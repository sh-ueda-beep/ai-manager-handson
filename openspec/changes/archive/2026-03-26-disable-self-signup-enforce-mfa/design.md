## Context

現在の認証設定は `defineAuth({ loginWith: { email: true } })` のみで、自己サインアップが有効・MFA未設定・ゲストアクセスがデフォルト有効の状態。Amplify Gen2では `defineAuth` の宣言的APIでMFA設定が可能だが、自己サインアップの無効化は `defineAuth` の直接オプションとしては提供されていないため、CDK L1 override（`cfnUserPool`）で設定する必要がある。

## Goals / Non-Goals

**Goals:**
- 自己サインアップを無効化し、管理者のみがユーザーを作成できるようにする
- TOTP MFAを必須化する
- ゲストアクセス（未認証ID）を無効化する
- フロントエンドのAuthenticator UIからサインアップタブを非表示にする

**Non-Goals:**
- 管理者用のユーザー管理画面の実装（AWSコンソール/CLIで運用）
- SMS MFAの対応（TOTPのみ）
- 招待メールテンプレートのカスタマイズ（デフォルトのまま）
- 既存ユーザーの一括MFA登録スクリプト

## Decisions

### 1. 自己サインアップの無効化方法

**決定**: `backend.ts` で CfnUserPool の L1 override を使用

```ts
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
};
```

**理由**: `defineAuth` には自己サインアップを無効化するオプションがない。Amplify Gen2の公式パターンとして `cfnResources` 経由の CDK override が推奨されている（Usernames設定やGuest access無効化と同じアプローチ）。

**代替案**: Lambda Trigger の Pre Sign-up で拒否する → 不必要に複雑で、CfnUserPoolの設定で十分。

### 2. MFA設定

**決定**: `defineAuth` の `multifactor` オプションで TOTP を `REQUIRED` に設定

```ts
export const auth = defineAuth({
  loginWith: { email: true },
  multifactor: {
    mode: 'REQUIRED',
    totp: true,
  },
});
```

**理由**: `defineAuth` が宣言的にMFA設定をサポートしており、CDK overrideは不要。`REQUIRED` にすることで全ユーザーにMFAを強制できる。TOTPはSMSより安全で、コストもかからない。

**代替案**: `OPTIONAL` + フロントエンドで強制 → ユーザーがバイパスできるリスクがあるため `REQUIRED` が適切。

### 3. ゲストアクセスの無効化

**決定**: `backend.ts` で CfnIdentityPool の override を使用

```ts
const { cfnIdentityPool } = backend.auth.resources.cfnResources;
cfnIdentityPool.allowUnauthenticatedIdentities = false;
```

**理由**: Amplify Gen2はデフォルトでゲストアクセスが有効。管理者発行ユーザーのみにアクセスを限定するため無効化する。公式ドキュメントに記載のパターン。

### 4. フロントエンド認証UI

**決定**: `@aws-amplify/ui-react` の Authenticator コンポーネントに `hideSignUp` を設定

```tsx
<Authenticator hideSignUp>
  {/* ... */}
</Authenticator>
```

**理由**: バックエンドで自己サインアップを無効化しても、UIにサインアップフォームが表示されるとユーザーが混乱する。`hideSignUp` でサインアップタブを非表示にする。MFAセットアップ画面（QRコード表示）は Authenticator が自動的にハンドリングする。

## Risks / Trade-offs

- **既存ユーザーへの影響**: MFAを `REQUIRED` に変更すると、既存ユーザーは次回ログイン時にTOTPセットアップを求められる → Authenticatorコンポーネントがセットアップフローを自動表示するため、追加実装は不要
- **管理者の運用負荷**: ユーザー追加がAWSコンソール/CLI操作になる → 現時点ではユーザー数が限定的なため許容範囲。将来必要に応じて管理画面を検討
- **ロックアウトリスク**: TOTP デバイスを紛失した場合の復旧手段 → AWS管理者がコンソールからMFAをリセット可能（`admin-set-user-mfa-preference`）

## Migration Plan

1. `amplify/auth/resource.ts` を更新（MFA設定追加）
2. `amplify/backend.ts` を更新（自己サインアップ無効化 + ゲストアクセス無効化）
3. フロントエンドの Authenticator に `hideSignUp` を追加
4. `amplify sandbox` でサンドボックス環境に適用・動作確認
5. 本番デプロイ

**ロールバック**: git revert でコード変更を戻し、再デプロイすれば元の設定に復元可能。Cognitoの設定変更は破壊的ではなく、既存ユーザーデータには影響しない。

## Open Questions

なし — Amplify Gen2の公式パターンで実現可能な範囲の変更。
