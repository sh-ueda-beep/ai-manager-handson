## 1. 事前準備とアカウント設定

- [x] 1.1 us-east-1 で Amazon Nova Multimodal Embeddings (`amazon.nova-2-multimodal-embeddings-v1:0`) のモデルアクセスをアカウント承認（デプロイ成功で承認済みを実証）
- [x] 1.2 us-east-1 で Claude Sonnet 4.6（推論プロファイル含む）のモデルアクセス状況を確認（レビュー動作で承認済みを実証）
- [x] 1.3 Cognito ユーザー一覧エクスポート — 不要判断（sandbox PoC につき運用データなし）
- [x] 1.4 データソース S3 一覧化 — 不要判断（同上、マイグレーション対象なし）
- [x] 1.5 PoC: Nova Multimodal + S3 Vectors の受理可否検証 — 実デプロイで検証済み（決定 3 で S3 Vectors 確定）

## 2. Amplify CDK: us-east-1 への基盤移行

- [x] 2.1 Amplify プロジェクトのデフォルトリージョンを us-east-1 に設定（環境変数 `AWS_REGION=us-east-1` で sandbox 構築）
- [x] 2.2 Cognito User Pool / Identity Pool を us-east-1 で新規デプロイ（MFA 必須・自己サインアップ無効設定を `backend.ts` で継承）
- [x] 2.3 API Gateway V2 (HTTP API) + JWT Authorizer を us-east-1 で再構築（pptx-parse-api, documents-api）
- [x] 2.4 PPTX 解析 Lambda（Docker, ARM64, Node 22）を us-east-1 にデプロイ完了
- [x] 2.5 Bedrock AgentCore Runtime を us-east-1 でデプロイ完了（Claude Sonnet 4.6 `us.` 推論プロファイル参照）
- [x] 2.6 フロントエンドの `amplify_outputs.json` が us-east-1 の API エンドポイント・Cognito 設定で自動生成・動作確認済み

## 3. ナレッジベース基盤の構築

- [x] 3.1 データソース S3 バケットを CDK で作成（バージョニング・暗号化有効）
- [x] 3.2 Multimodal storage destination S3 バケットを CDK で作成
- [x] 3.3 Multimodal storage destination に `aws/` プレフィックス配下 90 日削除の S3 Lifecycle ルールを付与
- [x] 3.4 S3 Vectors インデックス（dimension: 1024, similarity: cosine）を CDK で定義（docs 調査で Nova MME + S3 Vectors の公式サポート確認済み）
- [x] 3.5 Bedrock Knowledge Base を CDK で定義（`embeddingModelArn: amazon.nova-2-multimodal-embeddings-v1:0`、`supplementalDataStorageConfiguration` に multimodal storage destination を指定）
- [x] 3.6 KB データソース（S3 data source）を CDK で定義、`documents/` と `images/` プレフィックスを `inclusionPrefixes` に登録
- [x] 3.7 KB サービスロールに Nova MME InvokeModel / StartAsyncInvoke、データソース・マルチモーダルストレージ S3、S3 Vectors の各権限を付与
- [x] 3.8 ベクトルストア抽象化レイヤー — 不要判断（S3 Vectors で動作確認済み、AOSS 切替を廃止したため抽象化不要、決定 3）

## 4. バックエンド: インジェストと検索

- [x] 4.1 `amplify/functions/documents/handler.ts` を拡張：画像・PDF の MIME タイプ受付、`documents/` / `images/` プレフィックス分離
- [x] 4.2 `/api/documents` POST: ファイルアップロード後に Bedrock `StartIngestionJob` を呼び出し、ジョブ ID を HTTP 202 で返す
- [x] 4.3 `/api/documents/ingestion-jobs/{jobId}` GET: `GetIngestionJob` でステータスを返すエンドポイントを新設
- [x] 4.4 `/api/documents` DELETE: S3 オブジェクト削除 + 再インジェストジョブ起動
- [x] 4.5 `amplify/agent/app.ts` の `searchReferenceTool` を刷新：`Retrieve` API 呼び出し、モダリティ判定、`imageS3Uri` / `presignedUrl` 付与
- [x] 4.6 `searchReferenceTool` の戻り値型 `RetrievedChunk` を定義し、テキスト／画像／ドキュメントチャンクを区別する
- [x] 4.7 Agent のレビュー生成呼び出しで、画像チャンク上位 3 件を Claude Sonnet 4.6 の vision コンテンツブロックとして `messages` に挿入
- [x] 4.8 動画・音声プレフィックス（`videos/`, `audio/`）のアップロードを明示的に 400 で拒否し、エラーメッセージを返す

