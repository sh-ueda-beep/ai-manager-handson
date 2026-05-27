import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, LogOut } from 'lucide-react'
import { useAuthenticator } from '@aws-amplify/ui-react'
import { fetchAuthSession } from 'aws-amplify/auth'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { UploadCard } from '@/components/UploadCard'
import { HistorySidebar } from '@/components/HistorySidebar'
import { ChatPanel } from '@/components/ChatPanel'
import { ReferenceSidebar } from '@/components/ReferenceSidebar'
import { parseReviewText } from '@/lib/parseReview'
import {
  createMemoryContext,
  listMessages,
  listSessions,
  saveMessage,
  type MemoryContext,
} from '@/lib/agentcoreMemory'
import type {
  AppState,
  ConversationMessage,
  ConversationSession,
  ParseResult,
  SlideData,
} from '@/types'

interface CustomConfig {
  pptxParseApiUrl: string
  agentRuntimeArn: string
  memoryId: string
}

function getCustomConfig(): CustomConfig {
  const realConfigs = import.meta.glob('../amplify_outputs.json', { eager: true }) as Record<
    string,
    Record<string, unknown>
  >
  const config = Object.values(realConfigs)[0] as Record<string, unknown> | undefined
  const custom = config?.custom as Record<string, string> | undefined
  return {
    pptxParseApiUrl: custom?.pptxParseApiUrl ?? '',
    agentRuntimeArn: custom?.agentRuntimeArn ?? '',
    memoryId: custom?.memoryId ?? '',
  }
}

async function getAccessToken(): Promise<string> {
  const session = await fetchAuthSession()
  return session.tokens?.accessToken?.toString() ?? ''
}

interface AgentSlide {
  slideNumber: number
  title: string
  body: string
  notes: string
  imageCount: number
}

type ConversationTurn = { role: 'user' | 'assistant'; content: string }
type InvokePayload =
  | { mode: 'initial'; slides: AgentSlide[]; fileName?: string }
  | { mode: 'followup'; message: string; history: ConversationTurn[] }

function toAgentSlides(slides: SlideData[]): AgentSlide[] {
  // Agent に送るのはテキスト情報のみ（画像バイトは KB 経由で参照）
  return slides.map(s => ({
    slideNumber: s.slideNumber,
    title: s.title,
    body: s.body,
    notes: s.notes,
    imageCount: s.images?.length ?? 0,
  }))
}

