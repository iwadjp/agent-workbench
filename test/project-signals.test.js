'use strict';

// public/project-signals.js の単体テスト（node test/project-signals.test.js で実行）。
// 外部フレームワークは使わない（assertのみ）。clipboard APIはNodeで自動テストしにくいため、
// Markdown生成の純粋関数だけを検証する（コピー自体は public/app.js 側の薄いラッパー）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  signalsIdleDays,
  signalsIdleBucket,
  attentionFlags,
  buildPortfolioSummaryLines,
  buildAttentionSignalsLines,
  buildProjectSection,
  buildProjectSignalsMarkdown,
} = require('../public/project-signals');

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

function daysAgoIso(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function repo(overrides = {}) {
  return {
    name: 'alpha',
    path: 'D:\\work\\alpha',
    kind: 'repo',
    targetLabel: 'Windows',
    manualStatus: 'active',
    note: '',
    branch: 'master',
    gitStatus: 'clean',
    modifiedCount: 0,
    untrackedCount: 0,
    commit: { hash: 'abc1234', message: 'Latest subject', date: daysAgoIso(1) },
    remote: { enabled: true, status: 'up-to-date' },
    hasReadme: true,
    readmeTail: '# Alpha',
    hasProgress: true,
    progressTail: 'Initial notes. No structured headings here.',
    agentContextMarkdown: '',
    savedContext: null,
    error: null,
    ...overrides,
  };
}

// ---- signalsIdleDays / signalsIdleBucket -----------------------------------

test('signalsIdleDays: commitが無ければnull', () => {
  assert.strictEqual(signalsIdleDays(repo({ commit: null })), null);
});

test('signalsIdleBucket: 30日以上はlong-stale、7日以上はstale、それ未満はfresh', () => {
  assert.strictEqual(signalsIdleBucket(0), 'fresh');
  assert.strictEqual(signalsIdleBucket(6), 'fresh');
  assert.strictEqual(signalsIdleBucket(7), 'stale');
  assert.strictEqual(signalsIdleBucket(29), 'stale');
  assert.strictEqual(signalsIdleBucket(30), 'long-stale');
  assert.strictEqual(signalsIdleBucket(null), 'unknown');
});

// ---- attentionFlags ----------------------------------------------------------

test('scan errorがあれば "scan error" を含む', () => {
  const flags = attentionFlags(repo({ error: 'path not found' }));
  assert.ok(flags.includes('scan error'));
});

test('dirtyなrepoは "dirty" を含む（untracked-onlyは含まない）', () => {
  assert.ok(attentionFlags(repo({ gitStatus: 'dirty' })).includes('dirty'));
  assert.ok(!attentionFlags(repo({ gitStatus: 'untracked-only' })).includes('dirty'));
});

test('30日以上放置は "long stale" を含み、29日以下は含まない', () => {
  assert.ok(attentionFlags(repo({ commit: { hash: 'a', message: 'm', date: daysAgoIso(30) } })).includes('long stale'));
  assert.ok(!attentionFlags(repo({ commit: { hash: 'a', message: 'm', date: daysAgoIso(29) } })).includes('long stale'));
});

test('remote enabledかつno-remoteなら "no remote" を含む', () => {
  const flags = attentionFlags(repo({ remote: { enabled: true, status: 'no-remote' } }));
  assert.ok(flags.includes('no remote'));
});

test('remote未確認（enabled:false）では "no remote" を含まない', () => {
  const flags = attentionFlags(repo({ remote: { enabled: false, status: 'disabled' } }));
  assert.ok(!flags.includes('no remote'));
});

test('savedContextがstale/unknownなら該当フラグを含む', () => {
  assert.ok(attentionFlags(repo({ savedContext: { freshness: 'stale' } })).includes('agent context stale'));
  assert.ok(attentionFlags(repo({ savedContext: { freshness: 'unknown' } })).includes('agent context unknown'));
  assert.ok(!attentionFlags(repo({ savedContext: { freshness: 'current' } })).some((f) => f.startsWith('agent context')));
});

test('Agent context/PROGRESSの既知の制約・次に行うことがあればblocker/next actionを含む', () => {
  const flags = attentionFlags(repo({
    agentContextMarkdown: '# Agent context\n\n## 既知の制約\n\nAPIキー未設定。\n\n## 次に行うこと\n\n設定を追加する。',
  }));
  assert.ok(flags.includes('blocker'));
  assert.ok(flags.includes('next action'));
});

test('manualStatusがpausedなら "status: paused" を含む', () => {
  assert.ok(attentionFlags(repo({ manualStatus: 'paused' })).includes('status: paused'));
});

test('何も該当しないrepoは空配列', () => {
  assert.deepStrictEqual(attentionFlags(repo()), []);
});

// ---- buildPortfolioSummaryLines ---------------------------------------------

test('Portfolio summaryはproject count・target・status・git status・stale・remote・context・progressを集計する', () => {
  const repos = [
    repo({ name: 'alpha', gitStatus: 'clean', manualStatus: 'active' }),
    repo({ name: 'beta', gitStatus: 'dirty', manualStatus: 'paused', targetLabel: 'wsl', hasProgress: false, savedContext: { freshness: 'current' } }),
  ];
  const lines = buildPortfolioSummaryLines(repos).join('\n');
  assert.ok(lines.includes('project count: 2'));
  assert.ok(lines.includes('active 1'));
  assert.ok(lines.includes('paused 1'));
  assert.ok(lines.includes('clean 1'));
  assert.ok(lines.includes('dirty 1'));
  assert.ok(lines.includes('Agent context saved / not saved: 1 / 1'));
  assert.ok(lines.includes('PROGRESS.md present / absent: 1 / 1'));
});

// ---- buildAttentionSignalsLines ----------------------------------------------

test('Attention signalsはflagがあるrepoだけ列挙する', () => {
  const repos = [repo({ name: 'clean-repo' }), repo({ name: 'dirty-repo', gitStatus: 'dirty' })];
  const lines = buildAttentionSignalsLines(repos);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes('dirty-repo'));
  assert.ok(lines[0].includes('dirty'));
});

