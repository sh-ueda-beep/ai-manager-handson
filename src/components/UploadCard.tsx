import { useState, useRef, useCallback } from 'react'
import { FileText, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

interface UploadCardProps {
  file: File | null
  isLoading: boolean
  isParsing: boolean
  isReviewing: boolean
  hasParseResult: boolean
  onFileSelect: (file: File) => void
  onParse: () => void
  onReview: () => void
  onReset: () => void
}

export function UploadCard({
  file,
  isLoading,
  isParsing,
  isReviewing,
  hasParseResult,
  onFileSelect,
  onParse,
  onReview,
  onReset,
}: UploadCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const validateFile = useCallback((f: File): string | null => {
    if (!f.name.toLowerCase().endsWith('.pptx')) {
      return 'PPTX ファイルのみアップロードできます'
    }
    if (f.size > MAX_FILE_SIZE) {
      return 'ファイルサイズが上限（10MB）を超えています'
    }
    return null
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) {
      const err = validateFile(f)
      if (!err) onFileSelect(f)
    }
  }, [validateFile, onFileSelect])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setIsDragOver(false), [])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) onFileSelect(f)
  }, [onFileSelect])

  return (
    <Card>
      <CardHeader>
        <CardTitle>PowerPoint レビュー</CardTitle>
        <CardDescription>
          PPTX ファイルをアップロードして、AI にレビューしてもらいましょう
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className={`relative flex flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
            isLoading
              ? 'pointer-events-none border-gray-200 bg-gray-50 text-gray-300'
              : isDragOver
                ? 'border-teal bg-teal-light text-teal'
                : 'cursor-pointer border-gray-300 text-gray-400 hover:border-teal hover:text-teal'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => !isLoading && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pptx"
            className="hidden"
            onChange={handleInputChange}
            disabled={isLoading}
          />
          {file ? (
            <div className="flex items-center gap-2">
              <FileText className="h-6 w-6" />
              <span className="font-medium text-text-primary">{file.name}</span>
              <span className="text-sm text-text-muted">({(file.size / 1024).toFixed(1)} KB)</span>
              {!isLoading && (
                <button
                  onClick={(e) => { e.stopPropagation(); onReset() }}
                  className="ml-2 rounded-full p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8" />
              <span>PPTX ファイルをドラッグ＆ドロップ、またはクリックして選択</span>
              <span className="text-xs">最大 10MB</span>
            </>
          )}
        </div>

        <div className="flex gap-3">
          {!hasParseResult ? (
            <Button onClick={onParse} disabled={!file || isLoading}>
              {isParsing && <Spinner className="mr-2 h-4 w-4" />}
              {isParsing ? '解析中...' : '解析する'}
            </Button>
          ) : (
            <Button onClick={onReview} disabled={isLoading}>
              {isReviewing && <Spinner className="mr-2 h-4 w-4" />}
              {isReviewing ? 'レビュー中...' : 'レビューを実行'}
            </Button>
          )}
          <Button variant="outline" onClick={onReset} disabled={isLoading}>
            リセット
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
