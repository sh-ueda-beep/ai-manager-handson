import { File, ChevronRight, ChevronDown } from 'lucide-react'
import type { ParseResult } from '@/types'

interface SidebarProps {
  file: File
  parseResult: ParseResult
  selectedSlide: number | null
  onSlideSelect: (slideNumber: number | null) => void
}

export function Sidebar({ file, parseResult, selectedSlide, onSlideSelect }: SidebarProps) {
  return (
    <aside className="w-[360px] shrink-0 border-r border-border bg-white flex flex-col overflow-hidden">
      {/* ヘッダー */}
      <div className="border-b border-border p-5">
        <p className="mb-3 font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">
          SLIDES
        </p>
        <div className="flex items-center gap-2">
          <File className="h-[18px] w-[18px] shrink-0 text-text-muted" />
          <span className="truncate text-[13px] text-text-primary">{file.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-text-muted">
            {(file.size / 1024).toFixed(1)} KB
          </span>
        </div>
      </div>

      {/* スライド一覧（アコーディオン） */}
      <div className="flex-1 overflow-y-auto">
        {parseResult.slides.map((slide) => {
          const isActive = selectedSlide === slide.slideNumber
          const displayTitle = slide.title
            || slide.body.trim().split('\n')[0].slice(0, 40)
            || '(空のスライド)'
          const hasBody = !!slide.body.trim()
          const hasNotes = !!slide.notes.trim()

          return (
            <div key={slide.slideNumber}>
              {/* アコーディオンヘッダー */}
              <button
                onClick={() => onSlideSelect(isActive ? null : slide.slideNumber)}
                className={`flex w-full items-center gap-3 py-3 px-5 text-left transition-colors ${
                  isActive
                    ? 'border-l-[3px] border-teal bg-teal-light'
                    : 'border-b border-[#F0F0F0] hover:bg-gray-50'
                }`}
              >
                <span className={`shrink-0 font-mono text-[11px] ${
                  isActive ? 'text-teal' : 'text-[#AAAAAA]'
                }`}>
                  {String(slide.slideNumber).padStart(2, '0')}
                </span>
                <span className={`flex-1 truncate text-[13px] font-medium ${
                  isActive ? 'text-teal' : 'text-text-primary'
                }`}>
                  {displayTitle}
                </span>
                {isActive
                  ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-teal" />
                  : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#AAAAAA]" />
                }
              </button>

              {/* 展開コンテンツ */}
              {isActive && (hasBody || hasNotes) && (
                <div className="border-b border-[#F0F0F0] bg-[#F7FAFA] pb-3.5 pl-12 pr-5">
                  {hasBody && (
                    <div className="pt-2">
                      <p className="mb-1 font-mono text-[9px] font-semibold uppercase tracking-[1.5px] text-[#AAAAAA]">
                        CONTENT
                      </p>
                      <div className="space-y-0.5">
                        {slide.body.trim().split('\n').map((line, i) => (
                          <p key={i} className="text-[12px] leading-relaxed text-text-secondary">
                            {line}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                  {hasNotes && (
                    <div className="pt-2">
                      <p className="mb-1 font-mono text-[9px] font-semibold uppercase tracking-[1.5px] text-[#AAAAAA]">
                        NOTES
                      </p>
                      <p className="text-[11px] italic leading-[1.4] text-text-muted">
                        {slide.notes.trim()}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
