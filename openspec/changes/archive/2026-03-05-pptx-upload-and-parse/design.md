## Context

本プロジェクトは AWS Amplify Gen2 ベースの React アプリケーションで、現在は Cognito 認証のみが実装されている。PPTX ファイルをアップロードし、AI エージェントにレビューさせる機能を新規追加する。

現状のフロントエンドには `App.tsx` にアップロード用のプレースホルダー UI（破線ボーダーの領域）が既に存在する。バックエンドには Lambda 関数や API エンドポイントはまだ存在しない。

## Goals / Non-Goals

**Goals:**

- PPTX ファイルをブラウザからアップロードし、スライドごとのテキスト・構造を抽出できる
- 抽出結果を AI に渡してレビューコメントを生成し、ユーザーに表示する
- 認証済みユーザーのみがアップロード・レビュー機能を利用できる

**Non-Goals:**

- PPTX 内の画像・グラフ・アニメーションの解析（テキストと構造のみ対象）
- PPTX ファイルの編集・再生成
- レビュー結果の永続化・履歴管理（初期リリースでは都度実行）
- PPTX 以外のファイル形式（PDF、DOCX 等）への対応

## Decisions

### 1. ファイルアップロード方式: Lambda 直接アップロード

**選択**: API Gateway + Lambda にファイルを直接 POST する

**理由**: S3 presigned URL 方式（S3 にアップロード → S3 イベントで Lambda 起動）も検討したが、以下の理由で直接アップロードを採用する。

- PPTX ファイルは通常数 MB 程度で、API Gateway のペイロード上限（10MB）に収まる
- S3 バケットの追加管理が不要でインフラがシンプル
- アップロード → 解析 → レスポンスを同期的に処理でき、フロントエンドの実装が容易
- ファイルの永続化は Non-Goal のため、一時保存の仕組みが不要

**代替案**: S3 presigned URL + Lambda トリガー。大容量ファイルや永続化が必要になった場合はこちらに移行する。

### 2. PPTX 解析ライブラリ: pptx-composer ではなく直接 XML 解析

**選択**: `xml2js`（または `fast-xml-parser`）を使って PPTX（ZIP 内の XML）を直接パースする

**理由**:

- PPTX は ZIP 形式で、中身は XML ファイル群（`ppt/slides/slide*.xml`）
- テキスト抽出のみが目的なので、専用ライブラリのオーバーヘッドは不要
- `jszip` で ZIP を展開し、XML からテキストノード（`<a:t>` タグ）を抽出するシンプルな実装で十分
- Docker Lambda（Node 22）で動作するため、ネイティブ依存のないピュア JS ライブラリが望ましい

**代替案**: `python-pptx`（Python Lambda）。より高機能だが、技術スタックが TypeScript に統一されているため不採用。

### 3. AI レビュー: Bedrock AgentCore Runtime

**選択**: Bedrock AgentCore Runtime でレビューエージェントを構築する（diff_workflow プロジェクトと同じパターン）

**構成**:

- `amplify/agent/` ディレクトリに AgentCore アプリケーションを配置
- `BedrockAgentCoreApp`（`bedrock-agentcore` SDK）でランタイムを構成
- Vercel AI SDK（`ai` + `@ai-sdk/amazon-bedrock`）で Claude モデルを呼び出し
- Docker コンテナ（Node 22）として AgentCore にデプロイ
- CDK で `@aws-cdk/aws-bedrock-agentcore-alpha` の `Runtime` コンストラクトを使用
- Cognito 認証と連携（`RuntimeAuthorizerConfiguration.usingCognito`）

**理由**:

- AgentCore Runtime はエージェント実行に最適化されたマネージドサービスで、Lambda のタイムアウト制約（最大 15 分）を気にせずストリーミング応答が可能
- Cognito 認証を直接統合でき、既存の認証基盤をそのまま活用
- ツール呼び出し（`ToolLoopAgent`）やストリーミングレスポンスが標準サポート
- 同プロジェクト内の diff_workflow で実績があり、パターンが確立されている

**代替案**: Lambda から直接 Bedrock API を呼び出す。シンプルだが、ストリーミング応答やツールループが扱いにくく、AgentCore の方がエージェント用途に適している。

### 4. API 設計: Lambda（解析）+ AgentCore（レビュー）の 2 系統

**選択**: PPTX 解析は API Gateway + Lambda、AI レビューは AgentCore Runtime エンドポイント

| 処理 | エンドポイント | 基盤 | 説明 |
|---|---|---|---|
| PPTX 解析 | API Gateway `/api/pptx/parse` | Lambda | PPTX ファイルを受け取り、スライドごとのテキスト・構造を JSON で返す |
| AI レビュー | AgentCore Runtime URL | AgentCore | 解析済みテキストを受け取り、ストリーミングでレビューコメントを返す |

**理由**:

- PPTX 解析は単純な変換処理のため Lambda が適切（短時間で完了、同期レスポンス）
- AI レビューはストリーミング応答が必要で、AgentCore Runtime が最適
- 解析結果をユーザーに先に表示し、その後レビューを実行する UX が可能
- レビューのみ再実行したい場合に解析をスキップできる
- フロントエンドからは Cognito トークンで両方のエンドポイントに認証アクセス

**代替案**: 1 エンドポイントで解析 → レビューを一括処理。シンプルだが、レビュー生成に時間がかかるため UX が悪化する。

### 5. バックエンド構成: Lambda（解析）+ AgentCore Runtime（レビュー）

**選択**: 2 つの異なる実行基盤を用途に応じて使い分け

