'use strict';

// 再開サマリー（Resume summary）の抽出・整形ロジック。
// 開発再開時に最初に確認する要点（現在地/最後の作業/次に行うこと/既知の制約/再開方法）を、
// Agent context Markdown・PROGRESS.md末尾抜粋の「定型見出しの完全一致」だけで抽出する。
// 自由文章の自動要約・キーワード検索による推測は行わない（明示的に書かれた内容のみ表示する）。
//
// このファイルはブラウザ（クラシックscriptとしてapp.jsより先に読み込む）と
// Node（単体テスト: test/resume-summary.test.js）の両方から使う。
// DOM・fetch等には依存しない純粋関数のみを置く。

// 各項目の定型見出し。normalizeHeading() 後の完全一致のみ拾う。
// 日本語見出しが正。英語エイリアスは、既存の Agent context 実データ
// （Phase 5-E標準形式・dogfoodingで実際に使われた見出し）に限定して認める。
const RESUME_SECTIONS = [
  {
    key: 'currentState',
    label: '現在地',
    headings: ['現在地', 'current state', 'current focus'],
  },
  {
    // labelは「保存時の最後の作業」（見出し検索対象は従来どおり「最後の作業」等）。
    // 現在のlatest commitと混同されないよう、保存済みノートであることを明示する
    key: 'lastWork',
    label: '保存時の最後の作業',
    headings: ['最後の作業', 'last work', 'last handoff notes'],
  },
  {
    key: 'nextAction',
    label: '次に行うこと',
    headings: ['次に行うこと', 'next action', 'next actions'],
  },
  {
    key: 'knownConstraints',
    label: '既知の制約',
    headings: ['既知の制約', 'known constraints', 'important constraints', 'blockers / notes', 'blockers/notes'],
  },
  {
    key: 'resumeSteps',
    label: '再開方法',
    headings: ['再開方法', '開発再開手順', 'resume steps', 'development re-entry'],
  },
];

// 1項目あたりの最大表示文字数（非常に長い文章が画面を占有しないようにする）
const RESUME_ITEM_MAX_CHARS = 400;

// 見出しテキストの正規化: 前後trim・小文字化・連続空白を1つに
function normalizeHeading(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function clipResumeText(s, n) {
  const t = String(s == null ? '' : s).trim();
  const max = typeof n === 'number' ? n : RESUME_ITEM_MAX_CHARS;
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

// Markdownテキストから、定型見出し（#〜####・完全一致）のセクション本文を抽出する。
// 本文は「次の見出し行（レベル問わず）まで」。空本文・"(not set)" は欠落扱い。
// 戻り値: { currentState?: string, lastWork?: string, ... }（見つかった項目のみ）
function extractResumeSections(text) {
  const result = {};
  if (!text) return result;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const headingRe = /^(#{1,4})\s+(.+?)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (!m) continue;
    const normalized = normalizeHeading(m[2]);
    const def = RESUME_SECTIONS.find((d) => d.headings.includes(normalized));
    if (!def || result[def.key] !== undefined) continue; // 最初の一致のみ採用
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (headingRe.test(lines[j])) break;
      body.push(lines[j]);
    }
    const bodyText = body.join('\n').trim();
    if (!bodyText || bodyText === '(not set)') continue; // 空・未設定は欠落扱い
    result[def.key] = bodyText;
  }
  return result;
}

// 再開サマリーの「保存された作業コンテキスト」表示項目を組み立てる。優先順位:
//   1. Agent context Markdown の定型見出し
//   2. PROGRESS.md 末尾抜粋の定型見出し
// 記載が無い項目は返さない（推測による文章生成はしない）。
// 現在のlive HEAD情報はここでは扱わない（呼び出し側が別枠の「現在のrepo」として
// 常に表示する。以前あった「最後の作業」への最新コミットfallbackは廃止した。
// 廃止理由: 保存済みノートが古いcommit参照を含む場合、fallback文言と保存済み文言が
// 同じ「最後の作業」見出しの下で区別できず、現在のHEADと誤認されていたため
// （例: 保存済み "latest commit: 73daf10 ..." を現在の最新コミットと取り違える）
// input: { contextMarkdown, progressTail }
// 戻り値: [{ key, label, text, source: 'context'|'progress' }]（RESUME_SECTIONS の順）
function buildResumeItems(input) {
  const inp = input || {};
  const fromContext = extractResumeSections(inp.contextMarkdown);
  const fromProgress = extractResumeSections(inp.progressTail);
  const items = [];
  for (const def of RESUME_SECTIONS) {
    let text;
    let source;
    if (fromContext[def.key] !== undefined) {
      text = fromContext[def.key];
      source = 'context';
    } else if (fromProgress[def.key] !== undefined) {
      text = fromProgress[def.key];
      source = 'progress';
    }
    if (text === undefined) continue;
    items.push({ key: def.key, label: def.label, text: clipResumeText(text), source });
  }
  return items;
}

// 表示用HTML（<dl>のみ。外側のカード・見出しは呼び出し側が付ける）。
// 本文は必ずescapeし、改行はCSSのpre-wrapで表示する（Markdown見出しの巨大表示はしない）
function escapeResumeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderResumeItemsHtml(items) {
  if (!items || items.length === 0) return '';
  return `<dl class="resume-list">${items
    .map((it) => `<dt>${escapeResumeHtml(it.label)}</dt><dd>${escapeResumeHtml(it.text)}</dd>`)
    .join('')}</dl>`;
}

// Node（単体テスト）から require できるようにする。ブラウザではトップレベルの
// const/function がそのままグローバルになり、app.js から参照される
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RESUME_SECTIONS,
    RESUME_ITEM_MAX_CHARS,
    normalizeHeading,
    clipResumeText,
    extractResumeSections,
    buildResumeItems,
    renderResumeItemsHtml,
  };
}
