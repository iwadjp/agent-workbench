'use strict';

// Action Queue（Increment 1）の派生ロジック。
// repo scanner（一覧テーブル）とは分離した「次に何を進めるべきか」を短時間で
// 判断するためのビュー用に、運用 State（ACTION / OBSERVE / WAIT）と表示項目を算出する。
//
// resume-summary.js / project-signals.js と同じ方針で、DOM・fetch・ネットワーク・
// AI API 呼び出し・外部送信・永続化は一切行わない純粋関数のみを置く。入力は
// /api/projects が返すマージ済み repo オブジェクト（scan 結果 + manual status/note +
// agent context）だけ。
//
// このファイルはブラウザ（classic script。index.html で resume-summary.js /
// project-signals.js の後・app.js より前に読み込む）と Node（単体テスト:
// test/action-queue.test.js）の両方から使う。
//
// Increment 1 の設計制約（README「Action Queue」参照）:
//  1. Why now / priority には「今動く理由」だけを使う。scan error / no remote /
//     long stale 等の scanner 情報は使わない（それらは Scanner health / 詳細診断側）。
//  2. idleDays を priority の主要因にしない（同順位内の補助 tie-breaker のみ）。
//  3. dogfooding は原則 OBSERVE。next action に「実装 / fix / 修正 / 対応 / 検証実施」
//     等の具体的作業が明示されている場合のみ ACTION へ昇格する。
//  4. released は原則 Action Queue 外。note / agent context / PROGRESS に
//     レビュー待ち・F-Droid待ち・store審査待ち・公開後観測・外部イベント待ち等が
//     明示されている場合のみ WAIT または OBSERVE とする。
//  5. KEEP / IMPROVE / EXPAND / RETIRE は State にしない（portfolio 評価結果であり
//     運用 State とは分離する）。
//  6. 新しい manual status / schema / 手入力を増やさない。既存データからの派生のみ。
//  7. Next date は「次回確認日: 2026-09-08」のような明示ラベル付き日付だけを抽出する。
//     散文中の任意日付は拾わない。誤検出より未表示（null）を優先する。
//  8. GitHub 等の外部シグナル取得はしない。
//  9. scan error だけを理由に Action Queue へ昇格させない。WSL ECONNRESET /
//     ETIMEDOUT 等は Scanner health の担当。scan 不能 repo で manual status だけ
//     取得できている場合は Waiting へ「参考」表示し、priority には影響させない。

