## Why

step-10 で導入したナレッジベースは Titan Embed Text v2 によるテキスト専用で、`.md` ファイルしか取り込めない。しかし AI Manager の本質的な対象である PPTX プレゼンテーションは、スライドの図版・スクリーンショット・図表・動画デモ・ナレーション音声など視覚／聴覚情報を多く含み、これらを参照できないとレビューの根拠としてのナレッジベースが片手落ちになる。

2025-10-28 に一般提供された **Amazon Nova Multimodal Embeddings**（`amazon.nova-2-multimodal-embeddings-v1:0`）は、テキスト・ドキュメント・画像・動画・音声を単一モデルで統一セマンティック空間に埋め込めるため、AI Manager の参照データを本格的なマルチモーダル RAG へ拡張する好機となる。

## What Changes

- ナレッジベースの埋め込みモデルを Titan Embed Text v2 から **Amazon Nova Multimodal Embeddings**（`amazon.nova-2-multimodal-embeddings-v1:0`）へ移行
- 本モデルは現状 **us-east-1 限定** のため、バックエンド埋め込み呼び出しのみ us-east-1 の Bedrock Runtime を使うクロスリージョン構成を導入（ap-northeast-1 の Amplify スタックから呼び出し）
- 埋め込み出力次元は MRL 対応のうち **1024 次元** を採用し、既存 S3 Vectors インデックス（1024 float32, cosine）を再利用可能な範囲で維持（既存データは再インデックス必須、**BREAKING**）
- Bedrock Knowledge Base managed インジェスト（`CfnKnowledgeBase` + `CfnDataSource`）が Nova Multimodal Embeddings に未対応の場合に備え、**S3 Vectors API を直接利用する DIY インジェストパイプライン** を代替案として選択可能な設計にする（最終選定は design フェーズで決定）
- ナレッジベース取り込み対象として `.md` に加え、`.png` / `.jpg` / `.jpeg`（画像）、`.pdf`（ドキュメント）、`.mp4`（動画・非同期 API、最大 30 秒セグメント）、`.mp3` / `.wav`（音声、同上）を許可（本チェンジの初期スコープは **画像 + PDF** に限定し、動画・音声は将来拡張としてインターフェースのみ用意）
- フロントエンドの参照データサイドバー（`ReferenceSidebar`）で画像・PDF のアップロード・サムネイル表示・削除をサポート
- Agent ランタイムの `searchReferenceTool` を拡張し、Retrieve 時は `embeddingPurpose: GENERIC_RETRIEVAL` を使用、レスポンスにチャンクのモダリティ種別・画像 S3 URI・プリサイン URL・距離スコアを含めて返す
- PPTX パーサ（`pptx-parser.ts`）にスライド画像抽出機能を追加し、`ppt/media/image*` を S3 アップロード用バイナリとして返す（**BREAKING**: `SlideData` 型に `images: Array<{ index, mediaType, bytes }>` フィールドを追加）
- Claude Sonnet 4.6 の vision 能力を使い、Retrieve した画像チャンクを生成プロンプトに添付してレビューを生成

## Capabilities

### New Capabilities

- `knowledge-base-multimodal`: Amazon Nova Multimodal Embeddings を用いた画像・テキスト・PDF 混在コンテンツのインジェスト、クロスモーダル検索、画像を含むコンテキストの取得と生成プロンプトへの添付機能
- `reference-data-management`: フロントエンド参照データサイドバーによるデータソースファイル（テキスト / 画像 / PDF）のアップロード・一覧・サムネイルプレビュー・削除・インジェスト状態の可視化

### Modified Capabilities

- `pptx-parse`: スライドから埋め込み画像（`ppt/media/image*`）を抽出し、レスポンスに画像バイナリを含めるように拡張

## Impact

- **Amplify バックエンド**
  - `amplify/knowledge-base/resource.ts`: 埋め込みモデル ARN を `amazon.nova-2-multimodal-embeddings-v1:0` （us-east-1 ARN）に変更、ベクタ次元 1024 を維持、S3 Vectors インデックスの再作成、managed KB 継続 or DIY パイプライン切り替えの分岐
  - `amplify/functions/documents/handler.ts`: 画像・PDF MIME タイプの受付、プレフィックス分離（`images/`, `documents/`）、インジェスト対象拡張、DIY の場合は Bedrock Runtime `InvokeModel` + S3 Vectors `PutVectors` の実装
  - `amplify/agent/app.ts`: `searchReferenceTool` の応答型にモダリティ情報追加、画像チャンクを Claude Sonnet 4.6 の vision コンテンツブロックとして添付、`embeddingPurpose` を `GENERIC_RETRIEVAL` に切替
  - `amplify/functions/pptx-parse/pptx-parser.ts`: 画像抽出ロジック追加、`SlideData` 型拡張
  - 新規：us-east-1 の Bedrock Runtime クライアント初期化ユーティリティ（`amplify/agent/` 配下）
- **フロントエンド**
  - `src/components/ReferenceSidebar.tsx`: 画像・PDF アップロード UI、サムネイル表示、ファイル種別フィルタ
  - `src/components/documentsApi.ts`（または相当箇所）: 画像・PDF アップロード API 呼び出し、許可拡張子・サイズ上限の拡大
  - `src/types.ts`: 参照データ型に `contentType` / `thumbnailUrl` / `modality` を追加
- **IAM / AWS リソース**
  - Knowledge Base / Lambda ロールに us-east-1 の `amazon.nova-2-multimodal-embeddings-v1:0` への `InvokeModel` および `StartAsyncInvoke` 権限を追加
  - データソース S3 バケットに `images/` `documents/` `videos/` `audio/` プレフィックスを追加、Bedrock サービスプリンシパルまたは DIY インジェスト用 Lambda 実行ロールからの `GetObject` を許可
  - us-east-1 での Nova Multimodal Embeddings モデルアクセスをアカウントレベルで有効化する運用タスク
- **既存データ**
  - 既存の Titan Embed Text v2 で作成した S3 Vectors インデックスは、埋め込みモデル変更に伴い再インデックス必須（**BREAKING**）。既存の `.md` アップロード済みファイルは保持し、マイグレーションスクリプトで一括再インジェストする方針
- **依存関係**
  - 新規 npm 依存：特に不要（`@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-s3-vectors` は既存想定、不足時のみ追加）
  - AWS SDK v3：Nova Multimodal Embeddings に対応するバージョンへの更新確認
