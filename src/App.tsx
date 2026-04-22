import { useState, useCallback } from 'react'
import { FileText, LogOut } from 'lucide-react'
import { useAuthenticator } from '@aws-amplify/ui-react'
import { fetchAuthSession } from 'aws-amplify/auth'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { UploadCard } from '@/components/UploadCard'
import { Sidebar } from '@/components/Sidebar'
import { ReviewPanel } from '@/components/ReviewPanel'
import { ReferenceSidebar } from '@/components/ReferenceSidebar'
import { parseReviewText } from '@/lib/parseReview'
import type { AppState, ParseResult, StructuredReview } from '@/types'

function getCustomConfig() {
  const realConfigs = import.meta.glob('../amplify_outputs.json', { eager: true }) as Record<string, Record<string, unknown>>
  const config = Object.values(realConfigs)[0] as Record<string, unknown> | undefined
  const custom = config?.custom as Record<string, string> | undefined
  return {
    pptxParseApiUrl: custom?.pptxParseApiUrl ?? '',
    agentRuntimeArn: custom?.agentRuntimeArn ?? '',
  }
}

async function getAccessToken(): Promise<string> {
  const session = await fetchAuthSession()
  return session.tokens?.accessToken?.toString() ?? ''
}

function App() {
  const { signOut, user } = useAuthenticator()

  const [state, setState] = useState<AppState>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string>('')
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [reviewText, setReviewText] = useState<string>('')
  const [selectedSlide, setSelectedSlide] = useState<number | null>(null)
  const [structuredReview, setStructuredReview] = useState<StructuredReview | null>(null)

  const handleFileSelect = useCallback((f: File) => {
    setFile(f)
    setError('')
    setParseResult(null)
    setReviewText('')
    setStructuredReview(null)
    setSelectedSlide(null)
    setState('idle')
  }, [])

  const handleParse = useCallback(async () => {
    if (!file) return
    setState('parsing')
    setError('')

    try {
      const { pptxParseApiUrl } = getCustomConfig()
      const token = await getAccessToken()

      const arrayBuffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      )

      const res = await fetch(`${pptxParseApiUrl}/api/pptx/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ file: base64 }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'サーバーエラーが発生しました' }))
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const result: ParseResult = await res.json()
      setParseResult(result)
      setState('parsed')
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析中にエラーが発生しました')
      setState('error')
    }
  }, [file])

  const handleReview = useCallback(async () => {
    if (!parseResult) return
    setState('reviewing')
    setReviewText('')
    setStructuredReview(null)
    setError('')

    try {
      const { agentRuntimeArn } = getCustomConfig()
      const token = await getAccessToken()

      // Agent に送るのはテキスト情報のみで十分（画像バイトは KB 経由で参照）
      // images の bytes/presignedUrl を剥がして枚数情報だけ残す
      const slidesForAgent = parseResult.slides.map(s => ({
        slideNumber: s.slideNumber,
        title: s.title,
        body: s.body,
        notes: s.notes,
        imageCount: s.images?.length ?? 0,
      }))

      const url = `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent(agentRuntimeArn)}/invocations?qualifier=DEFAULT`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
          'x-amzn-bedrock-agentcore-runtime-session-id': crypto.randomUUID(),
        },
        body: JSON.stringify({ slides: slidesForAgent }),
      })

      if (!res.ok) {
        throw new Error(`レビューリクエストに失敗しました (HTTP ${res.status})`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('ストリーミング応答を取得できません')

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

      setStructuredReview(parseReviewText(accumulated))
      setState('reviewed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'レビュー中にエラーが発生しました')
      setState('error')
    }
  }, [parseResult])

  const handleReset = useCallback(() => {
    setFile(null)
    setParseResult(null)
    setReviewText('')
    setStructuredReview(null)
    setSelectedSlide(null)
    setError('')
    setState('idle')
  }, [])

  const isParsing = state === 'parsing'
  const isReviewing = state === 'reviewing'
  const isLoading = isParsing || isReviewing
  const showTwoColumn = state === 'parsed' || state === 'reviewing' || state === 'reviewed'

  return (
    <div className="h-screen flex flex-col bg-bg-light">
      <header className="border-b border-border bg-white px-6 py-4">
        <div className="flex items-center gap-3">
          <FileText className="h-6 w-6 text-teal" />
          <h1 className="text-xl font-bold text-text-primary">AI Manager</h1>
          <span className="ml-auto text-sm text-text-muted">{user?.signInDetails?.loginId}</span>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="h-4 w-4" />
            サインアウト
          </Button>
        </div>
      </header>

      {/* 解析前: センタリングされた1カラム */}
      {!showTwoColumn && (
        <main className="mx-auto w-full max-w-4xl px-6 py-8 space-y-6">
          <UploadCard
            file={file}
            isLoading={isLoading}
            isParsing={isParsing}
            isReviewing={isReviewing}
            hasParseResult={!!parseResult}
            onFileSelect={handleFileSelect}
            onParse={handleParse}
            onReview={handleReview}
            onReset={handleReset}
          />
          {error && (
            <Alert variant="destructive">
              <AlertTitle>エラー</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </main>
      )}

      {/* 解析後: 3カラム（左:スライド、中央:レビュー、右:参照データ） */}
      {showTwoColumn && file && parseResult && (
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            file={file}
            parseResult={parseResult}
            selectedSlide={selectedSlide}
            onSlideSelect={setSelectedSlide}
          />
          <main className="flex flex-1 flex-col overflow-hidden">
            {/* レビュー未実行時: 実行ボタン */}
            {state === 'parsed' && (
              <div className="border-b border-border bg-white px-6 py-4">
                <div className="flex items-center gap-3">
                  <Button onClick={handleReview} disabled={isLoading}>
                    レビューを実行
                  </Button>
                  <Button variant="outline" onClick={handleReset}>
                    リセット
                  </Button>
                </div>
              </div>
            )}

            {/* レビュー中 / レビュー完了 */}
            {(state === 'reviewing' || state === 'reviewed') && (
              <ReviewPanel
                isReviewing={isReviewing}
                isReviewed={state === 'reviewed'}
                reviewText={reviewText}
                structuredReview={structuredReview}
                parseResult={parseResult}
                selectedSlide={selectedSlide}
              />
            )}

            {/* エラー表示（3カラム内） */}
            {error && (
              <div className="p-6">
                <Alert variant="destructive">
                  <AlertTitle>エラー</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              </div>
            )}
          </main>
          <ReferenceSidebar />
        </div>
      )}
    </div>
  )
}

export default App
