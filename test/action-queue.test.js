'use strict';

// public/action-queue.js の単体テスト（node test/action-queue.test.js で実行）。
// 外部フレームワークは使わない（assert のみ）。DOM を持たない純粋関数だけを検証する
// （UI 描画は public/app.js 側の薄いラッパー。件数の表示制御だけ pageActionQueue で確認する）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  deriveActionState,
  buildActionQueue,
  pageActionQueue,
  extractNextDate,
  detectWaitReason,
  isDateDue,
  externalWaitText,
  externalSignalText,
} = require('../public/action-queue');

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
    commit: { hash: 'abc1234', message: 'Latest subject', date: daysAgoIso(3) },
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

const TODAY = new Date('2026-09-01T09:00:00+09:00');
const derive = (r) => deriveActionState(r, { today: TODAY });

// ---- dirty -> ACTION + Human gate ------------------------------------------

test('dirty な repo は ACTION + Human gate（最優先 priority）', () => {
  const d = derive(repo({ gitStatus: 'dirty', modifiedCount: 2 }));
  assert.strictEqual(d.state, 'ACTION');
  assert.strictEqual(d.section, 'queue');
  assert.strictEqual(d.humanGate, true);
  assert.strictEqual(d.priority, 10); // PRIORITY.ACTION_HUMAN
  assert.ok(d.whyNow.some((w) => w.includes('dirty')));
  assert.ok(d.whyNow.includes('Human gate'));
});

test('remote ahead な repo は ACTION + Human gate', () => {
  const d = derive(repo({ gitStatus: 'clean', remote: { enabled: true, status: 'ahead', ahead: 2, behind: 0 } }));
  assert.strictEqual(d.state, 'ACTION');
  assert.strictEqual(d.humanGate, true);
  assert.ok(d.whyNow.some((w) => w.includes('remote ahead')));
});

// ---- dogfooding + 観測待ち -> OBSERVE --------------------------------------

test('dogfooding + 受動的な観測待ち next action は OBSERVE（ACTION に昇格しない）', () => {
  const d = derive(repo({
    manualStatus: 'dogfooding',
    agentContextMarkdown: '# ctx\n\n## 次に行うこと\n\n実利用で不便が出ないか観測を継続する。実機確認待ち。\n',
  }));
  assert.strictEqual(d.state, 'OBSERVE');
  assert.strictEqual(d.section, 'queue');
  assert.strictEqual(d.priority, 40); // PRIORITY.OBSERVE
  assert.ok(d.whyNow.some((w) => w.includes('観測')));
});

test('dogfooding で next action が無い場合も OBSERVE（既定の観測文言）', () => {
  const d = derive(repo({ manualStatus: 'dogfooding', agentContextMarkdown: '', progressTail: '' }));
  assert.strictEqual(d.state, 'OBSERVE');
  assert.ok(d.now.length > 0);
});

// ---- dogfooding + 明示的修正作業 -> ACTION -------------------------------

test('dogfooding + next action に具体的修正作業が明示されていれば ACTION へ昇格', () => {
  const d = derive(repo({
    manualStatus: 'dogfooding',
    agentContextMarkdown: '# ctx\n\n## 次に行うこと\n\nアイコン読込順のバグを修正する。\n',
  }));
  assert.strictEqual(d.state, 'ACTION');
  assert.strictEqual(d.section, 'queue');
  assert.ok(d.whyNow.some((w) => w.includes('具体的作業')));
});

// ---- released --------------------------------------------------------------

test('released + 待ち理由なし は Action Queue 外（section none / state null）', () => {
  const d = derive(repo({ manualStatus: 'released', note: '', agentContextMarkdown: '', progressTail: '' }));
  assert.strictEqual(d.section, 'none');
  assert.strictEqual(d.state, null);
});

test('released + F-Droid 待ちが note に明示されていれば WAIT（Waiting セクション）', () => {
  const d = derive(repo({ manualStatus: 'released', note: 'F-Droid のマージ待ち。マージされたら README を更新する。' }));
  assert.strictEqual(d.state, 'WAIT');
  assert.strictEqual(d.section, 'waiting');
  assert.ok(d.whyNow.some((w) => w.includes('F-Droid')));
});

test('released + 公開後観測が明示されていれば OBSERVE', () => {
  const d = derive(repo({
    manualStatus: 'released',
    agentContextMarkdown: '# ctx\n\n## 既知の制約\n\nリリース後の反応を見る。公開後の様子を観測する。\n',
  }));
  assert.strictEqual(d.state, 'OBSERVE');
});

// ---- paused --------------------------------------------------------------

test('paused は WAIT（Waiting セクション）', () => {
  const d = derive(repo({ manualStatus: 'paused' }));
  assert.strictEqual(d.state, 'WAIT');
  assert.strictEqual(d.section, 'waiting');
  assert.strictEqual(d.priority, 50); // PRIORITY.WAIT
});

