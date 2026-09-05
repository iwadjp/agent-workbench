# agent-workbench

ローカルの個人開発リポジトリを一覧し、各プロジェクトの状態を1画面で確認するためのローカルWebダッシュボード。

## 目的

`sample-workspace` 配下に増えてきた git リポジトリについて、

- どれが dirty / clean か
- 最新コミットはいつ・何か
- PROGRESS.md の直近の記録
- 手動で付けたステータス（active / paused など）

を毎回 `cd` + `git status` せずにブラウザで一覧確認する。

## External dogfood quick start（最小外部dogfood）

Use this local workbench to see what is happening across your own software projects, choose the next project to handle, and resume it with saved context. The minimal flow does not require any existing local data and does not upload project contents.

This repository is an early external dogfood release for developers operating multiple AI-assisted software projects. It is a localhost-only, source-available tool distributed under the PolyForm Noncommercial License 1.0.0. Commercial use is not currently permitted under these terms. Development Session and other environment-dependent launcher features are optional and are not required for the first dogfood flow.

1. Install Node.js 18+ and Git, then install dependencies:

   ```powershell
   cd path\to\agent-workbench
   npm install
   ```

2. Create your local project-root configuration from the sanitized example:

   ```powershell
   Copy-Item config\roots.example.json config\roots.local.json
   ```

   Open `config\roots.local.json` and replace the enabled example path(s) with real paths on your machine. Start with one or more `repo-directories` targets, or enable a `single-repo` target for one project. Keep `roots.local.json` local; it is ignored by Git.

3. Start the workbench and open the local URL:

   ```powershell
   npm start
   ```

   Open `http://localhost:37891/` in a browser. Keep the default localhost binding for local dogfooding.

4. Run the first scan and use the portfolio view. The overview reads each configured project’s Git state, branch/latest commit, README/PROGRESS signals, and saved context. `Project Signals` summarizes cross-project attention; `Action Queue` groups the next operational items as `Now`, `Watching`, or `Waiting`.

5. Select a project and open its detail view. Review the live project status and `Resume summary`, then save context from the context section when you want the current work state to persist locally.

6. Use `Copy AI Handoff` on the project detail view to copy the structured project status, relevant signals, saved context, and next action into a coding-agent conversation. This is a copy/paste handoff; no AI API integration is required.

The external dogfood boundary intentionally stops at project overview, signals, action queue, project detail, saved context, and AI handoff. Development Session and IDE/agent launch settings remain optional local features.

## インストール

```powershell
cd agent-workbench
npm install
```

前提: Node.js（v18以上推奨）と git がPATHにあること。

## 起動

```powershell
npm start        # 通常起動
npm run dev      # ファイル変更で自動再起動（node --watch）
```

起動後、ブラウザで http://localhost:37891 を開く。

- ポートは環境変数 `AGENT_WORKBENCH_PORT`（または従来どおり `PORT`）で変更可能
- スキャン対象は環境変数 `SCAN_ROOT` で変更可能
- **デフォルトは `127.0.0.1`（localhost限定）でbindする。** LANの他端末から
  アクセスしたい場合は下記「LANアクセス」を参照

## LANアクセス（同一LAN内の他端末から開く）

デフォルトでは `127.0.0.1`（自分のPCからのみ）にbindしており、これが
**MacBook等の他端末から`http://<PCのIPアドレス>:37891/`にアクセスできない**
一番の理由になっている（Firewallの問題ではなく、そもそもそのネットワーク
インターフェースでlistenしていない）。LANアクセスしたい場合だけ、環境変数
`AGENT_WORKBENCH_HOST=0.0.0.0` を明示的に指定して起動する。
**デフォルトの挙動は変えていない**（明示指定しない限り従来どおり`127.0.0.1`）。

### 起動方法

コマンドプロンプト:

```bat
set AGENT_WORKBENCH_HOST=0.0.0.0
set AGENT_WORKBENCH_PORT=37891
npm start
```

PowerShell:

```powershell
$env:AGENT_WORKBENCH_HOST="0.0.0.0"
$env:AGENT_WORKBENCH_PORT="37891"
npm start
```

起動後、ログに `listening on 0.0.0.0:37891 (LAN accessible — trusted networks only, no auth)`
と表示されればLAN側からのアクセスを受け付けている。同一LAN内の他端末から
`http://<このPCのIPアドレス>:37891/`（例: `http://192.168.3.44:37891/`）で開ける。

### listen状態の確認

```powershell
netstat -ano | findstr :37891
```

`0.0.0.0:37891` や `<PCのIPアドレス>:37891` が `LISTENING` で表示されていれば
LAN側でも待ち受けている。`127.0.0.1:37891`のみの場合はまだlocalhost限定のまま。

### Windows Firewallについて

- Windows Defender Firewall が Node.js の受信接続をブロックする場合がある
- 初回アクセス時に「プライベートネットワークでの許可」を求めるダイアログが
  出ることがあるため、その場合は許可する
- 会社・公共Wi-Fi等の信頼できないネットワークでは開けない運用を推奨する
  （**Windows Firewallの設定はagent-workbenchが自動変更することはない**。
  必要な許可はユーザー自身がOS側で行う）

### セキュリティ上の注意

- agent-workbenchには**認証機能がない**。LAN公開（`0.0.0.0` bind）時は、
  同一LAN内の誰でもアクセス・status/note保存・Agent context編集ができる状態になる
- token・secretの類は不要だが、**信頼できる自宅LAN等でのみ**LANアクセスを
  有効にすること。公共Wi-Fi、会社ネットワーク、外部インターネットへ直接公開しない
- PWAとしてホーム画面へ追加しても認証や通信保護は追加されない。ホーム画面追加は
  接続の安全性を高める機能ではない
- ブラウザから任意command/args/cwdを保存・送信するAPIはない。一方、Development
  session launcherでは、**PC上のローカル設定に事前登録したitemをLANクライアントから
  起動できる**。そのため、`0.0.0.0` bindは信頼できる自宅LANだけで使用し、設定には
  API key、token、password等のsecretを書かない
- 任意URL fetch/proxy、任意editor、process停止、Windows Firewall変更は行わない

## スキャン対象の設定（Phase 2-B）

スキャン対象は設定ファイルで定義する。**実パスを含む設定は git 管理しない。**

### セットアップ

```powershell
Copy-Item config\roots.example.json config\roots.local.json
# roots.local.json を自分の環境に合わせて編集
```

- `config/roots.example.json` — git管理されるサンプル（個人パスを含めない）
- `config/roots.local.json` — 実際に使うローカル設定。**git管理しない**（.gitignore済み）
- `config/roots.json` — 旧形式の互換fallback。今後は使わず `roots.local.json` を推奨
  （こちらも .gitignore 済み）

読み込み優先順位: `roots.local.json` → `roots.json` → 内蔵デフォルト。
使用中の設定は画面フッターに `Config: roots.local.json` のように表示され、
どれも無い場合は default（設定未作成）である旨が赤字で表示される。

### スキャン状況の確認（Phase 2-D）

- ヘッダに全体のスキャン時間を表示: `Last scanned: yyyy-mm-dd hh:mm:ss / 1.2s`
- サマリー下の **Targets 行**に target別の状況を表示:
  `sample-workspace ok 3 projects 0.9s` / `wsl-workspace ok 1 project 0.1s` / `wsl-ubuntu disabled`
  - missing / error は赤、3秒以上は slow（黄）、10秒以上は very slow（赤太字）
- APIレスポンスの `scanSummary` に startedAt / finishedAt / durationMs と
  target別の projectCount / repoCount / noGitCount / errorCount /
  slowProjectCount / verySlowProjectCount / durationMs / status が入る

### repo単位のスキャン診断（Phase 2-F）

- 各projectに `scanDurationMs` / `scanSpeed`（normal | slow | very-slow）/
  `scanSteps`（git status / log / branch / tags / progress / exists / readme の各所要時間）が入る
- 目安: **3秒以上で slow、10秒以上で very slow**
- slow な repo は一覧の git バッジ横に `5.9s` のような小さな表示が出る（normal時は非表示）
- 詳細展開の「スキャン診断」ブロックで total とステップ別内訳を確認できる。
  WSL2 / UNC target が遅いとき、**どの repo のどの処理（git status か PROGRESS読み込みか等）が
  遅いのか**をここで特定する
- 常用時に重い target は `enabled: false` にしておき、必要な時だけ有効化する運用を推奨

### target の readdir 計測（Phase 2-G）

repo-directories target では、**repo内の git 処理よりも target直下のディレクトリ列挙
（readdir）が遅い場合がある**。特に WSL2 / UNC パスではここが主なボトルネックになりうる。

`scanSummary.targets` の各 repo-directories target に以下が入る
（single-repo / disabled は null）:

- `readdirMs` — target直下の列挙＋repo候補抽出の時間
- `readdirSpeed` — normal / slow(3秒以上) / very-slow(10秒以上)
- `childCandidateCount` — repo候補として見た直下ディレクトリ数
- `repoScanMs` — 各repoスキャン（並列実行）の実経過時間
- `repoScanTotalMs` — 各projectの scanDurationMs の単純合計
  （並列実行のため repoScanMs より大きくなりうる）
- `overheadMs` — `durationMs - readdirMs - repoScanMs`（設定処理等の残り時間）

UIでは Targets 行に `readdir 5.7s slow` のように表示される
（500ms未満はノイズなので省略。slow / very slow は色付きで強調）。
readdir が遅い target は `enabled: false` にしておき、必要な時だけ有効化する運用を推奨。

### remote tracking status（Phase 3-A）

target に `"remoteStatus": true` を付けると、その target の git repo だけ
remote tracking status（ahead / behind 等）を取得する。

```json
{ "id": "public_projects", "label": "public projects",
  "path": "D:\\path\\to\\public-projects",
  "type": "repo-directories", "enabled": true, "remoteStatus": true }
```

- **push / pull が必要になる public 系 target で使う想定**。
  private / WSL2 / workspace-root（上位管理repo）では通常無効でよい
- 無効な target では remote 確認の git コマンド自体を実行しない（時間も増えない）
- **git fetch は行わない**。ローカルの tracking 情報だけで ahead / behind を判定するため、
  **正確な behind を知りたい場合は別途手動で `git fetch` しておく必要がある**
- status の種類: up-to-date / ahead / behind / diverged / no-upstream / no-remote /
  unknown / error（無効targetは disabled）
- 一覧では git バッジ横に `sync` / `ahead 1` / `behind 2` / `div 1/2` 等の小バッジ、
  Targets 行には `remote ahead:2 no-upstream:3` のような集計が出る
- **originUrl は一覧には出さず、詳細欄にのみ表示**する

### remote status フィルタ（Phase 3-C）

ツールバーの `remote:` セレクトで、一覧を remote 状態で絞り込める
（他の git / status / PROGRESS / target フィルタと AND 条件）:

- `no-remote` — **origin 未設定 repo の棚卸し**に使う
- `ahead` / `behind` / `diverged` / `error` — push / pull 等の対応が必要な repo の確認
- `attention` — 上記4状態（remote上の要注意状態）をまとめて絞る。
  no-remote は件数が多くなりがちなので attention には含めない
- `enabledのみ` / `up-to-date` / `no-upstream` / `disabled` も選択可
- 絞り込み結果は「N / M 件表示」に反映される（Targets 行の remote 集計は常に全体値）
- fetch は行わないため、**behind はローカルの tracking ref 基準**（正確には手動 fetch が必要）
- 選択状態は表示状態として保存・復元される（プリセットボタンを押すと all に戻る）

### no-remote 棚卸し（Phase 3-D 〜 3-F）

Phase 3-D / 3-E では、no-remote repo を分類するための手動フィールド
（`visibility` → `remotePlan`）を追加したが、検討の結果 **Phase 3-F で UI から外した**。

理由: このアプリでは既に以下が方針を示しており、手動フィールドは重複していた。

- **公開方針**: public / sample-workspace / private といった **フォルダ構成（target）自体**が表す
- **origin の有無・upstream 状態**: remote status（up-to-date / no-remote / no-upstream 等）が表す
- **開発状態**: manual status（active / paused / abandoned 等）が表す
- **例外や判断理由**: note に自由記述すればよい（分類UIより柔軟）

そのため、現在は **remote filter と note を中心に棚卸しする設計**に戻している。

- プリセット `No-remote audit` は `remote: no-remote` のrepoだけを一覧表示する
  （他のフィルタは全て all）。origin 未設定の repo をまず洗い出し、
  対応方針は各 repo の note に書き留める運用を想定
- `data/projects.json` に古い `visibility` / `remotePlan` フィールドが残っていても
  読み込みでは無視されるだけで、アプリは問題なく動作する（legacy/internal
  compatibility only。現在のUIはこれらのフィールドを表示・送信しない）

この機能は**記録のみ**。GitHub での origin 作成・公開操作・repo移動は行わない。

### スキャン履歴（Phase 2-H）

- スキャンのたびに要点（全体/target別の duration・readdirMs 等）を
  `data/scan-history.json` に自動追記する。**git管理しない**（.gitignore済み）
- **直近50件**まで保持し、古い履歴は自動削除される
- `GET /api/scan-history` で履歴と target別統計（last / min / max / avg duration、
  max readdir、slow回数、サンプル数）が取れる
