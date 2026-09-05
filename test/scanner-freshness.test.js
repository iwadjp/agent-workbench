'use strict';

// README/PROGRESS file metadata（modifiedAt/contentHash）と、
// commits-ahead判定（computeCommitsAhead）の単体テスト。
// 実際のtemp git repoを使う（git installを前提とする。既存test群と同じ前提）。

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanRepo, computeCommitsAhead, hashText } = require('../lib/scanner');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function initRepo(cwd) {
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
}

function commitAll(cwd, message) {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

let count = 0;
async function test(name, fn) {
  count++;
  try {
    await fn();
    console.log(`ok ${count} - ${name}`);
  } catch (error) {
    console.error(`not ok ${count} - ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

(async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'awb-scanner-freshness-'));
  try {
    await test('hashText is stable for identical text and differs for different text', () => {
      assert.strictEqual(hashText('hello'), hashText('hello'));
      assert.notStrictEqual(hashText('hello'), hashText('hello world'));
      assert.strictEqual(typeof hashText(''), 'string');
      assert.strictEqual(hashText(null), hashText(''));
    });

    const repoDir = path.join(tempRoot, 'repo');
    await fsp.mkdir(repoDir, { recursive: true });
    initRepo(repoDir);
    await fsp.writeFile(path.join(repoDir, 'README.md'), '# Hello\n\nOverview text.\n', 'utf8');
    await fsp.writeFile(path.join(repoDir, 'PROGRESS.md'), '# PROGRESS\n\n## Step 1\nDone.\n', 'utf8');
    const firstHash = commitAll(repoDir, 'Initial commit');

    await test('scanRepo captures README/PROGRESS modifiedAt and contentHash of the read excerpt', async () => {
      const info = await scanRepo(repoDir, {});
      assert.strictEqual(info.hasReadme, true);
      assert.strictEqual(info.hasProgress, true);
      assert.strictEqual(typeof info.readmeModifiedAt, 'string');
      assert.strictEqual(typeof info.progressModifiedAt, 'string');
      assert.ok(!Number.isNaN(Date.parse(info.readmeModifiedAt)));
      assert.ok(!Number.isNaN(Date.parse(info.progressModifiedAt)));
      assert.strictEqual(info.readmeHash, hashText(info.readmeTail));
      assert.strictEqual(info.progressHash, hashText(info.progressTail));
    });

    await test('README/PROGRESS hash changes only when the read excerpt actually changes', async () => {
      const before = await scanRepo(repoDir, {});
      const beforeReadmeHash = before.readmeHash;
      const beforeProgressHash = before.progressHash;

      // README/PROGRESSを変更せずrescanしても同じhashになる
      const unchanged = await scanRepo(repoDir, {});
      assert.strictEqual(unchanged.readmeHash, beforeReadmeHash);
      assert.strictEqual(unchanged.progressHash, beforeProgressHash);

      // PROGRESS.mdだけ追記して再scanするとPROGRESSのhashだけ変わる
      await fsp.appendFile(path.join(repoDir, 'PROGRESS.md'), '\n## Step 2\nMore progress.\n', 'utf8');
      const afterProgressEdit = await scanRepo(repoDir, {});
      assert.strictEqual(afterProgressEdit.readmeHash, beforeReadmeHash);
      assert.notStrictEqual(afterProgressEdit.progressHash, beforeProgressHash);
    });

    let secondHash;
    await test('computeCommitsAhead returns the count when savedHash is an ancestor of the current HEAD', async () => {
      await fsp.writeFile(path.join(repoDir, 'file2.txt'), 'more\n', 'utf8');
      secondHash = commitAll(repoDir, 'Second commit');
      const ahead = await computeCommitsAhead(repoDir, firstHash, secondHash);
      assert.strictEqual(ahead, 1);
    });

    await test('computeCommitsAhead returns null for identical hashes without running git', async () => {
      const ahead = await computeCommitsAhead(repoDir, secondHash, secondHash);
      assert.strictEqual(ahead, null);
    });

    await test('computeCommitsAhead returns null (not an error) for an unrelated/unknown hash', async () => {
      const ahead = await computeCommitsAhead(repoDir, '0000000000000000000000000000000000dead', secondHash);
      assert.strictEqual(ahead, null);
    });

    await test('computeCommitsAhead returns null when either hash is missing', async () => {
      assert.strictEqual(await computeCommitsAhead(repoDir, null, secondHash), null);
      assert.strictEqual(await computeCommitsAhead(repoDir, secondHash, null), null);
    });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${count} scanner freshness tests, ${process.exitCode ? 'FAILED' : 'all passed'}`);
})();
