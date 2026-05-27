import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListSessionsCommand,
  ListEventsCommand,
  type SessionSummary,
  type Event,
} from '@aws-sdk/client-bedrock-agentcore'
import { fetchAuthSession } from 'aws-amplify/auth'

// Memory は AgentCore Runtime と同じリージョンに配置される前提
const REGION = 'us-east-1'

export type ConversationRole = 'user' | 'assistant'

export interface ConversationMessage {
  role: ConversationRole
  content: string
  timestamp?: Date
}

export interface SessionListItem {
  sessionId: string
  createdAt?: Date
  title?: string
  fileName?: string
}

async function getClient(): Promise<BedrockAgentCoreClient> {
  const session = await fetchAuthSession()
  const creds = session.credentials
  if (!creds) throw new Error('No Cognito Identity Pool credentials available')
  return new BedrockAgentCoreClient({
    region: REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      expiration: creds.expiration,
    },
  })
}

async function getActorId(): Promise<string> {
  const session = await fetchAuthSession()
  const sub = session.tokens?.idToken?.payload?.sub ?? session.userSub
  if (!sub) throw new Error('Cannot resolve Cognito sub (actorId)')
  return sub
}

export interface MemoryContext {
  client: BedrockAgentCoreClient
  actorId: string
  memoryId: string
}

export async function createMemoryContext(memoryId: string): Promise<MemoryContext> {
  const [client, actorId] = await Promise.all([getClient(), getActorId()])
  return { client, actorId, memoryId }
}

// AgentCore Memory の conversational payload は 8.6KB 上限を超えると CreateEvent が失敗する。
// UTF-8 バイト数で閾値を見て、超える場合は blob 形式にフォールバックする。
const CONVERSATIONAL_MAX_BYTES = 8000

// AgentCore Memory の metadata.stringValue は ASCII 制約 `[a-zA-Z0-9\s._:/=+@-]*` を持ち、
// 日本語などの非 ASCII を含む値を直接保存すると `InvalidInputException` で拒否される。
// パターンに収まらない値は base64 エンコードして `b64:` プレフィックスで区別する。
const METADATA_ASCII_SAFE = /^[a-zA-Z0-9\s._:/=+@-]*$/

function encodeMetadataValue(v: string): string {
  if (METADATA_ASCII_SAFE.test(v)) return v
  // btoa は Latin-1 限定なので、まず UTF-8 バイト列を Latin-1 文字列化してから base64 化する
  const utf8 = new TextEncoder().encode(v)
  let binary = ''
  for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8[i]!)
  return `b64:${btoa(binary)}`
}

function decodeMetadataValue(v: string): string {
  if (!v.startsWith('b64:')) return v
  try {
    const binary = atob(v.slice(4))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return v
  }
}

function buildPayload(role: ConversationRole, text: string) {
  const byteLength = new TextEncoder().encode(text).length
  if (byteLength <= CONVERSATIONAL_MAX_BYTES) {
    return {
      conversational: {
        role: role === 'user' ? 'USER' : 'ASSISTANT',
        content: { text },
      },
    } as const
  }
  // AgentCore Memory の `blob` フィールドに JS オブジェクトを渡すと、service 側で `{key=value}` 形式
  // (Java HashMap.toString() 風) に変換されて保存され、JSON.parse 不能な状態で返ってくる。
  // 文字列として渡すと opaque に保持されるため、こちら側で JSON.stringify してから渡す。
  return {
    blob: JSON.stringify({
      message: {
        role: role === 'user' ? 'user' : 'assistant',
        content: text,
      },
    }),
  } as const
}

export async function saveMessage(
  ctx: MemoryContext,
  sessionId: string,
  role: ConversationRole,
  text: string,
  metadata?: Record<string, string>,
): Promise<void> {
  if (!text) return
  await ctx.client.send(
    new CreateEventCommand({
      memoryId: ctx.memoryId,
      actorId: ctx.actorId,
      sessionId,
      eventTimestamp: new Date(),
      payload: [buildPayload(role, text)],
      ...(metadata
        ? {
            metadata: Object.fromEntries(
              Object.entries(metadata).map(([k, v]) => [k, { stringValue: encodeMetadataValue(v) }]),
            ),
          }
        : {}),
    }),
  )
}

/**
 * 自ユーザーの全セッションを新しい順に取得。
 * 各セッションの先頭 event metadata からタイトル/ファイル名を抽出する。
 */
export async function listSessions(ctx: MemoryContext): Promise<SessionListItem[]> {
  const summaries: SessionSummary[] = []
  let nextToken: string | undefined
  try {
    do {
      const resp = await ctx.client.send(
        new ListSessionsCommand({
          memoryId: ctx.memoryId,
          actorId: ctx.actorId,
          maxResults: 100,
          nextToken,
        }),
      )
      summaries.push(...(resp.sessionSummaries ?? []))
      nextToken = resp.nextToken
    } while (nextToken)
  } catch (err) {
    // Actor がまだ 1 件も event を持っていない場合 ResourceNotFoundException が返るが
    // これは履歴空を意味するのでエラー扱いせず空配列を返す
    if (isActorNotFound(err)) return []
    throw err
  }

  summaries.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))

  const items = await Promise.all(
    summaries.map(async (s): Promise<SessionListItem> => {
      const sessionId = s.sessionId ?? ''
      if (!sessionId) return { sessionId, createdAt: s.createdAt }
      const meta = await fetchSessionTitleMetadata(ctx, sessionId)
      return {
        sessionId,
        createdAt: s.createdAt,
        title: meta.title ?? fallbackTitle(s.createdAt),
        fileName: meta.fileName,
      }
    }),
  )
  return items
}

