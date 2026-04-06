import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
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

type SyncStatus = 'COMPLETE' | 'TIMEOUT' | 'FAILED';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** データソース同期を開始し、完了まで待機する（最大20秒） */
async function triggerSyncAndWait(): Promise<SyncStatus> {
  const startResult = await bedrockAgent.send(new StartIngestionJobCommand({
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    dataSourceId: DATA_SOURCE_ID,
  }));

  const jobId = startResult.ingestionJob?.ingestionJobId;
  if (!jobId) return 'FAILED';

  // 2秒間隔で最大10回ポーリング（最大20秒）
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const statusResult = await bedrockAgent.send(new GetIngestionJobCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
      ingestionJobId: jobId,
    }));
    const status = statusResult.ingestionJob?.status;
    if (status === 'COMPLETE') return 'COMPLETE';
    if (status === 'FAILED') return 'FAILED';
    // IN_PROGRESS / STARTING → 続行
  }

  return 'TIMEOUT';
}

// POST /api/documents/upload
async function handleUpload(event: LambdaEvent): Promise<LambdaResponse> {
  if (!event.body) return json(400, { error: 'リクエストボディが空です' });

  const body = JSON.parse(event.body);
  const { fileName, content } = body as { fileName?: string; content?: string };

  if (!fileName || !content) {
    return json(400, { error: 'fileName と content が必要です' });
  }
  if (!fileName.endsWith('.md')) {
    return json(400, { error: '.md ファイルのみアップロード可能です' });
  }

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: content,
    ContentType: 'text/markdown; charset=utf-8',
  }));

  // データソース同期を実行し完了を待機
  let syncStatus: SyncStatus = 'TIMEOUT';
  try {
    syncStatus = await triggerSyncAndWait();
  } catch {
    syncStatus = 'FAILED';
  }

  return json(200, { message: 'アップロード完了', fileName, syncStatus });
}

// GET /api/documents
async function handleList(): Promise<LambdaResponse> {
  const result = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
  }));

  const files = (result.Contents ?? []).map(obj => ({
    fileName: obj.Key,
    size: obj.Size,
    lastModified: obj.LastModified?.toISOString(),
  }));

  return json(200, { files });
}

// DELETE /api/documents/{key}
async function handleDelete(key: string): Promise<LambdaResponse> {
  if (!key) return json(400, { error: 'ファイルキーが必要です' });

  await s3.send(new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  }));

  // 削除後に同期を実行し完了を待機
  let syncStatus: SyncStatus = 'TIMEOUT';
  try {
    syncStatus = await triggerSyncAndWait();
  } catch {
    syncStatus = 'FAILED';
  }

  return json(200, { message: '削除完了', fileName: key, syncStatus });
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  try {
    const method = event.requestContext?.http?.method;
    const path = event.rawPath ?? '';

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    if (method === 'POST' && path.endsWith('/upload')) {
      return await handleUpload(event);
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
