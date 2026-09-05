'use strict';

const STATUSES = ['active', 'dogfooding', 'paused', 'abandoned', 'released', 'unknown'];
const GIT_LABELS = {
  clean: 'clean',
  dirty: 'dirty',
  'untracked-only': 'untracked',
  'no-git': 'no git',
  error: 'error',
};
// kind が repo 以外のときは kind をバッジ表示する（missing は gitStatus では表現できない）
const KIND_LABELS = { 'no-git': 'no git', missing: 'missing', error: 'error' };
// git status ソート時の並び（問題のあるものが先）
const GIT_ORDER = { dirty: 0, error: 1, 'untracked-only': 2, 'no-git': 3, clean: 4 };
const STATUS_ORDER = { active: 0, dogfooding: 1, paused: 2, released: 3, unknown: 4, abandoned: 5 };
const COLS = 10; // テーブル列数（詳細行のcolspan用）

const VIEW_STATE_KEY = 'agentWorkbench.viewState.v8';
// 旧キー（新しい順に移行読み込みする。旧版に無いフィルタは all 扱いになる。
// v5以前の remotePlanFilter / visibilityFilter は Phase 3-F で UI から廃止したため無視する。
// v7以前の filters.target / filters.status は単一選択の文字列だったが、
// Phase 4-D で複数選択の配列（targets / statuses）に変更した。読み込み時に
// 1件だけの配列へ変換して引き継ぐ（applyStoredState参照））
const VIEW_STATE_KEYS_OLD = [
  'agentWorkbench.viewState.v7',
  'agentWorkbench.viewState.v6',
  'agentWorkbench.viewState.v5',
  'agentWorkbench.viewState.v4',
  'agentWorkbench.viewState.v3',
  'agentWorkbench.viewState.v2',
  'agentWorkbench.viewState.v1',
];
const PROGRESS_VIEW_MODES = ['markdown', 'plain'];
// Copy AI Handoff の「# 目的」テンプレート（Phase 5-F）。既存互換のため
// 先頭（status-proposal）は従来からの固定文言と同一にしてある
const HANDOFF_PURPOSES = [
  {
    key: 'status-proposal',
    label: '現状把握＋方針提案',
    text: 'このrepoの現在状況を確認し、次に進めるべき作業を提案してください。\nまず現状把握と方針提案まで行い、実装はまだ始めないでください。',
  },
  {
    key: 'status-only',
    label: '現状把握のみ',
    text: 'このrepoの現在状況を確認してください。\nREADME、PROGRESS、Agent context、git状態を確認し、現在地・未完了事項・注意点を整理してください。\n方針提案や実装はまだ行わないでください。',
  },
  {
    key: 'feedback-investigation',
    label: 'FB調査',
    text: 'ユーザーからのFBをもとに、このrepoの現状と原因候補を調査してください。\nまず再現条件、関連ファイル、影響範囲、修正方針案を整理してください。\n実装は、ユーザーが明示的に許可するまで始めないでください。',
  },
  {
    key: 'implement-approved',
    label: '承認済み変更を実装',
    text: 'ユーザーが承認した変更方針に従って、このrepoを必要最小限で修正してください。\n作業前に git status を確認し、影響範囲を把握してください。\n実装後は必要なテスト、git diff --check、git status を確認し、問題なければコミットしてください。\ntag / release / push は明示指示がない限り行わないでください。',
  },
  {
    key: 'acceptance-record',
    label: '受け入れ記録',
    text: '実装済みの変更を、ユーザー確認済みとして記録してください。\n原則として PROGRESS.md のみを更新し、コードや設定は変更しないでください。\ngit diff --check を実行し、問題なければ acceptance 記録のコミットを作成してください。\ntag / release / push は行わないでください。',
  },
  {
    key: 'dogfooding-check',
    label: 'dogfooding確認',
    text: 'このrepoのdogfooding状況を確認してください。\n実使用で確認すべき観点、既知の制約、次にFBが出た場合の開発再開手順を整理してください。\n実装はまだ始めないでください。',
  },
];
const HANDOFF_PURPOSE_KEY = 'agentWorkbench.handoffPurpose.v1';
const SORT_KEYS = ['name', 'target', 'manualStatus', 'gitStatus', 'commitDate', 'idleDays', 'changeCount'];
const GIT_FILTERS = ['all', 'not-clean', 'dirty', 'untracked-only', 'error', 'no-git'];
const PROGRESS_FILTERS = ['all', 'yes', 'no'];
const REMOTE_FILTERS = [
  'all', 'enabled', 'attention', 'up-to-date', 'ahead', 'behind', 'diverged',
  'no-remote', 'no-upstream', 'error', 'disabled',
];
const PRESETS = ['all', 'attention', 'active', 'dogfooding', 'dirty', 'noremote-audit'];

let state = { repos: [], scannedAt: null, scanRoot: '', configErrors: [] };
let openPath = null;
// Action Queue（Increment 1）: 既定は優先度上位10件表示。10件超は「すべて表示」で展開する。
// 派生ロジックは public/action-queue.js（buildActionQueue）。この画面は表示のみ。
let actionQueueExpanded = false;
// Phase 6-L/6-L follow-up x2: PC詳細画面下部のtab（Documents/Context/
// Diagnostics）。project切替時（openPathの変更）にDocumentsへ戻す（実画面確認の
// FBにより、開いた直後はAlways/Resume/PROGRESSを中心にした静かな初期表示が
// 最も自然だった。ContextのSaved context閲覧ブロックやREADME全文をいきなり
// 大きく表示しないため）。同じprojectの再描画（Rescan後等）やタブ自体の切替
// ではrenderTable()を呼ばずhidden属性だけ切り替えるため、この値は明示的に
// リセットしない限り維持される
let openPanel = 'documents';
// Documents内のPROGRESS/README選択（sub-tab。50ef416のサブタブ構造を復元。
// 実画面確認のFBにより、初期documentはREADME（従来のPROGRESSから変更）。
// project切替時はREADMEへ戻す。同じprojectの再描画・Rescan後は維持する
let documentsSubView = 'readme';
// README本文の折りたたみ開閉状態（初期closed。見出しと開閉UIだけを表示し、
// 開いた時だけ本文を表示する。PROGRESSには対応する折りたたみは無い）。
// project切替時はclosedへ戻す。同じprojectの再描画・Rescan後は維持する
let readmeExpanded = false;
// README.md表示モード（Markdown/Plain text）。progressViewModeと同様、
// project単位ではなく全体設定として扱う（プロジェクト切替でリセットしない）
let readmeViewMode = 'markdown';
// mobile Phase 3: Documents/Context/Diagnosticsのmobile accordion開閉状態。
// PCの`openPanel`/`hidden`属性（排他的なtab切替）とは完全に独立しており、
// mobileでは複数同時openを許容する。CSS側は`.detail-panel.mobile-open`で
// 制御し、`hidden`属性はPC側の排他制御のためにそのまま残す（mobileでは
// author CSSがUA既定の`[hidden]{display:none}`を上書きする）。
// project切替時は全てclosedへ戻す。同じprojectの再描画（Rescan後等）・
// resizeでのPC⇄mobile切替では維持する（resizeでJS側の状態を書き換える処理は無い）
let mobileAccordionOpen = { documents: false, context: false, diagnostics: false };
let sortKey = 'commitDate';
let sortDir = 'desc';
// targets/statuses は複数選択（空配列 = 絞り込みなし、複数選択はOR条件）。
// targetText は target表示名/idへの部分一致テキストフィルタ（大文字小文字区別なし）
let filters = {
  git: 'all', statuses: [], progress: 'all', targets: [], targetText: '', projectText: '', remote: 'all',
};
// 'attention' のみ複合条件のため明示的に保持。null は通常のフィルタ動作
let preset = null;
// PROGRESS.md 表示モード（全repo共通の表示設定。デフォルトは markdown）
let progressViewMode = 'markdown';
// Copy AI Handoff の「# 目的」テンプレート選択（全project共通。project別ではなく
// 単純なlocalStorageキー1つで保持する）。
// localStorageに既存の選択が無い（未設定の）場合のみ、この初期値が使われる。
// FBにより、未設定時のデフォルトは「現状把握のみ」（status-only）に変更した
// （saveHandoffPurpose()はユーザーがセレクトを操作した時だけ呼ばれるため、
// 既にどれかを選んだことがあるユーザーの保存値は loadHandoffPurpose() でそのまま尊重される）
let handoffPurpose = 'status-only';
const developmentSessionCache = new Map();

// ---- 表示状態の保存・復元 -------------------------------------------------

function applyStoredState(v) {
  if (!v || typeof v !== 'object') return;
  // 値を1つずつ検証し、不正な値は無視して初期値を維持する
  if (SORT_KEYS.includes(v.sortKey)) sortKey = v.sortKey;
  if (v.sortDir === 'asc' || v.sortDir === 'desc') sortDir = v.sortDir;
  if (v.filters && typeof v.filters === 'object') {
    if (GIT_FILTERS.includes(v.filters.git)) filters.git = v.filters.git;
    if (PROGRESS_FILTERS.includes(v.filters.progress)) filters.progress = v.filters.progress;
    // 不正な remote フィルタ値・未設定（v2以前）は all のまま
    if (REMOTE_FILTERS.includes(v.filters.remote)) filters.remote = v.filters.remote;
    // v5以前の remotePlanFilter / v4以前の visibilityFilter は Phase 3-F でUIから廃止。
    // 保存値に残っていても無視する（読み込みでも書き込みでも扱わない）

    // statuses: v8以降は配列。不正な値は除いて取り込む
    if (Array.isArray(v.filters.statuses)) {
      filters.statuses = v.filters.statuses.filter((s) => STATUSES.includes(s));
    }
    // v7以前は単一選択の文字列だった。statusesが空のときだけ1件として引き継ぐ
    if (
      filters.statuses.length === 0 &&
      typeof v.filters.status === 'string' &&
      STATUSES.includes(v.filters.status)
    ) {
      filters.statuses = [v.filters.status];
    }

    // targets: v8以降は配列。実データとの突き合わせは populateTargetFilter() で行う
    if (Array.isArray(v.filters.targets)) {
      filters.targets = v.filters.targets.filter((t) => typeof t === 'string' && t);
    }
    // v7以前は単一選択の文字列（'all' は「絞り込みなし」を意味した）
    if (
      filters.targets.length === 0 &&
      typeof v.filters.target === 'string' &&
      v.filters.target !== 'all' &&
      v.filters.target
    ) {
      filters.targets = [v.filters.target];
    }

    if (typeof v.filters.targetText === 'string') filters.targetText = v.filters.targetText;
    if (typeof v.filters.projectText === 'string') filters.projectText = v.filters.projectText;
  }
  if (v.preset === 'attention') preset = 'attention';
  // 不正な値・未設定（v6以前）は markdown のまま
  if (PROGRESS_VIEW_MODES.includes(v.progressViewMode)) progressViewMode = v.progressViewMode;
}

function loadViewState() {
  let raw = null;
  try {
    raw = localStorage.getItem(VIEW_STATE_KEY);
    // v3が無ければ旧バージョンから引き継ぐ
    for (const key of VIEW_STATE_KEYS_OLD) {
      if (raw) break;
      raw = localStorage.getItem(key);
    }
  } catch (e) {
    return; // localStorage不可の環境では初期状態のまま
  }
  if (!raw) return;
  try {
    applyStoredState(JSON.parse(raw));
  } catch (e) {
    // 壊れたJSONは捨てて初期状態に戻る
    try { localStorage.removeItem(VIEW_STATE_KEY); } catch (e2) { /* ignore */ }
  }
}

function saveViewState() {
  try {
    localStorage.setItem(
      VIEW_STATE_KEY,
      JSON.stringify({ sortKey, sortDir, filters, preset, progressViewMode })
    );
  } catch (e) { /* 保存できなくても動作は継続 */ }
}

// Handoff purpose は viewState とは別の単純なキーで保持する（全project共通、
// versioned migrationは不要なシンプルな1値のため）
function loadHandoffPurpose() {
  try {
    const raw = localStorage.getItem(HANDOFF_PURPOSE_KEY);
    if (raw && HANDOFF_PURPOSES.some((p) => p.key === raw)) handoffPurpose = raw;
  } catch (e) { /* localStorage不可の環境では初期値のまま */ }
}

function saveHandoffPurpose() {
  try {
    localStorage.setItem(HANDOFF_PURPOSE_KEY, handoffPurpose);
  } catch (e) { /* 保存できなくても動作は継続 */ }
}

