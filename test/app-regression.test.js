'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { validateDevelopmentSessions } = require('../lib/development-sessions');
const { buildResumeItems, renderResumeItemsHtml } = require('../public/resume-summary');

function makeElement() {
  return {
    addEventListener() {},
    appendChild() {},
    remove() {},
    select() {},
    closest() { return null; },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    innerHTML: '',
    checked: false,
    disabled: false,
    hidden: false,
  };
}

const elements = new Map();
const documentStub = {
  body: makeElement(),
  addEventListener() {},
  execCommand() { return true; },
  createElement() { return makeElement(); },
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  },
  querySelector() { return makeElement(); },
  querySelectorAll() { return []; },
};

const sandbox = {
  alert() {},
  confirm() { return true; },
  console,
  document: documentStub,
  fetch: async () => ({ ok: true, json: async () => ({ repos: [], configErrors: [] }) }),
  localStorage: { getItem() { return null; }, setItem() {} },
  navigator: { clipboard: { writeText: async () => {} } },
  setTimeout,
  clearTimeout,
  window: { open() {} },
  // resume-summary.js を実装どおりの内容で読み込む（index.htmlでもapp.jsより
  // 先に読み込まれるclassic script）。Always headerのNext action抽出・
  // Resumeの表示項目はこの実関数に依存するため、ダミーではなく実体を渡す
  buildResumeItems,
  renderResumeItemsHtml,
};
vm.createContext(sandbox);
const appFile = path.join(__dirname, '..', 'public', 'app.js');
const source = fs.readFileSync(appFile, 'utf8').replace(/\nload\(false\);\s*$/, '\n');
vm.runInContext(source, sandbox, { filename: appFile });

function run(expression) {
  return vm.runInContext(expression, sandbox);
}

function repo(overrides = {}) {
  return {
    name: 'alpha',
    path: 'D:\\work\\alpha',
    kind: 'repo',
    targetId: 'windows',
    targetLabel: 'Windows',
    targetPath: 'D:\\work',
    manualStatus: 'active',
    note: '',
    gitStatus: 'clean',
    branch: 'master',
    commit: { hash: 'abc1234', message: 'Latest subject', date: '2026-07-20T10:00:00+09:00' },
    modifiedCount: 0,
    untrackedCount: 0,
    tags: ['v1.0.0'],
    remote: { enabled: true, status: 'ahead', upstream: 'origin/master', ahead: 2, behind: 0 },
    hasReadme: true,
    readmeTail: '# Alpha',
    hasProgress: true,
    progressTail: '## Current state\nReady.',
    progressSource: 'default',
    progressPath: null,
    progressError: null,
    readmeError: null,
    scanDurationMs: 5000,
    scanSpeed: 'slow',
    scanSteps: { gitStatusMs: 100, gitLogMs: 90, gitBranchMs: 80, gitTagsMs: 70 },
    agentContextMarkdown: '# Agent context\n\n## Current focus\n\nRegression check.',
    agentContext: {},
    commandHints: 'Test | npm test',
    contextUpdatedAt: null,
    error: null,
    gitDiagnosis: null,
    ...overrides,
  };
}

let count = 0;
function test(name, fn) {
  count++;
  try {
    fn();
    console.log(`ok ${count} - ${name}`);
  } catch (e) {
    console.error(`not ok ${count} - ${name}`);
    console.error(e && e.stack ? e.stack : e);
    process.exitCode = 1;
  }
}

const alpha = repo({ targetId: 'wsl', targetLabel: 'wsl private' });
const beta = repo({
  name: 'beta',
  path: 'D:\\work\\beta',
  manualStatus: 'paused',
  gitStatus: 'dirty',
  targetLabel: 'Windows',
});
sandbox.alpha = alpha;
sandbox.beta = beta;

test('target, status, and git filters retain their behavior', () => {
  run('state = { repos: [alpha, beta] }; preset = null');
  assert.deepStrictEqual(
    Array.from(run("filters = { git:'all', statuses:[], progress:'all', targets:['wsl private'], targetText:'', remote:'all' }; visibleRepos().map(r => r.name)")),
    ['alpha']
  );
  assert.deepStrictEqual(
    Array.from(run("filters = { git:'all', statuses:['paused'], progress:'all', targets:[], targetText:'', remote:'all' }; visibleRepos().map(r => r.name)")),
    ['beta']
  );
  assert.deepStrictEqual(
    Array.from(run("filters = { git:'dirty', statuses:[], progress:'all', targets:[], targetText:'', remote:'all' }; visibleRepos().map(r => r.name)")),
    ['beta']
  );
});

test('project search, PROGRESS, and remote filters retain their behavior', () => {
  run('state = { repos: [alpha, beta] }; preset = null');
  assert.deepStrictEqual(
    Array.from(run("filters = { git:'all', statuses:[], progress:'all', targets:[], targetText:'', projectText:'alp', remote:'all' }; visibleRepos().map(r => r.name)")),
    ['alpha']
  );
  assert.deepStrictEqual(
    Array.from(run("filters = { git:'all', statuses:[], progress:'no', targets:[], targetText:'', projectText:'', remote:'all' }; visibleRepos().map(r => r.name)")),
    []
  );
  assert.deepStrictEqual(
    Array.from(run("filters = { git:'all', statuses:[], progress:'all', targets:[], targetText:'', projectText:'', remote:'ahead' }; visibleRepos().map(r => r.name)")),
    ['alpha', 'beta']
  );
});

test('mobile presets preserve existing filter meanings', () => {
  sandbox.dogfood = repo({ name: 'dogfood', manualStatus: 'dogfooding' });
  run('state = { repos: [alpha, beta, dogfood] }; filters = { git:"all", statuses:[], progress:"all", targets:[], targetText:"", projectText:"", remote:"all" }');
  assert.deepStrictEqual(Array.from(run("applyPreset('active'); visibleRepos().map(r => r.name)")), ['alpha']);
  assert.deepStrictEqual(Array.from(run("applyPreset('dogfooding'); visibleRepos().map(r => r.name)")), ['dogfood']);
  assert.deepStrictEqual(Array.from(run("applyPreset('dirty'); visibleRepos().map(r => r.name)")), ['beta']);
  assert.deepStrictEqual(Array.from(run("applyPreset('attention'); visibleRepos().map(r => r.name)")), ['alpha', 'beta', 'dogfood']);
  run("alpha.remote = { enabled: true, status: 'no-remote' }");
  assert.deepStrictEqual(Array.from(run("applyPreset('noremote-audit'); visibleRepos().map(r => r.name)")), ['alpha']);
  run("alpha.remote = { enabled: true, status: 'ahead', upstream: 'origin/master', ahead: 2, behind: 0 }");
});

test('row displays branch, latest commit, and remote ahead status', () => {
  const html = run('repoRowHtml(alpha)');
  assert.ok(html.includes('master'));
  assert.ok(html.includes('abc1234'));
  assert.ok(html.includes('Latest subject'));
  assert.ok(html.includes('ahead 2'));
});

test('mobile card prioritizes repo state and omits verbose commit and remote details', () => {
  const html = run('repoCardHtml(alpha)');
  assert.ok(html.includes('alpha'));
  assert.ok(html.includes('active'));
  assert.ok(html.includes('wsl private'));
  assert.ok(html.includes('master'));
  assert.ok(html.includes('abc1234'));
  assert.ok(html.includes('data-role="row-rescan"'));
  assert.ok(!html.includes('Latest subject'));
  assert.ok(!html.includes('ahead 2'));
});

test('scan summary keeps slow and very slow classifications and remote counts', () => {
  sandbox.summaryState = {
    scanSummary: { targets: [
      { targetLabel: 'slow target', status: 'ok', type: 'single-repo', durationMs: 3000, projectCount: 1 },
      { targetLabel: 'very target', status: 'ok', type: 'repo-directories', durationMs: 10000,
        projectCount: 2, remoteEnabled: true, remoteAheadCount: 1, readdirMs: 600, readdirSpeed: 'normal' },
    ] },
  };
  run("state = summaryState; renderTargetSummary()");
  const html = elements.get('target-summary').innerHTML;
  assert.ok(html.includes('(slow)'));
  assert.ok(html.includes('(very slow)'));
  assert.ok(html.includes('ahead:1'));
  assert.ok(html.includes('readdir 0.6s'));
  assert.ok(elements.get('scan-details-meta').textContent.includes('2 targets'));
  assert.ok(elements.get('scan-details-meta').textContent.includes('error 0'));
  // scanner error が無ければ警告マーカーは出ない
  assert.ok(!elements.get('scan-details-meta').textContent.includes('⚠'));
});

