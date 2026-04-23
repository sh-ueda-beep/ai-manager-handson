import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BedrockAgentClient,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

const s3 = new S3Client({});
const bedrockAgent = new BedrockAgentClient({});

const BUCKET_NAME = process.env.BUCKET_NAME!;
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID!;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID!;

interface LambdaEvent {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
  requestContext?: { http?: { method?: string; path?: string } };
  pathParameters?: Record<string, string>;
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
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function json(statusCode: number, data: unknown): LambdaResponse {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(data) };
}

type Modality = 'text' | 'image' | 'document';

type AcceptedExtension = 'md' | 'png' | 'jpg' | 'jpeg' | 'gif' | 'webp' | 'pdf';

const EXTENSION_TO_MIME: Record<AcceptedExtension, string> = {
  md: 'text/markdown; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const REJECTED_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'flv',
  'mpeg',
  'mpg',
  'wmv',
  '3gp',
  'mp3',
  'ogg',
  'wav',
]);

function getExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : '';
}

function isAcceptedExtension(ext: string): ext is AcceptedExtension {
  return ext in EXTENSION_TO_MIME;
}

function resolvePrefix(ext: AcceptedExtension): 'documents' | 'images' {
  return ext === 'md' || ext === 'pdf' ? 'documents' : 'images';
}

function extensionToModality(ext: AcceptedExtension): Modality {
  if (ext === 'md') return 'text';
  if (ext === 'pdf') return 'document';
  return 'image';
}

async function startIngestion(): Promise<string | null> {
  const result = await bedrockAgent.send(new StartIngestionJobCommand({
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    dataSourceId: DATA_SOURCE_ID,
  }));
  return result.ingestionJob?.ingestionJobId ?? null;
}

// POST /api/documents/upload
async function handleUpload(event: LambdaEvent): Promise<LambdaResponse> {
  if (!event.body) return json(400, { error: 'リクエストボディが空です' });

  const body = JSON.parse(event.body);
  const { fileName, content, contentEncoding } = body as {
    fileName?: string;
    content?: string;
    contentEncoding?: 'base64' | 'utf8';
  };

  if (!fileName || !content) {
    return json(400, { error: 'fileName と content が必要です' });
  }

  const ext = getExtension(fileName);

  if (REJECTED_EXTENSIONS.has(ext)) {
    return json(400, {
      error: '動画・音声ファイルは本バージョンでは対応していません',
      extension: ext,
    });
  }

  if (!isAcceptedExtension(ext)) {
    return json(400, {
      error: '対応していないファイル形式です',
      accepted: Object.keys(EXTENSION_TO_MIME),
    });
  }

  const modality = extensionToModality(ext);
  const mimeType = EXTENSION_TO_MIME[ext];
  const key = `${resolvePrefix(ext)}/${fileName}`;

  const bodyBuffer =
    contentEncoding === 'base64' || modality === 'image' || modality === 'document'
      ? Buffer.from(content, 'base64')
      : Buffer.from(content, 'utf8');

  if (bodyBuffer.byteLength > MAX_UPLOAD_BYTES) {
    return json(413, {
      error: `ファイルサイズが上限 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB を超えています`,
      actualBytes: bodyBuffer.byteLength,
      maxBytes: MAX_UPLOAD_BYTES,
    });
  }

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: bodyBuffer,
    ContentType: mimeType,
    Metadata: {
      'original-name': encodeURIComponent(fileName),
      modality,
    },
  }));

  let ingestionJobId: string | null = null;
  try {
    ingestionJobId = await startIngestion();
  } catch (err) {
    console.error('StartIngestionJob failed', err);
  }

  return json(202, {
    message: 'アップロードを受け付けました',
    fileName,
    key,
    modality,
    ingestionJobId,
  });
}