// classic script はページ全体で 1 つのグローバル字句スコープを共有するため、
// トップレベルの `const`/`let` 名が他ファイル（例: project-signals.js の
// `_buildResumeItems`）と衝突すると SyntaxError でファイル全体が実行されず、
// ブラウザで Action Queue が丸ごと出なくなる。IIFE で内部スコープを閉じ、
// 公開シンボルだけをグローバル（またはCommonJS module.exports）へ明示的に出す。
(function (root) {
const _resumeSummaryMod = (typeof require !== 'undefined')
  ? require('./resume-summary.js')
  : { buildResumeItems: (root && typeof root.buildResumeItems !== 'undefined' ? root.buildResumeItems : null) };
const _buildResumeItems = _resumeSummaryMod.buildResumeItems;

// dogfooding / active / unknown の next action にこれらが含まれる場合だけ
// OBSERVE ではなく ACTION へ昇格する（制約 3）。
// 「検証待ち」「dogfooding待ち」「実機確認待ち」のような受動的な観測語は含めない。
const CONCRETE_WORK_RE =
  /実装する|実装完了|fix\b|バグ|不具合|修正する|修正が必要|要修正|対応する|対応が必要|要対応|検証を?実施|リファクタ|作り直|書き直|追加実装|再実装/i;

// released / paused 等で「外部の何かを待っている」ことが明示されている場合に拾う語。
// 散文中の任意日付は拾わない（制約 7）。ここではキーワードのみ。
// 判定は配列の先頭から順に行い、最初に一致したものを採用する。
const WAIT_REASON_PATTERNS = [
  { key: 'fdroid', label: 'F-Droid待ち', re: /f-?droid/i },
  {
    key: 'store-review',
    label: 'ストア審査待ち',
    re: /ストア審査|store\s*review|play\s*store[^\n]{0,12}(審査|review)|app\s*store[^\n]{0,12}review|審査待ち|審査中|審査提出|審査結果待ち/i,
  },
  {
    key: 'review',
    label: 'レビュー待ち',
    re: /レビュー待ち|レビュー中|review\s*待ち|査読待ち|pr\s*レビュー|コードレビュー待ち|マージレビュー待ち/i,
  },
  {
    key: 'post-release-observe',
    label: '公開後観測',
    re: /公開後[^\n]{0,4}観測|リリース後[^\n]{0,4}観測|post-?release[^\n]{0,16}observ|公開後[^\n]{0,4}(反応|様子)を?(見|観)/i,
  },
  {
    key: 'external-event',
    label: '外部イベント待ち',
    re: /外部イベント待ち|イベント待ち|正式リリース後|リリース後[^\n]{0,4}再確認|マージ待ち|merge\s*待ち|承認待ち|回答待ち|返信待ち|先方[^\n]{0,4}待ち|反映待ち|公開判断待ち/i,
  },
];

// Next date の明示ラベル。ラベル + 区切り(: ： =) + ISO 風日付 のみ許可する（制約 7）。
// 「latest commit ... (2026-07-07)」「v0.5.35」「wp70-rc3」等は一致しない。
const NEXT_DATE_RE =
  /(次回確認日|次回確認|次回観測日|次回観測|次回レビュー日|次回レビュー|再確認日|確認予定日|観測予定日|next\s*review|next\s*check|next\s*observation|review\s*date|check\s*date)\s*[:：=]\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})/i;

// Human gate を示す語（next action / 既知の制約 のテキストに対して）。
const HUMAN_GATE_RE =
  /実機|手動で|手動確認|ユーザーが|ユーザー確認|人手|人間が|承認|apply\b|インストール|install\b|審査|公開判断|リリース判断|マージ判断|要判断|手作業/i;

// priority の値が小さいほど上位。前向きな運用 State を中心にする（制約 2）。
//   ACTION + Human gate > ACTION > 期限到来した OBSERVE > OBSERVE > WAIT
// SCAN_UNAVAILABLE は最下位（scanner failure を portfolio priority にしないため）。
const PRIORITY = {
  ACTION_HUMAN: 10,
  ACTION: 20,
  OBSERVE_DUE: 30,
  OBSERVE: 40,
  WAIT: 50,
  SCAN_UNAVAILABLE: 90,
};

// 既定の Action Queue 表示件数（超過分は「すべて表示」で展開する）。
const DEFAULT_QUEUE_LIMIT = 10;

function _text(v) {
  return String(v == null ? '' : v);
}

// resume-summary.js の抽出結果（定型見出しの完全一致のみ）を key -> text の形で返す。
function resumeItemsFor(repo) {
  if (!_buildResumeItems) return {};
  const items = _buildResumeItems({
    contextMarkdown: repo.agentContextMarkdown || '',
    progressTail: repo.hasProgress ? (repo.progressTail || '') : '',
  });
  const byKey = {};
  for (const it of items) byKey[it.key] = it.text;
  return byKey;
}

// 放置日数。app.js / project-signals.js の idleDays() と同じ暦日ベースの計算。
// priority の主要因ではなく、同順位内の補助 tie-breaker としてのみ使う（制約 2）。
function idleDaysOf(repo) {
  if (!repo || !repo.commit || !repo.commit.date) return null;
  const d = new Date(repo.commit.date);
  if (isNaN(d)) return null;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  return Math.max(0, Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000));
}

function isScanUnavailable(repo) {
  return (
    repo.kind === 'error' ||
    repo.kind === 'missing' ||
    repo.gitStatus === 'error' ||
    !!repo.error
  );
}

