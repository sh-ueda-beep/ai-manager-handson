import type { ReviewCategory, ReviewItem, SlideReview, StructuredReview } from '@/types'

const CATEGORY_PATTERN = /【(構成|明確さ|表現|情報量)】/
const VISUAL_PATTERN = /^【ビジュアル】/
const SLIDE_HEADING_PATTERN = /^##\s*スライド\s*(\d+)/
const OVERALL_HEADING_PATTERN = /^##?\s*(全体総評|全体レビュー)/

function parseCategory(line: string): { category: ReviewCategory; text: string } | null {
  const match = line.match(CATEGORY_PATTERN)
  if (!match) return null
  const category = match[1] as ReviewCategory
  const text = line.replace(CATEGORY_PATTERN, '').replace(/^[\s:：\-]+/, '').trim()
  return text ? { category, text } : null
}

function parseSlideSection(lines: string[]): { items: ReviewItem[]; visualItems: ReviewItem[] } {
  const items: ReviewItem[] = []
  const visualItems: ReviewItem[] = []
  let currentCategory: ReviewCategory | null = null
  let currentLines: string[] = []
  let currentIsVisual = false

  const flush = () => {
    if (currentCategory && currentLines.length > 0) {
      const item = { category: currentCategory, text: currentLines.join('\n').trim() }
      if (currentIsVisual) visualItems.push(item)
      else items.push(item)
    }
    currentLines = []
    currentIsVisual = false
  }

  for (const line of lines) {
    if (VISUAL_PATTERN.test(line.replace(/^[\s\-*]+/, ''))) {
      flush()
      currentCategory = 'ビジュアル'
      currentIsVisual = true
      const text = line.replace(/^[\s\-*]+/, '').replace(VISUAL_PATTERN, '').replace(/^[\s:：]+/, '').trim()
      if (text) currentLines.push(text)
      continue
    }

    const catMatch = parseCategory(line)
    if (catMatch) {
      flush()
      currentCategory = catMatch.category
      currentIsVisual = false
      if (catMatch.text) currentLines.push(catMatch.text)
    } else if (currentCategory) {
      currentLines.push(line)
    }
  }
  flush()

  return { items, visualItems }
}

export function parseReviewText(text: string): StructuredReview {
  const lines = text.split('\n')
  let overallLines: string[] = []
  const slideReviews: SlideReview[] = []

  let currentSlideNumber: number | null = null
  let currentSlideLines: string[] = []
  let inOverall = false

  const flushSlide = () => {
    if (currentSlideNumber !== null && currentSlideLines.length > 0) {
      const { items, visualItems } = parseSlideSection(currentSlideLines)
      if (items.length > 0 || visualItems.length > 0) {
        slideReviews.push({ slideNumber: currentSlideNumber, items, visualItems })
      }
    }
    currentSlideLines = []
  }

  for (const line of lines) {
    const overallMatch = line.match(OVERALL_HEADING_PATTERN)
    if (overallMatch) {
      flushSlide()
      currentSlideNumber = null
      inOverall = true
      continue
    }

    const slideMatch = line.match(SLIDE_HEADING_PATTERN)
    if (slideMatch) {
      flushSlide()
      inOverall = false
      currentSlideNumber = parseInt(slideMatch[1], 10)
      continue
    }

    if (inOverall) {
      overallLines.push(line)
    } else if (currentSlideNumber !== null) {
      currentSlideLines.push(line)
    } else {
      // Before any heading — treat as overall
      overallLines.push(line)
    }
  }
  flushSlide()

  const overallSummary = overallLines.join('\n').trim()

  // Fallback: if no structure was found, use full text as overall summary
  if (!overallSummary && slideReviews.length === 0) {
    return { overallSummary: text.trim(), slideReviews: [] }
  }

  return { overallSummary, slideReviews }
}