async function fetchSessionTitleMetadata(
  ctx: MemoryContext,
  sessionId: string,
): Promise<{ title?: string; fileName?: string }> {
  // ListEvents は newest-first で返るため、全件ページングで拾ってから timestamp 昇順で
  // 最古から title を探す。title は初回 assistant event の metadata に入る規約。
  try {
    const events: Event[] = []
    let nextToken: string | undefined
    do {
      const resp = await ctx.client.send(
        new ListEventsCommand({
          memoryId: ctx.memoryId,
          actorId: ctx.actorId,
          sessionId,
          includePayloads: false,
          maxResults: 100,
          nextToken,
        }),
      )
      events.push(...(resp.events ?? []))
      nextToken = resp.nextToken
    } while (nextToken)

    events.sort(
      (a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0),
    )

    let fileName: string | undefined
    for (const ev of events) {
      const md = ev.metadata
      if (!md) continue
      const title = stringMetadata(md['title'])
      if (title) {
        return {
          title,
          fileName: stringMetadata(md['fileName']) ?? fileName,
        }
      }
      fileName = fileName ?? stringMetadata(md['fileName'])
    }
    if (fileName) return { fileName }
  } catch {
    // noop
  }
  return {}
}

function fallbackTitle(createdAt?: Date): string {
  const d = createdAt ?? new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} のレビュー`
}

function isActorNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } }
  if (e.name === 'ResourceNotFoundException') return true
  const msg = e.message ?? ''
  return /actor .* not found/i.test(msg)
}

function stringMetadata(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = (value as { stringValue?: string }).stringValue
  if (typeof v !== 'string' || v.length === 0) return undefined
  return decodeMetadataValue(v)
}

export async function listMessages(
  ctx: MemoryContext,
  sessionId: string,
): Promise<ConversationMessage[]> {
  const events: Event[] = []
  let nextToken: string | undefined
  try {
    do {
      const resp = await ctx.client.send(
        new ListEventsCommand({
          memoryId: ctx.memoryId,
          actorId: ctx.actorId,
          sessionId,
          includePayloads: true,
          maxResults: 100,
          nextToken,
        }),
      )
      events.push(...(resp.events ?? []))
      nextToken = resp.nextToken
    } while (nextToken)
  } catch (err) {
    if (isActorNotFound(err)) return []
    throw err
  }

  events.sort(
    (a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0),
  )

  const messages: ConversationMessage[] = []
  for (const ev of events) {
    for (const p of ev.payload ?? []) {
      messages.push(...extractTurns(p, ev.eventTimestamp))
    }
  }
  return messages
}

type PayloadItem = NonNullable<Event['payload']>[number]

function extractTurns(p: PayloadItem, timestamp?: Date): ConversationMessage[] {
  if (p.conversational) {
    const role: ConversationRole = p.conversational.role === 'USER' ? 'user' : 'assistant'
    const content = p.conversational.content?.text ?? ''
    return content ? [{ role, content, timestamp }] : []
  }
  if (p.blob) {
    return parseBlobPayload(p.blob, timestamp)
  }
  return []
}

/**
 * payload が 8.6KB 超で blob 形式に切り替わった場合のパーサ。
 * 正常パターン: `JSON.stringify({message: {role, content}})` した文字列。
 * 旧データ救出: AgentCore Memory が JS オブジェクトを直接渡された場合に保存していた
 *   `{message={content=..., role=assistant}}` 形式 (Java HashMap.toString() 風) も
 *   ベストエフォートで復元する。
 */
export function parseBlobPayload(blob: unknown, timestamp?: Date): ConversationMessage[] {
  try {
    const outer = typeof blob === 'string' ? JSON.parse(blob) : blob
    const arr = Array.isArray(outer) ? outer : [outer]
    const result: ConversationMessage[] = []
    for (const item of arr) {
      const inner = typeof item === 'string' ? JSON.parse(item) : item
      const message = inner?.message
      if (!message) continue
      const roleRaw = String(message.role ?? '').toLowerCase()
      const role: ConversationRole = roleRaw === 'user' ? 'user' : 'assistant'
      const content =
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? '')
      if (content) result.push({ role, content, timestamp })
    }
    if (result.length > 0) return result
  } catch {
    // 旧データ救出フォールバックへ
  }
  if (typeof blob === 'string') {
    const fallback = parseBrokenBlobFallback(blob)
    if (fallback) return [{ ...fallback, timestamp }]
  }
  return []
}

/**
 * 旧データ救出: `{message={content=..., role=assistant}}` 形式から content / role を抽出する。
 * 末尾の `, role=xxx}}` を起点に逆向きに content を切り出すヒューリスティクス。
 */
function parseBrokenBlobFallback(s: string): { role: ConversationRole; content: string } | null {
  const m = s.match(/,\s*role=(\w+)\}\}\s*$/)
  if (!m) return null
  const role: ConversationRole = m[1]!.toLowerCase() === 'user' ? 'user' : 'assistant'
  const prefix = '{message={content='
  if (!s.startsWith(prefix)) return null
  const content = s.slice(prefix.length, m.index!)
  if (!content) return null
  return { role, content }
}
