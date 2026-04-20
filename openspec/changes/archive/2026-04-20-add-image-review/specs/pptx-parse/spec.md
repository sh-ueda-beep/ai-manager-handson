## MODIFIED Requirements

### Requirement: JSON レスポンス形式
Lambda は抽出結果を構造化 JSON で返さなければならない（MUST）。レスポンスにはスライド総数とスライドごとのデータ（スライド番号、タイトル、本文テキスト、ノート、**画像リスト**）を含む。

#### Scenario: 正常レスポンス（画像あり）
- **WHEN** 画像を含む PPTX ファイルの解析が正常に完了する
- **THEN** システムは以下の構造の JSON を返す:
  ```
  {
    "totalSlides": number,
    "slides": [{
      "slideNumber": number,
      "title": string,
      "body": string,
      "notes": string,
      "images": [{ "mediaType": "image/png" | "image/jpeg", "data": string }],
      "imagesTruncated": boolean
    }]
  }
  ```

#### Scenario: 正常レスポンス（画像なし）
- **WHEN** 画像を含まない PPTX ファイルの解析が正常に完了する
- **THEN** システムは各スライドの `images` フィールドを空配列 `[]`、`imagesTruncated` を `false` として返す

#### Scenario: 解析エラー時のレスポンス
- **WHEN** PPTX ファイルの解析中にエラーが発生する
- **THEN** システムはステータスコード 500 と `{ "error": string }` 形式の JSON を返す
