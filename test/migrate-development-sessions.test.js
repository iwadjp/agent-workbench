'use strict';

const assert = require('assert');
const {
  derivePresetLabel,
  inferPlatform,
  itemsSignature,
  migrateV1ToV2,
  slugify,
  verifyMigration,
} = require('../lib/migrate-development-sessions');

function claudeItem(overrides = {}) {
  return {
    id: 'claude', label: 'Claude Code', kind: 'agent', enabledByDefault: true,
    command: 'claude', args: ['--model', 'sonnet'], cwd: '.', ...overrides,
  };
}
function codexItem(overrides = {}) {
  return {
    id: 'codex', label: 'Codex', kind: 'agent', enabledByDefault: false,
    command: 'codex', args: [], cwd: '.', ...overrides,
  };
}
function shellItem(overrides = {}) {
  return {
    id: 'shell', label: 'WSL shell', kind: 'process', enabledByDefault: true,
    command: 'bash', args: ['-l'], cwd: '.', ...overrides,
  };
}

function v1Project(targetId, path, items, defaultProfileId = 'default') {
  return {
    targetId,
    path,
    defaultProfileId,
    profiles: [{ id: defaultProfileId, label: 'Default development', items }],
  };
}

let count = 0;
function test(name, fn) {
  count++;
  try {
    fn();
    console.log(`ok ${count} - ${name}`);
  } catch (error) {
    console.error(`not ok ${count} - ${name}`);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

test('slugify produces safe, non-empty, lowercase IDs and falls back when the input has no usable characters', () => {
  assert.strictEqual(slugify('AI開発 Windows', 'fallback'), 'ai-windows');
  assert.strictEqual(slugify('', 'fallback'), 'fallback');
  assert.strictEqual(slugify('!!!', 'fallback'), 'fallback');
});

test('inferPlatform recognizes WSL UNC paths and treats everything else as windows', () => {
  assert.strictEqual(inferPlatform('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'), 'wsl');
  assert.strictEqual(inferPlatform('\\\\wsl$\\Ubuntu\\home\\dev\\repo'), 'wsl');
  assert.strictEqual(inferPlatform('D:\\work\\alpha'), 'windows');
});

test('derivePresetLabel joins item labels mechanically without summarizing or guessing', () => {
  assert.strictEqual(derivePresetLabel([claudeItem(), codexItem()]), 'Claude Code + Codex');
  assert.strictEqual(derivePresetLabel([]), 'Development');
});

test('itemsSignature is stable for identical items and differs when any executable field changes', () => {
  const a = itemsSignature([claudeItem()]);
  const b = itemsSignature([claudeItem()]);
  assert.strictEqual(a, b);
  const c = itemsSignature([claudeItem({ args: ['--model', 'opus'] })]);
  assert.notStrictEqual(a, c);
});

test('migrateV1ToV2 converts a valid v1 config to v2 and reuses one preset for identical items on the same platform', () => {
  const rawV1 = {
    version: 1,
    projects: [
      v1Project('sample-workspace', 'D:\\work\\alpha', [claudeItem(), codexItem()]),
      v1Project('sample-workspace', 'D:\\work\\beta', [claudeItem(), codexItem()]),
      v1Project('wsl-private', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\gamma', [shellItem(), claudeItem()]),
    ],
  };
  const { v2Raw, projectMappings } = migrateV1ToV2(rawV1);
  assert.strictEqual(v2Raw.version, 2);
  // alpha と beta は同じitems・同じplatformなので1つのpresetを共有する
  assert.strictEqual(v2Raw.presets.length, 2);
  const alphaMapping = projectMappings.find((m) => m.path === 'D:\\work\\alpha');
  const betaMapping = projectMappings.find((m) => m.path === 'D:\\work\\beta');
  const gammaMapping = projectMappings.find((m) => m.path.includes('gamma'));
  assert.strictEqual(alphaMapping.presetId, betaMapping.presetId);
  assert.notStrictEqual(alphaMapping.presetId, gammaMapping.presetId);
  const windowsPreset = v2Raw.presets.find((p) => p.id === alphaMapping.presetId);
  assert.strictEqual(windowsPreset.platform, 'windows');
  assert.deepStrictEqual(windowsPreset.items[0], claudeItem());
  const wslPreset = v2Raw.presets.find((p) => p.id === gammaMapping.presetId);
  assert.strictEqual(wslPreset.platform, 'wsl');
});

test('migrateV1ToV2 does not share a preset across platforms even if items happen to be identical', () => {
  const rawV1 = {
    version: 1,
    projects: [
      v1Project('windows-target', 'D:\\work\\alpha', [claudeItem()]),
      v1Project('wsl-target', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\alpha', [claudeItem()]),
    ],
  };
  const { v2Raw, projectMappings } = migrateV1ToV2(rawV1);
  assert.strictEqual(v2Raw.presets.length, 2);
  const windowsMapping = projectMappings.find((m) => m.targetId === 'windows-target');
  const wslMapping = projectMappings.find((m) => m.targetId === 'wsl-target');
  assert.notStrictEqual(windowsMapping.presetId, wslMapping.presetId);
});

test('migrateV1ToV2 losslessly migrates a project whose items match no common shape (kept as its own preset)', () => {
  const rawV1 = {
    version: 1,
    projects: [
  v1Project('sample-workspace', 'D:\\work\\solo', [
        { id: 'shell', label: 'Shell', kind: 'process', enabledByDefault: true, command: 'powershell.exe', args: ['-NoExit'], cwd: '.' },
      ]),
    ],
  };
  const { v2Raw } = migrateV1ToV2(rawV1);
  const verification = verifyMigration(rawV1, v2Raw);
  assert.strictEqual(verification.ok, true);
  assert.deepStrictEqual(verification.mismatches, []);
});

test('verifyMigration reports items-changed if a migrated project ever ends up with different expanded items', () => {
  const rawV1 = { version: 1, projects: [v1Project('sample-workspace', 'D:\\work\\alpha', [claudeItem()])] };
  const { v2Raw } = migrateV1ToV2(rawV1);
  const tampered = JSON.parse(JSON.stringify(v2Raw));
  tampered.presets[0].items[0].args = ['--different'];
  const verification = verifyMigration(rawV1, tampered);
  assert.strictEqual(verification.ok, false);
  assert.strictEqual(verification.mismatches[0].reason, 'items-changed');
});

test('migrateV1ToV2 refuses (migration失敗) to convert a v1 config that is itself invalid, with clear structured issues', () => {
  const brokenRawV1 = {
    version: 1,
    projects: [v1Project('sample-workspace', 'D:\\work\\alpha', [
      { id: 'shell', label: 'Shell', kind: 'process', enabledByDefault: true, command: 'EDIT_ME', args: [], cwd: '.' },
    ])],
  };
  assert.throws(
    () => migrateV1ToV2(brokenRawV1),
    (error) => error.code === 'config-validation-error' &&
      error.details.some((detail) => detail.code === 'placeholder-command')
  );
});

test('migrateV1ToV2 refuses a version 2 input (nothing to migrate)', () => {
  const alreadyV2 = { version: 2, presets: [], projects: [] };
  assert.throws(() => migrateV1ToV2(alreadyV2), /version 1/);
});

console.log(`\n${count} migration tests, ${process.exitCode ? 'FAILED' : 'all passed'}`);