test('Attention signalsが1件も無ければプレースホルダを返す', () => {
  const lines = buildAttentionSignalsLines([repo()]);
  assert.deepStrictEqual(lines, ['(no attention signals)']);
});

// ---- buildProjectSection ------------------------------------------------------

test('空フィールド（note/branch/savedContext等）は行ごと省略される', () => {
  const section = buildProjectSection(repo({ note: '', branch: null, savedContext: null, agentContextMarkdown: '', hasProgress: false, progressTail: null }));
  assert.ok(!section.includes('- note:'));
  assert.ok(!section.includes('- branch:'));
  assert.ok(!section.includes('- saved context date:'));
  assert.ok(!section.includes('- saved HEAD:'));
  assert.ok(!section.includes('- context freshness:'));
  assert.ok(!section.includes('#### Current focus'));
  assert.ok(!section.includes('#### Next action'));
  assert.ok(!section.includes('#### Blockers / notes'));
  assert.ok(!section.includes('#### Recent progress'));
  assert.ok(!section.includes('#### README summary'));
});

test('値がある項目はすべて出力される', () => {
  const section = buildProjectSection(repo({
    note: 'メモ',
    branch: 'main',
    savedContext: { savedAt: '2026-07-20T00:00:00.000Z', savedHeadHash: 'abc123', savedHeadSubject: 'Fix', freshness: 'stale' },
    agentContextMarkdown: '# Agent context\n\n## 現在地\n\n実装中。\n\n## 次に行うこと\n\nテスト追加。\n\n## 既知の制約\n\n未検証。',
  }));
  assert.ok(section.includes('- note: メモ'));
  assert.ok(section.includes('- branch: main'));
  assert.ok(section.includes('- context freshness: stale'));
  assert.ok(section.includes('#### Current focus'));
  assert.ok(section.includes('実装中。'));
  assert.ok(section.includes('#### Next action'));
  assert.ok(section.includes('#### Blockers / notes'));
  assert.ok(section.includes('#### Recent progress'));
});

test('運用見出し（次回確認日 / 外部イベント待ち / 外部シグナル）は存在する場合だけ出力される（Increment 2）', () => {
  const withOps = buildProjectSection(repo({
    agentContextMarkdown: [
      '# c', '', '## 現在地', '', 'x', '',
      '## 次回確認日', '', '2026-09-08', '',
      '## 外部イベント待ち', '', 'F-Droid: test 待ち', '',
      '## 外部シグナル', '', 'Star: 1', 'Downloads: 8',
    ].join('\n'),
  }));
  assert.ok(withOps.includes('- next review: 2026-09-08'));
  assert.ok(withOps.includes('- external wait: F-Droid: test 待ち'));
  assert.ok(withOps.includes('#### External signal'));
  assert.ok(withOps.includes('Downloads: 8'));

  const without = buildProjectSection(repo({ agentContextMarkdown: '# c\n\n## 現在地\n\nx\n' }));
  assert.ok(!without.includes('- next review:'));
  assert.ok(!without.includes('- external wait:'));
  assert.ok(!without.includes('#### External signal'));
});

