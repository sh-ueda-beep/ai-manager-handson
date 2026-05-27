import { useEffect, useRef, useState } from 'react'
import { FileText, Send, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ReviewCard } from '@/components/ReviewCard'
import { PptxDetailsDialog } from '@/components/PptxDetailsDialog'
import type { AppState, ConversationMessage, ParseResult } from '@/types'

interface ChatPanelProps {
  state: AppState
  headerTitle: string
  fileName?: string
  parseResult: ParseResult | null
  messages: ConversationMessage[]
  error: string
  inputText: string
  onInputChange: (text: string) => void
  onSend: () => void
}

export function ChatPanel({
  state,
  headerTitle,
  fileName,
  parseResult,
  messages,
  error,
  inputText,
  onInputChange,
  onSend,
}: ChatPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const canChat = state === 'chatting'
  const isStreaming = state === 'reviewing'

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* Chat Header */}
      <div className="flex items-center justify-between border-b border-border bg-white px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate font-medium text-text-primary">{headerTitle}</span>
          {state === 'restoring' && (
            <span className="text-xs text-text-muted">復元中...</span>
          )}
          {isStreaming && <span className="text-xs text-teal">レビュー生成中...</span>}
        </div>
        {parseResult && fileName && (
          <button
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-bg-light px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-teal-light hover:text-teal"
          >
            <FileText className="h-3.5 w-3.5" />
            <span className="max-w-[200px] truncate">{fileName}</span>
            <span className="text-text-muted">({parseResult.totalSlides}枚)</span>
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-bg-light px-6 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && state === 'restoring' && (
            <p className="text-center text-sm text-text-muted">履歴を読み込んでいます...</p>
          )}

          {messages.map((m, idx) => {
            if (m.role === 'user') {
              return (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-teal px-4 py-2.5 text-sm text-white whitespace-pre-wrap">
                    {m.content}
                  </div>
                </div>
              )
            }

            // assistant
            const isFirst = idx === 1 && m.role === 'assistant'
            if (isFirst && m.structured && parseResult) {
              return (
                <div key={m.id} className="space-y-3">
                  {m.structured.overallSummary && (
                    <ReviewCard variant="overall" summary={m.structured.overallSummary} />
                  )}
                  {m.structured.slideReviews.map((sr) => {
                    const slide = parseResult.slides.find((s) => s.slideNumber === sr.slideNumber)
                    return (
                      <ReviewCard
                        key={sr.slideNumber}
                        variant="slide"
                        slideNumber={sr.slideNumber}
                        title={slide?.title}
                        items={sr.items}
                      />
                    )
                  })}
                </div>
              )
            }

            return (
              <div key={m.id} className="flex justify-start gap-3">
                <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-teal-light">
                  <Sparkles className="h-3.5 w-3.5 text-teal" />
                </div>
                <div className="max-w-[80%] rounded-2xl rounded-tl-sm border border-border bg-white px-4 py-2.5 text-sm text-text-secondary whitespace-pre-wrap">
                  {m.content || (isStreaming && idx === messages.length - 1 ? '…' : '')}
                </div>
              </div>
            )
          })}

          {error && (
            <Alert variant="destructive">
              <AlertTitle>エラー</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border bg-white px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSend()
              }
            }}
            disabled={!canChat}
            rows={2}
            placeholder={
              canChat ? 'フォローアップ質問を入力... (Enter で送信 / Shift+Enter で改行)' : 'レビュー実行中は入力できません'
            }
            className="flex-1 resize-none rounded-md border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-teal focus:outline-none focus:ring-1 focus:ring-teal disabled:bg-bg-light disabled:text-text-muted"
          />
          <Button onClick={onSend} disabled={!canChat || !inputText.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {parseResult && fileName && (
        <PptxDetailsDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          fileName={fileName}
          parseResult={parseResult}
        />
      )}
    </main>
  )
}
