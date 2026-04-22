## Context

直前の `knowledge-base-multimodal-support` チェンジで、画像・PDF を参照データとして個別アップロード → KB インジェストするフローが実装された。本チェンジはその上に **「PPTX のスライドを 1 枚ずつ画像として KB に登録する UI とメタデータ配線」** を追加する最後の 1 マイル。

既存の利用可能なピース：
- `pptx-parser.ts` がスライドごとに画像バイナリを `SlideData.images[]` として返す
- `/api/documents/upload` が画像アップロードを受け付け、`images/` プレフィックスに保存、KB インジェストジョブを起動
- 参照データサイドバー `ReferenceSidebar.tsx` が一覧・サムネイル・削除・ジョブポーリングに対応
- 4 MB アップロード上限、非 ASCII ファイル名の `encodeURIComponent`、Nova MME + FM Parser の構成はデプロイ動作確認済

不足しているのは：
- レビュー画面の **UI**（プレビュー + 登録ボタン + 登録済みバッジ）
- **メタデータ配線**（元 PPTX 名・スライド番号・PPTX ハッシュ）
- **重複登録抑止**（同じ PPTX のスライド N を 2 回登録させない）

主要ステークホルダー：
- エンドユーザー（レビュー実施者）：一度レビューしたスライドを再利用できる
- KB 利用者（自分 or 同僚）：過去のスライド画像からアーキテクチャ図やフロー図を検索できる

## Goals / Non-Goals

**Goals:**
- レビュー画面の各スライドに画像プレビューと「KB に登録」ボタンを配置する
- 押下時に元 PPTX ファイル名・スライド番号・PPTX ハッシュを S3 オブジェクトタグとして付与する
- 同一 PPTX × 同一スライド番号の重複登録を UI レベルで抑止する
- ReferenceSidebar の一覧表示に「PPTX 由来」の情報（元ファイル名・スライド番号）を表示する
- 登録後、既存のジョブポーリング機構に合流して `COMPLETE` まで進捗表示する
- 非 BREAKING（既存 `.md` / 画像 / PDF 直接アップロードは現状のまま動作する）

**Non-Goals:**
- PPTX ファイルそのものの KB 登録（Bedrock 非対応、案 A で回避）
- PPTX → PDF 変換経由の登録（案 B、別チェンジ扱い）
- 複数スライド一括「全選択 → 一括登録」UX（MVP は 1 クリック 1 スライド）
- S3 に保存する画像の再エンコード／圧縮（PPTX 抽出時のフォーマットのまま保存）
- スライド画像の vision 事前解析・自動タグ付け（LLM によるキャプション生成など）
- PPTX 以外のソース（Google Slides/Keynote 等）からの登録

## Decisions

### 決定 1: メタデータは **S3 オブジェクトタグ** で保存する

**決定内容:** アップロード時、`PutObjectCommand.Tagging` にクエリ文字列形式で以下のタグを付与する：
- `sourceType=pptx-slide`
- `sourcePptxName=<URL エンコード済み元 PPTX 名>`
- `slideNumber=<1〜999>`
- `pptxHash=<SHA-256 先頭 12 文字>`

一覧 API では `GetObjectTagging` を並列発行して `DocumentFile` に含めて返す。

**理由:**
- S3 メタデータヘッダ (`x-amz-meta-*`) は非 ASCII 文字で失敗する（直前チェンジで `encodeURIComponent` による workaround 実装済だが、構造化されたメタデータには不向き）
- タグは値あたり 256 文字まで、オブジェクトあたり 10 タグまで扱え、**日本語ファイル名を URL エンコードして入れても問題ない**
- タグはオブジェクト本体と独立に後から追加・変更可能（将来の拡張余地）
- AWS コンソール／CLI で確認しやすい（運用デバッグが楽）

**検討した代替案:**
- **`.metadata.json` サイドカーファイル**: `images/pptx/<hash>/slide<NNN>.metadata.json` のように別オブジェクトとして保存。メリットは自由構造だが、一覧取得時に 1 オブジェクトにつき追加 1 GET が必要で N+1 問題が出る
- **S3 Metadata ヘッダ (`x-amz-meta-*`)**: 非 ASCII 文字と値 2KB 制限のため今回は採用しない
- **DynamoDB テーブル**: 運用リソース追加に見合うほどのメタデータ量ではないため却下

