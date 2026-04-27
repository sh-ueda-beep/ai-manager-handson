import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockAgentClient,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

const s3 = new S3Client({});
const bedrockAgent = new BedrockAgentClient({});

const BUCKET_NAME = process.env.BUCKET_NAME!;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID!;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID!;

// クライアントと揃えた上限。サーバ側バリデーションとしても使用
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
// Foundation Model Parser (Nova 2 Lite) の PDF 上限
const MAX_PDF_BYTES = 50 * 1024 * 1024;
// 元 PPTX 名を Metadata に保存する際の URL エンコード後の安全上限
const MAX_METADATA_VALUE_BYTES = 1024;
// pptxHash は SHA-256 先頭 12 文字（hex）
const PPTX_HASH_PATTERN = /^[0-9a-f]{12}$/;

interface LambdaEvent {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(statusCode: number, data: unknown): LambdaResponse {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(data) };
}

function runLibreoffice(inputPath: string, outputDir: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // HOME を /tmp に逃がす（Docker 側で設定済みだが念のため）
    const child = spawn('libreoffice', [
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--convert-to', 'pdf',
      '--outdir', outputDir,
      inputPath,
    ], {
      env: { ...process.env, HOME: '/tmp' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`libreoffice exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  try {
    if (event.requestContext?.http?.method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }
    if (!event.body) return json(400, { error: 'リクエストボディが空です' });

    const body = JSON.parse(event.body);
    const { fileName, content, contentEncoding, pptxHash } = body as {
      fileName?: string;
      content?: string;
      contentEncoding?: 'base64' | 'utf8';
      pptxHash?: string;
    };

    if (!fileName || !content || !pptxHash) {
      return json(400, { error: 'fileName, content, pptxHash が必要です' });
    }
    if (!fileName.toLowerCase().endsWith('.pptx')) {
      return json(400, { error: 'PPTX ファイルのみ受け付けます' });
    }
    if (contentEncoding !== 'base64') {
      return json(400, { error: 'contentEncoding は base64 のみ対応' });
    }
    if (!PPTX_HASH_PATTERN.test(pptxHash)) {
      return json(400, { error: 'pptxHash は hex 12 文字でなければなりません' });
    }

    const pptxBuffer = Buffer.from(content, 'base64');
    if (pptxBuffer.byteLength > MAX_UPLOAD_BYTES) {
      return json(413, {
        error: `ファイルサイズが上限 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB を超えています`,
        actualBytes: pptxBuffer.byteLength,
        maxBytes: MAX_UPLOAD_BYTES,
      });
    }

    // /tmp に一意な作業ディレクトリを作成（並列呼び出し対策）
    const workDir = path.join('/tmp', `work-${randomUUID()}`);
    await fs.mkdir(workDir, { recursive: true });

    const pptxPath = path.join(workDir, 'input.pptx');
    const pdfPath = path.join(workDir, 'input.pdf');

    try {
      await fs.writeFile(pptxPath, pptxBuffer);

      try {
        await runLibreoffice(pptxPath, workDir);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('LibreOffice conversion failed', message);
        return json(500, {
          error: 'PPTX の PDF 変換に失敗しました',
          detail: message.slice(0, 1000),
        });
      }

      const pdfStat = await fs.stat(pdfPath).catch(() => null);
      if (!pdfStat) {
        return json(500, { error: '変換後の PDF ファイルが生成されませんでした' });
      }
      if (pdfStat.size > MAX_PDF_BYTES) {
        return json(413, {
          error: `変換後 PDF が FM Parser 上限 ${Math.floor(MAX_PDF_BYTES / 1024 / 1024)} MB を超えています`,
          actualBytes: pdfStat.size,
          maxBytes: MAX_PDF_BYTES,
        });
      }

      const pdfBuffer = await fs.readFile(pdfPath);
      const key = `documents/pptx/${pptxHash}.pdf`;

      let encodedPptxName = encodeURIComponent(fileName);
      if (encodedPptxName.length > MAX_METADATA_VALUE_BYTES) {
        encodedPptxName = encodedPptxName.slice(0, MAX_METADATA_VALUE_BYTES);
      }

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
        Metadata: {
          'source-type': 'pptx-pdf',
          'original-pptx-name': encodedPptxName,
        },
      }));

      let ingestionJobId: string | null = null;
      try {
        const result = await bedrockAgent.send(new StartIngestionJobCommand({
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          dataSourceId: DATA_SOURCE_ID,
        }));
        ingestionJobId = result.ingestionJob?.ingestionJobId ?? null;
      } catch (err) {
        console.error('StartIngestionJob failed', err);
      }

      return json(202, {
        message: 'PPTX を PDF に変換し、インジェストジョブを起動しました',
        fileName,
        key,
        ingestionJobId,
      });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    console.error('pptx-to-pdf handler error', err);
    return json(500, { error: message });
  }
}
