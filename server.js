'use strict';

const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const express = require('express');
const { scanTargets, scanRepo, computeCommitsAhead } = require('./lib/scanner');
const {
  authorizeVscodeProject,
  launchProjectInVscode,
  launchWorkspaceInVscode,
} = require('./lib/vscode-launcher');
const {
  AsyncMutex,
  DevelopmentSessionError,
  DevelopmentSessionStore,
  RecentLaunchGuard,
  availablePresetsForProject,
  buildProjectIdentity,
  diagnoseProjectMatch,
  findProjectConfig,
  generatedWorkspacePath,
  isLoopbackAddress,
  launchKey,
  loadDevelopmentSessionsDiagnostic,
  publicProjectSession,
  readRawConfigForUpdate,
  registerPresetProject,
  resolveConfiguredSelection,
  validateRegisterPresetRequest,
  validateStartRequest,
  writeConfigFileAtomic,
  writeGeneratedWorkspace,
} = require('./lib/development-sessions');

// デフォルトはlocalhost限定（安全側）。LANアクセスしたい場合だけ
// AGENT_WORKBENCH_HOST=0.0.0.0 のように明示指定する（README「LANアクセス」参照）。
// 自動でLAN公開はしない。PORT/HOSTは既存の汎用env var名も後方互換で受け付ける
const PORT = process.env.AGENT_WORKBENCH_PORT || process.env.PORT || 37891;
const HOST = process.env.AGENT_WORKBENCH_HOST || process.env.HOST || '127.0.0.1';
// 読み込み優先順位: roots.local.json（本命・git管理外）→ roots.json（互換fallback）→ デフォルト
const CONFIG_FILES = [
  { file: path.join(__dirname, 'config', 'roots.local.json'), source: 'roots.local.json' },
  { file: path.join(__dirname, 'config', 'roots.json'), source: 'roots.json' },
];
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'projects.json');
const HISTORY_FILE = path.join(DATA_DIR, 'scan-history.json');
const CONTEXT_FILE = path.join(DATA_DIR, 'project-context.json');
const DEVELOPMENT_SESSIONS_FILE = path.join(DATA_DIR, 'development-sessions.json');
const GENERATED_WORKSPACES_DIR = path.join(DATA_DIR, 'generated-workspaces');
const SCAN_HISTORY_LIMIT = 50; // 保持する履歴件数（古いものから削除）

const VALID_STATUSES = ['active', 'dogfooding', 'paused', 'abandoned', 'released', 'unknown'];
// remotePlan / 旧visibility: Phase 3-D/3-E で追加した手動分類フィールド。
// Phase 3-F でUIから廃止（置き場所/remote status/statusと重複し分かりづらいため）。
// ここでは古い data/projects.json やクライアントとの互換のためだけに残す
// （legacy/internal compatibility only。現在のUIはこのフィールドを表示・送信しない）
const VALID_REMOTE_PLANS = [
  'unknown', 'public-candidate', 'local-only', 'private', 'move-to-private', 'paused', 'abandoned',
];

// 設定が読めないときのフォールバック（従来のMVP相当）
const DEFAULT_TARGETS = [
  {
    id: 'current-directory',
    label: 'current directory',
    path: process.cwd(),
    type: 'repo-directories',
    enabled: true,
  },
];

let scanCache = null; // { scannedAt, repos, configErrors }
const developmentSessionStore = new DevelopmentSessionStore(DEVELOPMENT_SESSIONS_FILE);
const developmentSessionLaunchGuard = new RecentLaunchGuard();

// Phase 6: preset登録（設定ファイル書き込み）はlocalhostからのrequestだけを許可する。
// req.ipではなくreq.socket.remoteAddressを直接見る（isLoopbackAddress参照）
function isLocalhostRequest(req) {
  return isLoopbackAddress(req.socket && req.socket.remoteAddress);
}
const developmentSessionWriteMutex = new AsyncMutex();

// 設定を優先順に読む。壊れていても落とさず、エラーは configErrors として返す
async function loadTargets() {
  const configErrors = [];
  for (const { file, source } of CONFIG_FILES) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (e) {
      continue; // 無ければ次の候補へ（エラー扱いにしない）
    }
    try {
      const conf = JSON.parse(text);
      if (!conf || !Array.isArray(conf.targets) || conf.targets.length === 0) {
        configErrors.push({ error: `config/${source}: targets is empty or invalid, skipped` });
        continue;
      }
      return { targets: conf.targets, configSource: source, configErrors };
    } catch (e) {
      configErrors.push({ error: `config/${source}: parse error, skipped` });
    }
  }
  configErrors.push({ error: 'no usable config found, using defaults (copy config/roots.example.json to config/roots.local.json)' });
  return { targets: DEFAULT_TARGETS, configSource: 'default', configErrors };
}