**Trade-off:** 一覧取得時に各オブジェクトに対して `GetObjectTagging` が発生する（= `ListObjectsV2` 結果件数分の API 呼び出し）。ファイル数が数十の段階では問題ないが、数百件以上になると `Promise.all` による並列化 + 適宜ページング対応が必要。

### 決定 2: S3 キー命名規則 `images/pptx/<pptxHash>/slide<NNN>.<ext>`

**決定内容:** PPTX 由来スライド画像は以下の命名規則で保存する：

```
images/pptx/<pptxHash>/slide<NNN>.<ext>
例: images/pptx/a1b2c3d4e5f6/slide001.png
```

- `pptxHash`: 元 PPTX ファイルの SHA-256 先頭 12 文字（例 `a1b2c3d4e5f6`）
- `NNN`: スライド番号 3 桁ゼロ埋め（`001`, `002`, ...）
- `ext`: パーサから得た `mediaType` に応じて `png` / `jpg` / `jpeg` / `gif` / `webp`

**理由:**
- 同一 PPTX の同一スライドは同じキーになり、再登録時に S3 上書きで冪等
- `pptxHash` プレフィックスで PPTX ごとにグルーピングされて確認しやすい
- 既存命名規則 `images/<uuid>.<ext>`（documents handler のデフォルト）とは別プレフィックス `images/pptx/` を切ることで、手動アップロード画像とフロー系画像を分離
- ハッシュ 12 文字（48 bit）は数万ファイルでも衝突確率ほぼ 0

**検討した代替案:**
- **UUID ベース**: 既存パターンだが、重複判定の難しさから却下
- **`<元ファイル名>-slide<N>` 方式**: 日本語ファイル名の URL エンコードが必要でキーが冗長に

### 決定 3: `pptxHash` はクライアント側で Web Crypto API を使って算出

**決定内容:** 元 PPTX ファイルの `ArrayBuffer` に対し、ブラウザ標準 `crypto.subtle.digest('SHA-256', buffer)` で SHA-256 を算出し、hex 文字列先頭 12 文字をハッシュとして使う。ユーザーが PPTX をアップロードしてパース成功したタイミングで 1 回計算し、`App.tsx` の state に保持する。

**理由:**
- サーバー側でハッシュ計算するには PPTX をもう一度送る必要があり、無駄な往復が発生
- Web Crypto API は外部依存なしで利用可能、ブラウザネイティブで高速
- パース後のタイミングなら既に `File.arrayBuffer()` は取得済み
- サーバー側の整合性チェックは不要（ハッシュは一意性のためであって信頼性検証ではない）

**検討した代替案:**
- **Lambda で PPTX 解析時にハッシュ返却**: パーサに責務追加、現行 API 互換性を壊すため却下
- **ファイルサイズ + ファイル名のハッシュ**: 同名別内容で衝突するため却下

### 決定 4: 重複登録判定は **一覧取得 → クライアント側判定**

**決定内容:** レビュー画面表示時に `listDocuments()` で現在の参照データ一覧を取得し、`sourceType === 'pptx-slide'` かつ `pptxHash === <current>` のスライドを集合として保持する。各スライドの「KB に登録」ボタンは、該当スライド番号が集合に含まれている場合は無効化し「登録済み」バッジに変更する。

**理由:**
- サーバー側で専用エンドポイント (`/exists?pptxHash=...&slideNumber=...`) を作るより、既存一覧 API を活用するほうがシンプル
- 同じ PPTX 内で複数スライドを連続登録するケースで、毎回個別チェックせずにクライアントキャッシュで判定できる
- 登録直後は楽観更新でバッジを即時反映（サイドバーポーリングが追いついた時点で確定）

**検討した代替案:**
- **HEAD リクエストで個別存在確認**: 遅い + 404 を握る必要あり
- **専用エンドポイント `/documents/exists`**: 管理対象 API が増える