// ---- abandoned ----------------------------------------------------------

test('abandoned は Action Queue にも Waiting にも出さない', () => {
  const d = derive(repo({ manualStatus: 'abandoned', gitStatus: 'dirty' }));
  assert.strictEqual(d.section, 'none');
});

// ---- Increment 2.1: scanner error は portfolio 分類を変えない --------------

function scanErr(overrides = {}) {
  return repo({ kind: 'error', gitStatus: 'error', error: 'Git operation "repository probe" timed out after 15 seconds.', commit: null, remote: { enabled: false, status: 'disabled' }, ...overrides });
}

test('scan error だけでは Action Queue へ載せない（unknown status・context なし → section none）', () => {
  const d = derive(scanErr({ manualStatus: 'unknown', agentContextMarkdown: '', note: '' }));
  assert.strictEqual(d.section, 'none');
  assert.strictEqual(d.state, null);
  assert.strictEqual(d.scanUnavailable, true);
});

test('dogfooding + scan error → Watching / OBSERVE（scan error は section を変えない、主 Why は通常 dogfooding 文言）', () => {
  const d = derive(scanErr({ manualStatus: 'dogfooding' }));
  assert.strictEqual(d.state, 'OBSERVE');
  assert.strictEqual(d.section, 'queue'); // = Watching（Now ではない）
  assert.strictEqual(d.scanUnavailable, true);
  assert.ok(d.now.includes('観測') || d.now.length > 0);
  assert.ok(d.whyNow.some((w) => w.includes('dogfooding 観測中')));
  assert.ok(!d.whyNow.some((w) => w.includes('スキャン不可'))); // 主理由を置き換えない
});

test('paused + scan error → Waiting / WAIT / Why は paused（scan error が paused 意味論を消さない）', () => {
  const d = derive(scanErr({ manualStatus: 'paused' }));
  assert.strictEqual(d.state, 'WAIT');
  assert.strictEqual(d.section, 'waiting');
  assert.deepStrictEqual(d.whyNow, ['paused']);
  assert.strictEqual(d.scanUnavailable, true);
});

test('active + scan error + 次アクションなし → 通常 active 派生（OBSERVE / Watching。scan error で Waiting へ落とさない）', () => {
  const d = derive(scanErr({ manualStatus: 'active', agentContextMarkdown: '', progressTail: '' }));
  assert.strictEqual(d.state, 'OBSERVE');
  assert.strictEqual(d.section, 'queue');
  assert.ok(d.whyNow.some((w) => w.includes('active・次アクション未記載')));
});

test('active + scan error でも dirty / ahead / diverged を推測しない', () => {
  const d = derive(scanErr({ manualStatus: 'active' }));
  assert.strictEqual(d.humanGate, false);
  assert.ok(!d.whyNow.some((w) => /dirty|ahead|diverged/i.test(w)));
  assert.notStrictEqual(d.state, 'ACTION');
});

test('released + scan error + 運用 wait なし → section none（従来どおり queue 外）', () => {
  const d = derive(scanErr({ manualStatus: 'released', note: '', agentContextMarkdown: '' }));
  assert.strictEqual(d.section, 'none');
});

test('released + scan error + external wait → Waiting（external wait が優先）', () => {
  const d = derive(scanErr({ manualStatus: 'released', agentContextMarkdown: '# c\n\n## 外部イベント待ち\n\nF-Droid: test 待ち\n' }));
  assert.strictEqual(d.section, 'waiting');
  assert.strictEqual(d.state, 'WAIT');
  assert.ok(d.whyNow.some((w) => w.includes('外部イベント待ち')));
});

test('scan error + external event wait は scan error より優先（section waiting、Why は外部イベント待ち）', () => {
  const d = derive(scanErr({ manualStatus: 'dogfooding', agentContextMarkdown: '# c\n\n## 外部イベント待ち\n\nreviewer 待ち\n' }));
  assert.strictEqual(d.section, 'waiting');
  assert.ok(d.whyNow.some((w) => w.includes('外部イベント待ち')));
});

test('scan error + future 次回確認日 は scan error より優先（dogfooding → Waiting scheduled）', () => {
  const d = deriveActionState(scanErr({ manualStatus: 'dogfooding', agentContextMarkdown: '# c\n\n## 次回確認日\n\n2026-12-25\n' }), { today: TODAY });
  assert.strictEqual(d.nextDate, '2026-12-25');
  assert.strictEqual(d.section, 'waiting');
});

test('unknown + scan error + context なし → Action Queue に載せない（section none）', () => {
  const d = derive(scanErr({ manualStatus: 'unknown', agentContextMarkdown: '', note: '', hasProgress: false, progressTail: '' }));
  assert.strictEqual(d.section, 'none');
  assert.strictEqual(d.scanUnavailable, true);
});