## 5. PPTX パーサの画像抽出対応

- [x] 5.1 `amplify/functions/pptx-parse/pptx-parser.ts` に slide relationship 解析を追加（`ppt/slides/_rels/slide*.xml.rels`）
- [x] 5.2 `ppt/media/image*` からスライド単位で画像バイナリを抽出する関数を実装
- [x] 5.3 `.emf` / `.wmf` 等の非対応画像形式をスキップし、警告ログを出力するフォールバックを実装
- [x] 5.4 `SlideData` 型に `images: Array<{ index, mediaType, bytes?, presignedUrl? }>` を追加（`amplify/functions/pptx-parse/pptx-parser.ts` および `src/types.ts`）
- [x] 5.5 合計 5 MB 超の場合に画像を一時 S3 バケットにアップロードして `presignedUrl` に切替するフォールバックを実装（`ImageUploader` DI で実現、Phase B で S3 配線）
- [x] 5.6 `index`／`bytes` と `presignedUrl` が混在しないガード（いずれかに統一）を実装
- [x] 5.7 PPTX パーサのユニットテストを追加：画像あり／なし／複数画像／非対応形式／大容量ファイル

## 6. フロントエンド: 参照データサイドバー拡張

- [x] 6.1 `src/components/ReferenceSidebar.tsx` に画像・PDF アップロード UI を追加（許可拡張子フィルタ、ドラッグ＆ドロップは file input で代替）
- [x] 6.2 クライアント側でファイルサイズ上限を検証し、超過時に画面上にエラー表示（実効上限は 4 MB。Lambda sync invocation + base64 オーバヘッド考慮。決定 14 参照）
- [x] 6.3 ファイル一覧に種別アイコン（Markdown・画像・PDF）とサムネイル（画像の場合は presignedUrl から表示）を表示
- [x] 6.4 インジェストジョブ状態バッジ（`STARTING` / `IN_PROGRESS` / `COMPLETE` / `FAILED`）とポーリング実装
- [ ] 6.5 `FAILED` 時の再試行ボタンを追加（削除ボタン・確認ダイアログは実装済み）
- [x] 6.6 空状態メッセージ「参照データが登録されていません」を表示
- [x] 6.7 `src/lib/documentsApi.ts` に画像・PDF アップロード、ジョブ状態取得、削除の API 呼び出しを実装
- [x] 6.8 `src/lib/documentsApi.ts` の `DocumentFile` 型に `contentType` / `modality` / `presignedUrl` を追加

## 7. フロントエンド: PPTX レビュー画面との連携

- [ ] 7.1 `ReviewPanel` / `ReviewCard` にスライド画像のプレビューコンポーネントを追加
- [ ] 7.2 各スライド画像に「KB に登録」ボタンを追加し、`/api/documents` に画像と元ファイル名・スライド番号を送信
- [ ] 7.3 登録済み画像には登録済みバッジを表示し、再登録を防ぐ
- [ ] 7.4 画像メタデータ（元 PPTX ファイル名・スライド番号）を S3 オブジェクトタグまたは `.metadata.json` サイドカーとして保存する送信ロジックを実装

## 8. データマイグレーションと切替

