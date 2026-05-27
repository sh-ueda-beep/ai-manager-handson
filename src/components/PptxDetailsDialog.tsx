import * as Dialog from '@radix-ui/react-dialog'
import { X, FileText } from 'lucide-react'
import type { ParseResult } from '@/types'

interface PptxDetailsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileName: string
  parseResult: ParseResult
}

export function PptxDetailsDialog({
  open,
  onOpenChange,
  fileName,
  parseResult,
}: PptxDetailsDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(90vw,720px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-white shadow-xl focus:outline-none"
        >
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-teal" />
              <Dialog.Title className="text-base font-semibold text-text-primary">
                {fileName}
              </Dialog.Title>
              <span className="text-xs text-text-muted">
                {parseResult.totalSlides}枚のスライド
              </span>
            </div>
            <Dialog.Close asChild>
              <button
                aria-label="閉じる"
                className="rounded p-1 text-text-muted hover:bg-bg-light"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            <ul className="space-y-3">
              {parseResult.slides.map((slide) => {
                const displayTitle =
                  slide.title || slide.body.trim().split('\n')[0]?.slice(0, 60) || '(空のスライド)'
                return (
                  <li
                    key={slide.slideNumber}
                    className="rounded-md border border-border p-4"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <span className="font-mono text-xs text-text-muted">
                        {String(slide.slideNumber).padStart(2, '0')}
                      </span>
                      <span className="text-sm font-medium text-text-primary">
                        {displayTitle}
                      </span>
                      {slide.images?.length > 0 && (
                        <span className="text-[10px] text-text-muted">
                          画像 {slide.images.length} 枚
                        </span>
                      )}
                    </div>
                    {slide.body.trim() && (
                      <div className="mb-2">
                        <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                          Content
                        </p>
                        <div className="whitespace-pre-wrap text-xs text-text-secondary">
                          {slide.body.trim()}
                        </div>
                      </div>
                    )}
                    {slide.notes.trim() && (
                      <div>
                        <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                          Notes
                        </p>
                        <div className="whitespace-pre-wrap text-xs italic text-text-muted">
                          {slide.notes.trim()}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
