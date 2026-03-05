---
name: handson-record
description: ハンズオンのステップを記録する。git差分の自動検出、テンプレートからのステップファイル生成、索引の更新を行う。
license: MIT
metadata:
  author: ai-manager
  version: "1.0"
---

直近の作業内容をハンズオンのステップとして記録する。git差分を自動検出し、テンプレートからステップファイルを生成する。

---

## 動作フロー

### 1. 直近の変更を自動検出

```bash
git diff --stat HEAD~1 2>/dev/null || git diff --stat
```

```bash
git log --oneline -3 2>/dev/null || echo "コミット履歴なし"
```

```bash
git rev-parse --short HEAD 2>/dev/null || echo "unknown"
```

### 2. 次のステップ番号を算出

`handson/steps/` ディレクトリ内の既存ファイル数をカウントし、次の番号を決定する。

```bash
ls handson/steps/step-*.md 2>/dev/null | wc -l
```

次のステップ番号 = 既存ファイル数 + 1

### 3. ユーザーにタイトルとゴールを確認

引数でタイトルが渡された場合はそれを使用する。渡されていない場合は AskUserQuestion で確認する。

AskUserQuestion で以下を確認：
- **タイトル**: このステップのタイトル（例：「OpenSpecの初期化」）
- **ゴール**: このステップで達成すること
- **タグ**: 関連するタグ（カンマ区切り、例：setup, openspec）

### 4. ステップファイルを生成

ファイル名: `handson/steps/step-{番号:02d}-{slug}.md`

slug はタイトルからケバブケースで生成する（日本語の場合はローマ字または英語に変換）。

以下のテンプレートを使用：

```markdown
---
step: {番号}
title: "{タイトル}"
slug: {slug}
status: draft
created: "{ISO 8601形式の現在日時+09:00}"
git_ref: "{直近のコミットハッシュ}"
prerequisites: [{前のステップ番号があれば}]
tags: [{タグリスト}]
---

## ゴール
{ユーザーが指定したゴール}

## 背景
{なぜこのステップが必要かを、git差分やコンテキストから推測して記述}

## 手順
{git差分やログから推測した手順を記述}

## 変更されたファイル
| ファイル | 変更内容 |
|---|---|
{git diff --stat の結果をテーブル形式で記載}

## 確認方法
- [ ] {検証項目}

## ポイント
{注意点やTips}

## Git差分サマリー
{git diff --stat の出力}
```

### 5. `_index.yaml` を更新

`handson/_index.yaml` の `steps` 配列に新しいエントリを追加：

```yaml
steps:
  - step: {番号}
    title: "{タイトル}"
    slug: "{slug}"
    file: "steps/step-{番号:02d}-{slug}.md"
    status: draft
    created: "{日時}"
```

### 6. 確認メッセージを表示

```
## ステップ {番号} を記録しました

- ファイル: `handson/steps/step-{番号:02d}-{slug}.md`
- タイトル: {タイトル}
- ステータス: draft

内容を確認・編集してください。ステータスを `review` → `final` に更新することで完成となります。

全ステップの一覧は `/handson:list` で確認できます。
```

---

## ガードレール

- 既存のステップファイルを上書きしない。同じ番号が既に存在する場合はエラーを表示する
- `_index.yaml` の整合性を保つ。ファイルが存在しない場合は初期化する
- すべてのテキストは**日本語**で記述する
- タイムゾーンは `+09:00`（JST）を使用する
