'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  DevelopmentSessionStore,
  RecentLaunchGuard,
  buildProjectIdentity,
  buildWorkspaceDocument,
  diagnoseProjectMatch,
  findProjectConfig,
  generatedWorkspacePath,
  loadDevelopmentSessions,
  loadDevelopmentSessionsDiagnostic,
  locateJsonParseError,
  publicProjectSession,
  resolveConfiguredSelection,
  validateDevelopmentSessions,
  validateStartRequest,
  writeGeneratedWorkspace,
  AsyncMutex,
  availablePresetsForProject,
  isLoopbackAddress,
  readRawConfigForUpdate,
  registerPresetProject,
  validateRegisterPresetRequest,
  writeConfigFileAtomic,
} = require('../lib/development-sessions');

const windowsProject = {
  name: 'alpha project',
  path: 'D:\\work\\alpha project',
  targetId: 'windows',
  kind: 'repo',
};
const wslProject = {
  name: 'sample-project',
  path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev user\\sample-project',
  targetId: 'wsl-private',
  kind: 'repo',
};
const scanCache = { repos: [windowsProject, wslProject] };

function validConfig(project = windowsProject) {
  return {
    version: 1,
    projects: [{
      targetId: project.targetId,
      path: project.path,
      defaultProfileId: 'default',
      profiles: [{
        id: 'default',
        label: 'Default development',
        items: [
          {
            id: 'claude', label: 'Claude Code', kind: 'agent', enabledByDefault: true,
            command: 'claude', args: ['--model', 'sonnet'], cwd: '.',
          },
          {
            id: 'codex', label: 'Codex', kind: 'agent', enabledByDefault: false,
            command: 'codex', args: [], cwd: 'tools/cli',
          },
          {
            id: 'dev-server', label: 'Dev server', kind: 'process', enabledByDefault: true,
            command: 'npm', args: ['start'], cwd: '.',
          },
        ],
      }],
    }],
  };
}