test('scan error の理由文字列そのものは whyNow に scanner フラグとして出さない', () => {
  const d = derive(repo({ gitStatus: 'dirty', error: null }));
  assert.ok(!d.whyNow.some((w) => /scan error|no remote|long stale/i.test(w)));
});

// ---- Next date 抽出（制約 7）------------------------------------------------

test('明示ラベル付きの日付だけを Next date として抽出する', () => {
  assert.strictEqual(extractNextDate(['次回確認日: 2026-09-08']), '2026-09-08');
  assert.strictEqual(extractNextDate(['Next review: 2026/09/08']), '2026-09-08');
  assert.strictEqual(extractNextDate(['観測予定日 ： 2026-9-8']), '2026-09-08');
});

test('ラベルの無い散文中の日付は Next date に誤認しない（誤検出より未表示を優先）', () => {
  assert.strictEqual(extractNextDate(['latest commit: abc1234 Fix thing (2026-07-07)']), null);
  assert.strictEqual(extractNextDate(['v0.5.35 accepted 2026-08-22 に受け入れ済み']), null);
  assert.strictEqual(extractNextDate(['tag: wp70-rc3-production-like 2026-07-09']), null);
  assert.strictEqual(extractNextDate(['']), null);
  assert.strictEqual(extractNextDate(['不正な日付 次回確認日: 2026-13-40']), null);
});

test('deriveActionState は明示ラベル付き Next date を拾い、到来済みなら OBSERVE_DUE で queue 上位に置く', () => {
  const due = derive(repo({
    manualStatus: 'dogfooding',
    agentContextMarkdown: '# ctx\n\n## 既知の制約\n\n次回確認日: 2026-08-25\n',
  }));
  assert.strictEqual(due.nextDate, '2026-08-25');
  assert.strictEqual(due.nextDateDue, true);
  assert.strictEqual(due.state, 'OBSERVE');
  assert.strictEqual(due.section, 'queue');
  assert.strictEqual(due.priority, 30); // PRIORITY.OBSERVE_DUE

  const future = derive(repo({
    manualStatus: 'dogfooding',
    agentContextMarkdown: '# ctx\n\n## 既知の制約\n\n次回確認日: 2026-12-25\n',
  }));
  assert.strictEqual(future.nextDate, '2026-12-25');
  assert.strictEqual(future.nextDateDue, false);
  assert.strictEqual(future.section, 'waiting'); // 将来日付は scheduled
});

test('detectWaitReason は先頭優先で最初に一致した理由を返す', () => {
  assert.strictEqual(detectWaitReason(['F-Droid のマージ待ち']).key, 'fdroid');
  assert.strictEqual(detectWaitReason(['ストア審査待ち']).key, 'store-review');
  assert.strictEqual(detectWaitReason(['特になし']), null);
});

test('isDateDue は基準日以前を到来済みとみなす', () => {
  assert.strictEqual(isDateDue('2026-08-31', TODAY), true);
  assert.strictEqual(isDateDue('2026-09-01', TODAY), true);
  assert.strictEqual(isDateDue('2026-09-02', TODAY), false);
  assert.strictEqual(isDateDue(null, TODAY), false);
});

// ---- priority 順（idleDays を主要因にしない）-----------------------------

test('priority は前向きな運用 State 順（ACTION+Human > ACTION > OBSERVE_DUE > OBSERVE > WAIT）', () => {
  const repos = [
    repo({ name: 'wait-1', manualStatus: 'paused' }),
    repo({ name: 'observe-1', manualStatus: 'dogfooding' }),
    repo({ name: 'action-1', manualStatus: 'active', agentContextMarkdown: '# c\n\n## 次に行うこと\n\n設計を詰める。\n' }),
    repo({ name: 'action-human', gitStatus: 'dirty' }),
    repo({ name: 'observe-due', manualStatus: 'dogfooding', agentContextMarkdown: '# c\n\n## 既知の制約\n\n次回確認日: 2026-08-20\n' }),
  ];
  const { queue } = buildActionQueue(repos, { today: TODAY });
  assert.deepStrictEqual(
    queue.map((d) => d.name),
    ['action-human', 'action-1', 'observe-due', 'observe-1']
  );
});

