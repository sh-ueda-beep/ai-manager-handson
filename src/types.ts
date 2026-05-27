export interface SlideImage {
  index: number
  mediaType: string
  bytes?: string
  presignedUrl?: string
}

export interface SlideData {
  slideNumber: number
  title: string
  body: string
  notes: string
  images: SlideImage[]
}

export interface ParseResult {
  totalSlides: number
  slides: SlideData[]
}

export type AppState =
  | 'idle'
  | 'parsing'
  | 'parsed'
  | 'reviewing'
  | 'chatting'
  | 'restoring'
  | 'error'

export type ConversationRole = 'user' | 'assistant'

export interface ConversationMessage {
  id: string
  role: ConversationRole
  content: string
  /** 初回 assistant メッセージのみ構造化レビューを保持 */
  structured?: StructuredReview
  timestamp?: Date
}

export interface ConversationSession {
  sessionId: string
  title?: string
  fileName?: string
  createdAt?: Date
}

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