// 運用見出し（Increment 2）。normalize 後の完全一致のみ拾う。
const NEXT_REVIEW_HEADINGS = [
  '次回確認日', '次回確認', '次回観測日', '次回観測',
  'next review', 'next check', 'next observation', 'review date',
];
const EXTERNAL_WAIT_HEADINGS = ['外部イベント待ち', 'external wait', 'external event wait'];
const EXTERNAL_SIGNAL_HEADINGS = ['外部シグナル', 'external signal', 'external signals'];
const ISO_DATE_ONLY_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

// Markdown（agentContextMarkdown）から `## <heading>` の本文（次の見出し行まで）を返す。
// 見出しは #〜###### のどれでもよく、normalize（trim + lowercase）後の完全一致のみ。
// 本文が空 / "(not set)" は '' 扱い。resume-summary.js の extractResumeSections と同方針。
function extractContextSection(md, aliases) {
  if (!md) return '';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
  const wanted = aliases.map((a) => a.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (!m) continue;
    if (!wanted.includes(m[2].trim().toLowerCase())) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (headingRe.test(lines[j])) break;
      body.push(lines[j]);
    }
    const t = body.join('\n').trim();
    return t === '(not set)' ? '' : t;
  }
  return '';
}

function _normDate(y, mo, d) {
  const M = Number(mo);
  const D = Number(d);
  if (!(M >= 1 && M <= 12) || !(D >= 1 && D <= 31)) return null;
  return `${y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
}

// Next date を 'YYYY-MM-DD' で返す。無ければ null（制約 7）。
// 受理するのは (1) 明示ラベル付きインライン（`次回確認日: 2026-09-08` 等）、
// (2) `## 次回確認日` 見出しの直後の非空行が単一 ISO 日付、の2形式のみ。
// 抽出元は呼び出し側で agentContextMarkdown / note に限定する。PROGRESS.md の
// 自由文からは絶対に拾わない。曖昧・複数トークン・時刻・範囲は null。
function extractNextDate(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const raw of list) {
    if (!raw) continue;
    const s = _text(raw);
    // (1) インライン: ラベル + 区切り + 日付
    const m = s.match(NEXT_DATE_RE);
    if (m) {
      const d = _normDate(m[2], m[3], m[4]);
      if (d) return d;
    }
    // (2) 見出し形式: `## 次回確認日` の本文の先頭非空行が単一 ISO 日付ちょうど
    const body = extractContextSection(s, NEXT_REVIEW_HEADINGS);
    if (body) {
      const first = body.split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
      const im = first.match(ISO_DATE_ONLY_RE);
      if (im) {
        const d = _normDate(im[1], im[2], im[3]);
        if (d) return d;
      }
    }
  }
  return null;
}

// `## 外部イベント待ち` の本文（自由記述、1行に畳む）。無ければ ''。
function externalWaitText(repo) {
  const raw = extractContextSection(repo && repo.agentContextMarkdown, EXTERNAL_WAIT_HEADINGS);
  return raw ? raw.replace(/\s*\n\s*/g, ' ').trim() : '';
}

// `## 外部シグナル` の本文（自由記述、改行は保持）。無ければ ''。表示・handoff 用のみ。
function externalSignalText(repo) {
  return extractContextSection(repo && repo.agentContextMarkdown, EXTERNAL_SIGNAL_HEADINGS);
}

// 待ち理由（キーワードのみ）。先頭から順に一致を探し、最初のものを返す。無ければ null。
function detectWaitReason(texts) {
  const joined = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join('\n');
  if (!joined) return null;
  for (const p of WAIT_REASON_PATTERNS) {
    if (p.re.test(joined)) return { key: p.key, label: p.label };
  }
  return null;
}

// nextDate が今日以前（=期限到来）か。opts.today で基準日を差し替えられる（テスト用）。
function isDateDue(dateStr, today) {
  if (!dateStr) return false;
  const due = new Date(dateStr + 'T00:00:00');
  if (isNaN(due)) return false;
  const base = today instanceof Date ? today : new Date();
  const startOfToday = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  return due <= startOfToday;
}

