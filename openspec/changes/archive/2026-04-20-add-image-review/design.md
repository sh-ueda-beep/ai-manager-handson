## Context

現在の「AI Manager」はPPTXのテキスト（タイトル・本文・ノート）のみを解析してAIレビューを行う。画像を主体とするスライドや図表が多用されたスライドは、テキスト情報がほぼ存在しないためレビューが形骸化している。

本設計は以下の2フェーズの拡張を定義する：
1. **image-extraction**：Lambdaがスライドリレーション（`.rels`）を解析して画像をスライドに紐づけ、Base64でレスポンスに含める
2. **image-review**：AgentCoreエージェントがマルチモーダルメッセージで画像を送信し、Claude Visionによるビジュアルレビューを行う

## Goals / Non-Goals

**Goals:**
- PPTXスライドに含まれるPNG/JPEG画像をスライド番号に紐づけて抽出する
- 抽出した画像をBedrock Claude Visionへ送信してビジュアル観点のレビューコメントを生成する
- フロントエンドでスライドサムネイルとビジュアルレビューコメントを表示する

**Non-Goals:**
- EMF/WMF等のベクター形式やSVGには対応しない（PowerPoint特有の形式はスキップ）
- スライドの完全なレンダリングやサムネイル生成（LibreOffice等の変換）は行わない
- 画像のOCRによるテキスト抽出は行わない（Claude Visionの推論に委ねる）
- 動画・音声ファイルの処理は行わない

## Decisions

### 1. 画像とスライドのマッピング方法

**決定**: `ppt/slides/_rels/slide{N}.xml.rels` を解析してリレーションシップからメディアファイルパスを取得する

**理由**: PPTXの仕様上、スライドと埋め込みメディアのマッピングは `.rels` ファイルが唯一の正規手段。`ppt/media/` の直接スキャンではスライドと画像の対応が取れない。

**代替案**: `ppt/slides/slide{N}.xml` 内の `<p:pic>` タグからrIdを取得する方法もあるが、`.rels`読み取りと組み合わせる必要があり実質同じ処理量。

**⚠️ 実装上の既知バグ（必ず守ること）: `.rels` 内の相対パス解決**

OOXMLの仕様では、`.rels` ファイル内の相対パスは **`_rels/` ディレクトリではなく、その親ディレクトリ** を基点として解釈しなければならない。

```
_rels ファイル: ppt/slides/_rels/slide1.xml.rels
Target:         ../media/image1.png

❌ 誤（_rels/ を基点）: ppt/slides/_rels/../media/ → ppt/slides/media/image1.png  (ZIPに存在しない)
✅ 正（親を基点）:       ppt/slides/../media/       → ppt/media/image1.png
```

`zip.files[wrongPath]` は `undefined` を返すだけで例外を投げないため、パス解決が誤っていても画像が**サイレントにスキップ**される。実装では必ず親ディレクトリを基点とすること：

```typescript
// ❌ 誤: _rels/ ディレクトリ自体を基点にする
const relsDir = relsFilePath.substring(0, relsFilePath.lastIndexOf('/') + 1);
// → 'ppt/slides/_rels/'

// ✅ 正: _rels/ の親ディレクトリを基点にする
const relsDir = relsFilePath.replace(/\/_rels\/[^/]+$/, '/');
// → 'ppt/slides/'
```

---

### 2. 画像の転送形式

**決定**: Lambda→フロントエンド間、フロントエンド→AgentCore間ともにBase64エンコードで転送する

**理由**:
- 既存のJSONベースAPI（`/api/pptx/parse`）との互換性を保てる
- S3への一時保存を追加せず、インフラの複雑さを増やさない
- Bedrock InvokeModelは`image`コンテンツブロックにBase64を直接渡せる

**代替案**: 画像をS3に一時保存してPresigned URLを渡す方式 → レイテンシ増・S3権限設定追加が必要なため非採用

**制約**: API Gateway V2のペイロード上限は10MB。スライド数×画像サイズが増えると超過リスクがある。対策として1スライドあたりの画像数を最大3枚、1枚あたりのBase64サイズに上限を設ける（詳細はspecで定義）。

---

### 3. マルチモーダルリクエストの構造

**決定**: テキストと画像を1つのuserメッセージにまとめて送信する

```
messages: [
  {
    role: "user",
    content: [
      { type: "text", text: "スライド{N}のレビューをしてください。\nタイトル: ...\n本文: ..." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
      ...
    ]
  }
]
```

**理由**: Bedrock Claude Vision（Messages API）はこの形式をネイティブサポート。スライド単位でまとめることでモデルがテキスト文脈と画像を対応付けやすい。

**代替案**: 画像のみ先行送信して別ターンでテキストを送る → マルチターン管理が複雑化するため非採用。

---

### 4. ビジュアルレビュー観点の追加方法

**決定**: 既存のシステムプロンプトにビジュアル観点セクションを追記する（エージェント設定変更）

**理由**: AgentCoreのプロンプトは環境変数またはCDK定義で注入されており、コード変更なしにプロンプトのみ更新できる。新規エージェントを作成するより変更コストが低い。

---

### 5. フロントエンドの画像表示

**決定**: `ReviewCard`コンポーネントにサムネイル表示エリアを追加し、`data:image/...;base64,...`形式でimgタグに渡す

**理由**: 追加ライブラリ不要。既存の`ReviewCard`の責務（スライド別レビュー表示）と一致する。

## Risks / Trade-offs

| リスク | 対策 |
|--------|------|
| API Gatewayペイロード10MB超過 | 画像サイズ・枚数に上限を設ける。超過時はLambdaが該当画像をスキップしてwarningフィールドを返す |
| Lambdaのコールドスタート増加（画像処理の計算コスト） | 現状ARM64 Lambdaで画像はBase64変換のみ（重い変換処理なし）。メモリ不足の場合は512MB→1024MBに増やす |
| Bedrock Vision対応モデルの利用可能リージョン制限 | Claude 3 Sonnet/Haikuがus-east-1で利用可能。現行モデルを確認してCDKで明示的に固定する |
| `.rels`の相対パス解決バグ（サイレントスキップ） | **Decision 1の実装注意**を参照。`_rels/`の親を基点とする正規化が必須。`zip.files[path] === undefined`チェックをログに出してデバッグ可能にする |
| 画像なしスライドへの影響 | 画像未抽出スライドは既存テキストレビューのみ実施。`images`フィールドは空配列`[]`を返す（後方互換） |

## Migration Plan

1. Lambda（pptx-parse）を更新してデプロイ → `images`フィールドが空配列で追加される（既存動作に影響なし）
2. AgentCore Runtimeのプロンプト・メッセージ構造を更新してデプロイ
3. フロントエンドの`ParseResult`型・`ReviewCard`を更新してデプロイ

ロールバック: Lambda/AgentCoreはCDKのhotswapデプロイで旧バージョンに戻せる。フロントエンドはAmplify Hostingのブランチロールバックで対応。

## Open Questions

- 1スライドに複数画像がある場合、全画像をBedrockへ送るか、最初の1枚のみにするか（コスト vs レビュー品質のトレードオフ）
- Bedrock Claude Visionのトークンコスト増加をどのレベルまで許容するか（現行はテキストのみ）
- 大きなPPTXで画像総サイズが上限を超えた場合のユーザー向けメッセージ設計
