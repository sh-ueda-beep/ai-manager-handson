## Context

AI Manager は AWS Amplify Gen2 スタックで稼働し、step-10 で RAG 機能（Bedrock Knowledge Bases + S3 Vectors + Titan Embed Text v2）が導入された。現行 RAG はテキスト（`.md`）のみを対象にしており、PPTX に含まれる画像・図表・画面キャプチャや、組織に存在する PDF 資料などを参照できない。

**Amazon Nova Multimodal Embeddings**（`amazon.nova-2-multimodal-embeddings-v1:0`, 2025-10-28 GA）は、テキスト・画像・ドキュメント・動画・音声を単一埋め込み空間で扱える最初の統一マルチモーダル埋め込みモデルで、**Bedrock Knowledge Bases の managed 埋め込みモデルとして公式サポート** されている。ただし提供リージョンは現時点で **us-east-1 のみ**。

既存スタックは ap-northeast-1 (Tokyo) に構築されているが、Tokyo 固定へのこだわりはなく、本チェンジを機に **スタック全体を us-east-1 (N. Virginia) に統一移行** する方針でシンプル化を図る。これによりクロスリージョン構成・余分な IAM・余計なレイテンシ・データ転送コストを回避できる。

調査で確定した主要な制約（us-east-1 に統一した場合にも残るもの）：
- Nova Multimodal を使う KB では **multimodal storage destination（専用 S3 バケット）が必須**。一時抽出メディアが格納されるため S3 ライフサイクルでのクリーンアップが推奨される。
- Nova Multimodal は画像・動画・音声への native 埋め込みは可能だが、**`RetrieveAndGenerate` と rerank はテキストコンテンツに限定**。画像チャンクは `Retrieve` で取得し、生成側（Claude Sonnet 4.6）に自前で渡す必要がある。
- Nova Multimodal は **音声／動画中の発話内容を効果的に扱えない**。発話文字起こしが必要なら Bedrock Data Automation (BDA) パーサーを使う（BDA は us-east-1 対応）。
- 対応ファイル形式: 画像 `.png/.jpg/.jpeg/.gif/.webp`、音声 `.mp3/.ogg/.wav`、動画 `.mp4/.mov/.mkv/.webm/.flv/.mpeg/.mpg/.wmv/.3gp`、ドキュメント（PDF 等）は **「テキストとして処理」**（画像としての native 埋め込みではない）。
- Bedrock KB の公式 CreateKnowledgeBase サンプル（Nova MME 版）では OpenSearch Serverless を使用しており、**S3 Vectors + Nova Multimodal の組み合わせが managed KB で公式サポートされているかは要検証**。
- S3 Vectors 側の制約：メタデータ上限 1 KB／ベクトル、キー 35 個、floating-point のみ、ハイブリッド検索非対応。

主要ステークホルダー：
- エンドユーザー（PPTX レビュー利用者）：図表・画像を含む根拠提示を期待
- 運用管理者（Cognito 管理者）：参照データのアップロード・削除を行う
- バックエンド保守者：リージョン移行、マイグレーション、コスト影響を理解する必要

## Goals / Non-Goals

**Goals:**
- Nova Multimodal Embeddings を使って画像・PDF（テキスト処理）・Markdown を単一の Bedrock Knowledge Base に取り込み、テキスト／画像クエリ双方で検索できる
- PPTX パーサから抽出したスライド画像を参照データとして KB にインジェストできる
- Retrieve 結果には画像チャンクの原本 S3 URI と、フロントエンド表示用のプリサイン URL が含まれ、Claude Sonnet 4.6 の vision 入力に使える
- 既存の `.md` データソースを新しい KB で再インジェストする運用手順が明確になる
- Amplify Gen2 + CDK で managed Bedrock KB（Nova Multimodal + multimodal storage destination）を宣言的に定義できる
- スタック一式の us-east-1 移行手順（Cognito / API Gateway / Agent Runtime / Lambda / S3 / CloudFront）が文書化される

