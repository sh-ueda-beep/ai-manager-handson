import { Spinner } from '@/components/ui/spinner'

interface ReviewHeaderProps {
  isReviewing: boolean
  isReviewed: boolean
}

export function ReviewHeader({ isReviewing, isReviewed }: ReviewHeaderProps) {
  return (
    <div className="border-b border-border bg-white px-6 py-4">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-serif font-bold text-text-primary">AI レビュー</h2>
        {isReviewing && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-light px-3 py-1 text-xs font-medium text-teal">
            <Spinner className="h-3 w-3 text-teal" />
            分析中
          </span>
        )}
        {isReviewed && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-light px-3 py-1 text-xs font-medium text-teal">
            完了
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-text-muted">
        プレゼンテーションの構成・表現・明確さを AI が分析します
      </p>
    </div>
  )
}