- `amplify/functions/pptx-parse/`: PPTX 解析用 Lambda（Docker, ARM64, Node 22, jszip + xml2js）
- `amplify/agent/`: AI レビュー用 AgentCore Runtime（Docker, Node 22, bedrock-agentcore + ai SDK）

**理由**:

- PPTX 解析は短時間で完了する同期処理のため Lambda が適切
- AI レビューはストリーミング・ツールループが必要なため AgentCore Runtime が適切
- CDK カスタマイズで `createAgentCoreRuntime()` を定義し、Cognito 認証・Bedrock 権限を一括設定
- `deploy-time-build` で ARM64 Docker イメージを CodeBuild でビルド

### 6. フロントエンド: 既存 App.tsx のプレースホルダーを拡張

**選択**: `App.tsx` のプレースホルダー部分をアップロード UI に置き換え、結果表示はモーダルまたは同一ページ内に展開

**理由**:

- 既にプレースホルダー UI が存在するため、自然な拡張ポイント
- 初期リリースではシングルページで完結させ、ルーティングは追加しない
- 既存の Card、Button、Alert、Spinner コンポーネントを活用

## Implementation Patterns（実装パターン参照）

以下は各コンポーネントの具体的な実装パターン。openspec の設計意図を正確にコードへ反映するための参照情報。

### Lambda 構成（CDK コンストラクト）

Docker Lambda は `lambda.DockerImageFunction` + `DockerImageCode.fromImageAsset` を使用する。`lambda.Function` にローカルバンドリングを設定するパターンではない。

```typescript
// amplify/functions/pptx-parse/resource.ts
const fn = new lambda.DockerImageFunction(stack, 'PptxParseFn', {
  code: lambda.DockerImageCode.fromImageAsset(
    path.dirname(fileURLToPath(import.meta.url)),
    { platform: Platform.LINUX_ARM64 }
  ),
  architecture: lambda.Architecture.ARM_64,
  memorySize: 512,
  timeout: Duration.seconds(30),
});
```

### リクエスト形式（PPTX 送信）

Base64 エンコードした PPTX は JSON ラッパーの `file` フィールドに格納して送信する。`Content-Type: application/octet-stream` で生 Base64 を送るパターンではない。

```typescript
// フロントエンド
fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ file: base64 }),
});

// Lambda ハンドラー
const body = JSON.parse(event.body);
const { file } = body as { file?: string };
const buffer = Buffer.from(file, 'base64');
```

### ToolLoopAgent API パターン

`ToolLoopAgent` は `stream({ messages })` で呼び出し、`fullStream` から `text-delta` イベントをフィルタする。`instructions` プロパティや `stream({ prompt })` + `textStream` パターンではない。

```typescript
// amplify/agent/app.ts
const reviewAgent = new ToolLoopAgent({ model: bedrock('...'), tools: {} });

const stream = await reviewAgent.stream({
  messages: [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ],
});

for await (const chunk of stream.fullStream) {
  if (chunk.type === 'text-delta') {
    yield { event: 'message', data: { text: chunk.text } };
  }
}
```

### XML パース方式

`fast-xml-parser` v5 系を使用し、`extractTextNodes` で再帰的に `<a:t>` タグを探索する。v4 系の `isArray` オプションや `extractTextFromParagraphs` パターンではない。

```typescript
// amplify/functions/pptx-parse/pptx-parser.ts
function extractTextNodes(obj: unknown): string[] {
  if (typeof obj === 'object' && obj !== null && 'a:t' in obj) {
    // 直接 a:t の値を取得
  }
  // 子要素を再帰探索
}
```

### Lambda ハンドラーの型定義

`@types/aws-lambda` の `APIGatewayProxyEventV2` ではなく、必要最小限のフィールドだけを持つ手書き `LambdaEvent` interface を使用する。Docker Lambda では `@types/aws-lambda` が不要になり、依存を減らせる。

```typescript
interface LambdaEvent {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string>;
  requestContext?: { http?: { method?: string } };
}
```

## Risks / Trade-offs

- **API Gateway 10MB 制限** → 大きな PPTX はアップロードできない。ユーザーにファイルサイズ上限を表示し、超過時はエラーメッセージを返す。将来的には S3 presigned URL 方式に移行可能。

- **Lambda コールドスタート** → Docker Lambda（解析用）は初回起動が遅い（数秒）。Spinner で待機状態を表示し、UX への影響を軽減。

- **AgentCore レスポンス時間** → AI レビュー生成に 10〜30 秒程度かかる可能性がある。AgentCore のストリーミング応答を活用し、フロントエンドでリアルタイムにテキストを表示することで体感待ち時間を軽減する。

- **PPTX パース精度** → 直接 XML 解析のため、複雑なレイアウト（SmartArt、グループ化されたテキストボックス等）ではテキスト抽出漏れの可能性がある。主要なテキスト要素（タイトル、本文、ノート）を優先的に抽出する。

- **Bedrock モデルのリージョン制約** → Claude モデルが利用可能なリージョンが限定される。AgentCore Runtime 内で `@ai-sdk/amazon-bedrock` のリージョン設定を適切に行う必要がある。

- **AgentCore の CDK アルファ版** → `@aws-cdk/aws-bedrock-agentcore-alpha` はアルファ版のため、API が変更される可能性がある。diff_workflow での実績があるバージョンに固定して利用する。

## Open Questions

- Bedrock で使用する Claude モデルのバージョン（Haiku / Sonnet）をどちらにするか？コストと品質のバランスで決定が必要。
- レビュー観点のカスタマイズ（構成チェック、誤字脱字、表現改善など）をユーザーが選べるようにするか？初期リリースでは固定で良いか。
