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
  /** PPTX から PDF に変換されて登録されたファイルに付く */
  sourceType?: 'pptx-pdf'
  /** PPTX 由来 PDF の元 PPTX ファイル名（表示用） */
  sourcePptxName?: string
}

export interface UploadResponse {
  message?: string
  fileName: string
  key: string
  modality?: Modality
  ingestionJobId: string | null
}

export interface IngestionJobStatus {
  jobId: string
  status: 'STARTING' | 'IN_PROGRESS' | 'COMPLETE' | 'FAILED' | 'UNKNOWN'
  failureReasons: string[]
}

const ACCEPTED_EXTENSIONS = ['md', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'pptx']

// 同期 Lambda (API Gateway HTTP API) 経由の実効アップロード上限。
// Lambda リクエスト/レスポンス 6 MB 上限に base64 オーバーヘッドを差し引いた保守値。
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
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/** `.md` / 画像 / `.pdf` 等の単一ファイルアップロード */
export async function uploadDocument(file: File): Promise<UploadResponse> {
  const check = isAcceptedFile(file)
  if (!check.ok) throw new Error(check.reason)

  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pptx') {
    throw new Error('PPTX は uploadPptx() を使用してください')
  }

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

/** `.pptx` を PDF 変換して KB に登録する */
export async function uploadPptx(file: File, pptxHash: string): Promise<UploadResponse> {
  const check = isAcceptedFile(file)
  if (!check.ok) throw new Error(check.reason)

  const content = await fileToBase64(file)
  const token = await getAccessToken()
  const res = await fetch(`${getDocumentsApiUrl()}/api/documents/upload-pptx`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      fileName: file.name,
      content,
      contentEncoding: 'base64',
      pptxHash,
    }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'PPTX のアップロードに失敗しました' }))
    const detail = data.detail ? `: ${data.detail}` : ''
    throw new Error((data.error || `HTTP ${res.status}`) + detail)
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

/** 管理運用・リトライ用途：既存ファイルに対してインジェストジョブを手動起動 */
export async function startIngestion(): Promise<{ ingestionJobId: string | null }> {
  const token = await getAccessToken()
  const res = await fetch(`${getDocumentsApiUrl()}/api/documents/start-ingestion`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'インジェスト起動に失敗しました' }))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return await res.json()
}
