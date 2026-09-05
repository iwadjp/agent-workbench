'use strict';

const assert = require('assert');
const {
  parseWslUncPath,
  buildGitInvocation,
  diagnoseGitError,
} = require('../lib/scanner');

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

test('parses wsl.localhost UNC paths', () => {
  assert.deepStrictEqual(
    parseWslUncPath('\\\\wsl.localhost\\Ubuntu\\home\\user\\projects\\sample-project'),
    { distro: 'Ubuntu', linuxPath: '/home/user/projects/sample-project' }
  );
});

test('preserves spaces, symbols, and hyphenated distro names', () => {
  assert.deepStrictEqual(
    parseWslUncPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev user\\repo #1\\'),
    { distro: 'Ubuntu-24.04', linuxPath: '/home/dev user/repo #1' }
  );
});

test('supports the wsl$ compatibility UNC form', () => {
  assert.deepStrictEqual(parseWslUncPath('\\\\wsl$\\Debian\\srv\\repo'), {
    distro: 'Debian',
    linuxPath: '/srv/repo',
  });
});

test('does not classify Windows paths as WSL', () => {
  assert.strictEqual(parseWslUncPath('D:\\work\\repo'), null);
  assert.strictEqual(parseWslUncPath('\\\\server\\share\\repo'), null);
});

test('builds an argument-array WSL git invocation', () => {
  const invocation = buildGitInvocation(
    '\\\\wsl.localhost\\Ubuntu\\home\\dev user\\repo #1',
    ['status', '--porcelain=v1']
  );
  assert.strictEqual(invocation.file, 'wsl.exe');
  assert.strictEqual(invocation.cwd, undefined);
  assert.deepStrictEqual(invocation.args, [
    '-d', 'Ubuntu', '--exec', 'git', '-C', '/home/dev user/repo #1', 'status', '--porcelain=v1',
  ]);
});

test('keeps Windows repositories on the native git path', () => {
  const invocation = buildGitInvocation('D:\\work\\repo', ['status', '--porcelain=v1']);
  assert.strictEqual(invocation.file, 'git');
  assert.strictEqual(invocation.cwd, 'D:\\work\\repo');
  assert.deepStrictEqual(invocation.args, ['status', '--porcelain=v1']);
  assert.strictEqual(invocation.wsl, null);
});

test('diagnoses WSL failures and recommends WSL-side safe.directory', () => {
  const repo = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo';
  assert.strictEqual(
    diagnoseGitError('fatal: cannot change to /home/dev/repo: No such file or directory', repo).code,
    'path-not-found'
  );
  assert.strictEqual(
    diagnoseGitError('fatal: not a git repository', repo).code,
    'not-a-repository'
  );
  const dubious = diagnoseGitError('fatal: detected dubious ownership', repo);
  assert.strictEqual(dubious.code, 'dubious-ownership');
  assert.ok(dubious.suggestedCommand.startsWith('wsl.exe -d "Ubuntu" --exec git config'));
  assert.ok(dubious.suggestedCommand.includes('"/home/dev/repo"'));
});

test('diagnoses timeout and missing WSL distribution separately', () => {
  const repo = '\\\\wsl.localhost\\Missing-Distro\\home\\dev\\repo';
  const timeout = new Error('Command failed');
  timeout.gitTimedOut = true;
  timeout.gitOperation = 'working tree status';
  assert.deepStrictEqual(diagnoseGitError(timeout, repo), {
    code: 'timeout',
    operation: 'working tree status',
    message: 'Git operation "working tree status" timed out after 15 seconds.',
  });
  assert.strictEqual(
    diagnoseGitError('Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND', repo).code,
    'wsl-distro-not-found'
  );
  assert.strictEqual(
    diagnoseGitError('execvpe(git) failed: No such file or directory', repo).code,
    'git-not-found'
  );
  assert.strictEqual(
    diagnoseGitError('Wsl/Service/WSL_E_WSL_NOT_RUNNING', repo).code,
    'wsl-start-failed'
  );
});

process.on('exit', (code) => {
  console.log(`\n${count} scanner tests, ${code === 0 ? 'all passed' : 'FAILED'}`);
});
