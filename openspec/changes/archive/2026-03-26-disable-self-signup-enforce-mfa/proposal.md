## Why

現在のCognito設定（`defineAuth({ loginWith: { email: true } })`）では、誰でも自己サインアップでアカウントを作成できる状態にある。AI Managerは社内・組織内向けツールであり、不特定多数のユーザーが自由にアカウントを作成できるのはセキュリティリスクとなる。管理者がユーザーを発行する運用に切り替え、MFAを必須化することでアクセス制御を強化する。

## What Changes

- **BREAKING**: 自己サインアップ（セルフサービス登録）を無効化。既存のサインアップUIフローは不要になる
- MFA（多要素認証）をTOTPベースで必須化
- ユーザー作成は管理者がAWSコンソールまたはCLIから行う運用に変更
- フロントエンドの認証UIを管理者発行フローに合わせて調整（初回ログイン時のパスワード変更・MFAセットアップ対応）

## Capabilities

### New Capabilities

- `admin-user-management`: 自己サインアップ無効化、管理者によるユーザー発行、MFA必須化に関するCognito認証設定の仕様

### Modified Capabilities

（既存specsの要件レベルの変更なし。pptx-upload/pptx-parse/pptx-reviewは認証トークンの取得方法に依存するが、JWT認証の仕組み自体は変わらないため影響なし）

## Impact

- `amplify/auth/resource.ts`: defineAuthの設定変更（selfSignUp無効化、MFA設定追加）
- フロントエンド認証UI: `@aws-amplify/ui-react`のAuthenticatorコンポーネントの挙動変更（サインアップタブ非表示、MFAセットアップ画面の追加）
- 運用: ユーザー追加はAWSマネジメントコンソールまたはAWS CLIの`admin-create-user`で実施
- 既存ユーザー: デプロイ後、次回ログイン時にMFAセットアップが求められる
