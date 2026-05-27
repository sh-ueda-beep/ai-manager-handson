import { ToolLoopAgent, tool, generateText } from 'ai'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'

// Knowledge Base / Nova MME は us-east-1 に配置
const KB_REGION = process.env['KB_REGION'] ?? 'us-east-1'

const bedrock = createAmazonBedrock({
  region: process.env['AWS_REGION'] ?? KB_REGION,
  credentialProvider: fromNodeProviderChain(),
})

const bedrockAgentRuntime = new BedrockAgentRuntimeClient({ region: KB_REGION })
const s3 = new S3Client({ region: KB_REGION })

const KNOWLEDGE_BASE_ID = process.env['KNOWLEDGE_BASE_ID'] ?? ''
const MAX_IMAGE_CHUNKS = 3

type Modality = 'text' | 'image' | 'document'

const slideSchema = z.object({
  slideNumber: z.number(),
  title: z.string(),
  body: z.string(),
  notes: z.string(),
  // フロントエンドからの送信は枚数情報のみ（画像バイトは送らない）
  imageCount: z.number().optional(),
})

const initialRequestSchema = z.object({
  mode: z.literal('initial'),
  slides: z.array(slideSchema),
  fileName: z.string().optional(),
})

const conversationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
})

const followupRequestSchema = z.object({
  mode: z.literal('followup'),
  message: z.string(),
  history: z.array(conversationTurnSchema).default([]),
})

const requestSchema = z.discriminatedUnion('mode', [
  initialRequestSchema,
  followupRequestSchema,
])

const systemPrompt = `あなたはプレゼンテーション資料のレビュー専門家です。提供されたスライドデータを分析し、以下の4つの観点でレビューコメントを生成してください。

## レビュー観点

1. **構成**: スライドの流れ・論理展開が適切か。結論が明確に提示されているか。ストーリーラインが一貫しているか。
2. **内容の明確さ**: 各スライドのメッセージが明確か。聴衆が理解しやすい表現になっているか。
3. **情報量**: 1スライドあたりの情報量が適切か。過多の場合はスライド分割を、過少の場合は統合を提案する。
4. **表現**: 誤字脱字、不自然な表現、敬語の不統一など、テキストの品質に関する指摘。

## 出力形式

以下の形式で日本語で出力してください:

### 全体総評
資料全体に対する評価と改善提案を3〜5文で記述。

### スライド別コメント

**スライド N: 「タイトル」**
- [構成] コメント
- [明確さ] コメント
- [情報量] コメント
- [表現] コメント

※ 指摘がない観点はスキップしてください。
※ 特に問題のないスライドは「特に指摘なし」と記載してください。

5. **参照データとの整合性**: 参照データ（ガイドライン等）が提供されている場合、その内容との整合性を確認する。

## 注意事項
- 具体的で実行可能な改善提案を心がけてください
- ポジティブな点も積極的に指摘してください
- スピーカーノートがある場合は、スライドの補足情報として考慮してください
- 参照データが提供されている場合は、レビューの最後に「参照したデータ」セクションで参照ファイル名を列挙してください
- 画像参照データが提供されている場合は、実際に目視して内容をコメントに反映してください
- 参照データが提供されていない場合は、一般知識のみでレビューを行ってください
`

const followupSystemPrompt = `あなたはプレゼンテーション資料のレビュー専門家です。ユーザーのフォローアップ質問に日本語で回答してください。

## 会話履歴
- この会話のこれまでのやり取り（初回の PPTX レビュー結果を含む）は本プロンプトに続くメッセージ履歴として提供されます。常に履歴を踏まえて回答してください。
- ユーザーが「先ほどの〜」「スライド N について」「さっき言ってた」のように過去の発言を参照する場合は、履歴中の該当箇所をもとに具体的に答えてください。
- 履歴が空の場合のみ「まだ資料のレビューがありません」と案内して構いません。

## ツール
- 社内ガイドラインの確認には searchReference を使って構いません。`

function inferModalityFromUri(uri?: string): Modality {
  if (!uri) return 'text'
  const lower = uri.toLowerCase()
  if (/\.(png|jpe?g|gif|webp)$/.test(lower)) return 'image'
  if (/\.pdf$/.test(lower)) return 'document'
  return 'text'
}

function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/)
  if (!match) return null
  return { bucket: match[1], key: match[2] }
}