test('idleDays は priority の主要因ではなく、同 priority 内の補助 tie-breaker に留まる', () => {
  const old = repo({ name: 'old-observe', manualStatus: 'dogfooding', commit: { hash: 'a', message: 'm', date: daysAgoIso(120) } });
  const fresh = repo({ name: 'fresh-action', manualStatus: 'active', commit: { hash: 'b', message: 'm', date: daysAgoIso(1) }, agentContextMarkdown: '# c\n\n## 次に行うこと\n\nテスト方針を決める。\n' });
  const { queue } = buildActionQueue([old, fresh], { today: TODAY });
  // 120日放置の OBSERVE より、1日前の ACTION が上位（idleDays では逆転しない）
  assert.strictEqual(queue[0].name, 'fresh-action');

  // 同 priority（OBSERVE 同士）では idleDays 大きい方が上位（補助 tie-breaker）
  const o1 = repo({ name: 'obs-30', manualStatus: 'dogfooding', commit: { hash: 'a', message: 'm', date: daysAgoIso(30) } });
  const o2 = repo({ name: 'obs-5', manualStatus: 'dogfooding', commit: { hash: 'b', message: 'm', date: daysAgoIso(5) } });
  const { queue: q2 } = buildActionQueue([o2, o1], { today: TODAY });
  assert.deepStrictEqual(q2.map((d) => d.name), ['obs-30', 'obs-5']);
});

// ---- KEEP / IMPROVE / EXPAND / RETIRE は State にしない（制約 5）---------

test('派生 State は ACTION / OBSERVE / WAIT / null のみ（KEEP/IMPROVE/EXPAND/RETIRE を返さない）', () => {
  const repos = [
    repo({ manualStatus: 'active' }),
    repo({ manualStatus: 'dogfooding' }),
    repo({ manualStatus: 'paused' }),
    repo({ manualStatus: 'released' }),
    repo({ manualStatus: 'abandoned' }),
    repo({ manualStatus: 'unknown' }),
    repo({ gitStatus: 'dirty' }),
  ];
  const allowed = new Set(['ACTION', 'OBSERVE', 'WAIT', null]);
  for (const r of repos) {
    assert.ok(allowed.has(deriveActionState(r, { today: TODAY }).state));
  }
});

// ---- 10 件超の表示制御 ---------------------------------------------------

test('pageActionQueue は既定で上位 10 件、超過分は hasMore / hiddenCount で表現する', () => {
  const items = Array.from({ length: 14 }, (_, i) => ({ name: `p${i}` }));
  const collapsed = pageActionQueue(items, false, 10);
  assert.strictEqual(collapsed.shown.length, 10);
  assert.strictEqual(collapsed.hiddenCount, 4);
  assert.strictEqual(collapsed.hasMore, true);

  const expanded = pageActionQueue(items, true, 10);
  assert.strictEqual(expanded.shown.length, 14);
  assert.strictEqual(expanded.hasMore, false);

  const few = pageActionQueue(items.slice(0, 7), false, 10);
  assert.strictEqual(few.shown.length, 7);
  assert.strictEqual(few.hasMore, false);
});

test('buildActionQueue は queue と waiting を分離し件数を集計する', () => {
  const repos = [
    repo({ name: 'a', gitStatus: 'dirty' }),
    repo({ name: 'b', manualStatus: 'dogfooding' }),
    repo({ name: 'c', manualStatus: 'paused' }),
    repo({ name: 'd', manualStatus: 'released', note: '' }),
    repo({ name: 'e', manualStatus: 'abandoned' }),
  ];
  const { queue, waiting, counts } = buildActionQueue(repos, { today: TODAY });
  assert.deepStrictEqual(queue.map((d) => d.name), ['a', 'b']);
  assert.deepStrictEqual(waiting.map((d) => d.name), ['c']);
  assert.strictEqual(counts.action, 1);
  assert.strictEqual(counts.observe, 1);
  assert.strictEqual(counts.total, 5);
});

// ---- Increment 1.1: Now / Watching / Waiting 3分割 ------------------------

test('ACTION は Now、通常 OBSERVE（dogfooding / active 未定義）は Watching へ入る', () => {
  const repos = [
    repo({ name: 'act', gitStatus: 'dirty' }),
    repo({ name: 'dogf', manualStatus: 'dogfooding' }),
    repo({ name: 'act-idle', manualStatus: 'active', agentContextMarkdown: '', progressTail: '' }),
  ];
  const { now, watching, waiting, counts } = buildActionQueue(repos, { today: TODAY });
  assert.deepStrictEqual(now.map((d) => d.name), ['act']);
  assert.deepStrictEqual(watching.map((d) => d.name).sort(), ['act-idle', 'dogf']);
  assert.deepStrictEqual(waiting.map((d) => d.name), []);
  assert.strictEqual(counts.now, 1);
  assert.strictEqual(counts.watching, 2);
  assert.strictEqual(counts.waiting, 0);
});

