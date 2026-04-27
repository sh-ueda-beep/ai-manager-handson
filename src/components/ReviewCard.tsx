import { Sparkles } from 'lucide-react'
import type { ReviewCategory, ReviewItem, SlideImage } from '@/types'

const CATEGORY_COLORS: Record<ReviewCategory, { text: string; bg: string }> = {
  '構成': { text: 'text-teal', bg: 'bg-teal-light' },
  '明確さ': { text: 'text-warning', bg: 'bg-warning-light' },
  '表現': { text: 'text-error', bg: 'bg-error-light' },
  '情報量': { text: 'text-teal', bg: 'bg-teal-light' },
  'ビジュアル': { text: 'text-purple-600', bg: 'bg-purple-50' },
}

function CategoryTag({ category }: { category: ReviewCategory }) {
  const colors = CATEGORY_COLORS[category]
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${colors.text} ${colors.bg}`}>
      {category}
    </span>
  )
}

interface OverallCardProps {
  variant: 'overall'
  summary: string
}

interface SlideCardProps {
  variant: 'slide'
  slideNumber: number
  title?: string
  items: ReviewItem[]
  visualItems?: ReviewItem[]
  images?: SlideImage[]
}

type ReviewCardProps = OverallCardProps | SlideCardProps

export function ReviewCard(props: ReviewCardProps) {
  if (props.variant === 'overall') {
    return (
      <div className="rounded-lg border border-border bg-white p-6 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-teal" />
          <h3 className="text-lg font-semibold text-text-primary">全体総評</h3>
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
          {props.summary}
        </div>
      </div>
    )
  }

  const { images = [], visualItems = [] } = props

  return (
    <div className="rounded-lg border border-border bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-3">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-teal text-sm font-bold text-white">
          {props.slideNumber}
        </span>
        {props.title && (
          <h3 className="text-lg font-semibold text-text-primary">{props.title}</h3>
        )}
      </div>
      {images.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <img
              key={i}
              src={`data:${img.mediaType};base64,${img.data}`}
              alt={`スライド ${props.slideNumber} 画像 ${i + 1}`}
              className="h-24 rounded border border-border object-contain"
            />
          ))}
        </div>
      )}
      <div className="space-y-3">
        {props.items.map((item, i) => (
          <div key={i} className="flex gap-3">
            <CategoryTag category={item.category} />
            <p className="flex-1 text-sm leading-relaxed text-text-secondary">{item.text}</p>
          </div>
        ))}
        {visualItems.map((item, i) => (
          <div key={`v-${i}`} className="flex gap-3">
            <CategoryTag category={item.category} />
            <p className="flex-1 text-sm leading-relaxed text-text-secondary">{item.text}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
