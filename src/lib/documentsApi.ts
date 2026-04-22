import { fetchAuthSession } from 'aws-amplify/auth'

async function getAccessToken(): Promise<string> {
  const session = await fetchAuthSession()
  return session.tokens?.accessToken?.toString() ?? ''
}

function getDocumentsApiUrl(): string {
  const realConfigs = import.meta.glob('../../amplify_outputs.json', { eager: true }) as Record<string, Record<string, unknown>>
  const config = Object.values(realConfigs)[0] as Record<string, unknown> | undefined
  const custom = config?.custom as Record<string, string> | undefined
  return custom?.documentsApiUrl ?? ''
}

export type Modality = 'text' | 'image' | 'document'

export interface DocumentFile {
  fileName: string
  size: number
  lastModified: string
  contentType: string
  modality: Modality
  presignedUrl?: string
}

export interface UploadResponse {
  message: string
  fileName: string
  key: string
  modality: Modality
  ingestionJobId: string | null
}

export interface IngestionJobStatus {
  jobId: string
  status: 'STARTING' | 'IN_PROGRESS' | 'COMPLETE' | 'FAILED' | 'UNKNOWN'
  failureReasons: string[]
}

const ACCEPTED_EXTENSIONS = ['md', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf']

// 現状のアップロードは API Gateway (HTTP API) + Lambda の同期呼び出しで、
// Lambda のリクエスト/レスポンスボディ上限は 6 MB。本体は base64 + JSON ラッパで
// 送るため、base64 オーバーヘッド (+33%) と JSON 包装を差し引いた生ファイル
// 実効上限は約 4 MB となる。それ以上のファイルはこのパスでは受け付けられない。
// TODO: S3 presigned URL による直接アップロード方式に切替時にはこの上限を拡張できる
//       （単一 PUT で 5 GB まで）。
export const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024
export const MAX_FILE_SIZE_LABEL = '4 MB'

export function isAcceptedFile(file: File): { ok: true } | { ok: false; reason: string } {
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return { ok: false, reason: `対応していないファイル形式です (.${ext})` }
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: `ファイルサイズが上限 ${MAX_FILE_SIZE_LABEL} を超えています` }
  }
  return { ok: true }
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  // 大きなファイルでスタックオーバーフローしないようにチャンク変換
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

export async function uploadDocument(file: File): Promise<UploadResponse> {
  const check = isAcceptedFile(file)
  if (!check.ok) throw new Error(check.reason)

  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  const isBinary = ext !== 'md'

  const content = isBinary ? await fileToBase64(file) : await file.text()
  const contentEncoding: 'base64' | 'utf8' = isBinary ? 'base64' : 'utf8'

  const token = await getAccessToken()
  const res = await fetch(`${getDocumentsApiUrl()}/api/documents/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ fileName: file.name, content, contentEncoding }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'アップロードに失敗しました' }))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return await res.json()
}

export async function listDocuments(): Promise<DocumentFile[]> {
  const token = await getAccessToken()
  const res = await fetch(`${getDocumentsApiUrl()}/api/documents`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.files ?? []
}

export async function deleteDocument(fileName: string): Promise<void> {
  const token = await getAccessToken()
  const res = await fetch(`${getDocumentsApiUrl()}/api/documents/${encodeURIComponent(fileName)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: '削除に失敗しました' }))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
}

export async function getIngestionJobStatus(jobId: string): Promise<IngestionJobStatus> {
  const token = await getAccessToken()
  const res = await fetch(
    `${getDocumentsApiUrl()}/api/documents/ingestion-jobs/${encodeURIComponent(jobId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}