// ---- ユーティリティ -------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// インライン記法（**bold** / `code`）を適用する。入力は必ず esc() 済みの文字列を渡すこと
// （HTMLをそのまま埋め込まないようにするため、エスケープ後の文字列だけを対象に変換する）
function mdInline(raw) {
  return esc(raw)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Markdown table の1行をセル配列に分解する（先頭/末尾の `|` は除去するだけの最小対応。
// エスケープされた `\|` や複数行セルには対応しない）
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

// separator行か判定する（---, :---, ---:, :---: のセルのみで構成されているか）
function isTableSeparatorRow(line) {
  if (!line || !line.includes('-')) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

// フラットな {indent, text} 配列から、インデントの増減だけを見てネスト構造の
// 木を組み立てる（2/4スペースなど正確な段数を仮定せず、前の項目との相対的な
// インデント増減で親子関係を判定するため、深さは特に制限しない）
function buildListTree(items) {
  const root = [];
  const stack = [{ indent: -1, children: root }];
  for (const { indent, text } of items) {
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const node = { text, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push({ indent, children: node.children });
  }
  return root;
}

function renderListTree(nodes) {
  if (!nodes || nodes.length === 0) return '';
  const items = nodes
    .map((n) => `<li>${mdInline(n.text)}${renderListTree(n.children)}</li>`)
    .join('');
  return `<ul>${items}</ul>`;
}

// PROGRESS.md 向けの最小Markdownレンダラ。完全なMarkdown互換ではなく、
// 見出し/箇条書き/コードブロック/インラインコード/bold/水平線/単純tableのみに
// 対応する軽量実装。外部ライブラリは使わない。HTMLは必ずescapeしてからDOMへ渡す。
function renderMiniMarkdown(text) {
  const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  let lines = src.split('\n');

  // PROGRESS.md は末尾だけを抜粋して渡されるため、抜粋の先頭にコードブロックの
  // 「閉じ」だけが孤立して残ることがある（開始位置が抜粋範囲より前にあるため）。
  // それを開始マーカーだと誤認すると、以降の見出し・箇条書きが軒並みコード
  // ブロックに飲み込まれてしまう。``` の出現数が奇数なら先頭が孤立した閉じである
  // とみなし、その行までを読み飛ばして以降だけを通常どおり解析する。
  const fenceCount = lines.filter((l) => /^```/.test(l)).length;
  if (fenceCount % 2 === 1) {
    const firstFenceIndex = lines.findIndex((l) => /^```/.test(l));
    if (firstFenceIndex !== -1) lines = lines.slice(firstFenceIndex + 1);
  }

  const out = [];
  let paragraph = [];
  let list = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${mdInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      out.push(renderListTree(buildListTree(list)));
      list = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // fenced code block: ``` 〜 ```（言語指定は無視。中身はそのままescapeして表示）
    if (/^```/.test(line)) {
      flushParagraph();
      flushList();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // 閉じ ``` を読み飛ばす（無い場合はそのままファイル末尾まで）
      out.push(`<pre class="md-code"><code>${esc(codeLines.join('\n'))}</code></pre>`);
      continue;
    }

    // 単純なMarkdown table: header行の次がseparator行なら表として扱う
    if (line.includes('|') && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      flushParagraph();
      flushList();
      const headerCells = splitTableRow(line);
      i += 2; // header行とseparator行を読み飛ばす
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = `<tr>${headerCells.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr>`;
      const tbody = bodyRows
        .map((row) => `<tr>${row.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(
        `<div class="md-table-wrap"><table class="md-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`
      );
      continue;
    }

    // 見出し: # 〜 ####
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${mdInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // 水平線: ---
    if (/^-{3,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr>');
      i++;
      continue;
    }

    // 箇条書き: - item（先頭の空白でネスト段を判定。2/4スペースいずれでも、
    // 前の項目との相対的なインデント増減があれば1段深いリストとして扱う）
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      list.push({ indent: bullet[1].length, text: bullet[2] });
      i++;
      continue;
    }
    flushList();

    // 空行は段落の区切り
    if (line.trim() === '') {
      flushParagraph();
      i++;
      continue;
    }

    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

function fmtDate(iso, withSeconds) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  let s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  if (withSeconds) s += ':' + p(d.getSeconds());
  return s;
}

// 放置日数（暦日ベース）。commit dateが無ければnull
function idleDays(r) {
  if (!r.commit || !r.commit.date) return null;
  const d = new Date(r.commit.date);
  if (isNaN(d)) return null;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = startOfDay(new Date()) - startOfDay(d);
  return Math.max(0, Math.round(diff / 86400000));
}

function idleLabel(days) {
  if (days == null) return 'unknown';
  if (days === 0) return 'today';
  return `${days} days`;
}

function idleClass(days) {
  if (days == null) return 'idle-unknown';
  if (days >= 30) return 'idle-old';
  if (days >= 7) return 'idle-stale';
  return 'idle-fresh';
}

function fmtMs(ms) {
  if (ms == null) return '-';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

async function api(url, options) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---- フィルタ・ソート -----------------------------------------------------

function sortValue(r, key) {
  switch (key) {
    case 'name': return r.name.toLowerCase();
    case 'target': return r.targetLabel || '';
    case 'manualStatus': return STATUS_ORDER[r.manualStatus] ?? 9;
    case 'gitStatus': return GIT_ORDER[r.gitStatus] ?? 9;
    case 'commitDate': return r.commit && r.commit.date ? new Date(r.commit.date).getTime() : null;
    case 'idleDays': return idleDays(r);
    case 'changeCount': return r.modifiedCount + r.untrackedCount;
    default: return r.name;
  }
}

// remote status フィルタの判定（他のフィルタと常に AND）
function matchesRemoteFilter(r) {
  const f = filters.remote;
  if (f === 'all') return true;
  const rm = r.remote;
  const enabled = !!(rm && rm.enabled);
  if (f === 'enabled') return enabled;
  if (f === 'disabled') return !enabled;
  if (f === 'attention') {
    // remote上の要注意状態。no-remote は棚卸し用のため含めない
    return enabled && ['ahead', 'behind', 'diverged', 'error'].includes(rm.status);
  }
  return enabled && rm.status === f;
}

// target の複数選択・テキストフィルタ判定（AND: 選択target一致 AND テキスト部分一致）
function matchesTargetFilter(r) {
  if (filters.targets.length > 0 && !filters.targets.includes(r.targetLabel)) return false;
  if (filters.targetText) {
    const needle = filters.targetText.trim().toLowerCase();
    if (needle) {
      const label = (r.targetLabel || '').toLowerCase();
      const id = (r.targetId || '').toLowerCase();
      if (!label.includes(needle) && !id.includes(needle)) return false;
    }
  }
  return true;
}

// manual status の複数選択判定（空配列 = 絞り込みなし、複数選択はOR）
function matchesStatusFilter(r) {
  if (filters.statuses.length === 0) return true;
  return filters.statuses.includes(r.manualStatus);
}

function matchesProjectText(r) {
  const needle = String(filters.projectText || '').trim().toLowerCase();
  if (!needle) return true;
  return (r.name || '').toLowerCase().includes(needle) ||
    (r.path || '').toLowerCase().includes(needle);
}

function isAttentionRepo(r) {
  if (r.manualStatus === 'abandoned') return false;
  return r.gitStatus !== 'clean' ||
    r.manualStatus === 'active' || r.manualStatus === 'dogfooding';
}

function matchesFilters(r) {
  if (!matchesProjectText(r)) return false;
  // target はプリセットとは独立した「範囲」の絞り込みとして常に適用する
  if (!matchesTargetFilter(r)) return false;
  if (!matchesRemoteFilter(r)) return false;
  if (preset === 'attention') {
    // abandoned は「もう追わない」と判断済みのため、no-git等のnot-cleanでも
    // Attentionには出さない（見たい場合はstatus filterで明示的に選ぶ運用）
    if (!isAttentionRepo(r)) return false;
  } else {
    if (filters.git === 'not-clean' && r.gitStatus === 'clean') return false;
    if (filters.git !== 'all' && filters.git !== 'not-clean' && r.gitStatus !== filters.git) return false;
    if (!matchesStatusFilter(r)) return false;
  }
  if (filters.progress === 'yes' && !r.hasProgress) return false;
  if (filters.progress === 'no' && r.hasProgress) return false;
  return true;
}

function visibleRepos() {
  const repos = state.repos.filter(matchesFilters);
  const dir = sortDir === 'asc' ? 1 : -1;
  repos.sort((a, b) => {
    const va = sortValue(a, sortKey);
    const vb = sortValue(b, sortKey);
    // 値が取れないものは方向に関係なく末尾へ
    if (va == null && vb == null) return a.name.localeCompare(b.name, 'ja');
    if (va == null) return 1;
    if (vb == null) return -1;
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return a.name.localeCompare(b.name, 'ja');
  });
  return repos;
}

// 単一statusと同一視できるか（プリセットは単一status選択のショートカットのため）
function statusesEqual(single) {
  return filters.statuses.length === 1 && filters.statuses[0] === single;
}

// 現在のフィルタ状態から「選択中」とみなせるプリセットを返す
// （target系フィルタはプリセットとは独立した「範囲」の絞り込みのため無関係）
function currentPreset() {
  if (preset === 'attention') return 'attention';
  // No-remote audit: remote=no-remote のみに依存する（origin未設定repoの棚卸し用）
  if (
    filters.git === 'all' && filters.statuses.length === 0 && filters.progress === 'all' &&
    filters.remote === 'no-remote'
  ) return 'noremote-audit';
  if (filters.progress !== 'all' || filters.remote !== 'all') return null;
  if (filters.git === 'all' && filters.statuses.length === 0) return 'all';
  if (filters.git === 'not-clean' && filters.statuses.length === 0) return 'dirty';
  if (filters.git === 'all' && statusesEqual('active')) return 'active';
  if (filters.git === 'all' && statusesEqual('dogfooding')) return 'dogfooding';
  return null;
}

function applyPreset(name) {
  preset = name === 'attention' ? 'attention' : null;
  filters.progress = 'all';
  filters.remote = 'all'; // プリセットは git/status ベース。remote絞り込みは解除する
  // target系（targets / targetText）はプリセットとは独立した「範囲」の絞り込みのため、
  // プリセット適用時にリセットしない（既存のtarget単一選択フィルタの方針を踏襲）
  switch (name) {
    case 'all':
    case 'attention':
      filters.git = 'all';
      filters.statuses = [];
      break;
    case 'active':
      filters.git = 'all';
      filters.statuses = ['active'];
      break;
    case 'dogfooding':
      filters.git = 'all';
      filters.statuses = ['dogfooding'];
      break;
    case 'dirty':
      filters.git = 'not-clean';
      filters.statuses = [];
      break;
    case 'noremote-audit':
      // origin未設定repoを一覧表示するだけ。判断はnoteに書く（remotePlanには依存しない）
      filters.git = 'all';
      filters.statuses = [];
      filters.remote = 'no-remote';
      break;
  }
  syncFilterControls();
  saveViewState();
  renderTable();
}

function syncFilterControls() {
  document.getElementById('filter-git').value = filters.git;
  document.getElementById('filter-progress').value = filters.progress;
  document.getElementById('filter-remote').value = filters.remote;
  document.getElementById('project-search').value = filters.projectText;
  syncStatusMultiSelect();
  syncTargetMultiSelect();
}

// ms-toggle ボタンの表示文言・強調状態を更新する
function updateMsToggleLabel(kind) {
  const btn = document.querySelector(`[data-role="ms-toggle"][data-ms="${kind}"]`);
  if (!btn) return;
  if (kind === 'target') {
    const parts = [];
    if (filters.targets.length > 0) parts.push(`${filters.targets.length}件選択`);
    if (filters.targetText.trim()) parts.push(`text:"${filters.targetText.trim()}"`);
    btn.textContent = parts.length ? `target: ${parts.join(' / ')}` : 'target: すべて';
    btn.classList.toggle('ms-active', parts.length > 0);
  } else if (kind === 'status') {
    btn.textContent = filters.statuses.length > 0 ? `status: ${filters.statuses.length}件選択` : 'status: すべて';
    btn.classList.toggle('ms-active', filters.statuses.length > 0);
  }
}

// STATUSES は固定なのでチェックボックス自体は index.html に静的に用意されている。
// 保存状態に合わせてチェック状態だけ同期する
function syncStatusMultiSelect() {
  document.querySelectorAll('[data-role="status-checks"] input[type="checkbox"]').forEach((cb) => {
    cb.checked = filters.statuses.includes(cb.value);
  });
  updateMsToggleLabel('status');
}

function syncTargetMultiSelect() {
  document.querySelectorAll('[data-role="target-checks"] input[type="checkbox"]').forEach((cb) => {
    cb.checked = filters.targets.includes(cb.value);
  });
  const textInput = document.querySelector('[data-role="target-text"]');
  if (textInput) textInput.value = filters.targetText;
  updateMsToggleLabel('target');
}

// 実データの targetLabel からチェックボックスを生成する
function populateTargetFilter() {
  const container = document.querySelector('[data-role="target-checks"]');
  const labels = [...new Set(state.repos.map((r) => r.targetLabel).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'ja')
  );
  container.innerHTML = labels
    .map(
      (l) =>
        `<label><input type="checkbox" value="${esc(l)}"${filters.targets.includes(l) ? ' checked' : ''}> ${esc(l)}</label>`
    )
    .join('');
  // 保存されていた選択のうち実データに存在しないものは除去する
  const before = filters.targets.length;
  filters.targets = filters.targets.filter((t) => labels.includes(t));
  if (filters.targets.length !== before) saveViewState();
  updateMsToggleLabel('target');
}

// ---- 描画 -----------------------------------------------------------------

function renderSummary() {
  const repos = state.repos;
  const count = (fn) => repos.filter(fn).length;
  const cards = [
    { label: 'repos', value: repos.length },
    { label: 'clean', value: count((r) => r.gitStatus === 'clean') },
    { label: 'dirty', value: count((r) => r.gitStatus === 'dirty'), warn: true },
    { label: 'untracked', value: count((r) => r.gitStatus === 'untracked-only') },
  ];
  const missing = count((r) => r.kind === 'missing');
  if (missing > 0) cards.push({ label: 'missing', value: missing, warn: true });
  for (const st of STATUSES) {
    const n = count((r) => r.manualStatus === st);
    if (n > 0) cards.push({ label: st, value: n });
  }
  const desktopCards = cards.map(
      (c) => `<div class="card${c.warn && c.value > 0 ? ' warn' : ''}">
        <div class="value">${c.value}</div><div class="label">${esc(c.label)}</div></div>`
    ).join('');
  const attention = count(isAttentionRepo);
  const active = count((r) => r.manualStatus === 'active');
  const dogfooding = count((r) => r.manualStatus === 'dogfooding');
  const dirty = count((r) => r.gitStatus === 'dirty');
  document.getElementById('summary').innerHTML = `
    <div class="summary-desktop">${desktopCards}</div>
    <div class="summary-mobile" aria-label="project summary">
      <span><strong>${repos.length}</strong> repos</span>
      <span class="summary-attention"><strong>${attention}</strong> Attention</span>
      <span><strong>${active}</strong> Active</span>
      <span><strong>${dogfooding}</strong> Dogfooding</span>
      <span class="summary-dirty"><strong>${dirty}</strong> Dirty</span>
    </div>`;
}

// ---- Action Queue（Increment 1）-----------------------------------------
// repo scanner（下部テーブル）とは分離した「次に何を進めるべきか」の判断ビュー。
// 3つの役割を混同しない:
//   Action Queue  = 何をするか
//   repo table    = 何が存在するか
//   Scanner health（スキャン詳細）= Workbench 自体が正常か
// 派生（State / Now / Why now / Next date / Human gate / priority）はすべて
// public/action-queue.js の純粋関数に置き、ここは表示だけを行う。
// scan error / no remote / long stale 等の scanner 情報はここに出さない。

function actionQueueWhyHtml(whys) {
  if (!whys || whys.length === 0) return '<span class="aq-why aq-why-none">—</span>';
  return whys.map((w) => `<span class="aq-why">${esc(w)}</span>`).join('');
}

function actionQueueDateHtml(d) {
  if (!d.nextDate) return '<span class="cdate">—</span>';
  return `<span class="aq-date${d.nextDateDue ? ' aq-date-due' : ''}" title="${d.nextDateDue ? '次回確認日が到来しています' : '次回確認予定日'}">${esc(d.nextDate)}</span>`;
}

function actionQueueRowHtml(d, withHuman) {
  const stateCls = 'aq-state-' + String(d.state || 'none').toLowerCase();
  const scanWarn = d.scanUnavailable
    ? '<span class="aq-scan-warn" title="スキャン不可。Scanner health を確認してください">scan?</span>'
    : '';
  const humanCell = withHuman
    ? `<td class="aq-human">${d.humanGate ? '<span class="aq-human-yes" title="人間の操作・判断が必要">要</span>' : '<span class="cdate">–</span>'}</td>`
    : '';
  return `<tr class="aq-row" data-path="${esc(d.path)}" tabindex="0" role="button" aria-label="${esc(d.name)} の詳細を開く">
    <td class="aq-name"><span class="aq-name-text">${esc(d.name)}</span><span class="aq-target">${esc(d.targetLabel || '')}</span>${scanWarn}</td>
    <td><span class="badge ${stateCls}">${esc(d.state || '-')}</span></td>
    <td class="aq-now">${d.now ? esc(d.now) : '<span class="cdate">—</span>'}</td>
    <td class="aq-whys">${actionQueueWhyHtml(d.whyNow)}</td>
    <td class="aq-next-date">${actionQueueDateHtml(d)}</td>
    ${humanCell}
  </tr>`;
}

// Now / Watching / Waiting 共通のテーブル本体（Now のみ Human 列あり）。
function actionQueueTableHtml(items, opts) {
  const withHuman = !!(opts && opts.withHuman);
  const nowHeader = opts && opts.nowLabel ? opts.nowLabel : 'Now / 待ち理由';
  const humanTh = withHuman ? '<th>Human</th>' : '';
  return `<table class="aq-table${opts && opts.extraClass ? ' ' + opts.extraClass : ''}">
    <thead><tr><th>project</th><th>State</th><th>${nowHeader}</th><th>Why</th><th>次回確認日</th>${humanTh}</tr></thead>
    <tbody>${items.map((d) => actionQueueRowHtml(d, withHuman)).join('')}</tbody>
  </table>`;
}

function renderActionQueue() {
  const el = document.getElementById('action-queue');
  if (!el) return;
  if (typeof buildActionQueue !== 'function') {
    // action-queue.js がロード・実行されていない（script 追加漏れ・SyntaxError 等）。
    // 黙って空表示にせず、原因を追えるようにログを出す。
    console.warn('[action-queue] buildActionQueue is not available; action-queue.js failed to load or evaluate');
    el.innerHTML = '<p class="aq-empty">Action Queue を初期化できませんでした（action-queue.js の読み込みを確認してください）。</p>';
    return;
  }
  const { now, watching, waiting, counts } = buildActionQueue(state.repos || []);
  const page = typeof pageActionQueue === 'function'
    ? pageActionQueue(now, actionQueueExpanded, 10)
    : { shown: now.slice(0, 10), hiddenCount: Math.max(0, now.length - 10), hasMore: now.length > 10 };

  const head = `<div class="aq-head">
    <h2>Action Queue</h2>
    <span class="aq-counts">今やる ${counts.now} 件・観測中 ${counts.watching} 件・待ち ${counts.waiting} 件</span>
  </div>`;

  // --- Now（常時展開。0 件でもセクションを出す） ---
  let nowHtml;
  if (now.length === 0) {
    nowHtml = '<p class="aq-empty">今すぐ対応する項目はありません。</p>';
  } else {
    nowHtml = actionQueueTableHtml(page.shown, { withHuman: true, nowLabel: 'Now（次にやること）' });
    if (page.hasMore || (actionQueueExpanded && now.length > 10)) {
      nowHtml += `<button type="button" class="aq-toggle" data-role="aq-toggle">${
        actionQueueExpanded ? '上位10件だけ表示' : `すべて表示（残り ${page.hiddenCount} 件）`
      }</button>`;
    }
  }
  const nowSection = `<div class="aq-section aq-section-now"><h3 class="aq-section-head">Now（今やる）</h3>${nowHtml}</div>`;

  // --- Watching（既定折りたたみ。件数を見出しに） ---
  let watchingSection = '';
  if (watching.length > 0) {
    watchingSection = `<details class="aq-section aq-watching">
      <summary>Watching / 観測中（${watching.length}）</summary>
      ${actionQueueTableHtml(watching, { withHuman: false, extraClass: 'aq-table-secondary' })}
    </details>`;
  }

  // --- Waiting / scheduled（既定折りたたみ。件数を見出しに） ---
  let waitingSection = '';
  if (waiting.length > 0) {
    waitingSection = `<details class="aq-section aq-waiting">
      <summary>Waiting / scheduled（${waiting.length}）</summary>
      ${actionQueueTableHtml(waiting, { withHuman: false, extraClass: 'aq-table-secondary' })}
    </details>`;
  }

  el.innerHTML = head + nowSection + watchingSection + waitingSection;
}

// Action Queue の行から既存の詳細ペインへ移動する。Action Queue は toolbar の
// フィルタとは独立した portfolio ビューのため、現在のフィルタで対象 repo が
// 一覧に出ていない場合はフィルタを全解除してから開く。
function focusRepoFromActionQueue(repoPath) {
  const repo = (state.repos || []).find((r) => r.path === repoPath);
  if (!repo) return;
  const currentDetailTr = openPath
    ? document.querySelector(`tr.detail-row[data-detail="${CSS.escape(openPath)}"]`)
    : null;
  if (currentDetailTr && hasUnsavedContextEdit(currentDetailTr)) {
    if (!confirm('Agent contextの編集内容が保存されていません。破棄してprojectを切り替えますか？')) return;
  }
  if (!visibleRepos().some((r) => r.path === repoPath)) {
    preset = null;
    filters = { git: 'all', statuses: [], progress: 'all', targets: [], targetText: '', projectText: '', remote: 'all' };
    syncFilterControls();
    saveViewState();
  }
  if (openPath !== repoPath) {
    openPanel = 'documents';
    documentsSubView = 'readme';
    readmeExpanded = false;
    mobileAccordionOpen = { documents: false, context: false, diagnostics: false };
  }
  openPath = repoPath;
  renderTable();
  const row = document.querySelector(`tr.repo-row[data-path="${CSS.escape(repoPath)}"]`);
  if (row && typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderConfigErrors() {
  const el = document.getElementById('config-errors');
  const errs = state.configErrors || [];
  if (errs.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = errs
    .map((e) => `<div>⚠ ${esc(e.targetId ? e.targetId + ': ' : '')}${esc(e.error)}${e.path ? ` (${esc(e.path)})` : ''}</div>`)
    .join('');
}

// target別スキャン状況の簡易表示。missing/error/slow は目立たせる
function renderTargetSummary() {
  const el = document.getElementById('target-summary');
  const meta = document.getElementById('scan-details-meta');
  const sum = state.scanSummary;
  if (!sum || !Array.isArray(sum.targets) || sum.targets.length === 0) {
    el.innerHTML = '';
    meta.textContent = '';
    return;
  }
  const badTargets = sum.targets.filter((t) => t.status === 'missing' || t.status === 'error').length;
  const verySlowTargets = sum.targets.filter((t) => (t.durationMs || 0) >= 10000).length;
  const slowTargets = sum.targets.filter((t) => (t.durationMs || 0) >= 3000 && (t.durationMs || 0) < 10000).length;
  // 閉じた summary 部分のコンパクト警告。config error + missing/error target の実件数。
  const configErrCount = Array.isArray(state.configErrors) ? state.configErrors.length : 0;
  const warnCount = configErrCount + badTargets;
  const warnPrefix = warnCount > 0 ? `⚠ ${warnCount}  ` : '';
  meta.textContent = `${warnPrefix}${sum.targets.length} targets · total ${fmtMs(sum.durationMs)} · error ${badTargets}`;
  meta.className = 'scan-details-meta';
  if (warnCount > 0 || verySlowTargets > 0) meta.classList.add('is-bad');
  else if (slowTargets > 0) meta.classList.add('is-slow');
  const items = sum.targets.map((t) => {
    const cls = ['ts-item'];
    let text;
    let readdirHtml = '';
    if (t.status === 'disabled') {
      cls.push('ts-disabled');
      text = `${t.targetLabel} disabled`;
    } else if (t.status === 'missing' || t.status === 'error') {
      cls.push('ts-bad');
      text = `${t.targetLabel} ${t.status}`;
    } else {
      const sec = (t.durationMs / 1000).toFixed(1);
      if (t.durationMs >= 10000) cls.push('ts-veryslow');
      else if (t.durationMs >= 3000) cls.push('ts-slow');
      const n = t.projectCount === 1 ? '1 project' : `${t.projectCount} projects`;
      text = `${t.targetLabel} ok ${n} ${sec}s`;
      if (t.durationMs >= 10000) text += ' (very slow)';
      else if (t.durationMs >= 3000) text += ' (slow)';
      const slowN = (t.slowProjectCount || 0) + (t.verySlowProjectCount || 0);
      if (slowN > 0) text += ` [slow repo: ${slowN}]`;
      if (t.excludedCount > 0) text += ` excluded:${t.excludedCount}`;
      // remoteStatus:true の target には remote 集計を付ける
      if (t.remoteEnabled) {
        const parts = [];
        if (t.remoteAheadCount) parts.push(`ahead:${t.remoteAheadCount}`);
        if (t.remoteBehindCount) parts.push(`behind:${t.remoteBehindCount}`);
        if (t.remoteDivergedCount) parts.push(`div:${t.remoteDivergedCount}`);
        if (t.remoteNoUpstreamCount) parts.push(`no-upstream:${t.remoteNoUpstreamCount}`);
        if (t.remoteNoRemoteCount) parts.push(`no-remote:${t.remoteNoRemoteCount}`);
        if (t.remoteErrorCount) parts.push(`err:${t.remoteErrorCount}`);
        text += parts.length > 0 ? ` remote ${parts.join(' ')}` : ' remote all-sync';
      }
      // repo-directories のみ readdir 時間を表示（速いときはノイズなので500ms未満は省略）
      if (typeof t.readdirMs === 'number' && t.readdirMs >= 500) {
        const rdCls =
          t.readdirSpeed === 'very-slow' ? 'ts-rd-veryslow' :
          t.readdirSpeed === 'slow' ? 'ts-rd-slow' : 'ts-rd';
        let rdText = `readdir ${(t.readdirMs / 1000).toFixed(1)}s`;
        if (t.readdirSpeed === 'slow') rdText += ' slow';
        else if (t.readdirSpeed === 'very-slow') rdText += ' very slow';
        readdirHtml = ` <em class="${rdCls}">${esc(rdText)}</em>`;
      }
    }
    return `<span class="${cls.join(' ')}" title="${esc(t.error || t.type)}">${esc(text)}${readdirHtml}</span>`;
  });
  el.innerHTML = `<span class="ts-head">Targets:</span> ${items.join(' ')}`;
}

function renderPresets() {
  const active = currentPreset();
  document.querySelectorAll('.toolbar button[data-preset]').forEach((b) => {
    b.classList.toggle('active', b.dataset.preset === active);
  });
}

function renderActiveFilterSummary() {
  const parts = [];
  if (String(filters.projectText || '').trim()) parts.push('project');
  if (filters.targets.length > 0 || filters.targetText.trim()) parts.push('target');
  if (filters.git !== 'all') parts.push('git');
  if (filters.statuses.length > 0) parts.push('status');
  if (filters.progress !== 'all') parts.push('PROGRESS');
  if (filters.remote !== 'all') parts.push('remote');
  const el = document.getElementById('active-filter-summary');
  el.textContent = parts.length > 0 ? `${parts.length} active` : 'all';
  el.classList.toggle('has-active', parts.length > 0);
}

// remote tracking status の一覧用バッジ（disabled / unknown は非表示）
function remoteBadge(r) {
  const rm = r.remote;
  if (!rm || !rm.enabled || rm.status === 'disabled' || rm.status === 'unknown') return '';
  const map = {
    'up-to-date': ['sync', 'rm-sync'],
    ahead: [`ahead ${rm.ahead}`, 'rm-ahead'],
    behind: [`behind ${rm.behind}`, 'rm-behind'],
    diverged: [`div ${rm.ahead}/${rm.behind}`, 'rm-diverged'],
    'no-upstream': ['no upstream', 'rm-none'],
    'no-remote': ['no remote', 'rm-none'],
    error: ['remote error', 'rm-error'],
  };
  const [label, cls] = map[rm.status] || [rm.status, 'rm-none'];
  return `<span class="badge rm ${cls}" title="${esc(rm.upstream || '')}">${esc(label)}</span>`;
}

// gitバッジ。kind が repo 以外なら kind を優先表示（missing対応）
function statusBadge(r) {
  if (r.kind && r.kind !== 'repo' && KIND_LABELS[r.kind]) {
    const cls = r.kind === 'missing' ? 'kind-missing' : 'git-' + r.gitStatus;
    return `<span class="badge ${cls}">${esc(KIND_LABELS[r.kind])}</span>`;
  }
  return `<span class="badge git-${esc(r.gitStatus)}">${esc(GIT_LABELS[r.gitStatus] || r.gitStatus)}</span>`;
}

// スマホ（狭い幅）用のカード表示。PC用の横長テーブルを狭い幅へ圧縮すると
// repo名が数文字になりバッジが重なって崩れるため、800px以下ではカードへ
// 切り替える（CSSメディアクエリで表示切替。PC表示のDOM・イベントは変更しない）。
// 変更数・remote内訳の詳細・フルパスは一覧カードには出さず、詳細ペインで確認する
function repoCardHtml(r) {
  const days = idleDays(r);
  const hash = r.commit ? r.commit.hash : '-';
  return `<div class="repo-card">
    <div class="rc-line1">
      <span class="rc-name">${esc(r.name)}</span>
      <span class="rc-selected">選択中</span>
      <button type="button" class="rc-rescan" data-role="row-rescan" title="このprojectだけ再スキャン">↻ 更新</button>
    </div>
    <div class="rc-badges">
      <span class="badge st-${esc(r.manualStatus)}" data-role="rc-status">${esc(r.manualStatus)}</span>
      ${statusBadge(r)}
    </div>
    <div class="rc-target">${esc(r.targetLabel || '-')}</div>
    <div class="rc-meta"><span>${esc(r.branch || '-')}</span><span class="hash">${esc(hash)}</span></div>
    <div class="rc-foot ${idleClass(days)}">
      ${esc(idleLabel(days))}
    </div>
  </div>`;
}

function repoRowHtml(r) {
  const changeCount = r.modifiedCount + r.untrackedCount;
  const days = idleDays(r);
  const commit = r.commit
    ? `<span class="hash">${esc(r.commit.hash)}</span>${esc(r.commit.message)}<span class="cdate">${esc(fmtDate(r.commit.date))}</span>`
    : '<span class="cdate">-</span>';
  const cls = ['repo-row'];
  if (r.kind === 'missing') cls.push('attn', 'attn-missing');
  else if (r.gitStatus !== 'clean') cls.push('attn', 'attn-' + r.gitStatus);
  if (r.path === openPath) cls.push('open');
  return `<tr class="${cls.join(' ')}" data-path="${esc(r.path)}">
    <td class="repo-name"><span class="repo-name-inner"><span class="repo-name-text">${esc(r.name)}</span><button type="button" class="row-rescan-btn" data-role="row-rescan" title="このprojectだけ再スキャン">↻</button></span>${repoCardHtml(r)}</td>
    <td class="target-cell">${esc(r.targetLabel || '')}</td>
    <td><span class="badge st-${esc(r.manualStatus)}">${esc(r.manualStatus)}</span></td>
    <td>${statusBadge(r)}${remoteBadge(r)}${
      r.scanSpeed && r.scanSpeed !== 'normal'
        ? `<span class="scan-dur ${esc(r.scanSpeed)}" title="スキャンに時間がかかっています">${esc(fmtMs(r.scanDurationMs))}</span>`
        : ''
    }</td>
    <td>${esc(r.branch || '-')}</td>
    <td class="commit-cell">${commit}</td>
    <td class="num ${idleClass(days)}">${esc(idleLabel(days))}</td>
    <td class="num">${changeCount > 0 ? changeCount : ''}</td>
    <td class="flag">${r.hasReadme ? '✓' : ''}</td>
    <td class="flag">${r.hasProgress ? '✓' : ''}</td>
  </tr>`;
}

// command hints は「label | command」1行1コマンドの簡易フォーマット。
// "|" を含まない行（見出しやメモ的な行）は個別コピー対象にはしない
function parseCommandHints(text) {
  if (!text) return [];
  return String(text)
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('|');
      if (idx === -1) return null;
      const label = line.slice(0, idx).trim();
      const command = line.slice(idx + 1).trim();
      if (!command) return null;
      return { label: label || command, command };
    })
    .filter(Boolean);
}

function commandHintsRowsHtml(r) {
  const rows = parseCommandHints(r.commandHints);
  if (!rows.length) return '<span class="cdate">command hints なし（1行「ラベル | コマンド」形式で入力してください）</span>';
  return rows
    .map(
      (row) => `<div class="cmd-hint-row">
        <span class="cmd-hint-label">${esc(row.label)}</span>
        <code class="cmd-hint-cmd">${esc(row.command)}</code>
        <button type="button" class="cmd-hint-copy" data-role="copy-command" data-command="${esc(row.command)}" title="cd + このコマンドをコピーします（実行はしません）">Copy</button>
      </div>`
    )
    .join('');
}

// ---- Phase 5-B: Auto-fill context（README/PROGRESS/manual status/note/
// ファイル構成からagent context・command hintsの初期候補を生成する）--------
// 外部AI APIは使わず、既存のスキャン結果（クライアント側）と、repo内の
// package.json等の構成ファイル（サーバー側 /api/projects/detect-commands）
// だけをルールベースで見て候補を作る。生成結果は保存されず、フォームに
// 反映するだけ（保存は Save context のみ）

function truncateText(s, n) {
  const t = (s || '').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).trim() + '…';
}

// PROGRESS/README冒頭は "# 見出し" 形式が多い前提の簡易ヒューリスティック。
// 完全なMarkdownパースはしない（renderMiniMarkdown等の既存パーサとは別軸の粗い抽出）
function firstHeadingLine(text) {
  if (!text) return '';
  for (const line of String(text).split('\n')) {
    const m = line.match(/^#{1,4}\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return '';
}

function firstMeaningfulReadmeLine(text) {
  if (!text) return '';
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^#{1,6}\s/.test(t)) continue; // 見出しは目的説明としては使わない
    if (/^[-*]\s/.test(t)) continue; // 箇条書きも先頭候補からは除外（本文らしい行を優先）
    return t;
  }
  return '';
}

// 見出し/箇条書きの中から Next / 次 / 次候補 / TODO / 未確認 を含む行を探す。
// 見出しでヒットした場合は、次の見出しまでの非空行を軽くまとめて返す
function findNextActionInProgress(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  const keywordRe = /next|次候補|次|todo|未確認/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch && keywordRe.test(headingMatch[1])) {
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^#{1,4}\s+/.test(lines[j])) break;
        const t = lines[j].trim().replace(/^[-*]\s+/, '');
        if (t) body.push(t);
        if (body.length >= 3) break;
      }
      return body.length ? body.join('; ') : headingMatch[1].trim();
    }
    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (bulletMatch && keywordRe.test(bulletMatch[1])) {
      return bulletMatch[1].trim();
    }
  }
  return '';
}

// Current focus / Next action / Blockers・notes / Last handoff notes の初期候補。
// 優先順位は各項目のコメントの通り（ユーザー指定の方針に対応）
function buildAutoFillSuggestion(r) {
  // Current focus: 1) manual note 2) PROGRESS内の見出し 3) READMEの概要 4) 空欄
  let currentFocus = '';
  if (r.note && r.note.trim()) {
    currentFocus = truncateText(r.note, 120);
  } else if (r.hasProgress && r.progressTail) {
    currentFocus = truncateText(firstHeadingLine(r.progressTail), 120);
  }
  if (!currentFocus && r.hasReadme && r.readmeTail) {
    currentFocus = truncateText(firstMeaningfulReadmeLine(r.readmeTail), 120);
  }

  // Next action: 1) PROGRESS内のNext/次/TODO等 2) dogfooding 3) dirty 4) abandonedは空欄
  let nextAction = '';
  const foundNext = r.hasProgress ? findNextActionInProgress(r.progressTail) : '';
  if (foundNext) {
    nextAction = truncateText(foundNext, 160);
  } else if (r.manualStatus === 'dogfooding') {
    nextAction = '実使用で不便点を確認する';
  } else if (r.gitStatus === 'dirty') {
    nextAction = 'git statusの変更内容を確認する';
  } else if (r.manualStatus === 'abandoned') {
    nextAction = '';
  }

  // Blockers / notes: 該当する注意点をすべて集めて列挙する（複数該当しうるため）
  const blockerLines = [];
  if (r.gitStatus === 'dirty') {
    blockerLines.push('working treeがdirty。commit/破棄の判断が必要');
  } else if (r.gitStatus === 'error') {
    blockerLines.push('git状態取得でエラーが発生中（詳細はスキャン診断/Git診断を参照）');
  } else if (r.gitStatus === 'no-git' || r.kind === 'no-git') {
    blockerLines.push('git管理下ではないフォルダ');
  }
  const rm = r.remote;
  if (rm && rm.enabled && ['ahead', 'behind', 'diverged', 'error'].includes(rm.status)) {
    blockerLines.push(`remoteが${rm.status}状態。push/mergeの要否を確認`);
  }
  if (/公開禁止|private|実データ|api\s*キー|api\s*key|token/i.test(r.note || '')) {
    blockerLines.push('noteに機密・非公開情報の言及あり。取り扱い注意');
  }
  if (r.manualStatus === 'abandoned') {
    blockerLines.push('Attention対象外（abandoned）。必要時のみ明示的に確認');
  }
  const blockers = blockerLines.join('\n');

  // Last handoff notes: 初期生成では latest commit / latest tag を短く入れる
  const lastParts = [];
  if (r.commit) lastParts.push(`latest commit: ${r.commit.hash} ${truncateText(r.commit.message, 60)}`);
  if (r.tags && r.tags.length) lastParts.push(`latest tag: ${r.tags[0]}`);
  const lastHandoffNotes = lastParts.join(' / ');

  return { currentFocus, nextAction, blockers, lastHandoffNotes };
}

// README/PROGRESS内のinline code（`...`）やコードブロックから、コマンドらしき行を拾う
function looksLikeCommand(s) {
  if (!s || s.length > 80) return false;
  return /^(npm|npx|yarn|pnpm|cargo|python3?|pip3?|code|git|cd|docker|make|cmake|\.\/gradlew|gradlew|go|dotnet|node)\b/.test(s);
}

function extractCommandLikeLines(text) {
  if (!text) return [];
  const found = [];
  const codeSpanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = codeSpanRe.exec(text))) {
    const cmd = m[1].trim();
    if (looksLikeCommand(cmd)) found.push(cmd);
  }
  const fenceRe = /```[a-zA-Z]*\n([\s\S]*?)```/g;
  while ((m = fenceRe.exec(text))) {
    for (const line of m[1].split('\n')) {
      const t = line.trim();
      if (looksLikeCommand(t)) found.push(t);
    }
  }
  return found;
}

// 複数グループのcommand hints行（"ラベル | コマンド"形式）を、コマンド本体で重複排除しつつ結合する
function mergeCommandHintLines(...groups) {
  const seen = new Set();
  const lines = [];
  for (const group of groups) {
    for (const line of group) {
      if (!line) continue;
      const idx = line.indexOf('|');
      const cmd = (idx === -1 ? line : line.slice(idx + 1)).trim();
      if (!cmd || seen.has(cmd)) continue;
      seen.add(cmd);
      lines.push(line);
    }
  }
  return lines.join('\n');
}

// Runtime helper card（dogfooding導線）。VSCode/Claude Code/Codexを常時起動せず
// PC serverを必要時に起動して使う運用を補助するため、runtime-sample-project の
// 詳細画面にだけ「起動中か確認する」「Webページを開く」ための最小UIを出す。
// 汎用化しない: 127.0.0.1:8787固定、token付きURLは一切生成しない、
// server起動/停止はagent-workbenchから行わない（確認と導線のみ）
const RUNTIME_HELPER_PROJECT_NAME = 'runtime-sample-project';
const RUNTIME_HELPER_BASE_URL = 'http://127.0.0.1:8787';

function isRuntimeHelperProject(r) {
  return r.name === RUNTIME_HELPER_PROJECT_NAME;
}

function runtimeHelperCardHtml(r) {
  if (!isRuntimeHelperProject(r)) return '';
  return `<div class="block runtime-card" data-role="runtime-helper-card">
    <h3>Runtime helper</h3>
    <div class="runtime-status-row">
      <span>Status:</span>
      <span class="runtime-status-badge rt-unknown" data-role="runtime-status">Unknown</span>
      <span class="cdate" data-role="runtime-latency"></span>
    </div>
    <div class="runtime-actions">
      <button type="button" data-role="runtime-check">Check server</button>
      <button type="button" data-role="runtime-open" data-url="${esc(RUNTIME_HELPER_BASE_URL)}/">Open root</button>
      <button type="button" data-role="runtime-open" data-url="${esc(RUNTIME_HELPER_BASE_URL)}/files.html">Open files page</button>
      <button type="button" data-role="runtime-open" data-url="${esc(RUNTIME_HELPER_BASE_URL)}/apks.html">Open APK page</button>
    </div>
    <div class="cdate runtime-note">
      Check uses ${esc(RUNTIME_HELPER_BASE_URL)}/ping ・ Links do not include tokens ・
      If a page requires auth/token, use the runtime helper documentation
    </div>
  </div>`;
}

// Phase 5-E: project agent context を1つのMarkdownテキストとして編集・表示する。
// agentContextMarkdown が正。旧4フィールド（Phase 5-A〜5-D）しか無いprojectは
// 表示時にMarkdownへ合成する（データ自体はSave contextを押すまで書き換えない）
function contextMarkdownFor(r) {
  if (r.agentContextMarkdown && r.agentContextMarkdown.trim()) return r.agentContextMarkdown;
  const ac = r.agentContext || {};
  const hasLegacy = !!(ac.currentFocus || ac.nextAction || ac.blockers || ac.lastHandoffNotes);
  if (hasLegacy) return buildContextMarkdown(ac);
  return '';
}

// Phase 6-L: Saved agent contextの閲覧表示（Current focus/Next action/
// Blockers・notes/Last handoff notes）。Next actionはAlwaysヘッダーと同じ
// buildResumeItems()の抽出結果を再利用し、別の値を作らない
function agentContextViewItemsHtml(r) {
  const items = buildResumeItems({
    contextMarkdown: contextMarkdownFor(r),
    progressTail: r.hasProgress ? (r.progressTail || '') : '',
  });
  const byKey = {};
  items.forEach((it) => { byKey[it.key] = it; });
  const rows = [
    ['currentState', 'Current focus'],
    ['nextAction', 'Next action'],
    ['knownConstraints', 'Blockers / notes'],
    ['lastWork', 'Last handoff notes'],
  ];
  if (!rows.some(([key]) => byKey[key])) {
    return '<span class="cdate">記録なし（「編集する」から # Agent context / ## Current focus 等の見出しで記載すると表示されます）</span>';
  }
  return `<dl class="context-view-list">${rows
    .map(([key, label]) => `<dt>${esc(label)}</dt><dd>${byKey[key] ? esc(byKey[key].text) : '<span class="cdate">(not set)</span>'}</dd>`)
    .join('')}</dl>`;
}

// Phase 5-A/5-E/6-L: project agent context（新しいagentへの引き継ぎメモ）と
// command hints（VSCode内ターミナル等で使う起動・確認コマンドのヒント）。
// 初期状態は閲覧（Saved contextのcompact表示 + 保存済みcommand hintsの
// 個別Copy一覧）。「編集する」を押すまでtextarea等の編集UIは表示しない
// （project再開時に大きな入力欄でfirst viewportやContext panelを占有しない）。
// このUIからコマンドを実行することはない。保存とコピーのみ
function agentContextBlockHtml(r) {
  const contextMd = contextMarkdownFor(r);
  return `<div class="block agent-context-block" data-role="agent-context-block">
    <div class="context-section-heading">
      <h3>Saved agent context</h3>
      <button type="button" data-role="context-edit-toggle">編集する</button>
    </div>
    <div class="context-view" data-role="context-view">
      ${agentContextViewItemsHtml(r)}
      <div class="command-hints-list">${commandHintsRowsHtml(r)}</div>
    </div>
    <div class="context-edit" data-role="context-edit" hidden>
      <p class="agent-context-desc">Agent context は README.md の代替ではなく、AI agent再開用のローカル要約です。現在地・運用方針・禁止事項・再開条件に絞って記載し、Copy AI Handoff の材料として使います（<code>data/project-context.json</code>にのみ保存され、repoにはコミットされません）。</p>
      <div class="row autofill-row">
        <button type="button" data-role="autofill-context" title="README/PROGRESS/構成ファイル/manual status・noteから候補を生成し、フォームに反映します（保存はしません。入力済みの場合は上書き確認します）">Auto-fill context</button>
        <button data-role="save-context" title="Agent context markdown/Command hintsの内容を保存します。保存時点のHEAD・README/PROGRESSのhashも記録し、以後の鮮度判定に使います">Save context</button>
        <button type="button" data-role="context-edit-cancel">Cancel</button>
      </div>
      <div class="row">
        <div class="ctx-view-header">
          <label>Agent context markdown（外部agentの提案文をそのまま貼り付けてOK。標準形式は # Agent context / ## Current focus / ## Next action / ## Blockers / notes / ## Last handoff notes）</label>
          <span class="progress-mode-toggle">
            <button type="button" class="pm-btn active" data-role="ctx-view-mode" data-mode="markdown">Markdown</button>
            <button type="button" class="pm-btn" data-role="ctx-view-mode" data-mode="plain">Plain text</button>
          </span>
        </div>
        <div class="md-body context-md-preview" data-role="ctx-md-preview">${contextMd.trim() ? renderMiniMarkdown(contextMd) : '<span class="cdate">(not set) — 編集するには Plain text タブへ切り替えてください</span>'}</div>
        <textarea data-role="ctx-markdown" class="context-markdown-input" hidden>${esc(contextMd)}</textarea>
      </div>
      <div class="row">
        <label>Command hints（1行「ラベル | コマンド」形式。例: Start server | npm run dev）</label>
        <textarea data-role="ctx-commands" class="command-hints-input">${esc(r.commandHints)}</textarea>
      </div>
      <button type="button" data-role="copy-context" title="Agent context markdown欄の内容をそのままコピーします（未保存でも可）">Copy agent context</button>
      <button type="button" data-role="copy-commands" title="command hintsのテキスト全体をコピーします（実行はしません）">Copy commands</button>
      <button type="button" data-role="copy-context-commands" title="Agent context markdownとcommand hintsをまとめてコピーします（未保存でも可）">Copy context + commands</button>
      <span class="save-result" data-role="context-result"></span>
      ${r.contextUpdatedAt ? `<div class="cdate">最終更新: ${esc(fmtDate(r.contextUpdatedAt))}</div>` : ''}
    </div>
  </div>`;
}

// freshnessコードから表示用バッジHTMLを作る（current/stale/unknown）。
// バッジは常に「保存済みcontextの鮮度」であり、現在のHEADの状態そのものではない
function freshnessBadgeHtml(freshness) {
  const map = {
    current: ['freshness-current', '現在のHEADと一致'],
    stale: ['freshness-stale', '現在のHEADより古い可能性'],
    unknown: ['freshness-unknown', '鮮度を判定できません'],
  };
  const [cls, label] = map[freshness] || map.unknown;
  return `<span class="freshness-badge ${cls}">${esc(label)}</span>`;
}

// 保存された作業コンテキスト（Agent context / PROGRESS.md の定型見出しから抽出、
// 保存時HEADとの鮮度付き）。
// 「現在のrepo」（常にlive・現在のHEAD由来）はAlwaysヘッダー（alwaysHeaderHtml）が
// 表示するため、ここでは重複させない。Next actionもAlwaysヘッダーが主表示するため、
// ここでは表示しない（同じ内容を旧位置に残さない）。
// 以前は保存済み「最後の作業」欄に最新コミットをフォールバック表示しており、
// 保存済みの古いcommit参照（例: latest commit: 73daf10 ...）と現在のHEADが
// 同じ見出しの下で見分けられなかった（agent-workbenchの実データで確認済みの不具合）。
// 現在のrepoを別ブロック（Always）として常に描画することでそれを解消している
function resumeSummaryBlockHtml(r) {
  const items = buildResumeItems({
    contextMarkdown: contextMarkdownFor(r),
    progressTail: r.hasProgress ? (r.progressTail || '') : '',
  }).filter((it) => it.key !== 'nextAction');
  const sc = r.savedContext;
  let freshnessHeader = '';
  if (sc) {
    const savedHeadText = sc.savedHeadHash
      ? `${esc(sc.savedHeadHash)}${sc.savedHeadSubject ? ' ' + esc(sc.savedHeadSubject) : ''}`
      : '<span class="cdate">保存時HEAD不明</span>';
    const parts = [
      `<dt>保存日時</dt><dd>${sc.savedAt ? esc(fmtDate(sc.savedAt, true)) : '<span class="cdate">不明</span>'}</dd>`,
      `<dt>保存時HEAD</dt><dd>${savedHeadText}</dd>`,
      `<dt>鮮度</dt><dd>${freshnessBadgeHtml(sc.freshness)}${
        sc.freshness === 'stale' && typeof sc.commitsAhead === 'number'
          ? ` <span class="cdate">（現在のHEADは保存時から${sc.commitsAhead}コミット進んでいます）</span>`
          : sc.freshness === 'stale'
            ? ' <span class="cdate">（保存後にHEADが更新されています）</span>'
            : ''
      }</dd>`,
    ];
    freshnessHeader = `<dl class="resume-saved-meta">${parts.join('')}</dl>`;
    // README/PROGRESS変更の有無はHEAD鮮度とは別根拠のため、別行で示す（1つの警告に混ぜない）
    const fileNotes = [];
    if (sc.readmeChanged === true) fileNotes.push('README.mdは保存後に更新されています。');
    if (sc.progressChanged === true) fileNotes.push('PROGRESS.mdは保存後に更新されています。');
    if (fileNotes.length) {
      freshnessHeader += `<div class="cdate resume-file-note">⚠ ${esc(fileNotes.join(' '))}</div>`;
    }
  }
  const body = items.length
    ? renderResumeItemsHtml(items)
    : '<span class="cdate">記録なし（Agent context に「## 現在地」「## 既知の制約」などの定型見出しで記載すると表示されます）</span>';
  // manual noteはAlways（status badge）と対になる閲覧値。編集はContext panel側で行う
  const noteLine = `<div class="cdate resume-note">Note: ${r.note && r.note.trim() ? esc(r.note) : '(未設定)'}</div>`;

  return `<div class="block resume-summary" data-role="resume-summary">
    <h3>保存された作業コンテキスト</h3>
    ${sc ? freshnessHeader : '<span class="cdate">保存済みcontextなし</span>'}
    ${body}
    ${noteLine}
  </div>`;
}

// Phase 6-K: PC詳細画面のAlwaysヘッダー。常用情報（repo名・target・manual status・
// Git clean/dirty・modified/untracked件数・branch・current HEAD・保存context鮮度・
// Next action・Development sessionを開始・VSCodeだけ開く・該当時のみRuntime helper
// Runtime chip）をfirst viewportへ集約する。README/PROGRESS全文・診断・編集
// フォームはここに置かない（下部のdetail-gridのまま）。旧「project status」
// ブロックの内容はここへ統合し、旧位置には残さない
function alwaysHeaderHtml(r) {
  const days = idleDays(r);
  const commit = r.commit
    ? `<div class="commit-line"><span class="hash">${esc(r.commit.hash)}</span><span class="commit-msg">${esc(r.commit.message)}</span></div>
       <div class="cdate">${esc(fmtDate(r.commit.date))}（${esc(idleLabel(days))}）</div>`
    : '<span class="cdate">コミットなし</span>';
  const changes = `modified: ${r.modifiedCount} / untracked: ${r.untrackedCount}`;
  const freshness = r.savedContext
    ? freshnessBadgeHtml(r.savedContext.freshness)
    : '<span class="freshness-badge freshness-unknown">保存contextなし</span>';
  const resumeItems = buildResumeItems({
    contextMarkdown: contextMarkdownFor(r),
    progressTail: r.hasProgress ? (r.progressTail || '') : '',
  });
  const nextActionItem = resumeItems.find((it) => it.key === 'nextAction');
  const nextActionBody = nextActionItem
    ? `<div class="ah-next-action-text">${esc(nextActionItem.text)}</div>`
    : '<div class="ah-next-action-text cdate">未設定（Agent contextに「## 次に行うこと」を記載すると表示されます）</div>';
  const warning = r.error
    ? '<div class="ah-warning">⚠ scan error（詳細は下部のerror欄を参照）</div>'
    : r.gitDiagnosis
      ? '<div class="ah-warning">⚠ Git診断あり（詳細は下部のGit診断を参照）</div>'
      : '';
  return `<div class="always-header" data-role="always-header">
    <div class="ah-title-row">
      <strong class="ah-name">${esc(r.name)}</strong>
      <span class="ah-target cdate">target: ${esc(r.targetLabel || '-')}</span>
    </div>
    <div class="block detail-status">
      <span class="badge st-${esc(r.manualStatus)}">${esc(r.manualStatus)}</span>
      ${statusBadge(r)}
      <span class="cdate">branch: ${esc(r.branch || '-')}</span>
      <span class="cdate">${esc(changes)}</span>
      ${freshness}
    </div>
    <div class="ah-commit-row">${commit}</div>
    ${warning}
    <div class="ah-next-action">
      <h4>Next action</h4>
      ${nextActionBody}
    </div>
    ${runtimeHelperCardHtml(r)}
    <div class="block development-session-block" data-role="development-session">
      <div class="development-session-heading">
        <h3>Development session</h3>
        <span class="session-status-badge" data-role="session-status-badge">読み込み中…</span>
      </div>
      <div class="development-session-body" data-role="development-session-body">
        <span class="cdate">設定を読み込み中...</span>
      </div>
      <div class="development-session-actions">
        <button type="button" data-role="start-development-session" disabled>Development sessionを開始</button>
        <button type="button" data-role="open-vscode">VSCodeだけ開く</button>
      </div>
      <div class="development-session-note">VS Codeはagent-workbench serverが動いているWindows PC上で起動します。初回はWorkspace Trust / Automatic Tasksの許可が必要な場合があります。</div>
      <div class="development-session-note session-duplicate-note">起動済みprocessを完全には検出しません。既に起動している可能性がある場合は重ねて開始しないでください。</div>
      <span class="save-result development-session-result" data-role="development-session-result"></span>
    </div>
  </div>`;
}

// Phase 6-L: PC詳細画面下部のnavigation。Always/Resumeより下の「必要な時だけ
// 見る情報」を Documents / Context / Diagnostics の3区分へ整理する（案A:
// Resumeは既にAlways直下に常時表示されているためタブへは含めない。Resumeタブを
// 追加すると同じCurrent focus/Last work/Handoffの重複表示になり冗長なため）。
// 初期選択はDocuments（実画面確認のFBにより再度変更。Context閲覧ブロックや
// README全文をいきなり大きく表示せず、Always/Resume/PROGRESSを中心にした
// 静かな初期表示が最も自然だった。DocumentsのREADMEは初期折りたたみのため、
// 開いた直後はPROGRESSだけが主に見える）
const DETAIL_TABS = [
  ['documents', 'Documents'],
  ['context', 'Context'],
  ['diagnostics', 'Diagnostics'],
];
function detailTabsHtml(activePanel) {
  const current = DETAIL_TABS.some(([key]) => key === activePanel) ? activePanel : 'documents';
  return `<div class="detail-tabs" role="tablist" aria-label="project detail sections" data-role="detail-tabs">
    ${DETAIL_TABS.map(([key, label]) => {
      const active = key === current;
      return `<button type="button" role="tab" id="tab-${key}" aria-selected="${active}" aria-controls="panel-${key}" tabindex="${active ? '0' : '-1'}" class="detail-tab-btn${active ? ' active' : ''}" data-role="detail-tab" data-panel="${key}">${esc(label)}</button>`;
    }).join('')}
  </div>`;
}

// Documents panel（実画面確認FBにより、50ef416時点のPROGRESS/READMEサブタブ
// 構造を復元。843e5d4で導入したPROGRESS/README同時表示は撤回した）。
// PROGRESS/README間はsub-tabで選択式に戻し、片方だけが見える（従来どおり）。
// 初期表示はさらに最小化する: 初期documentはREADME・README本文は初期closed
// （見出しと開閉UIだけを表示し、開いた時だけ本文を表示）。PROGRESSを選択した
// 時は従来どおり本文を常時表示する（PROGRESS側に折りたたみは無い）
function documentsPanelHtml(r, isActive, activeSub, isReadmeOpen, isMobileOpen) {
  const active = activeSub === 'progress' ? 'progress' : 'readme';
  const progress = r.hasProgress
    ? progressViewMode === 'markdown'
      ? `<div class="md-body">${renderMiniMarkdown(r.progressTail || '(読み取り失敗)')}</div>`
      : `<pre class="progress-tail">${esc(r.progressTail || '(読み取り失敗)')}</pre>`
    : '<span class="cdate">PROGRESS.md なし</span>';
  const progressToggle = `<span class="progress-mode-toggle">
    <button type="button" class="pm-btn${progressViewMode === 'markdown' ? ' active' : ''}" data-role="progress-mode" data-mode="markdown">Markdown</button>
    <button type="button" class="pm-btn${progressViewMode === 'plain' ? ' active' : ''}" data-role="progress-mode" data-mode="plain">Plain text</button>
  </span>`;
  // PROGRESSの読込元表示: default / custom <path> / missing
  let progressSrc = '';
  if (r.progressSource === 'custom') progressSrc = `PROGRESS: custom ${r.progressPath || ''}`;
  else if (r.progressSource === 'default') progressSrc = 'PROGRESS: default';
  else if (r.progressSource === 'missing' && r.progressPath) progressSrc = 'PROGRESS: missing';
  const progressSrcHtml = progressSrc
    ? `<span class="cdate progress-src">${esc(progressSrc)}</span>`
    : '';
  const progressErrHtml = r.progressError
    ? `<div class="cdate progress-err">⚠ ${esc(r.progressError)}</div>`
    : '';

  const readmeBody = !r.hasReadme
    ? '<span class="cdate">README.md なし</span>'
    : readmeViewMode === 'markdown'
      ? `<div class="md-body">${renderMiniMarkdown(r.readmeTail || '(読み取り失敗)')}</div>`
      : `<pre class="progress-tail">${esc(r.readmeTail || '(読み取り失敗)')}</pre>`;
  const readmeToggle = r.hasReadme
    ? `<span class="progress-mode-toggle">
        <button type="button" class="pm-btn${readmeViewMode === 'markdown' ? ' active' : ''}" data-role="readme-mode" data-mode="markdown">Markdown</button>
        <button type="button" class="pm-btn${readmeViewMode === 'plain' ? ' active' : ''}" data-role="readme-mode" data-mode="plain">Plain text</button>
      </span>`
    : '';
  // なし・read errorのいずれも、開かなくても見出し直下で分かるようにする
  const readmeStatusHtml = [
    !r.hasReadme ? '<span class="cdate">README.md なし</span>' : '',
    r.readmeError ? `<span class="cdate progress-err">⚠ read error</span>` : '',
  ].filter(Boolean).join(' ');

  return `<div class="detail-panel${isMobileOpen ? ' mobile-open' : ''}" id="panel-documents" role="tabpanel" aria-labelledby="tab-documents" tabindex="0"${isActive ? '' : ' hidden'}>
    <div class="documents-subnav progress-mode-toggle" role="tablist" aria-label="Documents">
      <button type="button" role="tab" aria-selected="${active === 'progress'}" class="pm-btn${active === 'progress' ? ' active' : ''}" data-role="documents-subtab" data-doc="progress">PROGRESS</button>
      <button type="button" role="tab" aria-selected="${active === 'readme'}" class="pm-btn${active === 'readme' ? ' active' : ''}" data-role="documents-subtab" data-doc="readme">README</button>
    </div>
    <div class="documents-doc" data-doc-panel="progress"${active === 'progress' ? '' : ' hidden'}>
      <div class="block progress-block">
        <div class="progress-block-header">
          <h3>PROGRESS.md（末尾）${progressSrcHtml}</h3>
          ${progressToggle}
        </div>
        ${progressErrHtml}
        <div class="progress-block-body documents-body documents-body-progress">${progress}</div>
      </div>
    </div>
    <div class="documents-doc" data-doc-panel="readme"${active === 'readme' ? '' : ' hidden'}>
      <details class="block readme-details" data-role="readme-details"${isReadmeOpen ? ' open' : ''}>
        <summary data-role="readme-toggle" aria-expanded="${isReadmeOpen ? 'true' : 'false'}" aria-controls="readme-body">
          <span class="readme-summary-label">README.md</span>
          ${readmeStatusHtml}
        </summary>
        <div id="readme-body">
          ${readmeToggle}
          ${r.readmeError ? `<div class="cdate progress-err">⚠ ${esc(r.readmeError)}</div>` : ''}
          <div class="readme-block-body documents-body documents-body-readme">${readmeBody}</div>
        </div>
      </details>
    </div>
  </div>`;
}

// Context panel: Saved agent context（閲覧/編集分離。agentContextBlockHtml側）と
// Project status & note（既存の手動status/note編集フォームをそのまま移動）
function contextPanelHtml(r, isActive, isMobileOpen) {
  const options = STATUSES.map(
    (s) => `<option value="${s}"${s === r.manualStatus ? ' selected' : ''}>${s}</option>`
  ).join('');
  return `<div class="detail-panel${isMobileOpen ? ' mobile-open' : ''}" id="panel-context" role="tabpanel" aria-labelledby="tab-context" tabindex="0"${isActive ? '' : ' hidden'}>
    ${agentContextBlockHtml(r)}
    <div class="block edit-form detail-status-editor">
      <h3>Project status &amp; note</h3>
      <div class="row">
        <label>status</label>
        <select data-role="status">${options}</select>
      </div>
      <div class="row">
        <label>note</label>
        <textarea data-role="note">${esc(r.note)}</textarea>
      </div>
      <button data-role="save">保存</button>
      <span class="save-result" data-role="result"></span>
      ${r.manualUpdatedAt ? `<div class="cdate">最終更新: ${esc(fmtDate(r.manualUpdatedAt))}</div>` : ''}
    </div>
  </div>`;
}

// Diagnostics panel: Repository（path/branch/latest commit/tags/remote）/
// Scan（Rescan・scan診断・error/Git診断）/ Development session settings
// （preset ID・Target ID・path・config open/reload・templateのみ。開始CTAと
// item checkboxはAlwaysに残す。development-session-config-actionsは
// renderDevelopmentSession()が書き込む既存placeholderをそのまま移動しただけで、
// 複製はしていない）の3つへ最低限分類する
function diagnosticsPanelHtml(r, isActive, isMobileOpen) {
  const days = idleDays(r);
  const tags = r.tags && r.tags.length
    ? r.tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join('')
    : '<span class="cdate">タグなし</span>';
  const commit = r.commit
    ? `<div class="commit-line"><span class="hash">${esc(r.commit.hash)}</span><span class="commit-msg">${esc(r.commit.message)}</span></div>
       <div class="cdate">${esc(fmtDate(r.commit.date))}（${esc(idleLabel(days))}）</div>`
    : '<span class="cdate">コミットなし</span>';
  const targetInfo = r.targetLabel
    ? `<div class="cdate">target: ${esc(r.targetLabel)}（${esc(r.targetPath || '')}）</div>`
    : '';
  // remote tracking status（originUrl は詳細欄のみに表示）
  let remoteBlock = '';
  if (r.remote) {
    if (!r.remote.enabled) {
      remoteBlock = `<div class="block detail-secondary"><h3>remote</h3><span class="cdate">disabled（このtargetでは取得しない設定）</span></div>`;
    } else {
      const rm = r.remote;
      const rows = [];
      rows.push(`status: ${rm.status}`);
      if (rm.upstream) rows.push(`upstream: ${rm.upstream}`);
      if (typeof rm.ahead === 'number') rows.push(`ahead: ${rm.ahead} / behind: ${rm.behind}`);
      remoteBlock = `<div class="block detail-secondary"><h3>remote</h3>
        <div>${remoteBadge(r) || esc(rm.status)}</div>
        <div class="cdate">${rows.map(esc).join(' ／ ')}</div>
        ${rm.originUrl ? `<div class="path">${esc(rm.originUrl)}</div>` : ''}
        ${rm.error ? `<div class="cdate progress-err">⚠ ${esc(rm.error)}</div>` : ''}
      </div>`;
    }
  }
  const err = r.error ? `<div class="block detail-warning"><h3>error</h3><div class="raw-error">${esc(r.error)}</div></div>` : '';
  // 既知のgitエラーには対処例を表示する（コマンドは表示のみ。自動実行はしない）
  const diag = r.gitDiagnosis
    ? `<div class="block git-diag detail-warning"><h3>Git診断</h3>
        <div>${esc(r.gitDiagnosis.message)}</div>
        ${r.gitDiagnosis.operation ? `<div class="cdate">operation: ${esc(r.gitDiagnosis.operation)}</div>` : ''}
        ${r.gitDiagnosis.suggestedCommand
          ? `<div class="cdate">対処例（手動で実行してください。自動実行はされません）:</div>
             <pre class="diag-cmd">${esc(r.gitDiagnosis.suggestedCommand)}</pre>`
          : ''}
      </div>`
    : '';
  // スキャン診断: repo単位の所要時間とステップ内訳（git系は並列実行のため合計はtotalを超えうる）
  let scanDiag = '';
  if (typeof r.scanDurationMs === 'number') {
    const speedTag = r.scanSpeed !== 'normal'
      ? ` <span class="scan-dur ${esc(r.scanSpeed)}">${esc(r.scanSpeed)}</span>`
      : '';
    const st = r.scanSteps || {};
    const stepDefs = [
      ['git status', st.gitStatusMs], ['git log', st.gitLogMs], ['git branch', st.gitBranchMs],
      ['git probe', st.gitProbeMs], ['tags', st.gitTagsMs], ['remote', st.remoteStatusMs], ['progress', st.progressMs],
      ['exists/.git', st.existsMs], ['readme', st.readmeMs],
    ];
    const steps = stepDefs
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `<li>${esc(k)}: ${esc(fmtMs(v))}</li>`)
      .join('');
    // 診断情報は再開用情報より優先度が低いため、折りたたみ（初期は閉じる）にする。
    // 閉じた状態でも total とspeedは summary 行で確認できる
    scanDiag = `<details class="block scan-diag-details detail-secondary">
      <summary>スキャン診断 <span class="cdate">total ${esc(fmtMs(r.scanDurationMs))}</span>${speedTag}</summary>
      <div><span class="cdate">target: ${esc(r.targetLabel || '-')} / kind: ${esc(r.kind || '-')}</span></div>
      <ul class="scan-steps">${steps}</ul>
    </details>`;
  }

  return `<div class="detail-panel${isMobileOpen ? ' mobile-open' : ''}" id="panel-diagnostics" role="tabpanel" aria-labelledby="tab-diagnostics" tabindex="0"${isActive ? '' : ' hidden'}>
    <div class="diag-section">
      <h4>Repository</h4>
      <div class="block detail-path detail-secondary"><h3>パス</h3><div class="path">${esc(r.path)}</div>${targetInfo}</div>
      <div class="cdate">branch: ${esc(r.branch || '-')}</div>
      <div class="block detail-secondary"><h3>latest commit</h3>${commit}</div>
      <div class="block detail-secondary"><h3>latest tags</h3><div class="tag-list">${tags}</div></div>
      ${remoteBlock}
    </div>
    <div class="diag-section">
      <h4>Scan</h4>
      <div class="block rescan-block detail-secondary">
        <button data-role="rescan-project" title="Git状態・最新コミット・タグ・remote・README.md/PROGRESS.mdをこのprojectだけ再取得します。保存済みAgent context・Current focus・Next action・手動status/noteは書き換えません（鮮度の再判定のみ行います）">Rescan project</button>
        <span class="save-result" data-role="rescan-result"></span>
      </div>
      ${err}${diag}${scanDiag}
    </div>
    <div class="diag-section">
      <h4>Development session settings</h4>
      <div class="development-session-config-actions" data-role="development-session-config-actions"></div>
    </div>
  </div>`;
}