test('nextDateDue の OBSERVE は Now、future nextDate の OBSERVE は Waiting', () => {
  const due = derive(repo({
    name: 'due',
    manualStatus: 'dogfooding',
    agentContextMarkdown: '# c\n\n## 既知の制約\n\n次回確認日: 2026-08-20\n',
  }));
  assert.strictEqual(due.state, 'OBSERVE');
  assert.strictEqual(due.nextDateDue, true);

  const { now, waiting } = buildActionQueue([
    repo({ name: 'due', manualStatus: 'dogfooding', agentContextMarkdown: '# c\n\n## 既知の制約\n\n次回確認日: 2026-08-20\n' }),
    repo({ name: 'future', manualStatus: 'dogfooding', agentContextMarkdown: '# c\n\n## 既知の制約\n\n次回確認日: 2026-12-25\n' }),
  ], { today: TODAY });
  assert.deepStrictEqual(now.map((d) => d.name), ['due']);
  assert.deepStrictEqual(waiting.map((d) => d.name), ['future']);
});

test('paused は Waiting、released（待ち理由なし）は none（どのセクションにも出ない）', () => {
  const { now, watching, waiting } = buildActionQueue([
    repo({ name: 'p', manualStatus: 'paused' }),
    repo({ name: 'rel', manualStatus: 'released', note: '', agentContextMarkdown: '', progressTail: '' }),
  ], { today: TODAY });
  assert.deepStrictEqual(waiting.map((d) => d.name), ['p']);
  assert.ok(!now.concat(watching).some((d) => d.name === 'rel'));
});

test('Now は priority 順（既存 _compareDerived 再利用）', () => {
  const { now } = buildActionQueue([
    repo({ name: 'a-plain', manualStatus: 'active', agentContextMarkdown: '# c\n\n## 次に行うこと\n\n設計を詰める。\n' }),
    repo({ name: 'a-human', gitStatus: 'dirty' }),
  ], { today: TODAY });
  assert.deepStrictEqual(now.map((d) => d.name), ['a-human', 'a-plain']); // ACTION+Human(10) → ACTION(20)
});

// ---- Increment 1.1 B: Next date は PROGRESS 末尾から拾わない ---------------

test('PROGRESS.md 末尾に「次回確認日: 2026-09-08」が書かれていても Next date として拾わない', () => {
  const d = derive(repo({
    name: 'aw',
    manualStatus: 'active',
    agentContextMarkdown: '',
    note: '',
    hasProgress: true,
    progressTail: '- **次回確認日**: `次回確認日: 2026-09-08` / `Next review: 2026-09-08` のような明示ラベル…\n',
  }));
  assert.strictEqual(d.nextDate, null);
  assert.strictEqual(d.section, 'queue');
  assert.strictEqual(d.state, 'OBSERVE'); // active + 次アクション未記載 → Watching 相当
});

test('agentContextMarkdown に明示された「次回確認日: 2026-09-08」は拾う', () => {
  const d = derive(repo({
    manualStatus: 'active',
    agentContextMarkdown: '# c\n\n## 既知の制約\n\n次回確認日: 2026-09-08\n',
    note: '',
  }));
  assert.strictEqual(d.nextDate, '2026-09-08');
});

test('note に明示された「Next review: 2026-09-08」も拾う', () => {
  const d = derive(repo({
    manualStatus: 'active',
    agentContextMarkdown: '',
    note: 'blocked on external check. Next review: 2026-09-08',
  }));
  assert.strictEqual(d.nextDate, '2026-09-08');
});

test('extractNextDate の呼び出し元（deriveActionState）は agentContextMarkdown と note のみを走査する', () => {
  // 同じ文字列が progressTail にだけあると拾わない、note にあると拾う
  const inProgressOnly = derive(repo({ agentContextMarkdown: '', note: '', hasProgress: true, progressTail: '次回確認日: 2026-08-20' }));
  assert.strictEqual(inProgressOnly.nextDate, null);
  const inNote = derive(repo({ agentContextMarkdown: '', note: '次回確認日: 2026-08-20', hasProgress: true, progressTail: '' }));
  assert.strictEqual(inNote.nextDate, '2026-08-20');
});

// ---- Increment 2: 運用見出し（次回確認日 / 外部イベント待ち / 外部シグナル） ----

test('`## 次回確認日` 見出し形式から単一 ISO 日付を抽出する', () => {
  assert.strictEqual(extractNextDate(['# c\n\n## 次回確認日\n\n2026-09-08\n']), '2026-09-08');
  assert.strictEqual(extractNextDate(['## Next review\n\n2026-9-2']), '2026-09-02');
  assert.strictEqual(extractNextDate(['## 次回確認日\n\n2026-09-08\n\nメモ行']), '2026-09-08');
});

