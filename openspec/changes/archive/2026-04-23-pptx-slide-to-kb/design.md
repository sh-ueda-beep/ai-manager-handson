## Context

`knowledge-base-multimodal-support` で、画像・PDF を参照データとして KB にインジェストする仕組みと、**Foundation Model Parser (`us.amazon.nova-2-lite-v1:0`)** が動いている。FM Parser は PDF 内の図表・フローチャート・画像を LLM が読み取って構造化テキストに変換する機能で、PDF アップロードでは実動作を確認済み。

先行の `pptx-slide-to-kb` の当初実装は「PPTX 内の素材画像を個別に取り出して KB へ」という方針だったが、検証で：
- 取れるのは埋め込み素材（アイコン等）のみで、スライドの「絵」そのものではない
- フローチャートの矢印・関係性が失われる（markitdown 系と同じ問題）

外部事例記事（[docs/1.md 以降の議論]）でも「**PPTX → PDF に変換してから KB に登録し、FM Parser に図表解析を任せる**」という王道パターンが共有されていた。FM Parser は PDF 上のフローチャートを以下のように構造化テキスト化できる：

```
## 経費申請フロー
### 申請者
経費発生 → 領収書UP → 申請入力 → 送信
...
**フローの流れ：**
1. 申請者が経費発生後、領収書をアップロードし...
```

本チェンジは、**既に我々のスタックで動いている FM Parser を PPTX にも効かせる** ため、PPTX→PDF 変換のレイヤーだけ追加する。記事と同じ Nova 2 Lite パーサーを流用できるので、大きな追加決定は LibreOffice Lambda だけ。

## Goals / Non-Goals

**Goals:**
- `.pptx` アップロード時に、サーバ側で **LibreOffice headless による PPTX → PDF 変換** を行う
- 変換後の PDF を既存の Bedrock KB (Nova MME + Nova 2 Lite FM Parser) に取り込み、図表・フローチャートの内容まで検索可能にする
- ユーザー操作は「サイドバーに .pptx を放り込むだけ」の 1 クリック完結
- 同じ PPTX の再アップロードは冪等（S3 キー `documents/pptx/<pptxHash>.pdf` で上書き）
- クライアント側 4 MB 制限を維持（PPTX 入力の範囲）
- 先行実装で価値が出なかったスライド画像個別登録ロジックを完全に撤去し、コードベースをシンプル化

**Non-Goals:**
- PPTX 50MB までの対応（別チェンジで presigned URL 化して拡張する）
- スライド単位での個別登録 UI（PDF 1 ファイル単位でのチャンキングは FM Parser 任せ）
- ナレッジベース埋め込みモデル／パーサーの変更（Nova MME + Nova 2 Lite 継続）
- レビュー画面 (`ReviewPanel` / `ReviewCard`) への機能追加（完全に分離維持）
- LibreOffice 以外での変換（Azure や OpenOffice、クライアントサイド変換は採用しない）
- 変換失敗時の自動リトライ（ユーザーが再アップロードする前提で MVP は許容）

## Decisions

### 決定 1: PPTX → PDF 変換は **LibreOffice headless** を Docker Lambda で実行（Debian slim ベース）

**決定内容:** `amplify/functions/pptx-to-pdf/` を新規追加。`public.ecr.aws/docker/library/node:22-slim`（Debian slim）ベースの Dockerfile に LibreOffice と日本語フォントをインストールし、**AWS Lambda Runtime Interface Client (`aws-lambda-ric`)** を同梱して Lambda として起動する。handler で以下を行う：

1. リクエスト body から `fileName`, `content`(base64), `pptxHash` を取得
2. `/tmp/work-<uuid>/input.pptx` に書き出し（Lambda `/tmp` は `ephemeralStorageSize` 2 GB に拡張）
3. `libreoffice --headless --norestore --nolockcheck --convert-to pdf --outdir /tmp/work-<uuid> /tmp/work-<uuid>/input.pptx` をサブプロセス実行
4. 生成された PDF を読み込み
5. S3 `documents/pptx/<pptxHash>.pdf` に `PutObject`（`Metadata['original-pptx-name']` に URL エンコード済み元名を保存）
6. `StartIngestionJob` を呼んで `ingestionJobId` を返す

**ベースイメージの選定理由:**
- AWS 公式 Lambda ベース `public.ecr.aws/lambda/nodejs:22-arm64`（Amazon Linux 2023）には **`libreoffice` / `libreoffice-headless` の dnf パッケージが無い**（EPEL も利用不可、デプロイで実測失敗）
- Debian slim の `apt install libreoffice` が参考記事 (`TS-AI-BOSS/Dockerfile`) でも実績のある王道
- Lambda は Docker image であれば任意のベースで動くため、AWS Lambda Runtime Interface Client を同梱すれば OK