// mobile Phase 3: Documents/Context/Diagnostics用のaccordion toggle。PC幅では
// CSSで非表示にする（`.detail-tabs`側のtab切替をそのまま使う）。mobileでは
// `.detail-tabs`自体を隠し、これを唯一のnavigationとして使う。開閉は
// `mobileAccordionOpen`（PCの`openPanel`/`hidden`属性とは独立）で管理し、
// 複数同時openを許容する
function mobileAccordionToggleHtml(key, label, isOpen) {
  return `<button type="button" class="mobile-accordion-toggle" data-role="mobile-accordion-toggle" data-panel="${key}" aria-expanded="${isOpen ? 'true' : 'false'}" aria-controls="panel-${key}">
    <span class="mat-label">${esc(label)}</span>
    <span class="mat-icon" aria-hidden="true"></span>
  </button>`;
}

// Increment 2: 詳細ペインの「運用（Portfolio）」ブロック。
// repo を持つ item / 持たない virtual item のどちらでも、State / Next action /
// Next review / External wait / External signal を確認できるようにする。
// 派生・見出し抽出は public/action-queue.js のグローバル関数を使う（無ければ素通り）。
function operationalBlockHtml(r) {
  const md = contextMarkdownFor(r);
  const nextDate = typeof extractNextDate === 'function'
    ? extractNextDate([md, r.note || ''])
    : null;
  const extWait = typeof externalWaitText === 'function' ? externalWaitText(r) : '';
  const extSignal = typeof externalSignalText === 'function' ? externalSignalText(r) : '';
  let derived = null;
  if (typeof deriveActionState === 'function') {
    try { derived = deriveActionState(r); } catch (e) { derived = null; }
  }
  const rows = [];
  if (derived && derived.state) {
    const isNow = derived.state === 'ACTION' ||
      (derived.state === 'OBSERVE' && derived.nextDateDue === true);
    const sectionLabel = derived.section === 'queue'
      ? (isNow ? 'Now' : 'Watching')
      : derived.section === 'waiting' ? 'Waiting / scheduled' : '（Action Queue 外）';
    rows.push(`<dt>State</dt><dd><span class="badge aq-state-${esc(String(derived.state).toLowerCase())}">${esc(derived.state)}</span> <span class="cdate">${esc(sectionLabel)}</span></dd>`);
    if (derived.now) rows.push(`<dt>Next action</dt><dd>${esc(derived.now)}</dd>`);
  }
  if (nextDate) rows.push(`<dt>Next review</dt><dd>${esc(nextDate)}</dd>`);
  if (extWait) rows.push(`<dt>External wait</dt><dd>${esc(extWait)}</dd>`);
  if (extSignal) rows.push(`<dt>External signal</dt><dd class="ops-signal">${esc(extSignal)}</dd>`);
  const nonRepoNote = r.kind && r.kind !== 'repo'
    ? '<div class="cdate ops-nonrepo">repo を持たない portfolio item のため branch / HEAD / commit / Development session は対象外です。運用状態は Context タブの Agent context（`## 現在地` / `## 次に行うこと` / `## 次回確認日` / `## 外部イベント待ち` / `## 外部シグナル`）で更新します。</div>'
    : '';
  if (rows.length === 0 && !nonRepoNote) return '';
  return `<div class="block ops-block" data-role="ops-block">
    <h3>運用（Portfolio）</h3>
    ${rows.length ? `<dl class="ops-list">${rows.join('')}</dl>` : ''}
    ${nonRepoNote}
  </div>`;
}

