import { ToolLoopAgent, tool } from 'ai'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime'
import { z } from 'zod'

const bedrock = createAmazonBedrock({
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  credentialProvider: fromNodeProviderChain(),
})

const bedrockAgentRuntime = new BedrockAgentRuntimeClient({
  region: process.env['AWS_REGION'] ?? 'ap-northeast-1',
})

const KNOWLEDGE_BASE_ID = process.env['KNOWLEDGE_BASE_ID'] ?? ''

const slideImageSchema = z.object({
  mediaType: z.string(),
  data: z.string(),
})

const slideSchema = z.object({
  slideNumber: z.number(),
  title: z.string(),
  body: z.string(),
  notes: z.string(),
  images: z.array(slideImageSchema).default([]),
  imagesTruncated: z.boolean().default(false),
})

const requestSchema = z.object({
  slides: z.array(slideSchema),
})

const systemPrompt = `あなたはプレゼンテーション資料のレビュー専門家です。提供されたスライドデータを分析し、以下の観点でレビューコメントを生成してください。

## レビュー観点

1. **構成**: スライドの流れ・論理展開が適切か。結論が明確に提示されているか。ストーリーラインが一貫しているか。
2. **内容の明確さ**: 各スライドのメッセージが明確か。聴衆が理解しやすい表現になっているか。
3. **情報量**: 1スライドあたりの情報量が適切か。過多の場合はスライド分割を、過少の場合は統合を提案する。
4. **表現**: 誤字脱字、不自然な表現、敬語の不統一など、テキストの品質に関する指摘。
5. **ビジュアル品質**（画像ありスライドのみ）: 図・グラフ・画像の明瞭さ、情報密度、画像内テキストの可読性（フォントサイズ・コントラスト）、スライド全体のデザインとの整合性。

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
- 【ビジュアル】コメント（画像ありスライドのみ。ビジュアル観点の指摘は必ず「【ビジュアル】」で始めてください）

※ 指摘がない観点はスキップしてください。
※ 特に問題のないスライドは「特に指摘なし」と記載してください。
※ 参照データとの整合性: 参照データ（ガイドライン等）が提供されている場合、その内容との整合性を確認する。

## 注意事項
- 具体的で実行可能な改善提案を心がけてください
- ポジティブな点も積極的に指摘してください
- スピーカーノートがある場合は、スライドの補足情報として考慮してください
- 画像が提供されている場合は、テキストと画像の両方を踏まえてレビューを行ってください
- 参照データが提供されている場合は、レビューの最後に「参照したデータ」セクションで参照ファイル名を列挙してください
- 参照データが提供されていない場合は、一般知識のみでレビューを行ってください
`

const searchReferenceTool = tool({
  description: '社内ガイドラインや参照データを検索します。レビュー時に関連する社内ルールやガイドラインを確認するために使用してください。Knowledge Base にデータが登録されていない場合は空の結果を返します。',
  inputSchema: z.object({
    query: z.string().describe('検索クエリ（スライドの内容やキーワード）'),
  }),
  execute: async ({ query }) => {
    if (!KNOWLEDGE_BASE_ID) {
      return { results: [], message: '参照データが登録されていません' }
    }

    try {
      const result = await bedrockAgentRuntime.send(new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: { text: query },
        retrievalConfiguration: {
          vectorSearchConfiguration: { numberOfResults: 5 },
        },
      }))

      const chunks = result.retrievalResults ?? []
      return {
        results: chunks.map((c, i) => ({
          index: i + 1,
          text: c.content?.text ?? '',
          source: c.location?.s3Location?.uri?.split('/').pop() ?? '不明',
          score: c.score ?? 0,
        })),
        message: chunks.length > 0
          ? `${chunks.length}件の参照データが見つかりました`
          : '関連する参照データが見つかりませんでした',
      }
    } catch {
      return { results: [], message: '参照データの検索に失敗しました' }
    }
  },
})

const reviewAgent = new ToolLoopAgent({
  model: bedrock('jp.anthropic.claude-sonnet-4-6'),
  tools: { searchReference: searchReferenceTool },
})

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    process: async function* (request, _context) {
      // スライドデータをマルチモーダルコンテンツに整形
      type ContentBlock =
        | { type: 'text'; text: string }
        | { type: 'image'; image: string; mimeType: string }

      const contentBlocks: ContentBlock[] = [
        {
          type: 'text',
          text: `以下のプレゼン資料（${request.slides.length}枚のスライド）をレビューしてください。\n\nまず searchReference ツールを使って関連する社内ガイドラインを検索し、見つかった場合はその内容も踏まえてレビューを行ってください。\n\n`,
        },
      ]

      for (const s of request.slides) {
        let slideText = `## スライド ${s.slideNumber}`
        if (s.title) slideText += `\nタイトル: ${s.title}`
        if (s.body) slideText += `\n本文:\n${s.body}`
        if (s.notes) slideText += `\nノート:\n${s.notes}`
        if (s.images.length > 0) slideText += `\n（以下に画像 ${s.images.length} 枚を添付）`
        contentBlocks.push({ type: 'text', text: slideText + '\n\n---\n\n' })

        for (const img of s.images) {
          contentBlocks.push({
            type: 'image',
            image: img.data,
            mimeType: img.mediaType,
          })
        }
      }

      const stream = await reviewAgent.stream({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: contentBlocks },
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
