import { useState, useRef, useCallback, type DragEvent, type ChangeEvent } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import { Button } from '@/components/ui/button'
import './App.css'

function getCustomConfig() {
  const realConfigs = import.meta.glob('../amplify_outputs.json', { eager: true }) as Record<string, Record<string, unknown>>
  const config = Object.values(realConfigs)[0] as Record<string, unknown> | undefined
  const custom = config?.custom as Record<string, string> | undefined
  return {
    pptxParseApiUrl: custom?.pptxParseApiUrl ?? '',
    agentRuntimeArn: custom?.agentRuntimeArn ?? '',
  }
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB

interface SlideData {
  slideNumber: number
  title: string
  body: string
  notes: string
}

interface ParseResult {
  totalSlides: number
  slides: SlideData[]
}

type AppPhase = 'upload' | 'parsing' | 'parsed' | 'reviewing' | 'reviewed' | 'error'

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function App() {
  const [phase, setPhase] = useState<AppPhase>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState('')
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [reviewText, setReviewText] = useState('')
  const [reviewDone, setReviewDone] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const validateFile = useCallback((f: File): string | null => {
    if (!f.name.endsWith('.pptx')) {
      return 'PPTX ファイルのみアップロードできます'
    }
    if (f.size > MAX_FILE_SIZE) {
      return 'ファイルサイズが上限（10MB）を超えています'
    }
    return null
  }, [])

  const handleFileSelect = useCallback((f: File) => {
    const err = validateFile(f)
    if (err) {
      setError(err)
      setPhase('error')
      return
    }
    setFile(f)
    setError('')
    setPhase('upload')
  }, [validateFile])

  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFileSelect(f)
  }, [handleFileSelect])

  const onFileChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) handleFileSelect(f)
  }, [handleFileSelect])

  const parsePptx = useCallback(async () => {
    if (!file) return
    setPhase('parsing')
    setError('')

    try {
      const { pptxParseApiUrl } = getCustomConfig()
      const session = await fetchAuthSession()
      const token = session.tokens?.accessToken?.toString()

      const arrayBuffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )

      const res = await fetch(`${pptxParseApiUrl}/api/pptx/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ file: base64 }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'ネットワークエラー' }))
        throw new Error(body.error || `HTTP ${res.status}`)
      }

      const result: ParseResult = await res.json()
      setParseResult(result)
      setPhase('parsed')
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析に失敗しました')
      setPhase('error')
    }
  }, [file])

  const startReview = useCallback(async () => {
    if (!parseResult) return
    setPhase('reviewing')
    setReviewText('')
    setReviewDone(false)
    setError('')

    try {
      const { agentRuntimeArn } = getCustomConfig()
      const session = await fetchAuthSession()
      const accessToken = session.tokens?.accessToken?.toString()

      const url = `https://bedrock-agentcore.ap-northeast-1.amazonaws.com/runtimes/${encodeURIComponent(agentRuntimeArn)}/invocations?qualifier=DEFAULT`

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'x-amzn-bedrock-agentcore-runtime-session-id': crypto.randomUUID(),
        },
        body: JSON.stringify({ slides: parseResult.slides }),
      })

      if (!res.ok) {
        throw new Error(`レビューリクエストに失敗しました (HTTP ${res.status})`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ''
      let lineBuf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        lineBuf += decoder.decode(value, { stream: true })
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: ')) continue
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            if (parsed.text) {
              accumulated += parsed.text
              setReviewText(accumulated)
            }
          } catch {
            // JSON パース失敗は無視（不完全なチャンク）
          }
        }
      }

      setReviewDone(true)
      setPhase('reviewed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'レビューに失敗しました')
      setPhase('error')
    }
  }, [parseResult])

  const reset = useCallback(() => {
    setPhase('upload')
    setFile(null)
    setError('')
    setParseResult(null)
    setReviewText('')
    setReviewDone(false)
  }, [])

  const isUploading = phase === 'parsing'

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-6 text-2xl font-bold text-text-primary">PPTX レビューアシスタント</h1>

      {/* Upload Area */}
      {(phase === 'upload' || phase === 'error') && (
        <div
          className={`rounded-lg border-2 border-dashed p-12 text-center transition-colors ${
            dragOver ? 'border-teal bg-teal-light' : 'border-border bg-bg-light'
          } ${isUploading ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pptx"
            className="hidden"
            onChange={onFileChange}
          />
          <div className="mb-4 text-4xl text-text-muted">📄</div>
          <p className="mb-2 text-text-primary">
            PPTX ファイルをドラッグ＆ドロップ、またはクリックして選択
          </p>
          <p className="text-sm text-text-muted">最大 10MB</p>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="mt-4 rounded-lg border border-error bg-error-light p-4 text-error">
          <p>{error}</p>
          {phase === 'error' && (
            <Button variant="outline" size="sm" className="mt-2" onClick={reset}>
              やり直す
            </Button>
          )}
        </div>
      )}

      {/* File Info */}
      {file && phase !== 'error' && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-white p-4">
          <div>
            <p className="font-medium text-text-primary">{file.name}</p>
            <p className="text-sm text-text-muted">{formatFileSize(file.size)}</p>
          </div>
          {phase === 'upload' && (
            <Button onClick={parsePptx}>解析する</Button>
          )}
        </div>
      )}

      {/* Parsing Spinner */}
      {phase === 'parsing' && (
        <div className="mt-6 flex items-center justify-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal border-t-transparent" />
          <p className="text-text-secondary">PPTX ファイルを解析中...</p>
        </div>
      )}

      {/* Parse Results */}
      {parseResult && (phase === 'parsed' || phase === 'reviewing' || phase === 'reviewed') && (
        <div className="mt-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-text-primary">
              解析結果（{parseResult.totalSlides} スライド）
            </h2>
            {phase === 'parsed' && (
              <Button onClick={startReview}>AI レビューを実行</Button>
            )}
          </div>

          <div className="space-y-3">
            {parseResult.slides.map((slide) => (
              <div key={slide.slideNumber} className="rounded-lg border border-border bg-white p-4">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="rounded bg-teal px-2 py-0.5 text-xs font-medium text-white">
                    #{slide.slideNumber}
                  </span>
                  <span className="font-medium text-text-primary">
                    {slide.title || '（タイトルなし）'}
                  </span>
                </div>
                {slide.body && (
                  <p className="mt-2 whitespace-pre-wrap text-sm text-text-secondary">{slide.body}</p>
                )}
                {slide.notes && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-text-muted">ノート</summary>
                    <p className="mt-1 whitespace-pre-wrap text-xs text-text-muted">{slide.notes}</p>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reviewing Spinner */}
      {phase === 'reviewing' && !reviewText && (
        <div className="mt-6 flex items-center justify-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal border-t-transparent" />
          <p className="text-text-secondary">AI がレビュー中...</p>
        </div>
      )}

      {/* Review Results (streaming) */}
      {reviewText && (
        <div className="mt-6">
          <h2 className="mb-4 text-lg font-semibold text-text-primary">
            AI レビュー {!reviewDone && <span className="text-sm font-normal text-text-muted">（生成中...）</span>}
          </h2>
          <div className="rounded-lg border border-border bg-white p-6">
            <div className="prose max-w-none whitespace-pre-wrap text-sm text-text-primary">
              {reviewText}
            </div>
          </div>
        </div>
      )}

      {/* Actions after review */}
      {phase === 'reviewed' && (
        <div className="mt-4 flex gap-3">
          <Button variant="outline" onClick={reset}>新しいファイルをアップロード</Button>
          <Button variant="secondary" onClick={startReview}>レビューを再実行</Button>
        </div>
      )}
    </div>
  )
}

export default App