- UIでは Targets 行の下の「Scan history」折りたたみ（初期は閉じる）で
  target別の `last / avg / min / max / max readdir / slow回数 / samples` を確認できる
- 用途: WSL2 / UNC target の**コールド/ウォーム差**の観測。
  「今回だけ遅い（max だけ大きい）」のか「常に遅い（avg も大きい）」のかを見分ける
- 履歴をリセットしたい場合は `data/scan-history.json` を削除する（削除UIは無し）

### target の type

- **`repo-directories`**: 指定パスの直下ディレクトリをそれぞれproject候補として見る。
  `.git` があれば repo、なければ no-git として一覧に出す
- **`single-repo`**: 指定パスそのものを1つのprojectとして見る。配下は再帰スキャンしない

### excludeNames（任意・Phase 3-B）

repo-directories target に `excludeNames` を指定すると、直下ディレクトリのうち
名前が完全一致するものを project 化しない（no-git としても表示しない。
git / README / PROGRESS / remote などのスキャンも一切行わない）。

```json
{ "id": "public_projects", "label": "public projects",
  "path": "D:\\path\\to\\public-projects",
  "type": "repo-directories", "enabled": true, "remoteStatus": true,
  "excludeNames": ["mixed_parent"] },
{ "id": "public_nested_repo", "label": "public / nested-repo",
  "path": "D:\\path\\to\\public-projects\\mixed_parent\\nested-repo",
  "type": "single-repo", "enabled": true, "remoteStatus": true }
```

**repo管理外の親フォルダの配下に実repoがある場合**（上の例の `mixed_parent/nested-repo`）は、
親フォルダを `excludeNames` で除外し、実repoを single-repo target として明示追加するのが推奨。

再帰スキャンではなく明示 single-repo を推奨する理由:

- 意図しない深いフォルダを拾わない
- repo管理外フォルダが no-git として一覧を汚さない
- 例外的な構造が設定ファイルに明示され、後から見て分かる

除外された件数は Targets 行に `excluded:1` と表示され、
`scanSummary.targets` の `excludedCount` / `excludedNames` でも確認できる。
single-repo target には excludeNames は適用されない。

### progressPath（任意・Phase 2-C）

target に `progressPath` を指定すると、repo直下の `PROGRESS.md` の代わりに
そのファイルを進捗抜粋として読む。

```json
{ "id": "workspace_root", "label": "workspace-root",
  "path": "D:\\path\\to\\workspace-root",
  "type": "single-repo", "enabled": false,
  "progressPath": "notes\\PROGRESS.md" }
```

- `progressPath` は **target の path からの相対パス**として解決される（絶対パスも可）
- **single-repo target で使う想定**。上位管理repoのように、進捗ファイルが
  repo直下ではなくサブフォルダにあるケース（例: `notes\PROGRESS.md`）に使う
- `repo-directories` の子repoには適用されず、従来どおり各子repo直下の `PROGRESS.md` を読む
- 指定パスが存在しない場合は詳細画面に `PROGRESS: missing` と警告を表示（アプリは落ちない）
- 詳細画面のPROGRESS見出し右に読込元（`default` / `custom <path>` / `missing`）を表示

### WSL2 target（Phase 2-D）

WSL2 側のプロジェクトも `\\wsl.localhost\<Distro>\...` のような UNCパスで指定できる（example参照）:

```json
{ "id": "wsl_projects", "label": "wsl projects",
  "path": "\\\\wsl.localhost\\<Distro>\\home\\<user>\\projects",
  "type": "repo-directories", "enabled": false }
```

注意:

- **ホーム直下を指定しない**こと。dot directory（.cache / .config 等）やツール設定まで
  拾って広すぎるため、Claude 配下や projects 配下など repo置き場に絞る
- WSL target の Git 情報は Windows Git で UNC を直接読まず、対象ディストリビューション内の
  Git を `wsl.exe -d <Distro> --exec git ...` で実行する。Windows target は従来どおり Windows Git を使う
- **最初は `enabled: false` で追加**し、必要な時だけ `enabled: true` にするのが安全
- `enabled: false` の target はスキャンされないが、画面の Targets 行に `disabled` として
  表示されるので、追加済みであることは確認できる
- 有効化後は Targets 行の targetごとの所要時間（3秒以上で slow、10秒以上で very slow 表示）
  を見て、常用に耐えるか判断する
- WSL 側 Git 自身が **dubious ownership** を返した場合だけ、詳細欄の「Git診断」に
  WSL 側 `safe.directory` の対処例を表示する（このツールが git config を変更することはない）:

  ```
  wsl.exe -d "<Distro>" --exec git config --global --add safe.directory "<Linux repo path>"
  ```

存在しないパスの target（未作成の置き場など）も、警告を消したい場合は
`enabled: false` にしておけばよい。

### この環境での実設定（roots.local.json）

| id | type | path |
|---|---|---|
| public_projects | repo-directories | `C:\workspaces\public-projects` |
| private_projects | repo-directories | `C:\workspaces\private-projects` |
| workspace_root | single-repo | `C:\workspaces` |

上位のworkspace rootは **single-repo として1件だけ**表示する。
配下に子repoがある場合でも、workspace root側からは列挙しない（重複防止）。

存在しないパスの扱い:

- single-repo のパスが無い場合: kind `missing` として一覧に赤色で表示
- repo-directories のルートが無い場合: 画面上部に設定警告バナーを表示（アプリは落ちない）
- 設定ファイルが無い/壊れている場合: 内蔵デフォルト（起動時のcurrent directory）で起動し、警告を表示

## 保存ファイル

手動ステータスとメモは `data/projects.json` に保存される（repo の絶対パスがキー）。

```json
{
  "C:\\workspaces\\example": {
    "status": "active",
    "note": "メモ",
    "updatedAt": "2026-07-06T00:00:00.000Z"
  }
}
```

ローカル絶対パスを含むため、このファイルは git 管理外（.gitignore 済み）。

## API

| Method | Path | 内容 |
|---|---|---|
| GET | `/api/projects` | repo一覧とgit情報（キャッシュあり）。各projectに`savedContext`（保存済みAgent contextの鮮度metadata。保存済みcontextが無ければ`null`）を含む |
| POST | `/api/rescan` | 全target・全projectを再スキャンして最新情報を返す |
| POST | `/api/projects/rescan-one` | `{ path, targetId? }` で指定した**1 projectだけ**再スキャン（Phase 4-E）。レスポンスに`rescanResult`（updated/unchanged/excluded/errors）を含む |
| POST | `/api/projects/open-vscode` | `{ path, targetId }` と現在のscan結果が完全一致するprojectをserver PCのVS Codeで開く |
| GET | `/api/projects/development-session` | scan済みprojectの識別情報とDevelopment session状態（configured / not-configured / target-id-mismatch / path-mismatch / invalid）を取得。`reload=1`で設定を再読込 |
| POST | `/api/projects/start-development-session` | `{ path, targetId, profileId, itemIds }`だけを受け、保存済みitemをVS Code Tasksで起動 |
| POST | `/api/development-sessions/open-config` | requestは空。固定path`data/development-sessions.json`だけをserver PCのVS Codeで開く |
| POST | `/api/development-sessions/register-preset` | `{ targetId, path, presetId }`だけを受け、version 2設定ファイルへproject参照を追記する。**localhostからのrequestだけ許可** |
| POST | `/api/projects/status` | `{ path, status, note }` を保存 |
| POST | `/api/projects/context` | `{ path, targetId?, agentContext, commandHints }` を保存（Phase 5-A） |
| GET | `/api/projects/detect-commands` | `?path=&targetId=` のrepoからcommand hints候補を検出（Phase 5-B。ファイル読み取りのみ、実行はしない） |
| GET | `/api/runtime/ping` | Runtime helper card専用。`127.0.0.1:8787/ping`への固定GETのみ（任意URL不可） |

## 個別project Rescan（Phase 4-E）

全体 `Rescan` は全target・全projectを再スキャンするため、WSL targetのような
遅いtargetが混ざっていると時間がかかる。1つのrepoだけcommitした／dirtyが
解消した／status・noteを確認したい、といった場面向けに、**1 projectだけ**
git/README/PROGRESS/remote情報を再取得できる機能を追加した。

- **詳細ペイン**の `Rescan project` ボタン、**一覧行**の `↻` ボタン（クリックすると
  詳細ペインが自動的に開く）の両方から実行できる
- サーバー側は `POST /api/projects/rescan-one` に `{ path, targetId }` を送る。
  **project の一意特定には絶対パス（`path`）を使う**（表示名は同名repoが複数target
  に存在しうるため使わない）。`targetId` を付けた場合はさらに一致確認し、
  一致しなければ409で拒否する（取り違え防止の二重チェック）
  - 実例: `private` targetの `inner-voice` と `wsl private` targetの `inner-voice`
    は同名だが絶対パスが異なるため、個別Rescanが正しい方だけを更新する
- 更新（再取得）される情報: gitStatus / modified・untracked件数 / latest commit /
  branch / tags / remote status / README冒頭抜粋とそのhash・更新日時 / PROGRESS末尾
  抜粋とそのhash・更新日時 / scan duration・speed / error・Git診断。**個別Rescanは
  常にファイルを再読込する**（キャッシュされた前回内容をそのまま返すことはない）
- **更新しない（対象外）情報**: 保存済みAgent context本文、Current focus / Next
  action / Blockers・notes（旧4フィールド）、manual status、manual note、
  command hints本文、選択中のHandoff purpose。これらはRescanでは一切書き換えず、
  保存済みAgent contextについては鮮度（`savedContext.freshness`）の再判定だけを行う
- レスポンスには `rescanResult`（`updated` / `unchanged` / `excluded` / `errors` /
  `readme.{reloaded,exists,changed}` / `progress.{reloaded,exists,changed}`）が
  含まれ、詳細ペインの結果表示欄に短い1行＋展開可能な詳細として表示される
- Rescan中は対象ボタンがdisabledになり「Rescanning...」を表示。失敗時は対象の
  結果表示欄にエラーメッセージを出し、他のprojectの表示には影響しない
- フィルタ・ソート・target/status複数選択・targetテキスト・選択中project・
  Markdown/Plain text表示モードはすべて維持される。ただし、再スキャンの結果
  現在のフィルタ条件から外れた場合（例: dirtyフィルタ中にcleanになった）は
  一覧から消える。これは仕様どおりでエラーにはしない
- 全体Rescanはそのまま残しており、両方を使い分けられる

## 表示情報の出典・鮮度（現在のrepo / 保存された作業コンテキスト）

「再開サマリーが古い保存内容を現在のrepo状態と誤認させる」というFBを受けて、
詳細ペインの情報を3種類に分類し、Rescanが何を更新し何を更新しないかを明示した。

### 3つの情報分類

| 分類 | 例 | 更新契機 |
|---|---|---|
| **現在のrepo（live）** | HEAD hash・commit message・branch・clean/dirty・modified/untracked件数・remote status・scan日時 | 一覧表示のたびに直近scan結果を表示。Rescan（全体/個別どちらも）で再取得 |
| **repoファイル由来** | README.md冒頭抜粋・PROGRESS.md末尾抜粋（本文そのもの） | Rescanで再読込。ファイル自体が変わらなければ内容も変わらない |
| **保存された作業コンテキスト** | Agent context本文（Current focus/Next action/Blockers/Last handoff notes）、manual status、manual note、command hints | ユーザーが明示的に保存操作（`Save context`、status/note編集）をしたときのみ更新。**Rescanでは書き換わらない** |

### 再開サマリーの構成（Phase 6-K以降）

「現在のrepo」ブロックと「保存された作業コンテキスト」ブロックは、詳細ペインの
別々のセクションとして常に分けて表示する（同じ内容を1箇所にまとめない）。