**Non-Goals:**
- 音声・動画中の**発話内容の検索**（BDA パーサーが必要だが、本チェンジでは画像＋PDF にフォーカスし、別チェンジで扱う）
- 動画・音声ファイルの取り込み実装（I/F とプレフィックスのみ用意）
- リアルタイム（ユーザー操作中）の同期的インジェストパイプライン（Bedrock 標準のインジェストジョブに任せる）
- 参照データのマルチリージョン DR／地域間レプリケーション
- 既存 `.md` インデックスのゼロダウンタイム移行（ダウンタイム許容、手動再インジェストを許可）
- 既存 Cognito ユーザーの維持（新リージョンで再作成。自己サインアップは無効・管理者招待のため影響は小さい）
- PPTX 以外のオフィス文書（DOCX, XLSX）からの画像抽出
- 画像のオフライン説明文生成（Claude での image-to-text）経由でのテキスト埋め込みへのフォールバック

## Decisions

### 決定 1: 埋め込みモデルは Amazon Nova Multimodal Embeddings を採用

**決定内容:** `amazon.nova-2-multimodal-embeddings-v1:0` を Bedrock Knowledge Base の `embeddingModelArn` に指定し、テキストも画像も PDF も同モデルで埋め込み、同一 KB で検索する。

**理由:**
- テキストクエリからの画像検索／画像クエリからのテキスト・画像検索（cross-modal）が自然に実現できる
- モダリティごとに KB を分けると Retrieve 側の結果マージが複雑化する
- Bedrock KB managed でサポートされており、インジェストのリトライ・差分検出・S3 同期が標準機能で使える

**検討した代替案:**
- **Titan Multimodal Embeddings G1**: ドキュメント・動画・音声未対応、将来拡張性で Nova に劣るため却下
- **Cohere Embed Multilingual v3 (multimodal)**: 画像対応だが、Bedrock KB + Nova の公式サポートパスのほうがシンプル
- **Titan Embed Text v2 + Claude で画像説明生成 → テキスト埋め込み**: 画像ベクトル類似度が取れず精度が落ち、説明生成コスト・レイテンシが大きい

### 決定 2: スタック全体を **us-east-1 (N. Virginia)** に統一移行

**決定内容:** Amplify スタック全体（Cognito / API Gateway / Lambda / Agent Runtime / データソース S3 / ベクトルストア / Bedrock Knowledge Base / フロントエンド配信）を us-east-1 に再構築する。既存 ap-northeast-1 スタックは本チェンジ完了後に撤去する。

**理由:**
- Nova Multimodal の埋め込みモデルが us-east-1 限定で、KB／ベクトルストア／multimodal storage destination は同一リージョンである必要がある
- クロスリージョン構成は IAM・レイテンシ・データ転送コスト・障害ドメインの複雑化を招く。単一リージョンのほうが圧倒的にシンプル
- ユーザーに Tokyo 固定の要件はなく、step-10 までの既定値にすぎない
- 既存データは学習用ハンズオン段階（step-10 までの PoC）で実運用データの蓄積は最小限、リージョン移行コストが許容範囲内
- Claude Sonnet 4.6 / 4.5、Bedrock Data Automation (BDA) など、将来必要になる Bedrock サービスの提供状況も us-east-1 が最も豊富

**検討した代替案:**
- **スタック本体 ap-northeast-1 + KB のみ us-east-1**: クロスリージョン構成が複雑、IAM が 2 リージョンに跨る、Retrieve レイテンシ +100〜150ms
- **us-west-2 (Oregon) に統一**: Bedrock サービス提供は豊富だが、Nova Multimodal は未提供（本チェンジで使えない）ため却下
- **ap-northeast-1 提供開始を待つ**: リリース時期未定、意思決定を遅延させるリスク

**Trade-off:** 日本からアクセスする場合のエンドユーザー RTT は +100〜150ms 程度増える。PPTX レビュー全体の応答時間（5〜30 秒）に対しては相対的に影響小。

### 決定 3: ベクトルストアは **S3 Vectors** で確定（Nova MME との managed KB 統合を動作確認済み）

**決定内容:** ベクトルストアに **S3 Vectors** を採用。`amazon.nova-2-multimodal-embeddings-v1:0` + S3 Vectors の組み合わせが Bedrock Knowledge Bases の managed パス（`CfnKnowledgeBase` の `storageConfiguration: { type: 'S3_VECTORS' }`）で動作することをデプロイで実証済み。

