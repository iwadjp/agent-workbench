'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PROGRESS_TAIL_LINES = 80;
// 末尾抜粋のために読む最大バイト数（大きいファイルでも末尾だけ読む）
const PROGRESS_TAIL_BYTES = 64 * 1024;
// README は末尾ではなく冒頭（目的・概要が書かれていることが多い）を抜粋する
const README_HEAD_LINES = 60;
const README_HEAD_BYTES = 16 * 1024;
const GIT_TIMEOUT_MS = 15 * 1000;

function normalizeProcessText(value) {
  return String(value || '').replace(/\0/g, '').replace(/\r\n/g, '\n');
}

function parseWslUncPath(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.includes('\0')) return null;
  const match = repoPath.match(/^\\\\(wsl\.localhost|wsl\$)\\([^\\/]+)(?:[\\/](.*))?$/i);
  if (!match || match[2] === '.' || match[2] === '..') return null;

  const segments = (match[3] || '').split(/[\\/]+/).filter(Boolean);
  return {
    distro: match[2],
    linuxPath: '/' + segments.join('/'),
  };
}

function buildGitInvocation(repoPath, args) {
  const wsl = parseWslUncPath(repoPath);
  if (wsl) {
    return {
      file: 'wsl.exe',
      args: ['-d', wsl.distro, '--exec', 'git', '-C', wsl.linuxPath, ...args],
      cwd: undefined,
      wsl,
    };
  }
  return { file: 'git', args, cwd: repoPath, wsl: null };
}

function git(repoPath, args, operation = args[0] || 'git') {
  const invocation = buildGitInvocation(repoPath, args);
  return new Promise((resolve, reject) => {
    execFile(
      invocation.file,
      invocation.args,
      {
        cwd: invocation.cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.gitOperation = operation;
          err.gitStdout = normalizeProcessText(stdout).trim();
          err.gitStderr = normalizeProcessText(stderr).trim();
          err.gitInvocation = invocation;
          err.gitTimedOut = err.killed === true || err.code === 'ETIMEDOUT';
          reject(err);
        }
        else resolve(normalizeProcessText(stdout));
      }
    );
  });
}

