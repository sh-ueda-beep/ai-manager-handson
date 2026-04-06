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

export interface DocumentFile {
  fileName: string
  size: number
  lastModified: string
}

export async function uploadDocument(fileName: string, content: string): Promise<void> {
  const token = await getAccessToken()
  const res = await fetch(`${getDocumentsApiUrl()}/api/documents/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ fileName, content }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'アップロードに失敗しました' }))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
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