test('見出し本文が単一 ISO 日付でなければ拾わない（Day1/Day7・時刻・範囲・不正月日）', () => {
  assert.strictEqual(extractNextDate(['## 次回確認日\n\nDay 1: 2026-09-03']), null);
  assert.strictEqual(extractNextDate(['## 次回確認日\n\n2026-09-08 10:00']), null);
  assert.strictEqual(extractNextDate(['## 次回確認日\n\n2026-09-08 / 2026-09-15']), null);
  assert.strictEqual(extractNextDate(['## 次回確認日\n\n2026-13-40']), null);
  assert.strictEqual(extractNextDate(['## 次回確認日\n\n(not set)']), null);
});

test('PROGRESS 説明用の日付は Next date に拾わない（呼び出し元は agent context / note のみ走査）', () => {
  const d = derive(repo({
    manualStatus: 'active',
    agentContextMarkdown: '',
    note: '',
    hasProgress: true,
    progressTail: '- **次回確認日**: `次回確認日: 2026-09-08` / `Next review: 2026-09-08`\n## 次回確認日\n\n2026-09-08\n',
  }));
  assert.strictEqual(d.nextDate, null);
});

test('externalWaitText / externalSignalText は該当見出しの本文だけを返す', () => {
  const md = '# c\n\n## 現在地\n\nx\n\n## 外部イベント待ち\n\nF-Droid: test 待ち\n\n## 外部シグナル\n\nStar: 1\nDownloads: 8\n';
  assert.strictEqual(externalWaitText({ agentContextMarkdown: md }), 'F-Droid: test 待ち');
  assert.strictEqual(externalSignalText({ agentContextMarkdown: md }), 'Star: 1\nDownloads: 8');
  assert.strictEqual(externalWaitText({ agentContextMarkdown: '# c\n\n## 現在地\n\nx\n' }), '');
});

test('external wait 明示: active / dogfooding / released いずれも Waiting へ', () => {
  const md = '# c\n\n## 外部イベント待ち\n\nF-Droid: test 待ち\n';
  for (const st of ['active', 'dogfooding', 'released']) {
    const d = derive(repo({ manualStatus: st, agentContextMarkdown: md }));
    assert.strictEqual(d.state, 'WAIT', st);
    assert.strictEqual(d.section, 'waiting', st);
    assert.ok(d.whyNow.some((w) => w.includes('外部イベント待ち')), st);
    assert.strictEqual(d.externalWait, 'F-Droid: test 待ち', st);
  }
});

test('external wait を削除すると通常の派生分類へ戻る', () => {
  const withWait = derive(repo({ manualStatus: 'dogfooding', agentContextMarkdown: '# c\n\n## 外部イベント待ち\n\nF-Droid: test 待ち\n' }));
  assert.strictEqual(withWait.section, 'waiting');
  const without = derive(repo({ manualStatus: 'dogfooding', agentContextMarkdown: '# c\n\n## 現在地\n\n観測中\n' }));
  assert.strictEqual(without.state, 'OBSERVE');
  assert.strictEqual(without.section, 'queue'); // 通常の dogfooding OBSERVE = Watching
});

// ---- Increment 2: portfolio / no-git item ----

function portfolioRepo(overrides = {}) {
  return repo({
    name: 'Some Portfolio Item',
    path: 'D:\\work\\agent-workbench\\data\\portfolio-items\\Some Portfolio Item',
    kind: 'no-git',
    gitStatus: 'no-git',
    targetLabel: 'Portfolio',
    manualStatus: 'unknown',
    commit: null,
    remote: { enabled: false, status: 'disabled' },
    hasReadme: false,
    hasProgress: false,
    progressTail: '',
    ...overrides,
  });
}

test('portfolio no-git + 将来の次回確認日 → Waiting', () => {
  const d = derive(portfolioRepo({ agentContextMarkdown: '# x\n\n## 次に行うこと\n\n公開する\n\n## 次回確認日\n\n2026-12-25\n' }));
  assert.strictEqual(d.state, 'OBSERVE');
  assert.strictEqual(d.section, 'waiting');
  assert.strictEqual(d.nextDate, '2026-12-25');
});

test('portfolio no-git + 到来した次回確認日 → Now', () => {
  const d = derive(portfolioRepo({ agentContextMarkdown: '# x\n\n## 次に行うこと\n\n公開する\n\n## 次回確認日\n\n2026-08-25\n' }));
  assert.strictEqual(d.state, 'OBSERVE');
  assert.strictEqual(d.section, 'queue');
  assert.strictEqual(d.nextDateDue, true);
  const { now } = buildActionQueue([portfolioRepo({ agentContextMarkdown: '# x\n\n## 次回確認日\n\n2026-08-25\n' })], { today: TODAY });
  assert.strictEqual(now.length, 1);
});