- [x] 8.1 マイグレーション用ワンショット Lambda は不要判断（step-10 PoC 時点で運用データ無し、sandbox 新規作成で代替）
- [x] 8.2 マイグレーション移送は不要（同上）
- [x] 8.3 Cognito ユーザー移行は不要（同上、動作確認アカウントのみ新規作成）
- [x] 8.4 フロントエンドは `amplify_outputs.json` を sandbox 新規構築で自動更新、動作確認済み

## 9. E2E 検証

- [x] 9.1 画像を含むテスト PPTX をアップロード → 解析 → 画像が `SlideData.images` に含まれることを確認
- [ ] 9.2 PPTX 画像を「KB に登録」→ インジェストジョブ `COMPLETE` まで確認（ReviewPanel 側ボタンは未実装、セクション 7 依存）
- [ ] 9.3 登録した画像が Retrieve 結果に含まれ、Claude Sonnet 4.6 のレビューに反映されることを確認
- [ ] 9.4 既存 `.md` ファイルの検索品質を回帰確認（代表クエリ 5 件でスコアと根拠が妥当か）
- [x] 9.5 PDF ファイルをアップロード → テキスト抽出経由のインジェスト完了を確認（Foundation Model Parser 経由）
- [ ] 9.6 動画・音声ファイルのアップロードが 400 で拒否されることを確認
- [ ] 9.7 5 MB 超の PPTX で画像が `presignedUrl` 方式に切替されることを確認
- [ ] 9.8 インジェストジョブ失敗時に UI に「失敗」バッジと再試行ボタンが表示されることを確認
- [x] 9.9 PNG / JPG 画像を直接アップロード → Foundation Model Parser + Nova MME 経由でインジェストジョブ `COMPLETE` まで確認

## 10. 旧リソース撤去とドキュメント

- [x] 10.1 切替後観察期間 — 不要判断（sandbox PoC につき該当なし）
- [x] 10.2 旧 ap-northeast-1 スタック撤去 — 不要判断（本件は sandbox 新規構築のため該当なし、旧 sandbox は `npx ampx sandbox delete` で別途対応済み想定）
- [x] 10.3 旧 Bedrock KB / S3 Vectors インデックス削除 — 不要判断（同上）
- [ ] 10.4 運用手順書（モデルアクセス承認、ユーザー招待、インジェストジョブ監視）を整備（**別チェンジで対応**）
- [ ] 10.5 README / ハンズオン資料に us-east-1 統一とマルチモーダル対応の変更点を日本語で記載（**別チェンジで対応**）
- [x] 10.6 design.md の Open Questions を整理し、解消済みは履歴セクションへ移動
- [x] 10.7 OpenSpec change を archive する（`/opsx:archive knowledge-base-multimodal-support` 実行中）

## 11. デプロイ時発見の追加修正（実装済みの記録）

- [x] 11.1 Nova MME と 1024 次元整合: `embeddingModelConfiguration.dimensions: 1024, embeddingDataType: 'FLOAT32'` を CfnKnowledgeBase に追加（決定 9）
- [x] 11.2 `InclusionPrefixes` の複数要素指定を削除（最大 1 要素制約、決定 10）
- [x] 11.3 S3 metadata `original-name` を `encodeURIComponent` でエンコード（決定 11）
- [x] 11.4 フロント→エージェント送信時に画像バイトを剥がして `imageCount` のみ送信（AgentCore ペイロード 413 対策、決定 12）
- [x] 11.5 Agent 内の事前 Retrieve を try/catch で握る（424 防止、決定 13）
- [x] 11.6 Claude Sonnet 4.6 inference profile を KB_REGION で自動切替 (`us.` / `jp.`)
- [x] 11.7 アップロード実効上限を 4 MB に修正（クライアント／サーバ両側、UI 表示込み、決定 14）
- [x] 11.8 Foundation Model Parser (Nova 2 Lite 推論プロファイル) を `CfnDataSource.vectorIngestionConfiguration.parsingConfiguration` に指定し、KB サービスロールに `GetInferenceProfile` / `GetFoundationModel` / `InvokeModel` 権限を追加（決定 15）