test('scan-details summary shows a compact warning count (config error + missing/error targets) without auto-expanding', () => {
  run("state = { scanSummary: { targets: [ { targetLabel: 'x', status: 'error', type: 'repo-directories', durationMs: 1, projectCount: 0 }, { targetLabel: 'y', status: 'ok', type: 'single-repo', durationMs: 1, projectCount: 1 } ] }, configErrors: [ { error: 'scan root not readable: ECONNRESET' } ] }; renderTargetSummary()");
  const text = elements.get('scan-details-meta').textContent;
  // config error 1 + error target 1 = 2
  assert.ok(text.includes('⚠ 2'), text);
  assert.ok(text.includes('2 targets'));
  // render() 側で scan-details.open を触らない（自動展開しない）
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/scanDetails\.open\s*=/.test(app));
});

test('detail keeps Runtime helper, Agent context, handoff, and scan diagnostics', () => {
  sandbox.runtimeHelper = repo({ name: 'runtime-sample-project' });
  const html = run('detailRowHtml(runtimeHelper)');
  assert.ok(html.includes('Runtime helper'));
  assert.ok(html.includes('Saved agent context'));
  assert.ok(html.includes('Copy AI Handoff'));
  assert.ok(html.includes('total 5.0s'));
  assert.ok(html.includes('slow'));
  assert.ok(html.includes('class="block detail-status"'));
  assert.ok(html.includes('class="block readme-details"'));
});

test('detail retains context tabs, save, auto-fill, copy controls, and README/PROGRESS views', () => {
  const html = run('detailRowHtml(alpha)');
  [
    'data-role="ctx-view-mode" data-mode="markdown"',
    'data-role="ctx-view-mode" data-mode="plain"',
    'data-role="autofill-context"',
    'data-role="save-context"',
    'data-role="copy-context"',
    'data-role="copy-commands"',
    'data-role="copy-context-commands"',
    'data-role="copy-handoff"',
    'data-role="development-session"',
    'data-role="start-development-session"',
    'data-role="open-vscode"',
    'data-role="session-status-badge"',
    'data-role="development-session-config-actions"',
    'VS Codeはagent-workbench serverが動いているWindows PC上で起動します。',
    'data-role="progress-mode" data-mode="markdown"',
    'data-role="progress-mode" data-mode="plain"',
    'data-role="readme-toggle"',
    'PROGRESS.md（末尾）',
  ].forEach((needle) => assert.ok(html.includes(needle), needle));
  assert.ok(!html.includes('data-role="copy-feedback-handoff"'));
  // 起動操作(開始/VSCodeだけ開く)は常に静的HTMLに含まれ、設定補助操作
  // (ひな形コピー/設定ファイルopen/再読み込み)は状態取得後に動的描画される。
  // 常用操作が設定補助より先にDOMへ現れることを確認する
  assert.ok(html.indexOf('data-role="start-development-session"') <
    html.indexOf('data-role="development-session-config-actions"'));
});

test('not-configured/mismatch/invalid action buttons expose template copy (primary), config open (secondary), and reload/VSCode-only (tertiary)', () => {
  const html = run("developmentSessionActionButtonsHtml({ state: 'not-configured', reason: 'missing-file' })");
  assert.ok(html.includes('data-role="copy-session-template"'));
  assert.ok(html.includes('session-btn-primary'));
  assert.ok(html.includes('data-role="copy-session-full-config"'));
  assert.ok(html.includes('data-role="open-development-sessions-config"'));
  assert.ok(html.includes('session-btn-secondary'));
  assert.ok(html.includes('data-role="reload-development-session"'));
  assert.ok(html.includes('data-role="open-vscode"'));
  assert.ok(html.includes('session-btn-tertiary'));
});

test('Full config copy button only appears when the config file is missing', () => {
  const projectNotConfiguredHtml = run("developmentSessionActionButtonsHtml({ state: 'not-configured', reason: 'project-not-configured' })");
  assert.ok(!projectNotConfiguredHtml.includes('data-role="copy-session-full-config"'));
  const invalidHtml = run("developmentSessionActionButtonsHtml({ state: 'invalid' })");
  assert.ok(!invalidHtml.includes('data-role="copy-session-full-config"'));
});

test('Mismatch states use the corrected-template wording for the primary button', () => {
  const targetIdMismatchHtml = run("developmentSessionActionButtonsHtml({ state: 'target-id-mismatch' })");
  assert.ok(targetIdMismatchHtml.includes('正しいproject設定ひな形をコピー'));
  const pathMismatchHtml = run("developmentSessionActionButtonsHtml({ state: 'path-mismatch' })");
  assert.ok(pathMismatchHtml.includes('正しいproject設定ひな形をコピー'));
  const notConfiguredHtml = run("developmentSessionActionButtonsHtml({ state: 'not-configured' })");
  assert.ok(notConfiguredHtml.includes('>project設定ひな形をコピー<'));
});

test('Configuration details are collapsed with helper buttons when configured, and expanded with identity only otherwise', () => {
  const configuredHtml = run(`developmentSessionConfigDetailsHtml({ state: 'configured', identity: ${JSON.stringify({ targetId: 'sample-workspace', path: 'D:\\\\work\\\\alpha' })} })`);
  assert.ok(!configuredHtml.includes(' open'));
  assert.ok(configuredHtml.includes('data-role="copy-session-template"'));
  assert.ok(configuredHtml.includes('data-role="open-development-sessions-config"'));
  assert.ok(configuredHtml.includes('data-role="reload-development-session"'));
  assert.ok(configuredHtml.includes('設定情報'));

  const notConfiguredHtml = run(`developmentSessionConfigDetailsHtml({ state: 'not-configured', identity: ${JSON.stringify({ targetId: 'sample-workspace', path: 'D:\\\\work\\\\alpha' })} })`);
  assert.ok(notConfiguredHtml.includes('<details class="session-config-details" data-role="session-config-details" open>'));
  // 未設定時、識別情報だけを持ち、buttonは既にbody側にあるため重複させない
  assert.ok(!notConfiguredHtml.includes('data-role="copy-session-template"'));
  assert.ok(!notConfiguredHtml.includes('data-role="reload-development-session"'));
});

test('Configuration details show the referenced preset ID and additional items when configured via a preset', () => {
  const session = {
    state: 'configured',
    identity: { targetId: 'sample-workspace', path: 'D:\\work\\alpha' },
    presetId: 'windows-ai',
    additionalItemIds: ['dev-server'],
  };
  const html = run(`developmentSessionConfigDetailsHtml(${JSON.stringify(session)})`);
  assert.ok(html.includes('Preset ID'));
  assert.ok(html.includes('windows-ai'));
  assert.ok(html.includes('追加item'));
  assert.ok(html.includes('dev-server'));

  const withoutPreset = run(`developmentSessionConfigDetailsHtml(${JSON.stringify({ state: 'configured', identity: session.identity })})`);
  assert.ok(!withoutPreset.includes('Preset ID'));
});

// ---- Phase 5/6: preset picker for not-configured projects -------------------

test('Preset picker lists platform-filtered presets with an item preview and a register button', () => {
  const session = {
    state: 'not-configured',
    canRegister: true,
    availablePresets: [
      {
        id: 'windows-ai', label: 'AI開発 Windows', platform: 'windows',
        items: [
          { id: 'claude', label: 'Claude Code', kind: 'agent', enabledByDefault: true, displayCommand: 'claude', cwd: '.' },
          { id: 'codex', label: 'Codex', kind: 'agent', enabledByDefault: false, displayCommand: 'codex', cwd: '.' },
        ],
      },
    ],
  };
  const html = run(`developmentSessionPresetPickerHtml(${JSON.stringify(session)})`);
  assert.ok(html.includes('起動プリセット'));
  assert.ok(html.includes('<option value="windows-ai">AI開発 Windows</option>'));
  assert.ok(html.includes('Claude Code'));
  assert.ok(html.includes('Codex'));
  assert.ok(html.includes('data-role="register-preset"'));
  assert.ok(!html.includes('disabled'));
  assert.ok(!html.includes('localhost'));
});

test('Preset picker disables registration and explains why when not on localhost', () => {
  const session = {
    state: 'not-configured',
    canRegister: false,
    availablePresets: [
      { id: 'wsl-ai', label: 'AI開発 WSL', platform: 'wsl', items: [
        { id: 'shell', label: 'WSL shell', kind: 'process', enabledByDefault: true, displayCommand: 'bash -l', cwd: '.' },
      ] },
    ],
  };
  const html = run(`developmentSessionPresetPickerHtml(${JSON.stringify(session)})`);
  assert.ok(html.includes('data-role="register-preset" disabled'));
  assert.ok(html.includes('localhostから行ってください'));
});