function detailRowHtml(r) {
  // Phase 5-C: project identity header。詳細ペインを下までスクロールしても
  // 「今どのprojectのcontext/commandsを編集しているか」が分かるよう、
  // repo名/target/status/git/pathをsticky表示する（同名projectはtarget/pathで区別できる）
  const identity = `<div class="project-identity">
    <div class="pi-line1">
      <span class="pi-selected">選択中</span>
      <strong class="pi-name">${esc(r.name)}</strong>
      <span class="pi-target">${esc(r.targetLabel || '-')}</span>
      <span class="badge st-${esc(r.manualStatus)}">${esc(r.manualStatus)}</span>
      ${statusBadge(r)}
    </div>
    <div class="pi-path">${esc(r.path)}</div>
  </div>`;

  const activePanel = DETAIL_TABS.some(([key]) => key === openPanel) ? openPanel : 'documents';

  return `<tr class="detail-row" data-detail="${esc(r.path)}"><td colspan="${COLS}">
    ${identity}
    <div class="detail-content">
      ${alwaysHeaderHtml(r)}
      ${resumeSummaryBlockHtml(r)}
      ${operationalBlockHtml(r)}
      <div class="block handoff-block">
        <label class="handoff-purpose-row">
          <span>Handoff purpose</span>
          <select data-role="handoff-purpose">
            ${HANDOFF_PURPOSES.map(
              (p) => `<option value="${esc(p.key)}"${p.key === handoffPurpose ? ' selected' : ''}>${esc(p.label)}</option>`
            ).join('')}
          </select>
        </label>
        <button data-role="copy-handoff" title="README/PROGRESS/git状態/note/Agent context/Command hintsと、選択したHandoff purposeをまとめたMarkdownをコピーします">Copy AI Handoff</button>
        <span class="save-result" data-role="handoff-result"></span>
      </div>
      ${detailTabsHtml(activePanel)}
      ${mobileAccordionToggleHtml('documents', 'Documents', mobileAccordionOpen.documents)}
      ${documentsPanelHtml(r, activePanel === 'documents', documentsSubView, readmeExpanded, mobileAccordionOpen.documents)}
      ${mobileAccordionToggleHtml('context', 'Context', mobileAccordionOpen.context)}
      ${contextPanelHtml(r, activePanel === 'context', mobileAccordionOpen.context)}
      ${mobileAccordionToggleHtml('diagnostics', 'Diagnostics', mobileAccordionOpen.diagnostics)}
      ${diagnosticsPanelHtml(r, activePanel === 'diagnostics', mobileAccordionOpen.diagnostics)}
    </div>
  </td></tr>`;
}