test('portfolio no-git + 日付なし・作業なしの通常観測 → Watching', () => {
  const d = derive(portfolioRepo({ agentContextMarkdown: '# x\n\n## 現在地\n\n観測中\n' }));
  assert.strictEqual(d.state, 'OBSERVE');
  assert.strictEqual(d.section, 'queue');
  const { watching } = buildActionQueue([portfolioRepo({ agentContextMarkdown: '# x\n\n## 現在地\n\n観測中\n' })], { today: TODAY });
  assert.strictEqual(watching.length, 1);
});

test('portfolio no-git は具体的作業が書かれていても自動 ACTION にはしない（Now は due date 経由のみ）', () => {
  const d = derive(portfolioRepo({ agentContextMarkdown: '# x\n\n## 次に行うこと\n\nバグを修正する\n' }));
  assert.strictEqual(d.state, 'OBSERVE');
  assert.notStrictEqual(d.section, 'queue' && d.nextDateDue, true);
  assert.strictEqual(d.nextDateDue, false);
});

test('運用情報を持たない no-git ディレクトリ（tmp / *-signing 等）は Action Queue に入らない', () => {
  const bare = derive(repo({
    name: 'tmp', kind: 'no-git', gitStatus: 'no-git', manualStatus: 'unknown',
    commit: null, agentContextMarkdown: '', note: '', hasProgress: false, progressTail: '',
  }));
  assert.strictEqual(bare.section, 'none');
  assert.strictEqual(bare.state, null);
});

// ---- Increment 2: 初期 fixture 相当（synthetic。実 fixture は browser + live 確認） ----

test('WSL Clipboard Qiita 相当（次回確認日 2026-09-02）: 2026-09-01 は Waiting / 2026-09-02 は Now', () => {
  const md = '# WSL Clipboard Qiita\n\n## 現在地\n\n記事は公開準備完了。2026-09-02公開予定。\n\n## 次に行うこと\n\nQiitaへ記事を公開する。\n\n## 次回確認日\n\n2026-09-02\n';
  const item = () => portfolioRepo({ name: 'WSL Clipboard Qiita', agentContextMarkdown: md });
  const before = deriveActionState(item(), { today: new Date('2026-09-01T09:00:00+09:00') });
  assert.strictEqual(before.section, 'waiting');
  const onDay = deriveActionState(item(), { today: new Date('2026-09-02T09:00:00+09:00') });
  assert.strictEqual(onDay.section, 'queue');
  assert.strictEqual(onDay.nextDateDue, true);
  assert.strictEqual(onDay.state, 'OBSERVE'); // isNowItem(OBSERVE + due) === true → Now
});

test('Coconala 相当（次回確認日 2026-09-08）: 2026-09-01 は Waiting / 2026-09-08 は Now', () => {
  const md = '# Coconala\n\n## 現在地\n\nサービス公開済み。初期観測期間中。\n\n## 次に行うこと\n\n公開後7日時点のviews / favorites / inquiry / purchaseを確認する。\n\n## 次回確認日\n\n2026-09-08\n';
  const item = () => portfolioRepo({ name: 'Coconala', agentContextMarkdown: md });
  assert.strictEqual(deriveActionState(item(), { today: new Date('2026-09-01T09:00:00+09:00') }).section, 'waiting');
  const due = deriveActionState(item(), { today: new Date('2026-09-08T09:00:00+09:00') });
  assert.strictEqual(due.section, 'queue');
  assert.strictEqual(due.nextDateDue, true);
});

test('Pixel Tag Drawer 相当（dogfooding + 外部イベント待ち）→ Waiting', () => {
  const d = derive(repo({ name: 'sample-project', manualStatus: 'dogfooding', agentContextMarkdown: '# Sample project\n\n## Current state\n\n…\n\n## 外部イベント待ち\n\nExternal test 待ち\n' }));
  assert.strictEqual(d.section, 'waiting');
  assert.strictEqual(d.state, 'WAIT');
});

test('WolLight 相当（released + 外部イベント待ち）→ Waiting', () => {
  const d = derive(repo({ name: 'wol-light', manualStatus: 'released', agentContextMarkdown: '# WolLight\n\n## 外部イベント待ち\n\nF-Droid: test 待ち\n' }));
  assert.strictEqual(d.section, 'waiting');
  assert.strictEqual(d.state, 'WAIT');
});

// ---- UI wiring（index.html / app.js / service-worker.js の静的チェック）----
// 実ブラウザでのクリック確認の代わりに、配線を静的に確認する（project-signals.test.js と同じ方式）

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('index.html は action-queue.js を resume-summary.js/project-signals.js の後・app.js より前に読み込む', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('id="action-queue"'));
  const scanIdx = html.indexOf('src="resume-summary.js"');
  const signalsIdx = html.indexOf('src="project-signals.js"');
  const queueIdx = html.indexOf('src="action-queue.js"');
  const appIdx = html.indexOf('src="app.js"');
  assert.ok(scanIdx < signalsIdx && signalsIdx < queueIdx && queueIdx < appIdx);
  // 一覧テーブルの列数（10列）は Action Queue 追加後も回帰しない
  const headerMatches = html.match(/<th[ >]/g) || [];
  assert.strictEqual(headerMatches.length, 10);
});

