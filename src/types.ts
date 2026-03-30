export interface SlideData {
  slideNumber: number
  title: string
  body: string
  notes: string
}

export interface ParseResult {
  totalSlides: number
  slides: SlideData[]
}

export type AppState = 'idle' | 'parsing' | 'parsed' | 'reviewing' | 'reviewed' | 'error'

export type ReviewCategory = '構成' | '明確さ' | '表現' | '情報量'

export interface ReviewItem {
  category: ReviewCategory
  text: string
}

export interface SlideReview {
  slideNumber: number
  items: ReviewItem[]
}

export interface StructuredReview {
  overallSummary: string
  slideReviews: SlideReview[]
}