function renderTable() {
  const repos = visibleRepos();
  let html = '';
  for (const r of repos) {
    html += repoRowHtml(r);
    if (r.path === openPath) html += detailRowHtml(r);
  }
  if (repos.length === 0) {
    html = `<tr><td colspan="${COLS}" class="empty">該当するrepoがありません</td></tr>`;
  }
  document.getElementById('repo-tbody').innerHTML = html;
  document.getElementById('filter-count').textContent =
    repos.length === state.repos.length ? '' : `${repos.length} / ${state.repos.length} 件表示`;
  document.getElementById('mobile-filter-count').textContent = `${repos.length} / ${state.repos.length}`;
  // ソート中の列にマークを付ける
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === sortKey);
    th.dataset.dir = th.dataset.sort === sortKey ? sortDir : '';
  });
  renderPresets();
  renderActiveFilterSummary();
  if (openPath) {
    const repo = state.repos.find((entry) => entry.path === openPath);
    if (repo) loadDevelopmentSession(repo);
  }
}

function render() {
  renderSummary();
  renderActionQueue();
  renderConfigErrors();
  renderTargetSummary();
  populateTargetFilter();
  renderTable();
  // Scanner health（スキャン詳細）は Action Queue より常に下位に置く。render() では
  // 開閉に一切触れない（既定は閉じたまま。hard error があっても自動展開しない）。
  // エラー件数は閉じた summary 部分に renderTargetSummary() がコンパクト表示する。
  let scanInfo = state.scannedAt ? `Last scanned: ${fmtDate(state.scannedAt, true)}` : '';
  if (scanInfo && state.scanSummary && typeof state.scanSummary.durationMs === 'number') {
    scanInfo += ` / ${(state.scanSummary.durationMs / 1000).toFixed(1)}s`;
  }
  document.getElementById('scan-info').textContent = scanInfo;
  const srcEl = document.getElementById('config-source');
  if (state.configSource === 'default') {
    srcEl.textContent = 'Config: default（config/roots.local.json 未作成）';
    srcEl.classList.add('config-default');
  } else {
    srcEl.textContent = state.configSource ? `Config: ${state.configSource}` : '';
    srcEl.classList.remove('config-default');
  }
  document.getElementById('scan-root').textContent = state.scanRoot;
}

