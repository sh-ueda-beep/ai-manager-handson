import { useState, useEffect, useCallback } from 'react'
import { Upload, Trash2, FileText, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { uploadDocument, listDocuments, deleteDocument, type DocumentFile } from '@/lib/documentsApi'

export function ReferenceSidebar() {
  const [files, setFiles] = useState<DocumentFile[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState('')

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

  useEffect(() => { fetchFiles() }, [fetchFiles])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.endsWith('.md')) {
      setError('.md ファイルのみアップロード可能です')
      return
    }

    setIsUploading(true)
    setError('')
    try {
      const content = await file.text()
      await uploadDocument(file.name, content)
      await fetchFiles()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'アップロードに失敗しました')
    } finally {
      setIsUploading(false)
      e.target.value = ''
    }
  }, [fetchFiles])

  const handleDelete = useCallback(async (fileName: string) => {
    if (!confirm(`${fileName} を削除しますか？`)) return
    try {
      await deleteDocument(fileName)
      await fetchFiles()
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    }
  }, [fetchFiles])

  return (
    <aside className="w-[280px] shrink-0 border-l border-border bg-white flex flex-col overflow-hidden">
      {/* ヘッダー */}
      <div className="border-b border-border p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">
            REFERENCES
          </p>
          <button onClick={fetchFiles} className="text-text-muted hover:text-text-primary">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* アップロードボタン */}
        <label className="block">
          <input
            type="file"
            accept=".md"
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
              {isUploading ? <Spinner className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />}
              {isUploading ? 'アップロード中...' : 'MDファイルを追加'}
            </span>
          </Button>
        </label>
      </div>

      {/* エラー表示 */}
      {error && (
        <div className="px-5 py-2 text-[11px] text-red-600 bg-red-50">
          {error}
        </div>
      )}

      {/* ファイル一覧 */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner className="h-5 w-5" />
          </div>
        ) : files.length === 0 ? (
          <div className="px-5 py-8 text-center text-[12px] text-text-muted">
            参照データがありません。<br />MDファイルをアップロードしてください。
          </div>
        ) : (
          files.map((file) => (
            <div
              key={file.fileName}
              className="flex items-center gap-2 border-b border-[#F0F0F0] px-5 py-3 hover:bg-gray-50"
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" />
              <div className="flex-1 min-w-0">
                <p className="truncate text-[12px] font-medium text-text-primary">
                  {file.fileName}
                </p>
                <p className="text-[10px] text-text-muted">
                  {(file.size / 1024).toFixed(1)} KB
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
