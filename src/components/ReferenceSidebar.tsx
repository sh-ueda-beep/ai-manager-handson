import { useState, useEffect, useCallback, useRef } from 'react'
import { Upload, Trash2, FileText, Image as ImageIcon, FileType2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  uploadDocument,
  listDocuments,
  deleteDocument,
  getIngestionJobStatus,
  isAcceptedFile,
  MAX_FILE_SIZE_LABEL,
  type DocumentFile,
  type IngestionJobStatus,
} from '@/lib/documentsApi'

type JobMap = Record<string, IngestionJobStatus['status']>

const POLL_INTERVAL_MS = 4000

export function ReferenceSidebar() {
  const [files, setFiles] = useState<DocumentFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState('')
  const [jobStatuses, setJobStatuses] = useState<JobMap>({})
  const activeJobs = useRef<Set<string>>(new Set())

  const fetchFiles = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await listDocuments()
      setFiles(result)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '一覧取得に失敗しました')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchFiles()
  }, [fetchFiles])

  const pollJob = useCallback(
    async (jobId: string) => {
      if (activeJobs.current.has(jobId)) return
      activeJobs.current.add(jobId)
      try {
        while (activeJobs.current.has(jobId)) {
          const status = await getIngestionJobStatus(jobId)
          setJobStatuses(prev => ({ ...prev, [jobId]: status.status }))
          if (status.status === 'COMPLETE' || status.status === 'FAILED') {
            await fetchFiles()
            break
          }
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
        }
      } catch {
        setJobStatuses(prev => ({ ...prev, [jobId]: 'FAILED' }))
      } finally {
        activeJobs.current.delete(jobId)
      }
    },
    [fetchFiles]
  )

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      const check = isAcceptedFile(file)
      if (!check.ok) {
        setError(check.reason)
        e.target.value = ''
        return
      }

      setIsUploading(true)
      setError('')
      try {
        const result = await uploadDocument(file)
        await fetchFiles()
        if (result.ingestionJobId) {
          setJobStatuses(prev => ({ ...prev, [result.ingestionJobId!]: 'STARTING' }))
          void pollJob(result.ingestionJobId)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'アップロードに失敗しました')
      } finally {
        setIsUploading(false)
        e.target.value = ''
      }
    },
    [fetchFiles, pollJob]
  )

  const handleDelete = useCallback(
    async (fileName: string) => {
      if (!confirm(`${fileName} を削除しますか？`)) return
      try {
        await deleteDocument(fileName)
        await fetchFiles()
      } catch (err) {
        setError(err instanceof Error ? err.message : '削除に失敗しました')
      }
    },
    [fetchFiles]
  )

  const activeJobStatuses = Object.values(jobStatuses).filter(
    s => s === 'STARTING' || s === 'IN_PROGRESS'
  )

  const renderIcon = (file: DocumentFile) => {
    if (file.modality === 'image' && file.presignedUrl) {
      return (
        <img
          src={file.presignedUrl}
          alt={file.fileName}
          className="h-8 w-8 shrink-0 rounded object-cover"
          onError={e => {
            ;(e.currentTarget as HTMLImageElement).style.display = 'none'
          }}
        />
      )
    }
    if (file.modality === 'image') {
      return <ImageIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    }
    if (file.modality === 'document') {
      return <FileType2 className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    }
    return <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" />
  }

  return (
    <aside className="w-[280px] shrink-0 border-l border-border bg-white flex flex-col overflow-hidden">
      {/* ヘッダー */}
      <div className="border-b border-border p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">
            REFERENCES
          </p>
          <button
            onClick={fetchFiles}
            className="text-text-muted hover:text-text-primary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* アップロードボタン */}
        <label className="block">
          <input
            type="file"
            accept=".md,.png,.jpg,.jpeg,.gif,.webp,.pdf"
            onChange={handleFileSelect}
            disabled={isUploading}
            className="hidden"
          />
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={isUploading}
            asChild
          >
            <span>
              {isUploading ? (
                <Spinner className="h-3.5 w-3.5" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {isUploading ? 'アップロード中...' : 'ファイルを追加 (MD/画像/PDF)'}
            </span>
          </Button>
        </label>

        <p className="mt-2 text-[10px] text-text-muted">
          最大 {MAX_FILE_SIZE_LABEL} / ファイル
        </p>

        {activeJobStatuses.length > 0 && (
          <p className="mt-1 text-[10px] text-text-muted">
            インジェスト処理中 ({activeJobStatuses.length} 件)
          </p>
        )}
      </div>

      {/* エラー表示 */}
      {error && (
        <div className="px-5 py-2 text-[11px] text-red-600 bg-red-50">{error}</div>
      )}

      {/* ファイル一覧 */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner className="h-5 w-5" />
          </div>
        ) : files.length === 0 ? (
          <div className="px-5 py-8 text-center text-[12px] text-text-muted">
            参照データが登録されていません。
            <br />
            MD / 画像 / PDF をアップロードしてください。
          </div>
        ) : (
          files.map(file => (
            <div
              key={file.fileName}
              className="flex items-center gap-2 border-b border-[#F0F0F0] px-5 py-3 hover:bg-gray-50"
            >
              {renderIcon(file)}
              <div className="flex-1 min-w-0">
                <p className="truncate text-[12px] font-medium text-text-primary">
                  {file.fileName.replace(/^(documents|images)\//, '')}
                </p>
                <p className="text-[10px] text-text-muted">
                  {(file.size / 1024).toFixed(1)} KB · {file.modality}
                </p>
              </div>
              <button
                onClick={() => handleDelete(file.fileName)}
                className="shrink-0 text-text-muted hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
