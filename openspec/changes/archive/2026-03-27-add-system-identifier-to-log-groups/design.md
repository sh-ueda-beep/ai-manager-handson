## Context

現在 Lambda 関数（`PptxParseFn`）は `logGroup` 未指定のため、CloudWatch ロググループ名が `/aws/lambda/<自動生成関数名>` となりランダムなハッシュが含まれる。CDK の `DockerImageFunction` は `logGroup` プロパティで事前に作成した `LogGroup` を指定できる。

## Goals / Non-Goals

**Goals:**
- Lambda 関数のロググループ名を `/ai-manager/pptx-parse` に明示的に設定する
- ロググループの保持期間を明示的に設定する（デフォルトは無期限保持）

**Non-Goals:**
- AgentCore Runtime のログ設定（AgentCore Runtime は現時点でカスタムロググループを指定するインターフェースがない）
- ログのフォーマット変更やフィルタリング設定
- CloudWatch アラームの設定

## Decisions

### 1. LogGroup の作成方法

**決定**: CDK の `aws_logs.LogGroup` を `pptx-parse/resource.ts` 内で作成し、Lambda の `logGroup` プロパティに渡す

```ts
import * as logs from 'aws-cdk-lib/aws-logs';

const logGroup = new logs.LogGroup(stack, 'PptxParseLogGroup', {
  logGroupName: '/ai-manager/pptx-parse',
  retention: logs.RetentionDays.ONE_MONTH,
  removalPolicy: RemovalPolicy.DESTROY,
});

const pptxParseFn = new lambda.DockerImageFunction(stack, 'PptxParseFn', {
  // ...既存設定
  logGroup,
});
```

**理由**: CDK の `logGroup` プロパティは Lambda がログ送信先として使用する LogGroup を完全にカスタマイズできる公式サポート機能。`logRetention` は旧APIであり、`logGroup` の使用が推奨されている。

### 2. 命名規則

**決定**: `/<システム識別子>/<機能名>` の形式

- Lambda: `/ai-manager/pptx-parse`

**理由**: AWS のロググループ命名のベストプラクティスに従い、`/` で階層化することで CloudWatch コンソールでのフィルタリングが容易になる。

### 3. 保持期間

**決定**: 1ヶ月（`RetentionDays.ONE_MONTH`）

**理由**: 開発段階では長期保持は不要。本番運用開始時に必要に応じて延長する。

### 4. 削除ポリシー

**決定**: `RemovalPolicy.DESTROY`

**理由**: サンドボックス環境の削除時にロググループも一緒にクリーンアップされるようにする。本番環境では `RETAIN` に変更することを検討。

## Risks / Trade-offs

- **既存ログの喪失**: 新しいロググループへの切り替え後、旧ロググループのログは残るが新しいロググループには引き継がれない → 開発段階のため問題なし
- **AgentCore**: AgentCore Runtime のロググループ名はカスタマイズ不可 → 将来のAPI更新で対応を検討