**Trade-off:** 一覧取得が高頻度化する。ただし `listDocuments()` はサイドバーで既に使っている呼び出しなので実質的な追加負荷はなし。

### 決定 5: UI はレビュー画面の **`ReviewCard` 内ではなく別エリア** に集約

**決定内容:** レビュー画面には新しいコンポーネント `SlideThumbnailStrip`（仮）を設け、以下を表示：
- 各スライドのサムネイル（`SlideData.images[0]` の最初の画像を base64 でインライン表示、画像がなければプレースホルダ）
- スライド番号ラベル
- 「KB に登録」ボタン／登録済みバッジ
- クリックで既存の `selectedSlide` state に連動（サイドバーと同じ動き）

配置先は「レビュー左ペイン（`Sidebar`）の下部」または「`ReviewPanel` のヘッダー直下のストリップ」。既存 `Sidebar` は文字情報中心なので、新コンポーネントは横スクロール可能なストリップ形式にする。

**理由:**
- `ReviewCard` はレビュー本文表示用で、画像プレビュー・登録アクションを混ぜるとコンポーネント責務が肥大化する
- スライド選択 UX はサイドバーで既に存在する → 画像プレビュー付きの第二の選択手段として整合性が取れる
- 横スクロールストリップは PPTX のスライド一覧を一望でき、レビュー中の視認性が高い

**検討した代替案:**
- **`ReviewCard` にプレビューを埋め込む**: 責務混在、却下
- **モーダルで画像一覧**: 操作ステップが増えるため却下

### 決定 6: アップロード時のリクエスト形式と命名責務の切り分け

**決定内容:**
- **クライアント側**: `pptxHash` と `slideNumber` を決定し、S3 キー（フルパス `images/pptx/<hash>/slide<NNN>.<ext>`）を計算してリクエストに含める
- **サーバー側**: 受け取った key が `images/pptx/` プレフィックス以下であること、命名規則に合致することを検証（不正値は 400）。タグ付けと S3 保存を実行

リクエスト body（拡張分）:
```json
{
  "fileName": "slide001.png",
  "content": "<base64>",
  "contentEncoding": "base64",
  "metadata": {
    "sourceType": "pptx-slide",
    "sourcePptxName": "<元 PPTX ファイル名>",
    "slideNumber": 1,
    "pptxHash": "a1b2c3d4e5f6"
  }
}
```

S3 保存先の key は、`metadata.sourceType === 'pptx-slide'` の場合に **サーバー側で** `images/pptx/<pptxHash>/slide<NNN>.<ext>` を組み立てる（`fileName` は最終判断に使わない、UI 表示用のみ）。

**理由:**
- キー組み立てを **サーバー側で一元化** することで、クライアントの命名ミスやパストラバーサル攻撃を防ぐ
- `metadata` がない既存アップロードは従来どおり `images/<fileName>` で保存される（非 BREAKING）
- `metadata.slideNumber` と `pptxHash` をサーバーが確認することで、バリデーションを一箇所に集約

**検討した代替案:**
- **クライアントでキー組み立てて直接指定**: 攻撃面が広がるため却下

### 決定 7: 登録後のジョブポーリングは既存サイドバーに委譲

**決定内容:** 「KB に登録」押下でアップロード API が 202 + `ingestionJobId` を返す。クライアントは登録済み集合を楽観更新し、`ingestionJobId` を `ReferenceSidebar` に伝播させて既存のポーリング機構に合流させる。レビュー画面側では個別のポーリングは持たず、サイドバーに「処理中 N 件」の表示を頼る。

**理由:**
- ポーリングロジックを二重化しない
- 既存の UI 表示（バッジ・失敗表示・再試行の土台）を流用

**実装メモ:** `ReferenceSidebar` の `jobStatuses` state をリフトアップして `App.tsx` で管理するか、または ReferenceSidebar 側に「外部から job を追加できる」API を生やす。後者の方が最小変更。

## Risks / Trade-offs