async function load(rescan) {
  const btn = document.getElementById('rescan-btn');
  const info = document.getElementById('scan-info');
  btn.disabled = true;
  if (rescan) {
    btn.textContent = 'Scanning...';
    info.textContent = 'スキャン中...';
  }
  try {
    state = rescan
      ? await api('/api/rescan', { method: 'POST' })
      : await api('/api/projects');
    if (!Array.isArray(state.configErrors)) state.configErrors = [];
    render();
  } catch (e) {
    alert('読み込み失敗: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '再スキャン';
  }
}

// Copy AI Handoff: 既存の README/PROGRESS/git状態/manual status/note を
// Claude Code・Codex に貼り付けやすい Markdown 文脈パックにまとめるだけの機能。
// タスク管理・優先度・次アクション入力欄などは持たない（プレーンテキスト運用を置き換えない）。
// Phase 5-F: 先頭の「# 目的」だけ、選択したpurposeKeyに応じたテンプレートに差し替える。
// 他のセクション構造（Repo/Current manual state/Agent context/Command hints/README/
// PROGRESS/Git notes/Warnings/Important rules/Request）は一切変更しない
function buildHandoffMarkdown(r, purposeKey) {
  const purpose = HANDOFF_PURPOSES.find((p) => p.key === purposeKey) || HANDOFF_PURPOSES[0];
  const isNoGit = r.kind === 'no-git';
  const readme = !r.hasReadme
    ? 'README not found.'
    : r.readmeTail
    ? r.readmeTail
    : (r.readmeError ? `README read failed: ${r.readmeError}` : '(empty)');
  const progress = !r.hasProgress
    ? 'PROGRESS not found.'
    : r.progressTail
    ? r.progressTail
    : (r.progressError ? `PROGRESS read failed: ${r.progressError}` : '(empty)');
  const note = r.note && r.note.trim() ? r.note.trim() : 'No note.';
  const tagsLine = r.tags && r.tags.length ? r.tags.join(', ') : 'No tags.';
  const commitLine = r.commit
    ? `${r.commit.hash} ${r.commit.message} (${fmtDate(r.commit.date)})`
    : 'No commits.';

  const rm = r.remote || { enabled: false, status: 'disabled' };
  const remoteStatusLine = !rm.enabled
    ? 'Remote disabled.'
    : rm.status === 'no-remote'
    ? 'No remote.'
    : rm.status === 'no-upstream'
    ? 'No upstream.'
    : rm.status;
  const upstreamLine = rm.upstream ? rm.upstream : 'No upstream.';
  const aheadLine = typeof rm.ahead === 'number' ? String(rm.ahead) : '-';
  const behindLine = typeof rm.behind === 'number' ? String(rm.behind) : '-';
  const gitStatusLine = isNoGit ? 'no-git' : (r.gitStatus || 'unknown');
  const workingTreeLine = isNoGit
    ? 'no-git'
    : `${r.gitStatus} (modified: ${r.modifiedCount || 0}, untracked: ${r.untrackedCount || 0})`;

  const warnings = [];
  if (isNoGit) {
    warnings.push('- This folder is not a git repo. Decide whether to initialize it as a repo or keep treating it as a plain work folder.');
  } else {
    if (r.gitStatus === 'dirty' || r.gitStatus === 'untracked-only') {
      warnings.push('- This repo is not clean. Review the changes and decide whether to delete, ignore, commit, or leave them as-is.');
    }
    if (rm.enabled && rm.status === 'no-remote') {
      warnings.push('- No remote is configured. Decide if creating an origin is necessary, but do not create one automatically.');
    } else if (rm.enabled && rm.status === 'no-upstream') {
      warnings.push('- A remote exists but no upstream is set. Check what the tracking branch should be if needed.');
    }
  }
  const warningsBlock = warnings.length ? `# Warnings\n\n${warnings.join('\n')}\n\n` : '';

  // Phase 5-A/5-E: project agent context。未設定ならセクションごと省略する
  // （Handoffの冗長化を避ける）。Phase 5-E以降は agentContextMarkdown を優先し、
  // 旧4フィールドしか無い場合は従来どおりMarkdownへ合成して含める
  let contextBody = '';
  if (r.agentContextMarkdown && r.agentContextMarkdown.trim()) {
    // Markdown自体に "# Agent context" 見出しがあると "# Local agent context" と
    // 重複するため、先頭のその見出し行だけ取り除いて埋め込む
    contextBody = r.agentContextMarkdown.trim().replace(/^#\s+Agent context\s*\n+/i, '');
  } else {
    const ac = r.agentContext || {};
    const hasLegacy = [ac.currentFocus, ac.nextAction, ac.blockers, ac.lastHandoffNotes].some(
      (v) => v && v.trim()
    );
    if (hasLegacy) {
      contextBody = buildContextMarkdown(ac).replace(/^#\s+Agent context\s*\n+/i, '');
    }
  }
  // 保存済みAgent contextを「現在の事実」として提示しないよう、
  // 保存日時・保存時HEAD・鮮度を明示するmetadata行を必ず先頭に付ける
  // （# Repo セクションが常にlive/現在の状態。ここは保存時点のスナップショット）
  let contextMetaLines = '';
  if (contextBody) {
    const sc = r.savedContext;
    if (sc) {
      const freshnessText = sc.freshness === 'current'
        ? 'current（現在のHEADと一致）'
        : sc.freshness === 'stale'
        ? 'stale（保存後にHEADが更新されています）'
        : 'unknown（保存時HEADが不明なため鮮度を判定できません）';
      contextMetaLines = [
        `- saved at: ${sc.savedAt ? fmtDate(sc.savedAt, true) : 'unknown'}`,
        `- saved HEAD: ${sc.savedHeadHash ? `${sc.savedHeadHash}${sc.savedHeadSubject ? ' ' + sc.savedHeadSubject : ''}` : 'unknown'}`,
        `- freshness: ${freshnessText}`,
      ].join('\n') + '\n';
      if (sc.freshness === 'stale') {
        contextMetaLines += '\nThis saved context predates the current HEAD. Treat the notes below as history, not current fact.\n';
      }
    } else {
      contextMetaLines = '- freshness: unknown（保存済みcontextのmetadataがありません）\n';
    }
    contextMetaLines += '\n';
  }
  const contextBlock = contextBody
    ? `# Saved agent context

${contextMetaLines}${contextBody}

`
    : '';
  const hasCommands = r.commandHints && r.commandHints.trim();
  const commandsBlock = hasCommands
    ? `# Command hints

\`\`\`text
${r.commandHints.trim()}
\`\`\`

`
    : '';

  return `# 目的

${purpose.text}

# Repo

- name: ${r.name}
- path: ${r.path}
- kind: ${r.kind}
- target: ${r.targetLabel || '-'}
- branch: ${r.branch || '-'}
- git status: ${gitStatusLine}
- remote status: ${remoteStatusLine}
- latest commit: ${commitLine}
- tags: ${tagsLine}

# Current manual state

- status: ${r.manualStatus || 'unknown'}
- note: ${note}

${contextBlock}${commandsBlock}# README tail

${readme}

# PROGRESS tail

${progress}

# Git / remote notes

- working tree: ${workingTreeLine}
- remote: ${rm.enabled ? rm.status : 'disabled'}
- upstream: ${upstreamLine}
- ahead: ${aheadLine}
- behind: ${behindLine}

${warningsBlock}# Important rules

- 最初に git status を確認してください。
- working tree が clean でない場合、勝手に commit しないでください。
- config/roots.local.json, config/roots.json, data/projects.json, data/scan-history.json, node_modules, cache, tmp, __pycache__ などは commit しないでください。
- 実装前に方針を説明し、必要なら確認してください。
- 実装後は git diff --check と関連テストを実行してください。
- 最終報告では、変更ファイル、確認コマンド、git status、commit hash を報告してください。
- tag / release / push は明示指示がない限り行わないでください。

# Request

このrepoの現状を読み取り、次フェーズ候補を3つ提案してください。
各候補について、目的、最小実装、リスク、確認方法を簡潔に整理してください。
実装はまだ開始しないでください。
`;
}

// クリップボードへコピー。navigator.clipboard が使えない/失敗する場合は
// textarea + execCommand('copy') にフォールバックする
async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // フォールバックへ
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

async function saveStatus(detailTr, repoPath) {
  const status = detailTr.querySelector('[data-role="status"]').value;
  const note = detailTr.querySelector('[data-role="note"]').value;
  const result = detailTr.querySelector('[data-role="result"]');
  result.textContent = '保存中...';
  result.className = 'save-result';
  try {
    await api('/api/projects/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoPath, status, note }),
    });
    const repo = state.repos.find((r) => r.path === repoPath);
    if (repo) {
      repo.manualStatus = status;
      repo.note = note;
      repo.manualUpdatedAt = new Date().toISOString();
    }
    result.textContent = '保存しました';
    result.className = 'save-result ok';
    renderSummary();
    // 一覧側のバッジだけ更新（詳細は開いたまま）
    const row = document.querySelector(`tr.repo-row[data-path="${CSS.escape(repoPath)}"]`);
    if (row) {
      row.children[2].innerHTML = `<span class="badge st-${esc(status)}">${esc(status)}</span>`;
      // スマホ用カード側のstatusバッジも更新する（カードはtd先頭セル内にある）
      const rcStatus = row.querySelector('[data-role="rc-status"]');
      if (rcStatus) rcStatus.outerHTML = `<span class="badge st-${esc(status)}" data-role="rc-status">${esc(status)}</span>`;
    }
  } catch (e) {
    result.textContent = '失敗: ' + e.message;
    result.className = 'save-result err';
  }
}

// Phase 5-A/5-E: project agent context / command hints の保存。
// Phase 5-E以降は agentContextMarkdown（1つのMarkdownテキスト）を保存する。
// 旧4フィールドは送らない（サーバー側が既存値を維持し後方互換を保つ）。
// 保存後は state.repos の該当要素だけ更新し、command hints個別コピー欄
// （.command-hints-list）だけを再生成する（textarea入力中のフォーカス・
// 未保存の他フィールドを壊さないよう、detailRowHtml全体は再描画しない）
async function saveContext(detailTr, repoPath, repo) {
  const agentContextMarkdown = detailTr.querySelector('[data-role="ctx-markdown"]').value;
  const commandHints = detailTr.querySelector('[data-role="ctx-commands"]').value;
  const result = detailTr.querySelector('[data-role="context-result"]');
  result.textContent = '保存中...';
  result.className = 'save-result';
  try {
    await api('/api/projects/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repoPath, targetId: repo.targetId, agentContextMarkdown, commandHints }),
    });
    repo.agentContextMarkdown = agentContextMarkdown;
    repo.commandHints = commandHints;
    repo.contextUpdatedAt = new Date().toISOString();
    result.textContent = '保存しました';
    result.className = 'save-result ok';
    // Saved contextの閲覧表示（Current focus/Next action/Blockers/Last handoff
    // notes + command hints一覧）を保存後の値で更新し、閲覧状態へ戻す
    const view = detailTr.querySelector('[data-role="context-view"]');
    if (view) {
      view.innerHTML = `${agentContextViewItemsHtml(repo)}<div class="command-hints-list">${commandHintsRowsHtml(repo)}</div>`;
    }
    setContextEditing(detailTr, false);
    // 再開サマリーはAgent contextの定型見出しを情報源とするため、保存後に
    // このブロックだけ差し替えて反映する（detail全体は再描画せず、
    // textarea編集中のフォーカス・未保存の他フィールドを壊さない）
    const resume = detailTr.querySelector('[data-role="resume-summary"]');
    if (resume) resume.outerHTML = resumeSummaryBlockHtml(repo);
  } catch (e) {
    result.textContent = '失敗: ' + e.message;
    result.className = 'save-result err';
  }
}

// Phase 5-D/5-E: Agent context のコピー用テキスト生成。
// コピー対象は保存済みデータではなく「現在フォームに入力されている内容」
// （Auto-fill直後や手直し中の未保存内容をSave前に確認・コピーできるようにするため）
function readContextForm(detailTr) {
  const v = (role) => detailTr.querySelector(`[data-role="${role}"]`).value;
  return {
    contextMarkdown: v('ctx-markdown'),
    commandHints: v('ctx-commands'),
  };
}

function buildContextMarkdown(form) {
  const val = (s) => (s && s.trim() ? s.trim() : '(not set)');
  return `# Agent context

## Current focus

${val(form.currentFocus)}

## Next action

${val(form.nextAction)}

## Blockers / notes

${val(form.blockers)}

## Last handoff notes

${val(form.lastHandoffNotes)}
`;
}

// Phase 5-E: Copy context + commands。Markdown欄の内容をそのまま使い、
// # Command hints セクションを続ける（hints空欄なら (not set)）
function buildContextCommandsMarkdown(form) {
  const context = form.contextMarkdown && form.contextMarkdown.trim()
    ? form.contextMarkdown.trim()
    : '(not set)';
  const commands = form.commandHints && form.commandHints.trim()
    ? form.commandHints.trim()
    : '(not set)';
  return `${context}

# Command hints

${commands}
`;
}

// Phase 5-B/5-E: Auto-fill context。README/PROGRESS/manual status・note（クライアント側の
// 既存スキャン結果）と、repo内のpackage.json/Cargo.toml/Gradle/requirements.txt
// （サーバー側 /api/projects/detect-commands）から候補を生成し、
// Agent context markdown欄とcommand hints欄に反映するだけ。ここでは保存しない
// （保存は Save context ボタンのみ）。
// 既存値の扱い: 両欄とも空欄ならそのまま反映、入力済みならconfirmで上書き確認する
async function autoFillContext(detailTr, repo) {
  const result = detailTr.querySelector('[data-role="context-result"]');
  const mdEl = detailTr.querySelector('[data-role="ctx-markdown"]');
  const cmdEl = detailTr.querySelector('[data-role="ctx-commands"]');
  if (mdEl.value.trim() || cmdEl.value.trim()) {
    const ok = confirm('Agent context / command hints に入力済みの内容があります。Auto-fillの候補で上書きしますか？');
    if (!ok) return;
  }
  result.textContent = '候補を生成中...';
  result.className = 'save-result';

  const suggestion = buildAutoFillSuggestion(repo);
  const docCmds = extractCommandLikeLines(repo.readmeTail)
    .concat(extractCommandLikeLines(repo.progressTail))
    .map((c) => `Doc | ${c}`);
  let configCmds = [];
  try {
    const qs = new URLSearchParams({ path: repo.path, targetId: repo.targetId || '' });
    const resp = await api(`/api/projects/detect-commands?${qs.toString()}`);
    configCmds = resp.commandHints ? resp.commandHints.split('\n').filter(Boolean) : [];
  } catch (e) {
    // ファイル構成の検出に失敗しても、doc由来の候補だけで続行する（致命的エラーにしない）
  }
  const mergedCommands = mergeCommandHintLines(configCmds, docCmds);

  // 候補を標準形式（# Agent context / ## Current focus / ...）のMarkdownとして反映する
  mdEl.value = buildContextMarkdown(suggestion);
  if (mergedCommands) cmdEl.value = mergedCommands;
  updateContextPreview(detailTr);

  result.textContent = '候補をフォームに反映しました。保存するには Save context を押してください。';
  result.className = 'save-result ok';
}

// Agent context markdown のプレビュー（PROGRESS.mdと同じmini markdown rendererを再利用）
function updateContextPreview(detailTr) {
  const preview = detailTr.querySelector('[data-role="ctx-md-preview"]');
  const mdEl = detailTr.querySelector('[data-role="ctx-markdown"]');
  if (!preview || !mdEl) return;
  preview.innerHTML = mdEl.value.trim()
    ? renderMiniMarkdown(mdEl.value)
    : '<span class="cdate">(not set) — 編集するには Plain text タブへ切り替えてください</span>';
}

// Runtime helper card の Check server。サーバー側の限定API
// （/api/runtime/ping、127.0.0.1:8787/pingへの固定GETのみ）を叩いて
// 結果をバッジ表示するだけ。状態はDOM上のみで保持し、保存やlocalStorageへの
// 永続化は行わない（詳細を閉じて開き直すとUnknownに戻る）
async function checkRuntimeHelper(detailTr) {
  const badge = detailTr.querySelector('[data-role="runtime-status"]');
  const latency = detailTr.querySelector('[data-role="runtime-latency"]');
  if (!badge) return;
  badge.textContent = 'Checking...';
  badge.className = 'runtime-status-badge rt-unknown';
  latency.textContent = '';
  try {
    const body = await api('/api/runtime/ping');
    const labelMap = { running: 'Running', 'not-running': 'Not running', error: 'Error' };
    const label = labelMap[body.status] || 'Unknown';
    badge.textContent = label;
    badge.className = 'runtime-status-badge rt-' + (labelMap[body.status] ? body.status : 'unknown');
    latency.textContent = typeof body.responseMs === 'number' ? `(${body.responseMs}ms)` : '';
  } catch (e) {
    badge.textContent = 'Error';
    badge.className = 'runtime-status-badge rt-error';
  }
}

// 個別project rescan（Phase 4-E）。全target/全projectを再読込せず、
// 指定した1 projectだけ git/README/PROGRESS/remote情報を再取得する。
// 成功時は state.repos を差し替えて再描画（フィルタ条件から外れた場合は
// 一覧から消えるが、それは仕様どおりでエラーにはしない）。
// 失敗時は再描画せず、渡されたボタン・結果表示だけを元に戻す（DOM参照が
// renderTable()で失われないようにするため）
// Rescan結果（rescanResult）を短い1行＋展開可能な詳細として表示する。
// updated/unchanged/excluded/errorsを区別し、「何が変わって何が変わらなかったか」を
// 保存済みcontextの上書きと誤認されないよう明示する
function rescanResultHtml(rr) {
  if (!rr) return '';
  const parts = [];
  if (rr.errors && rr.errors.length) parts.push(`⚠ ${rr.errors.length}件のエラー`);
  parts.push(rr.updated.length ? `更新: ${rr.updated.length}件` : '変更なし');
  const summary = parts.join(' / ');
  const readmeLine = rr.readme.exists
    ? `README.md: 再読込済み（${rr.readme.changed === true ? '内容変更あり' : rr.readme.changed === false ? '変更なし' : '比較不可'}）`
    : 'README.md: なし';
  const progressLine = rr.progress.exists
    ? `PROGRESS.md: 再読込済み（${rr.progress.changed === true ? '内容変更あり' : rr.progress.changed === false ? '変更なし' : '比較不可'}）`
    : 'PROGRESS.md: なし';
  return `<span class="rescan-summary${rr.errors.length ? ' err' : ''}">${esc(summary)}</span>
    <details class="rescan-detail">
      <summary>詳細</summary>
      <div class="cdate">更新: ${rr.updated.length ? esc(rr.updated.join(', ')) : 'なし'}</div>
      <div class="cdate">変更なし（再取得済み）: ${rr.unchanged.length ? esc(rr.unchanged.join(', ')) : 'なし'}</div>
      <div class="cdate">${esc(readmeLine)}</div>
      <div class="cdate">${esc(progressLine)}</div>
      <div class="cdate">対象外（保存済みcontext等。Rescanでは書き換えません）: ${esc(rr.excluded.join(', '))}</div>
      ${rr.errors.length ? `<div class="cdate progress-err">エラー: ${esc(rr.errors.join(', '))}</div>` : ''}
    </details>`;
}

async function rescanOneProject(repo, { resultEl, buttons }) {
  buttons.forEach((b) => { if (b) b.disabled = true; });
  if (resultEl) {
    resultEl.textContent = 'Rescanning...';
    resultEl.className = 'save-result';
  }
  try {
    const body = await api('/api/projects/rescan-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repo.path, targetId: repo.targetId }),
    });
    const idx = state.repos.findIndex((r) => r.path === repo.path);
    if (idx !== -1 && body.project) state.repos[idx] = body.project;
    renderSummary();
    renderTable();
    // renderTable()がdetail-rowを再生成するため、再取得後のDOMへ結果を反映する
    const newResultEl = document.querySelector(`[data-detail="${CSS.escape(repo.path)}"] [data-role="rescan-result"]`);
    if (newResultEl && body.rescanResult) {
      newResultEl.className = 'save-result ok';
      newResultEl.innerHTML = rescanResultHtml(body.rescanResult);
    }
  } catch (e) {
    buttons.forEach((b) => { if (b) b.disabled = false; });
    if (resultEl) {
      resultEl.textContent = '失敗: ' + e.message;
      resultEl.className = 'save-result err';
    }
  }
}

function developmentSessionKey(repo) {
  return `${repo.targetId}\n${repo.path}`;
}

// Phase 2: schemaに適合するproject設定ひな形をscan結果だけから生成する。
// server側へ任意のcommand/args/cwdを送るAPIは無く、コピーするだけ。
// commandはplaceholderのままだと（lib/development-sessions.jsのschema側で）
// 明確に拒否されるため、編集せずに保存しても起動はできない
const SESSION_TEMPLATE_PLACEHOLDER_COMMAND = 'EDIT_ME';

function buildProjectConfigTemplate(repo) {
  return {
    targetId: repo.targetId,
    path: repo.path,
    defaultProfileId: 'default',
    profiles: [
      {
        id: 'default',
        label: 'Default development',
        items: [
          {
            id: 'shell',
            label: 'Shell',
            kind: 'process',
            enabledByDefault: true,
            command: SESSION_TEMPLATE_PLACEHOLDER_COMMAND,
            args: [],
            cwd: '.',
          },
        ],
      },
    ],
  };
}

function buildFullConfigTemplate(repo) {
  return { version: 1, projects: [buildProjectConfigTemplate(repo)] };
}

function developmentSessionItemsHtml(profile) {
  return profile.items.map((item) => `<label class="development-session-item">
    <input type="checkbox" data-role="development-session-item" value="${esc(item.id)}"${item.enabledByDefault ? ' checked' : ''}>
    <span class="session-item-content">
      <span class="session-item-heading">
        <strong>${esc(item.label)}</strong>
        <span class="session-kind session-kind-${esc(item.kind)}">${esc(item.kind)}</span>
        <span class="session-default">default ${item.enabledByDefault ? 'on' : 'off'}</span>
      </span>
      <code class="session-command">${esc(item.displayCommand)}</code>
      <span class="session-cwd">cwd: ${esc(item.cwd)}</span>
    </span>
  </label>`).join('');
}

// Phase 2: 設定に使う正確な識別情報（内部targetId / 正規path）をコンパクトに
// 表示する。表示labelはproject headerで既に見えているためここでは省略し、
// 値とCopyボタンは同じ行に置く。ここではユーザー入力を受け付けない（表示のみ）
function developmentSessionIdentityHtml(identity) {
  if (!identity) return '';
  return `<div class="session-identity-row">
      <span class="session-identity-label">Target ID</span>
      <code class="session-identity-value session-identity-code">${esc(identity.targetId)}</code>
      <button type="button" class="session-identity-copy" data-role="copy-session-value" data-copy="${esc(identity.targetId)}">コピー</button>
    </div>
    <div class="session-identity-row">
      <span class="session-identity-label">Path</span>
      <code class="session-identity-value session-identity-code session-identity-path">${esc(identity.path)}</code>
      <button type="button" class="session-identity-copy" data-role="copy-session-value" data-copy="${esc(identity.path)}">コピー</button>
    </div>`;
}

// Phase 4: field単位のvalidation issueをJSON path / short code / message / hintで表示する
function developmentSessionIssuesHtml(issues) {
  if (!issues || issues.length === 0) return '';
  const shown = issues.slice(0, 20);
  const items = shown.map((detail) => `<li class="session-issue">
      <code class="session-issue-path">${esc(detail.path)}</code>
      <div class="session-issue-message">${esc(detail.message)}</div>
      ${detail.hint ? `<div class="session-issue-hint">${esc(detail.hint)}</div>` : ''}
    </li>`).join('');
  const more = issues.length > shown.length
    ? `<li class="session-issue-more">他 ${issues.length - shown.length} 件のissue</li>`
    : '';
  return `<div class="session-issues">
    <div class="session-issues-heading">設定エラー（${issues.length}件のissue）</div>
    <ul class="session-issue-list">${items}${more}</ul>
  </div>`;
}

// Phase 3/5: target-id-mismatch / path-mismatchを、設定側の値と正しい値を
// 並べて比較できる形で表示する（識別情報の値そのものは下の「設定情報」でも
// 確認できるが、ここでは「何が間違っているか」に絞って示す）
function developmentSessionMismatchHtml(session) {
  if (session.state === 'target-id-mismatch') {
    const correctTargetId = session.identity ? session.identity.targetId : '';
    return `<div class="session-mismatch">
      <div class="session-mismatch-row"><span class="session-mismatch-label">設定のTarget ID</span><code>${esc(session.configuredTargetId)}</code></div>
      <div class="session-mismatch-row"><span class="session-mismatch-label">正しいTarget ID</span><code>${esc(correctTargetId)}</code></div>
    </div>`;
  }
  if (session.state === 'path-mismatch') {
    const correctPath = session.identity ? session.identity.path : '';
    return `<div class="session-mismatch">
      <div class="session-mismatch-row"><span class="session-mismatch-label">設定のPath</span></div>
      <code class="session-mismatch-path">${esc(session.configuredPath)}</code>
      <div class="session-mismatch-row"><span class="session-mismatch-label">正しいPath</span></div>
      <code class="session-mismatch-path">${esc(correctPath)}</code>
    </div>`;
  }
  return '';
}

// Phase 5: 起動プリセットのitem preview（labelだけを箇条書きで示す。
// commandは折りたたみ内の詳細でなく、この場では省く）
function developmentSessionPresetItemsPreviewInnerHtml(preset) {
  if (!preset) return '';
  return preset.items.map((item) => `<li>${esc(item.label)}</li>`).join('');
}

// Phase 5/6: 未設定projectで、このprojectのplatformに適合する起動プリセットが
// 1件以上ある場合の主操作。プリセット選択・内容preview・「このプリセットで登録」を
// 常用の主操作とし、従来のひな形コピー等は「詳細設定」へ回す。
// LANなど登録不可な場所からは、登録buttonを disabled にし案内文を出す
// （既存の設定済みprojectの起動には影響しない）
function developmentSessionPresetPickerHtml(session) {
  const presets = session.availablePresets || [];
  if (presets.length === 0) return '';
  const options = presets.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  const registerDisabled = !session.canRegister;
  return `<div class="session-preset-picker" data-role="session-preset-picker">
    <label class="session-preset-row"><span>起動プリセット</span>
      <select data-role="session-preset-select">${options}</select>
    </label>
    <div class="session-preset-preview">
      <div class="session-preset-preview-heading">内容:</div>
      <ul data-role="session-preset-preview-list">${developmentSessionPresetItemsPreviewInnerHtml(presets[0])}</ul>
    </div>
    <div class="session-primary-actions">
      <button type="button" class="session-btn-primary" data-role="register-preset"${registerDisabled ? ' disabled' : ''}>このプリセットで登録</button>
    </div>
    ${registerDisabled
      ? '<div class="session-preset-note">このprojectは未登録です。project登録はWindows PCのlocalhostから行ってください。設定済みprojectの起動はこのまま利用できます。</div>'
      : ''}
  </div>`;
}

// Phase 4/5: 状態に応じた操作button群。configured以外では、設定補助
// （ひな形コピー / 設定ファイルopen / 再読み込み / VSCodeだけ開く）を
// primary/secondary/tertiaryの優先順位で目立たせる（開始buttonは表示しない）。
// 未設定projectに適合presetがある場合は、preset選択+登録を主操作にし、
// 従来のひな形コピー等は「詳細設定」として一段下げる
function developmentSessionActionButtonsHtml(session) {
  const showFullConfigCopy = session.state === 'not-configured' && session.reason === 'missing-file';
  const isMismatch = session.state === 'target-id-mismatch' || session.state === 'path-mismatch';
  const templateLabel = isMismatch ? '正しいproject設定ひな形をコピー' : 'project設定ひな形をコピー';
  const hasPresets = session.state === 'not-configured' &&
    Array.isArray(session.availablePresets) && session.availablePresets.length > 0;

  if (hasPresets) {
    return `${developmentSessionPresetPickerHtml(session)}
      <div class="session-detail-settings">
        <div class="session-detail-settings-label">詳細設定</div>
        <div class="session-tertiary-actions">
          <button type="button" class="session-btn-tertiary" data-role="open-development-sessions-config">設定ファイルをVS Codeで開く</button>
          <button type="button" class="session-btn-tertiary" data-role="copy-session-template">project設定ひな形をコピー</button>
          <button type="button" class="session-btn-tertiary" data-role="reload-development-session">設定を再読み込み</button>
          <button type="button" class="session-btn-tertiary" data-role="open-vscode">VSCodeだけ開く</button>
        </div>
      </div>`;
  }

  return `<div class="session-primary-actions">
      <button type="button" class="session-btn-primary" data-role="copy-session-template">${esc(templateLabel)}</button>
    </div>
    <div class="session-secondary-actions">
      <button type="button" class="session-btn-secondary" data-role="open-development-sessions-config">設定ファイルをVS Codeで開く</button>
      ${showFullConfigCopy ? '<button type="button" class="session-btn-secondary" data-role="copy-session-full-config">新規設定ファイル全体をコピー</button>' : ''}
    </div>
    <div class="session-tertiary-actions">
      <button type="button" class="session-btn-tertiary" data-role="reload-development-session">設定を再読み込み</button>
      <button type="button" class="session-btn-tertiary" data-role="open-vscode">VSCodeだけ開く</button>
    </div>`;
}

