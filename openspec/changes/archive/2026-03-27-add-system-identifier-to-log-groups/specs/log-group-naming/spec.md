## ADDED Requirements

### Requirement: ロググループの明示的な命名
Lambda 関数の CloudWatch ロググループは `/<システム識別子>/<機能名>` の形式で明示的に命名しなければならない（SHALL）。システム識別子は `ai-manager` とする。

#### Scenario: PptxParse Lambda のロググループ名
- **WHEN** PptxParse Lambda 関数がデプロイされる
- **THEN** CloudWatch ロググループ名が `/ai-manager/pptx-parse` である

#### Scenario: ロググループ名での検索
- **WHEN** 運用者が CloudWatch コンソールで `ai-manager` を検索する
- **THEN** AI Manager 関連のロググループがすべて表示される

### Requirement: ロググループの保持期間設定
CloudWatch ロググループには明示的な保持期間を設定しなければならない（SHALL）。デフォルトの無期限保持は使用しない。

#### Scenario: ログの自動削除
- **WHEN** ロググループに設定された保持期間（1ヶ月）を超えたログがある
- **THEN** 該当ログは CloudWatch により自動的に削除される

### Requirement: ロググループの削除ポリシー
ロググループにはスタック削除時の削除ポリシーを明示的に設定しなければならない（SHALL）。サンドボックス環境ではスタック削除時にロググループも削除される。

#### Scenario: サンドボックス環境の削除
- **WHEN** `npx ampx sandbox delete` でサンドボックス環境を削除する
- **THEN** ロググループも一緒に削除され、不要なリソースが残らない
