## Why

現在、Lambda関数のCloudWatchロググループ名はCDKが自動生成するため、`/aws/lambda/amplify-xxx-PptxParseFn-abc123` のようなランダムなハッシュ付きの名前になる。CloudWatchコンソールでのログ検索・監視が困難で、どのシステムのどの機能のログか一目で判別できない。ロググループ名にシステム識別子 `ai-manager` を含む明示的な命名を行い、運用時の可視性を向上させる。

## What Changes

- Lambda関数（`PptxParseFn`）に明示的なロググループを作成・指定し、`/ai-manager/pptx-parse` の名前にする
- ロググループの保持期間を明示的に設定する

## Capabilities

### New Capabilities

- `log-group-naming`: CloudWatch ロググループに対するシステム識別子付きの命名規則と設定の仕様

### Modified Capabilities

（既存specsの要件レベルの変更なし）

## Impact

- `amplify/functions/pptx-parse/resource.ts`: Lambda に `logGroup` プロパティを追加
- `amplify/backend.ts`: 必要に応じてロググループの CDK リソースを追加
- 既存のロググループ: デプロイ後、新しい名前のロググループが作成される（旧ロググループは手動削除が必要）