// POST /api/documents/start-ingestion
async function handleStartIngestion(): Promise<LambdaResponse> {
  try {
    const ingestionJobId = await startIngestion();
    return json(202, { ingestionJobId });
  } catch (err) {
    console.error('StartIngestionJob failed', err);
    return json(500, {
      error: 'インジェストジョブの起動に失敗しました',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** PPTX 由来 PDF の元ファイル名を HeadObject 経由で取得する */
async function fetchPptxPdfMetadata(key: string): Promise<{
  sourceType?: 'pptx-pdf';
  sourcePptxName?: string;
}> {
  if (!key.startsWith('documents/pptx/')) return {};
  try {
    const result = await s3.send(new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }));
    const meta = result.Metadata ?? {};
    if (meta['source-type'] !== 'pptx-pdf') return {};
    const raw = meta['original-pptx-name'] ?? '';
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    return { sourceType: 'pptx-pdf', sourcePptxName: decoded };
  } catch {
    return {};
  }
}

// GET /api/documents
async function handleList(): Promise<LambdaResponse> {
  const result = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
  }));

  const files = await Promise.all(
    (result.Contents ?? []).map(async obj => {
      const key = obj.Key ?? '';
      const ext = getExtension(key);
      const isImage = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp';

      const [presignedUrl, pptxMeta] = await Promise.all([
        isImage
          ? getSignedUrl(
              s3 as unknown as Parameters<typeof getSignedUrl>[0],
              new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }),
              { expiresIn: 300 }
            ).catch(() => undefined)
          : Promise.resolve<string | undefined>(undefined),
        fetchPptxPdfMetadata(key),
      ]);

      return {
        fileName: key,
        size: obj.Size,
        lastModified: obj.LastModified?.toISOString(),
        contentType: isAcceptedExtension(ext) ? EXTENSION_TO_MIME[ext] : 'application/octet-stream',
        modality: isAcceptedExtension(ext) ? extensionToModality(ext) : 'text',
        presignedUrl,
        ...pptxMeta,
      };
    })
  );

  return json(200, { files });
}

// GET /api/documents/ingestion-jobs/{jobId}
async function handleGetJob(jobId: string): Promise<LambdaResponse> {
  if (!jobId) return json(400, { error: 'jobId が必要です' });
  const result = await bedrockAgent.send(new GetIngestionJobCommand({
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    dataSourceId: DATA_SOURCE_ID,
    ingestionJobId: jobId,
  }));
  return json(200, {
    jobId,
    status: result.ingestionJob?.status ?? 'UNKNOWN',
    failureReasons: result.ingestionJob?.failureReasons ?? [],
  });
}

// DELETE /api/documents/{key}
async function handleDelete(key: string): Promise<LambdaResponse> {
  if (!key) return json(400, { error: 'ファイルキーが必要です' });

  await s3.send(new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  }));

  let ingestionJobId: string | null = null;
  try {
    ingestionJobId = await startIngestion();
  } catch (err) {
    console.error('StartIngestionJob failed (delete)', err);
  }

  return json(200, {
    message: '削除完了',
    fileName: key,
    ingestionJobId,
  });
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  try {
    const method = event.requestContext?.http?.method;
    const path = event.rawPath ?? '';

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    if (method === 'POST' && path.endsWith('/start-ingestion')) {
      return await handleStartIngestion();
    }

    if (method === 'POST' && path.endsWith('/upload')) {
      return await handleUpload(event);
    }

    if (method === 'GET' && path.includes('/ingestion-jobs/')) {
      const jobId = decodeURIComponent(path.split('/ingestion-jobs/')[1] ?? '');
      return await handleGetJob(jobId);
    }

    if (method === 'GET' && path.endsWith('/documents')) {
      return await handleList();
    }

    if (method === 'DELETE' && path.includes('/documents/')) {
      const key = decodeURIComponent(path.split('/documents/')[1]);
      return await handleDelete(key);
    }

    return json(404, { error: 'Not Found' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    return json(500, { error: message });
  }
}