async function loadManual() {
  try {
    const text = await fsp.readFile(DATA_FILE, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

async function saveManual(manual) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(manual, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

function normalizePath(p) {
  return path.resolve(p).toLowerCase();
}

// manual status/note/remotePlan を project にマージする（全体scan・個別rescan共通）
function applyManualOverlay(repo, manualByPath) {
  const m = manualByPath[normalizePath(repo.path)] || {};
  return {
    ...repo,
    manualStatus: VALID_STATUSES.includes(m.status) ? m.status : 'unknown',
    note: typeof m.note === 'string' ? m.note : '',
    // remotePlan があれば優先。無ければ旧フィールド visibility を読み替える（互換移行）
    remotePlan: VALID_REMOTE_PLANS.includes(m.remotePlan)
      ? m.remotePlan
      : VALID_REMOTE_PLANS.includes(m.visibility)
      ? m.visibility
      : 'unknown',
    manualUpdatedAt: m.updatedAt || null,
  };
}

async function loadManualByPath() {
  const manual = await loadManual();
  const manualByPath = {};
  for (const [key, value] of Object.entries(manual)) {
    manualByPath[normalizePath(key)] = value;
  }
  return manualByPath;
}

// ---- Project agent context / command hints（data/project-context.json・git管理外）---
// Phase 5-A: 各projectの作業文脈（agent context）とVSCode内ターミナル等で使う
// 起動・確認コマンドのヒント（command hints）を保存する。コマンドの直接実行は行わない。

async function loadContext() {
  try {
    const text = await fsp.readFile(CONTEXT_FILE, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

async function saveContext(context) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = CONTEXT_FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(context, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, CONTEXT_FILE);
}

async function loadContextByPath() {
  const context = await loadContext();
  const contextByPath = {};
  for (const [key, value] of Object.entries(context)) {
    contextByPath[normalizePath(key)] = value;
  }
  return contextByPath;
}

// 保存済みAgent contextのmetadata（保存時HEAD等）と現在のrepo状態を比べ、
// current/stale/unknownを判定する。git操作は行わない（string比較のみ。
// commitsAheadのような重い判定はrescan-one側でだけ計算する）
function computeSavedContextFreshness(metadata, repo) {
  const savedHead = metadata && typeof metadata.headHash === 'string' ? metadata.headHash : null;
  const currentHead = repo.commit && repo.commit.hash ? repo.commit.hash : null;
  if (!savedHead || !currentHead) return 'unknown';
  return savedHead === currentHead ? 'current' : 'stale';
}

// agent context/command hints を project にマージする（全体scan・個別rescan共通）
// Phase 5-E以降は agentContextMarkdown（1つのMarkdownテキスト）が正。
// 旧4フィールド（agentContext.currentFocus等）は後方互換のため引き続き返す
// （古いdata/project-context.jsonしか無いprojectはクライアント側でMarkdownへ合成表示する）。
// 保存済みcontextがある場合だけ savedContext（鮮度metadata）を付与する。
// metadataが無い旧entryはfreshness: 'unknown'になる（エラーにしない・本文は書き換えない）
function applyContextOverlay(repo, contextByPath) {
  const c = contextByPath[normalizePath(repo.path)] || {};
  const ac = c.agentContext || {};
  const hasSavedContext = !!(c.agentContextMarkdown && c.agentContextMarkdown.trim()) ||
    !!(ac.currentFocus || ac.nextAction || ac.blockers || ac.lastHandoffNotes);
  const metadata = c.metadata && typeof c.metadata === 'object' ? c.metadata : null;
  const savedContext = hasSavedContext ? {
    savedAt: c.updatedAt || null,
    savedHeadHash: metadata ? metadata.headHash || null : null,
    savedHeadSubject: metadata ? metadata.headSubject || null : null,
    savedBranch: metadata ? metadata.branch || null : null,
    freshness: computeSavedContextFreshness(metadata, repo),
    readmeChanged: metadata && metadata.readmeHash && repo.readmeHash
      ? metadata.readmeHash !== repo.readmeHash
      : null,
    progressChanged: metadata && metadata.progressHash && repo.progressHash
      ? metadata.progressHash !== repo.progressHash
      : null,
  } : null;
  return {
    ...repo,
    agentContext: {
      currentFocus: typeof ac.currentFocus === 'string' ? ac.currentFocus : '',
      nextAction: typeof ac.nextAction === 'string' ? ac.nextAction : '',
      blockers: typeof ac.blockers === 'string' ? ac.blockers : '',
      lastHandoffNotes: typeof ac.lastHandoffNotes === 'string' ? ac.lastHandoffNotes : '',
    },
    agentContextMarkdown: typeof c.agentContextMarkdown === 'string' ? c.agentContextMarkdown : '',
    commandHints: typeof c.commandHints === 'string' ? c.commandHints : '',
    contextUpdatedAt: c.updatedAt || null,
    savedContext,
  };
}

// Phase 5-B: repoのファイル構成（package.json/Cargo.toml/Gradle/requirements.txt）から
// command hints の候補を推定する。ファイルを読むだけで、コマンドの実行は一切行わない
async function readJsonSafe(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function existsFile(file) {
  try {
    await fsp.access(file);
    return true;
  } catch (e) {
    return false;
  }
}

async function detectCommandHints(repoPath) {
  const lines = [];

  const pkg = await readJsonSafe(path.join(repoPath, 'package.json'));
  if (pkg && pkg.scripts) {
    if (pkg.scripts.test) lines.push('Test | npm test');
    if (pkg.scripts.dev) lines.push('Dev server | npm run dev');
    if (pkg.scripts.start) lines.push('Start | npm start');
  }

  if (await existsFile(path.join(repoPath, 'Cargo.toml'))) {
    lines.push('Build | cargo build');
    lines.push('Test | cargo test');
    lines.push('Run | cargo run');
  }

  const buildGradlePath = path.join(repoPath, 'build.gradle');
  const buildGradleKtsPath = path.join(repoPath, 'build.gradle.kts');
  const hasGradle =
    (await existsFile(path.join(repoPath, 'gradlew'))) ||
    (await existsFile(path.join(repoPath, 'gradlew.bat'))) ||
    (await existsFile(buildGradlePath)) ||
    (await existsFile(buildGradleKtsPath));
  if (hasGradle) {
    lines.push('Build | ./gradlew build');
    let isAndroid = false;
    for (const p of [buildGradlePath, buildGradleKtsPath]) {
      try {
        const text = await fsp.readFile(p, 'utf8');
        if (/\bandroid\s*\{/.test(text) || text.includes('com.android')) {
          isAndroid = true;
          break;
        }
      } catch (e) {
        // ファイルが無い/読めない場合はAndroid判定をスキップ
      }
    }
    if (isAndroid) lines.push('Compile Kotlin | ./gradlew compileDebugKotlin');
  }

  if (await existsFile(path.join(repoPath, 'requirements.txt'))) {
    lines.push('Install deps | pip install -r requirements.txt');
  }

  lines.push('Open VSCode | code .');
  lines.push('Git status | git status');

  return [...new Set(lines)].join('\n');
}

// ---- スキャン履歴（data/scan-history.json・git管理外） ----------------------

async function loadHistory() {
  try {
    const parsed = JSON.parse(await fsp.readFile(HISTORY_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) return { version: 1, entries: parsed.entries };
  } catch (e) { /* 無い・壊れている場合は空から始める */ }
  return { version: 1, entries: [] };
}

// 1回のスキャン結果を履歴に追記する。失敗してもアプリは落とさず、エラー文字列を返す
async function appendHistory(entry) {
  try {
    const history = await loadHistory();
    history.entries.push(entry);
    if (history.entries.length > SCAN_HISTORY_LIMIT) {
      history.entries = history.entries.slice(-SCAN_HISTORY_LIMIT);
    }
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = HISTORY_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(history, null, 2) + '\n', 'utf8');
    await fsp.rename(tmp, HISTORY_FILE);
    return null;
  } catch (e) {
    return `scan history write failed: ${e.code || e.message}`;
  }
}

// 履歴から target別の簡易統計を計算する（disabled のサンプルは duration統計から除外）
function historyTargetStats(entries) {
  const byId = new Map();
  for (const entry of entries) {
    for (const t of entry.targets || []) {
      const key = t.targetId || t.targetLabel || '?';
      if (!byId.has(key)) {
        byId.set(key, {
          targetId: t.targetId, targetLabel: t.targetLabel,
          sampleCount: 0, disabledCount: 0,
          lastDurationMs: null, minDurationMs: null, maxDurationMs: null, avgDurationMs: null,
          lastReaddirMs: null, maxReaddirMs: null,
          slowCount: 0, verySlowCount: 0,
          _sum: 0,
        });
      }
      const s = byId.get(key);
      s.targetLabel = t.targetLabel || s.targetLabel;
      if (t.status === 'disabled') {
        s.disabledCount++;
        continue;
      }
      s.sampleCount++;
      s._sum += t.durationMs || 0;
      s.lastDurationMs = t.durationMs ?? null;
      if (s.minDurationMs == null || t.durationMs < s.minDurationMs) s.minDurationMs = t.durationMs;
      if (s.maxDurationMs == null || t.durationMs > s.maxDurationMs) s.maxDurationMs = t.durationMs;
      if (typeof t.readdirMs === 'number') {
        s.lastReaddirMs = t.readdirMs;
        if (s.maxReaddirMs == null || t.readdirMs > s.maxReaddirMs) s.maxReaddirMs = t.readdirMs;
      }
      if ((t.durationMs || 0) >= 10000) s.verySlowCount++;
      else if ((t.durationMs || 0) >= 3000) s.slowCount++;
    }
  }
  return [...byId.values()].map((s) => {
    const { _sum, ...rest } = s;
    rest.avgDurationMs = s.sampleCount > 0 ? Math.round(_sum / s.sampleCount) : null;
    return rest;
  });
}

async function buildProjects(forceScan) {
  if (forceScan || !scanCache) {
    const startedAt = new Date();
    const { targets, configSource, configErrors } = await loadTargets();
    const result = await scanTargets(targets);
    const finishedAt = new Date();
    scanCache = {
      scannedAt: finishedAt.toISOString(),
      repos: result.repos,
      configSource,
      configErrors: [...configErrors, ...result.configErrors],
      scanSummary: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt - startedAt,
        targets: result.targetSummaries,
      },
      scanHistoryError: null,
    };
    // 履歴に追記（失敗しても落とさない）
    scanCache.scanHistoryError = await appendHistory({
      startedAt: scanCache.scanSummary.startedAt,
      finishedAt: scanCache.scanSummary.finishedAt,
      durationMs: scanCache.scanSummary.durationMs,
      configSource,
      projectCount: result.repos.length,
      targets: result.targetSummaries,
    });
  }
  const manualByPath = await loadManualByPath();
  const contextByPath = await loadContextByPath();
  const repos = scanCache.repos.map((repo) =>
    applyContextOverlay(applyManualOverlay(repo, manualByPath), contextByPath)
  );
  return {
    scannedAt: scanCache.scannedAt,
    scanRoot: repos.map((r) => r.targetPath).filter((v, i, a) => a.indexOf(v) === i).join(' | '),
    configSource: scanCache.configSource,
    configErrors: scanCache.configErrors,
    scanSummary: scanCache.scanSummary,
    scanHistoryError: scanCache.scanHistoryError || null,
    repos,
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/projects', async (req, res) => {
  try {
    res.json(await buildProjects(false));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/scan-history', async (req, res) => {
  try {
    const history = await loadHistory();
    res.json({
      entries: history.entries,
      summary: { targetStats: historyTargetStats(history.entries) },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/rescan', async (req, res) => {
  try {
    res.json(await buildProjects(true));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 個別project rescan（Phase 4-E）。全target/全projectを再読込せず、
// 指定した1 projectだけ git/README/PROGRESS/remote情報を再取得する。
// WSL targetのような遅いtargetでも、対象repoだけ更新したい場合に使う。
// Rescan projectが実際に何を再取得し、何が変わった/変わらなかったかを可視化する。
// updated/unchanged は再取得した「事実情報」のカテゴリだけを対象にする。
// excludedは常に固定リスト（保存済みcontext・手動status/note等）で、
// Rescanでは一切触らないことをUI側へ明示するためのもの
const RESCAN_EXCLUDED_CATEGORIES = [
  'savedAgentContext',
  'currentFocusNextActionBlockers',
  'manualStatus',
  'manualNote',
  'commandHints',
  'handoffPurpose',
];

function buildRescanResult(before, after) {
  const updated = [];
  const unchanged = [];
  const errors = [];

  const compare = (label, beforeValue, afterValue) => {
    if (beforeValue === afterValue) unchanged.push(label);
    else updated.push(label);
  };

  compare('headHash', before.commit && before.commit.hash, after.commit && after.commit.hash);
  compare('branch', before.branch, after.branch);
  compare('gitStatus', before.gitStatus, after.gitStatus);
  compare('modifiedCount', before.modifiedCount, after.modifiedCount);
  compare('untrackedCount', before.untrackedCount, after.untrackedCount);
  compare('tags', JSON.stringify(before.tags || []), JSON.stringify(after.tags || []));

  const readme = {
    reloaded: true,
    exists: !!after.hasReadme,
    changed: before.hasReadme && after.hasReadme ? before.readmeHash !== after.readmeHash : null,
  };
  if (after.hasReadme && after.readmeError) errors.push('readme-read-failed');

  const progress = {
    reloaded: true,
    exists: !!after.hasProgress,
    changed: before.hasProgress && after.hasProgress ? before.progressHash !== after.progressHash : null,
  };
  if (after.hasProgress && after.progressError) errors.push('progress-read-failed');

  if (after.kind === 'error') errors.push('git-scan-failed');

  return { updated, unchanged, excluded: RESCAN_EXCLUDED_CATEGORIES, errors, readme, progress };
}

app.post('/api/projects/rescan-one', async (req, res) => {
  try {
    const { path: repoPath, targetId } = req.body || {};
    if (!repoPath || typeof repoPath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    if (!scanCache) {
      return res.status(409).json({ error: 'no scan yet; call /api/rescan first' });
    }
    // path で一意特定する（同名projectが別targetにあっても絶対パスは重複しないため、
    // 表示名ではなくpathで照合する。targetIdが渡された場合は取り違え防止のため突き合わせる）
    const idx = scanCache.repos.findIndex((r) => normalizePath(r.path) === normalizePath(repoPath));
    if (idx === -1) {
      return res.status(404).json({ error: 'unknown repo path (rescan first)' });
    }
    const existing = scanCache.repos[idx];
    if (targetId && existing.targetId !== targetId) {
      return res.status(409).json({ error: 'targetId does not match the project at this path' });
    }

    // このprojectが属するtargetの設定（progressPath/remoteStatus）を現在のconfigから再取得する。
    // single-repo以外にはprogressPathを適用しない（既存のscanTargetsと同じ方針）
    const { targets } = await loadTargets();
    const targetConf = targets.find((t) => t && t.id === existing.targetId) || null;
    const options = { remoteStatus: !!(targetConf && targetConf.remoteStatus === true) };
    if (targetConf && targetConf.type === 'single-repo' && targetConf.progressPath) {
      options.progressPath = targetConf.progressPath;
    }

    const rescanned = await scanRepo(existing.path, options);
    const updated = {
      ...rescanned,
      targetId: existing.targetId,
      targetLabel: existing.targetLabel,
      targetPath: existing.targetPath,
    };
    scanCache.repos[idx] = updated;

    const rescanResult = buildRescanResult(existing, updated);

    const manualByPath = await loadManualByPath();
    const contextByPath = await loadContextByPath();
    const project = applyContextOverlay(applyManualOverlay(updated, manualByPath), contextByPath);

    // rescan-oneは1projectだけを対象にした重い処理を許容できるため、
    // ここでだけcommitsAhead（保存時HEADから現在HEADまでの件数）を計算する
    // （一覧全体のscanでは行わない。低速化防止のため）
    if (project.savedContext && project.savedContext.freshness === 'stale' &&
        project.savedContext.savedHeadHash && project.commit && project.commit.hash) {
      project.savedContext.commitsAhead = await computeCommitsAhead(
        project.path,
        project.savedContext.savedHeadHash,
        project.commit.hash
      );
    }

    res.json({ ok: true, project, rescanResult });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// FB development用の固定VS Code起動API。requestはscan済みprojectを特定する
// path + targetIdだけを受け付け、実際の起動引数にはscan cache側のpathを使う。
// executable・追加args・shell文字列は受け付けない。
app.post('/api/projects/open-vscode', async (req, res) => {
  const authorization = authorizeVscodeProject(scanCache, req.body);
  if (!authorization.ok) {
    return res.status(authorization.status).json({
      error: authorization.error,
      code: authorization.code,
    });
  }

  try {
    await launchProjectInVscode(authorization.project.path);
    res.json({
      ok: true,
      launched: true,
      location: 'server-windows-pc',
      projectKind: authorization.project.path.startsWith('\\\\wsl') ? 'wsl' : 'windows',
    });
  } catch (error) {
    const code = error && error.code === 'code-not-found' ? 'code-not-found' : 'launch-failed';
    const status = code === 'code-not-found' ? 503 : 500;
    res.status(status).json({
      error: error && error.message ? error.message : 'VS Code could not be started on the server PC.',
      code,
    });
  }
});

function sendDevelopmentSessionError(res, error) {
  const code = error && error.code ? error.code : 'development-session-error';
  const status = error && error.status
    ? error.status
    : code === 'code-not-found'
    ? 503
    : code === 'wsl-path-invalid'
    ? 422
    : 500;
  console.error('development session:', code, error && error.details ? error.details : '');
  const body = {
    error: error && error.message ? error.message : 'The development session could not be started.',
    code,
  };
  if (error instanceof DevelopmentSessionError && error.details.length > 0) {
    body.details = error.details;
  }
  res.status(status).json(body);
}

// Development session設定はserver側のローカルJSONだけから読み、ブラウザには
// 選択可能なprofile/itemと表示用commandだけを返す。commandの保存APIは持たない。
// 表示は診断用ロード（例外を投げない）だけを使い、not-configured / target-id
// mismatch / path mismatch / invalid / configured を区別する。実行許可は
// このresponseを一切信用せず、start-development-session側で厳格に再判定する。
app.get('/api/projects/development-session', async (req, res) => {
  try {
    const allowedFields = new Set(['path', 'targetId', 'reload']);
    const extraFields = Object.keys(req.query || {}).filter((key) => !allowedFields.has(key));
    if (extraFields.length > 0) {
      throw new DevelopmentSessionError(
        'unsupported-fields',
        'Only path, targetId, and reload are accepted.',
        400
      );
    }
    const authorization = authorizeVscodeProject(scanCache, {
      path: req.query.path,
      targetId: req.query.targetId,
    });
    if (!authorization.ok) {
      throw new DevelopmentSessionError(
        authorization.code,
        authorization.error,
        authorization.status
      );
    }
    if (req.query.reload === '1') {
      // 実行系(start-development-session)が使う共有cacheもここで同期させておく。
      // 表示だけ最新化してもDevelopment sessionを開始した瞬間に古い設定が
      // 使われることのないようにする。loadDevelopmentSessions は無効な設定で
      // 例外を投げるが、それはこの表示専用routeの診断結果を壊してよい理由には
      // ならない（診断はloadDevelopmentSessionsDiagnosticが常に例外を投げず返す）
      try {
        await developmentSessionStore.reload();
      } catch (error) {
        // 診断側のissue表示で十分カバーされるため、ここでは無視する
      }
    }

    const identity = buildProjectIdentity(authorization.project);
    const diagnostic = await loadDevelopmentSessionsDiagnostic(DEVELOPMENT_SESSIONS_FILE);
    const match = diagnoseProjectMatch(diagnostic, authorization.project);

    if (match.state === 'configured') {
      const projectConfig = findProjectConfig({ projects: diagnostic.projects }, authorization.project);
      const session = publicProjectSession(projectConfig);
      const workspacePath = generatedWorkspacePath(
        GENERATED_WORKSPACES_DIR,
        authorization.project,
        session.defaultProfileId
      );
      let workspaceGenerated = true;
      try {
        await fsp.access(workspacePath);
      } catch (error) {
        workspaceGenerated = false;
      }
      return res.json({
        ok: true,
        identity,
        state: 'configured',
        ...session,
        workspaceGenerated,
        requiresVscodeApproval: true,
      });
    }
    if (match.state === 'target-id-mismatch') {
      return res.json({
        ok: true,
        identity,
        state: 'target-id-mismatch',
        configuredTargetId: match.configuredTargetId,
        looksLikeLabel: !!match.looksLikeLabel,
      });
    }
    if (match.state === 'path-mismatch') {
      return res.json({
        ok: true,
        identity,
        state: 'path-mismatch',
        configuredPath: match.configuredPath,
      });
    }
    if (match.state === 'invalid') {
      return res.json({
        ok: true,
        identity,
        state: 'invalid',
        issues: match.issues,
      });
    }
    return res.json({
      ok: true,
      identity,
      state: 'not-configured',
      reason: match.reason,
      // Phase 5: このprojectのplatformに適合する起動プリセットだけを返す。
      // 登録可否（localhostか否か）はUI側の案内文言・button活性化に使う
      availablePresets: availablePresetsForProject(diagnostic, authorization.project),
      canRegister: isLocalhostRequest(req),
    });
  } catch (error) {
    sendDevelopmentSessionError(res, error);
  }
});

// Phase 6: 既存の起動プリセット（presets[]）とscan済みprojectを結びつけるだけの
// 登録API。command/args/cwd/preset内容はrequestから一切受け取らない。
// - localhost（127.0.0.1 / ::1）以外からのrequestは拒否する
// - JSON Content-Typeを必須にし、Originがある場合はHostと一致させる
//   （認証が無いLAN運用でも、意図しないページ経由のPOSTを軽減するための
//   最小限の配慮。大掛かりなCSRF frameworkは導入しない）
// - 設定ファイルの読み込み→再検証→追加→再検証→atomic書き込みは
//   mutexで直列化し、書き込み直前のmtimeが読み込み時と異なれば拒否する
app.post('/api/development-sessions/register-preset', async (req, res) => {
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({
      error: 'project登録はserver PCのlocalhostから行ってください。',
      code: 'localhost-only',
    });
  }
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return res.status(415).json({
      error: 'Content-Type: application/json が必要です。',
      code: 'invalid-content-type',
    });
  }
  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch (error) { originHost = null; }
    if (!originHost || originHost !== req.headers.host) {
      return res.status(403).json({
        error: 'Originがこのserverと一致しません。',
        code: 'origin-mismatch',
      });
    }
  }

  try {
    const { project, presetId } = validateRegisterPresetRequest(scanCache, req.body);
    await developmentSessionWriteMutex.run(async () => {
      const { raw, mtimeMs } = await readRawConfigForUpdate(DEVELOPMENT_SESSIONS_FILE);
      const nextRaw = registerPresetProject(raw, project, presetId);
      await writeConfigFileAtomic(DEVELOPMENT_SESSIONS_FILE, nextRaw, { expectedMtimeMs: mtimeMs });
    });
    try {
      await developmentSessionStore.reload();
    } catch (error) {
      // 表示は次回のGET（診断経路）で再取得されるため、ここでの失敗は致命的ではない
    }
    res.json({ ok: true, registered: true, targetId: project.targetId, presetId });
  } catch (error) {
    sendDevelopmentSessionError(res, error);
  }
});

// 固定path（data/development-sessions.json）だけをVS Codeで開く。requestからは
// pathもeditorも受け取らない。既存の固定Code.exe検出・shell:falseの起動処理を再利用する。
app.post('/api/development-sessions/open-config', async (req, res) => {
  const extraFields = Object.keys(req.body || {});
  if (extraFields.length > 0) {
    return res.status(400).json({
      error: 'This endpoint does not accept a request body.',
      code: 'unsupported-fields',
    });
  }
  try {
    await fsp.access(DEVELOPMENT_SESSIONS_FILE);
  } catch (error) {
    return res.status(404).json({
      error: 'data/development-sessions.json does not exist yet.',
      code: 'config-file-missing',
      message: 'Copy the template below into a new data/development-sessions.json, or run: Copy-Item data\\development-sessions.example.json data\\development-sessions.json',
    });
  }
  try {
    await launchProjectInVscode(DEVELOPMENT_SESSIONS_FILE);
    res.json({ ok: true, launched: true, location: 'server-windows-pc' });
  } catch (error) {
    const code = error && error.code === 'code-not-found' ? 'code-not-found' : 'launch-failed';
    const status = code === 'code-not-found' ? 503 : 500;
    res.status(status).json({
      error: error && error.message ? error.message : 'VS Code could not be started on the server PC.',
      code,
    });
  }
});

// Requestはscan済みproject/profile/item IDだけを受け付ける。実際の
// command/args/cwdは検証済みローカル設定から解決し、生成workspaceへJSON出力する。
app.post('/api/projects/start-development-session', async (req, res) => {
  let guardKey = null;
  try {
    const project = validateStartRequest(scanCache, req.body);
    const state = await developmentSessionStore.get();
    if (state.status === 'missing') {
      throw new DevelopmentSessionError(
        'config-file-missing',
        'Development session configuration does not exist.',
        404
      );
    }
    const selection = resolveConfiguredSelection(
      state.config,
      project,
      req.body.profileId,
      req.body.itemIds
    );
    guardKey = launchKey(project, selection.profile.id);
    developmentSessionLaunchGuard.begin(guardKey);
    const generated = await writeGeneratedWorkspace(
      GENERATED_WORKSPACES_DIR,
      project,
      selection.profile,
      selection.items
    );
    await launchWorkspaceInVscode(generated.workspacePath, project.path);
    res.json({
      ok: true,
      launched: true,
      location: 'server-windows-pc',
      projectKind: project.path.startsWith('\\\\wsl') ? 'wsl' : 'windows',
      profileId: selection.profile.id,
      itemIds: selection.items.map((item) => item.id),
      requiresVscodeApproval: true,
    });
  } catch (error) {
    if (guardKey && (!error || error.code !== 'duplicate-launch')) {
      developmentSessionLaunchGuard.clear(guardKey);
    }
    sendDevelopmentSessionError(res, error);
  }
});

app.post('/api/projects/status', async (req, res) => {
  try {
    const { path: repoPath, status, note } = req.body || {};
    // remotePlan が正式フィールド。visibility しか無い古いリクエストも後方互換で受け付ける
    const remotePlanInput = req.body && req.body.remotePlan !== undefined
      ? req.body.remotePlan
      : req.body && req.body.visibility;
    if (!repoPath || typeof repoPath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    if (remotePlanInput !== undefined && !VALID_REMOTE_PLANS.includes(remotePlanInput)) {
      return res.status(400).json({ error: `remotePlan must be one of: ${VALID_REMOTE_PLANS.join(', ')}` });
    }
    // スキャン済みprojectのみ受け付ける（任意パスの書き込み防止）
    const known = (scanCache ? scanCache.repos : []).find(
      (r) => normalizePath(r.path) === normalizePath(repoPath)
    );
    if (!known) {
      return res.status(404).json({ error: 'unknown repo path (rescan first)' });
    }

    const manual = await loadManual();
    const prev = manual[known.path] || {};
    // 既存値は remotePlan があればそちら優先、無ければ旧 visibility を読み替える
    const prevRemotePlan = VALID_REMOTE_PLANS.includes(prev.remotePlan)
      ? prev.remotePlan
      : VALID_REMOTE_PLANS.includes(prev.visibility)
      ? prev.visibility
      : 'unknown';
    manual[known.path] = {
      status: status !== undefined ? status : prev.status || 'unknown',
      note: note !== undefined ? String(note) : prev.note || '',
      // 未指定なら既存値を維持（後方互換）。保存時は remotePlan に一本化し、古い visibility は残さない
      remotePlan: remotePlanInput !== undefined ? remotePlanInput : prevRemotePlan,
      updatedAt: new Date().toISOString(),
    };
    await saveManual(manual);
    res.json({ ok: true, path: known.path, saved: manual[known.path] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Project agent context / command hints の保存（Phase 5-A）。
// コマンドの直接実行は行わない。あくまでメモとヒントの保存・Handoffへの反映のみ。
app.post('/api/projects/context', async (req, res) => {
  try {
    const { path: repoPath, targetId, agentContext, agentContextMarkdown, commandHints } = req.body || {};
    if (!repoPath || typeof repoPath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    // スキャン済みprojectのみ受け付ける（任意パスの書き込み防止）
    const known = (scanCache ? scanCache.repos : []).find(
      (r) => normalizePath(r.path) === normalizePath(repoPath)
    );
    if (!known) {
      return res.status(404).json({ error: 'unknown repo path (rescan first)' });
    }
    // 同名projectが別targetに存在しうるため、targetIdが渡された場合は取り違え防止のため突き合わせる
    if (targetId && known.targetId !== targetId) {
      return res.status(409).json({ error: 'targetId does not match the project at this path' });
    }

    const context = await loadContext();
    const prev = context[known.path] || {};
    const prevAgentContext = prev.agentContext || {};
    const ac = agentContext || {};
    context[known.path] = {
      // 旧4フィールドは後方互換のため保持する（Phase 5-E以降のクライアントは送らないので既存値維持）
      agentContext: {
        currentFocus: typeof ac.currentFocus === 'string' ? ac.currentFocus : (prevAgentContext.currentFocus || ''),
        nextAction: typeof ac.nextAction === 'string' ? ac.nextAction : (prevAgentContext.nextAction || ''),
        blockers: typeof ac.blockers === 'string' ? ac.blockers : (prevAgentContext.blockers || ''),
        lastHandoffNotes: typeof ac.lastHandoffNotes === 'string' ? ac.lastHandoffNotes : (prevAgentContext.lastHandoffNotes || ''),
      },
      // Phase 5-E: 1つのMarkdownテキストを正とする
      agentContextMarkdown: typeof agentContextMarkdown === 'string'
        ? agentContextMarkdown
        : (typeof prev.agentContextMarkdown === 'string' ? prev.agentContextMarkdown : ''),
      commandHints: typeof commandHints === 'string' ? commandHints : (prev.commandHints || ''),
      updatedAt: new Date().toISOString(),
      // 保存時点のrepo状態（鮮度判定用）。値はすべてserver側のscanCache（known）から
      // 算出する。requestからmetadataを受け取ることはない（信用しない）
      metadata: {
        headHash: known.commit ? known.commit.hash : null,
        headSubject: known.commit ? known.commit.message : null,
        branch: known.branch || null,
        readmeHash: known.readmeHash || null,
        progressHash: known.progressHash || null,
      },
    };
    await saveContext(context);
    res.json({ ok: true, path: known.path, saved: context[known.path] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Phase 5-B: Auto-fill用のcommand hints候補検出。repo内のpackage.json/Cargo.toml/
// Gradle/requirements.txtを読むだけで、外部AI APIは使わず、コマンドの実行も行わない。
app.get('/api/projects/detect-commands', async (req, res) => {
  try {
    const repoPath = req.query.path;
    const targetId = req.query.targetId;
    if (!repoPath || typeof repoPath !== 'string') {
      return res.status(400).json({ error: 'path is required' });
    }
    const known = (scanCache ? scanCache.repos : []).find(
      (r) => normalizePath(r.path) === normalizePath(repoPath)
    );
    if (!known) {
      return res.status(404).json({ error: 'unknown repo path (rescan first)' });
    }
    if (targetId && known.targetId !== targetId) {
      return res.status(409).json({ error: 'targetId does not match the project at this path' });
    }
    const commandHints = await detectCommandHints(known.path);
    res.json({ ok: true, commandHints });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Runtime helper card用の限定ping。127.0.0.1:8787/ping への固定GETのみを行う。
// 任意URLへのアクセスは行わない・token/receiver.config.jsonは一切参照しない
// （外部runtime側のtoken付きエンドポイントには触れず、無認証の/pingだけを見る）。
// server起動/停止はagent-workbenchからは行わない（このAPIは確認専用）
function pingRuntimeHelperServer() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = http.get(
      { host: '127.0.0.1', port: 8787, path: '/ping', timeout: 2000 },
      (res) => {
        const responseMs = Date.now() - startedAt;
        res.resume(); // bodyは使わないので破棄する
        resolve({
          status: res.statusCode && res.statusCode < 500 ? 'running' : 'error',
          httpStatus: res.statusCode,
          responseMs,
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'error', responseMs: Date.now() - startedAt, error: 'timeout' });
    });
    req.on('error', (e) => {
      const status = e.code === 'ECONNREFUSED' ? 'not-running' : 'error';
      resolve({ status, responseMs: Date.now() - startedAt, error: e.code || String(e.message || e) });
    });
  });
}

app.get('/api/runtime/ping', async (req, res) => {
  res.json(await pingRuntimeHelperServer());
});

app.listen(PORT, HOST, async () => {
  console.log(`agent-workbench: http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`listening on ${HOST}:${PORT} (LAN accessible — trusted networks only, no auth)`);
  }
  try {
    const result = await buildProjects(true); // 起動時に初回スキャンを済ませておく
    console.log(`config source: ${result.configSource}`);
    console.log(`initial scan done: ${result.repos.length} projects`);
    for (const err of result.configErrors) {
      console.warn('config warning:', JSON.stringify(err));
    }
  } catch (e) {
    console.error('initial scan failed:', e.message || e);
  }
});