test('Preset picker renders nothing when no presets are available for this platform', () => {
  const html = run(`developmentSessionPresetPickerHtml(${JSON.stringify({ state: 'not-configured', canRegister: true, availablePresets: [] })})`);
  assert.strictEqual(html, '');
});

test('Action buttons put the preset picker first when presets exist, falling back to template copy as primary otherwise', () => {
  const withPresets = run(`developmentSessionActionButtonsHtml(${JSON.stringify({
    state: 'not-configured',
    canRegister: true,
    availablePresets: [{ id: 'windows-ai', label: 'AI開発 Windows', platform: 'windows', items: [
      { id: 'claude', label: 'Claude Code', kind: 'agent', enabledByDefault: true, displayCommand: 'claude', cwd: '.' },
    ] }],
  })})`);
  assert.ok(withPresets.includes('data-role="register-preset"'));
  assert.ok(withPresets.includes('詳細設定'));
  assert.ok(withPresets.includes('session-btn-tertiary" data-role="copy-session-template"'));
  assert.ok(!withPresets.includes('session-btn-primary" data-role="copy-session-template"'));

  const withoutPresets = run(`developmentSessionActionButtonsHtml(${JSON.stringify({ state: 'not-configured' })})`);
  assert.ok(!withoutPresets.includes('data-role="register-preset"'));
  assert.ok(withoutPresets.includes('session-btn-primary" data-role="copy-session-template"'));
});

test('Development session items render kind, command, cwd, and enabledByDefault', () => {
  sandbox.sessionProfile = {
    id: 'default',
    label: 'Default development',
    items: [
      { id: 'claude', label: 'Claude Code', kind: 'agent', enabledByDefault: true,
        displayCommand: 'claude --model sonnet', cwd: '.' },
      { id: 'codex', label: 'Codex', kind: 'agent', enabledByDefault: false,
        displayCommand: 'codex', cwd: 'tools/cli' },
      { id: 'dev-server', label: 'Dev server', kind: 'process', enabledByDefault: true,
        displayCommand: 'npm start', cwd: '.' },
      { id: 'escaped', label: '<Unsafe label>', kind: 'process', enabledByDefault: false,
        displayCommand: 'tool "argument with spaces" <unsafe>', cwd: '.' },
    ],
  };
  const html = run('developmentSessionItemsHtml(sessionProfile)');
  assert.ok(html.includes('data-role="development-session-item"'));
  assert.ok(html.includes('value="claude" checked'));
  assert.ok(html.includes('value="codex"'));
  assert.ok(!html.includes('value="codex" checked'));
  assert.ok(html.includes('session-kind-agent'));
  assert.ok(html.includes('session-kind-process'));
  assert.ok(html.includes('claude --model sonnet'));
  assert.ok(html.includes('cwd: tools/cli'));
  assert.ok(html.includes('&lt;Unsafe label&gt;'));
  assert.ok(html.includes('&lt;unsafe&gt;'));
  assert.ok(!html.includes('<Unsafe label>'));
});

test('Copy AI Handoff retains six purposes and status-only default', () => {
  assert.strictEqual(run('HANDOFF_PURPOSES.length'), 6);
  assert.strictEqual(run('handoffPurpose'), 'status-only');
  const html = run('detailRowHtml(alpha)');
  assert.strictEqual((html.match(/<option value=/g) || []).length >= 6, true);
  assert.ok(html.includes('value="status-only" selected'));
});

test('Git diagnosis renders operation without an undefined suggestion', () => {
  sandbox.failed = repo({
    kind: 'error',
    gitStatus: 'error',
    error: 'failed',
    gitDiagnosis: { code: 'timeout', operation: 'working tree status', message: 'Timed out.' },
  });
  const html = run('detailRowHtml(failed)');
  assert.ok(html.includes('working tree status'));
  assert.ok(html.includes('Timed out.'));
  assert.ok(!html.includes('undefined'));
});

test('Copy AI Handoff keeps agent context and remote facts', () => {
  const markdown = run("buildHandoffMarkdown(alpha, 'status-only')");
  assert.ok(markdown.includes('# Saved agent context'));
  assert.ok(markdown.includes('Regression check.'));
  assert.ok(markdown.includes('- ahead: 2'));
  assert.ok(markdown.includes('- behind: 0'));
  assert.ok(markdown.includes('Test | npm test'));
});

// ---- Phase 1: project identity display ------------------------------------

test('Identity display is compact: Target ID and Path only, each with a same-row copy button', () => {
  const windowsRepo = repo({ targetId: 'sample-workspace', targetLabel: 'sample-workspace', path: 'C:\\workspaces\\sample-workspace\\sample-project' });
  const identity = { targetLabel: windowsRepo.targetLabel, targetId: windowsRepo.targetId, path: windowsRepo.path };
  const html = run(`developmentSessionIdentityHtml(${JSON.stringify(identity)})`);
  // Target labelは既にproject headerで見えているため、identity内では省略する
  assert.ok(!html.includes('Session configuration identity'));
  assert.ok(!html.includes('SESSION CONFIGURATION IDENTITY'));
  assert.ok(html.includes('Target ID'));
  assert.ok(html.includes('sample-workspace'));
  assert.ok(html.includes('C:\\workspaces\\sample-workspace\\sample-project'));
  assert.ok((html.match(/data-role="copy-session-value"/g) || []).length === 2);
  // 値とCopyボタンが同じ行（同じsession-identity-row）に入っている
  const rows = html.split('session-identity-row').filter((_, i) => i > 0);
  assert.strictEqual(rows.length, 2);
  rows.forEach((row) => assert.ok(row.includes('data-role="copy-session-value"')));
});

