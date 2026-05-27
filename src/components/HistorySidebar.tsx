import { Plus, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ConversationSession } from '@/types'

interface HistorySidebarProps {
  sessions: ConversationSession[]
  activeSessionId: string | null
  onNewSession: () => void
  onSelectSession: (sessionId: string) => void
  errorMessage?: string
}

function formatDate(d?: Date): string {
  if (!d) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function HistorySidebar({
  sessions,
  activeSessionId,
  onNewSession,
  onSelectSession,
  errorMessage,
}: HistorySidebarProps) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-white">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="font-medium text-text-primary">履歴</span>
        <Button size="sm" variant="outline" onClick={onNewSession}>
          <Plus className="h-4 w-4" />
          新規
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {errorMessage && (
          <div className="mx-2 mb-2 rounded border border-error/30 bg-error-light px-3 py-2 text-xs text-error">
            <div className="mb-0.5 font-medium">履歴の取得に失敗しました</div>
            <div className="wrap-break-word">{errorMessage}</div>
          </div>
        )}
        {sessions.length === 0 ? (
          <p className="px-3 py-6 text-sm text-text-muted">
            {errorMessage
              ? '履歴を表示できません。ブラウザの開発者ツールのコンソールで詳細を確認してください。'
              : 'まだ履歴はありません。新しいレビューを開始してください。'}
          </p>
        ) : (
          <ul className="space-y-1">
            {sessions.map((s) => {
              const isActive = s.sessionId === activeSessionId
              return (
                <li key={s.sessionId}>
                  <button
                    onClick={() => onSelectSession(s.sessionId)}
                    className={`flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                      isActive
                        ? 'bg-teal-light text-teal'
                        : 'text-text-primary hover:bg-bg-light'
                    }`}
                  >
                    <MessageSquare
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        isActive ? 'text-teal' : 'text-text-muted'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">
                          {s.title ?? '（無題）'}
                        </span>
                        <span className="shrink-0 text-[11px] text-text-muted">
                          {formatDate(s.createdAt)}
                        </span>
                      </div>
                      {s.fileName && (
                        <div className="truncate text-xs text-text-muted">
                          {s.fileName}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
