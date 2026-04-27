## 1. 型定義の更新

- [x] 1.1 `src/types.ts` の `SlideData` 型に `images: { mediaType: string; data: string }[]` と `imagesTruncated: boolean` フィールドを追加する
- [x] 1.2 `src/types.ts` の `ParseResult` 型が更新された `SlideData` を参照していることを確認する

## 2. Lambda（pptx-parse）— 画像抽出実装

- [x] 2.1 `ppt/slides/_rels/slide{N}.xml.rels` を読み取って `Type=".../image"` のリレーションを抽出する `parseSlideRels` 関数を実装する
- [x] 2.2 **パス解決は `_rels/` の親ディレクトリを基点にする**（`relsFilePath.replace(/\/_rels\/[^/]+$/, '/')` を使用）。`ppt/slides/_rels/` を基点にするとパスが壊れるため厳守する
- [x] 2.3 解決したZIP内パスで `zip.files[resolvedPath]` が `undefined` の場合はスキップして警告ログを出力する処理を追加する
- [x] 2.4 PNG/JPEG ファイルを `async/arraybuffer()` で読み取り、Base64エンコードして `{ mediaType, data }` オブジェクトを生成する処理を実装する
- [x] 2.5 1スライドあたり最大3枚・1枚あたり1MB（Base64）の上限チェックを追加し、超過時に `imagesTruncated: true` をセットする
- [x] 2.6 既存の `parsePptx` 関数の戻り値（各スライドオブジェクト）に `images` と `imagesTruncated` フィールドを追加する

## 3. AgentCore Runtime（pptx-review）— マルチモーダル対応

- [x] 3.1 エージェントコードのメッセージ生成ロジックで、スライドの `images` が空でない場合に `content` 配列へ画像ブロック（`{ type: "image", source: { type: "base64", media_type, data } }`）を追加するよう変更する
- [x] 3.2 CDK定義のBedrockモデルIDをマルチモーダル対応モデル（Claude 3 Sonnet 以降）に明示的に固定する
- [x] 3.3 システムプロンプトにビジュアルレビュー観点（図の明瞭さ・情報密度・文字の可読性・デザイン整合性）を追記し、画像ありスライドのコメントに「【ビジュアル】」プレフィックスを付けるよう指示する

## 4. フロントエンド — 画像表示対応

- [x] 4.1 `ReviewCard` コンポーネントに `images` propsを受け取るサムネイル表示エリアを追加する（`data:image/...;base64,...` 形式で `<img>` タグに渡す）
- [x] 4.2 `parseReview.ts` で「【ビジュアル】」プレフィックスを持つコメントを識別してビジュアルコメントとして分類する処理を追加する
- [x] 4.3 `StructuredReview` 型にビジュアルコメントフィールドを追加し、`ReviewCard` で表示を分ける

## 5. デプロイ・動作確認

- [x] 5.1 Lambda（pptx-parse）をビルドしてデプロイし、画像を含むPPTXファイルで `images` フィールドが正しく返ることをcurlで確認する
- [x] 5.2 画像のないスライドで `images: []`・`imagesTruncated: false` が返ることを確認する（後方互換）
- [x] 5.3 AgentCore Runtime をデプロイし、画像付きスライドのレビューで「【ビジュアル】」コメントが生成されることを確認する
- [x] 5.4 フロントエンドをビルドしてデプロイし、画像を含むPPTXのレビューでサムネイルとビジュアルコメントが表示されることをブラウザで確認する
- [x] 5.5 画像のみのスライド（テキストなし）で「スライドの内容が提供されていません」が返らないことを確認する（`.rels` パス解決バグの回帰テスト）
