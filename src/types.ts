export interface SlideImage {
  mediaType: string
  data: string
}

export interface SlideData {
  slideNumber: number
  title: string
  body: string
  notes: string
  images: SlideImage[]
  imagesTruncated: boolean
}

export interface ParseResult {
  totalSlides: number
  slides: SlideData[]
}

export type AppState = 'idle' | 'parsing' | 'parsed' | 'reviewing' | 'reviewed' | 'error'

export type ReviewCategory = '構成' | '明確さ' | '表現' | '情報量' | 'ビジュアル'

export interface ReviewItem {
  category: ReviewCategory
  text: string
}

export interface SlideReview {
  slideNumber: number
  items: ReviewItem[]
  visualItems: ReviewItem[]
}

export interface StructuredReview {
  overallSummary: string
  slideReviews: SlideReview[]
}
