## 1. 先行実装の撤去（既存コードの縮退）

- [x] 1.1 `amplify/functions/documents/handler.ts` から `PptxSlideMetadata` 型、`MAX_SOURCE_NAME_CHARS_BEFORE_BASE64` 定数、`PPTX_HASH_PATTERN` 定数、`buildPptxSlideKey` / `encodeTagValueBase64` / `decodeTagValueBase64` / `buildPptxSlideTagging` / `fetchPptxTags` を削除
- [x] 1.2 `handleUpload` から `metadata.sourceType === 'pptx-slide'` 分岐、`skipIngestion` 受領ロジック、`Tagging` 付与を削除（通常ファイル路線のみ維持）
- [x] 1.3 `handleList` から `fetchPptxTags` 呼び出しを削除し、PPTX PDF 判定を S3 キー prefix `documents/pptx/` ベースに切替（`HeadObject` で `original-pptx-name` を取得して `sourcePptxName` を返す）
- [x] 1.4 `amplify/functions/documents/resource.ts` から `s3:GetObjectTagging` / `s3:PutObjectTagging` の IAM ポリシーを削除
- [x] 1.5 `src/lib/documentsApi.ts` から `uploadSlideImage`、`SlideImageUploadArgs` を削除
- [x] 1.6 `src/lib/documentsApi.ts` の `DocumentFile` 型から `slideNumber`、`pptxHash` を削除（`sourceType` を `'pptx-slide'` → `'pptx-pdf'` に差し替え、`sourcePptxName` は維持）
- [x] 1.7 `src/lib/pptxBatchUpload.ts` を削除
- [x] 1.8 `src/components/ReferenceSidebar.tsx` から旧 `uploadPptxAsSlides` import と並列バッチロジックを撤去し、新実装の 1 リクエスト方式に置換

## 2. pptx-to-pdf Lambda の新規追加

- [x] 2.1 `amplify/functions/pptx-to-pdf/` ディレクトリを作成
- [x] 2.2 `package.json` 作成：`@aws-sdk/client-s3`, `@aws-sdk/client-bedrock-agent`, `aws-lambda-ric`, `typescript`, `@types/node`
- [x] 2.3 `Dockerfile` 作成：**Debian slim (`public.ecr.aws/docker/library/node:22-slim`) ベース**に `apt install libreoffice fonts-noto-cjk fonts-dejavu build-essential cmake python3 autoconf automake libtool libcurl4-openssl-dev unzip ca-certificates`、ENTRYPOINT は `/var/task/node_modules/.bin/aws-lambda-ric` で Lambda として起動（AL2023 ベースは LibreOffice パッケージが無く断念、決定 1 参照）
- [x] 2.4 `handler.ts` 実装：body バリデーション / 4MB 上限 / `/tmp/work-<uuid>` 一意 workdir / `libreoffice --headless --norestore --nolockcheck --convert-to pdf` spawn / 失敗時 500+stderr 抜粋 / 50MB 超 413 / `documents/pptx/<hash>.pdf` PutObject（`source-type` / `original-pptx-name` Metadata 付与）/ StartIngestionJob
- [x] 2.5 `resource.ts` 実装：`DockerImageFunction` (ARM64 / 3008MB / 5min / ephemeral 2GB) + IAM + HTTP API ルート `POST /api/documents/upload-pptx` を既存 documents API に合流
- [x] 2.6 `amplify/backend.ts` に新 Lambda と新ルートを統合（`createDocumentsApi` が `jwtAuthorizer` / `integration` を返すよう変更、`createPptxToPdfLambda` を DocumentsStack に追加）

## 3. フロントエンド: 新 `uploadPptx()` と ReferenceSidebar

- [x] 3.1 `src/lib/documentsApi.ts` に `uploadPptx(file, pptxHash)` を追加
- [x] 3.2 `ReferenceSidebar.handleFileSelect` で `.pptx` 分岐 → `computePptxHash` → `uploadPptx`（1 リクエスト）
- [x] 3.3 `pptxPhase` state（`'converting' | 'starting-ingestion' | 'idle'`）で進捗ラベル表示
- [x] 3.4 完了後 `fetchFiles()`、`ingestionJobId` を既存 `pollJob()` に引き継ぎ
- [x] 3.5 一覧表示で `sourceType === 'pptx-pdf'` のとき「`<sourcePptxName>` (PDF変換済)」+ `Presentation` アイコン
- [x] 3.6 エラー時にサーバ応答の `error`/`detail` を画面表示（`uploadPptx` 側で throw）

## 4. 型チェックとビルド

- [x] 4.1 `cd amplify/functions/documents && npx tsc --noEmit handler.ts` エラーなし
- [x] 4.2 `cd amplify/functions/pptx-to-pdf && npx tsc --noEmit handler.ts` エラーなし
- [x] 4.3 `cd amplify && npx tsc --noEmit` エラーなし
- [x] 4.4 `npm run build`（フロント）エラーなし

## 5. E2E 検証（ユーザー検証）

- [x] 5.1 `npx ampx sandbox` で LibreOffice Docker のビルドが完走した（3 段階のビルドエラーを乗り越えて成功）
- [x] 5.2 日本語名 PPTX を ReferenceSidebar からアップロード → 進捗が「変換中」→「取り込み開始中」と遷移、エラーなく完了
- [x] 5.3 サイドバー一覧に「<元名>.pptx (PDF変換済)」が 1 件表示される
- [x] 5.4 インジェストジョブが `COMPLETE` まで到達
- [x] 5.5 PPTX の図表・フロー情報が Retrieve 結果に構造化テキストとして現れる
- [x] 5.6 同じ PPTX の再アップロードで S3 キー上書き冪等（エラーなし）
- [x] 5.7 4 MB 超 PPTX は事前にクライアント側で拒否
- [x] 5.8 既存の `.md` / 画像 / PDF 直アップロードが回帰なく動作
- [x] 5.9 レビュー機能への影響なし

## 6. ドキュメント・クロージング

- [x] 6.1 `openspec validate pptx-slide-to-kb` エラーなし
- [ ] 6.2 README か docs/ に「PPTX を参照データとして登録する手順（PDF 変換経由）」の簡易ガイドを追記（**本チェンジのスコープ外、別タイミングで対応**）
- [x] 6.3 `openspec archive pptx-slide-to-kb` で main specs へ sync（実行中）

## 7. デプロイ時発見の追加修正（実装済みの記録）

実装／デプロイ過程で遭遇した 3 段階の Docker ビルドエラーと対応：

- [x] 7.1 **AL2023 ベースで `libreoffice-headless` 不在** → Debian slim ベース + `aws-lambda-ric` 方式に切替（決定 1 に反映）
- [x] 7.2 **`aws-lambda-ric` の `cmake not installed` エラー** → `build-essential`, `cmake`, `python3`, `autoconf`, `libtool`, `unzip`, `ca-certificates` を apt に追加
- [x] 7.3 **`aclocal not found`（automake 不足）エラー** → `automake` と `libcurl4-openssl-dev` を apt に追加、AWS 公式 Lambda Container ドキュメントと同じパッケージ構成に揃えた
- [x] 7.4 ARM64 プラットフォーム指定の警告は無視（`FROM --platform=linux/arm64` は動作に影響なし）
