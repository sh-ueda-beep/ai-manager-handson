## ADDED Requirements

### Requirement: マルチモーダル埋め込みモデルの利用
システムはナレッジベースの埋め込みモデルとして Amazon Nova Multimodal Embeddings（`amazon.nova-2-multimodal-embeddings-v1:0`）を使用しなければならない（MUST）。テキスト・画像・ドキュメントを同一の埋め込み空間に変換することで、テキストクエリから画像を検索する等のクロスモーダル検索を可能にする。

#### Scenario: テキストファイルのインジェスト
- **WHEN** `.md` ファイルがデータソース S3 バケットにアップロードされる
- **THEN** システムは Nova Multimodal Embeddings でテキストを埋め込みベクトルへ変換し、ベクトルインデックスへ格納する

#### Scenario: 画像ファイルのインジェスト
- **WHEN** `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` 画像がデータソース S3 にアップロードされる
- **THEN** システムは Nova Multimodal Embeddings で画像を直接ベクトル化し、同じインデックスへ格納する

#### Scenario: クロスモーダル検索
- **WHEN** Agent がテキストクエリ（例: 「デザインシステムの構成図」）で Retrieve を実行する
- **THEN** システムはテキストチャンクと画像チャンクの両方を類似度スコア順に返す

### Requirement: リージョン統一
ナレッジベースおよび関連リソース（埋め込みモデル呼び出し、ベクトルストア、multimodal storage destination、データソース S3、Agent Runtime、Lambda、API Gateway、Cognito）はすべて **us-east-1** に配置しなければならない（MUST）。Nova Multimodal Embeddings の提供リージョン制約と整合させ、クロスリージョン構成による複雑化を避ける。

#### Scenario: 全リソースの us-east-1 配置
- **WHEN** Amplify CDK スタックがデプロイされる
- **THEN** すべての AWS リソースが us-east-1 に作成される

#### Scenario: 他リージョンへのデプロイ抑止
- **WHEN** CDK が us-east-1 以外のリージョンをターゲットにデプロイされようとする
- **THEN** デプロイは失敗するか、警告を出力し、ユーザに明示的な確認を求める

### Requirement: ベクトルストアの構成
システムはベクトルストアとして S3 Vectors を使用し、埋め込み次元 1024、データ型 float32、距離メトリック cosine でインデックスを作成しなければならない（MUST）。`amazon.nova-2-multimodal-embeddings-v1:0` + S3 Vectors の組み合わせは Bedrock Knowledge Base の managed 統合で動作することをデプロイで実証済み。

#### Scenario: S3 Vectors インデックスの作成
- **WHEN** Knowledge Base が初期化される
- **THEN** S3 Vector バケットとインデックス（dimension: 1024, dataType: float32, distanceMetric: cosine）が作成される

#### Scenario: 埋め込み次元の明示指定
- **WHEN** `CfnKnowledgeBase` が作成される
- **THEN** `vectorKnowledgeBaseConfiguration.embeddingModelConfiguration.bedrockEmbeddingModelConfiguration` に `{ dimensions: 1024, embeddingDataType: 'FLOAT32' }` が指定される

#### Scenario: 次元不一致の検出
- **WHEN** `embeddingModelConfiguration.dimensions` が省略された状態で KB 作成が試みられる
- **THEN** Nova MME の既定出力次元（3072）と S3 Vectors インデックス（1024）が不一致となり、CREATE_FAILED でスタックロールバックする

### Requirement: Foundation Model Parser によるマルチモーダル対応
システムはデータソースのパース戦略として `BEDROCK_FOUNDATION_MODEL` を指定し、パーサーモデルに Amazon Nova 2 Lite 推論プロファイル（`us.amazon.nova-2-lite-v1:0`）を使用しなければならない（MUST）。Bedrock default parser は画像ファイルを扱えないため、指定を省略してはならない（MUST NOT）。

#### Scenario: データソースのパース戦略指定
- **WHEN** `CfnDataSource` が作成される
- **THEN** `vectorIngestionConfiguration.parsingConfiguration` に `parsingStrategy: 'BEDROCK_FOUNDATION_MODEL'` と Nova 2 Lite 推論プロファイル ARN が指定される

#### Scenario: 画像ファイルの正常インジェスト
- **WHEN** PNG / JPG / JPEG / GIF / WEBP 画像がデータソースにアップロードされインジェストが実行される
- **THEN** インジェストジョブは `COMPLETE` で終了し、S3 Vectors に画像ベクトルが格納される

#### Scenario: KB ロールのパーサー権限
- **WHEN** Knowledge Base サービスロールが作成される
- **THEN** パーサー用推論プロファイルおよび背後の foundation-model に対し `bedrock:InvokeModel`, `bedrock:GetInferenceProfile`, `bedrock:GetFoundationModel` の権限が付与される

#### Scenario: BDA 選択の禁止
- **WHEN** 開発者がパース戦略に BDA を採用しようとする
- **THEN** 設計上禁止する。理由は BDA + Nova MME の組み合わせが Nova の native 画像埋め込みを失わせ、テキスト埋め込みに降格するため

### Requirement: Multimodal storage destination の配置
Nova Multimodal Embeddings を使用する Knowledge Base では、データソースとは別の専用 S3 バケットを multimodal storage destination として構成しなければならない（MUST）。`aws/` プレフィックス配下の transient data は S3 Lifecycle ルールにより 90 日で削除されなければならない（MUST）。

#### Scenario: 専用バケットの作成
- **WHEN** Knowledge Base が初期化される
- **THEN** `ai-manager-kb-multimodal-${accountId}` S3 バケットが作成され、KB リソースに紐付けられる

