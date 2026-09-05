'use strict';

// version 1 → version 2（起動プリセット方式）への変換ロジック（純粋関数のみ、I/Oなし）。
// projectごとに埋め込まれていたitemsを、実itemsが完全一致するprojects同士で
// 共有できる起動プリセットへ切り出す。プリセットの名前・itemsは実データから
// 機械的に導出するだけで、command/argsを推測・変更することは一切しない
// （元のitem配列をそのまま1つのpresetへ移すだけ）

const {
  CONFIG_VERSION,
  CONFIG_VERSION_PRESETS,
  validateDevelopmentSessions,
} = require('./development-sessions');

function slugify(text, fallback) {
  const safe = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return safe || fallback;
}

// projectのpathからplatformを判定する（development-sessions.js内の判定基準と
// 同じUNC pattern。ここでは循環require回避のため軽量に再実装する）
function inferPlatform(projectPath) {
  return /^\\\\(wsl\.localhost|wsl\$)\\/i.test(String(projectPath || '')) ? 'wsl' : 'windows';
}

// itemの内容だけ（実行に関わるfieldのみ）で同値判定できる正規化文字列を作る
function itemsSignature(items) {
  return JSON.stringify(items.map((item) => ({
    label: item.label,
    kind: item.kind,
    enabledByDefault: item.enabledByDefault,
    command: item.command,
    args: item.args,
    cwd: item.cwd,
  })));
}

// itemのlabelを連結しただけの、機械的で分かりやすいpreset labelを作る
// （内容を推測・要約したりはしない）
function derivePresetLabel(items) {
  return items.map((item) => item.label).join(' + ') || 'Development';
}

// v1設定（{version:1, projects:[{targetId,path,defaultProfileId,profiles}]}）を
// v2（{version:2, presets:[], projects:[{targetId,path,presetId,additionalItems:[]}]}）へ
// 変換する。全projectの実itemsを1件も変えず、同一items配列を持つproject同士だけ
// 同じpresetを共有する（platformが異なる場合は共有しない）
function migrateV1ToV2(rawV1) {
  const loaded = validateDevelopmentSessions(rawV1);
  if (loaded.version !== CONFIG_VERSION) {
    throw new Error(`入力はversion ${CONFIG_VERSION}ではありません（version: ${loaded.version}）。`);
  }

  const presets = [];
  const presetIdBySignature = new Map(); // `${platform}\n${signature}` -> presetId
  const usedPresetIds = new Set();
  const projectMappings = [];

  for (const project of loaded.projects) {
    const profile = project.profiles.find((entry) => entry.id === project.defaultProfileId) || project.profiles[0];
    const items = profile.items;
    const platform = inferPlatform(project.path);
    const signature = itemsSignature(items);
    const groupKey = `${platform}\n${signature}`;

    let presetId = presetIdBySignature.get(groupKey);
    if (!presetId) {
      const label = derivePresetLabel(items);
      let candidateId = slugify(`${platform}-${label}`, `${platform}-preset`);
      let suffix = 2;
      while (usedPresetIds.has(candidateId)) {
        candidateId = `${slugify(`${platform}-${label}`, `${platform}-preset`)}-${suffix}`;
        suffix += 1;
      }
      presetId = candidateId;
      usedPresetIds.add(presetId);
      presetIdBySignature.set(groupKey, presetId);
      presets.push({
        id: presetId,
        label,
        platform,
        items: items.map((item) => ({
          id: item.id,
          label: item.label,
          kind: item.kind,
          enabledByDefault: item.enabledByDefault,
          command: item.command,
          args: [...item.args],
          cwd: item.cwd,
        })),
      });
    }

    projectMappings.push({
      targetId: project.targetId,
      path: project.path,
      presetId,
    });
  }

  const v2Raw = {
    version: CONFIG_VERSION_PRESETS,
    presets,
    projects: projectMappings.map((mapping) => ({
      targetId: mapping.targetId,
      path: mapping.path,
      presetId: mapping.presetId,
      additionalItems: [],
    })),
  };

  return { v2Raw, projectMappings };
}

// 変換前後で、各projectの展開後items（command/args/cwd/enabledByDefault等）が
// 完全に一致することを確認する。1件でも不一致ならok:falseを返し、
// 呼び出し側は書き込みを行わないこと
function verifyMigration(rawV1, v2Raw) {
  const before = validateDevelopmentSessions(rawV1);
  const after = validateDevelopmentSessions(v2Raw);
  const mismatches = [];

  for (const beforeProject of before.projects) {
    const key = `${beforeProject.targetId}\n${beforeProject.path}`;
    const afterProject = after.projects.find((p) => `${p.targetId}\n${p.path}` === key);
    if (!afterProject) {
      mismatches.push({ targetId: beforeProject.targetId, path: beforeProject.path, reason: 'project-missing-after-migration' });
      continue;
    }
    const beforeProfile = beforeProject.profiles.find((entry) => entry.id === beforeProject.defaultProfileId) || beforeProject.profiles[0];
    const afterProfile = afterProject.profiles.find((entry) => entry.id === afterProject.defaultProfileId) || afterProject.profiles[0];
    const beforeItems = itemsSignature(beforeProfile.items);
    const afterItems = itemsSignature(afterProfile.items);
    if (beforeItems !== afterItems) {
      mismatches.push({
        targetId: beforeProject.targetId,
        path: beforeProject.path,
        reason: 'items-changed',
        before: beforeProfile.items,
        after: afterProfile.items,
      });
    }
  }

  return { ok: mismatches.length === 0, mismatches, before, after };
}

module.exports = {
  derivePresetLabel,
  inferPlatform,
  itemsSignature,
  migrateV1ToV2,
  slugify,
  verifyMigration,
};