**理由:**
- 2026-04 時点でデプロイ検証済み：Bedrock KB managed インジェスト・`Retrieve` API ともに動作
- S3 Vectors は OCU 最低課金が無く、アイドル時コストがゼロに近い
- step-10 以来の既存設定（1024 次元 / cosine / float32）と整合

**検討した代替案:**
- **OpenSearch Serverless (AOSS)**: Nova MME 公式サンプルは AOSS だが、動作確認で S3 Vectors でも問題ないことが判明したため却下（OCU 最低課金が不要）
- **Pinecone / Weaviate / Mongo Atlas**: 外部 SaaS 契約が必要、AWS 内完結の方針から逸脱

**Trade-off:** S3 Vectors はメタデータ上限 1 KB/ベクトル、最大 10 non-filterable キー、ハイブリッド検索非対応といった制約がある。本件の規模では問題にならない想定。

### 決定 4: Multimodal storage destination は専用 S3 バケット、90 日ライフサイクルで透過クリーンアップ

**決定内容:**
- データソースバケット（原本）：`ai-manager-kb-source-${accountId}`
- Multimodal storage destination バケット：`ai-manager-kb-multimodal-${accountId}`
- 2 つのバケットを分離（ドキュメント推奨）
- multimodal storage バケットの `aws/` 配下（Bedrock が transient data を置く既知パス）に S3 Lifecycle ルールを設定し、90 日後に削除

**理由:**
- 同一バケット利用時は `aws/` を避ける inclusion prefix が必要で運用ミスに弱い
- 分離すれば権限・ロギング・ライフサイクルが素直
- Bedrock のクリーンアップは保証されないため、ライフサイクルで確実に清掃

**検討した代替案:**
- **同一バケット共用**: 再インジェスト事故のリスク、却下

### 決定 5: 初期スコープは Markdown + 画像 + PDF（テキスト処理）、動画・音声は I/F のみ用意

