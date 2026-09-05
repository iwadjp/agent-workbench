# Agent Workbench — プロジェクト一覧+詳細画面 実装仕様(Round3改・最終案)

PC幅を優先。モバイル対応は今回の実装対象外。

参照モック: `final_design.html`(操作可能、モックデータ) / 選択ログ: `preferences.md`

## 画面構成(上から順)

1. **次に再開するカード列**(3枚横並び): repo名 / 「N日放置・status」の一行理由 / 「▶再開」ボタン。
   選定ロジック: status が active または dogfooding で、放置日数が大きい順に上位3件。abandoned/released/paused は対象外。
2. **要対応統計行**(条件付き表示):
   - dirty / untracked / abandoned の件数のみバッジ表示。0件の項目は個別に非表示。
   - 3項目すべてが0件なら、この行自体を非表示(トグルリンクも出さない)。
   - 1件以上あるときのみ右端に「詳細統計」リンクを表示。クリックで repos/clean/dirty/untracked/active/dogfooding/paused/released の全8項目をグリッド展開(デフォルト閉)。
3. **分割ビュー**(画面高さいっぱい、左右独立スクロール):
   - 左ペイン(幅約38%): repo一覧。デフォルトソートは放置日数の降順。
   - 右ペイン(残り幅): 選択中repoの詳細。未選択時は空状態メッセージ。

## 一覧行(左ペイン)の要素

repo名 / target バッジ / 放置日数の色分けドット(赤:14日以上, 橙:5〜13日, 緑:4日以下) / status / git状態 / 「▶再開」ボタン(行右端、詳細を開かずに単独で起動可能)。行クリック(ボタン以外)で右ペインの詳細を切り替える。

## 詳細ペイン(右)の構造

固定ヘッダー・固定要約・3タブの3層構成。ヘッダーと要約はタブを切り替えても常に表示され続ける。

### 固定ヘッダー
repo名 / target・status・branch / 「▶セッション再開」ボタン(常時表示、スクロールしても隠れない)。

### 固定要約
- Freshness: 最終スキャン日時 + 相対時間 + 「再スキャン」リンク(放置日数5日以上は赤字強調)
- Latest commit: commit hash + メッセージ
- Next action
- 保存された作業コンテキスト要約: 保存日時 / 鮮度 / 現在地 / 保存時の最後の作業(4項目を1行のグリッドで表示)

### タブ1: Resume
- Development sessionカード: 起動プリセット名、Claude Code / Codex それぞれの agent バッジ・起動コマンド・cwd
- 「Development sessionを開始」(主ボタン) / 「VS Codeだけ開く」(副ボタン)
- 注意書き2行(Workspace Trust等の案内 / 起動済みprocess検出不可の警告)
- Handoffカード: Handoff purpose セレクト、「Copy AI Handoff」ボタン
- Contextカード: Current focus / Blockers・notes / Last handoff notes(固定要約より詳しい全文)
- よく使うコマンドカード: Dev server・Start・Open VSCode・Git status・README由来のDocコマンド群。各行にCopyボタン
- Project status & noteカード: status セレクト、note テキストエリア、保存ボタン、最終更新日時

### タブ2: Documents
- PROGRESS / README 切り替えボタン
- Markdown / Plain text 切り替えボタン
- 文書本文(pre + white-space:pre-wrap でペイン幅に折り返し表示。長文でも横スクロールなしで読める)

### タブ3: Diagnostics
- Repositoryカード: パス(コピー可)、target、branch、latest commit、latest tags、remote状態
- Scanカード: 「Rescan project」ボタン、スキャン診断(折りたたみ、git status/log/branch/probe/tags/remote/progress/exists/.git/readme の各所要時間)
- Development session settingsカード: Preset ID / Target ID / Path(各コピー可)、「project設定ひな形をコピー」「設定ファイルをVS Codeで開く」「設定を再読み込み」ボタン

## 現行機能 → 新配置 対応表

| 現行の要素 | 新しい配置 |
|---|---|
| repo基本情報(target/status/branch) | 固定ヘッダー |
| latest commit | 固定要約 + Diagnosticsタブ(再掲) |
| latest tags | Diagnosticsタブ |
| remote | Diagnosticsタブ |
| Rescan project / scan diagnostics | Diagnosticsタブ |
| Development session / Claude Code・Codex設定 | Resumeタブ |
| Development sessionを開始 / VS Codeだけ開く | Resumeタブ(固定ヘッダーにも簡易版ボタンあり) |
| 保存された作業コンテキスト(保存日時/保存時HEAD/鮮度/現在地/保存時の最後の作業) | 固定要約(4項目の要約) + Resumeタブ Context(全文) |
| Handoff purpose / Copy AI Handoff | Resumeタブ |
| Documents(PROGRESS/README, Markdown/Plain text) | Documentsタブ |
| Context(Current focus/Blockers/Last handoff notes/コマンド群/Project status & note) | Resumeタブ |
| Diagnostics(repository path/branch/tags/remote/scan/session settings) | Diagnosticsタブ |

## 実装時に既存データから決める必要がある項目

- 「要対応」件数 = dirty数 + untracked数 + abandoned数(既存の統計値から算出可能、新規データ不要)
- 「次に再開する」候補の並び順ロジックは上記の通り固定。件数(3件)は変更可能だがRound3では3件で確定。
- 再スキャンボタンは既存の「再スキャン」全体実行ではなく、該当repo単体のスキャンを想定(要確認)。単体スキャンがない場合は全体再スキャンで代用可。

## モックとの差分(実装時に置き換える箇所)

- 「▶再開」「再スキャン」「VS Codeだけ開く」「設定ファイルをVS Codeで開く」「設定を再読み込み」のトースト表示 → 実際の処理呼び出しに置き換える。
- 「Copy AI Handoff」「Copy」ボタン → 実データを整形してクリップボードに書き込む処理に置き換える(モックは固定文言のトーストのみ)。
- Project status & note の保存ボタン → 実際の永続化処理に置き換える。
- Documents タブの本文 → 実ファイル(PROGRESS.md / README.md)の読み込みに置き換える。
- サンプルの10件データ → 実データ(25 repos)に置き換える。
- `#demo-zero` チェックボックスは確認用のみ。実装には含めない。

## 変更しないもの

複数targetのrepo一覧、Git状態、放置日数、PROGRESS、Agent context、Development session の各データ・機能は今回のGUI変更で削除・変更しない(表示位置と表示条件のみ変更)。
