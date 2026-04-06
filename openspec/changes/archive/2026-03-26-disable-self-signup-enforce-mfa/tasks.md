## 1. バックエンド認証設定

- [x] 1.1 `amplify/auth/resource.ts` に `multifactor: { mode: 'REQUIRED', totp: true }` を追加する
- [x] 1.2 `amplify/backend.ts` で `cfnUserPool.adminCreateUserConfig = { allowAdminCreateUserOnly: true }` を設定する
- [x] 1.3 `amplify/backend.ts` で `cfnIdentityPool.allowUnauthenticatedIdentities = false` を設定する

## 2. フロントエンド認証UI

- [x] 2.1 Authenticator コンポーネントに `hideSignUp` プロパティを追加する（`src/main.tsx` または Authenticator を使用している箇所）

## 3. 動作確認

- [x] 3.1 `npx ampx sandbox` でサンドボックスにデプロイし、Cognito UserPool の設定を確認する（自己サインアップ無効、MFA必須）
- [x] 3.2 AWS CLI で `admin-create-user` を実行してテストユーザーを作成し、招待メールが届くことを確認する
- [x] 3.3 仮パスワードでログインし、パスワード変更 → TOTP セットアップ → ログイン完了の一連のフローを確認する
- [x] 3.4 ログイン画面にサインアップタブ/リンクが表示されないことを確認する