**決定内容:**
- 初期スコープ：`.md`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.pdf`
- 動画 / 音声：S3 プレフィックス（`videos/`, `audio/`）を確保、アップロード UI は非表示、Retrieve 対象から除外
- PDF は Nova Multimodal の「Documents: Processed as text」仕様に従い、**テキスト抽出経由で扱われる**（画像として native 埋め込みされるわけではない）ことを明示
- PDF 中の図表をビジュアル検索したい場合は、スクリーンショット画像として別途アップロードする運用ガイドを提示

**理由:**
- 本チェンジの主目的は PPTX 画像・組織資料（PDF）をレビューで参照できるようにすること
- 動画・音声は Nova の発話処理制限と、将来の BDA 導入タイミングで別チェンジに分離

**検討した代替案:**
- **PDF を Foundation Model Parser で画像として処理**: Claude Vision パーサで解析可能だがコスト増と遅延増、スコープ外

### 決定 6: PPTX パーサは画像抽出を常時実行、`SlideData.images` を拡張（BREAKING）

**決定内容:** `pptx-parser.ts` は `/api/pptx/parse` 呼び出し時に常に画像を抽出し、`SlideData.images: Array<{ index: number, mediaType: string, bytes: string }>` （bytes は base64）を返す。フロントエンドは画像を即レビューに使うだけなら破棄し、KB に保存する場合のみ `/api/documents` に再投稿する。

**理由:**
- `/api/pptx/parse` は認証済みユーザーの同期 API（2〜5 秒）で、画像追加で 1〜2 秒程度増える想定（Lambda レスポンス 6 MB 上限内）
- 抽出をオプショナル化するとクライアント側のフラグ管理が複雑化
- 将来、PPTX 全体を Claude Sonnet 4.6 の vision に直接流して「スライドを見ながらレビュー」する機能と自然に接続できる

**Mitigation（レスポンスサイズ対策）:** 合計画像サイズが 5 MB を超える場合、画像部分を一時 S3 にアップロードしてプリサイン URL を返すフォールバックを実装。

### 決定 7: `searchReferenceTool` は `Retrieve` API を使用し、画像チャンクは Agent 側で Claude Sonnet 4.6 の vision 入力に展開

**決定内容:** Agent ランタイムの `searchReferenceTool` は `bedrock-agent-runtime:Retrieve` を呼び出す。レスポンス型を以下に拡張：

```ts
type RetrievedChunk = {
  index: number;
  modality: 'text' | 'image' | 'document' | 'video' | 'audio';
  text?: string;            // text / document チャンク時
  imageS3Uri?: string;      // image / video / audio の multimodal storage 内 URI
  sourceS3Uri: string;      // 元ファイルの原本 S3 URI
  sourceLabel: string;      // 人間可読なファイル名
  mediaType?: string;       // "image/png", "application/pdf" 等
  score: number;
  presignedUrl?: string;    // フロントエンド表示用、5 分有効
};
```

画像チャンクは生成呼び出し時に Claude Sonnet 4.6 の `messages` 配列内で vision コンテンツブロック（`{ type: 'image', source: { type: 'base64', ... } }`）として挿入する。

**理由:**
- Nova Multimodal は `RetrieveAndGenerate` がテキスト限定のため、`Retrieve` + 自前生成呼び出しが唯一の選択肢
- モダリティ明示でフロント・生成プロンプト双方のロジックが単純化
- multimodal storage destination の URI を直接返せるため追加メタデータ管理が不要

### 決定 8: 埋め込み次元は 1024、S3 Vectors インデックスもこれに合わせる

**決定内容:** `embeddingDimension: 1024`（Matryoshka Representation Learning）。S3 Vectors のインデックスは `dimension: 1024, dataType: "float32", distanceMetric: "cosine"` で構築。

**理由:**
- S3 Vectors の既存設定（1024）と整合
- 3072 はストレージ・クエリコスト 3 倍、256/384 は精度が落ちる。1024 が運用規模で最適

### 決定 9: `embeddingModelConfiguration.dimensions` を明示指定（デプロイ時発覚の必須事項）

**決定内容:** `CfnKnowledgeBase.vectorKnowledgeBaseConfiguration.embeddingModelConfiguration.bedrockEmbeddingModelConfiguration` に `{ dimensions: 1024, embeddingDataType: 'FLOAT32' }` を必ず指定する。

**理由:**
- Nova Multimodal Embeddings の既定出力次元は 3072 と推定される。省略すると KB 作成時のヘルスチェックで 1024 次元の S3 Vectors インデックスへ 3072 次元の query vector を投げ、`S3Vectors: Query vector contains invalid values or is invalid for this index` で `CREATE_FAILED` になる
- `BedrockEmbeddingModelConfiguration` は CloudFormation で `Dimensions` (0–4096) と `EmbeddingDataType` (FLOAT32 | BINARY) をサポート

**検討した代替案:**
- **S3 Vectors インデックス側を 3072 に合わせる**: ストレージ・クエリコスト 3 倍、却下

### 決定 10: データソースバケットは `InclusionPrefixes` を指定せずバケット全体を対象

**決定内容:** `CfnDataSource.dataSourceConfiguration.s3Configuration` で `inclusionPrefixes` は指定しない。`dataSourceBucket` は本 KB 専用で、アプリ側（`documents/` / `images/` プレフィックス分離アップロード）以外のオブジェクトは入らない前提。

**理由:**
- AWS 仕様で `InclusionPrefixes` は **最大 1 要素**。`['documents/', 'images/']` のような複数プレフィックス指定はプロパティ検証で `ROLLBACK_COMPLETE` になる
- 専用バケットなので inclusion で絞る必然性がない
- 将来、プレフィックス毎に分離ingestion したくなった場合は複数の `CfnDataSource` を定義（`['documents/']` / `['images/']` 別々）することで対応可能

### 決定 11: S3 メタデータに非 ASCII 文字を入れる際は `encodeURIComponent` する

**決定内容:** `documents` Lambda で S3 へ `PutObject` する際、`Metadata.original-name` は `encodeURIComponent(fileName)` でエンコードする。取り出し時は `decodeURIComponent` で戻す。

**理由:**
- S3 メタデータヘッダ (`x-amz-meta-*`) は HTTP ヘッダ扱いで US-ASCII のみ許可
- 日本語ファイル名で `Invalid character in header content` エラー発生を実測確認
- URL エンコードは S3 / AWS エコシステムで標準的な解決策

### 決定 12: フロントエンド→エージェントの送信ペイロードから画像バイトを剥がす

**決定内容:** App.tsx の `handleReview` で、`parseResult.slides` を `{ slideNumber, title, body, notes, imageCount }` に変換してから AgentCore Runtime に POST する。画像バイトは送らない。エージェント側スキーマ (`slideSchema`) も `imageCount: number` のみ受け取る。

**理由:**
- AgentCore Runtime の `invocations` にペイロード上限があり、画像付き PPTX を丸ごと送ると 413 Payload Too Large
- レビュー生成で画像が必要な場合は、エージェント内で KB の Retrieve 結果から取得して Claude Sonnet 4.6 の vision に展開する設計のため、エージェント入力として画像バイトは不要

### 決定 13: エージェント内の事前 Retrieve を try/catch で握って継続

**決定内容:** `app.ts` の `process` で、ユーザメッセージ組み立て前の事前 `retrieveReferences()` と `buildVisionAttachments()` は try/catch で失敗をログのみとし、空配列で続行する。

**理由:**
- KB が空／IAM の過渡状態／S3 取得失敗などでエージェント全体が 424 Failed Dependency で終わるのを避け、「参照データなしでも通常レビューは返す」という縮退動作にする
- `searchReferenceTool` 側は元々 try/catch 済みで、同じ方針を事前取得にも適用

### 決定 14: アップロード実効上限は 4 MB（同期 Lambda パスの現実的な制約）

**決定内容:** `/api/documents/upload` の実効上限を生ファイルで **4 MB** とし、クライアント側 (`src/lib/documentsApi.ts`) とサーバ側 (`amplify/functions/documents/handler.ts`) の両方で多層防御する。サーバ側は base64 デコード後のバッファ長で判定し、超過時は HTTP 413 を返す。

**理由:**
- API Gateway (HTTP API) + Lambda の同期呼び出しはリクエスト/レスポンス各 **6 MB** が上限
- クライアントは base64 + JSON ラッパで送信するため +33% 以上のオーバーヘッド発生
- 保守的に 4 MB に設定することで、Lambda invocation 上限に接触する前に明示エラーを返す
- UI（`ReferenceSidebar`）にも「最大 4 MB / ファイル」を表示してユーザーに明示

**検討した代替案:**
- **5 MB ギリギリまで許可**: 微妙な差で 6 MB 上限に接触し 500 系が出る可能性、却下
- **presigned URL 直接アップロード**: S3 単一 PUT の 5 GB まで拡張可能だが、EventBridge → Lambda の追加配線が必要で本チェンジのスコープ外。別チェンジで扱う

**Trade-off:** 4 MB を超える画像／PDF を取り込みたい場合は別途 presigned URL 方式の導入が必要。現状の参照データ（主にスライド画像・組織 MD ドキュメント）では 4 MB で十分。

### 決定 15: データソースのパース戦略は **Foundation Model Parser + Nova 2 Lite（推論プロファイル）**

**決定内容:** `CfnDataSource.vectorIngestionConfiguration.parsingConfiguration` に以下を指定：

```ts
parsingStrategy: 'BEDROCK_FOUNDATION_MODEL',
bedrockFoundationModelConfiguration: {
  modelArn: `arn:aws:bedrock:us-east-1:${accountId}:inference-profile/us.amazon.nova-2-lite-v1:0`,
}
```

KB サービスロールには `bedrock:InvokeModel` に加え **`bedrock:GetInferenceProfile` と `bedrock:GetFoundationModel`** を付与する（`CreateDataSource` / `UpdateDataSource` のプリフライト検証で読取系を呼ぶため）。IAM の `resources` は `inference-profile/us.amazon.nova-2-lite-v1:0` とその背後の `foundation-model/amazon.nova-2-lite-v1:0` 両方を許可する。

**理由:**
- Bedrock default parser は **画像ファイル（PNG/JPG/GIF/WEBP）を処理できずインジェストジョブが失敗** することをデプロイで実測確認。default parser はテキスト系フォーマット（PDF/MD/TXT/HTML/DOC/XLS/CSV）専用
- BDA parser を選ぶと Nova MME が native 画像埋め込みを失いテキスト埋め込みに降格（`docs/1.md` で明記）
- Foundation Model Parser ならドキュメント解析は FM で、画像は Nova MME に直接流れるため native 画像埋め込みが維持される（`docs/1.md` で 12 画像インジェスト成功事例）
- Nova 2 Lite は Nova 系統一感とコスト・性能のバランスで選定。推論プロファイル経由で us-east-1 から呼び出す

**検討した代替案:**
- **Claude Sonnet 4.x 系を Parser に使用**: 高精度だがコスト高、本件の図表解析には過剰
- **BDA 採用**: Nova MME の強みを殺すため却下（決定 1 と矛盾）

**Trade-off:** Parser モデル呼び出しのコストが増える（ドキュメント取り込みごと）。ただし Nova MME と比べると桁違いに軽量なモデルで、画像の native 埋め込みの利点のほうが大きい。

## Risks / Trade-offs

- **[us-east-1 からのエンドユーザーレイテンシ増]** → 日本からのフロントエンドアクセスで +100〜150ms。**Mitigation**: CloudFront でのキャッシュ配信、フロントエンドは静的 SPA なので実質的な影響はほぼ無し
- **[Cognito ユーザー再作成の運用]** → ap-northeast-1 側の既存ユーザーは us-east-1 では再招待が必要。**Mitigation**: 管理者招待制（step-08 で自己サインアップ無効化済み）のため、運用上影響軽微
- **[Nova Multimodal が `RetrieveAndGenerate` をテキスト限定]** → 画像チャンクは自前で Claude に渡す必要あり。**Mitigation**: Agent 側の既存システムプロンプトを拡張、テストケース追加
- **[Bedrock KB ingestion job の完了待ち]** → 画像・PDF で 30 秒〜1 分になる可能性。**Mitigation**: ingestion ジョブ ID を返して非同期ポーリング、サイドバーに「処理中」バッジ表示
- **[既存リソースの撤去忘れ]** → ap-northeast-1 側の Bedrock KB / Agent Runtime / S3 / Cognito 等が残留するとコスト漏れ。**Mitigation**: sandbox 新規構築後、旧リソースは `npx ampx sandbox delete --identifier <old>` で撤去
- **[PPTX 画像抽出による `/api/pptx/parse` レスポンスサイズ肥大]** → Lambda 6 MB 上限接触の可能性。**Mitigation**: 決定 6 のプリサイン URL フォールバック
- **[AgentCore Runtime の invocations ペイロード上限]** → PPTX パース結果を画像ごと送ると 413 Payload Too Large。**Mitigation**: 決定 12 に基づき、フロントで画像を剥がして `imageCount` のみ送信
- **[Agent 側で KB/S3 操作失敗時に 424 Failed Dependency]** → `process` 内の事前 Retrieve や S3 `GetObject` が落ちるとエージェント全体が失敗。**Mitigation**: 決定 13 で try/catch により縮退（参照データなしで通常レビューを返す）
- **[Claude Sonnet 4.6 への vision 入力での token 消費増]** → 画像複数枚添付で生成トークンコスト増。**Mitigation**: `searchReferenceTool` の topK を既存 5 → 画像チャンクは最大 3 まで制限、プロンプトで `most_relevant_first` を明示
- **[AWS SDK for JavaScript (v3) の Nova Multimodal 型定義遅延]** → Lambda 側は `bedrock-agent-runtime` のみ使用、埋め込み呼び出しは Bedrock KB 側が隠蔽するため影響回避
- **[S3 メタデータヘッダに非 ASCII 文字を入れて失敗]** → 日本語ファイル名で `Invalid character in header content` が発生。**Mitigation**: 決定 11 に基づき `encodeURIComponent` でエンコード
- **[同期 Lambda パスのアップロードサイズ制約]** → base64 JSON で送る都合、実効 4 MB までしか扱えない。**Mitigation**: 決定 14 でクライアント／サーバ両方の 4 MB 制限と UI 表示を実装。将来 presigned URL 方式への切替で拡張予定
- **[Bedrock default parser が画像ファイルで失敗]** → `CfnDataSource.parsingConfiguration` 未指定だとインジェストジョブが PNG/JPG で `FAILED` になる。**Mitigation**: 決定 15 に基づき Foundation Model Parser (Nova 2 Lite 推論プロファイル) を明示指定、KB ロールに `GetInferenceProfile` / `GetFoundationModel` 追加

## Migration Plan

step-10 時点のハンズオン PoC には運用データが無かったため、本チェンジでは **ap-northeast-1 からのデータ移行は実施せず、us-east-1 に sandbox を新規構築** した。以下は本件での実手順。

1. **事前作業**
   - us-east-1 で以下のモデルアクセスをアカウント承認：
     - Amazon Nova Multimodal Embeddings (`amazon.nova-2-multimodal-embeddings-v1:0`) — 埋め込み
     - Amazon Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`) — Foundation Model Parser
     - Claude Sonnet 4.6 (`us.anthropic.claude-sonnet-4-6`) — レビュー生成
