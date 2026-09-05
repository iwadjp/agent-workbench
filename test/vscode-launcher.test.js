'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  authorizeVscodeProject,
  normalizeProjectPath,
  resolveVscodeExecutable,
  buildVscodeArguments,
  buildWorkspaceLaunchArguments,
  launchProjectInVscode,
  launchWorkspaceInVscode,
} = require('../lib/vscode-launcher');

const windowsRepo = {
  path: 'D:\\work\\alpha',
  targetId: 'windows',
  kind: 'repo',
};
const wslRepo = {
  path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\projects\\sample-project',
  targetId: 'wsl-private',
  kind: 'repo',
};
const scanCache = { repos: [windowsRepo, wslRepo] };

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

function fakeSpawnRecorder(records, event = 'spawn', errorCode = null) {
  return (executable, args, options) => {
    records.push({ executable, args, options });
    const child = new EventEmitter();
    child.unref = () => { child.unrefCalled = true; };
    process.nextTick(() => {
      if (event === 'error') {
        const error = new Error('spawn failed');
        error.code = errorCode;
        child.emit('error', error);
      } else {
        child.emit('spawn');
      }
    });
    return child;
  };
}

(async () => {
  await test('allows a scanned Windows project with matching targetId', () => {
    const result = authorizeVscodeProject(scanCache, {
      path: 'D:\\work\\alpha',
      targetId: 'windows',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.project, windowsRepo);
  });

  await test('rejects paths outside the current scan', () => {
    const result = authorizeVscodeProject(scanCache, {
      path: 'D:\\work\\outside',
      targetId: 'windows',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 404);
    assert.strictEqual(result.code, 'project-not-found');
  });

  await test('rejects launch requests before a scan is available', () => {
    const result = authorizeVscodeProject(null, {
      path: windowsRepo.path,
      targetId: windowsRepo.targetId,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 409);
    assert.strictEqual(result.code, 'no-scan');
  });

  await test('rejects a matching path with a different targetId', () => {
    const result = authorizeVscodeProject(scanCache, {
      path: windowsRepo.path,
      targetId: 'wrong-target',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 409);
    assert.strictEqual(result.code, 'target-mismatch');
  });

  await test('keeps Linux path case significant while normalizing the WSL host and distro', () => {
    assert.strictEqual(
      normalizeProjectPath('\\\\WSL.LOCALHOST\\ubuntu\\home\\dev\\Repo'),
      'wsl:ubuntu:/home/dev/Repo'
    );
    assert.notStrictEqual(
      normalizeProjectPath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\Repo'),
      normalizeProjectPath('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo')
    );
  });

  await test('rejects command, executable, and args fields', () => {
    for (const field of ['command', 'executable', 'args']) {
      const body = { path: windowsRepo.path, targetId: windowsRepo.targetId, [field]: 'anything' };
      const result = authorizeVscodeProject(scanCache, body);
      assert.strictEqual(result.ok, false, field);
      assert.strictEqual(result.code, 'unsupported-fields', field);
    }
  });

  await test('spawns the fixed executable with one path argument and no shell', async () => {
    const records = [];
    const result = await launchProjectInVscode(windowsRepo.path, {
      resolveExecutable: async () => 'C:\\VSCode\\Code.exe',
      spawnImpl: fakeSpawnRecorder(records),
    });
    assert.deepStrictEqual(result.args, [windowsRepo.path]);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].executable, 'C:\\VSCode\\Code.exe');
    assert.deepStrictEqual(records[0].args, [windowsRepo.path]);
    assert.deepStrictEqual(records[0].options, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
  });

  await test('reports code-not-found without spawning', async () => {
    let spawnCalled = false;
    await assert.rejects(
      launchProjectInVscode(windowsRepo.path, {
        resolveExecutable: async () => {
          const error = new Error('not found');
          error.code = 'code-not-found';
          throw error;
        },
        spawnImpl: () => { spawnCalled = true; },
      }),
      (error) => error.code === 'code-not-found'
    );
    assert.strictEqual(spawnCalled, false);
  });

  await test('maps a missing spawned executable to code-not-found', async () => {
    await assert.rejects(
      launchProjectInVscode(windowsRepo.path, {
        resolveExecutable: async () => 'code',
        spawnImpl: fakeSpawnRecorder([], 'error', 'ENOENT'),
      }),
      (error) => error.code === 'code-not-found' &&
        !error.message.includes(windowsRepo.path)
    );
  });

  await test('maps other spawn failures to launch-failed without exposing the path', async () => {
    await assert.rejects(
      launchProjectInVscode(windowsRepo.path, {
        resolveExecutable: async () => 'C:\\VSCode\\Code.exe',
        spawnImpl: fakeSpawnRecorder([], 'error', 'EACCES'),
      }),
      (error) => error.code === 'launch-failed' &&
        !error.message.includes(windowsRepo.path)
    );
  });

  await test('opens a scanned WSL project through a fixed Remote WSL folder URI', async () => {
    const authorization = authorizeVscodeProject(scanCache, {
      path: wslRepo.path,
      targetId: wslRepo.targetId,
    });
    assert.strictEqual(authorization.ok, true);
    const records = [];
    await launchProjectInVscode(authorization.project.path, {
      resolveExecutable: async () => 'C:\\VSCode\\Code.exe',
      spawnImpl: fakeSpawnRecorder(records),
    });
    assert.deepStrictEqual(records[0].args, [
      '--folder-uri',
      'vscode-remote://wsl+Ubuntu/home/user/projects/sample-project',
    ]);
    assert.deepStrictEqual(buildVscodeArguments(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev user\\repo #1'
    ), [
      '--folder-uri',
      'vscode-remote://wsl+Ubuntu-24.04/home/dev%20user/repo%20%231',
    ]);
  });

  await test('opens a generated Windows workspace in a new window with no shell', async () => {
    const records = [];
    const workspacePath = 'D:\\workbench\\data\\generated-workspaces\\alpha.code-workspace';
    await launchWorkspaceInVscode(workspacePath, windowsRepo.path, {
      resolveExecutable: async () => 'C:\\VSCode\\Code.exe',
      spawnImpl: fakeSpawnRecorder(records),
    });
    assert.deepStrictEqual(records[0], {
      executable: 'C:\\VSCode\\Code.exe',
      args: ['--new-window', workspacePath],
      options: { detached: true, stdio: 'ignore', shell: false },
    });
  });

  await test('maps a generated workspace into WSL and opens it with a fixed authority', async () => {
    const records = [];
    const execRecords = [];
    const workspacePath = 'D:\\workbench\\data\\generated-workspaces\\wsl.code-workspace';
    await launchWorkspaceInVscode(workspacePath, wslRepo.path, {
      resolveExecutable: async () => 'C:\\VSCode\\Code.exe',
      execFileImpl: async (file, args, options) => {
        execRecords.push({ file, args, options });
        return { stdout: '/mnt/d/workbench/data/generated-workspaces/wsl.code-workspace\n' };
      },
      spawnImpl: fakeSpawnRecorder(records),
    });
    assert.deepStrictEqual(execRecords[0].args, [
      '-d', 'Ubuntu', '--', 'wslpath', '-a', '-u',
      'D:/workbench/data/generated-workspaces/wsl.code-workspace',
    ]);
    assert.deepStrictEqual(records[0].args, [
      '--new-window', '--remote', 'wsl+Ubuntu',
      '/mnt/d/workbench/data/generated-workspaces/wsl.code-workspace',
    ]);
    assert.strictEqual(records[0].options.shell, false);
  });

  await test('reports WSL workspace conversion failures separately', async () => {
    await assert.rejects(
      buildWorkspaceLaunchArguments('D:\\workbench\\session.code-workspace', wslRepo.path, {
        execFileImpl: async () => { throw new Error('missing distro'); },
      }),
      (error) => error.code === 'wsl-workspace-path-failed' && !error.message.includes(wslRepo.path)
    );
  });

  await test('reports a missing fixed VS Code executable for workspace launches', async () => {
    await assert.rejects(
      launchWorkspaceInVscode('D:\\workbench\\session.code-workspace', windowsRepo.path, {
        resolveExecutable: async () => {
          const error = new Error('missing');
          error.code = 'code-not-found';
          throw error;
        },
        spawnImpl: () => { throw new Error('must not spawn'); },
      }),
      (error) => error.code === 'code-not-found'
    );
  });

  await test('reports code-not-found when no fixed Windows install path exists', async () => {
    await assert.rejects(
      resolveVscodeExecutable({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
        access: async () => { throw new Error('missing'); },
      }),
      (error) => error.code === 'code-not-found'
    );
  });

  console.log(`\n${count} VSCode launcher tests, ${process.exitCode ? 'FAILED' : 'all passed'}`);
})();