**必要な apt パッケージ一式:**
| カテゴリ | パッケージ |
|---|---|
| LibreOffice 本体 | `libreoffice` |
| 日本語フォント | `fonts-noto-cjk`, `fonts-dejavu` |
| ネイティブビルド（aws-lambda-ric 向け） | `build-essential`, `cmake`, `python3`, `autoconf`, `automake`, `libtool`, `libcurl4-openssl-dev`, `unzip`, `ca-certificates` |

**ENTRYPOINT:** `/var/task/node_modules/.bin/aws-lambda-ric` を起点に `handler.handler` を指定。

**理由:**
- 記事で実績が紹介されている「業界の王道」
- AWS Lambda の Docker image size 上限 10 GB に LibreOffice (~400 MB) + ツールチェーン (~300 MB) は余裕で収まる
- LibreOffice の PDF export は PPTX の図表・フォント・レイアウトを忠実に再現する
- Bedrock Data Automation (BDA) は PPTX 未対応、OpenOffice は古く選択肢外

**検討した代替案:**
- **Amazon Linux 2023 Lambda ベース + dnf 経由**: 上記のとおり `libreoffice` パッケージが存在せず却下（検証で ImmutableError を確認）
- **マルチステージビルド**: 公式 Lambda イメージから Runtime Interface Client だけ抽出して Debian slim に COPY する案。動的リンクと `/var/runtime` 構造の互換性が脆く、`aws-lambda-ric` npm で完結する方がメンテしやすい
- **AWS Fargate / ECS**: Cold start なしだが、常駐コスト発生・オーバーキル
- **クライアントサイド (pptxjs 等)**: 複雑 PPTX の描画精度が不十分

**Trade-off:**
- Docker image が ~1 GB 程度（LibreOffice + ビルドツール + Node.js + 依存）、deploy-time-build で数分〜10 分
- Cold start 3〜5 秒、通常実行 5〜15 秒/ファイル
- Lambda メモリ 3008 MB、ephemeral storage 2 GB、timeout 5 分で余裕を持たせる
- 変換が確率的に失敗するケース（破損 PPTX、特殊オブジェクト）は 500 + stderr 抜粋で握る
- ビルドツール (`build-essential`, `cmake` 等) は本来は多段ビルドで実行時イメージから外すと軽量化できる。MVP では単段構成を許容

### 決定 2: クライアント側は **1 リクエスト完結**、新エンドポイント `POST /api/documents/upload-pptx`

**決定内容:** フロントは `.pptx` 選択時に `computePptxHash(file)` でハッシュ計算 → `fetch('/api/documents/upload-pptx', { body: JSON.stringify({ fileName, content, pptxHash }) })` を 1 回呼ぶだけ。並列バッチアップロード（`pptxBatchUpload.ts`）は削除する。

**理由:**
- 先行実装の「並列 N 枚アップロード」は、スライド個別登録を前提とした複雑さ。PDF 1 ファイル化で不要
- 1 リクエストなら進捗 UI も「変換中 → インジェスト起動中」の 2 フェーズでシンプル
- 途中失敗の部分成功ハンドリングも不要

**検討した代替案:**
- 既存 `/api/documents/upload` に `.pptx` 分岐を入れる: `documents` Lambda に LibreOffice を統合する必要があり、Docker image が重くなる。**責務分離の観点で別 Lambda にする方が運用しやすい**

### 決定 3: 冪等な S3 キー `documents/pptx/<pptxHash>.pdf`

**決定内容:** PDF の保存先は `documents/pptx/<pptxHash>.pdf`（`pptxHash` は元 PPTX の SHA-256 先頭 12 文字）。同じ内容の PPTX を再アップロードした場合は同じキーで上書きになるため、KB の差分取り込みでも重複登録されない。

**理由:**
- 先行実装の `images/pptx/<hash>/slide<NNN>.png` を簡素化（1 PPTX = 1 PDF）
- `documents/` プレフィックスに入れることで、FM Parser の対象として扱われる（既存 `documents/` は `.md` / `.pdf` 向け）
- `pptxHash` はクライアント側で `src/lib/pptxHash.ts`（既存）を流用して算出

### 決定 4: メタデータは **S3 Object Metadata ヘッダ**（タグではなく）

**決定内容:** PDF オブジェクトに以下のメタデータヘッダを付与する：

- `Metadata['original-pptx-name']` = `encodeURIComponent(元PPTX名)`
- `Metadata['source-type']` = `pptx-pdf`

S3 オブジェクトタグは使わない。一覧取得時は `ListObjectsV2` のレスポンスに含まれる `Key` から `documents/pptx/` プレフィックスを判定して `sourceType='pptx-pdf'` を設定し、元ファイル名は `HeadObject` で取得する（または遅延取得）。