test('Analysis request に AI operator 向けの運用情報更新依頼が含まれる（Increment 2）', () => {
  const md = buildProjectSignalsMarkdown([repo()], '2026-09-01T09:00:00.000Z');
  assert.ok(md.includes('## 次回確認日'));
  assert.ok(md.includes('## 外部イベント待ち'));
  assert.ok(md.includes('## 外部シグナル'));
  assert.ok(md.includes('推測値を書かないでください'));
  assert.ok(md.includes('Agent Workbench 自身は外部 API を呼びません'));
});

test('no-git repoはworking treeが"no-git"、missingは"missing (path not found)"', () => {
  const noGit = buildProjectSection(repo({ kind: 'no-git', gitStatus: 'no-git', branch: null, commit: null }));
  assert.ok(noGit.includes('- working tree: no-git'));
  const missing = buildProjectSection(repo({ kind: 'missing', gitStatus: 'error', branch: null, commit: null, error: 'path not found' }));
  assert.ok(missing.includes('- working tree: missing (path not found)'));
});

// ---- buildProjectSignalsMarkdown ----------------------------------------------

test('固定の見出し構成（Purpose/Generated at/Portfolio summary/Attention signals/Projects/Analysis request）を含む', () => {
  const md = buildProjectSignalsMarkdown([repo()], '2026-07-26T09:00:00.000Z');
  assert.ok(md.startsWith('# Agent Workbench Project Signals'));
  assert.ok(md.includes('## Purpose'));
  assert.ok(md.includes('## Generated at'));
  assert.ok(md.includes('2026-07-26'));
  assert.ok(md.includes('## Portfolio summary'));
  assert.ok(md.includes('## Attention signals'));
  assert.ok(md.includes('## Projects'));
  assert.ok(md.includes('## Analysis request'));
  assert.ok(md.includes('月10万円規模のストック収益'));
});

test('全repoが重複なく含まれる', () => {
  const repos = [repo({ name: 'alpha' }), repo({ name: 'beta' }), repo({ name: 'gamma' })];
  const md = buildProjectSignalsMarkdown(repos, '2026-07-26T09:00:00.000Z');
  for (const name of ['alpha', 'beta', 'gamma']) {
    const re = new RegExp(`^### ${name}$`, 'm');
    assert.strictEqual((md.match(re) || []).length, 1, `${name} should appear exactly once`);
  }
});

test('projectsが空でもエラーにならない', () => {
  const md = buildProjectSignalsMarkdown([], '2026-07-26T09:00:00.000Z');
  assert.ok(md.includes('(no projects)'));
  assert.ok(md.includes('project count: 0'));
});

// ---- UI wiring（index.html / app.js の静的チェック） -------------------------
// 実ブラウザでのクリック確認の代わりに、ボタンの存在・スクリプト読み込み順・
// クリックハンドラの配線を静的に確認する（test/pwa.test.js と同じ読み取り方式）

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('index.htmlにCopy project signalsボタンが表示され、既存のRescanボタンや一覧テーブルは維持される', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('id="signals-btn"'));
  assert.ok(html.includes('>Copy project signals<'));
  assert.ok(html.includes('id="rescan-btn"'));
  assert.ok(html.includes('id="repo-table"'));
  // 既存の一覧テーブルの列数（10列）に回帰がないことを確認する
  const headerMatches = html.match(/<th[ >]/g) || [];
  assert.strictEqual(headerMatches.length, 10);
  // project-signals.js は resume-summary.js の後・app.js より前に読み込む
  const scanIdx = html.indexOf('src="resume-summary.js"');
  const signalsIdx = html.indexOf('src="project-signals.js"');
  const appIdx = html.indexOf('src="app.js"');
  assert.ok(scanIdx < signalsIdx && signalsIdx < appIdx);
});

test('app.jsはsignals-btnのクリックでbuildProjectSignalsMarkdownをコピーする', () => {
  const app = read('public/app.js');
  assert.ok(app.includes("getElementById('signals-btn')"));
  assert.ok(app.includes('buildProjectSignalsMarkdown(state.repos'));
  assert.ok(app.includes('copyToClipboard(markdown)'));
});

test('service workerの静的キャッシュ一覧にproject-signals.jsが含まれる', () => {
  const sw = read('public/service-worker.js');
  const assets = sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)[1];
  assert.ok(assets.includes('/project-signals.js'));
});

process.on('exit', (code) => {
  console.log(`\n${count} tests, ${code === 0 ? 'all passed' : 'FAILED'}`);
});