async function presignS3Uri(uri: string): Promise<string | undefined> {
  const parsed = parseS3Uri(uri)
  if (!parsed) return undefined
  try {
    return await getSignedUrl(
      s3 as unknown as Parameters<typeof getSignedUrl>[0],
      new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }),
      { expiresIn: 300 }
    )
  } catch {
    return undefined
  }
}

async function fetchImageBytes(uri: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  const parsed = parseS3Uri(uri)
  if (!parsed) return null
  try {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key })
    )
    const bytes = await result.Body?.transformToByteArray()
    if (!bytes) return null
    const mediaType = result.ContentType ?? 'image/png'
    return { bytes, mediaType }
  } catch {
    return null
  }
}

type RetrievedChunk = {
  index: number
  modality: Modality
  text?: string
  sourceS3Uri: string
  sourceLabel: string
  mediaType?: string
  score: number
  presignedUrl?: string
}

async function retrieveReferences(query: string): Promise<RetrievedChunk[]> {
  if (!KNOWLEDGE_BASE_ID) return []

  const result = await bedrockAgentRuntime.send(
    new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: 5 },
      },
    })
  )

  const chunks = result.retrievalResults ?? []
  const hydrated: RetrievedChunk[] = []
  let i = 0
  for (const c of chunks) {
    const sourceS3Uri = c.location?.s3Location?.uri ?? ''
    const modality = inferModalityFromUri(sourceS3Uri)
    const sourceLabel = sourceS3Uri.split('/').pop() ?? '不明'
    const text = c.content?.text ?? undefined
    const score = c.score ?? 0

    const chunk: RetrievedChunk = {
      index: i + 1,
      modality,
      sourceS3Uri,
      sourceLabel,
      score,
    }
    if (text) chunk.text = text
    if (modality === 'image' && sourceS3Uri) {
      chunk.presignedUrl = await presignS3Uri(sourceS3Uri)
    }
    hydrated.push(chunk)
    i += 1
  }
  return hydrated
}

type VisionAttachment = { mediaType: string; base64: string; sourceLabel: string }

async function buildVisionAttachments(chunks: RetrievedChunk[]): Promise<VisionAttachment[]> {
  const imageChunks = chunks
    .filter(c => c.modality === 'image')
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_IMAGE_CHUNKS)

  const attachments: VisionAttachment[] = []
  for (const c of imageChunks) {
    const fetched = await fetchImageBytes(c.sourceS3Uri)
    if (!fetched) continue
    attachments.push({
      mediaType: c.mediaType ?? fetched.mediaType,
      base64: Buffer.from(fetched.bytes).toString('base64'),
      sourceLabel: c.sourceLabel,
    })
  }
  return attachments
}

const searchReferenceTool = tool({
  description:
    '社内ガイドラインや参照データ（テキスト・画像・PDF）を検索します。レビュー時に関連する社内ルール・図表・デザインガイド等を確認するために使用してください。Knowledge Base にデータが登録されていない場合は空の結果を返します。',
  inputSchema: z.object({
    query: z.string().describe('検索クエリ（スライドの内容やキーワード）'),
  }),
  execute: async ({ query }) => {
    if (!KNOWLEDGE_BASE_ID) {
      return { results: [], message: '参照データが登録されていません' }
    }
    try {
      const chunks = await retrieveReferences(query)
      return {
        results: chunks.map(c => ({
          index: c.index,
          modality: c.modality,
          text: c.text,
          source: c.sourceLabel,
          sourceS3Uri: c.sourceS3Uri,
          presignedUrl: c.presignedUrl,
          score: c.score,
        })),
        message:
          chunks.length > 0
            ? `${chunks.length}件の参照データが見つかりました（画像${chunks.filter(c => c.modality === 'image').length}件含む）`
            : '関連する参照データが見つかりませんでした',
      }
    } catch (err) {
      console.error('Retrieve failed', err)
      return { results: [], message: '参照データの検索に失敗しました' }
    }
  },
})

// Claude Sonnet 4.6 の inference profile はリージョンごとに異なる。
// KB_REGION が us-east-1 なら us. 系、ap-northeast-1 なら jp. 系。
const CLAUDE_MODEL_ID =
  process.env['CLAUDE_MODEL_ID'] ??
  (KB_REGION.startsWith('us-')
    ? 'us.anthropic.claude-sonnet-4-6'
    : 'jp.anthropic.claude-sonnet-4-6')