function _pushMeta(result, humanGate, nextDate, nextDateDue) {
  if (humanGate && !result.whyNow.includes('Human gate')) result.whyNow.push('Human gate');
  if (nextDate) {
    result.whyNow.push(`次回確認日 ${nextDate}${nextDateDue ? '（到来）' : ''}`);
  }
}

// 1 repo の運用 State と表示項目を派生する（純粋関数）。
// 戻り値:
//   {
//     path, name, targetLabel, manualStatus,
//     state: 'ACTION' | 'OBSERVE' | 'WAIT' | null,   // KEEP/IMPROVE/EXPAND/RETIRE は使わない（制約 5）
//     section: 'queue' | 'waiting' | 'none',
//     now: string,            // 次にやること 1 行。無ければ ''（UI 側で「—」表示）
//     whyNow: string[],       // 「今動く理由」だけ。scanner 情報は含めない（制約 1）
//     nextDate: 'YYYY-MM-DD' | null,
//     nextDateDue: boolean,
//     humanGate: boolean,
//     scanUnavailable: boolean,
//     idleDays: number | null,   // tie-breaker 用の参考値（priority 主要因ではない）
//     priority: number           // 小さいほど上位
//   }
function deriveActionState(repo, opts) {
  const options = opts || {};
  const today = options.today instanceof Date ? options.today : new Date();
  const rs = resumeItemsFor(repo);
  const nextActionText = _text(rs.nextAction).trim();
  const constraintsText = _text(rs.knownConstraints).trim();
  const status = repo.manualStatus || 'unknown';

  // Next date は明示ラベル付き日付だけを、短い構造化フィールド（agent context / note）
  // からのみ抽出する。PROGRESS.md 末尾は長文の開発履歴・説明文で、`次回確認日:` の
  // ような文字列がドキュメント例として混入しやすく誤検出の温床になるため走査しない。
  // インライン形式に加え `## 次回確認日` 見出し形式も受理する（Increment 2）。
  const dateSources = [
    repo.agentContextMarkdown || '',
    repo.note || '',
  ];
  const nextDate = extractNextDate(dateSources);
  const nextDateDue = isDateDue(nextDate, today);

  // 運用見出し（Increment 2）。AI operator が Agent context の薄い運用情報として書く。
  const externalWait = externalWaitText(repo);
  const externalSignal = externalSignalText(repo);
  const hasSavedContext = !!(repo.agentContextMarkdown && repo.agentContextMarkdown.trim());
  // repo を持たない portfolio item（portfolio target 配下等の no-git フォルダ）で、
  // 実際に運用情報を持っているものだけを Action Queue の通常派生へ流す。
  // 素の作業フォルダ（tmp / *-signing 等・context も status も無い）は none のまま。
  const isPortfolioItem =
    repo.kind === 'no-git' &&
    (hasSavedContext || status !== 'unknown' || !!nextDate || !!externalWait || !!nextActionText);

  const result = {
    path: repo.path,
    name: repo.name,
    targetLabel: repo.targetLabel || '',
    manualStatus: status,
    state: null,
    section: 'none',
    now: '',
    whyNow: [],
    nextDate: nextDate,
    nextDateDue: nextDateDue,
    externalWait: externalWait || null,
    externalSignal: externalSignal || null,
    humanGate: false,
    scanUnavailable: false,
    isPortfolioItem: isPortfolioItem,
    idleDays: idleDaysOf(repo),
    priority: 999,
  };

  // --- scan 不能（Increment 2.1）---
  // scanner error / kind=error / gitStatus=error は「補助情報」であり、それ自体を
  // 理由に Now / Watching / Waiting の section を変えない。portfolio 分類は既存の
  // manual status / agent context / operational headings から通常どおり導出する。
  // git 状態が取れないので dirty / ahead / diverged は「推測しない」（下の判定は
  // 明示値のみを見るため、scan-error repo では自然に false になるが、意図を明示する）。
  const scanUnavailable = isScanUnavailable(repo);
  result.scanUnavailable = scanUnavailable;
  // scan 不能な状態は Scanner health 側の担当。ここでは何もしない（早期 return しない）。

  // --- Action Queue 対象外の lifecycle ---
  if (status === 'abandoned') return result;

  const gitDirty = !scanUnavailable && repo.gitStatus === 'dirty';
  const remoteAhead =
    !scanUnavailable &&
    !!(
      repo.remote &&
      repo.remote.enabled &&
      (repo.remote.status === 'ahead' || repo.remote.status === 'diverged')
    );
  const humanGate =
    gitDirty ||
    remoteAhead ||
    HUMAN_GATE_RE.test(nextActionText + '\n' + constraintsText);
  result.humanGate = humanGate;

  // --- 明示された「外部イベント待ち」（`## 外部イベント待ち` 見出し）=> Waiting（Increment 2）---
  // manual status（active / dogfooding / released / unknown / paused）に関わらず Waiting へ。
  // AI operator が見出しまたは内容を削除すれば、次回以降は通常の派生ルールへ戻る。
  // PROGRESS 散文の「待ち」文字列は使わない（明示見出しのみ）。
  if (externalWait) {
    result.state = 'WAIT';
    result.section = 'waiting';
    result.now = nextActionText || externalWait;
    result.whyNow = [`外部イベント待ち: ${externalWait.slice(0, 60)}`];
    result.priority = PRIORITY.WAIT;
    _pushMeta(result, humanGate, nextDate, nextDateDue);
    return result;
  }

  // released 分岐の fallback 用。短い構造化フィールド（note / agent context）のみ走査し、
  // PROGRESS.md 自由文は見ない（Increment 1.1 / 2 の方針）。
  const waitReason = detectWaitReason([
    repo.note || '',
    repo.agentContextMarkdown || '',
  ]);

  // --- released: 原則 queue 外。待ち理由が明示されていれば WAIT / OBSERVE（制約 4）---
  if (status === 'released') {
    if (!waitReason) return result; // 完了扱い。Action Queue に出さない
    if (waitReason.key === 'post-release-observe') {
      result.state = 'OBSERVE';
      result.now = nextActionText || '公開後の反応・シグナルを観測する';
      result.whyNow = [waitReason.label];
      if (nextDate && !nextDateDue) {
        result.section = 'waiting'; // 将来日付 = scheduled
        result.priority = PRIORITY.WAIT;
      } else {
        result.section = 'queue';
        result.priority = nextDateDue ? PRIORITY.OBSERVE_DUE : PRIORITY.OBSERVE;
      }
    } else {
      result.state = 'WAIT';
      result.section = 'waiting';
      result.now = nextActionText || `${waitReason.label}。対応可能になったら次フェーズへ`;
      result.whyNow = [waitReason.label];
      result.priority = PRIORITY.WAIT;
    }
    _pushMeta(result, humanGate, nextDate, nextDateDue);
    return result;
  }

  // --- dirty / remote ahead => ACTION（最優先。Human gate 扱い）---
  if (gitDirty || remoteAhead) {
    result.state = 'ACTION';
    result.section = 'queue';
    result.whyNow = [];
    if (gitDirty) result.whyNow.push('dirty（commit / 破棄の判断）');
    if (remoteAhead) result.whyNow.push('remote ahead（push の判断）');
    result.now =
      nextActionText ||
      (gitDirty
        ? 'working tree の変更を確認して commit または破棄する'
        : 'ローカル commit の push 要否を確認する');
    result.humanGate = true;
    result.priority = PRIORITY.ACTION_HUMAN;
    _pushMeta(result, true, nextDate, nextDateDue);
    return result;
  }

  // --- paused => WAIT ---
  if (status === 'paused') {
    result.state = 'WAIT';
    result.section = 'waiting';
    result.now =
      nextActionText || (waitReason ? waitReason.label : '再開条件が満たされるまで保留');
    result.whyNow = waitReason ? [waitReason.label] : ['paused'];
    result.priority = PRIORITY.WAIT;
    _pushMeta(result, humanGate, nextDate, nextDateDue);
    return result;
  }

  // --- portfolio / no-git item（status unknown・運用情報あり）=> OBSERVE baseline（Increment 2）---
  // repo を持たない公開予定・観測予定・非repoサービス等。virtual だからといって
  // 自動 ACTION にはしない。Now は「次回確認日が到来した OBSERVE」経由でのみ。
  if (isPortfolioItem && status === 'unknown') {
    result.state = 'OBSERVE';
    result.now = nextActionText || '観測を継続する';
    if (nextDate && !nextDateDue) {
      result.section = 'waiting'; // 将来の確認日 = scheduled
      result.priority = PRIORITY.WAIT;
      result.whyNow = [`次回確認日 ${nextDate}`];
    } else if (nextDateDue) {
      result.section = 'queue';
      result.priority = PRIORITY.OBSERVE_DUE;
      result.whyNow = [`次回確認日 ${nextDate}（到来）`];
    } else {
      result.section = 'queue';
      result.priority = PRIORITY.OBSERVE;
      result.whyNow = ['観測中'];
    }
    if (humanGate && !result.whyNow.includes('Human gate')) result.whyNow.push('Human gate');
    return result;
  }

  // --- dogfooding => 原則 OBSERVE。具体的作業が明示されていれば ACTION（制約 3）---
  if (status === 'dogfooding') {
    const concrete = !!nextActionText && CONCRETE_WORK_RE.test(nextActionText);
    result.state = concrete ? 'ACTION' : 'OBSERVE';
    result.now = nextActionText || '実利用で不便・不整合が出ないか観測する';
    result.whyNow = concrete ? ['明示された具体的作業'] : ['dogfooding 観測中'];
    if (!concrete && nextActionText) result.whyNow.push('次アクションの記載あり');
    if (result.state === 'OBSERVE' && nextDate && !nextDateDue) {
      result.section = 'waiting'; // 将来日付 = scheduled
      result.priority = PRIORITY.WAIT;
    } else {
      result.section = 'queue';
      result.priority =
        result.state === 'ACTION'
          ? humanGate
            ? PRIORITY.ACTION_HUMAN
            : PRIORITY.ACTION
          : nextDateDue
          ? PRIORITY.OBSERVE_DUE
          : PRIORITY.OBSERVE;
    }
    _pushMeta(result, humanGate, nextDate, nextDateDue);
    return result;
  }

  // --- active => 次アクションがあれば ACTION、なければ OBSERVE ---
  if (status === 'active') {
    if (nextActionText) {
      const concrete = CONCRETE_WORK_RE.test(nextActionText);
      result.state = 'ACTION';
      result.section = 'queue';
      result.now = nextActionText;
      result.whyNow = [concrete ? '明示された具体的作業' : '明示された次アクション'];
      result.priority = humanGate ? PRIORITY.ACTION_HUMAN : PRIORITY.ACTION;
    } else {
      result.state = 'OBSERVE';
      result.now = 'active だが次アクション未記載。現状を確認して次を決める';
      result.whyNow = ['active・次アクション未記載'];
      if (nextDate && !nextDateDue) {
        result.section = 'waiting';
        result.priority = PRIORITY.WAIT;
      } else {
        result.section = 'queue';
        result.priority = nextDateDue ? PRIORITY.OBSERVE_DUE : PRIORITY.OBSERVE;
      }
    }
    _pushMeta(result, humanGate, nextDate, nextDateDue);
    return result;
  }

  // --- unknown status: 具体的な作業が明示されている時だけ ACTION として拾う ---
  if (status === 'unknown') {
    if (nextActionText && CONCRETE_WORK_RE.test(nextActionText)) {
      result.state = 'ACTION';
      result.section = 'queue';
      result.now = nextActionText;
      result.whyNow = ['明示された具体的作業'];
      result.priority = humanGate ? PRIORITY.ACTION_HUMAN : PRIORITY.ACTION;
      _pushMeta(result, humanGate, nextDate, nextDateDue);
    }
    return result;
  }

  return result;
}

