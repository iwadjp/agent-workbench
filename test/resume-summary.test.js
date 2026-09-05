'use strict';

// public/resume-summary.js の単体テスト（node test/resume-summary.test.js で実行）。
// 外部フレームワークは使わない（assertのみ）。

const assert = require('assert');
const {
  RESUME_SECTIONS,
  RESUME_ITEM_MAX_CHARS,
  normalizeHeading,
  clipResumeText,
  extractResumeSections,
  buildResumeItems,
  renderResumeItemsHtml,
} = require('../public/resume-summary');

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

// ---- normalizeHeading / clipResumeText -------------------------------------

test('normalizeHeading: trim・小文字化・連続空白の圧縮', () => {
  assert.strictEqual(normalizeHeading('  Current   State '), 'current state');
  assert.strictEqual(normalizeHeading('現在地'), '現在地');
});

test('clipResumeText: 上限以下はそのまま、超過は省略記号付きで切る', () => {
  assert.strictEqual(clipResumeText('short'), 'short');
  const long = 'あ'.repeat(RESUME_ITEM_MAX_CHARS + 100);
  const clipped = clipResumeText(long);
  assert.ok(clipped.length <= RESUME_ITEM_MAX_CHARS);
  assert.ok(clipped.endsWith('…'));
});

// ---- extractResumeSections --------------------------------------------------

const FULL_JP = `# Agent context

## 現在地

Runtime helper sample v0.5.5まで受入済み。

## 最後の作業

LANアクセスとAgent context更新を受入済み。

## 次に行うこと

実運用で新しい不便が出るまで待機。

## 既知の制約

ログオン時自動起動はAccess denied。

## 再開方法

health-check.ps1で状態確認。
`;

test('日本語の定型見出し5項目をすべて抽出する', () => {
  const s = extractResumeSections(FULL_JP);
  assert.strictEqual(s.currentState, 'Runtime helper sample v0.5.5まで受入済み。');
  assert.strictEqual(s.lastWork, 'LANアクセスとAgent context更新を受入済み。');
  assert.strictEqual(s.nextAction, '実運用で新しい不便が出るまで待機。');
  assert.strictEqual(s.knownConstraints, 'ログオン時自動起動はAccess denied。');
  assert.strictEqual(s.resumeSteps, 'health-check.ps1で状態確認。');
});

test('英語エイリアス（Current state / Important constraints / Development re-entry）を抽出する', () => {
  const s = extractResumeSections(
    '# X agent context\n\n## Current state\n\ndogfooding中。\n\n## Important constraints\n\ntokenはコミットしない。\n\n## Development re-entry\n\nhealth-check後にVSCodeを開く。\n'
  );
  assert.strictEqual(s.currentState, 'dogfooding中。');
  assert.strictEqual(s.knownConstraints, 'tokenはコミットしない。');
  assert.strictEqual(s.resumeSteps, 'health-check後にVSCodeを開く。');
});

test('旧4フィールド合成形式（Current focus / Next action / Blockers / notes / Last handoff notes）を抽出する', () => {
  const s = extractResumeSections(
    '# Agent context\n\n## Current focus\n\nUI改善。\n\n## Next action\n\nテスト追加。\n\n## Blockers / notes\n\ndirtyのまま。\n\n## Last handoff notes\n\nlatest commit: abc1234\n'
  );
  assert.strictEqual(s.currentState, 'UI改善。');
  assert.strictEqual(s.nextAction, 'テスト追加。');
  assert.strictEqual(s.knownConstraints, 'dirtyのまま。');
  assert.strictEqual(s.lastWork, 'latest commit: abc1234');
});

test('見出しの大文字小文字・#の段数（#〜####）を区別しない', () => {
  const s = extractResumeSections('#### CURRENT STATE\n本文A\n# next ACTION\n本文B\n');
  assert.strictEqual(s.currentState, '本文A');
  assert.strictEqual(s.nextAction, '本文B');
});

test('本文は次の見出し（レベル問わず）までで区切る', () => {
  const s = extractResumeSections('## 現在地\n1行目\n2行目\n### 内訳\nここは含めない\n');
  assert.strictEqual(s.currentState, '1行目\n2行目');
});

test('空本文・"(not set)" の見出しは欠落扱いにする', () => {
  const s = extractResumeSections('## 現在地\n\n## 次に行うこと\n\n(not set)\n\n## 既知の制約\nあり\n');
  assert.strictEqual(s.currentState, undefined);
  assert.strictEqual(s.nextAction, undefined);
  assert.strictEqual(s.knownConstraints, 'あり');
});

