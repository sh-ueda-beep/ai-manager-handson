## 1. ロググループの作成と Lambda への設定

- [x] 1.1 `amplify/functions/pptx-parse/resource.ts` に `aws-cdk-lib/aws-logs` の `LogGroup` をインポートし、`/ai-manager/pptx-parse` の名前でロググループを作成する
- [x] 1.2 作成した `LogGroup` を `DockerImageFunction` の `logGroup` プロパティに設定する
- [x] 1.3 保持期間を `RetentionDays.ONE_MONTH`、削除ポリシーを `RemovalPolicy.DESTROY` に設定する

## 2. 動作確認

- [x] 2.1 `npx ampx sandbox` でデプロイし、CloudWatch コンソールで `/ai-manager/pptx-parse` ロググループが作成されていることを確認する
- [x] 2.2 PPTX ファイルをアップロードして Lambda を実行し、ログが `/ai-manager/pptx-parse` に出力されることを確認する