// 同順位内の並び: nextDate 早い順 → idleDays 大きい順（補助的 tie-breaker のみ） → name。
function _compareDerived(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.nextDate && b.nextDate && a.nextDate !== b.nextDate) {
    return a.nextDate < b.nextDate ? -1 : 1;
  }
  if (a.nextDate && !b.nextDate) return -1;
  if (!a.nextDate && b.nextDate) return 1;
  const ai = a.idleDays == null ? -1 : a.idleDays;
  const bi = b.idleDays == null ? -1 : b.idleDays;
  if (ai !== bi) return bi - ai;
  return _text(a.name).localeCompare(_text(b.name), 'ja');
}

// 「今やる（Now）」に入る条件（Increment 1.1）:
//   state === 'ACTION'  または  state === 'OBSERVE' かつ nextDateDue（確認日が到来）
// State enum は増やさない。section === 'queue' の中を Now / Watching へ再グループするだけ。
function isNowItem(d) {
  return d.state === 'ACTION' || (d.state === 'OBSERVE' && d.nextDateDue === true);
}

// repo 配列から Now / Watching / Waiting のリストと件数を組み立てる（純粋関数）。
// toolbar のフィルタとは独立に、渡された repo をそのまま評価する。
//   Now      : 今日動くもの（ACTION / 期限到来した OBSERVE）
//   Watching : queue の残りの OBSERVE（dogfooding 観測中 / active だが具体的作業未定義 等）
//   Waiting  : paused / 将来の確認日 / 外部イベント待ち / block（section === 'waiting'）
function buildActionQueue(repos, opts) {
  const derived = (Array.isArray(repos) ? repos : []).map((r) => deriveActionState(r, opts || {}));
  const inQueue = derived.filter((d) => d.section === 'queue').sort(_compareDerived);
  const waiting = derived.filter((d) => d.section === 'waiting').sort(_compareDerived);
  const now = inQueue.filter(isNowItem);
  const watching = inQueue.filter((d) => !isNowItem(d));
  return {
    now,
    watching,
    waiting,
    // 後方互換: 旧 `queue` は now + watching（priority 順は従来どおり _compareDerived）
    queue: inQueue,
    counts: {
      total: derived.length,
      now: now.length,
      watching: watching.length,
      waiting: waiting.length,
      queue: inQueue.length,
      action: now.filter((d) => d.state === 'ACTION').length,
      observe: inQueue.filter((d) => d.state === 'OBSERVE').length,
    },
  };
}

