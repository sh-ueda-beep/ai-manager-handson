## MODIFIED Requirements

### Requirement: 参照ファイルのアップロード
フロントエンドの参照データサイドバーは、認証済みユーザが以下の拡張子のファイルをアップロードできなければならない（MUST）: `.md`、`.png`、`.jpg`、`.jpeg`、`.gif`、`.webp`、`.pdf`、**`.pptx`**。1 ファイルあたりの最大サイズは **4 MB**（同期 Lambda 経由の API Gateway + base64 オーバーヘッドを考慮した実効上限）とし、上限超過時はクライアント側で事前拒否しなければならない（MUST）。サーバ側も多層防御として、base64 デコード後のバッファ長が 4 MB を超えたら HTTP 413 を返さなければならない（MUST）。

#### Scenario: 許可拡張子のアップロード
- **WHEN** ユーザが `.md` / `.png` / `.pdf` / `.pptx` 等のファイルを選択ダイアログから投入する
- **THEN** システムは拡張子に応じた処理パイプライン（通常 1 ファイル登録 or PPTX→PDF 変換登録）に分岐する

#### Scenario: `.pptx` 選択時のパイプライン起動
- **WHEN** ユーザが `.pptx` を選択する
- **THEN** フロントエンドは通常の `/api/documents/upload` を直接呼ばず、新エンドポイント `POST /api/documents/upload-pptx` を 1 リクエストで呼ぶ

#### Scenario: 不許可拡張子のアップロード
- **WHEN** ユーザが `.exe` / `.zip` 等の不許可拡張子ファイルを投入する
- **THEN** システムはアップロードを拒否し、画面に「対応していないファイル形式です」と表示する

#### Scenario: サイズ上限超過（クライアント側）
- **WHEN** ユーザが 4 MB を超えるファイルを投入する
- **THEN** システムはアップロードを開始せず、画面に「ファイルサイズが上限 4 MB を超えています」と表示する

#### Scenario: サイズ上限超過（サーバ側多層防御）
- **WHEN** クライアント検証をバイパスされ、4 MB を超える base64 content が POST される
- **THEN** サーバはデコード後のバッファ長を検証して HTTP 413 Payload Too Large を返す

#### Scenario: 非 ASCII ファイル名のアップロード
- **WHEN** ユーザが日本語ファイル名（例: `設計図.png` / `設計書.pptx`）を投入する
- **THEN** サーバは S3 `PutObject` 時の `Metadata.original-name`（または PPTX の場合は `Metadata.original-pptx-name`）へ `encodeURIComponent(fileName)` で URL エンコードして保存し、`Invalid character in header content` エラーを発生させない

#### Scenario: UI への上限表示
- **WHEN** ユーザが参照データサイドバーを開く
- **THEN** アップロードボタン近辺に「最大 4 MB / ファイル」を明示する

## ADDED Requirements

### Requirement: PPTX→PDF 変換パイプライン
`.pptx` ファイルがサイドバーから選択された場合、フロントエンドは以下を自動実行しなければならない（MUST）：

1. 元 PPTX の SHA-256 を Web Crypto API (`crypto.subtle.digest`) で計算し、hex 先頭 12 文字を `pptxHash` として保持（既存 `src/lib/pptxHash.ts` を流用）
2. `POST /api/documents/upload-pptx` に `{ fileName, content (base64), contentEncoding: 'base64', pptxHash }` を送信
3. サーバから返ってきた `ingestionJobId` を既存のサイドバーのジョブポーリング機構に引き継ぐ

サーバ側（`pptx-to-pdf` Lambda）は以下を実行しなければならない（MUST）：

1. base64 デコードして `/tmp/input.pptx` に書き出す
2. LibreOffice headless で `libreoffice --headless --convert-to pdf --outdir /tmp /tmp/input.pptx` を実行
3. 生成された PDF を `documents/pptx/<pptxHash>.pdf` キーで S3 にアップロード
4. `Metadata` ヘッダに `source-type=pptx-pdf` と `original-pptx-name=<URL エンコード済み元PPTX名>` を付与
5. `StartIngestionJob` を 1 回呼んで `ingestionJobId` を取得
6. `{ ingestionJobId, key, fileName }` を HTTP 202 で返す