2. **us-east-1 での sandbox 新規構築**
   - `export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1`
   - `npx ampx sandbox` で us-east-1 にフルスタックを作成
     - Cognito User Pool / Identity Pool
     - API Gateway V2 (HTTP API, JWT 認証)
     - Lambda (pptx-parse, documents)
     - Bedrock AgentCore Runtime (Claude Sonnet 4.6)
     - データソース S3 バケット
     - Multimodal storage destination S3 バケット（ライフサイクル付き）
     - S3 Vectors バケット + インデックス（1024 次元）
     - Bedrock Knowledge Base（embedding model = Nova Multimodal、`dimensions: 1024` 明示）
     - KB サービスロール・各 Lambda 実行ロール
3. **E2E 検証**
   - `.md` / 画像 / PDF のアップロード、インジェストジョブ完了、Retrieve、レビュー生成までを確認
4. **旧リソース撤去**
   - 動作確認後、ap-northeast-1 側の旧 sandbox を `npx ampx sandbox delete --identifier <old>` で削除
5. **将来の本番運用時のマイグレーション**
   - 将来、本番相当のデータが溜まった時点での us-east-1 → 本番環境移行は、別チェンジで計画する

## Open Questions

以下は本チェンジのデプロイ後も未確定・別チェンジで追う事項：

