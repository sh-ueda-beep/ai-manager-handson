## 1. PPTX 解析 Lambda のセットアップ

> **実装パターン参照**: design.md §Implementation Patterns「Lambda 構成」「Lambda ハンドラーの型定義」
> - CDK: `lambda.DockerImageFunction` + `DockerImageCode.fromImageAsset` を使用（`lambda.Function` ではない）
> - API Gateway は `resource.ts` 内で定義（`backend.ts` に直書きしない）
> - Lambda ハンドラーの型: 手書き `LambdaEvent` interface（`@types/aws-lambda` 不要）

- [x] 1.1 `amplify/functions/pptx-parse/` ディレクトリを作成し、Dockerfile（Node 22, ARM64）と package.json を配置する
- [x] 1.2 `amplify/functions/pptx-parse/resource.ts` に Lambda 関数定義（Docker, ARM64）を作成する
- [x] 1.3 `amplify/backend.ts` に pptx-parse Lambda と API Gateway V2 エンドポイント（`POST /api/pptx/parse`）を追加する
- [x] 1.4 API Gateway エンドポイントに Cognito JWT オーソライザーを設定する

## 2. PPTX 解析ロジックの実装

> **実装パターン参照**: design.md §Implementation Patterns「リクエスト形式」「XML パース方式」
> - `fast-xml-parser` は v5 系（`^5.2.3`）を使用（v4 系の `isArray` オプションではなく `extractTextNodes` 再帰パターン）
> - リクエスト形式: `Content-Type: application/json` + `{ file: base64 }`（生 Base64 ではない）

- [x] 2.1 `jszip` と `fast-xml-parser` を pptx-parse Lambda の依存に追加する
- [x] 2.2 Base64 エンコードされた PPTX ファイルを受信・デコードする Lambda ハンドラーを作成する
- [x] 2.3 `jszip` で ZIP を展開し、`ppt/slides/slide*.xml` からスライドテキスト（`<a:t>` タグ）を抽出する関数を実装する
- [x] 2.4 スライド内のタイトル要素（type: title/ctrTitle）と本文テキストを分類するロジックを実装する
- [x] 2.5 `ppt/notesSlides/notesSlide*.xml` からスピーカーノートを抽出するロジックを実装する
- [x] 2.6 レスポンス JSON（`{ totalSlides, slides: [{ slideNumber, title, body, notes }] }`）を返すようハンドラーを完成させる
- [x] 2.7 不正ファイル（非 ZIP、破損ファイル）に対するエラーハンドリングを実装する

## 3. AgentCore Runtime のセットアップ

- [x] 3.1 `amplify/agent/` ディレクトリを作成し、Dockerfile（Node 22）と package.json（`bedrock-agentcore`, `ai`, `@ai-sdk/amazon-bedrock`, `zod`）を配置する
- [x] 3.2 `amplify/agent/resource.ts` に `createAgentCoreRuntime()` 関数を作成し、AgentCore Runtime CDK コンストラクト（`@aws-cdk/aws-bedrock-agentcore-alpha`）、Cognito 認証連携、Bedrock 権限を定義する
- [x] 3.3 `amplify/backend.ts` に AgentCore Runtime のリソースを追加する
- [x] 3.4 `deploy-time-build` で ARM64 Docker イメージをビルドする設定を追加する

## 4. AI レビューエージェントの実装

> **実装パターン参照**: design.md §Implementation Patterns「ToolLoopAgent API パターン」
> - `ToolLoopAgent` は `stream({ messages: [...] })` で呼び出す（`stream({ prompt })` ではない）
> - ストリーミングは `fullStream` から `text-delta` をフィルタ（`textStream` ではない）
> - requestSchema は `{ slides }` のみ（`totalSlides` はエージェント側では不要）

- [x] 4.1 `amplify/agent/app.ts` に `BedrockAgentCoreApp` のエントリーポイントを作成する
- [x] 4.2 リクエストスキーマ（解析済みスライドデータを受け取る Zod スキーマ）を定義する
- [x] 4.3 プレゼン資料レビュー用のシステムプロンプト（構成・明確さ・情報量・表現の 4 観点、スライド単位コメント + 全体総評）を作成する
- [x] 4.4 `ToolLoopAgent` と `@ai-sdk/amazon-bedrock` で Claude モデルを使ったレビューエージェントを実装する
- [x] 4.5 ストリーミング応答（`text-delta` イベントの逐次送信）を実装する

## 5. フロントエンド: アップロード UI

- [x] 5.1 `App.tsx` のプレースホルダー部分をドラッグ＆ドロップ対応のアップロードコンポーネントに置き換える
- [x] 5.2 ファイル形式バリデーション（`.pptx` のみ）とファイルサイズバリデーション（10MB 上限）を実装する
- [x] 5.3 ファイル選択後にファイル名・サイズを表示する UI を実装する
- [x] 5.4 アップロード中のローディング状態（Spinner 表示、アップロードエリア非活性化）を実装する

## 6. フロントエンド: 解析 API 呼び出し

- [x] 6.1 Cognito JWT トークンを取得し、`POST /api/pptx/parse` に PPTX ファイルを Base64 で送信する関数を作成する
- [x] 6.2 解析結果（スライド一覧）を画面に表示する UI を実装する（スライド番号、タイトル、本文テキスト、ノート）
- [x] 6.3 解析エラー時の Alert 表示を実装する

## 7. フロントエンド: レビュー表示

- [x] 7.1 AgentCore Runtime エンドポイントへのストリーミングリクエスト関数を作成する（Cognito トークン認証付き）
- [x] 7.2 ストリーミング応答をリアルタイムに表示するレビュー結果コンポーネントを実装する
- [x] 7.3 レビュー完了後にスライド別コメントと全体総評を Card コンポーネントで整形表示する
- [x] 7.4 レビューエラー時の Alert 表示と再試行ボタンを実装する

## 8. Amplify 出力設定と結合テスト

- [x] 8.1 `amplify_outputs` に API Gateway エンドポイント URL と AgentCore Runtime URL を出力する設定を追加する
- [x] 8.2 フロントエンドで出力された URL を読み取り、API 呼び出しに使用するよう接続する
- [ ] 8.3 `npx ampx sandbox` でローカル環境を起動し、PPTX アップロード → 解析 → レビューの一連の流れを動作確認する