#### Scenario: transient data のライフサイクル削除
- **WHEN** multimodal storage destination の `aws/` プレフィックスに 90 日以上経過したオブジェクトが存在する
- **THEN** S3 Lifecycle ルールにより該当オブジェクトが自動削除される

### Requirement: インジェスト対応ファイル形式
初期スコープとして、システムは以下のファイル形式をインジェストできなければならない（MUST）: `.md`、`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.pdf`。動画 (`videos/`) と音声 (`audio/`) プレフィックスは予約されるが、本チェンジの初期実装ではインジェスト対象外としなければならない（MUST）。

#### Scenario: 許可拡張子のインジェスト
- **WHEN** 許可拡張子のファイルがアップロードされる
- **THEN** システムはインジェストジョブ対象として処理する

#### Scenario: 動画・音声の取り込み拒否
- **WHEN** `.mp4` / `.mp3` 等の動画・音声ファイルがアップロードされる
- **THEN** システムはインジェスト対象外とし、フロントエンドに「本バージョン未対応」を示すレスポンスを返す

#### Scenario: PDF のテキスト処理明示
- **WHEN** `.pdf` ファイルがインジェストされる
- **THEN** システムは Nova Multimodal の Document モダリティに従い、PDF 内容をテキスト抽出してベクトル化する（画像としての native 埋め込みは行わない）

### Requirement: インジェストジョブの起動と進捗監視
ファイルアップロード後、システムは Bedrock Knowledge Base の `StartIngestionJob` を起動し、ジョブ ID をクライアントに返却しなければならない（MUST）。クライアントはジョブ ID を用いて `GetIngestionJob` でステータス（`STARTING` / `IN_PROGRESS` / `COMPLETE` / `FAILED`）を取得できなければならない（MUST）。

#### Scenario: インジェストジョブの開始
- **WHEN** 参照ファイルがアップロードされる
- **THEN** `StartIngestionJob` が呼び出され、ジョブ ID が HTTP 202 でクライアントに返される

#### Scenario: ジョブ進捗のポーリング
- **WHEN** クライアントが `/api/documents/ingestion-jobs/{jobId}` に GET する
- **THEN** システムは現在のステータスと、失敗時のエラーメッセージを返す

#### Scenario: インジェストジョブの失敗
- **WHEN** Bedrock 側でジョブが失敗する
- **THEN** システムはステータスを `FAILED` として返し、CloudWatch ログにエラー詳細を記録する

### Requirement: マルチモーダル Retrieve 結果の構造化
Agent ランタイムの `searchReferenceTool` は Bedrock `Retrieve` API を呼び出し、各チャンクに対しモダリティ種別 (`text`/`image`/`document`)、元ファイル S3 URI、multimodal storage 内 URI（画像の場合）、人間可読なファイル名、類似度スコア、プリサイン URL（5 分有効）を含む構造で返さなければならない（MUST）。

#### Scenario: テキストチャンクの取得
- **WHEN** テキストクエリでテキストファイル由来のチャンクが取得される
- **THEN** 戻り値の `modality` は `text`、`text` フィールドに抜粋が、`sourceS3Uri` に原本 URI が設定される

#### Scenario: 画像チャンクの取得
- **WHEN** テキストクエリで画像ファイル由来のチャンクが取得される
- **THEN** 戻り値の `modality` は `image`、`imageS3Uri` に multimodal storage 内 URI、`presignedUrl` に 5 分有効なプリサイン URL が設定される

#### Scenario: 空のクエリ結果
- **WHEN** クエリに合致するチャンクがない
- **THEN** システムは空配列を返し、エラーにはしない

### Requirement: 画像チャンクの生成プロンプトへの展開
Agent は Retrieve で取得した画像チャンクを、Claude Sonnet 4.6 への生成呼び出し時に vision コンテンツブロック（`{ type: 'image', source: { type: 'base64', media_type, data } }`）として `messages` に挿入しなければならない（MUST）。1 リクエストあたりの画像チャンクは上位 3 件までに制限しなければならない（MUST）。

#### Scenario: 画像を含む根拠提示
- **WHEN** Retrieve の結果に画像チャンクが含まれる
- **THEN** Agent は画像を base64 で Claude のリクエストに添付し、レビュー生成に利用させる

#### Scenario: 画像枚数の上限
- **WHEN** Retrieve の結果に画像チャンクが 5 件含まれる
- **THEN** Agent はスコア降順の上位 3 件のみを Claude に渡し、残りは破棄する

### Requirement: Knowledge Base アクセス権限
Knowledge Base サービスロールには、Nova Multimodal Embeddings の `InvokeModel` / `StartAsyncInvoke` 権限、データソース S3 および multimodal storage destination S3 への `GetObject` / `PutObject` / `ListBucket` 権限、ベクトルストア（AOSS）への API 権限を付与しなければならない（MUST）。Agent / Lambda 実行ロールには `bedrock-agent-runtime:Retrieve` および multimodal storage destination S3 の `GetObject` 権限を付与しなければならない（MUST）。

#### Scenario: KB サービスロールの権限付与
- **WHEN** Knowledge Base が作成される
- **THEN** サービスロールに埋め込みモデル呼び出し権限・S3 アクセス権限・ベクトルストア API 権限が付与される

#### Scenario: Agent からの Retrieve 呼び出し
- **WHEN** Agent Runtime が `bedrock-agent-runtime:Retrieve` を呼び出す
- **THEN** 付与された IAM 権限により正常に実行される