function isExpectedEmptyRepoError(error) {
  const msg = String(error.gitStderr || error.gitStdout || error.message || error);
  return /does not have any commits yet|your current branch .* has no commits yet|ambiguous argument ['"]?HEAD|bad revision ['"]?HEAD/i.test(msg);
}

// Classify Git/WSL failures for display. suggestedCommand is display-only.
function diagnoseGitError(error, repoPath, operation) {
  const err = error && typeof error === 'object' ? error : null;
  const msg = String((err && (err.gitStderr || err.gitStdout || err.message)) || error || '');
  const op = operation || (err && err.gitOperation) || 'git';
  const wsl = parseWslUncPath(repoPath);
  const result = (code, message, suggestedCommand) => ({
    code,
    operation: op,
    message,
    ...(suggestedCommand ? { suggestedCommand } : {}),
  });

  if ((err && err.gitTimedOut) || /timed?\s*out/i.test(msg)) {
    return result('timeout', `Git operation "${op}" timed out after ${GIT_TIMEOUT_MS / 1000} seconds.`);
  }
  if (wsl && /WSL_E_DISTRO_NOT_FOUND|no distribution with the supplied name|distribution.*not found/i.test(msg)) {
    return result('wsl-distro-not-found', `WSL distribution "${wsl.distro}" was not found.`);
  }
  if (wsl && err && err.code === 'ENOENT') {
    return result('wsl-not-available', 'wsl.exe could not be started. Check that WSL is installed and available.');
  }
  if (wsl && /cannot change to .*No such file or directory|cannot change to .*not found/i.test(msg)) {
    return result('path-not-found', 'The repository path does not exist inside the WSL distribution.');
  }
  if (wsl && /execvpe?\(git\).*failed|git:\s*(command\s*)?not found|git.*executable.*not found/i.test(msg)) {
    return result('git-not-found', `Git is not installed or not available in WSL distribution "${wsl.distro}".`);
  }
  if (/not a git repository/i.test(msg)) {
    return result('not-a-repository', 'The path exists, but it is not a Git repository.');
  }
  if (/dubious ownership|safe\.directory/i.test(msg)) {
    if (wsl) {
      const distro = wsl.distro.replace(/"/g, '\\"');
      const linuxPath = wsl.linuxPath.replace(/"/g, '\\"');
      return result(
        'dubious-ownership',
        'Git inside WSL does not trust the ownership of this repository (dubious ownership).',
        `wsl.exe -d "${distro}" --exec git config --global --add safe.directory "${linuxPath}"`
      );
    }
    const gitPath = String(repoPath).replace(/\\/g, '/');
    return result(
      'dubious-ownership',
      'Git does not trust the ownership of this repository (dubious ownership).',
      `git config --global --add safe.directory "${gitPath}"`
    );
  }
  if (wsl && /Wsl\/Service|WSL_E_|failed to (start|launch)|Windows Subsystem for Linux/i.test(msg)) {
    return result('wsl-start-failed', `WSL distribution "${wsl.distro}" could not be started.`);
  }
  return result('git-error', `Git operation "${op}" failed.`);
}

async function readProgressTail(filePath) {
  const stat = await fsp.stat(filePath);
  const start = Math.max(0, stat.size - PROGRESS_TAIL_BYTES);
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    await fh.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8').replace(/\r\n/g, '\n');
    // 途中から読んだ場合、先頭の欠けた行を捨てる
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    const lines = text.split('\n');
    return lines.slice(-PROGRESS_TAIL_LINES).join('\n').trim();
  } finally {
    await fh.close();
  }
}

// README は目的・概要が冒頭にあることが多いため、末尾ではなく先頭を抜粋する
async function readReadmeHead(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const len = Math.min(stat.size, README_HEAD_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    const text = buf.toString('utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n').slice(0, README_HEAD_LINES);
    return lines.join('\n').trim();
  } finally {
    await fh.close();
  }
}

// scanDurationMs から速度区分を返す（3秒以上 slow / 10秒以上 very-slow）
function speedOf(ms) {
  if (ms >= 10000) return 'very-slow';
  if (ms >= 3000) return 'slow';
  return 'normal';
}

// README/PROGRESSの「今回読んだ範囲（冒頭/末尾の抜粋）」だけのcontent hashを作る。
// ファイル全体は読んでいないため、全体hashではなく実際に表示している範囲のhashにする
// （表示内容が変わったかどうかを判定するには十分で、全文再読込は不要）
function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

// remote tracking status を fetch なしで取得する（ローカルの tracking 情報のみ）。
// git fetch / pull / push / GitHub API は一切使わない。
async function readRemoteStatus(repoPath) {
  const remote = {
    enabled: true,
    hasRemote: false,
    originUrl: null,
    upstream: null,
    ahead: null,
    behind: null,
    status: 'unknown', // no-remote | no-upstream | up-to-date | ahead | behind | diverged | unknown | error
    error: null,
  };
  try {
    let url = '';
    try {
      url = (await git(repoPath, ['remote', 'get-url', 'origin'], 'remote origin')).trim();
    } catch (e) {
      const detail = String(e.gitStderr || e.gitStdout || e.message || e);
      if (!/No such remote ['"]?origin/i.test(detail)) throw e;
    }
    if (!url) {
      remote.status = 'no-remote';
      return remote;
    }
    remote.hasRemote = true;
    remote.originUrl = url;

    let upstream = '';
    try {
      upstream = (
        await git(
          repoPath,
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
          'remote upstream'
        )
      ).trim();
    } catch (e) {
      const detail = String(e.gitStderr || e.gitStdout || e.message || e);
      if (!/no upstream configured|no upstream branch/i.test(detail)) throw e;
    }
    if (!upstream) {
      remote.status = 'no-upstream';
      return remote;
    }
    remote.upstream = upstream;

    // 左=upstream側のみ（behind）、右=HEAD側のみ（ahead）
    const counts = (
      await git(repoPath, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], 'remote ahead/behind')
    ).trim();
    const m = counts.match(/^(\d+)\s+(\d+)$/);
    if (!m) {
      remote.status = 'unknown';
      return remote;
    }
    remote.behind = parseInt(m[1], 10);
    remote.ahead = parseInt(m[2], 10);
    if (remote.ahead === 0 && remote.behind === 0) remote.status = 'up-to-date';
    else if (remote.ahead > 0 && remote.behind > 0) remote.status = 'diverged';
    else if (remote.ahead > 0) remote.status = 'ahead';
    else remote.status = 'behind';
  } catch (e) {
    remote.status = 'error';
    const diagnosis = diagnoseGitError(e, repoPath);
    remote.error = `${diagnosis.operation}: ${diagnosis.message}`.slice(0, 200);
  }
  return remote;
}

// 1ディレクトリを1projectとしてスキャンする。
// kind: repo | no-git | missing | error（gitStatus は従来互換で維持）
// options.progressPath: PROGRESS.md のカスタムパス（repoPath からの相対。絶対パスも可）
// options.remoteStatus: true のときだけ remote tracking status を取得（fetchなし）
async function scanRepo(repoPath, options = {}) {
  const name = path.basename(repoPath);
  const scanStart = Date.now();
  // ステップ別時間。git系は並列実行のため、合計は scanDurationMs を超えることがある
  const scanSteps = {
    existsMs: 0,
    readmeMs: 0,
    progressMs: 0,
    gitStatusMs: 0,
    gitBranchMs: 0,
    gitLogMs: 0,
    gitTagsMs: 0,
    gitProbeMs: 0,
    remoteStatusMs: 0,
  };
  const finish = (info) => {
    info.scanDurationMs = Date.now() - scanStart;
    info.scanFinishedAt = new Date().toISOString();
    info.scanSpeed = speedOf(info.scanDurationMs);
    return info;
  };
  const info = {
    name,
    path: repoPath,
    kind: 'repo',
    isGitRepo: false,
    branch: null,
    commit: null, // { hash, message, date }
    gitStatus: 'error', // clean | dirty | untracked-only | no-git | error
    modifiedCount: 0,
    untrackedCount: 0,
    tags: [],
    hasReadme: false,
    readmeTail: null,
    readmeError: null,
    readmeModifiedAt: null, // README.mdのfs mtime（file metadata表示用。表示範囲のみ読むため全文hashではない）
    readmeHash: null, // 実際に読んだ範囲（冒頭抜粋）のcontent hash。変更検知に使う
    hasProgress: false,
    progressTail: null,
    progressPath: options.progressPath || null,
    progressSource: 'missing', // default | custom | missing
    progressError: null,
    progressModifiedAt: null, // PROGRESS.mdのfs mtime
    progressHash: null, // 実際に読んだ範囲（末尾抜粋）のcontent hash
    error: null,
    gitOperation: null,
    gitDiagnosis: null, // { code, message, suggestedCommand } | null
    remote: { enabled: false, status: 'disabled' }, // remoteStatus有効targetのgit repoのみ取得
    scanStartedAt: new Date(scanStart).toISOString(),
    scanFinishedAt: null,
    scanDurationMs: 0,
    scanSpeed: 'normal', // normal | slow | very-slow
    scanSteps,
  };

  let t = Date.now();
  const wsl = parseWslUncPath(repoPath);
  let repoExists;
  if (wsl) {
    const probeStart = Date.now();
    try {
      const probe = await git(repoPath, ['rev-parse', '--show-toplevel'], 'repository probe');
      repoExists = true;
      const topLevel = probe.trim().replace(/\/+$/, '') || '/';
      const requestedPath = wsl.linuxPath.replace(/\/+$/, '') || '/';
      info.isGitRepo = topLevel === requestedPath;
    } catch (e) {
      const diagnosis = diagnoseGitError(e, repoPath, 'repository probe');
      if (diagnosis.code === 'not-a-repository') {
        repoExists = true;
        info.isGitRepo = false;
      } else if (diagnosis.code === 'path-not-found') {
        repoExists = false;
        info.gitOperation = 'repository probe';
        info.gitDiagnosis = diagnosis;
      } else {
        info.kind = 'error';
        info.gitStatus = 'error';
        info.gitOperation = 'repository probe';
        const detail = e.gitStderr || e.gitStdout || e.message || String(e);
        info.error = (diagnosis.code === 'git-error' ? detail : diagnosis.message).slice(0, 300);
        info.gitDiagnosis = diagnosis;
        scanSteps.gitProbeMs = Date.now() - probeStart;
        scanSteps.existsMs = scanSteps.gitProbeMs;
        return finish(info);
      }
    } finally {
      scanSteps.gitProbeMs = Date.now() - probeStart;
    }
  } else {
    repoExists = fs.existsSync(repoPath);
    // .git can be a directory or a file (for example, a worktree).
    info.isGitRepo = repoExists && fs.existsSync(path.join(repoPath, '.git'));
  }
  scanSteps.existsMs = Date.now() - t;

  if (!repoExists) {
    info.kind = 'missing';
    info.gitStatus = 'error';
    info.error = 'path not found';
    return finish(info);
  }

  t = Date.now();
  const readmeFile = path.join(repoPath, 'README.md');
  info.hasReadme = fs.existsSync(readmeFile);
  if (info.hasReadme) {
    // readmeTail という名称だが、README は冒頭に目的・概要が書かれることが多いため実体は先頭抜粋
    try {
      info.readmeTail = await readReadmeHead(readmeFile);
      info.readmeHash = hashText(info.readmeTail);
      try {
        info.readmeModifiedAt = (await fsp.stat(readmeFile)).mtime.toISOString();
      } catch (statError) {
        info.readmeModifiedAt = null;
      }
    } catch (e) {
      info.readmeTail = null;
      info.readmeError = String(e.message || e).slice(0, 200);
    }
  }
  scanSteps.readmeMs = Date.now() - t;

  // PROGRESS の場所を決める: progressPath 指定時は repoPath からの相対
  // （絶対パスならそのまま）、未指定なら repo直下の PROGRESS.md
  t = Date.now();
  const custom = typeof options.progressPath === 'string' && options.progressPath.trim() !== '';
  const progressFile = custom
    ? path.resolve(repoPath, options.progressPath)
    : path.join(repoPath, 'PROGRESS.md');

  info.hasProgress = fs.existsSync(progressFile);
  if (info.hasProgress) {
    info.progressSource = custom ? 'custom' : 'default';
    try {
      info.progressTail = await readProgressTail(progressFile);
      info.progressHash = hashText(info.progressTail);
      try {
        info.progressModifiedAt = (await fsp.stat(progressFile)).mtime.toISOString();
      } catch (statError) {
        info.progressModifiedAt = null;
      }
    } catch (e) {
      info.progressTail = null;
      info.progressError = String(e.message || e).slice(0, 200);
    }
  } else {
    info.progressSource = 'missing';
    if (custom) info.progressError = 'progressPath not found: ' + options.progressPath;
  }
  scanSteps.progressMs = Date.now() - t;

  if (!info.isGitRepo) {
    info.kind = 'no-git';
    info.gitStatus = 'no-git';
    return finish(info);
  }

  // Measure each command while running in parallel. Empty-repo branch/log errors are optional.
  const timedGit = async (args, stepKey, optional, operation) => {
    const s = Date.now();
    try {
      return await git(repoPath, args, operation);
    } catch (e) {
      if (optional && isExpectedEmptyRepoError(e)) return '';
      throw e;
    } finally {
      scanSteps[stepKey] = Date.now() - s;
    }
  };

  // remoteStatus 有効時のみ取得（readRemoteStatus は内部でエラーを吸収するため reject しない）
  const remotePromise =
    options.remoteStatus === true
      ? (async () => {
          const s = Date.now();
          try {
            return await readRemoteStatus(repoPath);
          } finally {
            scanSteps.remoteStatusMs = Date.now() - s;
          }
        })()
      : Promise.resolve(null);

  try {
    const [branch, logOut, statusOut, tagsOut, remoteInfo] = await Promise.all([
      timedGit(['rev-parse', '--abbrev-ref', 'HEAD'], 'gitBranchMs', true, 'branch'),
      timedGit(['log', '-1', '--format=%h%x1f%s%x1f%cI'], 'gitLogMs', true, 'latest commit'),
      timedGit(['status', '--porcelain=v1'], 'gitStatusMs', false, 'working tree status'),
      timedGit(
        ['for-each-ref', '--sort=-creatordate', '--count=5', '--format=%(refname:short)', 'refs/tags'],
        'gitTagsMs',
        true,
        'tags'
      ),
      remotePromise,
    ]);
    if (remoteInfo) info.remote = remoteInfo;

    info.branch = branch.trim() || null;

    const logLine = logOut.trim();
    if (logLine) {
      const [hash, message, date] = logLine.split('\x1f');
      info.commit = { hash, message, date };
    }

    const statusLines = statusOut.split('\n').filter((l) => l.length > 0);
    let modified = 0;
    let untracked = 0;
    for (const line of statusLines) {
      if (line.startsWith('??')) untracked++;
      else modified++;
    }
    info.modifiedCount = modified;
    info.untrackedCount = untracked;
    if (statusLines.length === 0) info.gitStatus = 'clean';
    else if (modified === 0) info.gitStatus = 'untracked-only';
    else info.gitStatus = 'dirty';

    info.tags = tagsOut.split('\n').filter((t) => t.trim().length > 0);
  } catch (e) {
    const msg = String(e.message || e);
    info.kind = 'error';
    info.gitStatus = 'error';
    info.gitOperation = e.gitOperation || null;
    info.gitDiagnosis = diagnoseGitError(e, repoPath);
    const detail = e.gitStderr || e.gitStdout || msg;
    info.error = String(info.gitDiagnosis.code === 'git-error' ? detail : info.gitDiagnosis.message).slice(0, 300);
  }

  return finish(info);
}

function withTarget(project, target) {
  return {
    ...project,
    targetId: target.id,
    targetLabel: target.label,
    targetPath: target.path,
  };
}

// targets（config設定の配列）を順にスキャンする。
// 戻り値: { repos, configErrors, targetSummaries }
// - repo-directories: 直下の全ディレクトリを候補にする（.gitなしは no-git）
// - single-repo: 指定パスそのものを1projectとして扱う（配下は見ない）
// - enabled:false はスキャンしないが、summary には status: disabled で載せる
async function scanTargets(targets) {
  const repos = [];
  const configErrors = [];
  const targetSummaries = [];

  for (const target of targets) {
    if (!target) continue;
    const summary = {
      targetId: target.id || '?',
      targetLabel: target.label || target.id || '?',
      type: target.type || '?',
      enabled: target.enabled !== false,
      status: 'ok', // ok | missing | error | disabled
      projectCount: 0,
      repoCount: 0,
      noGitCount: 0,
      errorCount: 0,
      slowProjectCount: 0,
      verySlowProjectCount: 0,
      durationMs: 0,
      // readdir系（repo-directories のみ値が入る。single-repo / disabled は null）
      // excludeNames による除外（repo-directories のみ）
      excludedCount: 0,
      excludedNames: [],
      readdirMs: null, // target直下のディレクトリ列挙＋候補抽出の時間
      readdirSpeed: null, // normal | slow | very-slow（しきい値は repo と同じ 3秒/10秒）
      childCandidateCount: null, // repo候補として見た直下ディレクトリ数
      repoScanMs: null, // 各repoスキャン（並列実行）の実経過時間
      repoScanTotalMs: null, // 各projectの scanDurationMs の単純合計（並列のため repoScanMs より大きくなりうる）
      overheadMs: null, // durationMs - readdirMs - repoScanMs（残りの処理時間）
      // remote tracking 集計（remoteStatus:true の target のみ件数が入る）
      remoteEnabled: target && target.remoteStatus === true,
      remoteCheckedCount: 0,
      remoteAheadCount: 0,
      remoteBehindCount: 0,
      remoteDivergedCount: 0,
      remoteNoRemoteCount: 0,
      remoteNoUpstreamCount: 0,
      remoteErrorCount: 0,
      error: null,
    };
    targetSummaries.push(summary);

    if (target.enabled === false) {
      summary.status = 'disabled';
      continue;
    }
    if (!target.path || typeof target.path !== 'string') {
      summary.status = 'error';
      summary.error = 'path missing in config';
      configErrors.push({ targetId: summary.targetId, error: 'path missing in config' });
      continue;
    }

    const startMs = Date.now();
    const scanned = [];

    if (target.type === 'single-repo') {
      // 存在しない場合も kind: missing の1件として一覧に出す
      // progressPath は single-repo のみ適用（repo-directories の子repoには渡さない）
      scanned.push(
        await scanRepo(target.path, {
          progressPath: target.progressPath,
          remoteStatus: target.remoteStatus === true,
        })
      );
      if (scanned[0].kind === 'missing') {
        summary.status = 'missing';
        summary.error = 'path not found: ' + target.path;
      }
    } else if (target.type === 'repo-directories') {
      let entries = null;
      const readdirStart = Date.now();
      try {
        entries = await fsp.readdir(target.path, { withFileTypes: true });
      } catch (e) {
        summary.status = e.code === 'ENOENT' ? 'missing' : 'error';
        summary.error = `scan root not readable: ${e.code || e.message}`;
        configErrors.push({
          targetId: target.id,
          path: target.path,
          error: summary.error,
        });
      }
      if (entries) {
        let dirs = entries.filter((ent) => ent.isDirectory());
        // excludeNames: basename の完全一致で除外。除外したものは一切スキャンしない
        const excludeNames = Array.isArray(target.excludeNames) ? target.excludeNames : [];
        if (excludeNames.length > 0) {
          const excluded = dirs.filter((ent) => excludeNames.includes(ent.name));
          summary.excludedCount = excluded.length;
          summary.excludedNames = excluded.map((ent) => ent.name);
          dirs = dirs.filter((ent) => !excludeNames.includes(ent.name));
        }
        summary.readdirMs = Date.now() - readdirStart; // 列挙＋候補抽出まで
        summary.readdirSpeed = speedOf(summary.readdirMs);
        summary.childCandidateCount = dirs.length;
        const repoScanStart = Date.now();
        scanned.push(
          ...(await Promise.all(
            dirs.map((ent) =>
              scanRepo(path.join(target.path, ent.name), { remoteStatus: target.remoteStatus === true })
            )
          ))
        );
        summary.repoScanMs = Date.now() - repoScanStart;
        summary.repoScanTotalMs = scanned.reduce((a, p) => a + (p.scanDurationMs || 0), 0);
      } else {
        // 失敗した readdir 試行の時間も記録しておく
        summary.readdirMs = Date.now() - readdirStart;
        summary.readdirSpeed = speedOf(summary.readdirMs);
      }
    } else {
      summary.status = 'error';
      summary.error = `unknown type: ${target.type}`;
      configErrors.push({ targetId: target.id, error: summary.error });
    }

    summary.durationMs = Date.now() - startMs;
    if (summary.readdirMs != null && summary.repoScanMs != null) {
      summary.overheadMs = Math.max(0, summary.durationMs - summary.readdirMs - summary.repoScanMs);
    }
    summary.projectCount = scanned.length;
    for (const p of scanned) {
      if (p.kind === 'repo') summary.repoCount++;
      else if (p.kind === 'no-git') summary.noGitCount++;
      else summary.errorCount++; // missing / error
      if (p.scanSpeed === 'slow') summary.slowProjectCount++;
      else if (p.scanSpeed === 'very-slow') summary.verySlowProjectCount++;
      if (p.remote && p.remote.enabled) {
        summary.remoteCheckedCount++;
        if (p.remote.status === 'ahead') summary.remoteAheadCount++;
        else if (p.remote.status === 'behind') summary.remoteBehindCount++;
        else if (p.remote.status === 'diverged') summary.remoteDivergedCount++;
        else if (p.remote.status === 'no-remote') summary.remoteNoRemoteCount++;
        else if (p.remote.status === 'no-upstream') summary.remoteNoUpstreamCount++;
        else if (p.remote.status === 'error') summary.remoteErrorCount++;
      }
      repos.push(withTarget(p, target));
    }
  }

  repos.sort(
    (a, b) =>
      a.targetLabel.localeCompare(b.targetLabel, 'ja') ||
      a.name.localeCompare(b.name, 'ja')
  );
  return { repos, configErrors, targetSummaries };
}

// 保存時HEADから現在HEADまでの「進んだcommit数」を安全に判定する。
// savedHash が現在の履歴に存在しない（force-push・履歴書き換え・別branchのhash等）場合や、
// git操作自体が失敗する場合は例外を投げず null を返す（呼び出し側は「差はあるが件数不明」表示に倒す）。
// 1 project単位でのみ呼ぶ（rescan-one等）。一覧全体のscanでは呼ばない（低速化防止）
async function computeCommitsAhead(repoPath, savedHash, currentHash) {
  if (!savedHash || !currentHash || savedHash === currentHash) return null;
  try {
    // savedHashが現在のhistoryの祖先であることを確認してからcountする
    // （祖先でない=force-push等で失われたhistoryの場合はcountを出さない）
    await git(repoPath, ['merge-base', '--is-ancestor', savedHash, currentHash], 'merge-base check');
  } catch (e) {
    return null;
  }
  try {
    const out = await git(repoPath, ['rev-list', '--count', `${savedHash}..${currentHash}`], 'commits ahead count');
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  scanTargets,
  scanRepo,
  computeCommitsAhead,
  diagnoseGitError,
  hashText,
  readRemoteStatus,
  parseWslUncPath,
  buildGitInvocation,
};
