## ADDED Requirements

### Requirement: スライドリレーション解析
Lambda は `ppt/slides/_rels/slide{N}.xml.rels` を解析して、各スライドに埋め込まれた画像メディアのZIP内パスを特定しなければならない（MUST）。パス解決は OOXML 仕様に従い、**`_rels/` ディレクトリではなくその親ディレクトリ** を基点とした相対パス解決を行う。

#### Scenario: 正常なリレーション解析
- **WHEN** スライドに画像（PNG/JPEG）が埋め込まれており、対応する `.rels` ファイルが存在する
- **THEN** システムは `Type` 属性が `http://schemas.openxmlformats.org/officeDocument/2006/relationships/image` のリレーションを抽出し、`Target` の相対パスを親ディレクトリ基点で解決して正しいZIP内パス（例: `ppt/media/image1.png`）を得る

#### Scenario: パス解決の検証
- **WHEN** `.rels` ファイルの `Target` が `../media/image1.png` であり、`.rels` ファイルのパスが `ppt/slides/_rels/slide1.xml.rels` である
- **THEN** 解決されたパスは `ppt/media/image1.png` でなければならない（`ppt/slides/media/image1.png` ではない）

#### Scenario: `.rels` ファイルが存在しないスライド
- **WHEN** スライドに対応する `.rels` ファイルが存在しない、またはリレーションが空
- **THEN** システムはそのスライドの `images` フィールドを空配列 `[]` として返し、エラーにはしない

#### Scenario: 非対応形式のメディアを含むスライド
- **WHEN** スライドに EMF・WMF・SVG 等の非対応形式のメディアが埋め込まれている
- **THEN** システムは非対応メディアを無視し、PNG/JPEG のみを抽出する

### Requirement: 画像データのBase64エンコード
システムは抽出した画像ファイルを Base64 エンコードして返さなければならない（MUST）。

#### Scenario: PNG画像の抽出
- **WHEN** スライドに PNG 画像が埋め込まれている
- **THEN** システムは `{ mediaType: "image/png", data: "<Base64文字列>" }` 形式で画像データを返す

#### Scenario: JPEG画像の抽出
- **WHEN** スライドに JPEG 画像が埋め込まれている
- **THEN** システムは `{ mediaType: "image/jpeg", data: "<Base64文字列>" }` 形式で画像データを返す

#### Scenario: ZIPに画像ファイルが存在しない（サイレントスキップ）
- **WHEN** `.rels` から解決したパスに対応するファイルが ZIP アーカイブ内に存在しない
- **THEN** システムはその画像をスキップし、警告ログを出力する。他の画像の処理は継続する

### Requirement: 画像数・サイズ上限
Lambda は API Gateway V2 のペイロード上限（10MB）超過を防ぐため、1スライドあたりの画像数と1画像あたりのBase64サイズに上限を設けなければならない（MUST）。

#### Scenario: 画像数が上限以内
- **WHEN** 1スライドの画像数が3枚以内である
- **THEN** システムは全画像を抽出してレスポンスに含める

#### Scenario: 画像数が上限超過
- **WHEN** 1スライドの画像数が3枚を超える
- **THEN** システムは先頭3枚のみを抽出し、残りをスキップする。レスポンスの該当スライドに `imagesTruncated: true` フラグを付与する

#### Scenario: 画像サイズが上限超過
- **WHEN** 1画像のBase64サイズが1MB（約750KB バイナリ）を超える
- **THEN** システムはその画像をスキップし、レスポンスの該当スライドに `imagesTruncated: true` フラグを付与する
