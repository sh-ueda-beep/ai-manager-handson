## Why

Bedrock Knowledge Base は `.pptx` を直接インジェスト対象として受け付けない。一方で組織内ナレッジの多くは PowerPoint に詰まっており（業務フロー図、システム構成図、製品仕様書）、PPTX の本質は「テキストではなく図表・フローチャート・レイアウト」にある。

先行実装では PPTX 内部の埋め込み素材画像だけを抜いて KB に登録してみたが、実装後の検証と [外部事例の記事](docs/1.md 前後の議論) で以下が判明した：

- `pptx-parser` で取れるのはスライド内の **素材画像（アイコン・スクリーンショット等）のみ**
- フローチャートのテキスト要素は取れるが **矢印や相互関係は失われる**
- スライドの「見た目そのもの」は取得できていない

解決アプローチは **PPTX → PDF に変換してから KB に登録** する。既に our KB には Foundation Model Parser (`us.amazon.nova-2-lite-v1:0`) が設定されており、PDF 内の図表・フローチャート・画像の中身まで LLM が構造化テキストへ変換してくれる。この改訂で、ユーザーが PPTX をサイドバーに放り込むだけで、スライドの視覚情報を含めて検索可能になる。

## What Changes

- **LibreOffice headless 入りの新 Lambda `pptx-to-pdf`** を追加し、PPTX → PDF 変換を担当させる（ARM64 / Docker）
- `ReferenceSidebar` で `.pptx` が選ばれたとき、新エンドポイント **`POST /api/documents/upload-pptx`** に 1 リクエストで送信する（フロント側の並列バッチは廃止）
- `upload-pptx` の処理フロー：
  1. クライアントから `fileName`, `content`(base64), `pptxHash` を受け取る
  2. LibreOffice で PPTX → PDF に変換（メモリ展開 or `/tmp` 経由）
  3. S3 に `documents/pptx/<pptxHash>.pdf` として保存（冪等な命名）
  4. `StartIngestionJob` を 1 回起動して `ingestionJobId` を返す
- `DocumentFile` のメタデータに `sourceType='pptx-pdf'`、`sourcePptxName` を保持（S3 オブジェクトタグではなく、`Metadata['original-pptx-name']` ヘッダに URL エンコードで格納し、タグ値不正問題を根本回避）
- ReferenceSidebar の一覧で `sourceType='pptx-pdf'` のファイルは「`<元PPTX名>.pptx` (PDF変換済み)」と表示
- 既存実装のうち不要になる部分を削除：
  - フロントの `src/lib/pptxBatchUpload.ts`
  - documents Lambda の `buildPptxSlideKey` / `encodeTagValueBase64` / `decodeTagValueBase64` / `fetchPptxTags`
  - `/api/documents/upload` の `metadata.sourceType='pptx-slide'` 分岐
  - `documentsApi.ts` の `uploadSlideImage`、`SlideImageUploadArgs`、`DocumentFile` のスライド関連メタデータ
  - S3 の `s3:GetObjectTagging` / `s3:PutObjectTagging` 権限（タグ方式はやめるため）
- 一部を残すもの：
  - `src/lib/pptxHash.ts`（PDF 登録時のキー冪等化で引き続き利用）
  - `/api/documents/start-ingestion` エンドポイント（PDF アップロード完了後に 1 回呼ぶ用途で継続利用）
  - 既存 `/api/documents/upload` の `.md` / 画像 / PDF 直アップロード経路（非 BREAKING）
- クライアント側のアップロード上限は **4 MB のまま**（短期対応）。LibreOffice 変換後の PDF が 50MB の FM Parser 上限に収まる前提で、ほとんどの PPTX はこの 4MB の入力制限内に収まる
- レビュー画面 (`ReviewPanel` / `ReviewCard`) は **一切変更しない**

## Capabilities

### New Capabilities

なし

### Modified Capabilities

- `reference-data-management`:
  - `.pptx` のアップロード経路を「個別スライド画像の並列登録」から「PDF 変換 → 1 ファイル登録」に刷新
  - 新エンドポイント `POST /api/documents/upload-pptx` の追加
  - S3 オブジェクトタグでのメタデータ保存方式を廃止し、`Metadata` ヘッダ方式に統一
  - 一覧表示で `sourceType='pptx-pdf'` のラベル表記を規定

## Impact

- **新規バックエンド**
  - `amplify/functions/pptx-to-pdf/` 一式（`handler.ts`、`package.json`、`Dockerfile`、`resource.ts`）
    - Dockerfile: `public.ecr.aws/lambda/nodejs:22-arm64` ベースに LibreOffice headless (+ fonts) をインストール
    - handler: base64 デコード → `/tmp` に PPTX 書き込み → `libreoffice --headless --convert-to pdf` 実行 → PDF バイナリ読み戻し → S3 `PutObject`
    - メモリ 2048〜3008 MB / タイムアウト 5 分を想定
  - `backend.ts` に新 Lambda と新 API ルートを統合
- **既存バックエンドの縮退**
  - `amplify/functions/documents/handler.ts`:
    - PPTX スライドタグ関連ヘルパと分岐を削除
    - `/start-ingestion` は維持
  - `amplify/functions/documents/resource.ts`:
    - `s3:GetObjectTagging` / `s3:PutObjectTagging` の IAM を削除
- **フロントエンド**
  - `src/components/ReferenceSidebar.tsx`: `.pptx` 分岐を新 API 呼び出し（1 リクエスト）に変更、進捗表示を「PPTX を変換中」「KB 取り込み開始中」の 2 フェーズに整理
  - `src/lib/documentsApi.ts`: `uploadPptx()` を追加、`uploadSlideImage()` / `SlideImageUploadArgs` 削除、`DocumentFile` 型整理（`sourceType: 'pptx-pdf'`、`sourcePptxName` を保持、`slideNumber` / `pptxHash` を削除）
  - `src/lib/pptxBatchUpload.ts`: 削除
- **依存**
  - Docker イメージに LibreOffice と日本語フォント（Noto CJK）を同梱するため、ビルド時間 +数分増
  - 新規 npm 依存はなし
- **互換性**
  - 既存の `.md` / 画像 / PDF 直アップロードは従来どおり動作（**非 BREAKING**）
  - 既に画像タグ方式でアップロードされた PPTX スライドは誰も成功保存していない（TagValue エラーで弾かれていた）ため、データマイグレーション不要