- **[S3 `GetObjectTagging` の API 呼び出しコスト増]** → 一覧取得で N 回発生。**Mitigation**: `Promise.all` で並列化、件数 100 超で警告ログ + 将来キャッシュ検討
- **[クライアント側ハッシュ算出でブラウザ固有の差]** → `crypto.subtle` はモダンブラウザで使えるが Safari 古いバージョンで注意。**Mitigation**: Amplify のサポートブラウザに揃える、失敗時は一意性を落として UUID でフォールバック
- **[同じ PPTX 別名ファイル問題]** → `a.pptx` と `a-copy.pptx` で中身が同じならハッシュ一致、別名でも登録済み判定が効く（意図通り）
- **[PPTX 内の画像サイズが 4 MB 超]** → 既存の 4 MB 上限で 413 が返る。**Mitigation**: クライアント側で事前サイズチェック、超過時はスライドごとに「サイズ超過」ラベルを表示してボタンを無効化。将来 presigned URL 化で解決
- **[S3 タグ値の長さ上限（256 文字）]** → 日本語 PPTX 名を URL エンコードすると 3 倍に膨れる。**Mitigation**: `sourcePptxName` は元名を 80 文字で切ってエンコード、超過時はタグに格納せず別途扱う
- **[S3 タグ数の上限（10 タグ / オブジェクト）]** → 現時点 4 タグ使用、余裕あり
- **[命名規則ミスで既存画像を上書き]** → サーバー側バリデーションで `images/pptx/<hex12>/slide<NNN>.<ext>` パターン厳密チェック
- **[重複登録判定の race condition]** → 同じ PPTX を 2 タブで開いて同時登録すると両方成功する。**Mitigation**: S3 の `If-None-Match: *` などで冪等化するが、MVP では無視（同じ内容の上書きなので実害ほぼ無し）

## Migration Plan

非 BREAKING のため段階的デプロイ可能：

1. **バックエンド先行**
   - `documents` Lambda にメタデータ受領ロジックと `PutObjectTagging` を実装
   - `handleList` で `GetObjectTagging` を呼んでタグを返却
   - IAM に `s3:GetObjectTagging` / `s3:PutObjectTagging` 権限追加
   - デプロイしても既存アップロードは `metadata` なしで従来挙動
2. **フロントエンド**
   - `documentsApi.ts` に `uploadSlideImage()` 追加と `DocumentFile` 型拡張
   - `SlideThumbnailStrip` コンポーネント新設
   - `ReviewPanel` / `App.tsx` に配線
3. **E2E 検証**
   - 複数画像の PPTX で 1 枚ずつ登録できる
   - 登録済みバッジが表示される
   - サイドバーで PPTX 由来表記が出る
   - 同じ PPTX を再アップロードしたとき既登録が検出される
4. **ロールバック**
   - フロント側は feature flag は設けず、バグ発覚時は `App.tsx` から `SlideThumbnailStrip` を外すだけで旧動作に戻る
   - バックエンドの `handleUpload` 拡張は `metadata === undefined` の場合に従来どおり動くため、放置しても無害

## Open Questions

1. `SlideThumbnailStrip` の配置先はレビュー左ペイン or レビューヘッダー直下か？ （PoC 実装時に UI 試作して決定）
2. PPTX 由来スライドの `DocumentFile` 一覧での表示ラベル文言（例: 「`設計書.pptx` / スライド 3」vs「PPTX slide 3 of 設計書」）
3. 将来、PPTX 全体を一括登録する「すべてのスライドを KB に登録」ボタンを追加するか？ （本チェンジではスコープ外）
4. S3 タグに付与する `sourcePptxName` の文字数制限時（80 文字超）のフォールバック詳細
5. 将来 presigned URL 直接アップロードに切り替えた場合、このメタデータ配線をどう引き継ぐか（presigned URL では `Tagging` ヘッダを事前指定可能だが設計変更が必要）

## Sources

- [S3 Object Tagging](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-tagging.html)
- [PutObjectCommand Tagging property — AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/command/PutObjectCommand/)
- [Web Crypto API — SubtleCrypto.digest()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)
- 先行チェンジ `knowledge-base-multimodal-support` の `design.md` 決定 11（`encodeURIComponent` 対応の経緯）