test('定型に無い見出し（部分一致・類似見出し）は拾わない', () => {
  const s = extractResumeSections(
    '## 現在地について\n推測されそうな本文\n## Next development trigger\n新しい不便が出たら\n## Runtime policy\n方針\n'
  );
  assert.deepStrictEqual(s, {});
});

test('同じ見出しが複数ある場合は最初の一致のみ採用する', () => {
  const s = extractResumeSections('## 現在地\n最初\n## 現在地\n二番目\n');
  assert.strictEqual(s.currentState, '最初');
});

test('CRLF入力でも抽出できる', () => {
  const s = extractResumeSections('## 現在地\r\n本文\r\n');
  assert.strictEqual(s.currentState, '本文');
});

test('null・空文字は空オブジェクトを返す', () => {
  assert.deepStrictEqual(extractResumeSections(null), {});
  assert.deepStrictEqual(extractResumeSections(''), {});
});

// ---- buildResumeItems -------------------------------------------------------

const COMMIT = { hash: 'abc1234', message: 'Fix bug' };

test('全項目ありの場合、RESUME_SECTIONSの順で5項目返す', () => {
  const items = buildResumeItems({ contextMarkdown: FULL_JP });
  assert.deepStrictEqual(items.map((i) => i.key), RESUME_SECTIONS.map((d) => d.key));
  assert.deepStrictEqual(items.map((i) => i.label), ['現在地', '保存時の最後の作業', '次に行うこと', '既知の制約', '再開方法']);
  assert.ok(items.every((i) => i.source === 'context'));
});

test('Agent contextがPROGRESSより優先される（sourceで出典が分かる）', () => {
  const items = buildResumeItems({
    contextMarkdown: '## 現在地\ncontext側\n',
    progressTail: '## 現在地\nprogress側\n## 次に行うこと\nprogressのnext\n',
  });
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.strictEqual(byKey.currentState.text, 'context側');
  assert.strictEqual(byKey.currentState.source, 'context');
  assert.strictEqual(byKey.nextAction.text, 'progressのnext'); // 欠落項目はPROGRESSで補完
  assert.strictEqual(byKey.nextAction.source, 'progress');
});

test('記載が無い項目は含めない（推測しない）', () => {
  const items = buildResumeItems({ contextMarkdown: '## 現在地\nここだけ\n' });
  assert.deepStrictEqual(items.map((i) => i.key), ['currentState']);
});

// 以前は「最後の作業」に記載が無い場合、最新コミットへ自動フォールバックしていたが、
// 現在のHEADは呼び出し側が別枠「現在のrepo」として常に表示するため廃止した。
// 保存済みノートに古いcommit参照が含まれる場合、フォールバック文言と混ざって
// 現在のHEADと誤認されていたため（例: 保存済み "latest commit: 73daf10 ..." を
// 現在の最新コミットと取り違える）。したがって、記載が無ければ何も返さない
test('コミットが渡されても最後の作業へフォールバックしない（廃止済み）', () => {
  const items = buildResumeItems({ contextMarkdown: '', commit: COMMIT });
  assert.deepStrictEqual(items, []);
});

test('情報が何も無ければ空配列（エラーにならない）', () => {
  assert.deepStrictEqual(buildResumeItems({}), []);
  assert.deepStrictEqual(buildResumeItems(undefined), []);
  assert.deepStrictEqual(buildResumeItems({ contextMarkdown: '', progressTail: '' }), []);
});

test('非常に長い本文は上限文字数で切られる', () => {
  const items = buildResumeItems({ contextMarkdown: `## 現在地\n${'あ'.repeat(2000)}\n` });
  assert.ok(items[0].text.length <= RESUME_ITEM_MAX_CHARS);
  assert.ok(items[0].text.endsWith('…'));
});

// ---- renderResumeItemsHtml --------------------------------------------------

test('HTMLとして危険な文字列がエスケープされる', () => {
  const html = renderResumeItemsHtml([
    { key: 'currentState', label: '現在地', text: '<script>alert("x")</script> & <img src=x>' },
  ]);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&quot;'));
});

test('改行はテキストとして保持される（タグ化しない）', () => {
  const html = renderResumeItemsHtml([{ key: 'resumeSteps', label: '再開方法', text: '1行目\n2行目' }]);
  assert.ok(html.includes('1行目\n2行目'));
});

test('空配列は空文字を返す', () => {
  assert.strictEqual(renderResumeItemsHtml([]), '');
  assert.strictEqual(renderResumeItemsHtml(null), '');
});

process.on('exit', (code) => {
  console.log(`\n${count} tests, ${code === 0 ? 'all passed' : 'FAILED'}`);
});