#### Scenario: 日本語名 PPTX の正常変換
- **WHEN** ユーザが `設計書.pptx`（4 MB 未満）をアップロードする
- **THEN** サーバは LibreOffice で PDF 変換し、`documents/pptx/<pptxHash>.pdf` に保存、インジェストジョブが 1 件起動されて `ingestionJobId` が返る

#### Scenario: 変換失敗（破損 PPTX）
- **WHEN** 破損した `.pptx` ファイル、または LibreOffice が変換できないファイルが投入される
- **THEN** サーバは HTTP 500 と `{ error, detail }` 形式で LibreOffice の stderr 抜粋を返し、ユーザが原因を把握できるようにする

#### Scenario: PPTX サイズ上限超過（事前）
- **WHEN** ユーザが 4 MB を超える `.pptx` を選択する
- **THEN** パースもアップロードも開始せず、クライアント側で「ファイルサイズが上限 4 MB を超えています」と表示する

#### Scenario: 変換後 PDF の 50 MB 超過
- **WHEN** 変換後 PDF が 50 MB（FM Parser 上限）を超過する
- **THEN** サーバは PDF アップロードもインジェスト起動も行わず、HTTP 413 と「変換後 PDF が大きすぎるため取り込みできません」を返す

#### Scenario: 冪等な再アップロード
- **WHEN** 同じ内容の PPTX（同一 `pptxHash`）を再度アップロードする
- **THEN** 同じ S3 キーで上書き保存され、エラーにならない

### Requirement: PPTX 由来ファイルのメタデータ保存
`pptx-to-pdf` Lambda は S3 `PutObject` 時に以下の Metadata ヘッダを付与しなければならない（MUST）：

- `Metadata['source-type'] = 'pptx-pdf'`
- `Metadata['original-pptx-name'] = encodeURIComponent(元PPTX名)`

S3 オブジェクトタグは使ってはならない（MUST NOT）。日本語・記号を含む PPTX 名で `TagValue invalid` エラーを発生させないため、Metadata ヘッダ + URL エンコード 1 段方式に統一する。

#### Scenario: Metadata ヘッダの付与
- **WHEN** PPTX が PDF 変換されて S3 に保存される
- **THEN** `source-type=pptx-pdf` と `original-pptx-name=<URL エンコード済み>` が `PutObject.Metadata` に設定される

#### Scenario: 非 ASCII 文字の正常保存
- **WHEN** 元 PPTX 名に日本語や括弧が含まれる（例: `設計書 (v2).pptx`）
- **THEN** URL エンコード経由で Metadata に保存され、S3 API がエラーを返さない

### Requirement: 参照ファイル一覧での PPTX PDF 表示
`/api/documents` GET は、S3 キーが `documents/pptx/` プレフィックスから始まる PDF について、`sourceType='pptx-pdf'` と `sourcePptxName` を `DocumentFile` に含めて返却しなければならない（MUST）。`sourcePptxName` は `HeadObject` でオブジェクトの `Metadata['original-pptx-name']` を取得して URL デコードして返す（MUST）。

#### Scenario: PPTX 由来 PDF の一覧返却
- **WHEN** クライアントが `/api/documents` を GET し、`documents/pptx/<hash>.pdf` が存在する
- **THEN** レスポンスには `sourceType='pptx-pdf'` と `sourcePptxName='設計書.pptx'`（デコード済み）が含まれる

#### Scenario: HeadObject 失敗時のフォールバック
- **WHEN** 特定オブジェクトの `HeadObject` が失敗する
- **THEN** そのファイルは `sourcePptxName` 省略で一覧に含められ、全体エラーにはしない

#### Scenario: 通常 PDF の互換表示
- **WHEN** 手動アップロードされた `documents/<任意名>.pdf` が一覧に含まれる
- **THEN** `sourceType` は設定されず（または `undefined`）、ファイル名そのまま表示される

### Requirement: 参照データサイドバーでの PPTX PDF 表示ラベル
フロントエンドのサイドバー一覧で、`sourceType === 'pptx-pdf'` のファイルは「`<sourcePptxName>` (PDF変換済)」形式のラベルを表示しなければならない（MUST）。タグが無い従来のファイルは、従来どおりファイル名のみ表示する（MUST）。

#### Scenario: PPTX 由来 PDF の表示
- **WHEN** 一覧に `sourceType='pptx-pdf'`、`sourcePptxName='設計書.pptx'` のファイルが含まれる
- **THEN** サイドバーには「設計書.pptx (PDF変換済)」と表示される

