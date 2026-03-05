import { ToolLoopAgent } from 'ai'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime'
import { z } from 'zod'

const bedrock = createAmazonBedrock({
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  credentialProvider: fromNodeProviderChain(),
})

const slideSchema = z.object({
  slideNumber: z.number(),
  title: z.string(),
  body: z.string(),
  notes: z.string(),
})

const requestSchema = z.object({
  slides: z.array(slideSchema),
})

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

## 注意事項
- 具体的で実行可能な改善提案を心がけてください
- ポジティブな点も積極的に指摘してください
- スピーカーノートがある場合は、スライドの補足情報として考慮してください
`

const reviewAgent = new ToolLoopAgent({
  model: bedrock('jp.anthropic.claude-sonnet-4-6'),
  tools: {},
})

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    process: async function* (request, _context) {
      // スライドデータをプロンプトに整形
      const slidesText = request.slides
        .map((s) => {
          let text = `## スライド ${s.slideNumber}`
          if (s.title) text += `\nタイトル: ${s.title}`
          if (s.body) text += `\n本文:\n${s.body}`
          if (s.notes) text += `\nノート:\n${s.notes}`
          return text
        })
        .join('\n\n---\n\n')

      const userMessage = `以下のプレゼン資料（${request.slides.length}枚のスライド）をレビューしてください。\n\n${slidesText}`

      const stream = await reviewAgent.stream({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
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
