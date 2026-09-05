'use strict';

// Copy project signals: 全プロジェクト横断でAI分析用に渡すMarkdownを組み立てる
// 純粋関数群。resume-summary.js と同じ方針で、DOM・fetch・アイデア生成・AI API
// 呼び出し・外部送信は一切行わない。既存のscan結果（state.repos）を整形して
// Markdown文字列を返すだけ。
//
// このファイルはブラウザ（classic script。index.html で resume-summary.js の
// 次・app.js より前に読み込む）と Node（単体テスト: test/project-signals.test.js）
// の両方から使う。

const _resumeSummary = (typeof require !== 'undefined')
  ? require('./resume-summary.js')
  : { buildResumeItems: typeof buildResumeItems !== 'undefined' ? buildResumeItems : null };
const _buildResumeItems = _resumeSummary.buildResumeItems;

// action-queue.js の運用見出しパーサを遅延解決する。ブラウザでは project-signals.js が
// action-queue.js より先に読み込まれるため、参照は呼び出し時（globalThis 経由）に行う。
// Node（テスト）では require で解決する。存在しなければ null を返し、機能は素通りする。
function _aqFn(name) {
  if (typeof require !== 'undefined') {
    try {
      return require('./action-queue.js')[name] || null;
    } catch (e) {
      return null;
    }
  }
  return (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function')
    ? globalThis[name]
    : null;
}

// 放置日数。app.js の idleDays() と同じ計算（暦日ベース）を独立実装する。
// project-signals.js は app.js に依存しないための重複であり、新しい判定基準の
// 追加ではない（閾値も idleClass() と同じ 7日 / 30日をそのまま使う）
function signalsIdleDays(r) {
  if (!r.commit || !r.commit.date) return null;
  const d = new Date(r.commit.date);
  if (isNaN(d)) return null;
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = startOfDay(new Date()) - startOfDay(d);
  return Math.max(0, Math.round(diff / 86400000));
}

function signalsIdleLabel(days) {
  if (days == null) return 'unknown';
  if (days === 0) return 'today';
  return `${days} days`;
}

function signalsIdleBucket(days) {
  if (days == null) return 'unknown';
  if (days >= 30) return 'long-stale';
  if (days >= 7) return 'stale';
  return 'fresh';
}

function fmtSignalsDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function singleLine(s) {
  return String(s == null ? '' : s).replace(/\r\n|\r|\n/g, ' ').trim();
}

// buildHandoffMarkdown() と同じ考え方の working tree 表示（kind別）
function workingTreeText(r) {
  if (r.kind === 'missing') return 'missing (path not found)';
  if (r.kind === 'no-git') return 'no-git';
  if (!r.gitStatus) return 'unknown';
  return `${r.gitStatus} (modified: ${r.modifiedCount || 0}, untracked: ${r.untrackedCount || 0})`;
}

// remote status有効なtargetのみ表示する。無効targetは「未確認」であり
// 「no-remote」と混同しないよう null（=行自体を省略）にする
function remoteText(r) {
  const rm = r.remote;
  if (!rm || !rm.enabled) return null;
  if (rm.status === 'no-remote') return 'no-remote';
  if (rm.status === 'no-upstream') return 'no-upstream';
  return rm.status || 'unknown';
}

function contextFreshnessText(freshness) {
  if (freshness === 'current') return 'current';
  if (freshness === 'stale') return 'stale';
  return 'unknown';
}

function resumeItemsByKey(r) {
  if (!_buildResumeItems) return {};
  const items = _buildResumeItems({
    contextMarkdown: r.agentContextMarkdown,
    progressTail: r.progressTail,
  });
  const byKey = {};
  for (const it of items) byKey[it.key] = it;
  return byKey;
}

// ---- Portfolio summary -----------------------------------------------------

function countBy(repos, keyFn) {
  const counts = {};
  for (const r of repos) {
    const k = keyFn(r);
    if (k == null) continue;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function formatCounts(counts, order) {
  const keys = order ? order.filter((k) => counts[k]) : Object.keys(counts).sort();
  return keys.map((k) => `${k} ${counts[k]}`).join(' / ');
}

function buildPortfolioSummaryLines(repos) {
  const lines = [];
  lines.push(`- project count: ${repos.length}`);
  lines.push(`- by target: ${formatCounts(countBy(repos, (r) => r.targetLabel || '(unknown target)')) || '(none)'}`);
  lines.push(`- by status: ${formatCounts(
    countBy(repos, (r) => r.manualStatus || 'unknown'),
    ['active', 'dogfooding', 'paused', 'abandoned', 'released', 'unknown']
  ) || '(none)'}`);
  lines.push(`- git status: ${formatCounts(
    countBy(repos, (r) => r.gitStatus || 'unknown'),
    ['clean', 'dirty', 'untracked-only', 'no-git', 'error']
  ) || '(none)'}`);
  lines.push(`- stale: ${formatCounts(
    countBy(repos, (r) => signalsIdleBucket(signalsIdleDays(r))),
    ['fresh', 'stale', 'long-stale', 'unknown']
  ) || '(none)'}`);
  const remoteEnabled = repos.filter((r) => r.remote && r.remote.enabled).length;
  lines.push(`- remote tracking enabled / disabled: ${remoteEnabled} / ${repos.length - remoteEnabled}`);
  const withContext = repos.filter((r) => !!r.savedContext).length;
  lines.push(`- Agent context saved / not saved: ${withContext} / ${repos.length - withContext}`);
  const withProgress = repos.filter((r) => r.hasProgress).length;
  lines.push(`- PROGRESS.md present / absent: ${withProgress} / ${repos.length - withProgress}`);
  return lines;
}

// ---- Attention signals ------------------------------------------------------

// 機械的に判定できるものだけを列挙する。既存の判定ロジック（idleClass()の閾値、
// matchesRemoteFilter()のno-remote判定、savedContext.freshness、
// buildResumeItems()の見出し抽出）をそのまま再利用し、新しい推測ロジックは
// 追加しない。PROGRESS.mdの「直近記録が古い」はmtimeだけでは根拠不十分として
// 既存実装でも見送られているため、ここでも対象にしない
function attentionFlags(r) {
  const flags = [];
  if (r.error) flags.push('scan error');
  if (r.gitStatus === 'dirty') flags.push('dirty');
  const days = signalsIdleDays(r);
  if (days != null && days >= 30) flags.push('long stale');
  if (r.remote && r.remote.enabled && r.remote.status === 'no-remote') flags.push('no remote');
  if (r.savedContext && (r.savedContext.freshness === 'unknown' || r.savedContext.freshness === 'stale')) {
    flags.push(`agent context ${r.savedContext.freshness}`);
  }
  const byKey = resumeItemsByKey(r);
  if (byKey.knownConstraints) flags.push('blocker');
  if (byKey.nextAction) flags.push('next action');
  if (r.manualStatus === 'paused') flags.push('status: paused');
  return flags;
}

function buildAttentionSignalsLines(repos) {
  const withFlags = repos
    .map((r) => ({ r, flags: attentionFlags(r) }))
    .filter((x) => x.flags.length > 0);
  if (withFlags.length === 0) return ['(no attention signals)'];
  return withFlags.map(({ r, flags }) => `- ${r.name} (${r.targetLabel || '-'}): ${flags.join(', ')}`);
}

// ---- Projects ---------------------------------------------------------------

function buildProjectSection(r) {
  const lines = [];
  lines.push(`### ${r.name}`);
  lines.push('');
  lines.push(`- target: ${singleLine(r.targetLabel || '-')}`);
  lines.push(`- path: ${singleLine(r.path || '-')}`);
  lines.push(`- status: ${singleLine(r.manualStatus || 'unknown')}`);
  if (r.note && r.note.trim()) lines.push(`- note: ${singleLine(r.note)}`);
  if (r.branch) lines.push(`- branch: ${singleLine(r.branch)}`);
  lines.push(`- working tree: ${workingTreeText(r)}`);
  const remote = remoteText(r);
  if (remote) lines.push(`- remote: ${remote}`);
  if (r.commit) {
    const dateText = fmtSignalsDate(r.commit.date) || r.commit.date;
    lines.push(`- latest commit: ${r.commit.hash} ${singleLine(r.commit.message)} (${dateText})`);
  }
  const days = signalsIdleDays(r);
  if (days != null) lines.push(`- stale: ${signalsIdleLabel(days)}`);
  if (r.error) lines.push(`- scan status: error - ${singleLine(r.error)}`);
  const sc = r.savedContext;
  if (sc) {
    lines.push(`- saved context date: ${sc.savedAt ? fmtSignalsDate(sc.savedAt) : 'unknown'}`);
    const headText = sc.savedHeadHash
      ? `${sc.savedHeadHash}${sc.savedHeadSubject ? ' ' + singleLine(sc.savedHeadSubject) : ''}`
      : 'unknown';
    lines.push(`- saved HEAD: ${headText}`);
    lines.push(`- context freshness: ${contextFreshnessText(sc.freshness)}`);
  }

  // 運用見出し（Increment 2）。存在する場合だけ出力する。
  const extractNextDate = _aqFn('extractNextDate');
  const externalWaitText = _aqFn('externalWaitText');
  const externalSignalText = _aqFn('externalSignalText');
  const nextReview = extractNextDate
    ? extractNextDate([r.agentContextMarkdown || '', r.note || ''])
    : null;
  if (nextReview) lines.push(`- next review: ${nextReview}`);
  const extWait = externalWaitText ? externalWaitText(r) : '';
  if (extWait) lines.push(`- external wait: ${singleLine(extWait)}`);
  const extSignal = externalSignalText ? externalSignalText(r) : '';

  const byKey = resumeItemsByKey(r);
  if (byKey.currentState) {
    lines.push('', '#### Current focus', '', byKey.currentState.text);
  }
  if (byKey.nextAction) {
    lines.push('', '#### Next action', '', byKey.nextAction.text);
  }
  if (byKey.knownConstraints) {
    lines.push('', '#### Blockers / notes', '', byKey.knownConstraints.text);
  }
  if (r.hasProgress && r.progressTail && r.progressTail.trim()) {
    lines.push('', '#### Recent progress', '', r.progressTail.trim());
  }
  if (extSignal && extSignal.trim()) {
    lines.push('', '#### External signal', '', extSignal.trim());
  }
  // README summary: 現在のscan結果に該当フィールド（README全文の要約）が
  // 存在しないため、この機能のために新しく要約処理を追加せず出力しない
  return lines.join('\n');
}

// ---- 全体組み立て -----------------------------------------------------------

const ANALYSIS_REQUEST_TEXT = `この素材を読み、次を行ってください。

1. ユーザー本人が繰り返し困っていることを抽出する
2. 複数プロジェクトに共通する課題や仕組みを抽出する
3. 再利用可能なコード、設計、運用知見の候補を抽出する
4. システム化またはサービス化できる案を提案する
5. 各案について、根拠となるプロジェクトと具体的な利用場面を示す
6. ユーザー本人が最初の利用者になれるかを評価する
7. 2時間以内の検証方法を示す
8. 継続利用の理由と破棄条件を示す
9. 月10万円規模のストック収益へ発展する経路があれば示す
10. 根拠が弱い案を無理に採用しない

提案数を増やすことより、ユーザー本人が「今すぐ触りたい」と思う案を優先してください。

---

外部状態（GitHub / F-Droid / Qiita / Coconala / Google Play 等）を確認できる場合は、
変化があった project / item についてのみ、Agent context の薄い運用情報を更新するための
情報を返してください。対象の見出しは次の5つで、単一 project ごとにまとめてください。

- ## 現在地 … 現在の状況を1〜3行で
- ## 次に行うこと … 次の具体的アクション（無ければ省略）
- ## 次回確認日 … 単一 ISO 日付（YYYY-MM-DD）のみ。無ければ省略
- ## 外部イベント待ち … F-Droid / ストア審査 / レビュー等、外部の何かを待っている場合のみ1行
- ## 外部シグナル … downloads / stars / views / favorites / inquiry / purchase 等の観測値（数行）

推測値を書かないでください。確認できた事実のみ。変化が無い項目は返さないでください。
これは Agent Workbench の Agent context 欄へ人間が貼り付けるための素材であり、
Agent Workbench 自身は外部 API を呼びません。`;

function buildProjectSignalsMarkdown(repos, generatedAtIso) {
  const list = Array.isArray(repos) ? repos : [];
  const generatedAt = fmtSignalsDate(generatedAtIso || new Date().toISOString());
  const projectsBody = list.length
    ? list.map(buildProjectSection).join('\n\n')
    : '(no projects)';

  return `# Agent Workbench Project Signals

## Purpose

この情報は、複数プロジェクトを横断して次を探すための素材です。

- ユーザー本人が繰り返し困っていること
- 複数プロジェクトに共通する課題
- 再利用できる技術・仕組み・知見
- 放置されているが再開価値がある案
- 自分用ツールからサービス化できる候補
- 1日以内で検証できるシステム化・サービス化案

コード変更や外部公開を自動で行うための入力ではありません。

## Generated at

${generatedAt}

## Portfolio summary

${buildPortfolioSummaryLines(list).join('\n')}

## Attention signals

${buildAttentionSignalsLines(list).join('\n')}

## Projects

${projectsBody}

## Analysis request

${ANALYSIS_REQUEST_TEXT}
`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    signalsIdleDays,
    signalsIdleLabel,
    signalsIdleBucket,
    fmtSignalsDate,
    workingTreeText,
    remoteText,
    contextFreshnessText,
    attentionFlags,
    buildPortfolioSummaryLines,
    buildAttentionSignalsLines,
    buildProjectSection,
    buildProjectSignalsMarkdown,
    ANALYSIS_REQUEST_TEXT,
  };
}
