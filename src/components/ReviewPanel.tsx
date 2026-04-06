import type { ParseResult, StructuredReview } from '@/types'
import { ReviewHeader } from '@/components/ReviewHeader'
import { ReviewCard } from '@/components/ReviewCard'

interface ReviewPanelProps {
  isReviewing: boolean
  isReviewed: boolean
  reviewText: string
  structuredReview: StructuredReview | null
  parseResult: ParseResult
  selectedSlide: number | null
}

export function ReviewPanel({
  isReviewing,
  isReviewed,
  reviewText,
  structuredReview,
  parseResult,
  selectedSlide,
}: ReviewPanelProps) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ReviewHeader isReviewing={isReviewing} isReviewed={isReviewed} />

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {/* ストリーミング中: プレーンテキスト表示 */}
        {isReviewing && (
          <div className="rounded-lg border border-border bg-white p-6 shadow-sm">
            <div className="prose prose-sm max-w-none whitespace-pre-wrap text-text-secondary">
              {reviewText || 'レビューを生成中...'}
            </div>
          </div>
        )}

        {/* レビュー完了: 構造化カード表示 */}
        {isReviewed && structuredReview && (
          <>
            {/* 全体総評 (selectedSlide が null のとき表示) */}
            {selectedSlide === null && structuredReview.overallSummary && (
              <ReviewCard variant="overall" summary={structuredReview.overallSummary} />
            )}

            {/* スライド別レビュー */}
            {structuredReview.slideReviews
              .filter((sr) => selectedSlide === null || sr.slideNumber === selectedSlide)
              .map((sr) => {
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
          </>
        )}

        {/* レビュー完了だが構造化パース失敗 → フォールバック */}
        {isReviewed && !structuredReview && reviewText && (
          <ReviewCard variant="overall" summary={reviewText} />
        )}
      </div>
    </div>
  )
}