test('app.js は Action Queue を Now / Watching / Waiting の3セクションで描画し、行から既存の詳細ペインへ移動する配線を持つ', () => {
  const app = read('public/app.js');
  assert.ok(app.includes('function renderActionQueue'));
  assert.ok(app.includes('buildActionQueue(state.repos'));
  assert.ok(app.includes("getElementById('action-queue')"));
  assert.ok(app.includes('function focusRepoFromActionQueue'));
  // 3セクション
  assert.ok(/const \{ now, watching, waiting, counts \} = buildActionQueue/.test(app));
  assert.ok(app.includes('Now（今やる）'));
  assert.ok(app.includes('Watching / 観測中（'));
  assert.ok(app.includes('Waiting / scheduled（'));
  // Now は 0 件でもセクションを出す
  assert.ok(app.includes('今すぐ対応する項目はありません'));
});

test('app.js は詳細ペインに運用（Portfolio）ブロックを描画する（State / Next review / External wait / External signal）', () => {
  const app = read('public/app.js');
  assert.ok(app.includes('function operationalBlockHtml'));
  assert.ok(/\$\{operationalBlockHtml\(r\)\}/.test(app));
  assert.ok(app.includes('運用（Portfolio）'));
  assert.ok(app.includes('Next review'));
  assert.ok(app.includes('External wait'));
  assert.ok(app.includes('External signal'));
  // typeof ガードで action-queue.js 未ロード時も落ちない
  assert.ok(app.includes("typeof extractNextDate === 'function'"));
});

test('classic script 共有スコープで resume-summary/project-signals/action-queue を連結しても衝突せず、buildActionQueue がグローバルへ出る', () => {
  // ブラウザは classic script をページ全体で 1 つのグローバル字句スコープで評価する。
  // 3 ファイルを連結して 1 つの vm context で実行し、トップレベル const の再宣言
  // （例: _buildResumeItems）で SyntaxError にならず、公開シンボルが globalThis
  // へ出ることを確認する（この検証が無いと Node の require 分離では衝突を見逃す）。
  const vm = require('vm');
  const concat = [
    'public/resume-summary.js',
    'public/project-signals.js',
    'public/action-queue.js',
  ].map(read).join('\n;\n');
  const ctx = { module: undefined, require: undefined, console };
  vm.createContext(ctx);
  vm.runInContext(concat, ctx, { filename: 'concat-classic-scripts.js' });
  assert.strictEqual(typeof ctx.buildActionQueue, 'function');
  assert.strictEqual(typeof ctx.deriveActionState, 'function');
  assert.strictEqual(typeof ctx.pageActionQueue, 'function');
  // Increment 2: 運用見出しパーサもグローバルへ出る（app.js / project-signals.js が使う）
  assert.strictEqual(typeof ctx.extractNextDate, 'function');
  assert.strictEqual(typeof ctx.externalWaitText, 'function');
  assert.strictEqual(typeof ctx.externalSignalText, 'function');
  // 実際に動くこと（buildResumeItems 連携込み）
  const { now, watching, waiting } = ctx.buildActionQueue([
    { name: 'x', path: 'p', kind: 'repo', targetLabel: 't', manualStatus: 'active', note: '',
      gitStatus: 'dirty', commit: { hash: 'a', message: 'm', date: new Date().toISOString() },
      remote: { enabled: false, status: 'disabled' }, agentContextMarkdown: '', hasProgress: false },
  ]);
  assert.strictEqual(now.length, 1);
  assert.strictEqual(now[0].state, 'ACTION');
  assert.strictEqual(watching.length, 0);
  assert.strictEqual(waiting.length, 0);
});

test('Scanner health（scan-details）は render() で自動 open されない（Action Queue より常に下位）', () => {
  const app = read('public/app.js');
  assert.ok(!/scanDetails\.open\s*=/.test(app));
  assert.ok(!/scan-details['"]\)\.open\s*=/.test(app));
  // 閉じた summary 部分のコンパクト警告件数（config error + missing/error target）
  assert.ok(app.includes('const warnCount = configErrCount + badTargets'));
  assert.ok(app.includes('`⚠ ${warnCount}'));
});

test('service worker の静的キャッシュ一覧に action-queue.js が含まれる', () => {
  const sw = read('public/service-worker.js');
  const assets = sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)[1];
  assert.ok(assets.includes('/action-queue.js'));
});

process.on('exit', (code) => {
  console.log(`\n${count} tests, ${code === 0 ? 'all passed' : 'FAILED'}`);
});