// 既定は上位 limit 件だけ表示し、超過分は「すべて表示」で展開する（制約: 既定 10 件）。
function pageActionQueue(items, expanded, limit) {
  const lim = typeof limit === 'number' && limit > 0 ? limit : DEFAULT_QUEUE_LIMIT;
  const list = Array.isArray(items) ? items.slice() : [];
  if (expanded || list.length <= lim) {
    return { shown: list, hiddenCount: 0, hasMore: false };
  }
  return { shown: list.slice(0, lim), hiddenCount: list.length - lim, hasMore: true };
}

const _publicApi = {
  deriveActionState,
  buildActionQueue,
  isNowItem,
  pageActionQueue,
  extractNextDate,
  extractContextSection,
  externalWaitText,
  externalSignalText,
  detectWaitReason,
  isDateDue,
  idleDaysOf,
  CONCRETE_WORK_RE,
  WAIT_REASON_PATTERNS,
  NEXT_DATE_RE,
  NEXT_REVIEW_HEADINGS,
  EXTERNAL_WAIT_HEADINGS,
  EXTERNAL_SIGNAL_HEADINGS,
  PRIORITY,
  DEFAULT_QUEUE_LIMIT,
};

if (typeof module !== 'undefined' && module.exports) {
  // Node（単体テスト）
  module.exports = _publicApi;
} else if (root) {
  // ブラウザ（classic script）: app.js が参照するシンボルだけをグローバルへ出す。
  root.deriveActionState = deriveActionState;
  root.buildActionQueue = buildActionQueue;
  root.pageActionQueue = pageActionQueue;
  root.extractNextDate = extractNextDate;
  root.externalWaitText = externalWaitText;
  root.externalSignalText = externalSignalText;
}
})(typeof globalThis !== 'undefined' ? globalThis : this);