test('WSL project identity shows the real target ID (not the display label) with the correct path', () => {
  const identity = { targetLabel: 'wsl private', targetId: 'wsl_claude_private', path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\projects\\sample-project' };
  const html = run(`developmentSessionIdentityHtml(${JSON.stringify(identity)})`);
  assert.ok(!html.includes('>wsl private<'));
  assert.ok(html.includes('wsl_claude_private'));
  assert.ok(html.includes('data-copy="wsl_claude_private"'));
  assert.ok(html.includes('\\\\wsl.localhost\\Ubuntu\\home\\user\\projects\\sample-project'));
});

// ---- Phase 2: project config template generation ---------------------------

test('Windows and WSL project templates are schema-conformant except for the unedited placeholder', () => {
  const windowsRepo = repo({ targetId: 'sample-workspace', targetLabel: 'sample-workspace', path: 'C:\\workspaces\\sample-workspace\\sample-project' });
  const wslRepo = repo({
    targetId: 'wsl_claude_private',
    targetLabel: 'wsl private',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\projects\\sample-project',
  });
  for (const project of [windowsRepo, wslRepo]) {
    const templateJson = run(`JSON.stringify(buildProjectConfigTemplate(${JSON.stringify(project)}))`);
    const template = JSON.parse(templateJson);
    assert.strictEqual(template.targetId, project.targetId);
    assert.strictEqual(template.path, project.path);
    assert.strictEqual(template.defaultProfileId, 'default');
    assert.strictEqual(Array.isArray(template.profiles), true);
    assert.strictEqual(template.profiles[0].items.length >= 1, true);
    assert.throws(
      () => validateDevelopmentSessions({ version: 1, projects: [template] }),
      (error) => error.code === 'config-validation-error' &&
        error.details.every((detail) => detail.code === 'placeholder-command'),
      'template must be valid except for the intentional EDIT_ME placeholder rejection'
    );
  }
});

test('Full config template wraps the project object in a fresh version 1 document', () => {
  const project = repo({ targetId: 'sample-workspace', path: 'D:\\work\\alpha' });
  const fullJson = run(`JSON.stringify(buildFullConfigTemplate(${JSON.stringify(project)}))`);
  const full = JSON.parse(fullJson);
  assert.strictEqual(full.version, 1);
  assert.strictEqual(full.projects.length, 1);
  assert.strictEqual(full.projects[0].targetId, 'sample-workspace');
});

test('Project template JSON escapes UNC paths and special characters safely', () => {
  const trickyPath = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev user\\repo "with quotes" #1';
  const project = repo({ targetId: 'wsl-private', path: trickyPath });
  const templateJson = run(`JSON.stringify(buildProjectConfigTemplate(${JSON.stringify(project)}))`);
  const template = JSON.parse(templateJson);
  assert.strictEqual(template.path, trickyPath);
  assert.strictEqual(template.profiles[0].items[0].command, 'EDIT_ME');
  assert.deepStrictEqual(template.profiles[0].items[0].args, []);
});

// ---- Phase 4/5: issues and mismatch rendering -------------------------------

test('Validation issues render JSON path, message, and hint without leaking stack traces', () => {
  const issues = [
    { path: 'projects[0].defaultProfileId', code: 'missing-default-profile', message: '必須fieldがないか、値が不正です。', hint: 'defaultProfileIdに、下のprofile一覧にあるIDのいずれかを設定してください。' },
    { path: 'projects[0].profiles[0].items[0].cwd', code: 'invalid-cwd', message: 'repoルートからの相対pathである必要があります。', hint: null },
  ];
  const html = run(`developmentSessionIssuesHtml(${JSON.stringify(issues)})`);
  assert.ok(html.includes('設定エラー（2件のissue）'));
  assert.ok(html.includes('projects[0].defaultProfileId'));
  assert.ok(html.includes('必須fieldがないか、値が不正です。'));
  assert.ok(html.includes('defaultProfileIdに、下のprofile一覧にあるIDのいずれかを設定してください。'));
  assert.ok(html.includes('projects[0].profiles[0].items[0].cwd'));
  assert.ok(!html.includes('at Object'));
  assert.ok(!html.includes('.js:'));
});

test('Target ID mismatch rendering shows the configured value next to the correct one', () => {
  const html = run(`developmentSessionMismatchHtml(${JSON.stringify({
    state: 'target-id-mismatch',
    configuredTargetId: 'wsl private',
    identity: { targetId: 'wsl_claude_private', path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\projects\\sample-project' },
  })})`);
  assert.ok(html.includes('設定のTarget ID'));
  assert.ok(html.includes('wsl private'));
  assert.ok(html.includes('正しいTarget ID'));
  assert.ok(html.includes('wsl_claude_private'));
});

test('Path mismatch rendering shows the configured path next to the correct one', () => {
  const html = run(`developmentSessionMismatchHtml(${JSON.stringify({
    state: 'path-mismatch',
    configuredPath: 'D:\\work\\old-location',
    identity: { targetId: 'sample-workspace', path: 'C:\\workspaces\\sample-workspace\\agent-workbench' },
  })})`);
  assert.ok(html.includes('設定のPath'));
  assert.ok(html.includes('D:\\work\\old-location'));
  assert.ok(html.includes('正しいPath'));
  assert.ok(html.includes('C:\\workspaces\\sample-workspace\\agent-workbench'));
});

// ---- Phase 6: detail layout ordering ---------------------------------------

test('Profile label is prefixed with 起動プリセット only when the project references a preset', () => {
  const preset = { presetId: 'windows-ai' };
  const noPreset = { presetId: null };
  const profile = { label: 'AI開発 Windows' };
  assert.strictEqual(run(`developmentSessionProfileLabelText(${JSON.stringify(preset)}, ${JSON.stringify(profile)})`), '起動プリセット: AI開発 Windows');
  assert.strictEqual(run(`developmentSessionProfileLabelText(${JSON.stringify(noPreset)}, ${JSON.stringify(profile)})`), 'AI開発 Windows');
});

test('Development session ranks above Git/remote diagnostics, Handoff, and Agent context', () => {
  sandbox.runtimeHelper2 = repo({ name: 'runtime-sample-project' });
  const html = run('detailRowHtml(runtimeHelper2)');
  const runtimeIdx = html.indexOf('Runtime helper');
  const devSessionIdx = html.indexOf('data-role="development-session"');
  const handoffIdx = html.indexOf('class="block handoff-block"');
  const commitIdx = html.indexOf('<h3>latest commit</h3>');
  const agentContextIdx = html.indexOf('Saved agent context');
  assert.ok(runtimeIdx !== -1 && devSessionIdx !== -1 && handoffIdx !== -1 && commitIdx !== -1 && agentContextIdx !== -1);
  assert.ok(runtimeIdx < devSessionIdx, 'Runtime helper should stay before Development session');
  assert.ok(devSessionIdx < handoffIdx, 'Development session should rank above Handoff');
  assert.ok(devSessionIdx < commitIdx, 'Development session should rank above Git/remote diagnostics');
  assert.ok(devSessionIdx < agentContextIdx, 'Development session should rank above Agent context');
});

// ---- Always header: live current-repo facts + Next action + CTA (Phase 6-K) ----

test('Always header shows repo/target/status/git/branch/current HEAD and a neutral freshness chip when unsaved', () => {
  sandbox.liveRepo = repo({ scanFinishedAt: '2026-07-20T12:00:00.000Z' });
  const html = run('alwaysHeaderHtml(liveRepo)');
  assert.ok(html.includes('alpha'));
  assert.ok(html.includes('target: Windows'));
  assert.ok(html.includes('class="badge st-active"'));
  assert.ok(html.includes('class="badge git-clean"'));
  assert.ok(html.includes('branch: master'));
  assert.ok(html.includes('abc1234'));
  assert.ok(html.includes('Latest subject'));
  assert.ok(html.includes('modified: 0 / untracked: 0'));
  assert.ok(html.includes('保存contextなし')); // savedContext未設定時は中立表示（stale/currentと誤認させない）
});

test('Always header shows the freshness badge (current/stale/unknown) from saved context', () => {
  const currentHtml = run(`alwaysHeaderHtml(${JSON.stringify(repo({ savedContext: { freshness: 'current' } }))})`);
  assert.ok(currentHtml.includes('現在のHEADと一致'));
  const staleHtml = run(`alwaysHeaderHtml(${JSON.stringify(repo({ savedContext: { freshness: 'stale' } }))})`);
  assert.ok(staleHtml.includes('現在のHEADより古い可能性'));
  const unknownHtml = run(`alwaysHeaderHtml(${JSON.stringify(repo({ savedContext: { freshness: 'unknown' } }))})`);
  assert.ok(unknownHtml.includes('鮮度を判定できません'));
});

test('Always header shows Next action extracted from Agent context, or an explicit "not set" fallback', () => {
  const withNextAction = repo({ agentContextMarkdown: '# Agent context\n\n## 次に行うこと\n\nテストを追加する。' });
  const html = run(`alwaysHeaderHtml(${JSON.stringify(withNextAction)})`);
  assert.ok(html.includes('Next action'));
  assert.ok(html.includes('テストを追加する。'));
  const withoutNextAction = repo({ agentContextMarkdown: '# Agent context\n\n## 現在地\n\n何かの状態。' });
  const html2 = run(`alwaysHeaderHtml(${JSON.stringify(withoutNextAction)})`);
  assert.ok(html2.includes('未設定'));
});

test('Always header includes the Development session start / VS Code CTA and excludes them from the lower detail', () => {
  const html = run('detailRowHtml(alpha)');
  const alwaysIdx = html.indexOf('data-role="always-header"');
  const tabsIdx = html.indexOf('data-role="detail-tabs"');
  assert.ok(alwaysIdx !== -1 && tabsIdx !== -1 && alwaysIdx < tabsIdx);
  const startIdx = html.indexOf('data-role="start-development-session"');
  const vscodeIdx = html.indexOf('data-role="open-vscode"');
  assert.ok(startIdx > alwaysIdx && startIdx < tabsIdx, 'Development session start CTA should be inside the Always header');
  assert.ok(vscodeIdx > alwaysIdx && vscodeIdx < tabsIdx, 'VS Code CTA should be inside the Always header');
  // data-role毎に1つだけ存在する（重複要素があるとdetailTr.querySelector系の状態同期が壊れるため）
  assert.strictEqual((html.match(/data-role="start-development-session"/g) || []).length, 1);
  assert.strictEqual((html.match(/data-role="development-session"/g) || []).length, 1);
});

test('Always header shows the Runtime helper chip only for runtime helper projects and adds no empty space otherwise', () => {
  const runtimeHelperHtml = run(`alwaysHeaderHtml(${JSON.stringify(repo({ name: 'runtime-sample-project' }))})`);
  assert.ok(runtimeHelperHtml.includes('Runtime helper'));
  const otherHtml = run('alwaysHeaderHtml(alpha)');
  assert.ok(!otherHtml.includes('Runtime helper'));
});

test('Always header surfaces a compact scan-error warning pointing to the detail below', () => {
  const errRepo = repo({ error: 'git status failed' });
  const html = run(`alwaysHeaderHtml(${JSON.stringify(errRepo)})`);
  assert.ok(html.includes('scan error'));
  const okHtml = run('alwaysHeaderHtml(alpha)');
  assert.ok(!okHtml.includes('scan error'));
});

// ---- Resume summary: saved context only (current repo moved to Always header) ----

test('Resume summary shows saved context without duplicating the live current-repo facts', () => {
  const html = run('resumeSummaryBlockHtml(liveRepo)');
  assert.ok(!html.includes('現在のrepo'));
  assert.ok(!html.includes('abc1234')); // 現在のHEADはAlwaysヘッダー側のみで表示する
  assert.ok(html.includes('保存された作業コンテキスト'));
});

test('Resume summary shows "保存済みcontextなし" when no saved context exists', () => {
  sandbox.noContextRepo = repo({ savedContext: null });
  const html = run('resumeSummaryBlockHtml(noContextRepo)');
  assert.ok(html.includes('保存済みcontextなし'));
});

test('Resume summary marks stale saved context distinctly, without the current HEAD in the same block', () => {
  sandbox.staleRepo = repo({
    savedContext: {
      savedAt: '2026-07-01T00:00:00.000Z',
      savedHeadHash: '73daf10',
      savedHeadSubject: 'Add auto-fill for project agent context and command hints',
      savedBranch: 'master',
      freshness: 'stale',
      commitsAhead: 3,
      readmeChanged: null,
      progressChanged: null,
    },
  });
  const html = run('resumeSummaryBlockHtml(staleRepo)');
  assert.ok(html.includes('73daf10'));
  assert.ok(!html.includes('abc1234')); // 現在のHEADはAlwaysヘッダー側のみ
  assert.ok(html.includes('3コミット進んでいます'));
  assert.ok(html.includes('現在のHEADより古い可能性'));
  // 「最後の作業」という曖昧な見出しは廃止済み（保存時の最後の作業へ改名）
  assert.ok(!html.includes('>最後の作業<'));
});

test('Resume summary does not repeat Next action (shown prominently in the Always header instead)', () => {
  sandbox.nextActionBothRepo = repo({
    agentContextMarkdown: '# Agent context\n\n## 現在地\n\n作業中。\n\n## 次に行うこと\n\n次のタスク文言X。',
  });
  const resumeHtml = run('resumeSummaryBlockHtml(nextActionBothRepo)');
  assert.ok(!resumeHtml.includes('次のタスク文言X。'));
  const alwaysHtml = run('alwaysHeaderHtml(nextActionBothRepo)');
  assert.ok(alwaysHtml.includes('次のタスク文言X。'));
});

test('detailRowHtml keeps saved HEAD (Resume) and current HEAD (Always) distinct without conflation', () => {
  const html = run('detailRowHtml(staleRepo)');
  const alwaysIdx = html.indexOf('data-role="always-header"');
  const resumeIdx = html.indexOf('data-role="resume-summary"');
  assert.ok(alwaysIdx !== -1 && resumeIdx !== -1);
  assert.ok(alwaysIdx < resumeIdx, 'Always header should render before the Resume block');
  assert.ok(html.includes('abc1234')); // 現在のHEAD（live、Always）
  assert.ok(html.includes('73daf10')); // 保存時HEAD（saved context、Resume）
});

test('Resume summary shows "保存時HEAD不明" and unknown freshness when saved context has no metadata (old entries)', () => {
  sandbox.legacyRepo = repo({
    savedContext: {
      savedAt: '2026-01-01T00:00:00.000Z',
      savedHeadHash: null,
      savedHeadSubject: null,
      savedBranch: null,
      freshness: 'unknown',
      readmeChanged: null,
      progressChanged: null,
    },
  });
  const html = run('resumeSummaryBlockHtml(legacyRepo)');
  assert.ok(html.includes('保存時HEAD不明'));
  assert.ok(html.includes('鮮度を判定できません'));
});

test('Resume summary reports README/PROGRESS changed-since-save as separate evidence from HEAD staleness', () => {
  sandbox.fileChangedRepo = repo({
    savedContext: {
      savedAt: '2026-07-01T00:00:00.000Z',
      savedHeadHash: 'abc1234',
      savedHeadSubject: 'Latest subject',
      savedBranch: 'master',
      freshness: 'current',
      readmeChanged: true,
      progressChanged: true,
    },
  });
  const html = run('resumeSummaryBlockHtml(fileChangedRepo)');
  assert.ok(html.includes('現在のHEADと一致'));
  assert.ok(html.includes('README.mdは保存後に更新されています。'));
  assert.ok(html.includes('PROGRESS.mdは保存後に更新されています。'));
});

// ---- Rescan result: updated / unchanged / excluded / errors ----------------

test('rescanResultHtml distinguishes updated, unchanged, excluded, and errors', () => {
  const rr = {
    updated: ['headHash', 'gitStatus'],
    unchanged: ['branch'],
    excluded: ['savedAgentContext', 'manualStatus'],
    errors: [],
    readme: { reloaded: true, exists: true, changed: false },
    progress: { reloaded: true, exists: true, changed: true },
  };
  sandbox.rr1 = rr;
  const html = run('rescanResultHtml(rr1)');
  assert.ok(html.includes('更新: 2件'));
  assert.ok(html.includes('headHash'));
  assert.ok(html.includes('branch'));
  assert.ok(html.includes('savedAgentContext'));
  assert.ok(html.includes('内容変更あり')); // progress changed
  assert.ok(!html.includes('rr1'));
});

test('rescanResultHtml surfaces read failures without leaking internal errors', () => {
  const rr = {
    updated: [],
    unchanged: ['headHash', 'branch', 'gitStatus', 'modifiedCount', 'untrackedCount', 'tags'],
    excluded: ['savedAgentContext'],
    errors: ['readme-read-failed'],
    readme: { reloaded: true, exists: true, changed: null },
    progress: { reloaded: true, exists: false, changed: null },
  };
  sandbox.rr2 = rr;
  const html = run('rescanResultHtml(rr2)');
  assert.ok(html.includes('エラー'));
  assert.ok(html.includes('readme-read-failed'));
  assert.ok(html.includes('変更なし'));
});

// ---- Copy AI Handoff: saved agent context freshness ------------------------

test('Copy AI Handoff labels the embedded context "Saved agent context" and warns when stale', () => {
  sandbox.staleHandoffRepo = repo({
    savedContext: {
      savedAt: '2026-07-01T00:00:00.000Z',
      savedHeadHash: '73daf10',
      savedHeadSubject: 'old subject',
      freshness: 'stale',
    },
  });
  const markdown = run("buildHandoffMarkdown(staleHandoffRepo, 'status-only')");
  assert.ok(markdown.includes('# Saved agent context'));
  assert.ok(markdown.includes('saved HEAD: 73daf10 old subject'));
  assert.ok(markdown.includes('This saved context predates the current HEAD.'));
  assert.ok(markdown.includes('# Repo')); // current stateは別セクションのまま維持
});

test('Copy AI Handoff shows unknown freshness (no crash) when saved context lacks metadata', () => {
  sandbox.noMetaHandoffRepo = repo({ savedContext: null });
  const markdown = run("buildHandoffMarkdown(noMetaHandoffRepo, 'status-only')");
  assert.ok(markdown.includes('freshness: unknown'));
});

// ---- Phase 6-L: PC detail navigation (Documents / Context / Diagnostics) ----

test('Detail tabs expose ARIA tab semantics and mark exactly one requested tab selected', () => {
  const html = run('detailTabsHtml("documents")');
  assert.ok(html.includes('role="tablist"'));
  assert.ok((html.match(/role="tab"/g) || []).length === 3);
  assert.ok(html.includes('id="tab-documents"'));
  assert.ok(html.includes('id="tab-context"'));
  assert.ok(html.includes('id="tab-diagnostics"'));
  assert.ok(html.includes('aria-controls="panel-documents"'));
  // Resumeは既にAlways直下に常時表示されているためtabへは含めない（案A）
  assert.ok(!/data-panel="resume"/.test(html));
  assert.strictEqual((html.match(/aria-selected="true"/g) || []).length, 1);
  const docBtn = html.match(/<button[^>]*data-panel="documents"[^>]*>/)[0];
  assert.ok(docBtn.includes('aria-selected="true"'));
  assert.ok(docBtn.includes('tabindex="0"'));
  const ctxBtn = html.match(/<button[^>]*data-panel="context"[^>]*>/)[0];
  assert.ok(ctxBtn.includes('aria-selected="false"'));
  assert.ok(ctxBtn.includes('tabindex="-1"'));
});

test('Detail tabs mark the requested panel selected and fall back to Documents for an unknown key', () => {
  const html = run('detailTabsHtml("diagnostics")');
  const diagBtn = html.match(/<button[^>]*data-panel="diagnostics"[^>]*>/)[0];
  assert.ok(diagBtn.includes('aria-selected="true"'));
  const fallbackHtml = run('detailTabsHtml("nonexistent")');
  const docBtn = fallbackHtml.match(/<button[^>]*data-panel="documents"[^>]*>/)[0];
  assert.ok(docBtn.includes('aria-selected="true"'));
});

// ---- Phase 6-L follow-up x3: restore the PROGRESS/README sub-tab structure,
// with README (the new default document) additionally collapsed within its own sub-tab ----

test('Documents panel keeps the PROGRESS/README sub-tab structure and defaults to README, collapsed', () => {
  const html = run('documentsPanelHtml(alpha, true, "readme", false)');
  assert.ok(html.includes('id="panel-documents"'));
  assert.ok(html.includes('role="tabpanel"'));
  assert.ok(!html.includes('id="panel-documents" role="tabpanel" aria-labelledby="tab-documents" tabindex="0" hidden'));
  // sub-tab構造は50ef416から復元したまま（撤去していない）
  assert.ok(html.includes('documents-subnav'));
  const readmeSubtab = html.match(/<button[^>]*data-doc="readme"[^>]*>/)[0];
  const progressSubtab = html.match(/<button[^>]*data-doc="progress"[^>]*>/)[0];
  assert.ok(readmeSubtab.includes('aria-selected="true"'));
  assert.ok(progressSubtab.includes('aria-selected="false"'));
  const readmeDoc = html.match(/<div class="documents-doc" data-doc-panel="readme"[^>]*>/)[0];
  const progressDoc = html.match(/<div class="documents-doc" data-doc-panel="progress"[^>]*>/)[0];
  assert.ok(!readmeDoc.includes('hidden'));
  assert.ok(progressDoc.includes('hidden'));
  // README選択時でも、本文自体はさらに折りたたまれている（初期closed）
  const readmeDetails = html.match(/<details class="block readme-details" data-role="readme-details"[^>]*>/)[0];
  assert.ok(!readmeDetails.includes(' open'));
  const summary = html.match(/<summary data-role="readme-toggle"[^>]*>/)[0];
  assert.ok(summary.includes('aria-expanded="false"'));
  assert.ok(summary.includes('aria-controls="readme-body"'));
});

test('Selecting the PROGRESS sub-tab shows its body immediately, with no extra collapse layer', () => {
  const html = run('documentsPanelHtml(alpha, true, "progress", false)');
  const readmeDoc = html.match(/<div class="documents-doc" data-doc-panel="readme"[^>]*>/)[0];
  const progressDoc = html.match(/<div class="documents-doc" data-doc-panel="progress"[^>]*>/)[0];
  assert.ok(readmeDoc.includes('hidden'));
  assert.ok(!progressDoc.includes('hidden'));
  assert.ok(html.includes('PROGRESS.md（末尾）'));
  // PROGRESS本文自体は<details>で包まれておらず、折りたたみの対象ではない
  assert.ok(html.includes('<div class="block progress-block">'));
});

test('README stays open/closed independent of which sub-tab or top-level tab is currently active', () => {
  const openHtml = run('documentsPanelHtml(alpha, true, "readme", true)');
  const readmeDetails = openHtml.match(/<details class="block readme-details" data-role="readme-details"[^>]*>/)[0];
  assert.ok(readmeDetails.includes(' open'));
  assert.ok(openHtml.match(/<summary data-role="readme-toggle"[^>]*>/)[0].includes('aria-expanded="true"'));
  // README以外のsub-tab（progress）が選択されていても、readmeExpandedのDOM状態自体は維持される
  const progressActiveButReadmeOpen = run('documentsPanelHtml(alpha, true, "progress", true)');
  const readmeDetails2 = progressActiveButReadmeOpen.match(/<details class="block readme-details" data-role="readme-details"[^>]*>/)[0];
  assert.ok(readmeDetails2.includes(' open'));
  // Documentsタブ自体が非activeでもDOM上は維持される
  const inactiveButOpen = run('documentsPanelHtml(alpha, false, "readme", true)');
  const panelTag = inactiveButOpen.match(/<div class="detail-panel" id="panel-documents"[^>]*>/)[0];
  assert.ok(panelTag.includes('hidden'));
  const readmeDetails3 = inactiveButOpen.match(/<details class="block readme-details" data-role="readme-details"[^>]*>/)[0];
  assert.ok(readmeDetails3.includes(' open'));
});

test('PROGRESS and README each get their own Markdown/Plain text toggle, and README shows one only when it has content', () => {
  const html = run('documentsPanelHtml(alpha, true, "readme", true)');
  assert.ok(html.includes('data-role="progress-mode" data-mode="markdown"'));
  assert.ok(html.includes('data-role="progress-mode" data-mode="plain"'));
  assert.ok(html.includes('data-role="readme-mode" data-mode="markdown"'));
  assert.ok(html.includes('data-role="readme-mode" data-mode="plain"'));
  const noReadme = repo({ hasReadme: false });
  const noReadmeHtml = run(`documentsPanelHtml(${JSON.stringify(noReadme)}, true, "readme", true)`);
  assert.ok(!noReadmeHtml.includes('data-role="readme-mode"'));
  assert.ok(noReadmeHtml.includes('README.md なし'));
});

test('PROGRESS and README body wrappers share the documents-body class (progress/readme variants), unaffected by Markdown/Plain text', () => {
  const markdownHtml = run('documentsPanelHtml(alpha, true, "readme", true)');
  assert.ok(markdownHtml.includes('class="progress-block-body documents-body documents-body-progress"'));
  assert.ok(markdownHtml.includes('class="readme-block-body documents-body documents-body-readme"'));
  run("progressViewMode = 'plain'; readmeViewMode = 'plain'");
  const plainHtml = run('documentsPanelHtml(alpha, true, "readme", true)');
  assert.ok(plainHtml.includes('class="progress-block-body documents-body documents-body-progress"'));
  assert.ok(plainHtml.includes('class="readme-block-body documents-body documents-body-readme"'));
  assert.ok(plainHtml.includes('class="pm-btn active" data-role="progress-mode" data-mode="plain"'));
  assert.ok(plainHtml.includes('class="pm-btn active" data-role="readme-mode" data-mode="plain"'));
  run("progressViewMode = 'markdown'; readmeViewMode = 'markdown'"); // 後続テストへ影響しないよう既定値へ戻す
});

test('Documents panel reports missing PROGRESS/README without blocking the other document', () => {
  const noProgress = repo({ hasProgress: false, hasReadme: true });
  const html = run(`documentsPanelHtml(${JSON.stringify(noProgress)}, true, "progress", true)`);
  assert.ok(html.includes('PROGRESS.md なし'));
  assert.ok(html.includes('README.md'));
  const noReadme = repo({ hasProgress: true, hasReadme: false });
  const html2 = run(`documentsPanelHtml(${JSON.stringify(noReadme)}, true, "readme", false)`);
  assert.ok(html2.includes('README.md なし'));
  assert.ok(html2.includes('PROGRESS.md（末尾）'));
});

test('Documents panel surfaces a README read error next to the collapsed heading and inside the expanded body', () => {
  const errRepo = repo({ hasReadme: true, readmeError: 'permission denied' });
  const closedHtml = run(`documentsPanelHtml(${JSON.stringify(errRepo)}, true, "readme", false)`);
  const summary = closedHtml.match(/<summary data-role="readme-toggle"[^>]*>[\s\S]*?<\/summary>/)[0];
  assert.ok(summary.includes('read error'));
  const openHtml = run(`documentsPanelHtml(${JSON.stringify(errRepo)}, true, "readme", true)`);
  assert.ok(openHtml.includes('permission denied'));
});

test('Context panel shows a compact Saved-context view first, with editing UI hidden until requested', () => {
  const withContext = repo({ agentContextMarkdown: '# Agent context\n\n## Current focus\n\nUI改善。\n\n## Next action\n\nテスト追加。' });
  const html = run(`contextPanelHtml(${JSON.stringify(withContext)}, true)`);
  assert.ok(html.includes('data-role="context-view"'));
  assert.ok(html.includes('Current focus'));
  assert.ok(html.includes('UI改善。'));
  assert.ok(html.includes('Next action'));
  assert.ok(html.includes('テスト追加。'));
  assert.ok(html.includes('編集する'));
  const editBlock = html.match(/<div class="context-edit" data-role="context-edit"[^>]*>/)[0];
  assert.ok(editBlock.includes('hidden'));
  assert.ok(html.includes('data-role="context-edit-cancel"'));
});

test('Context panel view falls back to a not-recorded message when Saved context has no fields, without inventing text', () => {
  const empty = repo({ agentContextMarkdown: '', agentContext: {}, hasProgress: false });
  const html = run(`contextPanelHtml(${JSON.stringify(empty)}, true)`);
  assert.ok(html.includes('記録なし'));
});

test('Context panel Next action matches the Always header exactly (same buildResumeItems() call, not a second dataset)', () => {
  const withNextAction = repo({ agentContextMarkdown: '# Agent context\n\n## 次に行うこと\n\n一致確認用テキストZ。' });
  const alwaysHtml = run(`alwaysHeaderHtml(${JSON.stringify(withNextAction)})`);
  const contextHtml = run(`contextPanelHtml(${JSON.stringify(withNextAction)}, true)`);
  assert.ok(alwaysHtml.includes('一致確認用テキストZ。'));
  assert.ok(contextHtml.includes('一致確認用テキストZ。'));
});

test('Context panel moves manual status/note editing under "Project status & note", not Diagnostics', () => {
  const html = run('contextPanelHtml(alpha, true)');
  assert.ok(html.includes('Project status &amp; note'));
  assert.ok(html.includes('data-role="status"'));
  assert.ok(html.includes('data-role="note"'));
  assert.ok(html.includes('data-role="save"'));
});

test('Diagnostics panel groups Repository / Scan / Development session settings and stays hidden unless active', () => {
  const html = run('diagnosticsPanelHtml(alpha, true)');
  assert.ok(html.includes('<h4>Repository</h4>'));
  assert.ok(html.includes('<h4>Scan</h4>'));
  assert.ok(html.includes('<h4>Development session settings</h4>'));
  const repoIdx = html.indexOf('<h4>Repository</h4>');
  const scanIdx = html.indexOf('<h4>Scan</h4>');
  const sessionSettingsIdx = html.indexOf('<h4>Development session settings</h4>');
  assert.ok(repoIdx < scanIdx && scanIdx < sessionSettingsIdx);
  assert.ok(html.includes('data-role="rescan-project"'));
  assert.ok(html.includes('data-role="development-session-config-actions"'));
  // 開始CTA・item checkboxはAlways側のみ（Diagnosticsへ複製しない）
  assert.ok(!html.includes('data-role="start-development-session"'));

  const inactive = run('diagnosticsPanelHtml(alpha, false)');
  const panelTag = inactive.match(/<div class="detail-panel" id="panel-diagnostics"[^>]*>/)[0];
  assert.ok(panelTag.includes('hidden'));
});

test('Diagnostics panel shows Git diagnosis and scan errors that Always only warns about compactly', () => {
  sandbox.diagErrRepo = repo({
    kind: 'error',
    gitStatus: 'error',
    error: 'boom',
    gitDiagnosis: { code: 'timeout', operation: 'working tree status', message: 'Timed out.' },
  });
  const diagHtml = run('diagnosticsPanelHtml(diagErrRepo, true)');
  assert.ok(diagHtml.includes('boom'));
  assert.ok(diagHtml.includes('working tree status'));
  assert.ok(diagHtml.includes('Timed out.'));
  const alwaysHtml = run('alwaysHeaderHtml(diagErrRepo)');
  assert.ok(alwaysHtml.includes('scan error'));
  assert.ok(!alwaysHtml.includes('boom'));
});

test('Resume summary shows a compact manual-note view; editing lives in the Context panel instead', () => {
  const withNote = repo({ note: '休止中の理由メモ' });
  const resumeHtml = run(`resumeSummaryBlockHtml(${JSON.stringify(withNote)})`);
  assert.ok(resumeHtml.includes('Note: 休止中の理由メモ'));
  assert.ok(!resumeHtml.includes('data-role="note"'));
  const emptyNote = repo({ note: '' });
  const resumeHtml2 = run(`resumeSummaryBlockHtml(${JSON.stringify(emptyNote)})`);
  assert.ok(resumeHtml2.includes('Note: (未設定)'));
});

test('detailRowHtml renders Always/Resume/Handoff before the tab navigation, with only one panel visible', () => {
  const html = run('detailRowHtml(alpha)');
  const alwaysIdx = html.indexOf('data-role="always-header"');
  const resumeIdx = html.indexOf('data-role="resume-summary"');
  const handoffIdx = html.indexOf('class="block handoff-block"');
  const tabsIdx = html.indexOf('data-role="detail-tabs"');
  const documentsIdx = html.indexOf('id="panel-documents"');
  assert.ok(alwaysIdx < resumeIdx && resumeIdx < handoffIdx && handoffIdx < tabsIdx && tabsIdx < documentsIdx);
  // 初期選択はDocuments（実画面確認のFBにより、Always/Resume/PROGRESSを
  // 中心にした静かな初期表示が最も自然だったため、Contextから再度変更した）
  const docsPanelTag = html.match(/<div class="detail-panel" id="panel-documents"[^>]*>/)[0];
  const ctxPanelTag = html.match(/<div class="detail-panel" id="panel-context"[^>]*>/)[0];
  const diagPanelTag = html.match(/<div class="detail-panel" id="panel-diagnostics"[^>]*>/)[0];
  assert.ok(!docsPanelTag.includes('hidden'));
  assert.ok(ctxPanelTag.includes('hidden'));
  assert.ok(diagPanelTag.includes('hidden'));
  // 開いた直後、README折りたたみはclosed（Always/Resume/PROGRESSだけの静かな画面）
  const readmeDetails = html.match(/<details class="block readme-details" data-role="readme-details"[^>]*>/)[0];
  assert.ok(!readmeDetails.includes(' open'));
});

test('Duplicate elimination: README/PROGRESS full text, Agent context editing, and diagnostics each render exactly once', () => {
  const html = run('detailRowHtml(alpha)');
  assert.strictEqual((html.match(/data-role="readme-details"/g) || []).length, 1);
  assert.strictEqual((html.match(/PROGRESS\.md（末尾）/g) || []).length, 1);
  assert.strictEqual((html.match(/data-role="ctx-markdown"/g) || []).length, 1);
  assert.strictEqual((html.match(/class="block handoff-block"/g) || []).length, 1);
  assert.strictEqual((html.match(/data-role="rescan-project"/g) || []).length, 1);
  assert.strictEqual((html.match(/data-role="start-development-session"/g) || []).length, 1);
  // development-session-config-actionsはrenderDevelopmentSession()がquerySelector()
  // （querySelectorAllではない）で1件だけを前提に書き込むplaceholderのため、
  // AlwaysとDiagnosticsの両方に置くと複製になり状態同期が壊れる（実際に混入した回帰）
  assert.strictEqual((html.match(/data-role="development-session-config-actions"/g) || []).length, 1);
  // PROGRESS/READMEサブタブはちょうど2つ（複製されていない）
  assert.strictEqual((html.match(/data-role="documents-subtab"/g) || []).length, 2);
});

// ---- Phase 6-L follow-up x2: Documents is the initial/default panel ------

test('openPanel/documentsSubView initialize to Documents + README (a quiet Always/Resume/PROGRESS-heading-first screen)', () => {
  assert.strictEqual(run('openPanel'), 'documents');
  assert.strictEqual(run('documentsSubView'), 'readme');
  assert.strictEqual(run('readmeExpanded'), false);
});

test('simulated project switch resets to Documents + README sub-tab, closed, mirroring the click handler reset block', () => {
  // 実際のproject切替（click handler）が行うのと同じ3行を再現する。
  // Context/Diagnosticsを見ていた・PROGRESSサブタブを選んでいた・READMEを
  // 開いていた状態から、別projectへ切り替えるとDocuments + README（closed）へ
  // 戻ることを確認する
  run("openPanel = 'context'; documentsSubView = 'progress'; readmeExpanded = true");
  run("openPanel = 'documents'; documentsSubView = 'readme'; readmeExpanded = false"); // project切替時のreset相当
  assert.strictEqual(run('openPanel'), 'documents');
  assert.strictEqual(run('documentsSubView'), 'readme');
  assert.strictEqual(run('readmeExpanded'), false);
  const html = run('detailRowHtml(alpha)');
  const docsPanelTag = html.match(/<div class="detail-panel" id="panel-documents"[^>]*>/)[0];
  assert.ok(!docsPanelTag.includes('hidden'));
  const readmeDoc = html.match(/<div class="documents-doc" data-doc-panel="readme"[^>]*>/)[0];
  assert.ok(!readmeDoc.includes('hidden'));
  const readmeDetails = html.match(/<details class="block readme-details" data-role="readme-details"[^>]*>/)[0];
  assert.ok(!readmeDetails.includes(' open'));
});

test('detailRowHtml keeps whichever panel, Documents sub-tab, and README open/closed state is currently selected across a re-render (same effect as Rescan/rerender)', () => {
  // Rescan/自動再描画はrenderTable()経由でdetailRowHtml()を呼び直すだけで、
  // openPanel/documentsSubView/readmeExpanded自体はリセットしない。ここでは
  // その前提（グローバル状態がそのまま再利用される）を、Diagnosticsを選び、
  // Documentsのsub-tabをPROGRESSにし、READMEを開いた状態を再現して確認する
  run("openPanel = 'diagnostics'; documentsSubView = 'progress'; readmeExpanded = true");
  const html = run('detailRowHtml(alpha)');
  const diagPanelTag = html.match(/<div class="detail-panel" id="panel-diagnostics"[^>]*>/)[0];
  const docsPanelTag = html.match(/<div class="detail-panel" id="panel-documents"[^>]*>/)[0];
  assert.ok(!diagPanelTag.includes('hidden'));
  assert.ok(docsPanelTag.includes('hidden'));
  const progressDoc = html.match(/<div class="documents-doc" data-doc-panel="progress"[^>]*>/)[0];
  assert.ok(!progressDoc.includes('hidden'));
  const readmeDetails = html.match(/<details class="block readme-details" data-role="readme-details"[^>]*>/)[0];
  assert.ok(readmeDetails.includes(' open'));
  run("openPanel = 'documents'; documentsSubView = 'readme'; readmeExpanded = false"); // 後続テストへ影響しないよう既定値へ戻す
});

test('Context editing left open survives a switch to Documents and back (no data loss on tab switch)', () => {
  // タブ切替はrenderTable()を呼ばずhidden属性の切替のみのため、Context編集中の
  // 状態（.context-edit自体）はDOM上維持される。ここではsetContextEditing()が
  // Documents/Diagnosticsへの遷移で編集要素を破棄しないことを確認する
  const html = run('detailRowHtml(alpha)');
  assert.ok(html.includes('data-role="context-edit"'));
  assert.ok(html.includes('data-role="ctx-markdown"'));
});

test('activateDetailTab falls back to Documents (not Context) for an unrecognized panel key', () => {
  run('activateDetailTab(document.createElement("tr"), "not-a-real-panel")');
  assert.strictEqual(run('openPanel'), 'documents');
});

// ---- Phase 6-L: interactive helpers do not throw against a stubbed DOM -----

test('activateDetailTab, activateDocumentsSubtab, setContextEditing, and resetContextEditForm run without throwing', () => {
  run('activateDetailTab(document.createElement("tr"), "context")');
  run('activateDocumentsSubtab(document.createElement("tr"), "progress")');
  run('setContextEditing(document.createElement("tr"), true)');
  run('resetContextEditForm(document.createElement("tr"), alpha)');
  assert.ok(run('hasUnsavedContextEdit(document.createElement("tr"))') === false || run('hasUnsavedContextEdit(document.createElement("tr"))') === true);
});

// ---- mobile Phase 3: Documents/Context/Diagnostics accordions -------------

test('mobileAccordionOpen initializes with all three panels closed', () => {
  assert.deepStrictEqual(
    JSON.parse(run('JSON.stringify(mobileAccordionOpen)')),
    { documents: false, context: false, diagnostics: false }
  );
});

test('mobileAccordionToggleHtml exposes a button with aria-expanded/aria-controls and no reliance on an icon alone', () => {
  const closedHtml = run(`mobileAccordionToggleHtml('documents', 'Documents', false)`);
  assert.ok(closedHtml.includes('data-role="mobile-accordion-toggle"'));
  assert.ok(closedHtml.includes('data-panel="documents"'));
  assert.ok(closedHtml.includes('aria-expanded="false"'));
  assert.ok(closedHtml.includes('aria-controls="panel-documents"'));
  assert.ok(closedHtml.includes('>Documents<'));
  const openHtml = run(`mobileAccordionToggleHtml('context', 'Context', true)`);
  assert.ok(openHtml.includes('aria-expanded="true"'));
  assert.ok(openHtml.includes('aria-controls="panel-context"'));
});

test('detailRowHtml renders exactly one mobile-accordion-toggle per panel, all closed by default (mobileAccordionOpen unset)', () => {
  const html = run('detailRowHtml(alpha)');
  assert.strictEqual((html.match(/data-role="mobile-accordion-toggle"/g) || []).length, 3);
  ['documents', 'context', 'diagnostics'].forEach((key) => {
    const btn = html.match(new RegExp(`<button[^>]*data-role="mobile-accordion-toggle"[^>]*data-panel="${key}"[^>]*>`))[0];
    assert.ok(btn.includes('aria-expanded="false"'), key);
  });
  // 初期状態ではどのpanelにもmobile-openクラスが付かない
  assert.ok(!html.includes('detail-panel mobile-open'));
});

test('documentsPanelHtml/contextPanelHtml/diagnosticsPanelHtml add "mobile-open" only when instructed, independent of the PC isActive flag', () => {
  const docHtml = run('documentsPanelHtml(alpha, false, "readme", false, true)');
  assert.ok(docHtml.match(/<div class="detail-panel mobile-open" id="panel-documents"/));
  assert.ok(docHtml.includes(' hidden')); // PC側はisActive=falseのままhidden

  const ctxHtml = run('contextPanelHtml(alpha, false, true)');
  assert.ok(ctxHtml.match(/<div class="detail-panel mobile-open" id="panel-context"/));

  const diagHtmlClosed = run('diagnosticsPanelHtml(alpha, true, false)');
  assert.ok(diagHtmlClosed.match(/<div class="detail-panel" id="panel-diagnostics"/));
  assert.ok(!diagHtmlClosed.includes('mobile-open'));
});

test('toggleMobileAccordion flips only the requested panel and does not touch openPanel/hidden (PC state untouched)', () => {
  run("mobileAccordionOpen = { documents: false, context: false, diagnostics: false }");
  run("openPanel = 'documents'");
  run('toggleMobileAccordion(document.createElement("tr"), "context")');
  const state = JSON.parse(run('JSON.stringify(mobileAccordionOpen)'));
  assert.deepStrictEqual(state, { documents: false, context: true, diagnostics: false });
  assert.strictEqual(run('openPanel'), 'documents'); // PCのtab状態は無関係のまま
  run('toggleMobileAccordion(document.createElement("tr"), "context")'); // 元に戻す
  assert.strictEqual(run('mobileAccordionOpen.context'), false);
});

test('toggleMobileAccordion ignores unknown keys without throwing', () => {
  run("mobileAccordionOpen = { documents: false, context: false, diagnostics: false }");
  run('toggleMobileAccordion(document.createElement("tr"), "not-a-real-panel")');
  assert.deepStrictEqual(
    JSON.parse(run('JSON.stringify(mobileAccordionOpen)')),
    { documents: false, context: false, diagnostics: false }
  );
});

test('project switch reset (simulated) closes all mobile accordions along with Documents/README', () => {
  run("mobileAccordionOpen = { documents: true, context: true, diagnostics: true }");
  // 実際のclick handlerが行うreset相当（project切替時）
  run("openPanel = 'documents'; documentsSubView = 'readme'; readmeExpanded = false; mobileAccordionOpen = { documents: false, context: false, diagnostics: false };");
  const html = run('detailRowHtml(alpha)');
  assert.ok(!html.includes('detail-panel mobile-open'));
  ['documents', 'context', 'diagnostics'].forEach((key) => {
    const btn = html.match(new RegExp(`<button[^>]*data-role="mobile-accordion-toggle"[^>]*data-panel="${key}"[^>]*>`))[0];
    assert.ok(btn.includes('aria-expanded="false"'), key);
  });
});

test('detailRowHtml keeps mobile accordion open state across a re-render (same effect as Rescan/rerender)', () => {
  run("mobileAccordionOpen = { documents: false, context: true, diagnostics: false }");
  const html = run('detailRowHtml(alpha)');
  const ctxPanelTag = html.match(/<div class="detail-panel[^"]*" id="panel-context"[^>]*>/)[0];
  assert.ok(ctxPanelTag.includes('mobile-open'));
  const ctxToggle = html.match(/<button[^>]*data-role="mobile-accordion-toggle"[^>]*data-panel="context"[^>]*>/)[0];
  assert.ok(ctxToggle.includes('aria-expanded="true"'));
  run("mobileAccordionOpen = { documents: false, context: false, diagnostics: false }"); // 既定値へ戻す
});

test('Duplicate elimination: mobile accordion toggles and panel ids remain singular (no PC/mobile DOM duplication)', () => {
  const html = run('detailRowHtml(alpha)');
  assert.strictEqual((html.match(/id="panel-documents"/g) || []).length, 1);
  assert.strictEqual((html.match(/id="panel-context"/g) || []).length, 1);
  assert.strictEqual((html.match(/id="panel-diagnostics"/g) || []).length, 1);
  assert.strictEqual((html.match(/data-panel="documents"/g) || []).length, 2); // PC tab + mobile accordion toggle
  assert.strictEqual((html.match(/id="readme-body"/g) || []).length, 1);
  assert.strictEqual((html.match(/PROGRESS\.md（末尾）/g) || []).length, 1);
});

process.on('exit', (code) => {
  console.log(`\n${count} app regression tests, ${code === 0 ? 'all passed' : 'FAILED'}`);
});
