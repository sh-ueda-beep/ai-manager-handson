## Why

現在のPPTXレビュー機能はテキスト（タイトル・本文・ノート）のみを解析対象としており、画像のみで構成されたスライドや図表を含むスライドは実質的にレビューの対象外となっている。視覚的な情報を含むプレゼン資料でも品質レビューを完結させるため、スライド内の画像をAIが視覚的に解析するイメージレビュー機能を追加する。

## What Changes

- PPTXパーサーがスライドから画像（PNG/JPEG）を抽出し、Base64エンコードしてレスポンスに含める
- AIレビューエージェントが画像付きスライドに対してマルチモーダル推論（Bedrock Claude Vision）でビジュアルレビューを実施する
- レビュー観点に「ビジュアル品質」（図の見やすさ・情報密度・文字の可読性）を追加する
- フロントエンドのレビューカードにスライドサムネイルと画像レビューコメントを表示する

## Capabilities

### New Capabilities
- `image-extraction`: PPTXスライドから画像メディア（PNG/JPEG）を抽出し、スライド番号に紐づけてBase64形式で返す機能
- `image-review`: 抽出した画像をBedrock Claude Visionでマルチモーダル解析し、ビジュアル観点のレビューコメントを生成する機能

### Modified Capabilities
- `pptx-parse`: レスポンス構造に `images` フィールド（スライド番号と画像Base64の配列）を追加する要件変更
- `pptx-review`: 画像付きスライドに対してビジュアルレビュー観点（図の明瞭さ・情報密度・可読性）を追加する要件変更

## Impact

- **Lambda（pptx-parse）**: `jszip` で `ppt/media/` 配下の画像ファイルを読み取り、スライドとのマッピング（`ppt/slides/_rels/slide*.xml.rels`）を解析する処理を追加
- **AgentCore Runtime（pptx-review agent）**: Bedrock InvokeModel の messages に `image` コンテンツブロックを含む形式に変更（マルチモーダル対応モデルが必要）
- **API Gateway**: レスポンスサイズ増加（画像Base64を含む）によりペイロード上限（10MB）への配慮が必要
- **フロントエンド**: `ParseResult` 型に `images` フィールドを追加、`ReviewCard` に画像サムネイル表示を追加
- **依存関係**: Bedrock モデルをマルチモーダル対応モデル（Claude 3以降）に固定する必要がある
