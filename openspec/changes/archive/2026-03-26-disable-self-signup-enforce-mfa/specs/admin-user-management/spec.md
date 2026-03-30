## ADDED Requirements

### Requirement: 自己サインアップの無効化
システムは自己サインアップ（セルフサービスでのアカウント登録）を無効化しなければならない（SHALL）。Cognito UserPool の `adminCreateUserConfig.allowAdminCreateUserOnly` を `true` に設定する。

#### Scenario: 未認証ユーザーがサインアップを試みる
- **WHEN** 未認証ユーザーが Cognito SignUp API を直接呼び出す
- **THEN** Cognito が `NotAuthorizedException` を返し、アカウントは作成されない

#### Scenario: フロントエンドにサインアップUIが表示されない
- **WHEN** 未認証ユーザーがログイン画面にアクセスする
- **THEN** Authenticator コンポーネントにサインアップタブ/リンクが表示されず、サインインフォームのみが表示される

### Requirement: TOTP MFA の必須化
システムはすべてのユーザーに対して TOTP（Time-based One-Time Password）による多要素認証を必須としなければならない（SHALL）。`defineAuth` の `multifactor.mode` を `REQUIRED`、`multifactor.totp` を `true` に設定する。

#### Scenario: 新規ユーザーの初回ログイン時にTOTPセットアップが求められる
- **WHEN** 管理者が作成したユーザーが初回ログインし仮パスワードを変更した後
- **THEN** TOTP セットアップ画面（QRコード + 確認コード入力）が表示され、セットアップを完了するまでアプリにアクセスできない

#### Scenario: TOTP登録済みユーザーのログイン
- **WHEN** TOTP セットアップ済みのユーザーがメールアドレスとパスワードでサインインする
- **THEN** TOTP コードの入力を求められ、正しいコードを入力するとアプリにアクセスできる

#### Scenario: 誤ったTOTPコードの入力
- **WHEN** ユーザーが誤った TOTP コードを入力する
- **THEN** 認証が失敗し、再度コード入力を求められる

### Requirement: ゲストアクセスの無効化
システムは未認証（ゲスト）の Identity Pool アクセスを無効化しなければならない（SHALL）。`cfnIdentityPool.allowUnauthenticatedIdentities` を `false` に設定する。

#### Scenario: 未認証状態でのAWSリソースアクセス
- **WHEN** 未認証のクライアントが Identity Pool から認証情報を取得しようとする
- **THEN** アクセスが拒否され、AWS リソースへのアクセスができない

### Requirement: 管理者によるユーザー作成
ユーザーアカウントの作成は AWS 管理者のみが実施できなければならない（SHALL）。管理者は AWS マネジメントコンソールまたは AWS CLI の `admin-create-user` コマンドを使用してユーザーを作成する。

#### Scenario: 管理者がコンソールからユーザーを作成する
- **WHEN** AWS 管理者が Cognito コンソールからメールアドレスを指定してユーザーを作成する
- **THEN** 指定されたメールアドレスに仮パスワードを含む招待メールが送信される

#### Scenario: 管理者がCLIからユーザーを作成する
- **WHEN** AWS 管理者が `aws cognito-idp admin-create-user` コマンドを実行する
- **THEN** ユーザーが作成され、仮パスワードを含む招待メールが送信される

### Requirement: 初回ログイン時の仮パスワード変更
管理者が作成したユーザーは初回ログイン時に仮パスワードを変更しなければならない（SHALL）。これは Cognito の `FORCE_CHANGE_PASSWORD` ステータスにより自動的に強制される。

#### Scenario: 仮パスワードでの初回ログイン
- **WHEN** ユーザーが招待メールの仮パスワードで初回ログインする
- **THEN** 新しいパスワードの設定画面が表示され、新パスワードを設定するまでアプリにアクセスできない

#### Scenario: パスワード変更後のTOTPセットアップへの遷移
- **WHEN** ユーザーが新しいパスワードを設定完了する
- **THEN** 続けて TOTP セットアップ画面に遷移する
