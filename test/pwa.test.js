'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

let count = 0;
function test(name, fn) {
  count++;
  try {
    fn();
    console.log(`ok ${count} - ${name}`);
  } catch (error) {
    console.error(`not ok ${count} - ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

test('manifest is standalone and all local icons exist', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.strictEqual(manifest.name, 'Agent Workbench');
  assert.strictEqual(manifest.start_url, '/');
  assert.strictEqual(manifest.scope, '/');
  assert.strictEqual(manifest.display, 'standalone');
  assert.ok(/^#[0-9a-f]{6}$/i.test(manifest.theme_color));
  assert.deepStrictEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
  manifest.icons.forEach((icon) => {
    assert.ok(icon.src.startsWith('/icons/'));
    assert.ok(fs.existsSync(path.join(root, 'public', icon.src)));
  });
});

test('document links the manifest and mobile metadata', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'));
  assert.ok(html.includes('name="theme-color"'));
  assert.ok(html.includes('name="mobile-web-app-capable" content="yes"'));
  assert.ok(html.includes('rel="apple-touch-icon"'));
});

test('service worker never caches API or HTML responses', () => {
  const sw = read('public/service-worker.js');
  const assets = sw.match(/const STATIC_ASSETS = \[([\s\S]*?)\];/)[1];
  assert.ok(!assets.includes('/api/'));
  assert.ok(!assets.includes('/index.html'));
  assert.ok(!assets.includes("'/'"));
  assert.ok(sw.includes("url.pathname.startsWith('/api/')"));
  assert.ok(sw.includes("request.mode === 'navigate'"));
  assert.ok(sw.includes("cache: 'no-store'"));
  assert.ok(sw.includes("cache: 'no-cache'"));
  assert.ok(sw.includes('self.skipWaiting()'));
  assert.ok(sw.includes('self.clients.claim()'));
});

test('app registers the service worker without changing the server bind default', () => {
  const app = read('public/app.js');
  const server = read('server.js');
  assert.ok(app.includes("navigator.serviceWorker.register('/service-worker.js')"));
  assert.ok(server.includes("process.env.AGENT_WORKBENCH_HOST"));
  assert.ok(server.includes("|| '127.0.0.1'"));
  assert.ok(server.includes('process.env.AGENT_WORKBENCH_PORT'));
});

test('mobile workspace and desktop table rules coexist', () => {
  const css = read('public/style.css');
  assert.ok(css.includes('@media (max-width: 800px)'));
  assert.ok(css.includes('.summary-mobile'));
  assert.ok(css.includes('.advanced-filters'));
  assert.ok(css.includes('.repo-card'));
  assert.ok(css.includes('#repo-table thead { display: none; }'));
  // Phase 6-L: 旧2カラムdetail-grid用のflex order reorderingは、Documents/
  // Context/Diagnosticsがtab切替（どれか1つだけ表示）になったため不要になった。
  // 詳細ペインは.detail-content内で常時表示ブロック→タブ→panelの順に並ぶだけでよい
  assert.ok(!css.includes('.detail-grid'));
  assert.ok(css.includes('.detail-tabs'));
  // mobile Phase 3: PC幅のtab bar自体はmobileでは隠し、独立accordionへ置き換える
  assert.ok(css.includes('.detail-tabs { display: none; }'));
  assert.ok(css.includes('.mobile-accordion-toggle'));
  assert.ok(css.includes('.detail-panel.mobile-open { display: block; }'));
  assert.ok(css.includes('.development-session-block { padding: 9px; }'));
  assert.ok(css.includes('.development-session-actions button { width: 100%; min-height: 44px;'));
  assert.ok(css.includes('.handoff-block {'));
  assert.ok(css.includes('.agent-context-block { padding: 9px;'));
  assert.ok(css.includes('.summary-mobile { display: none; }'));
});

test('PROGRESS/README each carry a documents-body variant class, PROGRESS taller than README, with a bounded mobile fallback', () => {
  const css = read('public/style.css');
  const app = read('public/app.js');
  // PROGRESS（常時表示の主document）とREADME（折りたたみ）は別variantを持つ
  // ことで、両方を同時に開いてもDocuments全体が過度に長くならないようにする
  assert.ok(app.includes('class="progress-block-body documents-body documents-body-progress"'));
  assert.ok(app.includes('class="readme-block-body documents-body documents-body-readme"'));
  // PC: PROGRESSはclampで420〜720pxへ、READMEはより低いclampで320〜640pxへ
  // （実際のAlways/Resume/tab bar高さを見て決めた見積もり。1366x768でも
  // 実用的な高さを確保しつつ、1920x1080等の大画面では過度に低くしない）
  assert.ok(css.includes('.documents-body-progress { min-height: 420px; height: clamp(420px, 52vh, 720px); }'));
  assert.ok(css.includes('.documents-body-readme { min-height: 320px; height: clamp(320px, 45vh, 640px); }'));
  // mobile: PC側の大きなclamp/viewport絶対値を引きずらず、min()で頭打ちにする
  assert.ok(css.includes('.documents-body-progress { height: auto; min-height: 0; max-height: min(56vh, 480px); }'));
  assert.ok(css.includes('.documents-body-readme { height: auto; min-height: 0; max-height: min(52vh, 420px); }'));
});

process.on('exit', (code) => {
  console.log(`\n${count} PWA/mobile contract tests, ${code === 0 ? 'all passed' : 'FAILED'}`);
});