const TITLE_MODEL_ID =
  process.env['TITLE_MODEL_ID'] ??
  (KB_REGION.startsWith('us-')
    ? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
    : 'jp.anthropic.claude-haiku-4-5-20251001-v1:0')

const reviewAgent = new ToolLoopAgent({
  model: bedrock(CLAUDE_MODEL_ID),
  tools: { searchReference: searchReferenceTool },
})

type UserContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; mediaType: string }
>

function formatSlides(slides: z.infer<typeof slideSchema>[]): string {
  return slides
    .map(s => {
      let text = `## スライド ${s.slideNumber}`
      if (s.title) text += `\nタイトル: ${s.title}`
      if (s.body) text += `\n本文:\n${s.body}`
      if (s.notes) text += `\nノート:\n${s.notes}`
      if (s.imageCount && s.imageCount > 0) {
        text += `\n（スライド内に画像 ${s.imageCount} 枚あり）`
      }
      return text
    })
    .join('\n\n---\n\n')
}

async function generateTitle(reviewText: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: bedrock(TITLE_MODEL_ID),
      prompt: `次のレビュー結果の冒頭部分から、20文字以内の日本語タイトルのみを返してください。装飾（括弧、引用符、「〜について」などの定型）は不要です。\n\n---\n${reviewText.slice(0, 800)}`,
    })
    const cleaned = text.trim().replace(/^[「『"'\s]+|[」』"'\s]+$/g, '').slice(0, 40)
    return cleaned || fallbackTitle()
  } catch {
    return fallbackTitle()
  }
}

function fallbackTitle(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} のレビュー`
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    process: async function* (request, context) {
      const sessionId = context.sessionId
      console.log(`[agent] request: sessionId=${sessionId} mode=${request.mode}`)

      if (request.mode === 'initial') {
        const slidesText = formatSlides(request.slides)

        // 事前に参照データを検索し、画像があれば Claude の vision 入力に展開
        let retrievedChunks: RetrievedChunk[] = []
        let visionAttachments: VisionAttachment[] = []
        try {
          retrievedChunks = await retrieveReferences(
            request.slides
              .map(s => `${s.title} ${s.body}`.trim())
              .filter(Boolean)
              .join('\n')
              .slice(0, 2000)
          )
          visionAttachments = await buildVisionAttachments(retrievedChunks)
        } catch (err) {
          console.error('Pre-retrieve failed, continuing without reference data', err)
        }

        const userContent: UserContent = [
          {
            type: 'text',
            text:
              `以下のプレゼン資料（${request.slides.length}枚のスライド）をレビューしてください。\n\n` +
              `必要に応じて searchReference ツールを使って追加の関連参照データを検索してください。\n\n` +
              (visionAttachments.length > 0
                ? `以下に、関連する参照画像を ${visionAttachments.length} 枚添付しました。画像の内容も踏まえてレビューしてください。\n` +
                  visionAttachments.map((a, i) => `- 画像${i + 1}: ${a.sourceLabel}`).join('\n') +
                  '\n\n'
                : '') +
              slidesText,
          },
          ...visionAttachments.map(a => ({
            type: 'image' as const,
            image: a.base64,
            mediaType: a.mediaType,
          })),
        ]

        const stream = await reviewAgent.stream({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent as unknown as string },
          ],
        })

        let assistantText = ''
        for await (const chunk of stream.fullStream) {
          if (chunk.type === 'text-delta') {
            assistantText += chunk.text
            yield { event: 'message', data: { text: chunk.text } }
          }
        }

        if (assistantText) {
          const title = await generateTitle(assistantText)
          yield { event: 'title', data: { title } }
        }
        return
      }

      // followup: フロントから渡された history を system prompt の後に直接前置する
      console.log(`[agent] followup: history length=${request.history.length}`)
      const stream = await reviewAgent.stream({
        messages: [
          { role: 'system', content: followupSystemPrompt },
          ...request.history.map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: request.message },
        ],
      })

      for await (const chunk of stream.fullStream) {
        if (chunk.type === 'text-delta') {
          yield { event: 'message', data: { text: chunk.text } }
        }
      }
    },
  },
})

app.run()