- **現在のrepo**（Alwaysヘッダー。詳細ペイン最上部・identity headerの直下・
  常時表示）: repo名・target・manual status・Git clean/dirty・
  modified/untracked件数・branch・HEAD（hash + commit message + 日付）・
  保存context鮮度バッジ・**Next action**・Development sessionを開始 /
  VSCodeだけ開く・該当project限定のRuntime helper chip。詳細は
  [PC詳細画面のAlwaysヘッダー](#pc詳細画面のalwaysヘッダーphase-6-k)を参照
- **保存された作業コンテキスト**（Resumeブロック。Alwaysヘッダーの直下）:
  保存日時 / 保存時HEAD / 鮮度バッジ（`current` / `stale` / `unknown`）/
  Agent context・PROGRESS.mdの定型見出し抽出（現在地・既知の制約・再開方法・
  **保存時の最後の作業**）。Next actionはAlwaysヘッダー側の主表示と重複させない
  ため、ここには表示しない（抽出ロジック自体は共通のまま）
  - 「最後の作業」という見出しは、現在のHEADと混同されないよう
    **「保存時の最後の作業」**に改名した（見出し検索対象自体は従来どおり
    「最後の作業」等も引き続きマッチする。過去に保存したMarkdownは書き換え不要）
  - 以前あった「保存済み記載が無ければ最新コミットへフォールバック表示する」
    処理は廃止した。保存済みの古いcommit参照（例: `latest commit: 73daf10 ...`）
    が、廃止前はこのフォールバックと同じ見出しの下に表示され、現在のHEADと
    区別がつかなかったため（実データで確認・再現済みの不具合）
  - 保存済みcontextが無いprojectでは「保存済みcontextなし」とだけ表示する

### 鮮度（freshness）判定

Agent context保存時に、その時点のHEAD hash・commit subject・branch・
README/PROGRESSのcontent hashを `metadata` として一緒に保存する
（`data/project-context.json`、ブラウザから送られた値は一切信用せず、
必ずサーバー側の直近scan結果から取得する）。

- `current`: 保存時HEAD == 現在HEAD
- `stale`: 保存時HEAD != 現在HEAD。個別Rescan時に限り、安全に判定できる場合は
  `git merge-base --is-ancestor` + `git rev-list --count` で「保存後に何コミット
  進んだか」も表示する（force-push等で安全に判定できない場合は件数を省略し、
  「保存後にHEADが更新されています」とだけ表示する）
- `unknown`: 保存時metadataが無い（旧`data/project-context.json`のエントリ等）
  または現在HEADが取得できない場合。**エラーにはしない**

README.md / PROGRESS.mdの「保存後に変更されたか」は、上記のHEAD鮮度とは
**別根拠の情報**として、hash比較で個別に判定・表示する（1つの警告文に混ぜない）。
PROGRESS.mdについては、ファイルの更新日時が最新コミットより古いというだけでは
「古い」と断定しない（mtimeだけでは根拠不十分なため）。README.mdはHEADに
紐づく情報ではない恒久ドキュメントとして扱い、鮮度警告は表示しない。

### Auto-fill / Save context / Rescan / Copy AI Handoffの役割

紛らわしかった4つの操作の役割を明確化した:

- **Rescan project**: git状態・README/PROGRESS・鮮度判定を再取得するだけ。
  保存済みAgent context本文やmanual status/noteは書き換えない
- **Auto-fill context**: README/PROGRESS/構成ファイル/manual status・noteから
  編集フォームへの**候補**を生成するだけ。`Save context`を押すまで
  `data/project-context.json`には反映されない
- **Save context**: フォームの内容を実際に保存し、保存時点のHEAD等のmetadataを
  記録する（本文は変更しない。metadataだけを更新する）
- **Copy AI Handoff**: 現在のrepo状態（`# Repo`）と保存済みAgent context
  （`# Saved agent context`、保存日時・保存時HEAD・鮮度を明記）を分けて出力する。
  保存済みcontextが`stale`の場合は
  `This saved context predates the current HEAD.` という行を必ず添える

## Project agent context / command hints（Phase 5-A）

各projectごとにVSCodeを開いてClaude Code / Codexを起動し、そのターミナルで
サーバ起動・アプリ起動・テスト実行等を行う運用を想定し、**projectごとの
最新の作業文脈と、起動・確認コマンドのヒントを agent-workbench 側に保持**
できるようにした。新しいagentを起動したときに引き継ぎやすくするための機能で、
このAgent context / command hints機能自体はメモの保存・表示・コピーだけを行う。
実際のVS Code / agent / development process起動は、後述する別機能
「Development session launcher」のローカル設定からだけ行う。

### README.md / PROGRESS.md / Agent context の役割分担（Phase 5-F follow-up）

「Agent contextが何のためにあるのか分かりにくい」というFBを受けて、3つの
記録の役割を整理する。

| | README.md | PROGRESS.md | Agent context |
|---|---|---|---|
| 対象読者 | repo利用者・人間 | 開発履歴を追う人間 | 新しいAI agent（自分自身の再開時含む） |
| 内容 | インストール方法・通常の使い方・仕様・注意事項 | 実装内容・acceptance・判断・既知制約・次候補 | 現在地・運用方針・禁止事項・再開条件の**要約** |
| 公開範囲 | 公開可能な恒久情報 | 公開可能な開発履歴 | agent-workbenchのローカル運用メモ（**非公開・非コミット**） |
| 保存先 | 各project repo内 | 各project repo内 | `data/project-context.json`（git管理外） |
| 主な用途 | 人間が読む・configure・使い方を調べる | 経緯・受け入れ判断を後から追う | Copy AI Handoffの材料。README/PROGRESSを全部読ませる前の要約として使う |

- **Agent contextはREADME.mdの代替ではない。** READMEに書くべき恒久的な
  使い方・仕様は引き続きREADMEに書く。Agent contextは「そのrepoを初めて見る
  AI agentに、README/PROGRESSを読ませる前にまず伝えたい現在地」に絞る
- README/PROGRESSと内容が重複しすぎる場合は、**Agent context側を短く保ち**、
  直近の現在地・次に何をすべきかの判断・触ってはいけないもの（禁止事項）・
  開発を再開すべきタイミング（再開条件）に寄せる
- UI上にも同様の説明文を表示している（`Agent context & command hints`
  展開時、Auto-fillボタンの上）

- 詳細ペインに `Agent context & command hints`（`<details>`で折りたたみ可能）
  を追加。以下の項目を保存できる
  - **Agent context**: 1つのMarkdownテキスト（Phase 5-Eで4分割textareaから
    変更。標準形式は `# Agent context` / `## Current focus` / `## Next action` /
    `## Blockers / notes` / `## Last handoff notes` だが自由記述でよい）。
    外部agent（ChatGPT/Claude Code等）の提案文をそのまま貼り付けられる。
    表示はPROGRESS.mdと同様の **Markdown / Plain text タブ切替**
    （Phase 5-E follow-up）: デフォルトはMarkdown preview（PROGRESS.mdと同じ
    mini markdown rendererで表示）、編集はPlain textタブへ切り替えて行う。
    Plain textでの未保存編集はMarkdownタブへ戻った時にpreviewへ反映される
  - **Command hints**: `ラベル | コマンド` 形式のプレーンテキスト（1行1コマンド）。
    例: `Start server | npm run dev`
- `Save context` ボタンで両方をまとめて保存する。保存先は
  **`data/project-context.json`**（`data/projects.json`と同様、絶対パスを
  キーとする。git管理外・`.gitignore`済み）
  - Phase 5-E以降は `agentContextMarkdown`（1つのMarkdown文字列）が正。
    Phase 5-A〜5-Dの旧4フィールド（`agentContext.currentFocus`等）は後方互換の
    ため保持され、`agentContextMarkdown`が未保存のprojectでは表示時に旧4フィールド
    からMarkdownへ合成される（データ自体はSave contextを押すまで書き換えない）
  - 保存のたびに `metadata: { headHash, headSubject, branch, readmeHash,
    progressHash }` をサーバー側の直近scan結果から付与する（ブラウザから
    送られた値は信用しない）。**旧`data/project-context.json`のエントリ
    （`metadata`が無い）はエラーにならず、鮮度は`unknown`として扱われる。
    本文は次回Save contextを押すまで書き換わらない**（詳細は前述「表示情報の
    出典・鮮度」を参照）
- 既存の manual status / note とは役割を分ける
  - status: 状態分類 / note: 一覧に出る短い説明
  - agent context: 新しいagentに渡す詳細な作業文脈 / command hints: 起動・確認コマンド
- Command hints は保存済みの内容を1行ずつ表示し、各行に `Copy` ボタンを表示する。
  押すと `cd "<project path>"` + そのコマンドをクリップボードにコピーする
  （**実行はしない**）。`Copy commands` ボタンで command hints 全体（未保存の
  編集中テキストも含む）をコピーできる
- **コピー系ボタンの役割分担**（Phase 5-D、Phase 5-Eで簡素化）
  - `Copy agent context`: Agent context markdown欄の内容を**そのまま**コピー
    （空欄なら `(not set)`）
  - `Copy commands`: command hintsのテキスト全体のみコピー
  - `Copy context + commands`: Markdown欄の内容 + `# Command hints` +
    command hintsをまとめてコピー（それぞれ空欄なら `(not set)`）
  - `Copy AI Handoff`: README/PROGRESS/git状態も含む完全な引き継ぎ（従来どおり）
  - いずれも**保存済みデータではなく現在フォームに入力中の内容**をコピーする
    （Auto-fill直後や手直し中の未保存内容をSave前に確認・コピーできる）
- ~~Import context（Phase 5-D follow-up）~~: **Phase 5-Eで廃止**。
  Agent contextが1つのMarkdown欄になったため、外部agentが出したMarkdownは
  Markdown欄に直接貼り付ければよく、見出し解析による4欄分配は不要になった
- **Copy AI Handoff（後述）に組み込まれる**: 生成されるMarkdownの
  `Current manual state`の後、`README tail`の前に `# Saved agent context`
  （保存日時・保存時HEAD・鮮度のmetadata行 + 本文）/ `# Command hints`
  セクションを追加する。**全項目が未設定のprojectではセクションごと省略**し、
  Handoffが冗長にならないようにしている（一部項目のみ未設定の場合はその項目
  だけ`(not set)`と表示する）
- **project の一意特定**は個別Rescanと同じ方針で、絶対パス（`path`）を主キーとし、
  `targetId`が渡された場合はさらに一致確認する（同名projectの取り違え防止。
  実例: `private` targetの`inner-voice`と`wsl private` targetの`inner-voice`で、
  それぞれ別々にagent context/command hintsを保持できることを確認済み）
- rescan（全体・個別とも）や status/note保存では、agent context/command hintsは
  変更されない（サーバー側は該当データを上書きしない）

## Auto-fill context（Phase 5-B）

Phase 5-Aの各項目を毎回手作業で埋めるのは大変なため、既存情報から初期候補を
生成して**フォームに反映するだけ**の機能を追加した。**外部AI APIは使わず、
ルールベースの推定のみ**。生成しただけでは保存されず、保存は既存の
`Save context` ボタンでのみ行う。

- 詳細ペインの `Agent context & command hints` 内に `Auto-fill context` ボタンを追加
  - Phase 5-E以降: Agent context markdown / command hintsの両方が空欄なら
    そのまま候補を反映し、どちらかに入力済みの内容がある場合は確認ダイアログを
    出してから上書きする（旧`Only fill blanks`チェックボックスはMarkdown一本化に
    伴い廃止）。候補は標準形式（`# Agent context` / `## Current focus`…）の
    Markdownとして反映される
- 推定元（すべてクライアント側の既存スキャン結果 + サーバー側のファイル検出）
  - **Current focus**: manual note → PROGRESS.md末尾の見出し → READMEの概要 →
    空欄、の優先順で1つ選ぶ
  - **Next action**: PROGRESS.md内の `Next` / `次` / `次候補` / `TODO` / `未確認`
    を含む見出し・箇条書き → manual statusが`dogfooding`なら固定文言 →
    `dirty`なら固定文言 → `abandoned`なら空欄
  - **Blockers / notes**: gitStatusがdirty/error/no-git、remoteがahead/behind/
    diverged/error、noteに機密情報らしき語（公開禁止/private/実データ/APIキー等）、
    manualStatusがabandoned、に該当する注意点を**すべて列挙**する（複数該当しうるため）
  - **Last handoff notes**: latest commit / latest tag を短く入れる
  - **Command hints**: `GET /api/projects/detect-commands`（サーバー側）でrepo内の
    `package.json`（scripts.test/dev/start）・`Cargo.toml`・Gradle
    （`build.gradle(.kts)`/`gradlew`。android{}ブロックがあれば
    `./gradlew compileDebugKotlin`も追加）・`requirements.txt`を検出し、
    README/PROGRESS.md末尾のinline code・コードブロックからコマンドらしき行
    （`npm`/`cargo`/`git`/`code`等で始まる短い行）も候補に加える。
    `Open VSCode | code .` / `Git status | git status` は常に候補に含める。
    重複コマンドは1つにまとめる
- 生成結果は`Auto-fill context`実行時にフォームへ反映されるだけで、
  **その時点では保存されない**。保存するには従来どおり`Save context`を押す必要がある
- project一意特定はPhase 5-Aと同じ（絶対パス + 任意`targetId`）

## PC詳細画面のAlwaysヘッダー（Phase 6-K）

次期UI設計案（`docs/design/agent-workbench-ui-design-20260722.pdf`のPC
P1案・情報分類表）に基づき、PC詳細画面を開いた**first viewport**だけで
「現在状態の把握」と「Development session開始」が完結するよう、常用情報を
detail-gridの外側（全幅）・最上部の**Alwaysヘッダー**へ集約した
（`alwaysHeaderHtml()`）。

Alwaysヘッダーに含まれるもの（この順序）:

1. repo名 / target
2. manual status badge / Git clean・dirty badge / branch / modified・
   untracked件数 / 保存context鮮度バッジ
3. current HEAD（hash + commit message + 日付・放置日数）
4. scan error / Git診断がある場合のみ、詳細参照を促す短い警告
5. **Next action**（Agent context・PROGRESS.mdの「## 次に行うこと」系見出しから
   抽出。記載が無ければ「未設定」と明示する。以前は再開サマリーの中盤以降に
   埋もれていた項目を最優先の位置へ引き上げた）
6. 該当project限定のRuntime helper chip（非対象projectでは領域自体を作らない）
7. Development session（設定状態バッジ・起動preset名・**Development sessionを
   開始** / **VSCodeだけ開く** CTA・item checkbox。設定詳細（preset ID・
   Target ID・path・config open/reload・template）はPhase 6-Lで
   Diagnosticsタブへ移した。schema・起動API・duplicate launch抑止は
   変更していない）

旧「project status」ブロック（manual status・branch・変更件数）と、旧「現在の
repo」ブロック（再開サマリー内）はここへ統合し、旧位置には残していない
（同じ内容が2箇所に出ないようにした）。「latest commit」ブロック（放置日数付き。
下部detail-secondary）はAlwaysヘッダーと内容が一部重なるが、既存の診断的な
表示として維持している。

Development sessionの開始ボタン・状態バッジ・保存済みAgent context・manual
status・Handoff purposeの選択値・freshness判定ロジックは、位置を移しただけで
挙動・API・スキーマは一切変更していない。

## PC詳細画面下部のtab: Documents / Context / Diagnostics（Phase 6-L）

Always/Resume summaryより下に雑多に並んでいた「必要な時だけ見る情報」を、
detail-gridの2カラムから、固定されたtab navigationへ再編した
（`detailTabsHtml()` / `documentsPanelHtml()` / `contextPanelHtml()` /
`diagnosticsPanelHtml()`）。旧`detail-grid`/`detail-col-left`/
`detail-col-right`はこのPhaseで廃止し、情報は3タブへ再分配した。

設計案（`docs/design/agent-workbench-ui-design-20260722.pdf`）はResumeを
含む4タブ構成（案B）も提示していたが、実装前にResume summaryの内容を確認した
ところ、Current focus・保存時の最後の作業・Blockers・Handoffが既にAlways直下へ
常時表示されており、同じ内容をResumeタブへも置くと冗長になることが分かった。
そのため**Resumeはタブに含めず、常時表示のまま**とし、タブは
**Documents / Context / Diagnostics（案A）**の3つにした。

- **タブの初期選択はDocuments**（実画面確認のFBにより、一度Contextへ変更した
  ものを再度Documentsへ戻した。Contextの閲覧ブロックやREADME全文をいきなり
  大きく表示せず、Always/Resume/PROGRESSを中心にした静かな初期画面が最も
  自然だった）。project切替時はDocumentsへ戻す。同じprojectの再描画
  （Rescan後等）では選択中のタブを維持する
- タブ切替はrenderTable()を呼ばず、`hidden`属性とARIA状態だけを直接更新する
  （Markdownの再parse・API再取得・未保存のContext編集の消失を起こさないため。
  既存の`ctx-view-mode`/`progress-mode`と同じ設計方針）
- ARIA: `role="tablist"` / `role="tab"` / `role="tabpanel"` /
  `aria-selected` / `aria-controls` / `tabindex`（非選択タブは`-1`）を実装し、
  ArrowLeft/ArrowRight/Home/Endでタブ間を移動できる（Enter/Spaceはbuttonの
  ネイティブ動作）

### Documents

**PROGRESS.md / README.mdをsub-tabで選択式**にしている（`[PROGRESS]
[README]`。50ef416時点の構造を維持）。片方だけが見える。実画面確認FBに
より、**初期documentはREADME**にした（従来はPROGRESS）。ただし単純に
初期documentを変えるだけでなく、README選択時は**見出しと開閉UIだけを表示し、
開いた時だけ本文を表示**する（本文自体がさらに`<details>`で折りたたまれて
いる）。PROGRESSを選択した時は従来どおり本文を常時表示する（PROGRESS側には
対応する折りたたみは無い）。目的はREADMEだけを理想的に特別扱いすることでは
なく、既存のsub-tab構造を維持したまま初期画面を最小化すること
（Documents/Context/Diagnosticsの上位タブ構造・PROGRESS/READMEのsub-tab
構造・API/schemaはこのfollow-upでは変更していない）。

- README折りたたみは**初期closed**。project切替時はDocuments+README
  sub-tab+closedへ戻し、同じprojectの再描画（Rescan後等）ではDocuments内の
  sub-tab選択（`documentsSubView`）・README開閉（`readmeExpanded`）を
  維持する。開閉はnativeの`<details>`/`<summary>`（`toggle`イベントを
  `repo-tbody`へのcapture-phaseリスナーで拾って状態を同期する。`toggle`は
  bubbleしないため）なので、keyboard Enter/Space・focus・closed時の本文
  非フォーカスはブラウザの既定動作にそのまま従う。`aria-expanded`/
  `aria-controls`は明示的に付与している
- READMEが無い場合は見出し直下に「README.md なし」、read error時は
  「⚠ read error」を、開かなくても分かるようcompact表示する（展開すると
  詳細なエラーメッセージが本文欄に出る）
- READMEにもMarkdown/Plain text切替がある（PROGRESSと独立した
  `readmeViewMode`。展開時だけ表示され、PROGRESSの`progressViewMode`とは
  別の状態として保持する）

**本文表示領域**: PROGRESS（sub-tab選択時は常時表示）とREADME（選択時でも
さらに折りたたみ）は、別々の高さvariant classにしている。両方とも共通の
`.documents-body`（scroll容器の土台）に、`.documents-body-progress`または
`.documents-body-readme`を組み合わせる。調整はこの2 variantのCSSだけで
完結する:

| variant | PC | mobile（`max-width: 800px`） |
|---|---|---|
| `.documents-body-progress` | `min-height: 420px` / `height: clamp(420px, 52vh, 720px)` | `max-height: min(56vh, 480px)` |
| `.documents-body-readme` | `min-height: 320px` / `height: clamp(320px, 45vh, 640px)` | `max-height: min(52vh, 420px)` |

Markdown/Plain text切替は同じラッパー内の表示切替のみのため、高さは
変わらない。closed時のREADMEは（native `<details>`の既定動作により）
高さを占有しない。

### Context

**Saved agent context**と**Project status & note**の2 sectionを置く。

- Saved agent contextは初期状態が**閲覧**（Current focus / Next action /
  Blockers・notes / Last handoff notesをcompactな`<dl>`で表示し、保存済み
  command hintsのCopy一覧を添える）。「編集する」を押すまでMarkdown/Plain
  textのtextarea等は表示しない。編集中は「編集する」ボタンが隠れ、
  Cancelで保存済みの値へ戻して閲覧へ復帰、Saveで保存後の値を反映して
  閲覧へ戻る
  - 閲覧の**Next action**は、AlwaysヘッダーのNext actionと**同じ
    `buildResumeItems()`の呼び出し結果**を表示する（別の抽出をしない。
    値が食い違わないようにするため）
  - Auto-fill context / Save context / Copy agent context / Copy commands /
    Copy context + commands / Markdown・Plain text切替は、既存のまま編集
    UI側に維持している
- Project status & noteは、旧「手動ステータス」編集フォーム（status
  select・note textarea・保存button）をそのまま移設した。保存API・意味は
  変更していない。Resume summary側には、この保存済みnoteの**閲覧専用の
  1行**（`Note: ...`）を追加した（編集はContextでのみ行う）

project切替時、Context編集が開いたままだと無警告で内容が失われる
（project切替はDOM全体を再生成するため）。これを避けるため、編集中に
別projectへ切り替えようとすると確認ダイアログを表示する。

### Diagnostics

**Repository**（path・target・branch・latest commit・latest tags・remote）・
**Scan**（Rescan project・scan診断・error・Git診断）・**Development session
settings**（preset ID・Target ID・path・config open/reload・project設定
ひな形。既存の`development-session-config-actions`placeholderをそのまま
このタブへ移しただけで、複製はしていない）の3 sectionへ最低限分類した。
Development sessionの開始CTA・item checkbox・Runtime操作はDiagnosticsへは
移さず、Alwaysに残している。

Rescan projectボタンはDiagnostics内の1箇所のみとし、Always/Resumeには
別の入口を追加していない（同じボタンを複数箇所に置かないため）。

## 再開サマリー（Resume summary、Phase 6-A）

初見ユーザーテストで「リポジトリ一覧とGit状態確認の目的は伝わるが、
**前回どこまで進めたか・なぜ止まっているか・次に何をするか・再開手順**が
画面から読み取りにくい（PROGRESS等の長文に埋もれる）」という問題が出たため、
選択projectの詳細ペイン最上部（identity headerの直下、PROGRESS全文・Git詳細より前）に
**再開サマリー**カードを表示していた。Phase 6-Kで、常用情報（現在のrepo・Next
action・CTA）はAlwaysヘッダーへ移動し、このセクションは**保存された作業
コンテキスト（Resumeブロック）専用**になっている。Handoff purposeの選択・
Copy AI Handoffも、このResumeブロックの直後に置く（旧position「project status」
ブロック内からは移動済み）。

表示項目（この順序。1〜3行程度のコンパクトな定義リスト）:

1. 現在地
2. 保存時の最後の作業
3. 既知の制約
4. 再開方法

「次に行うこと（Next action）」はAlwaysヘッダー側で主表示するため、Resume
ブロックでは重複表示しない（抽出ロジック自体は共通で、表示側だけ除外している）。

### 情報源と優先順位（AIによる自由要約はしない）

内容は**明示的に記載されたものだけ**を表示する。READMEやPROGRESSの自由文章の
自動要約・キーワード検索による推測は行わない。

1. **Agent context Markdown内の定型見出し**（`data/project-context.json`）
2. **PROGRESS.md末尾抜粋内の同じ定型見出し**（Agent contextに無い項目のみ補完）
3. **「最後の作業」のみ**、記載が無ければ最新コミット（hash + message + 日時）を
   事実情報として表示する。working treeがclean以外の場合はその状態も併記する

定型見出しは**完全一致**（大文字小文字・`#`〜`####`の段数は区別しない）のみ拾う:

| 項目 | 見出し（日本語が正） | 英語エイリアス |
|---|---|---|
| 現在地 | `## 現在地` | `Current state` / `Current focus` |
| 最後の作業 | `## 最後の作業` | `Last work` / `Last handoff notes` |
| 次に行うこと | `## 次に行うこと` | `Next action` / `Next actions` |
| 既知の制約 | `## 既知の制約` | `Known constraints` / `Important constraints` / `Blockers / notes` |
| 再開方法 | `## 再開方法` / `## 開発再開手順` | `Resume steps` / `Development re-entry` |

英語エイリアスは、Phase 5-E標準形式とdogfoodingで実際に使われた見出しに限定している
（`現在地について`のような部分一致・類似見出しは拾わない）。

### 編集方法・挙動

- **編集は既存のAgent context Markdown欄**（`Agent context & command hints`）で行う。
  上記の定型見出しでセクションを書いて `Save context` すると、再開サマリーに即反映される
  （保存後にサマリーブロックだけを再描画する。他の未保存編集は失われない）
- 記載が無い項目は**表示しない**（推測で文章を作らない。「最後の作業」のみ
  上記のコミットfallbackあり）。全項目が欠落している場合のみ
  「記録なし（定型見出しで記載すると表示されます）」の1行を表示する
- 本文は必ずHTML escapeして表示する。1項目400文字で省略し、カード全体にも
  高さ上限（内部スクロール）があるため、長文が画面を占有しない
- 旧4フィールドのみのproject（`agentContextMarkdown`未保存）でも、合成Markdownの
  `## Current focus` 等がエイリアス一致するため、そのまま表示される（後方互換）
- 抽出・整形ロジックは `public/resume-summary.js` に分離し、
  `npm test`（`test/resume-summary.test.js`）で単体テストできる

### あわせて実施した小さな整理（Phase 6-A）

- 選択中の一覧行のハイライトを強化（背景を濃く＋左端に青のアクセント）し、
  詳細ペインのidentity headerに「選択中」バッジを追加した
- 詳細ペインの「スキャン診断」を折りたたみ（初期は閉じる。totalは閉じたまま見える）に
  変更し、再開用情報より診断情報が目立たないようにした（機能は削除していない）

## Runtime helper card（runtime-sample-project専用、dogfooding follow-up）

runtime-sample-project / Runtime helperは、VSCode / Claude Code / Codexを常時起動せず、
PC serverを必要時に起動して使うdogfooding runtimeとして運用する方針になった。
そのための最小導線として、**runtime-sample-projectの詳細画面にだけ**「Runtime
helper」カードを表示する（`r.name === 'runtime-sample-project'`で判定。他project
には出ない、汎用機能ではない）。

- **Check server**: サーバー側の限定API `GET /api/runtime/ping`が
  `127.0.0.1:8787/ping`へ固定GET（タイムアウト2秒）するだけ。結果を
  Running / Not running / Error / Uknownバッジとレスポンス時間で表示する。
  任意URLへのアクセス・任意コマンド実行はできない。`receiver.config.json`は
  読まない
- **Open root / Open files page / Open APK page**: `http://127.0.0.1:8787/`・
  `/files.html`・`/apks.html`をtoken無しの固定URLとして新規タブで開くだけ
  （`window.open()`。agent-workbenchからのfetchや実行ではない）。tokenが必要な
  ページでも、token付きURLは生成・保存・表示しない（runtime helper documentation
  の導線を使う旨をカード内に注記する）
- 状態（Running等）はDOM上でのみ保持し、`data/project-context.json`等には保存
  しない（詳細を閉じて開き直すとUnknownに戻る）
- Runtime helper serverの起動・停止はagent-workbenchからは行わない（利用側の
  PowerShellスクリプトを使う）

## Copy AI Handoff（Phase 4-A）

project詳細欄に **Copy AI Handoff** ボタンがある。押すと、そのrepoの現在状況を
まとめた Markdown を **クリップボードにコピー**する。Claude Code / Codex にそのまま
貼り付けて、現状把握と次フェーズ提案を依頼するための文脈パックを作る機能。

- **タスク管理機能ではない**。次アクション入力欄・優先度入力欄・カンバン・カレンダー等は
  持たない。既存の README.md / PROGRESS.md 冒頭抜粋 / git status / git log / remote status /
  manual status / note を材料に Markdown を生成するだけ
- **プレーンテキスト運用を置き換えない**。agent-workbench 上でタスクを管理させるのではなく、
  普段どおり README / PROGRESS / note に書いている情報を、AI へ渡しやすい形に
  まとめ直すだけの補助ツール
- **生成AI APIは使わない**。Markdown組み立てはクライアント側の文字列処理のみ
- **実装・commit・pushを自動実行しない**。コピーした Markdown 自体に
  「実装前に方針を確認する」「tag/release/pushは明示指示がない限り行わない」といった
  ルールを含めているが、これはあくまで貼り付け先のAIへの指示文であり、
  agent-workbench 自身が何かを実行するわけではない
- dirty / untracked / no-git / no-remote / no-upstream の場合は、Markdown内に
  該当する注意文が自動で入る（sync状態のrepoには不要な警告は入らない）
- クリップボードコピーは `navigator.clipboard.writeText()` を使用し、
  失敗時は textarea + `execCommand('copy')` にフォールバックする
- **Handoff purpose 選択**（Phase 5-F）: Copy AI Handoff ボタンの上に
  `Handoff purpose` セレクトがあり、生成されるMarkdown先頭の `# 目的` 文だけを
  6種類（現状把握＋方針提案 / 現状把握のみ / FB調査 / 承認済み変更を実装 /
  受け入れ記録 / dogfooding確認）から切り替えられる。`# 目的` 以外の
  セクション構造（Repo / Current manual state / Agent context / Command hints /
  README tail / PROGRESS tail / Git notes / Warnings / Important rules / Request）
  は選択によらず変更しない。選択状態は全project共通でlocalStorageに保存し、
  一度でも選択したことがあればその値を尊重する。**localStorageに保存が無い
  （まだ一度も選んだことがない）場合のデフォルトは「現状把握のみ」**
  （Phase 5-F follow-upでFBにより「現状把握＋方針提案」から変更。テンプレート
  自体は6種類とも維持しており、「現状把握＋方針提案」も引き続き選択できる）
  （`Copy agent context` / `Copy commands` / `Copy context + commands` には影響しない）

## Copy project signals

ヘッダー右上（`再スキャン`の隣）に **Copy project signals** ボタンがある。押すと、
**全project横断**の課題・進捗・再利用候補の素材を Markdown としてクリップボードに
コピーする。

- **Copy AI Handoffとは別用途**。役割の違いは次のとおり
  - `Copy AI Handoff`: **1つのrepo**について、AIへ作業を引き継ぐための文脈パック
    （README/PROGRESS/git状態/Agent context等）
  - `Copy project signals`: **全repoを横断**して、ユーザー本人が繰り返し困っている
    こと・複数プロジェクトに共通する課題・再利用できる知見・システム化/サービス化案
    を探すための素材（Portfolio summary・Attention signals・project別の要点・
    固定の分析依頼文）
- **外部送信は行わない**。生成はブラウザ側の文字列処理のみで、`navigator.clipboard`
  へコピーするだけ（`Copy AI Handoff`と同じ方式）。生成AI APIの呼び出し・
  アイデア生成・自動評価もこの機能自体では行わない
- 出力には**ローカルの絶対パス**や、configured roots配下のrepo名・note・
  Agent context本文が含まれうる。**外部AI（ChatGPT等）に貼り付ける前に、
  貼り付け先のプライバシー/データ取り扱いを確認し、貼ってよい内容か見直すこと**
- 各projectのセクションは、取得できる項目（target/path/status/note/branch/
  working tree/remote/latest commit/放置日数/scan状態/保存済みAgent contextの
  鮮度・Current focus・Next action・Blockers・PROGRESS.md末尾抜粋）だけを出力し、
  値が無い項目は行ごと省略する。README全文の要約は行わない（現在のscan結果に
  README summaryフィールドが無いため）

## Action Queue（Increment 1）

repo一覧（下部テーブル）は「何が存在するか」を見る画面であり、「次に何を進めるべきか」を
判断する画面ではなかった。そこで、画面上部に **Action Queue** を追加した。3つの役割を
混同しない設計にしている。

| 領域 | 役割 |
|---|---|
| **Action Queue**（画面上部） | 何をするか |
| **repo table**（下部・従来どおり） | 何が存在するか |
| **スキャン詳細 / Scanner health**（折りたたみ） | Workbench 自体が正常か |

- Action Queue は **既存データからの派生のみ**で作る。新しい manual status・schema・
  手入力フィールドは追加していない（`data/projects.json` の status enum も変更なし）。
- 派生ロジックは純粋関数 `public/action-queue.js`（`deriveActionState` /
  `buildActionQueue` / `pageActionQueue`）に分離し、`test/action-queue.test.js` で
  単体テストする。DOM・fetch・ネットワーク・AI API・外部送信・永続化は一切行わない。
- 行をクリック（またはEnter / Space）すると、既存の詳細ペイン（Always / Resume /
  Documents / Context / Diagnostics）へ移動する。現在のフィルタで対象 repo が一覧に
  出ていない場合は、フィルタを全解除してから開く（Action Queue は toolbar の
  フィルタとは独立した portfolio ビューのため）。

### 表示項目

各行: **project** / **State** / **Now（次にやること）** / **Why now** / **次回確認日** /
**Human**（Waiting セクションは Human 列なし）。

- **State**: `ACTION`（今やる具体的作業がある） / `OBSERVE`（観測。具体的作業はまだ無い） /
  `WAIT`（外部イベント・他者・将来日付を待っている）。
  KEEP / IMPROVE / EXPAND / RETIRE は **State にしない**（portfolio 上の評価・意思決定結果
  であり、運用 State とは分離する）。
- **Now**: Agent context / PROGRESS.md の `## 次に行うこと`（`## Next action` 等の
  エイリアス。resume-summary.js の完全一致抽出）から取る。無ければ State に応じた既定文言。
- **Why now**: 「今動く理由」だけを出す。`dirty` / `remote ahead` / 明示された次アクション /
  明示された待ち理由 / `Human gate` / 到来した次回確認日 のみ。
  **scan error / no remote / long stale などの scanner 情報は Why now に出さない**
  （それらは Scanner health / 詳細診断の担当）。
- **次回確認日**: `次回確認日: 2026-09-08` / `Next review: 2026-09-08` のような
  **明示ラベルに結びついた日付だけ**を安全に抽出する。ラベルの無い散文中の日付
  （`latest commit ... (2026-07-07)` 等）は拾わない。誤検出より未表示（`—`）を優先する。
  抽出元は **Agent context Markdown と manual note のみ**（Increment 1.1）。
  PROGRESS.md 末尾は長文の履歴・説明文でラベル文字列がドキュメント例として混入
  しやすいため走査しない。正式な `## 次回確認日` 見出しの導入は Increment 2 以降。
- **Human**: 人間の操作・判断が必要か。`dirty`（commit/破棄の判断） / `remote ahead`
  （push の判断） / next action・既知の制約に「実機」「手動」「ユーザーが」「承認」
  「install」「審査」等が含まれる、で導出する。

### State の派生ルール（`public/action-queue.js`）

`data/projects.json` の manual status と scan 結果の組み合わせから派生する。

| 入力 | 派生 State | section |
|---|---|---|
| `gitStatus` が `dirty`、または `remote` が `ahead` / `diverged` | `ACTION`（Human gate） | queue（最優先） |
| manual status `active` + 次アクション記載あり | `ACTION` | queue |
| manual status `active` + 次アクション記載なし | `OBSERVE` | queue（将来日付があれば waiting） |
| manual status `dogfooding` | 原則 `OBSERVE`。次アクションに「実装 / fix / 修正 / 不具合 / 対応 / 検証実施 / リファクタ」等の具体的作業が明示されていれば `ACTION` | queue（OBSERVE で将来日付があれば waiting） |
| manual status `paused` | `WAIT` | waiting |
| manual status `released` + note / agent context / PROGRESS に「F-Droid待ち / ストア審査待ち / レビュー待ち / 公開後観測 / 外部イベント待ち」等が明示 | `WAIT`（観測系は `OBSERVE`） | waiting（観測 + 到来日付は queue） |
| manual status `released` + 待ち理由なし | — | none（Action Queue に出さない） |
| manual status `abandoned` | — | none |
| manual status `unknown` + 具体的作業が明示 | `ACTION` | queue |
| scan 不能（`kind` error/missing、`gitStatus` error、scan error あり） | **section を変えない**。上の各行と同じく manual status / agent context / operational headings から通常どおり導出する。git 状態が取れないため `dirty` / `ahead` / `diverged` は推測しない（明示値のみ判定 → scan-error repo では false になる）。`scanUnavailable` フラグを立て、行に `scan?` バッジを出すだけ（Increment 2.1） | 通常どおり |

**priority**（小さいほど上位。前向きな運用 State 中心）:
`ACTION + Human gate` → `ACTION` → 期限到来した `OBSERVE` → `OBSERVE` → `WAIT`。
同順位内は「次回確認日が早い順 → 放置日数が大きい順 → repo名」。
**放置日数（idleDays）は priority の主要因にしない**（同順位内の補助 tie-breaker のみ）。

### Now / Watching / Waiting の3セクション（Increment 1.1）

派生した `section === 'queue'` を、表示時に **Now** と **Watching** へ再グループする
（State enum は変更しない。分けるのは表示グループだけ）。

- **Now（今やる）**: `state === 'ACTION'`、または `state === 'OBSERVE'` かつ
  **次回確認日が到来している**もの。**常時展開**。0 件でもセクションを出し
  「今すぐ対応する項目はありません」と表示する。優先度上位10件表示 →「すべて表示」で展開。
- **Watching / 観測中**: queue の残りの `OBSERVE`（dogfooding 観測中、active だが
  具体的作業が未定義、など）。**既定は折りたたみ**（見出しに件数）。
- **Waiting / scheduled**: `section === 'waiting'`（paused、外部イベント待ち、
  将来日付の OBSERVE）。**既定は折りたたみ**（見出しに件数）。
  scan 不能でも portfolio 分類は変わらない（Increment 2.1）。paused の scan-error repo は
  Why が `paused` のまま Waiting に出て、`scan?` バッジが付くだけ。
- 行クリック / Enter / Space による既存詳細ペインへの遷移は3セクションすべてで使える。
- `buildActionQueue()` の返却は `{ now, watching, waiting, counts }`。旧 `queue`
  （= now + watching）と `counts.queue` も後方互換で残している。

### やらないこと（Increment 1）

- GitHub API 等による外部シグナル（download / star / issue / review）取得。
  ネットワークアクセス・新しい server 側 fetch は追加していない。
- WSL ECONNRESET / ETIMEDOUT 等の scan error を理由に Action Queue へ昇格させること。
  scan error は **スキャン詳細 / Scanner health** の担当。scan 詳細は Action Queue より
  常に下位に置き、**エラーの有無にかかわらず既定で閉じたまま**（`render()` では開閉に
  触れない）。エラー件数は閉じた toggle 行に `⚠ N`（config error + missing/error target の
  実件数）としてコンパクト表示し、詳細はユーザーが手動展開して確認する。
- 新しい manual status 語彙の追加、`data/projects.json` の schema 変更、
  repo ごとの状態手入力。

### 運用見出し / 外部イベント待ち / repo-less item（Increment 2）

Agent Workbench を repo action dashboard から、repo 外の公開予定・外部イベント待ち・
観測予定も含めた **portfolio operator dashboard** へ一段進める。**Agent Workbench 自身は
外部 API を呼ばない**。外部状態（GitHub / F-Droid / Qiita / Coconala / Google Play 等）の
観測は ChatGPT / Claude 等の **AI operator の担当**で、その結果を Agent context の薄い
運用見出しへ反映する。

#### `agentContextMarkdown` の運用見出し（任意）

| 見出し | 値 | 扱い |
|---|---|---|
| `## 次回確認日` | 単一 ISO 日付（`2026-09-08`）1個のみ | Next date として抽出。将来日付 → Waiting、到来 → Now(OBSERVE) |
| `## 外部イベント待ち` | 自由記述1行（`F-Droid: test 待ち` 等） | manual status（active / dogfooding / released / unknown / paused）に関わらず **Waiting** へ。見出し / 内容を削除すれば通常派生へ戻る |
| `## 外部シグナル` | 自由記述（`Star: 1` / `Downloads: 8` 等） | 表示・Handoff 用のみ。時系列 DB・数値集計はしない |

- 複数日付 / `Day1`/`Day7` 配列 / 時刻 / recurrence は扱わない（単一 ISO 日付のみ）。
- Next date の抽出元は **`agentContextMarkdown` と `note` のみ**。PROGRESS.md 自由文からは拾わない。
- `## 次回確認日` はインライン形式（`次回確認日: 2026-09-08`）と見出し形式の両方を受理する。
  見出し形式は本文の先頭非空行が ISO 日付ちょうどの場合のみ。曖昧・不正は無視。

#### repo-less portfolio item（V1: フォルダ方式）

repo を持たない公開予定・非 repo サービス・記事 output 等は、`portfolio` target
（`config/roots.local.json` の `repo-directories`、`data/portfolio-items/` を指す）配下の
**サブフォルダ1つ = 1 item** として登録する。フォルダ名が表示名。scanner 上は `kind: no-git`。

- 配置先は **agent-workbench repo 内の gitignore 済み `data/portfolio-items/`**。
  親 repo（`C:\workspaces`）の `private_notes/` は tracked のため、そこに置くと親 repo が
  恒常的に untracked になる。`data/portfolio-items/` は agent-workbench の `.gitignore` に
  追加済みで、他 repo に影響しない。
- 運用状態は `data/project-context.json`（絶対パスキー、gitignore 済み）の
  `agentContextMarkdown` で管理する。AI operator が生成 → ユーザーが Agent context 欄へ
  貼って Save（または operator が直接ファイル更新）。フォーム手入力・専用 CRUD UI は無い。
- portfolio / no-git item は、**agentContextMarkdown / manual status / 次回確認日 /
  外部イベント待ち / 次に行うこと のいずれかを持つ場合だけ** Action Queue の通常派生へ流す。
  素の作業フォルダ（`tmp` / `*-signing` 等・運用情報なし）は Action Queue に出さない。
- virtual item だからといって自動 ACTION にはしない。Now に入るのは
  「ACTION」または「次回確認日が到来した OBSERVE」のみ（Increment 1.1 の原則を維持）。
- 詳細ペインには「運用（Portfolio）」ブロック（State / Next action / Next review /
  External wait / External signal）を表示。repo を持たない item では branch / HEAD /
  commit / Development session は対象外である旨を注記する。

#### Copy project signals（export の最小拡張）

各 project / item について、存在する場合だけ `next review` / `external wait` /
`#### External signal` を出力する。AI operator 向け依頼文に「外部状態を確認できたら、
変化があった item の `## 現在地` / `## 次に行うこと` / `## 次回確認日` /
`## 外部イベント待ち` / `## 外部シグナル` を更新するための情報（推測値なし）を返す」を追加。
**双方向 sync engine にはしない。生成 AI API も呼ばない。** 純粋な Markdown export のまま。

## Development session launcher

Windows再起動後や開発再開時に、project詳細の **Development session** から
VS Code workspaceと統合ターミナルを復元する。通常の`Copy AI Handoff`とpurpose
6種類（FB調査を含む）は補助機能として維持する。専用の「FB調査用Handoffをコピー」
ボタンは通常Handoffと役割が重複し、FB本文との結合は外部で必要だったため削除した。

画面ではprofile内のitemごとにlabel、`agent` / `process`、実行予定command、cwd、
default on/offを表示する。Claude Codeだけ、Codexだけ、両方、development processだけ、
または任意の組み合わせをチェックし、`Development sessionを開始`を押す。
`VSCodeだけ開く`は従来機能を維持し、`設定を再読み込み`はローカルJSONを読み直す。
スマホから押しても、起動先はagent-workbench serverが動くWindows PCである。

Development sessionセクションは常に次の順で表示する。①セクションタイトルと状態
（Configured / Not configured / Target ID mismatch / Path mismatch / Configuration error）、
②このprojectのsession configuration identity、③エラーまたは未設定の案内（該当時のみ）、
④profile/item一覧（設定済みの時のみ）、⑤常用の起動操作（開始 / VSCodeだけ開く）、
⑥設定補助操作（ひな形コピー / 設定ファイルを開く / 再読み込み）。常用の起動操作は
設定補助操作より上に置き、未設定・エラー時は識別情報とエラー案内が自然と目立つ位置に来る。

### 新しいprojectへ設定を追加する手順

以前は「exampleを手動コピー → schemaを覚えて手打ち → targetIdと画面上のtarget labelを
取り違えやすい（例: 画面表示は`wsl private`だが実際に設定へ書くべきIDは`wsl_claude_private`）
→ エラーは`Development session configuration is invalid (1 issue).`としか出ず原因不明
→ 設定はJSONとしては正しく読めていても、targetId/pathが一致しないだけの場合も
`This project has no development session configuration.`と表示され、未設定なのか
照合ミスなのか区別できない」という問題があった。現在は次の手順で迷わず設定できる。

**起動プリセット（推奨・version 2）** が1件以上定義済みなら、未設定projectの
Development sessionカードにpreset選択と内容previewがそのまま表示される。

1. project詳細を開く（未設定projectでは、適合する起動プリセットの選択欄が
   そのまま常用の主操作として表示される）
2. **起動プリセット**のドロップダウンから、このprojectに合うものを選ぶ
   （Windows projectには`platform: windows`または`any`、WSL projectには
   `platform: wsl`または`any`のpresetだけが選択肢に出る）。内容（含まれるitem
   のlabel一覧）がその場でpreviewされる
3. **このプリセットで登録**を押す。requestは`targetId` / `path` / `presetId`の
   識別子だけを送り、command/args/cwdやpreset内容そのものはbrowserから送らない。
   登録はagent-workbench serverが動くWindows PC上のlocalhostからだけ行える
   （下記「起動プリセット（version 2）」参照）
4. 登録が終わると自動で設定済み表示に切り替わり、**Development sessionを開始**で
   VS Code workspaceとtaskを起動できる

適合するpresetが1件も無いprojectでは、従来の「project設定ひな形をコピー」経路が
そのまま使える（詳細設定として表示される）。

1. project詳細を開き、Development session内の **設定情報** を開いて
   正確な `Target ID`（設定ファイルに書く内部ID。project headerに出ている表示labelとは
   別物）と `Path`（scan結果の正規path）を確認する。値の行に並んだ`コピー`で
   それぞれ個別にコピーできる（設定済みprojectでは設定情報は初期折りたたみ）
2. **project設定ひな形をコピー**を押す。scan結果から生成した、schemaに完全準拠する
   project object（`targetId` / `path` / `defaultProfileId` / `profiles` / items 1件）が
   クリップボードへコピーされる。`data/development-sessions.json`がまだ無いprojectでは
   **新規設定ファイル全体をコピー**（`{ "version": 1, "projects": [...] }`）も選べる
3. **設定ファイルをVS Codeで開く**を押す。固定path`data/development-sessions.json`だけを、
   agent-workbench serverが動くWindows PC上のVS Codeで開く（存在しない場合は作成手順を表示する）
4. コピーしたproject objectを`projects`配列へ貼り付け、`command`（ひな形では
   `"EDIT_ME"` placeholder）と`args`を実際の環境に合わせて編集する。ひな形自体には
   Claude Code / Codex / npm等の実引数を推測して入れていない
5. **設定を再読み込み**を押す。schema/照合の結果がその場で更新される
6. **Development sessionを開始**でVS Code workspaceとtaskを起動する

ひな形コピー・設定ファイルopen・preset登録のいずれも、ブラウザからserverへ任意の
command / args / cwd / preset内容を送るAPIではない。ひな形はクリップボードへ
コピーするだけ、設定ファイルopenは固定pathをVS Codeで開くだけ、preset登録は
既存のtargetId/path/presetIdの組み合わせを設定ファイルへ追記するだけである。

### ローカル設定

実設定は`data/development-sessions.json`へ置き、Git管理しない。初回はexampleをコピーする
（または上記の「project設定ひな形をコピー」→ 貼り付けでも作成できる）。

```powershell
Copy-Item data\development-sessions.example.json data\development-sessions.json
```

schema versionは`1`。projectは表示名ではなく`targetId + 絶対path`で識別し、projectごとに
`defaultProfileId`と1つ以上のprofileを持つ。profileは`id`、`label`、`items`、itemは
次のfieldだけを持つ。不明field、duplicate project/profile/item ID、型不一致は設定エラーになる。

```json
{
  "id": "dev-server",
  "label": "Dev server",
  "kind": "process",
  "enabledByDefault": true,
  "command": "npm",
  "args": ["start"],
  "cwd": "."
}
```

- `kind`: `agent`または`process`
- `command`と`args`: 必ず分離する。shell文字列は書かない
- `cwd`: repoルートからの相対path。絶対pathと`..`によるrepo外移動は拒否
- `enabledByDefault`: 詳細を開いた時の初期チェック
- `command` / `args` / `cwd` / executableをAPI requestから指定することはできない
- environment変数fieldはない。API key、token、password等のsecretを保存しない。
  VS Code taskは通常の統合ターミナル環境を継承する
- 実際の引数は推測せず、使用環境の`claude --help`、`codex --help`で確認して設定する。
  WindowsとWSLではPATHやCLIのinstall状況が異なるため、それぞれのtask環境で確認する
- `command`に生成直後の`"EDIT_ME"`が残っている場合、validationが明示的に拒否する
  （誤ってひな形のまま保存・起動されるのを防ぐ）

schemaは複数profileを扱える。UIもprofileが複数あれば選択できるが、最初はdefault profile
1つとitemチェックの組み合わせでの運用を推奨する。

#### Windows / WSL設定例

Windows project（`targetId`はscan結果のIDをそのまま使う）:

```json
{
  "targetId": "sample-workspace",
  "path": "C:\\workspaces\\sample-workspace\\sample-project",
  "defaultProfileId": "default",
  "profiles": [{
    "id": "default",
    "label": "Default development",
    "items": [
      { "id": "claude", "label": "Claude Code", "kind": "agent", "enabledByDefault": true,
        "command": "claude", "args": [], "cwd": "." },
      { "id": "codex", "label": "Codex", "kind": "agent", "enabledByDefault": true,
        "command": "codex", "args": [], "cwd": "." }
    ]
  }]
}
```

WSL project（`targetId`は表示label`wsl private`ではなく、内部ID`wsl_claude_private`を使う。
`path`はUNC表記のまま）:

```json
{
  "targetId": "wsl_claude_private",
  "path": "\\\\wsl.localhost\\Ubuntu\\home\\user\\projects\\sample-project",
  "defaultProfileId": "default",
  "profiles": [{
    "id": "default",
    "label": "Default development",
    "items": [
      { "id": "shell", "label": "WSL shell", "kind": "process", "enabledByDefault": true,
        "command": "bash", "args": ["-l"], "cwd": "." },
      { "id": "claude", "label": "Claude Code", "kind": "agent", "enabledByDefault": true,
        "command": "claude", "args": [], "cwd": "." }
    ]
  }]
}
```

WSL側のtaskはRemote WSL接続後にLinux側で実行されるため、Windows側の`powershell.exe`等は
指定しない。commandはbash等のLinuxコマンド名をそのまま書く。

### 起動プリセット（version 2）

project ごとに Claude Code / Codex / shell の item を毎回コピペしていると、
引数を1つ変えるだけで設定済みの全projectを直さないといけなくなる。
version 2 schemaでは、共通の起動構成を**起動プリセット**として`presets`に
一度だけ定義し、各projectは`presetId`で参照するだけにできる。

```json
{
  "version": 2,
  "presets": [
    {
      "id": "windows-ai",
      "label": "AI開発 Windows",
      "platform": "windows",
      "items": [
        { "id": "claude", "label": "Claude Code", "kind": "agent", "enabledByDefault": true,
          "command": "claude", "args": [], "cwd": "." },
        { "id": "codex", "label": "Codex", "kind": "agent", "enabledByDefault": true,
          "command": "codex", "args": [], "cwd": "." }
      ]
    }
  ],
  "projects": [
    {
      "targetId": "sample-workspace",
      "path": "C:\\workspaces\\sample-workspace\\sample-project",
      "presetId": "windows-ai",
      "additionalItems": []
    }
  ]
}
```

- `presets[].id`: file全体で一意。既存のprofile/item ID規則と同じ安全な文字だけ
- `presets[].platform`: `windows` / `wsl` / `any`。Windows projectはWindows専用presetと
  `any`だけ、WSL projectはWSL専用presetと`any`だけを参照できる（片方専用のpresetを
  もう片方から使うことはできない）
- `presets[].items`: 内容はversion 1のitemと同じ規則（`kind`、`command`/`args`分離、
  相対`cwd`、`EDIT_ME`拒否等）
- `projects[].presetId`: 定義済みのpreset IDを指す。存在しないIDはschema errorになる
- `projects[].additionalItems`: そのprojectだけに追加するitem（`npm start`等、
  presetのitem IDとは衝突できない）。無ければ`[]`
- `projects[].itemOverrides`（任意）: presetのitemごとに`enabledByDefault`だけを
  上書きできる。`command`/`args`/`cwd`/`kind`/`label`の上書きは、共通化の意味を
  失いschemaも複雑になるため初版では用意していない。project固有のcommandが
  必要な場合は`additionalItems`へ追加する

```json
"itemOverrides": {
  "codex": { "enabledByDefault": false }
}
```

起動時の展開順は「preset items（itemOverridesがあれば`enabledByDefault`だけ反映）
→ additionalItems」。展開結果はversion 1のprofile/items相当の形へ正規化されるため、
VS Code workspace/task生成や起動APIはversion 1/2を区別せず同じ経路で動く
（起動方式自体は変更していない）。

#### localhostからのproject登録

未設定projectのDevelopment sessionカードに、適合するpresetの選択・内容preview・
`このプリセットで登録`ボタンが出る。requestは`targetId` / `path` / `presetId`の
識別子だけを受け付け、command/args/cwd/preset内容/label/kind/enabledByDefault/
additionalItems/itemOverridesをbrowserから指定することはできない。

登録APIは **agent-workbench serverが動くPC上のlocalhost（127.0.0.1 / ::1）からの
requestだけ**を許可する。判定はproxyを前提としない生の接続元アドレス
（`req.socket.remoteAddress`）で行い、`X-Forwarded-For`等の転送ヘッダは信用しない。
Content-Type: `application/json`を必須にし、`Origin`headerがある場合はhostと
一致するか確認する（大掛かりなCSRF防止機構ではなく、認証なしLAN運用での
最小限の配慮）。

LANの他端末（スマホ等）からは、preset一覧の閲覧と**既存の設定済みprojectの起動**は
従来どおり可能だが、新規project登録boutonは無効化され「project登録はWindows PCの
localhostから行ってください」と案内する。

設定ファイルの更新は、読み込み→再検証→追加→再検証→一時ファイルへのatomic書き込み
（`fs.rename`）という手順を、単純なmutexで直列化して行う。書き込み直前のファイルの
更新時刻が読み込み時と異なる場合は外部変更とみなして拒否し、`設定を再読み込み`から
やり直すよう案内する。更新前のファイルは最新1世代だけ`data/development-sessions.json.bak`
へbackupし、backupを増やし続けることはしない。

#### 設定済みprojectでの表示

presetを参照しているprojectでは、item一覧の上に`起動プリセット: <label>`と表示し、
「設定情報」内に`Preset ID`と（あれば）`additionalItems`のIDを表示する。
**既に設定済みのpresetをWeb UIから変更・登録解除する機能は無い**（誤操作の影響が
大きく、additionalItemsとの整合を壊しかねないため）。preset変更やproject登録解除は、
`設定ファイルをVS Codeで開く`から手動で行う。

#### version 1 → version 2 migration

既存のversion 1設定を無断で書き換えることはない。変換したい場合は付属のCLIを使う。

```powershell
# dry-run（既定）: 変換候補と検証結果を表示するだけで、ファイルは書き換えない
node scripts/migrate-development-sessions.js

# 検証が通った場合だけ、backupを取ってから書き換える
node scripts/migrate-development-sessions.js --write
```

- 変換前のversion 1設定自体がschema違反（`EDIT_ME`未編集等）の場合は、dry-run/write
  問わず変換しない。原因のissueをそのまま表示するので、設定ファイル側を直してから
  再実行する
- 変換は、同じproject内の実itemsが完全に一致するprojects同士だけで1つのpresetを
  共有する（platformが異なる場合は共有しない）。presetの名前・IDはitem labelから
  機械的に作るだけで、command/argsの内容は元の値をそのまま移すだけ（推測・変更はしない）
- `--write`前に、変換後の各projectの展開後itemsが変換前と完全に一致することを
  自動検証する。1件でも不一致なら書き込まない
- `--write`は元ファイルを`<file>.v1.bak`へbyte単位でbackupしてから、atomicに
  置き換える。問題があれば、このbackupを`data/development-sessions.json`へ戻せば
  元の状態に復元できる
- `--file=<path>`で対象ファイルを指定できる（既定は`data/development-sessions.json`）

### 設定エラーの読み方

JSON parse errorまたはschema errorがある場合、詳細画面のDevelopment sessionは
`Configuration error`状態になり、issueごとに次を表示する。

- **JSON path**: 例 `projects[0].profiles[0].items[0].command`
- **short code**: 例 `invalid-cwd`、`missing-default-profile`、`placeholder-command`
  （version 2固有: `duplicate-preset-id`、`preset-not-found`、`invalid-platform`、
  `platform-mismatch`、`additional-item-collision`、`item-override-unknown-item`）
- **message**: 人が読める説明
- **hint**: 分かる範囲での修正のヒント（無い場合もある）

JSON構文エラーの場合はできる範囲でline/columnも表示する。issueは複数同時に表示され、
stack traceやサーバーの内部パスは表示しない（詳細はサーバーログにだけ出す）。

### 未設定・照合不一致・invalid・configuredの違い

同じ「設定が使えない」状態でも、原因によって表示を分ける。ステータスバッジは
日本語（設定済み / 未設定 / Target IDが一致しません / Pathが一致しません / 設定エラー）で
表示する。

| 状態 | 意味 | 表示される主な情報 |
|---|---|---|
| 未設定 | `data/development-sessions.json`が無い、またはこのproject（targetId + path）の設定が無い | 未設定の案内、ひな形コピー（primary）、設定ファイルopen（secondary） |
| Target IDが一致しません | 正規化した`path`が一致するprojectがあるが、`targetId`が一致しない（表示labelを`targetId`に書いてしまった場合など） | 「設定のTarget ID」と「正しいTarget ID」を並べて表示 |
| Pathが一致しません | `targetId`が一致し、かつ設定済みpathの末尾セグメント（repoディレクトリ名）が閲覧中projectの名前と一致するprojectがあるが、`path`が一致しない | 「設定のPath」と「正しいPath」を並べて表示 |
| 設定エラー | JSON parse error、またはschema validation error | issueごとのJSON path / code / message / hint |
| 設定済み | 一致するprojectがschema上も正しく見つかった | profile一覧、item一覧、起動操作 |

**同じtargetIdに属する別projectの設定があるだけでは、Pathが一致しませんにはしない。**
`repo-directories`型targetでは同じtargetIdに多数のprojectが属するため（例:
`sample-workspace`配下に`sample-project`と`agent-workbench`が両方ある）、片方だけ
設定済みでも、もう片方は素直に「未設定」になる。Pathが一致しませんと判定するのは、
設定済みpathの末尾ディレクトリ名が閲覧中projectの名前と一致する場合だけで、
それ以外は診断の正確性を優先してnot-configuredへ寄せる。

設定ファイル全体が invalid でも、閲覧中のprojectについて分かる範囲でmismatchの
ヒントを出すことがある（診断専用の読み取りであり、実行はしない）。**Development session
の開始は設定済み状態のときだけ有効になる。invalidな設定や、未設定・mismatch状態から
起動することはない。**

### 常用操作と設定補助の切り替え

設定済みprojectでは、`Development sessionを開始` / `VSCodeだけ開く`を主役にし、
`Target ID` / `Path`と`project設定ひな形をコピー` / `設定ファイルをVS Codeで開く` /
`設定を再読み込み`は「設定情報」の折りたたみへ収め、初期状態では閉じておく。

未設定・mismatch・invalid状態では、使えない`Development sessionを開始`ボタンを
大きなdisabled表示のままにせず、非表示にする。代わりに`project設定ひな形をコピー`
（mismatch時は`正しいproject設定ひな形をコピー`）をprimary、`設定ファイルをVS Codeで開く`を
secondary、`設定を再読み込み`と`VSCodeだけ開く`をtertiaryとして表示する。`設定情報`は
このときTarget ID / Pathの参照用として初期展開される。

### 設定ファイルをVS Codeで開く

`設定ファイルをVS Codeで開く`は、対象を`data/development-sessions.json`固定にした
POST APIで、requestからpathもeditorも受け取らない。VS Codeの固定検出・
`spawn(executable, [file], { shell: false })`という既存の安全な起動処理を再利用しており、
`open-vscode`（project folderを開く）とは別のAPIになっている。ファイルがまだ無い場合は
起動せず、作成手順（exampleコピー、またはひな形コピー→貼り付け）を案内する。

### VS Code workspace / Tasks

起動時に、選択itemだけを含むworkspaceを次へ生成・更新する。

```text
data/generated-workspaces/<safe-target-id>/<project-path-hash>/<profile-id>.code-workspace
```

生成先はagent-workbench側のGit管理外directoryで、各project repoへ`.vscode/tasks.json`や
`.code-workspace`を追加しない。taskは`type: process`、commandとargsを別fieldにし、
`presentation.panel: dedicated`でitemごとに別の統合ターミナルを使う。
`runOptions.runOn: folderOpen`でworkspaceを開いた時に起動し、task単位のinstance limitも1にする。

- Windows project: local folderを持つworkspaceを固定`Code.exe`へ`--new-window`で渡す
- WSL project: folderを`vscode-remote://wsl+<distro>/<linux path>` URIにし、生成workspaceを
  `wslpath`でLinux pathへ変換して`--remote wsl+<distro>`で開く。taskのcommand/cwd/PATHは
  Remote WSL側で解決する
- 初回はVS CodeのWorkspace TrustとAutomatic Tasksの許可を求められる場合がある。
  安全機構は無効化していないため、内容を確認してVS Code側で許可する
- APIはVS Code process終了を待たず、spawn成功で応答する
- 同じproject/profileのrequestは8秒間重複拒否する。task側もinstance limit 1だが、既に
  起動済みのserver/agentを完全検出する機能ではない
- 起動済みprocessの停止・kill機能はない。終了は各VS Code terminalで行う

### 起動APIの制限

- requestは`path`と`targetId`だけを受け付け、command / executable / args等の
  追加fieldは拒否する（`open-vscode`）。session開始は加えて`profileId`と`itemIds`だけを
  受け付け、command / args / cwd / executableその他のfieldを拒否する
- 現在のscan cacheに同じpathが存在し、targetIdも一致する場合だけ許可する。
  session itemは検証済みローカル設定に存在するIDだけを許可する
- Windowsでは既知のVS Codeインストール位置にある`Code.exe`だけを解決し、
  `spawn(executable, args, { shell: false })`で起動する。shell、cmd.exe、
  PowerShell、任意実行ファイル、任意引数は使用しない
- WSL projectは`\\wsl.localhost\<distro>\...`を既存の安全なparserで変換し、
  固定の`--folder-uri vscode-remote://wsl+<distro>/<linux path>`でRemote WSLを開く
- APIはVS Code processの終了を待たず、OSがprocessをspawnできた時点で応答する
- project未検出、target不一致、VS Code未検出、起動失敗を別codeで返し、
  error本文にprojectの個人pathを含めない
- `/api/development-sessions/open-config`はrequest bodyを受け付けない（空である
  ことだけを確認する）。開く対象はserver側で固定した`data/development-sessions.json`
  一択で、pathやeditorをrequestから指定する余地はない。起動処理自体は
  `open-vscode`と同じ固定`Code.exe`検出・`shell: false`を再利用する
- ひな形コピー（project設定ひな形 / 新規設定ファイル全体）はブラウザ側だけで完結し、
  serverへ何も送らない。コピー内容にはAPI key・token・passwordの類を含めない
- `/api/development-sessions/register-preset`（preset登録・設定ファイル書き込み）は
  `targetId` / `path` / `presetId`だけを受け付け、それ以外のfieldを拒否する。
  **localhost（127.0.0.1 / ::1）からのrequestだけ**を許可し、LANの他端末からは
  403で拒否する。詳細は「起動プリセット（version 2）> localhostからのproject登録」参照

通常の低優先度FBはGmail下書きへ蓄積する。急ぐFBは通常のCopy AI Handoffでpurposeを
`FB調査`にしてChatGPTへFB本文と一緒に貼り、方針決定後にDevelopment sessionを開始して
ChatGPTの指示をClaude Code / Codexへ貼る。agent-workbenchはGmail、ChatGPT、agent、
FB本文を管理せず、projectの現在地と開発環境の再現を担当する。

## PROGRESS.md の Markdown / Plain text 表示（Phase 4-B / 4-C）

project詳細欄の PROGRESS.md 表示は、**Markdown 表示**と**Plain text 表示**を
切り替えられる（切替UIは PROGRESS.md タイトルの横）。

- **デフォルトは Markdown 表示**。見出し（# 〜 ####）・箇条書き（`- item`）・
  fenced code block（\`\`\` 〜 \`\`\`）・inline code（`` `code` ``）・
  bold（`**text**`）・水平線（`---`）・**単純な Markdown table**
  （`| A | B |` ヘッダ行 + `|---|---|` セパレータ行 + データ行）に対応した
  **軽量な内蔵レンダラ**で描画する（**完全な Markdown 互換ではない**。
  セル結合・複数行セル・ネストしたMarkdown・GitHub拡張記法などは非対応）
- **箇条書きはネスト（`  - item` のようなインデント）にも対応**。
  2スペース・4スペースいずれのインデント幅でも、前の項目との相対的な
  増減で階層を判定するため、複数段のネストも `<ul><li>` の入れ子として
  表示される。dogfoodingで「ネスト箇条書きが段落内に生テキストのまま
  残る」というFBがあり、読みやすさを改善するために対応した
  （順序付きリストは非対応）
- **PROGRESS.md は末尾だけを抜粋して表示するため、抜粋の先頭が
  fenced code block の途中から始まることがある**（孤立した閉じ `` ``` `` だけが
  残る）。レンダラはこれを検出して読み飛ばし、以降の見出し・箇条書きなどが
  誤ってコードブロックに飲み込まれないようにしている
- **外部Markdownライブラリは使わない**。npm依存・bundlerは追加せず、
  `public/app.js` 内の数十行の関数だけで実装している
- **HTMLは必ずescapeしてから描画する**。PROGRESS.md本文に生のHTMLタグが
  含まれていても、そのままDOMに挿入されることはない（XSS対策）
- Plain text に切り替えると、従来どおり等幅フォントでの整形済みテキスト表示に戻る
- 表示モードの選択は `localStorage` に保存され、次回起動時も復元される
- PROGRESS.md 表示欄は、**詳細ペインの左側（パス〜Agent context/Command hints/
  Runtime helper cardまで）と正確に同じ高さまで伸びる**（`align-items: stretch`
  で右ペインが左ペインの実高さに追従）。下限480pxだけを設けており、極端に低い
  画面でも読みやすい範囲に収まる。800px以下の狭い画面では360px固定に戻る。
  内容は欄内だけでスクロールする
  - 調整の経緯: 当初「左ペインと完全同高」にしたところ縦に大きくなりすぎた →
    上限（clamp）だけで高さを決め打ちしたところ、今度は左ペインより大きく短くなり
    右側に空白が残った → 「左ペインの高さに追従しつつ、下限/上限で暴走を防ぐ」
    （下限480px・上限75vh）方式に落ち着いた → その後Phase 5-A以降、左ペインに
    Agent context・Command hints・Runtime helper card等が加わって左ペインが
    大きく伸びるようになった結果、右ペインが上限75vhで頭打ちになり、右下に
    大きな空白ができる不具合（Phase 5-F follow-up）が再発 → **上限を撤廃**し、
    下限480pxのみで左ペインの実高さに正確に追従する方式へ調整した
- Agent context markdown欄のMarkdown previewも、固定320px上限だと内部スクロール
  が出やすかったため、画面の高さに応じた上限（`55vh`）に調整した
  （Phase 5-F follow-up）
- 一覧テーブルは `table-layout: fixed` で列幅を固定しているため、
  Markdown ⇄ Plain text を切り替えても**上部の repo 一覧テーブルの列幅は変わらない**
  （切替前は、詳細行の内容が変わることで一覧テーブルの列幅が揺れる問題があった）

## target / status の複数選択フィルタと target テキスト絞り込み（Phase 4-D）

ツールバーの `target:` と `status:` は、単一選択のセレクトではなく、
ボタンを押すとチェックボックス一覧が開く**複数選択フィルタ**になっている
（vanilla JSのシンプルな実装で、外部UIライブラリは使わない）。

- **target 複数選択**: 何も選ばなければ全target表示。1つ以上選ぶと、
  選んだtargetのいずれかに一致するproject**のみ**表示する（**OR条件**）
- **status 複数選択**: 同様に、manual statusを複数選べる（**OR条件**）。
  未選択なら全status表示
- **target テキスト絞り込み**: targetパネル内の入力欄に文字列を入れると、
  **target表示名またはtarget id**への**部分一致**（大文字小文字区別なし）で
  絞り込む。空文字なら絞り込みなし
  - 例: `wsl` → `wsl_agent` / `wsl wsl-workspace` など
  - 例: `private` → `private` / `wsl private` など
- **他フィルタとの組み合わせ**: target複数選択・status複数選択・target
  テキストは、既存の git / PROGRESS / remote status フィルタ・ソート・
  プリセットと**すべてAND条件**で組み合わさる
- **プリセットとの関係**: target系フィルタ（複数選択・テキスト）は、既存の
  単一target選択と同じ方針で「プリセットとは独立した範囲の絞り込み」として
  扱い、プリセット適用時にリセットしない。status複数選択は、既存の単一status
  選択と同じ扱いでプリセット適用時にリセットされる
- **有効性の見た目**: ボタンには `target: 2件選択` のように件数・テキストが
  表示され、何か選択中は色を変えて強調する
- **localStorage**: 選択中target一覧・選択中status一覧・targetテキストは
  表示状態として保存・復元される（キーを `agentWorkbench.viewState.v8` に更新。
  v7以前の単一選択文字列も1件の配列として自動的に引き継がれる）
- **Copy AI Handoff / PROGRESS.md の Markdown表示は変更していない**

## 一覧画面の使い方（Phase 1-B）

- **ソート**: 列ヘッダ（repo / status / git / latest commit / 放置 / 変更）をクリックで並べ替え。
  再クリックで昇順/降順切り替え。初期表示は latest commit の新しい順（コミットの無いrepoは末尾）
- **フィルタ**: テーブル上のツールバーで絞り込み
  - git: すべて / clean以外 / dirty / untracked / error / no git
  - status: 手動ステータス（複数選択。Phase 4-D参照）
  - PROGRESS: PROGRESS.md の有無
  - target: 複数選択・テキスト絞り込み（Phase 4-D参照）
- **放置列**: 最新コミットからの経過日数（today / N days / unknown）。
  7日以上は黄、30日以上は赤で表示
- **行の強調**: clean でないrepoは左端に色付きアクセント（dirty=赤 / untracked=黄 / error=紫 / no git=灰）
- **再スキャン**: ボタン押下中は `Scanning...` 表示。完了後にヘッダへ `Last scanned: yyyy-mm-dd hh:mm:ss`

## スマホ表示とPWA（Phase 6-C）

800px以下は、PC情報を縦積みにするのではなく、日常的な状態確認と引き継ぎを
優先するモバイルワークスペースとして表示する。PC幅では従来の高密度テーブル、
10個の集計カード、Targets、全フィルタ、Scan historyを維持する。

- ヘッダーはアプリ名と再スキャンを同じ行、Last scannedを小さい2行目に配置
- 上部集計は `repos / Attention / Active / Dogfooding / Dirty` の1つの
  コンパクトサマリーにする。全内訳はPC表示に残す
- Targetsは「スキャン詳細」として初期折りたたみ。閉じたままでもtarget数、
  total、error数を確認でき、error / very slowは強調する。Scan historyも初期閉
- 常用フィルタはAll / Attention / Active / Dogfooding / Dirtyの横スクロールchip、
  repo名検索、表示件数。target / git / status / PROGRESS / remote /
  No-remote auditは「詳細フィルター」へまとめる。既存条件とlocalStorage保存は維持
- projectカードはrepo名、manual/git status、target、branch、短縮hash、更新時期、
  40px角の個別更新だけを常時表示する。remote、commit subject、変更内訳、
  README/PROGRESS有無、scan診断は詳細へ移した
- カード全体で詳細を開閉でき、個別更新は先にイベント処理して選択と競合しない

### mobile詳細画面（Phase 3）

PC Phase 2で確定した情報構造（Always → Resume → Handoff →
Documents/Context/Diagnostics）は**同じDOMをそのまま使う**。mobile専用の
別DOM・別routeは作らず、CSSと最小限のJSで表示方式だけを切り替える。

- **Compact overview**: Always overview（project名・manual status・
  branch・Git clean/dirty・freshness・Next action・Runtime helper・
  Development session CTA）をそのまま使う。長いtarget名・branch名・commit
  messageはellipsisではなく折り返しで横スクロールを防ぐ（PC表示は無変更）
- **Resume**: Resume summary（保存された作業コンテキスト・note閲覧）を
  そのまま常時表示する
- **Quick actions**: Development session開始・Runtime helper・Handoffは
  いずれもAlways/Resume直下の元の位置のまま。新しい別ブロックへは
  再配置していない（PC DOMの複製・再構成を避けたため）。Runtime cardの
  Check/Open系操作ボタンはmobileで44px以上・縦積みにした
- **Detail accordions**: PCの`Documents / Context / Diagnostics`タブは、
  mobileでは**独立して開閉できる3つのaccordion**にする
  （`.mobile-accordion-toggle` + `.detail-panel.mobile-open`）。PC幅では
  この3ボタンをCSSで非表示にし、代わりに従来どおり`.detail-tabs`（排他的な
  tab切替）を使う。逆にmobile幅では`.detail-tabs`自体を非表示にし、
  3つのaccordionだけをnavigationとして使う
  - 初期状態は**3つともclosed**（first viewportを短くする）
  - 複数同時openを許容する（1つ開くと他が閉じる、という制約はない）
  - `mobileAccordionOpen`はPCの`openPanel`/`hidden`属性とは完全に独立した
    stateで、project切替時に全てclosedへ戻し、同じprojectの再描画
    （Rescan後等）では維持する
  - Documents accordionを開くと、PC Phase 2と同じ`[PROGRESS] [README]`
    sub-tab構造がそのまま入っている（初期README・README本文は初期closed。
    `documentsSubView`/`readmeExpanded`もPCと共有するstateで、挙動は
    「表示情報の出典・鮮度」節・「PC詳細画面下部のtab」節のとおり）
  - Context accordionは既存のContext panel（閲覧/編集分離・Auto-fill・
    Save・Cancel・未保存編集保持）をそのまま格納する
  - Diagnostics accordionは既存のDiagnostics panel（Repository/Scan/
    Development session settings）をそのまま格納する
- **resize**: このアプリはwindow resizeを監視するJSを持たない
  （`window.matchMedia`のchange監視は`#scan-details`/`#advanced-filters`
  という別の既存機能のみ）。PC⇄mobileの表示切り替えは100% CSSの
  `@media (max-width: 800px)`だけで行われるため、`openPanel`・
  `documentsSubView`・`readmeExpanded`・`mobileAccordionOpen`・Context
  編集中の内容は、どちらの表示方式が有効かに関わらず常にJS側に保持されたまま
  になる。resizeでどちらかのstateが失われることはない
- READMEは折りたたみ、PROGRESSはMarkdown/Plain text切替を維持する。
  Markdown tableとcode blockだけはブロック内で横スクロールできる

### PWA

`manifest.webmanifest`、192/512pxアイコン、service workerを同梱し、対応する
Android Chromeではホーム画面追加・standalone起動を行える構成にしている。
`start_url`と`scope`は`/`、アプリ名はAgent Workbenchである。

この画面は最新project状態を扱うため、service workerは`/api/*`とHTMLを
キャッシュしない。CSS/JS/アイコンだけをnetwork-firstで更新し、通信失敗時に限って
静的キャッシュへ戻る。**完全オフライン対応ではなく、オフライン時に古い
project状態を正常値として表示することは保証しない。**

ブラウザの完全なPWAインストールとservice workerはsecure context（HTTPSまたは
localhost）が前提になる。LANのHTTP接続ではChromeのバージョンや設定により
ホーム画面ショートカット扱いになる場合がある。Android実機でのインストールと
standalone起動は環境ごとに確認すること。

スマホから使う場合も起動方法は上記「LANアクセス」と同じで、必要な時だけ
`AGENT_WORKBENCH_HOST=0.0.0.0`を明示する。PWA化しても認証は追加されないため、
信頼できる自宅LAN内だけで使用し、公共Wi-Fi、会社ネットワーク、インターネットへ
直接公開しない。Windows Firewallは自動変更しない。

現時点ではAndroidネイティブアプリを作らず、状態確認、project選択、
Runtime helper、Copy AI Handoff、README/PROGRESS参照をPWAでdogfoodingする。
push通知、バックグラウンド監視、OS共有メニュー、生体認証・資格情報管理、
LAN外からの安全な接続、またはPWAでは不足する操作性が必要になった場合にだけ
ネイティブアプリを再検討する。

## 複数target表示（Phase 2-A）

- 一覧に **target列**（sample-workspace / secondary-workspace / wsl-workspace）と **kind**
  （repo / no-git / missing / error。repo以外はgit列にバッジ表示）を追加
- ツールバーに **targetフィルタ** を追加（選択肢は実データから自動生成）。
  targetはプリセットとは独立した「範囲」の絞り込みで、プリセットを押しても維持される
- 表示状態の保存キーは `agentWorkbench.viewState.v2` に更新（v1からは自動引き継ぎ）

## 表示状態の保存とプリセット（Phase 1-C）

- **表示状態の保存**: ソートキー・ソート方向・各フィルタ・選択中プリセットを
  `localStorage`（キー: `agentWorkbench.viewState.v1`）に保存し、リロード後に復元。
  保存値が壊れていても初期状態に戻るだけで画面は落ちない
- **プリセットボタン**（ツールバー左端）
  - `All`: 全repo表示
  - `Attention`: clean でない repo、または status が active / dogfooding の repo（複合条件）。
    ただし status が `abandoned` の repo は、clean でなくても対象から除外する
    （Phase 4-F follow-up。「もう追わない」と判断済みのnoiseを出さないため。
    abandonedを見たい場合はstatus filterで明示的に選ぶ）
  - `Active` / `Dogfooding`: 各 manual status のみ
  - `Dirty`: clean でない repo のみ
  - Attention 以外は既存フィルタの組み合わせに展開されるため、フィルタUIと常に一致する。
    Attention は選択中ボタンのハイライトで明示され、フィルタを手動変更すると解除される
- **詳細表示の改善**: パスはクリックで全選択できる枠付き表示、タグはチップ表示、
  commit は message 強調＋経過日数併記、working tree はバッジ表示

## MVPでやること

- リポジトリスキャン（branch / 最新commit / working tree状態 / tags / README・PROGRESS有無）
- PROGRESS.md 末尾抜粋（最大80行、大きいファイルは末尾のみ読む）
- 手動ステータス（active / dogfooding / paused / abandoned / released / unknown）と note の保存
- サマリー＋一覧テーブル＋行クリックで詳細展開のUI

## 今回やらないこと

- AI API連携（OpenAI / Anthropic）
- DB導入
- Electron / Tauri
- React / Vue / Next.js
- 他リポジトリへの書き込み・git操作（読み取り専用）