// Phase 2/4/7: 識別情報（Target ID / Path）を「設定情報」の折りたたみへまとめる。
// configuredでは、参照している起動プリセット（presetId / additionalItems）と
// 設定補助button（ひな形コピー/設定ファイルopen/再読み込み）もこの中に入れて
// 初期折りたたみにし、常用の起動操作を主役にする。configured以外では
// button群は既にbody側で目立つ位置にあるため、ここには識別情報だけを入れ、
// 未設定/mismatch/invalid時は初期展開する
function developmentSessionConfigDetailsHtml(session) {
  const identityHtml = developmentSessionIdentityHtml(session.identity);
  const configured = session.state === 'configured';
  let presetInfoHtml = '';
  if (configured && session.presetId) {
    const additionalItemIds = session.additionalItemIds || [];
    presetInfoHtml = `<div class="session-identity-row">
      <span class="session-identity-label">Preset ID</span>
      <code class="session-identity-value session-identity-code">${esc(session.presetId)}</code>
    </div>
    ${additionalItemIds.length > 0
      ? `<div class="session-identity-row">
          <span class="session-identity-label">追加item</span>
          <span class="session-identity-value">${esc(additionalItemIds.join(', '))}</span>
        </div>`
      : ''}`;
  }
  const helperButtons = configured
    ? `<div class="session-config-actions-buttons">
        <button type="button" data-role="copy-session-template">project設定ひな形をコピー</button>
        <button type="button" data-role="open-development-sessions-config">設定ファイルをVS Codeで開く</button>
        <button type="button" data-role="reload-development-session">設定を再読み込み</button>
      </div>`
    : '';
  return `<details class="session-config-details" data-role="session-config-details"${configured ? '' : ' open'}>
    <summary>設定情報</summary>
    <div class="session-identity">${presetInfoHtml}${identityHtml}</div>
    ${helperButtons}
  </details>`;
}

// Phase 7: 起動プリセット経由で設定されたprojectでは、profile labelの前に
// 「起動プリセット: 」を付けて、通常のprofile名と区別できるようにする
function developmentSessionProfileLabelText(session, profile) {
  return session.presetId ? `起動プリセット: ${profile.label}` : profile.label;
}

const SESSION_STATE_LABELS = {
  configured: '設定済み',
  'not-configured': '未設定',
  'target-id-mismatch': 'Target IDが一致しません',
  'path-mismatch': 'Pathが一致しません',
  invalid: '設定エラー',
};

function renderDevelopmentSession(detailTr, session, preferredProfileId) {
  const body = detailTr.querySelector('[data-role="development-session-body"]');
  const startButton = detailTr.querySelector('[data-role="start-development-session"]');
  const topVscodeButton = detailTr.querySelector('.development-session-actions [data-role="open-vscode"]');
  const statusBadgeEl = detailTr.querySelector('[data-role="session-status-badge"]');
  const configActionsEl = detailTr.querySelector('[data-role="development-session-config-actions"]');

  if (!session || session.error) {
    if (statusBadgeEl) {
      statusBadgeEl.textContent = 'エラー';
      statusBadgeEl.className = 'session-status-badge session-status-error';
    }
    body.innerHTML = `<div class="session-config-error">${esc(session && session.error ? session.error : '設定の読み込みに失敗しました。')}</div>`;
    startButton.hidden = true;
    startButton.disabled = true;
    if (topVscodeButton) topVscodeButton.hidden = false;
    if (configActionsEl) configActionsEl.innerHTML = '';
    return;
  }

  if (statusBadgeEl) {
    statusBadgeEl.textContent = SESSION_STATE_LABELS[session.state] || session.state || '';
    statusBadgeEl.className = `session-status-badge session-status-${esc(session.state || 'unknown')}`;
  }
  if (configActionsEl) configActionsEl.innerHTML = developmentSessionConfigDetailsHtml(session);

  if (session.state === 'configured') {
    startButton.hidden = false;
    if (topVscodeButton) topVscodeButton.hidden = false;
    const profile = session.profiles.find((entry) => entry.id === preferredProfileId) ||
      session.profiles.find((entry) => entry.id === session.defaultProfileId) ||
      session.profiles[0];
    const profileLabelText = developmentSessionProfileLabelText(session, profile);
    const profileSelect = session.profiles.length > 1
      ? `<label class="session-profile-row"><span>Profile</span><select data-role="development-session-profile">${session.profiles.map(
          (entry) => `<option value="${esc(entry.id)}"${entry.id === profile.id ? ' selected' : ''}>${esc(entry.label)}</option>`
        ).join('')}</select></label>`
      : `<div class="session-profile-label">${esc(profileLabelText)}</div>
         <input type="hidden" data-role="development-session-profile" value="${esc(profile.id)}">`;
    body.innerHTML = `${profileSelect}<div class="development-session-items">${developmentSessionItemsHtml(profile)}</div>`;
    startButton.disabled = !profile.items.some((item) => item.enabledByDefault);
    return;
  }

  // 使えない開始buttonを大きなdisabled表示のまま残さない（非表示にする）。
  // VSCodeだけ開くはbody側のtertiary操作として表示するため、上段は隠す
  startButton.hidden = true;
  startButton.disabled = true;
  if (topVscodeButton) topVscodeButton.hidden = true;
  const actionButtonsHtml = developmentSessionActionButtonsHtml(session);

  if (session.state === 'not-configured') {
    body.innerHTML = `<div class="session-empty">このprojectにはDevelopment session設定がありません。</div>${actionButtonsHtml}`;
    return;
  }
  if (session.state === 'target-id-mismatch' || session.state === 'path-mismatch') {
    body.innerHTML = `${developmentSessionMismatchHtml(session)}${actionButtonsHtml}`;
    return;
  }
  if (session.state === 'invalid') {
    body.innerHTML = `${developmentSessionIssuesHtml(session.issues)}${actionButtonsHtml}`;
    return;
  }
  body.innerHTML = actionButtonsHtml;
}

async function loadDevelopmentSession(repo, force = false) {
  const key = developmentSessionKey(repo);
  const detailTr = document.querySelector(`tr.detail-row[data-detail="${CSS.escape(repo.path)}"]`);
  if (!detailTr) return;
  const cached = developmentSessionCache.get(key);
  if (!force && cached && !cached.loading) {
    renderDevelopmentSession(detailTr, cached);
    return;
  }
  if (!force && cached && cached.loading) return;

  developmentSessionCache.set(key, { loading: true });
  const body = detailTr.querySelector('[data-role="development-session-body"]');
  body.innerHTML = '<span class="cdate">設定を読み込み中...</span>';
  detailTr.querySelector('[data-role="start-development-session"]').disabled = true;
  try {
    const query = new URLSearchParams({ path: repo.path, targetId: repo.targetId });
    if (force) query.set('reload', '1');
    const session = await api(`/api/projects/development-session?${query.toString()}`);
    developmentSessionCache.set(key, session);
    const currentDetail = document.querySelector(`tr.detail-row[data-detail="${CSS.escape(repo.path)}"]`);
    if (currentDetail) renderDevelopmentSession(currentDetail, session);
  } catch (error) {
    const failed = { error: `設定エラー: ${error.message}` };
    developmentSessionCache.set(key, failed);
    const currentDetail = document.querySelector(`tr.detail-row[data-detail="${CSS.escape(repo.path)}"]`);
    if (currentDetail) renderDevelopmentSession(currentDetail, failed);
  }
}

function selectedDevelopmentSessionItems(detailTr) {
  return Array.from(detailTr.querySelectorAll('[data-role="development-session-item"]'))
    .filter((input) => input.checked && !input.disabled)
    .map((input) => input.value);
}

async function startDevelopmentSession(repo, detailTr, button) {
  const resultEl = detailTr.querySelector('[data-role="development-session-result"]');
  const profileSelect = detailTr.querySelector('[data-role="development-session-profile"]');
  const itemIds = selectedDevelopmentSessionItems(detailTr);
  if (itemIds.length === 0) {
    resultEl.textContent = '起動対象を1つ以上選択してください。';
    resultEl.className = 'save-result development-session-result err';
    return;
  }
  button.disabled = true;
  resultEl.textContent = '起動要求を送信中...';
  resultEl.className = 'save-result development-session-result';
  try {
    await api('/api/projects/start-development-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: repo.path,
        targetId: repo.targetId,
        profileId: profileSelect.value,
        itemIds,
      }),
    });
    const cached = developmentSessionCache.get(developmentSessionKey(repo));
    if (cached && cached.state === 'configured') cached.workspaceGenerated = true;
    resultEl.textContent = 'Windows PCでDevelopment sessionを起動しました。初回はVS Code側の許可を確認してください。';
    resultEl.className = 'save-result development-session-result ok';
  } catch (error) {
    resultEl.textContent = '起動失敗: ' + error.message;
    resultEl.className = 'save-result development-session-result err';
  } finally {
    button.disabled = selectedDevelopmentSessionItems(detailTr).length === 0;
  }
}

async function openProjectInVscode(repo, button, resultEl) {
  button.disabled = true;
  resultEl.textContent = 'Opening...';
  resultEl.className = 'save-result development-session-result';
  try {
    await api('/api/projects/open-vscode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: repo.path, targetId: repo.targetId }),
    });
    resultEl.textContent = 'Windows PCでVSCodeを起動しました。';
    resultEl.className = 'save-result development-session-result ok';
  } catch (error) {
    resultEl.textContent = '起動失敗: ' + error.message;
    resultEl.className = 'save-result development-session-result err';
  } finally {
    button.disabled = false;
  }
}

// Phase 3: data/development-sessions.json を固定pathでVS Codeから開く。
// requestにpath/editorは含めない。既存のfixed Code.exe検出をserver側で再利用する
async function openDevelopmentSessionsConfigFile(button, resultEl) {
  button.disabled = true;
  resultEl.textContent = 'Opening...';
  resultEl.className = 'save-result development-session-result';
  try {
    await api('/api/development-sessions/open-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    resultEl.textContent = 'Windows PCでdevelopment-sessions.jsonを開きました。';
    resultEl.className = 'save-result development-session-result ok';
  } catch (error) {
    resultEl.textContent = '失敗: ' + error.message;
    resultEl.className = 'save-result development-session-result err';
  } finally {
    button.disabled = false;
  }
}

// Phase 6: 選択中の起動プリセットをこのprojectへ登録する。requestは
// targetId/path/presetIdの識別子だけを送る（command/args/cwd/preset内容は
// 送らない）。server側はlocalhostからのrequestだけを受け付ける。
// 成功したら設定を再読み込みし、configured表示へ切り替える
async function registerDevelopmentSessionPreset(repo, detailTr, button) {
  const select = detailTr.querySelector('[data-role="session-preset-select"]');
  const presetId = select ? select.value : '';
  const resultEl = detailTr.querySelector('[data-role="development-session-result"]');
  if (!presetId) return;
  button.disabled = true;
  resultEl.textContent = '登録中...';
  resultEl.className = 'save-result development-session-result';
  try {
    await api('/api/development-sessions/register-preset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId: repo.targetId, path: repo.path, presetId }),
    });
    resultEl.textContent = 'project設定を登録しました。';
    resultEl.className = 'save-result development-session-result ok';
    await loadDevelopmentSession(repo, true);
  } catch (error) {
    resultEl.textContent = '登録失敗: ' + error.message;
    resultEl.className = 'save-result development-session-result err';
    button.disabled = false;
  }
}

// ---- Phase 6-L: PC下部tab（Documents/Context/Diagnostics）・Context閲覧/編集分離 ----
// renderTable()は呼ばない。hidden属性・aria状態だけを直接更新することで、
// タブ切替のたびにMarkdown再parse・server API再取得・未保存Context編集の消失が
// 起きないようにする（既存のctx-view-mode/progress-modeと同じ設計方針）

function activateDetailTab(detailTr, panelKey) {
  const key = DETAIL_TABS.some(([k]) => k === panelKey) ? panelKey : 'documents';
  openPanel = key;
  detailTr.querySelectorAll('[data-role="detail-tab"]').forEach((btn) => {
    const active = btn.dataset.panel === key;
    btn.setAttribute('aria-selected', String(active));
    btn.tabIndex = active ? 0 : -1;
    btn.classList.toggle('active', active);
  });
  detailTr.querySelectorAll('.detail-panel').forEach((panel) => {
    panel.hidden = panel.id !== `panel-${key}`;
  });
}

// Documents内のPROGRESS/README選択（sub-tab）。renderTable()は呼ばず、
// hidden/aria属性だけを直接更新する（50ef416の実装を復元）
function activateDocumentsSubtab(detailTr, docKey) {
  const key = docKey === 'progress' ? 'progress' : 'readme';
  documentsSubView = key;
  detailTr.querySelectorAll('[data-role="documents-subtab"]').forEach((btn) => {
    const active = btn.dataset.doc === key;
    btn.setAttribute('aria-selected', String(active));
    btn.classList.toggle('active', active);
  });
  detailTr.querySelectorAll('.documents-doc').forEach((panel) => {
    panel.hidden = panel.dataset.docPanel !== key;
  });
}

// Agent contextの閲覧⇄編集切替。編集中はSaved contextの閲覧を隠し、
// 「編集する」ボタン自体もSave/Cancelに役目を譲るため隠す
function setContextEditing(detailTr, editing) {
  const block = detailTr.querySelector('[data-role="agent-context-block"]');
  const view = detailTr.querySelector('[data-role="context-view"]');
  const edit = detailTr.querySelector('[data-role="context-edit"]');
  const toggleBtn = detailTr.querySelector('[data-role="context-edit-toggle"]');
  if (!view || !edit) return;
  view.hidden = editing;
  edit.hidden = !editing;
  if (toggleBtn) toggleBtn.hidden = editing;
  if (block) block.classList.toggle('editing', editing);
}

// Cancel: textarea・previewを保存済みの値へ戻す（入力中の破棄）
function resetContextEditForm(detailTr, repo) {
  const contextMd = contextMarkdownFor(repo);
  const ta = detailTr.querySelector('[data-role="ctx-markdown"]');
  const cmdTa = detailTr.querySelector('[data-role="ctx-commands"]');
  if (ta) ta.value = contextMd;
  if (cmdTa) cmdTa.value = repo.commandHints || '';
  detailTr.querySelectorAll('[data-role="ctx-view-mode"]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === 'markdown');
  });
  updateContextPreview(detailTr);
  const preview = detailTr.querySelector('[data-role="ctx-md-preview"]');
  if (preview) preview.hidden = false;
  if (ta) ta.hidden = true;
}

// project切替前に、開いたままのContext編集が未保存かどうかを確認する
// （切替はrenderTable()でDOM全体を再生成するため、無警告だと編集内容が消える）
function hasUnsavedContextEdit(detailTr) {
  const edit = detailTr && detailTr.querySelector('[data-role="context-edit"]');
  return !!(edit && !edit.hidden);
}

// mobile Phase 3: Documents/Context/Diagnosticsのmobile accordion開閉。
// PCの`activateDetailTab()`（`openPanel`・`hidden`属性による排他制御）とは
// 完全に別の状態・別のDOM操作。ここでは`hidden`属性には一切触れず、
// `.mobile-open`クラスとaria-expandedだけを更新する（mobile CSSがこのクラスで
// 表示を制御し、PC幅では`.mobile-accordion-toggle`自体が非表示のため関与しない）
function toggleMobileAccordion(detailTr, key) {
  if (!Object.prototype.hasOwnProperty.call(mobileAccordionOpen, key)) return;
  const nextOpen = !mobileAccordionOpen[key];
  mobileAccordionOpen[key] = nextOpen;
  const btn = detailTr.querySelector(`[data-role="mobile-accordion-toggle"][data-panel="${key}"]`);
  const panel = detailTr.querySelector(`#panel-${key}`);
  if (btn) btn.setAttribute('aria-expanded', String(nextOpen));
  if (panel) panel.classList.toggle('mobile-open', nextOpen);
}

// ---- イベント -------------------------------------------------------------

