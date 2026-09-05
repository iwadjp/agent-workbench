'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { parseWslUncPath } = require('./scanner');

const execFileAsync = promisify(execFile);

class VscodeLaunchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VscodeLaunchError';
    this.code = code;
  }
}

function normalizeProjectPath(value) {
  const wsl = parseWslUncPath(value);
  if (wsl) return `wsl:${wsl.distro.toLowerCase()}:${wsl.linuxPath}`;
  return path.resolve(value).toLowerCase();
}

function authorizeVscodeProject(scanCache, body) {
  if (!scanCache || !Array.isArray(scanCache.repos)) {
    return { ok: false, status: 409, code: 'no-scan', error: 'No completed scan is available.' };
  }
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return { ok: false, status: 400, code: 'invalid-request', error: 'A project reference is required.' };
  }

  const allowedFields = new Set(['path', 'targetId']);
  const extraFields = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (extraFields.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'unsupported-fields',
      error: 'Only path and targetId are accepted.',
    };
  }
  if (typeof body.path !== 'string' || !body.path ||
      typeof body.targetId !== 'string' || !body.targetId) {
    return {
      ok: false,
      status: 400,
      code: 'invalid-project-reference',
      error: 'Both path and targetId are required.',
    };
  }

  const project = scanCache.repos.find(
    (repo) => normalizeProjectPath(repo.path) === normalizeProjectPath(body.path)
  );
  if (!project || project.kind === 'missing' || project.kind === 'error') {
    return {
      ok: false,
      status: 404,
      code: 'project-not-found',
      error: 'The project is not in the current scan.',
    };
  }
  if (project.targetId !== body.targetId) {
    return {
      ok: false,
      status: 409,
      code: 'target-mismatch',
      error: 'The target does not match the scanned project.',
    };
  }

  return { ok: true, project };
}

async function resolveVscodeExecutable({
  platform = process.platform,
  env = process.env,
  access = fsp.access,
} = {}) {
  if (platform !== 'win32') return 'code';

  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      // Try the next fixed VS Code installation location.
    }
  }

  throw new VscodeLaunchError('code-not-found', 'VS Code command was not found on the server PC.');
}

function buildVscodeArguments(projectPath) {
  const wsl = parseWslUncPath(projectPath);
  if (!wsl) return [projectPath];

  const encodedPath = wsl.linuxPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const folderUri = `vscode-remote://wsl+${encodeURIComponent(wsl.distro)}${encodedPath}`;
  return ['--folder-uri', folderUri];
}

async function launchProjectInVscode(projectPath, {
  spawnImpl = spawn,
  resolveExecutable = resolveVscodeExecutable,
} = {}) {
  const executable = await resolveExecutable();
  const args = buildVscodeArguments(projectPath);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
    } catch (error) {
      reject(new VscodeLaunchError('launch-failed', 'VS Code could not be started on the server PC.'));
      return;
    }

    child.once('error', (error) => {
      const code = error && error.code === 'ENOENT' ? 'code-not-found' : 'launch-failed';
      const message = code === 'code-not-found'
        ? 'VS Code command was not found on the server PC.'
        : 'VS Code could not be started on the server PC.';
      reject(new VscodeLaunchError(code, message));
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ executable: 'code', args });
    });
  });
}

async function resolveWslWorkspacePath(workspacePath, distro, {
  execFileImpl = execFileAsync,
} = {}) {
  try {
    const result = await execFileImpl(
      'wsl.exe',
      ['-d', distro, '--', 'wslpath', '-a', '-u', workspacePath.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 10000, windowsHide: true }
    );
    const linuxPath = String(result.stdout || '').trim();
    if (!linuxPath.startsWith('/')) throw new Error('invalid wslpath output');
    return linuxPath;
  } catch (error) {
    throw new VscodeLaunchError(
      'wsl-workspace-path-failed',
      'The generated workspace could not be mapped into the WSL distribution.'
    );
  }
}

async function buildWorkspaceLaunchArguments(workspacePath, projectPath, options = {}) {
  const wsl = parseWslUncPath(projectPath);
  if (!wsl) {
    if (/^\\\\wsl(?:\.localhost|\$)\\/i.test(projectPath)) {
      throw new VscodeLaunchError('wsl-path-invalid', 'The WSL project path is invalid.');
    }
    return ['--new-window', workspacePath];
  }
  const linuxWorkspacePath = await resolveWslWorkspacePath(workspacePath, wsl.distro, options);
  return ['--new-window', '--remote', `wsl+${wsl.distro}`, linuxWorkspacePath];
}

async function launchWorkspaceInVscode(workspacePath, projectPath, {
  spawnImpl = spawn,
  resolveExecutable = resolveVscodeExecutable,
  execFileImpl = execFileAsync,
} = {}) {
  const executable = await resolveExecutable();
  const args = await buildWorkspaceLaunchArguments(workspacePath, projectPath, { execFileImpl });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, args, {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
    } catch (error) {
      reject(new VscodeLaunchError('launch-failed', 'VS Code could not be started on the server PC.'));
      return;
    }
    child.once('error', (error) => {
      const code = error && error.code === 'ENOENT' ? 'code-not-found' : 'launch-failed';
      reject(new VscodeLaunchError(
        code,
        code === 'code-not-found'
          ? 'VS Code command was not found on the server PC.'
          : 'VS Code could not be started on the server PC.'
      ));
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ executable: 'code', args });
    });
  });
}

module.exports = {
  VscodeLaunchError,
  authorizeVscodeProject,
  normalizeProjectPath,
  resolveVscodeExecutable,
  buildVscodeArguments,
  buildWorkspaceLaunchArguments,
  launchProjectInVscode,
  launchWorkspaceInVscode,
  resolveWslWorkspacePath,
};