// version 2（起動プリセット方式）のfixture。windows-ai/wsl-aiという2つの
// presetを持ち、windowsProjectがwindows-aiを参照する最小構成
function validConfigV2() {
  return {
    version: 2,
    presets: [
      {
        id: 'windows-ai',
        label: 'AI開発 Windows',
        platform: 'windows',
        items: [
          { id: 'claude', label: 'Claude Code', kind: 'agent', enabledByDefault: true, command: 'claude', args: ['--model', 'sonnet'], cwd: '.' },
          { id: 'codex', label: 'Codex', kind: 'agent', enabledByDefault: false, command: 'codex', args: [], cwd: '.' },
        ],
      },
      {
        id: 'wsl-ai',
        label: 'AI開発 WSL',
        platform: 'wsl',
        items: [
          { id: 'shell', label: 'WSL shell', kind: 'process', enabledByDefault: true, command: 'bash', args: ['-l'], cwd: '.' },
          { id: 'claude', label: 'Claude Code', kind: 'agent', enabledByDefault: true, command: 'claude', args: [], cwd: '.' },
        ],
      },
    ],
    projects: [
      { targetId: windowsProject.targetId, path: windowsProject.path, presetId: 'windows-ai', additionalItems: [] },
    ],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// details は Phase 4 で構造化issue（{ path, code, message, hint }）になった。
// expectedCode は detail.code と照合する
function expectValidationError(mutator, expectedCode) {
  const config = clone(validConfig());
  mutator(config);
  assert.throws(
    () => validateDevelopmentSessions(config),
    (error) => error.code === 'config-validation-error' &&
      error.details.some((detail) => detail.code === expectedCode) &&
      error.details.every((detail) =>
        typeof detail.path === 'string' &&
        typeof detail.code === 'string' &&
        typeof detail.message === 'string' &&
        (detail.hint === null || typeof detail.hint === 'string'))
  );
}

function expectValidationErrorV2(mutator, expectedCode) {
  const config = clone(validConfigV2());
  mutator(config);
  assert.throws(
    () => validateDevelopmentSessions(config),
    (error) => error.code === 'config-validation-error' &&
      error.details.some((detail) => detail.code === expectedCode),
    expectedCode
  );
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
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'awb-development-sessions-'));
  try {
    await test('reports a missing local configuration file', async () => {
      const loaded = await loadDevelopmentSessions(path.join(tempRoot, 'missing.json'));
      assert.strictEqual(loaded.status, 'missing');
      assert.strictEqual(loaded.config, null);
    });

    await test('loads and normalizes a valid version 1 schema', async () => {
      const file = path.join(tempRoot, 'valid.json');
      await fsp.writeFile(file, JSON.stringify(validConfig()), 'utf8');
      const store = new DevelopmentSessionStore(file);
      const loaded = await store.get();
      assert.strictEqual(loaded.status, 'loaded');
      assert.strictEqual(loaded.config.projects[0].profiles[0].items.length, 3);
      assert.strictEqual((await store.reload()).status, 'loaded');
    });

    await test('reports JSON parse errors separately', async () => {
      const file = path.join(tempRoot, 'broken.json');
      await fsp.writeFile(file, '{ nope', 'utf8');
      await assert.rejects(loadDevelopmentSessions(file), (error) => error.code === 'config-parse-error');
    });

    await test('rejects unsupported versions and unknown fields', () => {
      // version 2 は起動プリセット方式の別schemaとして正式にサポートしたため、
      // ここでは両方のschemaに合致しない値でinvalid-versionを確認する
      expectValidationError((config) => { config.version = 3; }, 'invalid-version');
      expectValidationError((config) => { delete config.version; }, 'invalid-version');
      expectValidationError((config) => { config.extra = true; }, 'unknown-field');
    });

    await test('rejects duplicate projects, profiles, and item IDs', () => {
      expectValidationError((config) => { config.projects.push(clone(config.projects[0])); }, 'duplicate-project');
      expectValidationError((config) => {
        config.projects[0].profiles.push(clone(config.projects[0].profiles[0]));
      }, 'duplicate-profile-id');
      expectValidationError((config) => {
        config.projects[0].profiles[0].items.push(clone(config.projects[0].profiles[0].items[0]));
      }, 'duplicate-item-id');
    });

    await test('rejects invalid command and args types', () => {
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].command = ['claude']; }, 'invalid-command');
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].args = '--help'; }, 'invalid-args');
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].args = [1]; }, 'invalid-args');
    });

    await test('rejects absolute cwd and parent traversal', () => {
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].cwd = 'C:\\temp'; }, 'invalid-cwd');
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].cwd = '/tmp'; }, 'invalid-cwd');
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].cwd = '../outside'; }, 'invalid-cwd');
    });

    await test('rejects invalid kind, enabledByDefault, and secret/env fields', () => {
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].kind = 'shell'; }, 'invalid-kind');
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].enabledByDefault = 'yes'; }, 'invalid-enabled-by-default');
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].env = { API_KEY: 'secret' }; }, 'forbidden-field');
    });

    await test('rejects missing defaultProfileId and a profileId that matches no profile', () => {
      expectValidationError((config) => { delete config.projects[0].defaultProfileId; }, 'missing-default-profile');
      expectValidationError((config) => { config.projects[0].defaultProfileId = 'nope'; }, 'default-profile-not-found');
    });

    await test('rejects an unedited placeholder command', () => {
      expectValidationError((config) => { config.projects[0].profiles[0].items[0].command = 'EDIT_ME'; }, 'placeholder-command');
    });

    await test('every issue has a JSON path, short code, human message, and optional hint', () => {
      const config = clone(validConfig());
      delete config.projects[0].defaultProfileId;
      config.extra = true;
      try {
        validateDevelopmentSessions(config);
        assert.fail('expected validation to throw');
      } catch (error) {
        assert.strictEqual(error.details.length >= 2, true);
        for (const detail of error.details) {
          assert.strictEqual(typeof detail.path, 'string');
          assert.ok(detail.path.length > 0);
          assert.strictEqual(typeof detail.code, 'string');
          assert.strictEqual(typeof detail.message, 'string');
          assert.ok(!detail.message.includes('at Object'), 'must not leak a stack trace');
        }
      }
    });

    // ---- schema v2 (起動プリセット) ---------------------------------------

    await test('loads a valid version 2 preset schema and expands project items', () => {
      const config = validateDevelopmentSessions(validConfigV2());
      assert.strictEqual(config.version, 2);
      assert.strictEqual(config.presets.length, 2);
      const projectConfig = findProjectConfig(config, windowsProject);
      assert.ok(projectConfig);
      assert.strictEqual(projectConfig.presetId, 'windows-ai');
      assert.strictEqual(projectConfig.presetLabel, 'AI開発 Windows');
      assert.strictEqual(projectConfig.profiles[0].items.length, 2);
      assert.strictEqual(projectConfig.profiles[0].items[0].command, 'claude');
    });

    await test('rejects duplicate preset IDs', () => {
      expectValidationErrorV2((config) => { config.presets.push(clone(config.presets[0])); }, 'duplicate-preset-id');
    });

    await test('rejects an invalid preset platform', () => {
      expectValidationErrorV2((config) => { config.presets[0].platform = 'mac'; }, 'invalid-platform');
    });

    await test('rejects duplicate preset item IDs', () => {
      expectValidationErrorV2((config) => {
        config.presets[0].items.push(clone(config.presets[0].items[0]));
      }, 'duplicate-item-id');
    });

    await test('rejects a project referencing an undefined preset', () => {
      expectValidationErrorV2((config) => { config.projects[0].presetId = 'does-not-exist'; }, 'preset-not-found');
    });

    await test('rejects a Windows project referencing a WSL-only preset and vice versa', () => {
      expectValidationErrorV2((config) => { config.projects[0].presetId = 'wsl-ai'; }, 'platform-mismatch');
      expectValidationErrorV2((config) => {
        config.projects.push({ targetId: wslProject.targetId, path: wslProject.path, presetId: 'windows-ai', additionalItems: [] });
      }, 'platform-mismatch');
    });

    await test('allows platform: any presets for both Windows and WSL projects', () => {
      const config = clone(validConfigV2());
      config.presets.push({
        id: 'shell-any', label: 'Shell', platform: 'any',
        items: [{ id: 'shell', label: 'Shell', kind: 'process', enabledByDefault: true, command: 'EDIT_ME', args: [], cwd: '.' }],
      });
      config.projects.push({ targetId: wslProject.targetId, path: wslProject.path, presetId: 'shell-any', additionalItems: [] });
      // EDIT_ME自体は別issue（placeholder-command）になるため、それだけを許容して検証する
      assert.throws(
        () => validateDevelopmentSessions(config),
        (error) => error.details.every((d) => d.code === 'placeholder-command')
      );
    });

    await test('accepts valid additionalItems and combines them with preset items in order', () => {
      const config = clone(validConfigV2());
      config.projects[0].additionalItems = [
        { id: 'dev-server', label: 'Dev server', kind: 'process', enabledByDefault: true, command: 'npm', args: ['start'], cwd: '.' },
      ];
      const validated = validateDevelopmentSessions(config);
      const projectConfig = findProjectConfig(validated, windowsProject);
      assert.strictEqual(projectConfig.profiles[0].items.length, 3);
      assert.strictEqual(projectConfig.profiles[0].items[2].id, 'dev-server');
      // 設定情報表示用に、どのitemがadditionalItems由来かを追跡できる
      assert.deepStrictEqual(projectConfig.additionalItemIds, ['dev-server']);
      const session = publicProjectSession(projectConfig);
      assert.deepStrictEqual(session.additionalItemIds, ['dev-server']);
      assert.strictEqual(session.presetId, 'windows-ai');
      assert.strictEqual(session.presetLabel, 'AI開発 Windows');
    });

    await test('rejects an additionalItem ID that collides with a preset item ID', () => {
      expectValidationErrorV2((config) => {
        config.projects[0].additionalItems = [
          { id: 'claude', label: 'dup', kind: 'process', enabledByDefault: true, command: 'echo', args: [], cwd: '.' },
        ];
      }, 'additional-item-collision');
    });

    await test('accepts itemOverrides limited to enabledByDefault on an existing preset item', () => {
      const config = clone(validConfigV2());
      config.projects[0].itemOverrides = { codex: { enabledByDefault: true } };
      const validated = validateDevelopmentSessions(config);
      const projectConfig = findProjectConfig(validated, windowsProject);
      const codex = projectConfig.profiles[0].items.find((item) => item.id === 'codex');
      assert.strictEqual(codex.enabledByDefault, true);
    });

    await test('rejects itemOverrides referencing an unknown preset item or a non-enabledByDefault field', () => {
      expectValidationErrorV2((config) => {
        config.projects[0].itemOverrides = { 'no-such-item': { enabledByDefault: true } };
      }, 'item-override-unknown-item');
      expectValidationErrorV2((config) => {
        config.projects[0].itemOverrides = { codex: { command: 'echo' } };
      }, 'unknown-field');
      expectValidationErrorV2((config) => {
        config.projects[0].itemOverrides = { codex: { enabledByDefault: 'yes' } };
      }, 'invalid-enabled-by-default');
    });

    await test('rejects unknown top-level and project-level fields in version 2', () => {
      expectValidationErrorV2((config) => { config.extra = true; }, 'unknown-field');
      expectValidationErrorV2((config) => { config.projects[0].profiles = []; }, 'unknown-field');
    });

    await test('rejects forbidden secret/env fields on version 2 preset items', () => {
      expectValidationErrorV2((config) => { config.presets[0].items[0].env = { KEY: 'x' }; }, 'forbidden-field');
    });

    await test('matches configured projects by targetId and absolute path, not by name', () => {
      const config = validateDevelopmentSessions(validConfig());
      assert.ok(findProjectConfig(config, { ...windowsProject, name: 'renamed display' }));
      assert.strictEqual(findProjectConfig(config, { ...windowsProject, targetId: 'other' }), null);
    });

    await test('returns safe display data without exposing executable request controls', () => {
      const config = validateDevelopmentSessions(validConfig());
      const summary = publicProjectSession(config.projects[0]);
      assert.strictEqual(summary.defaultProfileId, 'default');
      assert.strictEqual(summary.profiles[0].items[0].displayCommand, 'claude --model sonnet');
      assert.strictEqual('args' in summary.profiles[0].items[0], false);
      assert.strictEqual('command' in summary.profiles[0].items[0], false);
    });

    await test('authorizes only scanned path/target/profile/item identifier requests', () => {
      const project = validateStartRequest(scanCache, {
        path: windowsProject.path, targetId: windowsProject.targetId,
        profileId: 'default', itemIds: ['claude', 'codex'],
      });
      assert.strictEqual(project, windowsProject);
      for (const field of ['command', 'args', 'cwd', 'executable', 'extra']) {
        assert.throws(
          () => validateStartRequest(scanCache, {
            path: windowsProject.path, targetId: windowsProject.targetId,
            profileId: 'default', itemIds: ['claude'], [field]: 'blocked',
          }),
          (error) => error.code === 'unsupported-fields',
          field
        );
      }
    });

    await test('rejects unscanned projects, target mismatch, empty and duplicate items', () => {
      assert.throws(() => validateStartRequest(scanCache, {
        path: 'D:\\work\\outside', targetId: 'windows', profileId: 'default', itemIds: ['claude'],
      }), (error) => error.code === 'project-not-found');
      assert.throws(() => validateStartRequest(scanCache, {
        path: windowsProject.path, targetId: 'wrong', profileId: 'default', itemIds: ['claude'],
      }), (error) => error.code === 'target-mismatch');
      assert.throws(() => validateStartRequest(scanCache, {
        path: windowsProject.path, targetId: 'windows', profileId: 'default', itemIds: [],
      }), (error) => error.code === 'no-items');
      assert.throws(() => validateStartRequest(scanCache, {
        path: windowsProject.path, targetId: 'windows', profileId: 'default', itemIds: ['claude', 'claude'],
      }), (error) => error.code === 'duplicate-items');
    });

    await test('rejects unknown profiles and items after server-side configuration lookup', () => {
      const config = validateDevelopmentSessions(validConfig());
      assert.throws(
        () => resolveConfiguredSelection(config, windowsProject, 'missing', ['claude']),
        (error) => error.code === 'profile-not-found'
      );
      assert.throws(
        () => resolveConfiguredSelection(config, windowsProject, 'default', ['missing']),
        (error) => error.code === 'item-not-found'
      );
      assert.throws(
        () => resolveConfiguredSelection(config, wslProject, 'default', ['claude']),
        (error) => error.code === 'project-not-configured'
      );
    });

    await test('builds separate Windows process tasks with dedicated terminals and safe cwd', () => {
      const config = validateDevelopmentSessions(validConfig());
      const selection = resolveConfiguredSelection(config, windowsProject, 'default', ['claude', 'codex']);
      const workspace = buildWorkspaceDocument(windowsProject, selection.profile, selection.items);
      assert.deepStrictEqual(workspace.folders, [{ name: 'alpha project', path: windowsProject.path }]);
      assert.strictEqual(workspace.tasks.tasks.length, 2);
      assert.strictEqual(workspace.tasks.tasks[0].type, 'process');
      assert.strictEqual(workspace.tasks.tasks[0].command, 'claude');
      assert.deepStrictEqual(workspace.tasks.tasks[0].args, ['--model', 'sonnet']);
      assert.strictEqual(workspace.tasks.tasks[0].options.cwd, '${workspaceFolder}');
      assert.strictEqual(workspace.tasks.tasks[1].options.cwd, '${workspaceFolder}/tools/cli');
      assert.strictEqual(workspace.tasks.tasks[0].presentation.panel, 'dedicated');
      assert.strictEqual(workspace.tasks.tasks[0].runOptions.runOn, 'folderOpen');
      assert.strictEqual(workspace.tasks.tasks[0].runOptions.instanceLimit, 1);
      assert.strictEqual(JSON.stringify(workspace).includes('"type":"shell"'), false);
    });

    await test('builds a Remote WSL folder URI and Linux-side process tasks', () => {
      const config = validateDevelopmentSessions(validConfig(wslProject));
      const selection = resolveConfiguredSelection(config, wslProject, 'default', ['claude']);
      const workspace = buildWorkspaceDocument(wslProject, selection.profile, selection.items);
      assert.deepStrictEqual(workspace.folders, [{
        name: 'sample-project',
        uri: 'vscode-remote://wsl+Ubuntu-24.04/home/dev%20user/sample-project',
      }]);
      assert.strictEqual(workspace.tasks.tasks[0].command, 'claude');
      assert.strictEqual(workspace.tasks.tasks[0].type, 'process');
    });

    await test('writes stable generated workspaces below data without touching project repos', async () => {
      const generatedRoot = path.join(tempRoot, 'data', 'generated-workspaces');
      const config = validateDevelopmentSessions(validConfig());
      const selection = resolveConfiguredSelection(config, windowsProject, 'default', ['dev-server']);
      const beforeExists = fs.existsSync(windowsProject.path);
      const written = await writeGeneratedWorkspace(generatedRoot, windowsProject, selection.profile, selection.items);
      assert.strictEqual(written.workspacePath, generatedWorkspacePath(generatedRoot, windowsProject, 'default'));
      assert.ok(path.resolve(written.workspacePath).startsWith(path.resolve(generatedRoot) + path.sep));
      assert.ok(fs.existsSync(written.workspacePath));
      assert.strictEqual(fs.existsSync(windowsProject.path), beforeExists);
      const parsed = JSON.parse(await fsp.readFile(written.workspacePath, 'utf8'));
      assert.strictEqual(parsed.tasks.tasks[0].command, 'npm');
      assert.deepStrictEqual(parsed.tasks.tasks[0].args, ['start']);
    });

    await test('builds a safe project identity from scan data only', () => {
      assert.deepStrictEqual(buildProjectIdentity(windowsProject), {
        targetLabel: 'windows',
        targetId: 'windows',
        path: windowsProject.path,
      });
      assert.deepStrictEqual(
        buildProjectIdentity({ targetId: 'wsl_claude_private', targetLabel: 'wsl private', path: wslProject.path }),
        { targetLabel: 'wsl private', targetId: 'wsl_claude_private', path: wslProject.path }
      );
    });

    await test('locates JSON parse errors by line and column when possible', () => {
      const broken = '{\n  "version": 1,\n  "projects": [\n    { "targetId": }\n  ]\n}';
      let parseError;
      try { JSON.parse(broken); } catch (error) { parseError = error; }
      const located = locateJsonParseError(broken, parseError);
      assert.strictEqual(typeof located.message, 'string');
      if (located.line != null) {
        assert.strictEqual(located.line >= 1, true);
        assert.strictEqual(located.column >= 1, true);
      }
    });

    await test('diagnostic loader reports missing, valid, JSON-invalid, and schema-invalid states without throwing', async () => {
      const missing = await loadDevelopmentSessionsDiagnostic(path.join(tempRoot, 'diag-missing.json'));
      assert.strictEqual(missing.status, 'missing');

      const validFile = path.join(tempRoot, 'diag-valid.json');
      await fsp.writeFile(validFile, JSON.stringify(validConfig()), 'utf8');
      const valid = await loadDevelopmentSessionsDiagnostic(validFile);
      assert.strictEqual(valid.status, 'valid');
      assert.strictEqual(valid.issues.length, 0);
      assert.strictEqual(valid.projects[0].targetId, windowsProject.targetId);

      const parseErrorFile = path.join(tempRoot, 'diag-parse-error.json');
      await fsp.writeFile(parseErrorFile, '{ "version": 1, "projects": [ { "targetId": } ] }', 'utf8');
      const parseInvalid = await loadDevelopmentSessionsDiagnostic(parseErrorFile);
      assert.strictEqual(parseInvalid.status, 'invalid');
      assert.strictEqual(parseInvalid.issues[0].code, 'json-parse-error');
      assert.strictEqual(typeof parseInvalid.issues[0].message, 'string');

      const schemaInvalidFile = path.join(tempRoot, 'diag-schema-invalid.json');
      const broken = clone(validConfig());
      delete broken.projects[0].defaultProfileId;
      await fsp.writeFile(schemaInvalidFile, JSON.stringify(broken), 'utf8');
      const schemaInvalid = await loadDevelopmentSessionsDiagnostic(schemaInvalidFile);
      assert.strictEqual(schemaInvalid.status, 'invalid');
      assert.ok(schemaInvalid.issues.some((detail) => detail.code === 'missing-default-profile'));
      // best-effort: targetId/path are still readable even though the file is invalid
      assert.strictEqual(schemaInvalid.projects[0].targetId, windowsProject.targetId);
    });

    await test('distinguishes not-configured, configured, target-id mismatch, path mismatch, and invalid states', () => {
      const missingFileDiag = { status: 'missing', issues: [], projects: [] };
      assert.deepStrictEqual(
        diagnoseProjectMatch(missingFileDiag, windowsProject),
        { state: 'not-configured', reason: 'missing-file' }
      );

      const validDiag = { status: 'valid', issues: [], projects: [
        { targetId: windowsProject.targetId, path: windowsProject.path, defaultProfileId: 'default', profiles: [] },
      ] };
      assert.deepStrictEqual(diagnoseProjectMatch(validDiag, windowsProject), { state: 'configured' });

      const unrelatedDiag = { status: 'valid', issues: [], projects: [
        { targetId: 'other', path: 'D:\\work\\elsewhere', defaultProfileId: 'default', profiles: [] },
      ] };
      assert.deepStrictEqual(diagnoseProjectMatch(unrelatedDiag, windowsProject), {
        state: 'not-configured', reason: 'project-not-configured',
      });

      // typoの再現: 表示labelをtargetIdとして使ってしまったケース（path一致、targetId不一致）
      const labelUsedAsIdDiag = { status: 'valid', issues: [], projects: [
        { targetId: 'wsl private', path: wslProject.path, defaultProfileId: 'default', profiles: [] },
      ] };
      const targetIdMismatch = diagnoseProjectMatch(labelUsedAsIdDiag, { ...wslProject, targetLabel: 'wsl private' });
      assert.strictEqual(targetIdMismatch.state, 'target-id-mismatch');
      assert.strictEqual(targetIdMismatch.configuredTargetId, 'wsl private');
      assert.strictEqual(targetIdMismatch.looksLikeLabel, true);

      // 同じtargetIdに属する「別project」の設定があるだけではpath-mismatchに
      // しない（repo-directories型targetでは同じtargetIdに多数のprojectが属する。
      // 例: sample-workspace配下でsample-projectが設定済みでも、未設定の
      // agent-workbenchをpath-mismatchと誤診断してはいけない）
      const sameTargetDifferentProjectDiag = { status: 'valid', issues: [], projects: [
        { targetId: windowsProject.targetId, path: 'D:\\work\\some-other-project', defaultProfileId: 'default', profiles: [] },
      ] };
      assert.deepStrictEqual(diagnoseProjectMatch(sameTargetDifferentProjectDiag, windowsProject), {
        state: 'not-configured', reason: 'project-not-configured',
      });

      // 真にpath-mismatchと判定できるのは、設定pathの末尾セグメント（repo
      // ディレクトリ名）が閲覧中projectの名前と一致する場合だけ（= 同じproject が
      // 別の場所へ移動したとみなせる根拠がある場合）
      const genuinePathMismatchDiag = { status: 'valid', issues: [], projects: [
        { targetId: windowsProject.targetId, path: 'D:\\work\\old-location\\alpha project', defaultProfileId: 'default', profiles: [] },
      ] };
      const pathMismatch = diagnoseProjectMatch(genuinePathMismatchDiag, windowsProject);
      assert.strictEqual(pathMismatch.state, 'path-mismatch');
      assert.strictEqual(pathMismatch.configuredPath, 'D:\\work\\old-location\\alpha project');

      const invalidNoMatchDiag = { status: 'invalid', issues: [{ path: 'projects[0]', code: 'x', message: 'x', hint: null }], projects: [] };
      assert.deepStrictEqual(diagnoseProjectMatch(invalidNoMatchDiag, windowsProject), {
        state: 'invalid', issues: invalidNoMatchDiag.issues,
      });
    });

    await test('a configured sibling project under the same repo-directories target does not become path-mismatch', () => {
      // 実際のバグ再現: sample-workspace target配下でsample-projectだけ設定済みの
      // 場合、同じtargetの未設定projectであるagent-workbenchはnot-configuredに
      // なるべきで、sample-projectのpathをconfigured pathとして警告してはいけない
      const agentWorkbench = { name: 'agent-workbench', path: 'C:\\workspaces\\sample-workspace\\agent-workbench', targetId: 'sample-workspace', kind: 'repo' };
      const diag = { status: 'valid', issues: [], projects: [
        { targetId: 'sample-workspace', path: 'C:\\workspaces\\sample-workspace\\sample-project', defaultProfileId: 'default', profiles: [] },
      ] };
      assert.deepStrictEqual(diagnoseProjectMatch(diag, agentWorkbench), {
        state: 'not-configured', reason: 'project-not-configured',
      });
    });

    await test('surfaces a target-id mismatch hint even when the overall file is schema-invalid', () => {
      // 設定全体はinvalid（別projectのdefaultProfileId欠落）だが、閲覧中projectは
      // path一致・targetId不一致なので、危険な部分実行なしにmismatchヒントを出せる
      const issues = [{ path: 'projects[1].defaultProfileId', code: 'missing-default-profile', message: 'x', hint: null }];
      const mixedDiag = { status: 'invalid', issues, projects: [
        { targetId: 'wsl private', path: wslProject.path, defaultProfileId: 'default', profiles: [] },
        { targetId: 'unrelated', path: 'D:\\work\\other', defaultProfileId: undefined, profiles: [] },
      ] };
      const result = diagnoseProjectMatch(mixedDiag, { ...wslProject, targetLabel: 'wsl private' });
      assert.strictEqual(result.state, 'target-id-mismatch');
      assert.strictEqual(result.configuredTargetId, 'wsl private');
    });

    // ---- Phase 6: preset registration (localhost-only, no arbitrary content) --

    await test('availablePresetsForProject filters by platform and hides secrets/commands are still safe display', () => {
      const config = validateDevelopmentSessions(validConfigV2());
      const diagnostic = { presets: config.presets };
      const windowsPresets = availablePresetsForProject(diagnostic, windowsProject);
      assert.deepStrictEqual(windowsPresets.map((p) => p.id), ['windows-ai']);
      const wslPresets = availablePresetsForProject(diagnostic, wslProject);
      assert.deepStrictEqual(wslPresets.map((p) => p.id), ['wsl-ai']);
      assert.strictEqual('command' in windowsPresets[0].items[0], false);
      assert.ok(windowsPresets[0].items[0].displayCommand.includes('claude'));
    });

    await test('validateRegisterPresetRequest only accepts targetId/path/presetId identifiers', () => {
      const result = validateRegisterPresetRequest(scanCache, {
        targetId: windowsProject.targetId, path: windowsProject.path, presetId: 'windows-ai',
      });
      assert.strictEqual(result.project, windowsProject);
      assert.strictEqual(result.presetId, 'windows-ai');
      for (const field of ['command', 'args', 'cwd', 'label', 'kind', 'enabledByDefault', 'additionalItems', 'itemOverrides', 'executable']) {
        assert.throws(
          () => validateRegisterPresetRequest(scanCache, {
            targetId: windowsProject.targetId, path: windowsProject.path, presetId: 'windows-ai', [field]: 'x',
          }),
          (error) => error.code === 'unsupported-fields',
          field
        );
      }
      assert.throws(
        () => validateRegisterPresetRequest(scanCache, { targetId: windowsProject.targetId, path: windowsProject.path, presetId: '' }),
        (error) => error.code === 'invalid-preset-id'
      );
      assert.throws(
        () => validateRegisterPresetRequest(scanCache, { targetId: 'other', path: windowsProject.path, presetId: 'windows-ai' }),
        (error) => error.code === 'target-mismatch'
      );
    });

    await test('registerPresetProject appends a scoped project reference and re-validates the whole config', () => {
      const raw = clone(validConfigV2());
      raw.projects = []; // まだ何も登録されていない状態から
      const nextRaw = registerPresetProject(raw, wslProject, 'wsl-ai');
      assert.strictEqual(nextRaw.projects.length, 1);
      assert.deepStrictEqual(nextRaw.projects[0], {
        targetId: wslProject.targetId, path: wslProject.path, presetId: 'wsl-ai', additionalItems: [],
      });
      // 返り値は実行可能なschemaとして再検証できる
      const validated = validateDevelopmentSessions(nextRaw);
      assert.ok(findProjectConfig(validated, wslProject));
    });

    await test('registerPresetProject rejects a missing config file, wrong version, unknown preset, and duplicates', () => {
      assert.throws(() => registerPresetProject(null, windowsProject, 'windows-ai'), (error) => error.code === 'config-file-missing');
      assert.throws(() => registerPresetProject(validConfig(), windowsProject, 'windows-ai'), (error) => error.code === 'unsupported-version');
      assert.throws(() => registerPresetProject(validConfigV2(), windowsProject, 'no-such-preset'), (error) => error.code === 'preset-not-found');
      assert.throws(() => registerPresetProject(validConfigV2(), windowsProject, 'windows-ai'), (error) => error.code === 'project-already-configured');
    });

    await test('registerPresetProject rejects platform mismatch and an already-invalid config', () => {
      assert.throws(() => registerPresetProject(validConfigV2(), wslProject, 'windows-ai'), (error) => error.code === 'platform-mismatch');
      const brokenRaw = clone(validConfigV2());
      delete brokenRaw.presets[0].label;
      assert.throws(
        () => registerPresetProject(brokenRaw, wslProject, 'wsl-ai'),
        (error) => error.code === 'config-validation-error'
      );
    });

    await test('readRawConfigForUpdate and writeConfigFileAtomic round-trip with a single backup generation and conflict detection', async () => {
      const configFile = path.join(tempRoot, 'atomic-config.json');
      const missing = await readRawConfigForUpdate(configFile);
      assert.strictEqual(missing.raw, null);
      assert.strictEqual(missing.mtimeMs, undefined);

      await writeConfigFileAtomic(configFile, validConfigV2());
      const backupPathAfterFirstWrite = `${configFile}.bak`;
      assert.strictEqual(fs.existsSync(backupPathAfterFirstWrite), false, 'no prior file existed, so no backup is expected yet');

      const loaded = await readRawConfigForUpdate(configFile);
      assert.strictEqual(loaded.raw.version, 2);
      assert.strictEqual(typeof loaded.mtimeMs, 'number');

      const updatedRaw = clone(loaded.raw);
      updatedRaw.projects.push({ targetId: wslProject.targetId, path: wslProject.path, presetId: 'wsl-ai', additionalItems: [] });
      await writeConfigFileAtomic(configFile, updatedRaw, { expectedMtimeMs: loaded.mtimeMs });
      assert.strictEqual(fs.existsSync(backupPathAfterFirstWrite), true, 'the previous version should be backed up once');
      const backupText = await fsp.readFile(backupPathAfterFirstWrite, 'utf8');
      assert.deepStrictEqual(JSON.parse(backupText), loaded.raw);

      const afterSecondWrite = await readRawConfigForUpdate(configFile);
      assert.strictEqual(afterSecondWrite.raw.projects.length, 2);

      // 競合検出: 古いmtimeで再度書こうとすると拒否される（外部変更を想定）
      await assert.rejects(
        writeConfigFileAtomic(configFile, updatedRaw, { expectedMtimeMs: loaded.mtimeMs }),
        (error) => error.code === 'config-conflict'
      );

      // backupが世代を増やし続けていないこと（.bakファイルは1つだけ）
      const bakFiles = fs.readdirSync(tempRoot).filter((name) => name.endsWith('.bak'));
      assert.strictEqual(bakFiles.length, 1);
    });

    await test('writeConfigFileAtomic reports a write failure without leaving a temp file, when the parent directory does not exist', async () => {
      const configFile = path.join(tempRoot, 'no-such-parent-dir', 'config.json');
      await assert.rejects(
        writeConfigFileAtomic(configFile, validConfigV2()),
        (error) => error.code === 'config-write-failed'
      );
      const parentDirExists = fs.existsSync(path.join(tempRoot, 'no-such-parent-dir'));
      assert.strictEqual(parentDirExists, false);
    });

    await test('.gitignore covers the backup files writeConfigFileAtomic and the migration CLI actually produce (dogfooding fix)', () => {
      // 実運用確認で発見: data/development-sessions.json.bak と .v1.bak が
      // .gitignore の対象外になっており、誤ってgit addされうる状態だった
      const { execFileSync } = require('child_process');
      const repoRoot = path.join(__dirname, '..');
      for (const name of ['data/development-sessions.json.bak', 'data/development-sessions.json.v1.bak']) {
        assert.doesNotThrow(
          () => execFileSync('git', ['check-ignore', name], { cwd: repoRoot, stdio: 'pipe' }),
          `${name} should be covered by .gitignore`
        );
      }
    });

    await test('isLoopbackAddress recognizes IPv4/IPv6 localhost and rejects LAN addresses', () => {
      assert.strictEqual(isLoopbackAddress('127.0.0.1'), true);
      assert.strictEqual(isLoopbackAddress('::1'), true);
      assert.strictEqual(isLoopbackAddress('::ffff:127.0.0.1'), true);
      assert.strictEqual(isLoopbackAddress('192.168.1.50'), false);
      assert.strictEqual(isLoopbackAddress('10.0.0.5'), false);
      assert.strictEqual(isLoopbackAddress('::ffff:192.168.1.50'), false);
      assert.strictEqual(isLoopbackAddress(undefined), false);
      assert.strictEqual(isLoopbackAddress(''), false);
    });

    await test('AsyncMutex serializes concurrent run() calls even when one fails', async () => {
      const mutex = new AsyncMutex();
      const order = [];
      const first = mutex.run(async () => {
        order.push('first-start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('first-end');
        throw new Error('first failed');
      });
      const second = mutex.run(async () => {
        order.push('second-start');
        order.push('second-end');
        return 'second-ok';
      });
      await assert.rejects(first, /first failed/);
      assert.strictEqual(await second, 'second-ok');
      assert.deepStrictEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
    });

    await test('suppresses a duplicate project/profile launch for a short window', () => {
      let now = 1000;
      const guard = new RecentLaunchGuard(8000, () => now);
      guard.begin('alpha/default');
      assert.throws(() => guard.begin('alpha/default'), (error) => error.code === 'duplicate-launch');
      guard.begin('alpha/runtime');
      now += 8000;
      guard.begin('alpha/default');
    });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }

  console.log(`\n${count} development session tests, ${process.exitCode ? 'FAILED' : 'all passed'}`);
})();