function App() {
  const { signOut, user } = useAuthenticator()
  const config = getCustomConfig()

  const [state, setState] = useState<AppState>('idle')
  const [error, setError] = useState<string>('')

  const [file, setFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)

  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID())
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [sessions, setSessions] = useState<ConversationSession[]>([])
  const [inputText, setInputText] = useState('')

  const memoryCtxRef = useRef<MemoryContext | null>(null)

  const getMemoryCtx = useCallback(async () => {
    if (memoryCtxRef.current) return memoryCtxRef.current
    if (!config.memoryId) return null
    try {
      memoryCtxRef.current = await createMemoryContext(config.memoryId)
      return memoryCtxRef.current
    } catch (err) {
      console.warn('Memory context unavailable', err)
      return null
    }
  }, [config.memoryId])

  const [sessionsError, setSessionsError] = useState<string>('')

  const refreshSessions = useCallback(async () => {
    const ctx = await getMemoryCtx()
    if (!ctx) {
      setSessionsError('履歴ストレージに接続できません (memoryId 未設定の可能性)')
      return
    }
    try {
      const list = await listSessions(ctx)
      setSessions(
        list.map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          fileName: s.fileName,
          createdAt: s.createdAt,
        })),
      )
      setSessionsError('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('Failed to list sessions', err)
      setSessionsError(msg)
    }
  }, [getMemoryCtx])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  const handleNewSession = useCallback(() => {
    setSessionId(crypto.randomUUID())
    setMessages([])
    setFile(null)
    setParseResult(null)
    setError('')
    setInputText('')
    setState('idle')
  }, [])

  const handleFileSelect = useCallback((f: File) => {
    setFile(f)
    setError('')
    setParseResult(null)
    setState('idle')
  }, [])

  const handleParse = useCallback(async () => {
    if (!file) return
    setState('parsing')
    setError('')

    try {
      const token = await getAccessToken()

      const arrayBuffer = await file.arrayBuffer()
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          '',
        ),
      )

      const res = await fetch(`${config.pptxParseApiUrl}/api/pptx/parse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ file: base64 }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'サーバーエラーが発生しました' }))
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const result: ParseResult = await res.json()
      setParseResult(result)
      setState('parsed')
    } catch (err) {
      setError(err instanceof Error ? err.message : '解析中にエラーが発生しました')
      setState('error')
    }
  }, [file, config.pptxParseApiUrl])

  const streamInvoke = useCallback(
    async (
      payload: InvokePayload,
      onDelta: (text: string) => void,
      onTitle: (title: string) => void,
    ) => {
      const token = await getAccessToken()
      const url = `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent(config.agentRuntimeArn)}/invocations?qualifier=DEFAULT`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
          'x-amzn-bedrock-agentcore-runtime-session-id': sessionId,
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        throw new Error(`リクエストに失敗しました (HTTP ${res.status})`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('ストリーミング応答を取得できません')

      const decoder = new TextDecoder()
      let lineBuf = ''
      let currentEvent = 'message'

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        lineBuf += decoder.decode(value, { stream: true })
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim() || 'message'
            continue
          }
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data) as { text?: string; title?: string }
            if (currentEvent === 'title' && parsed.title) {
              onTitle(parsed.title)
            } else if (parsed.text) {
              onDelta(parsed.text)
            }
          } catch {
            // noop
          }
        }
      }
    },
    [config.agentRuntimeArn, sessionId],
  )

  const handleInitialReview = useCallback(async () => {
    if (!parseResult) return
    setState('reviewing')
    setError('')

    const userMsgId = crypto.randomUUID()
    const assistantMsgId = crypto.randomUUID()
    const userContent = `${file?.name ?? 'PPTX'} をレビューしてください。`
    setMessages([
      { id: userMsgId, role: 'user', content: userContent },
      { id: assistantMsgId, role: 'assistant', content: '' },
    ])

    const ctx = await getMemoryCtx()
    if (ctx) {
      try {
        await saveMessage(
          ctx,
          sessionId,
          'user',
          userContent,
          file?.name ? { fileName: file.name } : undefined,
        )
      } catch (err) {
        console.warn('saveMessage(user) failed', err)
      }
    }

    let assistantText = ''
    let assistantTitle = ''
    try {
      await streamInvoke(
        { mode: 'initial', slides: toAgentSlides(parseResult.slides), fileName: file?.name },
        (delta) => {
          assistantText += delta
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? { ...m, content: assistantText } : m)),
          )
        },
        (title) => {
          assistantTitle = title
          setSessions((prev) => {
            const existing = prev.find((s) => s.sessionId === sessionId)
            if (existing) {
              return prev.map((s) => (s.sessionId === sessionId ? { ...s, title } : s))
            }
            return [
              { sessionId, title, fileName: file?.name, createdAt: new Date() },
              ...prev,
            ]
          })
        },
      )

      const structured = parseReviewText(assistantText)
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, structured } : m)),
      )

      if (ctx && assistantText) {
        try {
          const metadata: Record<string, string> = {}
          if (assistantTitle) metadata.title = assistantTitle
          if (file?.name) metadata.fileName = file.name
          await saveMessage(
            ctx,
            sessionId,
            'assistant',
            assistantText,
            Object.keys(metadata).length > 0 ? metadata : undefined,
          )
        } catch (err) {
          console.warn('saveMessage(assistant) failed', err)
        }
      }

      setState('chatting')
      void refreshSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'レビュー中にエラーが発生しました')
      setState('error')
    }
  }, [parseResult, file, streamInvoke, sessionId, refreshSessions, getMemoryCtx])

  const handleSendFollowup = useCallback(async () => {
    const text = inputText.trim()
    if (!text || state !== 'chatting') return
    setError('')
    setInputText('')

    // 現在の UI 状態をそのまま agent に渡す履歴として snapshot。
    // 空の placeholder assistant（ストリーム受信待ち）は除外する。
    const history: ConversationTurn[] = messages
      .filter((m) => m.content)
      .map((m) => ({ role: m.role, content: m.content }))

    const userMsgId = crypto.randomUUID()
    const assistantMsgId = crypto.randomUUID()
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: text },
      { id: assistantMsgId, role: 'assistant', content: '' },
    ])

    const ctx = await getMemoryCtx()
    if (ctx) {
      try {
        await saveMessage(ctx, sessionId, 'user', text)
      } catch (err) {
        console.warn('saveMessage(user) failed', err)
      }
    }

    let assistantText = ''
    try {
      await streamInvoke(
        { mode: 'followup', message: text, history },
        (delta) => {
          assistantText += delta
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? { ...m, content: assistantText } : m)),
          )
        },
        () => {},
      )

      if (ctx && assistantText) {
        try {
          await saveMessage(ctx, sessionId, 'assistant', assistantText)
        } catch (err) {
          console.warn('saveMessage(assistant) failed', err)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信中にエラーが発生しました')
    }
  }, [inputText, state, messages, streamInvoke, sessionId, getMemoryCtx])

  const handleSelectSession = useCallback(
    async (targetId: string) => {
      if (targetId === sessionId && messages.length > 0) return
      const ctx = await getMemoryCtx()
      if (!ctx) return
      setState('restoring')
      setError('')
      setSessionId(targetId)
      setFile(null)
      setParseResult(null)
      try {
        const past = await listMessages(ctx, targetId)
        const restored: ConversationMessage[] = past.map((m, i) => {
          const base: ConversationMessage = {
            id: `${targetId}-${i}`,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          }
          if (i === 1 && m.role === 'assistant') {
            return { ...base, structured: parseReviewText(m.content) }
          }
          return base
        })
        setMessages(restored)
        setState('chatting')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'セッション復元に失敗しました')
        setState('error')
      }
    },
    [sessionId, messages.length, getMemoryCtx],
  )

  const activeSession = sessions.find((s) => s.sessionId === sessionId)
  const headerTitle = activeSession?.title ?? (file?.name ?? '新しいレビュー')

  // Upload フェーズ: 履歴もファイルもない、あるいは parsing/parsed 中
  const showUploadFlow =
    messages.length === 0 &&
    (state === 'idle' || state === 'parsing' || state === 'parsed' || state === 'error')

  return (
    <div className="flex h-screen flex-col bg-bg-light">
      <header className="border-b border-border bg-white px-6 py-4">
        <div className="flex items-center gap-3">
          <FileText className="h-6 w-6 text-teal" />
          <h1 className="text-xl font-bold text-text-primary">AI Manager</h1>
          <span className="ml-auto text-sm text-text-muted">{user?.signInDetails?.loginId}</span>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="h-4 w-4" />
            サインアウト
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <HistorySidebar
          sessions={sessions}
          activeSessionId={sessionId}
          onNewSession={handleNewSession}
          onSelectSession={(id) => void handleSelectSession(id)}
          errorMessage={sessionsError}
        />

        {showUploadFlow ? (
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-6 py-10 space-y-6">
              <UploadCard
                file={file}
                isLoading={state === 'parsing'}
                isParsing={state === 'parsing'}
                isReviewing={false}
                hasParseResult={!!parseResult}
                onFileSelect={handleFileSelect}
                onParse={handleParse}
                onReview={handleInitialReview}
                onReset={handleNewSession}
              />
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>エラー</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          </main>
        ) : (
          <ChatPanel
            state={state}
            headerTitle={headerTitle}
            fileName={file?.name ?? activeSession?.fileName}
            parseResult={parseResult}
            messages={messages}
            error={error}
            inputText={inputText}
            onInputChange={setInputText}
            onSend={() => void handleSendFollowup()}
          />
        )}

        <ReferenceSidebar />
      </div>
    </div>
  )
}

export default App