document.getElementById('repo-tbody').addEventListener('click', (ev) => {
  const saveBtn = ev.target.closest('[data-role="save"]');
  if (saveBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    saveStatus(detailTr, detailTr.dataset.detail);
    return;
  }
  const startSessionBtn = ev.target.closest('[data-role="start-development-session"]');
  if (startSessionBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    if (repo) startDevelopmentSession(repo, detailTr, startSessionBtn);
    return;
  }
  const reloadSessionBtn = ev.target.closest('[data-role="reload-development-session"]');
  if (reloadSessionBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    if (repo) {
      reloadSessionBtn.disabled = true;
      loadDevelopmentSession(repo, true).finally(() => { reloadSessionBtn.disabled = false; });
    }
    return;
  }
  const openVscodeBtn = ev.target.closest('[data-role="open-vscode"]');
  if (openVscodeBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    if (repo) {
      openProjectInVscode(
        repo,
        openVscodeBtn,
        detailTr.querySelector('[data-role="development-session-result"]')
      );
    }
    return;
  }
  // Phase 3: 固定path（data/development-sessions.json）だけをVS Codeで開く
  const openConfigBtn = ev.target.closest('[data-role="open-development-sessions-config"]');
  if (openConfigBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    openDevelopmentSessionsConfigFile(
      openConfigBtn,
      detailTr.querySelector('[data-role="development-session-result"]')
    );
    return;
  }
  // Phase 6: 選択中の起動プリセットをこのprojectへ登録する
  const registerPresetBtn = ev.target.closest('[data-role="register-preset"]');
  if (registerPresetBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    if (repo) registerDevelopmentSessionPreset(repo, detailTr, registerPresetBtn);
    return;
  }
  // Phase 1: Target ID / project path の個別コピー
  const identityCopyBtn = ev.target.closest('[data-role="copy-session-value"]');
  if (identityCopyBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const result = detailTr.querySelector('[data-role="development-session-result"]');
    copyToClipboard(identityCopyBtn.dataset.copy || '').then((ok) => {
      result.textContent = ok ? 'Copied.' : 'Copy failed.';
      result.className = ok ? 'save-result development-session-result ok' : 'save-result development-session-result err';
    });
    return;
  }
  // Phase 2: schemaに適合するproject設定ひな形をコピーする（serverへは何も送らない）
  const templateCopyBtn = ev.target.closest('[data-role="copy-session-template"]');
  if (templateCopyBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    const result = detailTr.querySelector('[data-role="development-session-result"]');
    if (repo) {
      copyToClipboard(JSON.stringify(buildProjectConfigTemplate(repo), null, 2)).then((ok) => {
        result.textContent = ok ? 'project設定ひな形をコピーしました。' : 'Copy failed.';
        result.className = ok ? 'save-result development-session-result ok' : 'save-result development-session-result err';
      });
    }
    return;
  }
  const fullConfigCopyBtn = ev.target.closest('[data-role="copy-session-full-config"]');
  if (fullConfigCopyBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    const result = detailTr.querySelector('[data-role="development-session-result"]');
    if (repo) {
      copyToClipboard(JSON.stringify(buildFullConfigTemplate(repo), null, 2)).then((ok) => {
        result.textContent = ok ? '新規設定ファイルのひな形をコピーしました。' : 'Copy failed.';
        result.className = ok ? 'save-result development-session-result ok' : 'save-result development-session-result err';
      });
    }
    return;
  }
  const handoffBtn = ev.target.closest('[data-role="copy-handoff"]');
  if (handoffBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    const result = detailTr.querySelector('[data-role="handoff-result"]');
    const purposeSel = detailTr.querySelector('[data-role="handoff-purpose"]');
    const purposeKey = purposeSel ? purposeSel.value : handoffPurpose;
    if (repo) {
      copyToClipboard(buildHandoffMarkdown(repo, purposeKey)).then((ok) => {
        result.textContent = ok ? 'Copied AI handoff.' : 'Copy failed.';
        result.className = ok ? 'save-result ok' : 'save-result err';
      });
    }
    return;
  }
  // Phase 6-L: 下部tab（Documents/Context/Diagnostics）切替。renderTable()は
  // 呼ばず、hidden/aria属性だけを更新する（同じprojectの再描画では選択タブを維持）
  const tabBtn = ev.target.closest('[data-role="detail-tab"]');
  if (tabBtn) {
    activateDetailTab(ev.target.closest('tr.detail-row'), tabBtn.dataset.panel);
    return;
  }
  const docSubtabBtn = ev.target.closest('[data-role="documents-subtab"]');
  if (docSubtabBtn) {
    activateDocumentsSubtab(ev.target.closest('tr.detail-row'), docSubtabBtn.dataset.doc);
    return;
  }
  const mobileAccordionBtn = ev.target.closest('[data-role="mobile-accordion-toggle"]');
  if (mobileAccordionBtn) {
    toggleMobileAccordion(ev.target.closest('tr.detail-row'), mobileAccordionBtn.dataset.panel);
    return;
  }
  const contextEditToggleBtn = ev.target.closest('[data-role="context-edit-toggle"]');
  if (contextEditToggleBtn) {
    setContextEditing(ev.target.closest('tr.detail-row'), true);
    return;
  }
  const contextEditCancelBtn = ev.target.closest('[data-role="context-edit-cancel"]');
  if (contextEditCancelBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    if (repo) resetContextEditForm(detailTr, repo);
    setContextEditing(detailTr, false);
    return;
  }
  const modeBtn = ev.target.closest('[data-role="progress-mode"]');
  if (modeBtn) {
    progressViewMode = modeBtn.dataset.mode === 'plain' ? 'plain' : 'markdown';
    saveViewState();
    renderTable();
    return;
  }
  const readmeModeBtn = ev.target.closest('[data-role="readme-mode"]');
  if (readmeModeBtn) {
    readmeViewMode = readmeModeBtn.dataset.mode === 'plain' ? 'plain' : 'markdown';
    renderTable();
    return;
  }
  // Agent context の Markdown / Plain text タブ切替（Phase 5-E follow-up）。
  // PROGRESS.mdと違い再描画はせず、preview/textareaの表示を切り替えるだけ
  // （textareaの未保存編集を失わないため）。Markdownタブへ戻る時にpreviewを更新する
  const ctxModeBtn = ev.target.closest('[data-role="ctx-view-mode"]');
  if (ctxModeBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const mode = ctxModeBtn.dataset.mode === 'plain' ? 'plain' : 'markdown';
    detailTr.querySelectorAll('[data-role="ctx-view-mode"]').forEach((b) => {
      b.classList.toggle('active', b === ctxModeBtn);
    });
    const ta = detailTr.querySelector('[data-role="ctx-markdown"]');
    const preview = detailTr.querySelector('[data-role="ctx-md-preview"]');
    if (mode === 'plain') {
      preview.hidden = true;
      ta.hidden = false;
      ta.focus();
    } else {
      updateContextPreview(detailTr);
      ta.hidden = true;
      preview.hidden = false;
    }
    return;
  }
  const rescanBtn = ev.target.closest('[data-role="rescan-project"]');
  if (rescanBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    if (repo) {
      rescanOneProject(repo, {
        resultEl: detailTr.querySelector('[data-role="rescan-result"]'),
        buttons: [rescanBtn],
      });
    }
    return;
  }
  const runtimeCheckBtn = ev.target.closest('[data-role="runtime-check"]');
  if (runtimeCheckBtn) {
    checkRuntimeHelper(ev.target.closest('tr.detail-row'));
    return;
  }
  const runtimeOpenBtn = ev.target.closest('[data-role="runtime-open"]');
  if (runtimeOpenBtn) {
    // token付きURLは持たない固定リンクを新規タブで開くだけ（agent-workbenchからのfetchや実行はしない）
    window.open(runtimeOpenBtn.dataset.url, '_blank', 'noopener,noreferrer');
    return;
  }
  const rowRescanBtn = ev.target.closest('[data-role="row-rescan"]');
  if (rowRescanBtn) {
    const row = ev.target.closest('tr.repo-row');
    const repoPath = row.dataset.path;
    // 詳細ペインを開いて結果表示欄を確保してからrescanする（未オープンなら開く）
    if (openPath !== repoPath) {
      openPath = repoPath;
      renderTable();
    }
    const detailTr = document.querySelector(`tr.detail-row[data-detail="${CSS.escape(repoPath)}"]`);
    const repo = state.repos.find((r) => r.path === repoPath);
    if (detailTr && repo) {
      rescanOneProject(repo, {
        resultEl: detailTr.querySelector('[data-role="rescan-result"]'),
        buttons: [detailTr.querySelector('[data-role="rescan-project"]'), rowRescanBtn],
      });
    }
    return;
  }
  const saveContextBtn = ev.target.closest('[data-role="save-context"]');
  if (saveContextBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    if (repo) saveContext(detailTr, detailTr.dataset.detail, repo);
    return;
  }
  const autofillBtn = ev.target.closest('[data-role="autofill-context"]');
  if (autofillBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((r) => r.path === detailTr.dataset.detail);
    if (repo) autoFillContext(detailTr, repo);
    return;
  }
  const copyCommandsBtn = ev.target.closest('[data-role="copy-commands"]');
  if (copyCommandsBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const ta = detailTr.querySelector('[data-role="ctx-commands"]');
    const result = detailTr.querySelector('[data-role="context-result"]');
    copyToClipboard(ta.value).then((ok) => {
      result.textContent = ok ? 'Copied commands.' : 'Copy failed.';
      result.className = ok ? 'save-result ok' : 'save-result err';
    });
    return;
  }
  const copyCommandBtn = ev.target.closest('[data-role="copy-command"]');
  if (copyCommandBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repoPath = detailTr.dataset.detail;
    const result = detailTr.querySelector('[data-role="context-result"]');
    const text = `cd "${repoPath}"\n${copyCommandBtn.dataset.command}`;
    copyToClipboard(text).then((ok) => {
      result.textContent = ok ? 'Copied command.' : 'Copy failed.';
      result.className = ok ? 'save-result ok' : 'save-result err';
    });
    return;
  }
  const copyContextBtn = ev.target.closest('[data-role="copy-context"]');
  if (copyContextBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const result = detailTr.querySelector('[data-role="context-result"]');
    const md = readContextForm(detailTr).contextMarkdown;
    copyToClipboard(md && md.trim() ? md : '(not set)').then((ok) => {
      result.textContent = ok ? 'コピーしました（agent context）' : 'Copy failed.';
      result.className = ok ? 'save-result ok' : 'save-result err';
    });
    return;
  }
  const copyContextCommandsBtn = ev.target.closest('[data-role="copy-context-commands"]');
  if (copyContextCommandsBtn) {
    const detailTr = ev.target.closest('tr.detail-row');
    const result = detailTr.querySelector('[data-role="context-result"]');
    copyToClipboard(buildContextCommandsMarkdown(readContextForm(detailTr))).then((ok) => {
      result.textContent = ok ? 'コピーしました（context + commands）' : 'Copy failed.';
      result.className = ok ? 'save-result ok' : 'save-result err';
    });
    return;
  }
  if (ev.target.closest('tr.detail-row')) return; // 詳細内クリックは無視
  const row = ev.target.closest('tr.repo-row');
  if (!row) return;
  const nextPath = openPath === row.dataset.path ? null : row.dataset.path;
  if (nextPath !== openPath) {
    // project切替はrenderTable()でDOM全体を再生成するため、Context編集中なら
    // 無警告で失われる前に確認する（Phase 6-L要件）
    const currentDetailTr = openPath
      ? document.querySelector(`tr.detail-row[data-detail="${CSS.escape(openPath)}"]`)
      : null;
    if (currentDetailTr && hasUnsavedContextEdit(currentDetailTr)) {
      if (!confirm('Agent contextの編集内容が保存されていません。破棄してprojectを切り替えますか？')) return;
    }
    // project切替時はDocuments + README（初期closed）へ戻す（実画面確認の
    // FBにより、Always/Resume/PROGRESS見出しを中心にした静かな初期表示が
    // 最も自然だった。Resumeは常時表示のため対象外）。mobile accordion
    // （Documents/Context/Diagnostics）もすべてclosedへ戻す
    openPanel = 'documents';
    documentsSubView = 'readme';
    readmeExpanded = false;
    mobileAccordionOpen = { documents: false, context: false, diagnostics: false };
  }
  openPath = nextPath;
  renderTable();
});

// Phase 6-L: 下部tab（Documents/Context/Diagnostics）のkeyboard操作
// （ArrowLeft/ArrowRight/Home/End）。Enter/Spaceはbuttonのネイティブ動作に任せる
document.getElementById('repo-tbody').addEventListener('keydown', (ev) => {
  const tabBtn = ev.target.closest('[data-role="detail-tab"]');
  if (!tabBtn) return;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
  const tablist = ev.target.closest('.detail-tabs');
  if (!tablist) return;
  const tabs = Array.from(tablist.querySelectorAll('[data-role="detail-tab"]'));
  const idx = tabs.indexOf(tabBtn);
  let nextIdx = idx;
  if (ev.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
  else if (ev.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
  else if (ev.key === 'Home') nextIdx = 0;
  else if (ev.key === 'End') nextIdx = tabs.length - 1;
  ev.preventDefault();
  const detailTr = ev.target.closest('tr.detail-row');
  activateDetailTab(detailTr, tabs[nextIdx].dataset.panel);
  tabs[nextIdx].focus();
});

// Agent context markdown の入力中プレビュー更新（Phase 5-E）
document.getElementById('repo-tbody').addEventListener('input', (ev) => {
  if (ev.target.matches && ev.target.matches('[data-role="ctx-markdown"]')) {
    const detailTr = ev.target.closest('tr.detail-row');
    if (detailTr) updateContextPreview(detailTr);
  }
});

// READMEの折りたたみ開閉（nativeの<details>。keyboard Enter/Space・focus・
// hidden時の非フォーカスはブラウザの既定動作にそのまま任せる）。toggleイベントは
// バブルしないため、repo-tbodyへのcapture-phaseリスナーで拾う。ここで
// readmeExpandedを同期しておくことで、progress-mode/readme-mode切替や
// Rescan等でrenderTable()が再実行されても開閉状態を維持できる
document.getElementById('repo-tbody').addEventListener('toggle', (ev) => {
  if (ev.target.matches && ev.target.matches('[data-role="readme-details"]')) {
    readmeExpanded = ev.target.open;
    const summary = ev.target.querySelector('[data-role="readme-toggle"]');
    if (summary) summary.setAttribute('aria-expanded', String(readmeExpanded));
  }
}, true);

// Handoff purpose の選択を保存する（Phase 5-F。全project共通の単純な設定値）
document.getElementById('repo-tbody').addEventListener('change', (ev) => {
  if (ev.target.matches && ev.target.matches('[data-role="handoff-purpose"]')) {
    handoffPurpose = ev.target.value;
    saveHandoffPurpose();
    return;
  }
  if (ev.target.matches && ev.target.matches('[data-role="development-session-profile"]')) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((entry) => entry.path === detailTr.dataset.detail);
    const cached = repo ? developmentSessionCache.get(developmentSessionKey(repo)) : null;
    if (cached && cached.state === 'configured') renderDevelopmentSession(detailTr, cached, ev.target.value);
    return;
  }
  if (ev.target.matches && ev.target.matches('[data-role="development-session-item"]')) {
    const detailTr = ev.target.closest('tr.detail-row');
    detailTr.querySelector('[data-role="start-development-session"]').disabled =
      selectedDevelopmentSessionItems(detailTr).length === 0;
  }
  // Phase 5: プリセット選択を切り替えたら内容previewだけを更新する
  // （client側に既にある availablePresets から作るため、再取得は不要）
  if (ev.target.matches && ev.target.matches('[data-role="session-preset-select"]')) {
    const detailTr = ev.target.closest('tr.detail-row');
    const repo = state.repos.find((entry) => entry.path === detailTr.dataset.detail);
    const cached = repo ? developmentSessionCache.get(developmentSessionKey(repo)) : null;
    const preset = cached && Array.isArray(cached.availablePresets)
      ? cached.availablePresets.find((entry) => entry.id === ev.target.value)
      : null;
    const previewList = detailTr.querySelector('[data-role="session-preset-preview-list"]');
    if (previewList) previewList.innerHTML = developmentSessionPresetItemsPreviewInnerHtml(preset);
  }
});

document.querySelector('#repo-table thead').addEventListener('click', (ev) => {
  const th = ev.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  if (sortKey === key) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey = key;
    // 日付・変更数は新しい/多い順、それ以外は昇順を初期方向にする
    sortDir = key === 'commitDate' || key === 'changeCount' ? 'desc' : 'asc';
  }
  saveViewState();
  renderTable();
});

for (const [id, key] of [
  ['filter-git', 'git'],
  ['filter-progress', 'progress'],
  ['filter-remote', 'remote'],
]) {
  document.getElementById(id).addEventListener('change', (ev) => {
    filters[key] = ev.target.value;
    preset = null; // 手動でフィルタを触ったら複合プリセットは解除
    saveViewState();
    renderTable();
  });
}

// target系（複数選択・テキスト）は範囲の切り替えなのでプリセットは維持する。
// status（複数選択）は他の単一select同様、手動変更で複合プリセットを解除する
document.querySelector('[data-role="target-checks"]').addEventListener('change', (ev) => {
  if (ev.target.type !== 'checkbox') return;
  const val = ev.target.value;
  if (ev.target.checked) {
    if (!filters.targets.includes(val)) filters.targets.push(val);
  } else {
    filters.targets = filters.targets.filter((t) => t !== val);
  }
  updateMsToggleLabel('target');
  saveViewState();
  renderTable();
});

document.querySelector('[data-role="target-text"]').addEventListener('input', (ev) => {
  filters.targetText = ev.target.value;
  updateMsToggleLabel('target');
  saveViewState();
  renderTable();
});

document.querySelector('[data-role="status-checks"]').addEventListener('change', (ev) => {
  if (ev.target.type !== 'checkbox') return;
  const val = ev.target.value;
  if (ev.target.checked) {
    if (!filters.statuses.includes(val)) filters.statuses.push(val);
  } else {
    filters.statuses = filters.statuses.filter((s) => s !== val);
  }
  preset = null; // 手動でフィルタを触ったら複合プリセットは解除
  updateMsToggleLabel('status');
  saveViewState();
  renderTable();
});

// ms-toggle ボタンで開閉、外側クリックで閉じる（同時に開くのは1つだけ）
document.addEventListener('click', (ev) => {
  const toggle = ev.target.closest('[data-role="ms-toggle"]');
  if (toggle) {
    const kind = toggle.dataset.ms;
    const panel = document.querySelector(`[data-role="ms-panel"][data-ms="${kind}"]`);
    const wasHidden = panel.hidden;
    document.querySelectorAll('[data-role="ms-panel"]').forEach((p) => { p.hidden = true; });
    panel.hidden = !wasHidden;
    return;
  }
  if (!ev.target.closest('.ms-filter')) {
    document.querySelectorAll('[data-role="ms-panel"]').forEach((p) => { p.hidden = true; });
  }
});

document.querySelector('.toolbar').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-preset]');
  if (!btn || !PRESETS.includes(btn.dataset.preset)) return;
  applyPreset(btn.dataset.preset);
});

document.getElementById('project-search').addEventListener('input', (ev) => {
  filters.projectText = ev.target.value;
  saveViewState();
  renderTable();
});

// Scan history: 開いたときに取得して表示（閉じている間は何もしない）
async function loadScanHistory() {
  const body = document.getElementById('scan-history-body');
  body.textContent = '読み込み中...';
  try {
    const h = await api('/api/scan-history');
    const stats = (h.summary && h.summary.targetStats) || [];
    if (stats.length === 0) {
      body.textContent = '履歴がまだありません';
      return;
    }
    body.innerHTML = stats
      .map((s) => {
        if (s.sampleCount === 0) {
          return `<div class="sh-row"><span class="sh-label">${esc(s.targetLabel)}</span>: disabledのみ（${s.disabledCount}件）</div>`;
        }
        let line =
          `last ${esc(fmtMs(s.lastDurationMs))} / avg ${esc(fmtMs(s.avgDurationMs))}` +
          ` / min ${esc(fmtMs(s.minDurationMs))} / max ${esc(fmtMs(s.maxDurationMs))}`;
        if (s.maxReaddirMs != null && s.maxReaddirMs >= 500) {
          line += ` / max readdir ${esc(fmtMs(s.maxReaddirMs))}`;
        }
        const slowN = (s.slowCount || 0) + (s.verySlowCount || 0);
        if (slowN > 0) line += ` / <span class="sh-slow">slow ${slowN}/${s.sampleCount}</span>`;
        line += ` / samples ${s.sampleCount}`;
        return `<div class="sh-row"><span class="sh-label">${esc(s.targetLabel)}</span>: ${line}</div>`;
      })
      .join('');
  } catch (e) {
    body.textContent = '履歴の読み込みに失敗: ' + e.message;
  }
}

document.getElementById('scan-history').addEventListener('toggle', (ev) => {
  if (ev.target.open) loadScanHistory();
});

document.getElementById('rescan-btn').addEventListener('click', () => load(true));

// Copy project signals: 全projectを横断した課題・進捗・再利用候補の素材を
// Markdownとしてクリップボードにコピーするだけの機能（アイデア生成・AI API
// 呼び出し・外部送信は行わない）。1repoの再開用の Copy AI Handoff とは別用途。
// 結果通知は既存の rescan-btn と同じ「ボタン自身のテキストを一時的に変える」
// 方式を再利用する（ヘッダーに新しい行・要素を増やさないため）
const SIGNALS_BTN_LABEL = 'Copy project signals';
document.getElementById('signals-btn').addEventListener('click', (ev) => {
  const btn = ev.currentTarget;
  const markdown = buildProjectSignalsMarkdown(state.repos, new Date().toISOString());
  copyToClipboard(markdown).then((ok) => {
    btn.textContent = ok ? 'Copied.' : 'Copy failed.';
    clearTimeout(btn._signalsResetTimer);
    btn._signalsResetTimer = setTimeout(() => {
      btn.textContent = SIGNALS_BTN_LABEL;
    }, 1600);
  });
});

// Action Queue: 「すべて表示」トグルと、行クリック/Enter/Space で既存の詳細ペインへ移動。
document.getElementById('action-queue').addEventListener('click', (ev) => {
  const toggle = ev.target.closest('[data-role="aq-toggle"]');
  if (toggle) {
    actionQueueExpanded = !actionQueueExpanded;
    renderActionQueue();
    return;
  }
  const row = ev.target.closest('.aq-row');
  if (row && row.dataset.path) focusRepoFromActionQueue(row.dataset.path);
});
document.getElementById('action-queue').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const row = ev.target.closest('.aq-row');
  if (!row || !row.dataset.path) return;
  ev.preventDefault();
  focusRepoFromActionQueue(row.dataset.path);
});

function syncResponsiveDisclosures() {
  if (!window.matchMedia) return;
  const mobile = window.matchMedia('(max-width: 800px)').matches;
  // scan-details（Scanner health）の開閉は render() が scan error の有無で決める。
  // ここでは advanced-filters（フィルターUI）だけを画面幅へ追従させる。
  document.getElementById('advanced-filters').open = !mobile;
}

if (window.matchMedia) {
  const responsiveMedia = window.matchMedia('(max-width: 800px)');
  responsiveMedia.addEventListener('change', syncResponsiveDisclosures);
  syncResponsiveDisclosures();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((e) => {
      console.warn('service worker registration failed:', e.message || e);
    });
  });
}

loadViewState();
loadHandoffPurpose();
syncFilterControls();
load(false);