**理由:**
- 先行実装では S3 Object Tag に日本語を入れて `TagValue invalid` で詰まった経緯あり
- Metadata ヘッダなら URL エンコード 1 段で非 ASCII を安全に扱える（既存の `Metadata['original-name']` と同じ方式）
- Nova MME / FM Parser はタグもメタデータも参照しない（検索結果のメタ情報としてフロントに表示するだけの用途）

**検討した代替案:**
- Object Tag + Base64 エンコード: 先行実装で動作確認済みだが、フロント側でデコードが必要、コードが二系統になる
- `.metadata.json` サイドカー: N+1 GET 問題、却下

**Trade-off:** 一覧取得で元 PPTX 名を表示するために `HeadObject` を N 回並列呼び出しする必要がある（先行実装の `GetObjectTagging` と同じオーダー）。ファイル数 100 件超で懸念が出たら将来最適化。

### 決定 5: 既存 `/api/documents/start-ingestion` エンドポイントは残す

**決定内容:** 先行実装で追加した `POST /api/documents/start-ingestion` は削除せず、`pptx-to-pdf` Lambda から同等の `StartIngestionJob` を呼ぶ形でも可。**ただし本チェンジでは `pptx-to-pdf` 内で完結的に呼び出す**（ネットワーク往復を減らすため）。`start-ingestion` は将来の運用手動トリガー等に有用なので削除しない。

**理由:**
- `pptx-to-pdf` が PDF 保存直後にそのままジョブ起動するのが最も高速
- `start-ingestion` は別用途（管理者手動再取り込み等）で残す

### 決定 6: クライアント上限 4MB 維持、長期拡張は別チェンジ

**決定内容:** `src/lib/documentsApi.ts` の `MAX_FILE_SIZE_BYTES = 4 MB` はそのまま。`.pptx` も同じ 4MB 上限に従う。FM Parser は 50MB まで対応するが、presigned URL 方式への移行と合わせて別チェンジ（次期）で拡張する。

**理由:**
- 4MB 以下で収まる PPTX は多い（ビジネス用途の一般的な仕様書・構成図）
- API Gateway + Lambda の同期呼び出し上限 6 MB / base64 +33% を考えると、現実的な上限
- presigned URL 化は複数 Lambda（フロント S3 署名取得、S3 Event → 変換 Lambda）を絡める設計変更になり、スコープ拡大

**Trade-off:** 大容量 PPTX（ドキュメント系や高画質画像多数）は現時点では非対応、事前にフロントで「4MB 超過」を明示する。

## Risks / Trade-offs

- **[LibreOffice Docker image size 増]** → デプロイ時間 +数分〜10 分、初回 Cold start 遅延。**Mitigation**: Lambda プロビジョンド同時実行は不要（利用頻度低想定）、日本語フォントは Noto CJK / DejaVu のみに絞る
- **[変換失敗（破損 PPTX、特殊オブジェクト）]** → 一部 PPTX で LibreOffice が変換エラー。**Mitigation**: handler で subprocess の stderr を捕捉して 500 応答の `detail` に含め、ユーザーが原因を把握できるようにする
- **[変換後の日本語フォント崩れ]** → Noto CJK JP 以外のフォントを要するドキュメントでグリフが置き換わる。**Mitigation**: Noto CJK を同梱、運用ドキュメントに「カスタムフォントは埋め込まれた描画にのみ反映」と明記
- **[変換時間のユーザー体感]** → 5〜15 秒/ファイル。**Mitigation**: サイドバーに「PPTX を PDF に変換中...」のフェーズ表示、タイムアウトは 5 分で安全マージンを確保
- **[先行実装の撤去で既存タグ付きオブジェクトが S3 に残存]** → ただし先行実装は `TagValue invalid` で保存に成功したオブジェクトは無いため、実データ影響なし
- **[/tmp 512 MB 上限]** → 巨大 PPTX + PDF の同時展開で溢れる可能性。**Mitigation**: `ephemeralStorageSize` を 2 GB に拡張、4 MB 入力制限下では余裕
- **[PDF 変換後サイズが 50MB を超える場合]** → 本チェンジの 4MB 入力制限下ではほぼ起きないが、理論上可能。**Mitigation**: 変換後サイズをチェックして 50MB 超過なら警告しインジェスト起動しない（将来の圧縮対応まではエラー扱い）
- **[Lambda ベースイメージ選定ミス]** → Amazon Linux 2023 ベースには LibreOffice パッケージが存在せず、最初のビルドで `No package matches 'libreoffice-headless'` が発生した。**Mitigation**: Debian slim ベース + aws-lambda-ric に切り替えて解決。決定 1 に記録済み
- **[aws-lambda-ric のネイティブビルド依存]** → 初回ビルドで `cmake not installed` / `aclocal not found` のエラーが段階的に発生。**Mitigation**: `build-essential`, `cmake`, `python3`, `autoconf`, `automake`, `libtool`, `libcurl4-openssl-dev`, `unzip` を apt で同梱。将来はマルチステージビルドでランタイムイメージから削るのが望ましい
- **[FM Parser のトークン消費コスト]** → PPTX の図解析は Nova 2 Lite に LLM 呼び出しが走る。**Mitigation**: Nova 2 Lite は Claude Sonnet 比で桁違いに安いため運用規模で許容。利用量は CloudWatch Metrics で監視

