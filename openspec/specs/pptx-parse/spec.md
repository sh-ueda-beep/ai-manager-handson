## ADDED Requirements

### Requirement: PPTX ファイル受信
Lambda 関数は API Gateway 経由で POST された PPTX ファイルを受信し、デコードできなければならない（MUST）。リクエストは `Content-Type: application/json` で、`{ "file": "<Base64エンコードされたPPTX>" }` 形式の JSON ボディとする。

#### Scenario: 正常な PPTX ファイルの受信
- **WHEN** フロントエンドから `{ "file": "<Base64>" }` 形式の JSON が POST される
- **THEN** Lambda は `file` フィールドの Base64 をデコードし、ZIP として展開処理に渡す

#### Scenario: 不正なファイルの受信
- **WHEN** PPTX 形式でないファイル（破損ファイルや別形式のファイル）が POST される
- **THEN** Lambda はステータスコード 400 とエラーメッセージ「無効な PPTX ファイルです」を返す

### Requirement: スライドテキスト抽出
システムは PPTX ファイル内の各スライドから、タイトル・本文テキストを抽出しなければならない（MUST）。抽出には `jszip` で ZIP を展開し、`ppt/slides/slide*.xml` 内の `<a:t>` タグからテキストを取得する。

#### Scenario: 複数スライドのテキスト抽出
- **WHEN** 5 枚のスライドを含む PPTX ファイルが送信される
- **THEN** システムはスライド番号順に 5 つのスライドデータを返し、各スライドにテキスト内容が含まれる

#### Scenario: テキストのないスライド
- **WHEN** テキストを含まないスライド（画像のみ等）が存在する
- **THEN** システムは該当スライドを空のテキストとして返し、エラーにはしない

### Requirement: スライド構造の識別
システムはスライド内のテキストをタイトル（`<p:sp>` の `<p:nvSpPr>` で type が title/ctrTitle）と本文に分類しなければならない（SHALL）。

#### Scenario: タイトルと本文の分類
- **WHEN** タイトルと箇条書き本文を含むスライドが処理される
- **THEN** システムはタイトルテキストと本文テキストを区別して返す

#### Scenario: タイトルのないスライド
- **WHEN** タイトル要素を含まないスライドが処理される
- **THEN** システムはタイトルを空文字列として返し、全テキストを本文として扱う

### Requirement: スピーカーノート抽出
システムは各スライドのスピーカーノート（`ppt/notesSlides/notesSlide*.xml`）が存在する場合、テキストを抽出しなければならない（SHALL）。

#### Scenario: ノートありのスライド
- **WHEN** スピーカーノートが設定されたスライドが処理される
- **THEN** システムは該当スライドのレスポンスにノートテキストを含める

#### Scenario: ノートなしのスライド
- **WHEN** スピーカーノートが設定されていないスライドが処理される
- **THEN** システムは該当スライドのノートを空文字列として返す

### Requirement: JSON レスポンス形式
Lambda は抽出結果を構造化 JSON で返さなければならない（MUST）。レスポンスにはスライド総数とスライドごとのデータ（スライド番号、タイトル、本文テキスト、ノート、画像配列）を含む。

#### Scenario: 正常レスポンス
- **WHEN** PPTX ファイルの解析が正常に完了する
- **THEN** システムは以下の構造の JSON を返す: `{ "totalSlides": number, "slides": [{ "slideNumber": number, "title": string, "body": string, "notes": string, "images": [{ "index": number, "mediaType": string, "bytes"?: string, "presignedUrl"?: string }] }] }`

#### Scenario: 解析エラー時のレスポンス
- **WHEN** PPTX ファイルの解析中にエラーが発生する
- **THEN** システムはステータスコード 500 と `{ "error": string }` 形式の JSON を返す

#### Scenario: 画像なし PPTX のレスポンス
- **WHEN** 画像を含まない PPTX が正常に解析される
- **THEN** 各スライドの `images` フィールドは空配列 `[]` として返される

### Requirement: スライド画像抽出
システムは PPTX ファイル内の各スライドから、埋め込み画像（`ppt/media/image*.{png,jpg,jpeg,gif}` 等）を抽出しなければならない（MUST）。抽出では `jszip` で ZIP を展開し、各スライドの relationship（`ppt/slides/_rels/slide*.xml.rels`）を解析して該当スライドに紐づく画像のみを収集する。

#### Scenario: 画像を含むスライドの抽出
- **WHEN** 画像を含むスライドが処理される
- **THEN** システムは該当スライドの画像バイナリを base64 文字列として抽出し、スライドデータの `images` フィールドに `{ index, mediaType, bytes }` 配列として設定する

#### Scenario: 複数画像を含むスライド
- **WHEN** 1 スライドに複数の画像が埋め込まれている
- **THEN** システムは出現順に 0 から採番された `index` を各画像に付与し、すべてを `images` 配列に含める

#### Scenario: 画像を含まないスライド
- **WHEN** 画像を含まないスライドが処理される
- **THEN** システムは `images` フィールドを空配列として返し、エラーにはしない

#### Scenario: 非対応画像形式のスキップ
- **WHEN** スライドに `.emf` / `.wmf` 等のベクタ画像が埋め込まれている
- **THEN** システムは該当画像を抽出対象から除外し、警告ログを出力する（処理は継続する）

### Requirement: 大容量レスポンスのプリサイン URL フォールバック
抽出結果の合計サイズが Lambda レスポンス上限（6 MB）に接近する場合（閾値 5 MB 超）、システムは画像バイナリを一時 S3 にアップロードし、`images[].bytes` の代わりに `images[].presignedUrl`（5 分有効）を返さなければならない（MUST）。

#### Scenario: 通常サイズの PPTX
- **WHEN** 抽出結果の合計サイズが 5 MB 以下である
- **THEN** システムは画像を `bytes`（base64）としてインラインで返す

#### Scenario: 大容量 PPTX
- **WHEN** 抽出結果の合計サイズが 5 MB を超える
- **THEN** システムは画像を一時 S3 バケットにアップロードし、`presignedUrl` を返す

#### Scenario: 混在レスポンスの禁止
- **WHEN** フォールバックが必要な場合
- **THEN** システムはすべての画像を `presignedUrl` 方式に統一し、`bytes` と `presignedUrl` を混在させない

### Requirement: JWT 認証
API Gateway エンドポイントは Cognito JWT トークンによる認証を必須としなければならない（MUST）。

#### Scenario: 有効なトークンでのリクエスト
- **WHEN** 有効な Cognito JWT トークンを含むリクエストが送信される
- **THEN** Lambda が実行され、解析結果が返される

#### Scenario: トークンなしのリクエスト
- **WHEN** JWT トークンなしでリクエストが送信される
- **THEN** API Gateway はステータスコード 401 を返す