1. Multimodal storage destination のライフサイクルルール：`aws/` 配下の transient data を何日で削除するのが安全か（現行 90 日設定、Bedrock の処理時間窓の確認待ち）
2. フロントエンドのサムネイル：multimodal storage destination の画像を直接 presigned URL で表示するか、別途サムネイル生成 Lambda を置くか（モバイル帯域次第）
3. Claude Sonnet 4.6 への vision 入力の 1 リクエストあたり画像枚数・サイズ上限の実測値（現状 topK=3 で制御）

### 解消した Open Questions（履歴）

- ~~`amazon.nova-2-multimodal-embeddings-v1:0` + **S3 Vectors** の組み合わせは managed KB で受理されるか？~~ → **受理される**。デプロイ実証済み（決定 3）
- ~~PPTX 内の画像を KB にインジェストする際のメタデータ設計~~ → documents handler で `Metadata.original-name` / `modality` を付与（決定 11）
- ~~OpenSearch Serverless の月次 OCU コスト試算~~ → S3 Vectors 採用で不要（決定 3）
- ~~ap-northeast-1 旧スタックの撤去タイミング~~ → step-10 PoC でデータ無しのため即時削除で問題なし

## Sources

- [Amazon Nova Multimodal Embeddings モデルカード](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-amazon-nova-multimodal-embeddings.html)
- [Build a knowledge base for multimodal content](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal.html)
- [Create a knowledge base for multimodal content](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal-create.html)
- [Choosing your multimodal processing approach](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal-choose-approach.html)
- [Prerequisites for multimodal knowledge bases](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-multimodal-prerequisites.html)
- [Using S3 Vectors with Amazon Bedrock Knowledge Bases](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-vectors-bedrock-kb.html)
- [Supported models and Regions for Amazon Bedrock knowledge bases](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base-supported.html)
- [Announcing Amazon Nova Multimodal Embeddings - AWS](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-nova-multimodal-embeddings/)