## Migration Plan

非 BREAKING 段階的デプロイ：

1. **バックエンド先行**
   - `amplify/functions/pptx-to-pdf/` 一式を作成（Dockerfile / handler / resource / package.json）
   - `amplify/backend.ts` に Lambda と `POST /api/documents/upload-pptx` ルートを統合
   - 既存 `documents` Lambda から PPTX スライドタグ関連ヘルパーを削除
   - IAM: `documents` から `s3:GetObjectTagging` / `s3:PutObjectTagging` を削除、`pptx-to-pdf` に `s3:PutObject` + `bedrock:StartIngestionJob` を付与
2. **フロントエンド**
   - `src/lib/documentsApi.ts` に `uploadPptx()` 追加、`uploadSlideImage` 系の API を削除、`DocumentFile` 型から `slideNumber` / `pptxHash` を除去（`sourceType` と `sourcePptxName` は残す）
   - `src/lib/pptxBatchUpload.ts` を削除
   - `src/components/ReferenceSidebar.tsx` の `.pptx` 分岐を 1 リクエスト化、進捗フェーズを 2 段階に
3. **sandbox デプロイ確認**
   - `npx ampx sandbox` で LibreOffice Docker のビルドが通ること
   - 日本語名 PPTX を登録してインジェスト `COMPLETE` まで到達、サイドバー表示が `<名前>.pptx (PDF変換済)` 相当になること
4. **E2E 検証**
   - フローチャート入り PPTX でレビュー/Retrieve 時に図の関係性が検索結果に現れる
   - 既存 `.md` / 画像 / PDF アップロードは引き続き動作（回帰なし）
5. **ロールバック**
   - フロント側: `ReferenceSidebar` の `.pptx` 分岐だけ旧実装（並列バッチ）にロールバック可能にしない（旧実装は TagValue エラーで動かないため、ロールバックの価値なし）
   - サーバ側: `pptx-to-pdf` Lambda を削除し、`upload-pptx` ルートを外すだけで元のコア機能（`.md` / 画像 / PDF）は無影響

## Open Questions

1. 変換後 PDF が 50MB を超えた場合の挙動（本チェンジではエラー、将来は LibreOffice の PDF 圧縮オプション `--convert-to pdf:writer_pdf_Export:SelectPdfVersion=1`、`ReduceImageResolution=true` 等で対応）
2. LibreOffice Lambda のメモリ最適値（現状 3008 MB / ephemeral 2 GB、実利用データで適正化）
3. 変換失敗時のログレベル（現状 stderr の先頭 1000 文字だけを 500 応答の `detail` に含める実装、CloudWatch には全文出力）
4. 同じ `pptxHash` の PDF を再アップロードしたとき、KB 側で「コンテンツは同じだが再インジェストが走る」挙動が想定どおりか（chunkingStrategy 次第）
5. Docker image 肥大化対策としてのマルチステージビルド（runtime からビルドツールを削る）を将来的に導入するか

### 解消した Open Questions

- ~~LibreOffice の Lambda Docker image 構築で使う apt/yum パッケージの最終リスト（Amazon Linux 2023 ベースイメージでの動作確認が必要）~~ → AL2023 には LibreOffice が無いため、Debian slim + `apt install libreoffice fonts-noto-cjk` 方式を採用。`aws-lambda-ric` のビルドに `build-essential cmake python3 autoconf automake libtool libcurl4-openssl-dev unzip` が追加で必要（決定 1 に記録）

## Sources

- 外部事例: PPTX→PDF→Foundation Model Parser アーキテクチャ（docs/1.md 前後の議論で共有）
- 参考 Dockerfile: `/Users/sh-ueda/repos/TS-AI-BOSS/Dockerfile`（`apt install libreoffice fonts-noto-cjk` の実装例）
- [Parsing options for your data source - Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-advanced-parsing.html)
- [S3 Object Metadata ヘッダ制約](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html)
- [AWS Lambda container image for Node.js](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html)（Debian ベースで RIC を使う手順）
- LibreOffice Headless PDF Export: https://help.libreoffice.org/latest/en-US/text/shared/guide/pdf_params.html
- 先行チェンジ `knowledge-base-multimodal-support` design.md（Nova MME / FM Parser 構成）
