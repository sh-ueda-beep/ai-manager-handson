## Why

Bedrock Knowledge Base は `.pptx` を直接インジェスト対象として受け付けないが、AI Manager の主対象は PPTX であり、スライド内の図表・アーキテクチャ図・画面キャプチャを「後から検索したい」というユーザー要求が強い。直前にリリースした Nova Multimodal Embeddings は画像をネイティブに埋め込める。`pptx-parser` は既にスライド画像を抽出できる状態で、`/api/documents/upload` も画像アップロードを受け付ける。つまり、**レビュー画面の UI と documents Lambda のメタデータ対応を足すだけで、PPTX を「スライド画像群」として KB に登録できる**。この最後の 1 マイルを実装することで、過去レビューしたスライドからの視覚検索と再利用が可能になる。

## What Changes

- レビュー画面（`ReviewPanel` / `ReviewCard`）の各スライドに **画像プレビュー** と「**KB に登録**」ボタンを追加
- クリック時、スライド画像を `/api/documents/upload` に送信。リクエストには元 PPTX ファイル名・スライド番号・ユーザー識別子などのメタデータを付与
- `documents` Lambda を拡張し、アップロード時に受け取ったメタデータを **S3 オブジェクトタグ** としてオブジェクトに付与（`x-amz-meta-*` は非 ASCII 問題があるため、値の長い日本語を含み得るメタデータはタグ方式を推奨）
- 登録済みスライドは**登録済みバッジ**を表示し、同じ PPTX × スライド番号の重複登録を抑止
- S3 のキー命名規則を **`images/pptx/<pptxHash>/slide<NNN>.png`** とし、`pptxHash` は元 PPTX の SHA-256 の先頭 12 文字を使用することで、同一 PPTX からの重複判定を単純化
- ReferenceSidebar の一覧表示でも、メタデータがあるファイルには「PPTX由来（`<元ファイル名>` / スライド N）」のラベルを表示
- 登録後、既存のインジェストジョブポーリングに合流し `COMPLETE` まで UI で進捗を追跡

## Capabilities

### New Capabilities

なし（既存 capability の拡張のみ）

### Modified Capabilities

- `reference-data-management`: 参照データアップロード API にメタデータ（`sourceType='pptx-slide'`、`sourcePptxName`、`slideNumber`、`pptxHash`）の受領と S3 オブジェクトタグ付与を追加。一覧 API でタグを返却し、フロント側で登録済み判定・出典表示に利用できるようにする
- `pptx-review`: レビュー画面に「スライド画像プレビュー + KB 登録ボタン + 登録済みバッジ」を追加

## Impact

- **フロントエンド**
  - `src/components/ReviewPanel.tsx` / `ReviewCard.tsx`: スライド画像プレビューと KB 登録ボタン
  - `src/lib/documentsApi.ts`: `uploadSlideImage()` 関数（File ではなく base64 + メタデータ受け取り）
  - `src/types.ts`: `DocumentFile` に PPTX 由来メタデータ field（`sourceType`, `sourcePptxName`, `slideNumber`）を追加
  - App.tsx: 登録済みスライドの状態管理（既存 `files` 一覧を参照し、`pptxHash` + `slideNumber` で判定）
- **バックエンド**
  - `amplify/functions/documents/handler.ts`:
    - `handleUpload` でリクエストボディに `metadata?: { sourceType, sourcePptxName, slideNumber, pptxHash }` を受け取る
    - S3 オブジェクトタグ（`s3:PutObjectTagging` 相当を `PutObjectCommand.Tagging` に含める）でメタデータを付与
    - `handleList` で S3 オブジェクトタグを取得してレスポンスに含める（`GetObjectTagging` 呼び出しのバッチ）
    - 命名規則 `images/pptx/<pptxHash>/slide<NNN>.png` の検証（clientは命名するが、サーバー側でも prefix 妥当性チェック）
- **IAM**
  - documents Lambda の実行ロールに `s3:GetObjectTagging` / `s3:PutObjectTagging` 権限を付与
- **依存**
  - 新規 npm 依存なし（ハッシュは Web Crypto API / Node crypto で算出、`@aws-sdk/client-s3` の `PutObjectCommand.Tagging` は既存 SDK バージョンで利用可能）
- **互換性**
  - 既存 `.md` / 画像 / PDF のアップロード経路は変更なし（**非 BREAKING**）。`metadata` はオプショナル
  - 既存アップロード済みのファイルにはタグが無い → 一覧取得時はタグ無し = PPTX 由来でないと扱う