#### Scenario: メタデータなし PDF の表示
- **WHEN** 一覧にメタデータのない通常 PDF (`documents/spec.pdf`) が含まれる
- **THEN** サイドバーには「spec.pdf」と表示される（従来動作）

### Requirement: PPTX 処理の UI 進捗表示
`.pptx` 選択後、フロントエンドはバッチ処理の進捗をサイドバー上部に表示しなければならない（MUST）。表示フェーズは「PDF 変換中」「KB への取り込みを開始中」「インジェスト処理中（既存バッジへ合流）」を含む（SHOULD）。

#### Scenario: 処理中の進捗表示
- **WHEN** `.pptx` 選択後にサーバ呼び出しが進行中である
- **THEN** サイドバー上部に「PPTX を PDF に変換中...」または「KB への取り込みを開始中...」が表示される

#### Scenario: 完了時の進捗表示クリア
- **WHEN** アップロードとインジェスト起動が完了する
- **THEN** バッチ進捗表示は消え、通常のジョブポーリング表示に切り替わる

### Requirement: IAM 権限の整備（pptx-to-pdf Lambda）
`pptx-to-pdf` Lambda の実行ロールには以下を付与しなければならない（MUST）：

- データソースバケットへの `s3:PutObject`
- `bedrock:StartIngestionJob` / `bedrock:GetIngestionJob`（対象 KB）

先行実装で `documents` Lambda に付与されていた `s3:GetObjectTagging` / `s3:PutObjectTagging` は、本チェンジで不要となるため削除しなければならない（MUST）。

#### Scenario: pptx-to-pdf の S3 書込権限
- **WHEN** Lambda が `PutObject` で `documents/pptx/<hash>.pdf` を保存する
- **THEN** 権限拒否にならず保存が成功する

#### Scenario: pptx-to-pdf のインジェスト起動権限
- **WHEN** Lambda が `StartIngestionJob` を呼ぶ
- **THEN** 権限拒否にならずジョブが起動する

#### Scenario: 旧タグ権限の撤去
- **WHEN** スタックデプロイ後に `documents` Lambda の IAM ポリシーを確認する
- **THEN** `s3:GetObjectTagging` / `s3:PutObjectTagging` は含まれていない

## REMOVED Requirements

### Requirement: PPTX バッチ登録パイプライン
**Reason**: PPTX 内の画像を個別にアップロードするアプローチは、「スライドの図表・フローチャートの関係性が失われる」「埋め込み素材画像しか取れず意味が薄い」「S3 Object Tag の `TagValue invalid` 問題で実運用に載らなかった」という問題があり、PPTX→PDF 変換 + Foundation Model Parser 任せの新方式に全面置換するため削除する。

**Migration**: フロントエンドは `uploadPptxAsSlides` の代わりに新 `uploadPptx` を呼び出す。サーバ側は `documents` Lambda の `metadata.sourceType='pptx-slide'` 分岐と `buildPptxSlideKey` / `encodeTagValueBase64` / `fetchPptxTags` を削除し、新 `pptx-to-pdf` Lambda に処理を委譲する。旧方式でアップロード成功したファイルは存在しないため、データマイグレーション不要。

### Requirement: PPTX スライド画像のメタデータ付与
**Reason**: S3 Object Tag にメタデータ（`sourcePptxName`、`slideNumber`、`pptxHash`）を Base64 で保存する方式は、PDF 1 ファイル化に伴いスライド番号概念が消え、元 PPTX 名は Metadata ヘッダで十分扱えるため不要になった。

**Migration**: 同上。PPTX 由来の PDF は S3 Metadata ヘッダ `original-pptx-name` と `source-type=pptx-pdf` で識別する新方式に移行。

### Requirement: アップロード API の `skipIngestion` フラグ
**Reason**: スライド 1 枚ごとにアップロード API を N 回叩いて最後にまとめてインジェスト起動する設計は、PDF 1 ファイル化で不要になった。`pptx-to-pdf` Lambda が PDF 保存と同時にジョブ起動まで 1 操作で完結する。

**Migration**: `documents` Lambda の `/api/documents/upload` からは `skipIngestion` パラメータを削除する。`/api/documents/start-ingestion` エンドポイント自体は残置（管理運用での手動トリガー等に有用）。
