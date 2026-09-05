'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { authorizeVscodeProject, normalizeProjectPath } = require('./vscode-launcher');
const { parseWslUncPath } = require('./scanner');

const CONFIG_VERSION = 1;
const CONFIG_VERSION_PRESETS = 2;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VALID_KINDS = new Set(['agent', 'process']);
const VALID_PLATFORMS = new Set(['windows', 'wsl', 'any']);
// テンプレートのplaceholder値。ひな形コピー後に編集しないまま保存された場合、
// 起動前validationで明確に拒否する（誤起動防止。schema自体は複雑化しない）
const PLACEHOLDER_COMMAND = 'EDIT_ME';
// secret/env系のfield名はunknown fieldの中でも原因が伝わるよう別codeにする
const FORBIDDEN_FIELD_NAMES = new Set(['env', 'environment', 'secret', 'secrets', 'token', 'apiKey', 'api_key', 'password']);

class DevelopmentSessionError extends Error {
  constructor(code, message, status = 400, details = []) {
    super(message);
    this.name = 'DevelopmentSessionError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function projectKey(targetId, projectPath) {
  return `${targetId}\n${normalizeProjectPath(projectPath)}`;
}

function safeFileId(value, fallback = 'item') {
  const safe = String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return safe || fallback;
}

// 構造化issue: UIがfield単位で具体表示できるよう、path/code/message/hintを持つ
function issue(location, code, message, hint = null) {
  return { path: location, code, message, hint };
}

function assertKnownFields(value, allowed, location, issues) {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    if (FORBIDDEN_FIELD_NAMES.has(key)) {
      issues.push(issue(
        `${location}.${key}`,
        'forbidden-field',
        `field "${key}" はサポートされていません。`,
        'secret / environment系のfieldはここでは扱いません。このfieldを削除してください。'
      ));
    } else {
      issues.push(issue(
        `${location}.${key}`,
        'unknown-field',
        `不明なfield "${key}" です。`,
        'このfieldを削除するか、typoがないか確認してください。'
      ));
    }
  }
}

function validText(value, { allowEmpty = false, max = 512 } = {}) {
  return typeof value === 'string' &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= max &&
    !/[\0\r\n]/.test(value);
}

function validateRelativeCwd(value) {
  if (!validText(value, { max: 512 })) return false;
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return false;
  const segments = value.split(/[\\/]+/);
  return !segments.includes('..');
}

// item（session実行単位）のfield検証。v1のprofile.items、v2のpreset.items /
// project.additionalItemsのすべてがこの同じ規則を使う。seenIdsを渡すと
// そのスコープ内でのID一意性・重複も検査する（呼び出し側でスコープを決める）
function validateItemFields(item, itemLocation, issues, seenIds) {
  if (!item || Array.isArray(item) || typeof item !== 'object') {
    issues.push(issue(itemLocation, 'invalid-item', 'objectである必要があります。'));
    return null;
  }
  assertKnownFields(
    item,
    new Set(['id', 'label', 'kind', 'enabledByDefault', 'command', 'args', 'cwd']),
    itemLocation,
    issues
  );
  if (!ID_PATTERN.test(item.id || '')) {
    issues.push(issue(`${itemLocation}.id`, 'invalid-item-id', '安全なitem IDである必要があります。'));
  }
  if (seenIds) {
    if (seenIds.has(item.id)) {
      issues.push(issue(`${itemLocation}.id`, 'duplicate-item-id', 'item IDが重複しています。'));
    }
    seenIds.add(item.id);
  }
  if (!validText(item.label, { max: 120 })) {
    issues.push(issue(`${itemLocation}.label`, 'invalid-label', '空でない1行の文字列である必要があります。'));
  }
  if (!VALID_KINDS.has(item.kind)) {
    issues.push(issue(`${itemLocation}.kind`, 'invalid-kind', '"agent" または "process" である必要があります。'));
  }
  if (typeof item.enabledByDefault !== 'boolean') {
    issues.push(issue(`${itemLocation}.enabledByDefault`, 'invalid-enabled-by-default', '真偽値（true/false）である必要があります。'));
  }
  if (!validText(item.command, { max: 512 })) {
    issues.push(issue(`${itemLocation}.command`, 'invalid-command', '空でない1行の文字列である必要があります。'));
  } else if (item.command === PLACEHOLDER_COMMAND) {
    issues.push(issue(
      `${itemLocation}.command`,
      'placeholder-command',
      `placeholderのcommand "${PLACEHOLDER_COMMAND}" のままです。使用前に置き換えてください。`,
      'commandと（必要ならargsも）編集し、設定を再読み込みしてください。'
    ));
  }
  if (!Array.isArray(item.args) || item.args.some((arg) => !validText(arg, { allowEmpty: true, max: 2048 }))) {
    issues.push(issue(`${itemLocation}.args`, 'invalid-args', '1行の文字列の配列である必要があります。'));
  }
  if (!validateRelativeCwd(item.cwd)) {
    issues.push(issue(
      `${itemLocation}.cwd`,
      'invalid-cwd',
      'repoルートからの相対pathで、親directoryへの脱出（..）を含まない必要があります。',
      '"." または "tools/cli" のようなsubfolderを使ってください。絶対pathと ".." は拒否されます。'
    ));
  }
  return {
    id: item.id,
    label: item.label,
    kind: item.kind,
    enabledByDefault: item.enabledByDefault,
    command: item.command,
    args: Array.isArray(item.args) ? [...item.args] : [],
    cwd: item.cwd,
  };
}

// projectのpathからplatformを判定する（WSL UNC pathならwsl、それ以外はwindows）
function projectPlatform(projectPath) {
  return parseWslUncPath(projectPath) ? 'wsl' : 'windows';
}

// JSON.parseのSyntaxErrorメッセージから可能であればline/columnを復元する。
// Node/V8のメッセージ形式は変わりうるため、position情報が取れない場合は
// メッセージだけを返す（例外は投げない）
function locateJsonParseError(text, error) {
  const message = error && error.message ? error.message : 'JSONが不正です。';
  const positionMatch = /position (\d+)/.exec(message);
  const lineColMatch = /line (\d+) column (\d+)/.exec(message);
  if (lineColMatch) {
    return { message, line: Number(lineColMatch[1]), column: Number(lineColMatch[2]) };
  }
  if (positionMatch) {
    const pos = Number(positionMatch[1]);
    const before = text.slice(0, pos);
    const line = (before.match(/\n/g) || []).length + 1;
    const column = pos - before.lastIndexOf('\n');
    return { message, line, column };
  }
  return { message, line: null, column: null };
}

// 生JSONのschema検査を行い、issueと（無効な項目を含む）best-effort正規化済み
// projectsを返す。例外は投げない（診断用途と実行用validationの両方から使う共通処理）。
// version 1（project内profiles）を扱う。version 2は collectConfigV2 が担当する
function collectConfigV1(raw) {
  const issues = [];
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') {
    issues.push(issue('root', 'invalid-root', '設定はJSON objectである必要があります。'));
    return { issues, projects: [] };
  }

  assertKnownFields(raw, new Set(['version', 'projects']), 'root', issues);
  if (raw.version !== CONFIG_VERSION) {
    issues.push(issue(
      'root.version',
      'invalid-version',
      `versionは${CONFIG_VERSION}または${CONFIG_VERSION_PRESETS}である必要があります。`,
      `"version": ${CONFIG_VERSION}（project毎にitemsを書く従来方式）か ${CONFIG_VERSION_PRESETS}（起動プリセット方式）を設定してください。`
    ));
  }
  if (!Array.isArray(raw.projects)) {
    issues.push(issue('root.projects', 'invalid-projects', '配列である必要があります。', '"projects"にproject objectの配列を設定してください。'));
  }

  const normalizedProjects = [];
  const seenProjects = new Set();
  for (const [projectIndex, projectConfig] of (Array.isArray(raw.projects) ? raw.projects : []).entries()) {
    const location = `projects[${projectIndex}]`;
    if (!projectConfig || Array.isArray(projectConfig) || typeof projectConfig !== 'object') {
      issues.push(issue(location, 'invalid-project', 'objectである必要があります。'));
      continue;
    }
    assertKnownFields(
      projectConfig,
      new Set(['targetId', 'path', 'defaultProfileId', 'profiles']),
      location,
      issues
    );
    if (!validText(projectConfig.targetId, { max: 128 })) {
      issues.push(issue(
        `${location}.targetId`,
        'invalid-target-id',
        '空でない1行の文字列である必要があります。',
        'このprojectの「設定情報」に表示される正確なTarget IDを使ってください（画面上のTarget表示名ではありません）。'
      ));
    }
    if (!validText(projectConfig.path, { max: 2048 }) || !path.win32.isAbsolute(projectConfig.path)) {
      issues.push(issue(
        `${location}.path`,
        'invalid-path',
        '絶対pathまたはWSLのUNC pathである必要があります。',
        'このprojectの「設定情報」からpathをコピーしてください。'
      ));
    }
    if (!ID_PATTERN.test(projectConfig.defaultProfileId || '')) {
      issues.push(issue(
        `${location}.defaultProfileId`,
        'missing-default-profile',
        '必須fieldがないか、値が不正です。',
        'defaultProfileIdに、下のprofile一覧にあるIDのいずれかを設定してください（例: "default"）。'
      ));
    }
    if (!Array.isArray(projectConfig.profiles) || projectConfig.profiles.length === 0) {
      issues.push(issue(`${location}.profiles`, 'invalid-profiles', '1件以上を含む配列である必要があります。'));
    }

    if (validText(projectConfig.targetId, { max: 128 }) &&
        validText(projectConfig.path, { max: 2048 }) &&
        path.win32.isAbsolute(projectConfig.path)) {
      const key = projectKey(projectConfig.targetId, projectConfig.path);
      if (seenProjects.has(key)) {
        issues.push(issue(location, 'duplicate-project', 'targetIdとpathの組み合わせが重複しています。', 'profileを1つのproject entryへまとめてください。'));
      }
      seenProjects.add(key);
    }

    const profiles = [];
    const seenProfiles = new Set();
    for (const [profileIndex, profile] of (Array.isArray(projectConfig.profiles) ? projectConfig.profiles : []).entries()) {
      const profileLocation = `${location}.profiles[${profileIndex}]`;
      if (!profile || Array.isArray(profile) || typeof profile !== 'object') {
        issues.push(issue(profileLocation, 'invalid-profile', 'objectである必要があります。'));
        continue;
      }
      assertKnownFields(profile, new Set(['id', 'label', 'items']), profileLocation, issues);
      if (!ID_PATTERN.test(profile.id || '')) {
        issues.push(issue(`${profileLocation}.id`, 'invalid-profile-id', '安全なprofile IDである必要があります。'));
      }
      if (seenProfiles.has(profile.id)) {
        issues.push(issue(`${profileLocation}.id`, 'duplicate-profile-id', 'profile IDが重複しています。'));
      }
      seenProfiles.add(profile.id);
      if (!validText(profile.label, { max: 120 })) {
        issues.push(issue(`${profileLocation}.label`, 'invalid-label', '空でない1行の文字列である必要があります。'));
      }
      if (!Array.isArray(profile.items) || profile.items.length === 0) {
        issues.push(issue(`${profileLocation}.items`, 'invalid-items', '1件以上を含む配列である必要があります。'));
      }

      const items = [];
      const seenItems = new Set();
      for (const [itemIndex, item] of (Array.isArray(profile.items) ? profile.items : []).entries()) {
        const normalized = validateItemFields(item, `${profileLocation}.items[${itemIndex}]`, issues, seenItems);
        if (normalized) items.push(normalized);
      }
      profiles.push({ id: profile.id, label: profile.label, items });
    }

    if (projectConfig.defaultProfileId && !seenProfiles.has(projectConfig.defaultProfileId)) {
      issues.push(issue(
        `${location}.defaultProfileId`,
        'default-profile-not-found',
        `profile "${projectConfig.defaultProfileId}" が見つかりません。`,
        `次のいずれかを使ってください: ${[...seenProfiles].join(', ') || '（profileが定義されていません）'}`
      ));
    }
    normalizedProjects.push({
      targetId: projectConfig.targetId,
      path: projectConfig.path,
      defaultProfileId: projectConfig.defaultProfileId,
      profiles,
    });
  }

  return { issues, projects: normalizedProjects };
}

// version 2の起動プリセット（presets[]）を検証し、id→preset のMapと
// 正規化済みpreset一覧を返す（例外は投げない）
function collectPresetsV2(raw, issues) {
  const presetsById = new Map();
  const normalizedPresets = [];
  if (!Array.isArray(raw.presets)) {
    issues.push(issue('root.presets', 'invalid-presets', '配列である必要があります。', '"presets"に起動プリセットの配列を設定してください。'));
    return { presetsById, normalizedPresets };
  }
  const seenPresetIds = new Set();
  for (const [presetIndex, presetConfig] of raw.presets.entries()) {
    const location = `presets[${presetIndex}]`;
    if (!presetConfig || Array.isArray(presetConfig) || typeof presetConfig !== 'object') {
      issues.push(issue(location, 'invalid-preset', 'objectである必要があります。'));
      continue;
    }
    assertKnownFields(presetConfig, new Set(['id', 'label', 'platform', 'items']), location, issues);
    const validId = ID_PATTERN.test(presetConfig.id || '');
    if (!validId) {
      issues.push(issue(`${location}.id`, 'invalid-preset-id', '安全なpreset IDである必要があります。'));
    } else if (seenPresetIds.has(presetConfig.id)) {
      issues.push(issue(`${location}.id`, 'duplicate-preset-id', 'preset IDが重複しています。', 'preset IDはfile全体で一意にしてください。'));
    }
    if (validId) seenPresetIds.add(presetConfig.id);
    if (!validText(presetConfig.label, { max: 120 })) {
      issues.push(issue(`${location}.label`, 'invalid-label', '空でない1行の文字列である必要があります。'));
    }
    if (!VALID_PLATFORMS.has(presetConfig.platform)) {
      issues.push(issue(`${location}.platform`, 'invalid-platform', '"windows"、"wsl"、"any" のいずれかである必要があります。'));
    }
    if (!Array.isArray(presetConfig.items) || presetConfig.items.length === 0) {
      issues.push(issue(`${location}.items`, 'invalid-items', '1件以上を含む配列である必要があります。'));
    }
    const seenItemIds = new Set();
    const items = [];
    for (const [itemIndex, item] of (Array.isArray(presetConfig.items) ? presetConfig.items : []).entries()) {
      const normalized = validateItemFields(item, `${location}.items[${itemIndex}]`, issues, seenItemIds);
      if (normalized) items.push(normalized);
    }
    const normalizedPreset = {
      id: presetConfig.id,
      label: presetConfig.label,
      platform: presetConfig.platform,
      items,
    };
    normalizedPresets.push(normalizedPreset);
    if (validId && !presetsById.has(presetConfig.id)) {
      presetsById.set(presetConfig.id, normalizedPreset);
    }
  }
  return { presetsById, normalizedPresets };
}

// version 2: projectはpresetId参照 + additionalItems（+ itemOverrides）だけを持ち、
// 実itemsはpresetから展開する。展開結果はv1と同じ{defaultProfileId, profiles}形へ
// 正規化するため、findProjectConfig / resolveConfiguredSelection / buildWorkspaceDocument
// など実行系のコードはv1/v2を意識せず共通に動く（起動方式自体は変更していない）
function collectConfigV2(raw) {
  const issues = [];
  assertKnownFields(raw, new Set(['version', 'presets', 'projects']), 'root', issues);
  const { presetsById, normalizedPresets } = collectPresetsV2(raw, issues);

  if (!Array.isArray(raw.projects)) {
    issues.push(issue('root.projects', 'invalid-projects', '配列である必要があります。', '"projects"にproject objectの配列を設定してください。'));
  }

  const normalizedProjects = [];
  const seenProjects = new Set();
  for (const [projectIndex, projectConfig] of (Array.isArray(raw.projects) ? raw.projects : []).entries()) {
    const location = `projects[${projectIndex}]`;
    if (!projectConfig || Array.isArray(projectConfig) || typeof projectConfig !== 'object') {
      issues.push(issue(location, 'invalid-project', 'objectである必要があります。'));
      continue;
    }
    assertKnownFields(
      projectConfig,
      new Set(['targetId', 'path', 'presetId', 'additionalItems', 'itemOverrides']),
      location,
      issues
    );

    const validTargetId = validText(projectConfig.targetId, { max: 128 });
    if (!validTargetId) {
      issues.push(issue(
        `${location}.targetId`,
        'invalid-target-id',
        '空でない1行の文字列である必要があります。',
        'このprojectの「設定情報」に表示される正確なTarget IDを使ってください（画面上のTarget表示名ではありません）。'
      ));
    }
    const validPath = validText(projectConfig.path, { max: 2048 }) && path.win32.isAbsolute(projectConfig.path);
    if (!validPath) {
      issues.push(issue(
        `${location}.path`,
        'invalid-path',
        '絶対pathまたはWSLのUNC pathである必要があります。',
        'このprojectの「設定情報」からpathをコピーしてください。'
      ));
    }

    if (validTargetId && validPath) {
      const key = projectKey(projectConfig.targetId, projectConfig.path);
      if (seenProjects.has(key)) {
        issues.push(issue(location, 'duplicate-project', 'targetIdとpathの組み合わせが重複しています。', 'project entryを1つにまとめてください。'));
      }
      seenProjects.add(key);
    }

    let preset = null;
    const validPresetId = ID_PATTERN.test(projectConfig.presetId || '');
    if (!validPresetId) {
      issues.push(issue(`${location}.presetId`, 'invalid-preset-id', '安全なpreset IDである必要があります。'));
    } else if (!presetsById.has(projectConfig.presetId)) {
      issues.push(issue(
        `${location}.presetId`,
        'preset-not-found',
        `preset "${projectConfig.presetId}" が見つかりません。`,
        '定義済みのpresets[].idのいずれかを指定してください。'
      ));
    } else {
      preset = presetsById.get(projectConfig.presetId);
    }

    if (preset && validPath) {
      const actualPlatform = projectPlatform(projectConfig.path);
      if (preset.platform !== 'any' && preset.platform !== actualPlatform) {
        issues.push(issue(
          `${location}.presetId`,
          'platform-mismatch',
          `このprojectのplatform(${actualPlatform})とpreset "${preset.id}" のplatform(${preset.platform})が一致しません。`,
          'windows projectにはwindows/any preset、WSL projectにはwsl/any presetだけを指定してください。'
        ));
        preset = null;
      }
    }

    const additionalItemsSeen = new Set();
    const additionalItems = [];
    if (projectConfig.additionalItems !== undefined && !Array.isArray(projectConfig.additionalItems)) {
      issues.push(issue(`${location}.additionalItems`, 'invalid-additional-items', '配列である必要があります。'));
    } else {
      for (const [itemIndex, item] of (projectConfig.additionalItems || []).entries()) {
        const normalized = validateItemFields(item, `${location}.additionalItems[${itemIndex}]`, issues, additionalItemsSeen);
        if (normalized) additionalItems.push(normalized);
      }
    }
    if (preset) {
      const presetItemIds = new Set(preset.items.map((item) => item.id));
      for (const item of additionalItems) {
        if (presetItemIds.has(item.id)) {
          issues.push(issue(
            `${location}.additionalItems`,
            'additional-item-collision',
            `additionalItemのID "${item.id}" がpreset itemと衝突しています。`,
            '別のIDを使うか、既存preset itemの有効/無効はitemOverridesで調整してください。'
          ));
        }
      }
    }

    const overridesById = new Map();
    if (projectConfig.itemOverrides !== undefined) {
      if (!projectConfig.itemOverrides || Array.isArray(projectConfig.itemOverrides) || typeof projectConfig.itemOverrides !== 'object') {
        issues.push(issue(`${location}.itemOverrides`, 'invalid-item-overrides', 'objectである必要があります。'));
      } else {
        for (const [itemId, override] of Object.entries(projectConfig.itemOverrides)) {
          const overrideLocation = `${location}.itemOverrides.${itemId}`;
          if (preset && !preset.items.some((item) => item.id === itemId)) {
            issues.push(issue(
              overrideLocation,
              'item-override-unknown-item',
              `preset "${preset.id}" にitem "${itemId}" がありません。`,
              'itemOverridesのキーは、参照しているpresetのitem IDと一致させてください。'
            ));
            continue;
          }
          if (!override || Array.isArray(override) || typeof override !== 'object') {
            issues.push(issue(overrideLocation, 'invalid-item-override', 'objectである必要があります。'));
            continue;
          }
          assertKnownFields(override, new Set(['enabledByDefault']), overrideLocation, issues);
          if (typeof override.enabledByDefault !== 'boolean') {
            issues.push(issue(`${overrideLocation}.enabledByDefault`, 'invalid-enabled-by-default', '真偽値（true/false）である必要があります。'));
          } else {
            overridesById.set(itemId, override.enabledByDefault);
          }
        }
      }
    }

    let expandedItems = [];
    if (preset) {
      expandedItems = preset.items
        .map((item) => (overridesById.has(item.id) ? { ...item, enabledByDefault: overridesById.get(item.id) } : item))
        .concat(additionalItems);
    }

    normalizedProjects.push({
      targetId: projectConfig.targetId,
      path: projectConfig.path,
      defaultProfileId: 'default',
      presetId: validPresetId ? projectConfig.presetId : undefined,
      presetLabel: preset ? preset.label : undefined,
      additionalItemIds: additionalItems.map((item) => item.id),
      profiles: [{ id: 'default', label: preset ? preset.label : 'Development', items: expandedItems }],
    });
  }

  return { issues, projects: normalizedProjects, presets: normalizedPresets };
}

// version（raw.version）でv1/v2の実装へ振り分ける。1ファイル内でv1/v2の
// projectを混在させることはない（各collectorがそれぞれの許可fieldしか
// 受け付けないため、他バージョンの構造は自然にunknown fieldとして拒否される）
function collectConfig(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === CONFIG_VERSION_PRESETS) {
    return collectConfigV2(raw);
  }
  return collectConfigV1(raw);
}

function validateDevelopmentSessions(raw) {
  const { issues, projects, presets } = collectConfig(raw);
  if (issues.length > 0) {
    throw new DevelopmentSessionError(
      'config-validation-error',
      `Development session設定が不正です（${issues.length}件のissue）。`,
      422,
      issues
    );
  }
  const version = raw && typeof raw === 'object' && raw.version === CONFIG_VERSION_PRESETS
    ? CONFIG_VERSION_PRESETS
    : CONFIG_VERSION;
  return { version, projects, presets: presets || [] };
}

async function loadDevelopmentSessions(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'missing', config: null };
    throw new DevelopmentSessionError(
      'config-read-error',
      'Development session設定を読み込めませんでした。',
      500
    );
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DevelopmentSessionError(
      'config-parse-error',
      'Development session設定のJSONが不正です。',
      422
    );
  }
  return { status: 'loaded', config: validateDevelopmentSessions(raw) };
}

// 表示専用の診断ロード: 例外を投げず、missing/invalid/validを常に返す。
// invalidでも（読めた範囲の）best-effort projectsを返すため、targetId/path
// 照合ヒントをinvalid設定からも安全に提示できる。実行系（loadDevelopmentSessions /
// resolveConfiguredSelection）はこの関数を使わず、従来どおり厳格に例外を投げる
async function loadDevelopmentSessionsDiagnostic(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'missing', issues: [], projects: [], presets: [] };
    return {
      status: 'invalid',
      issues: [issue('root', 'config-read-error', 'Development session設定を読み込めませんでした。')],
      projects: [],
      presets: [],
    };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const located = locateJsonParseError(text, error);
    return {
      status: 'invalid',
      issues: [issue(
        'root',
        'json-parse-error',
        located.line != null
          ? `JSONが不正です（line ${located.line}, column ${located.column}）。`
          : 'JSONが不正です。',
        'その付近の閉じ忘れの引用符・波括弧、または余分なカンマを確認してください。'
      )],
      projects: [],
      presets: [],
    };
  }

  const { issues, projects, presets } = collectConfig(raw);
  return { status: issues.length > 0 ? 'invalid' : 'valid', issues, projects, presets: presets || [] };
}

class DevelopmentSessionStore {
  constructor(file) {
    this.file = file;
    this.state = null;
  }

  async get() {
    if (!this.state) this.state = await loadDevelopmentSessions(this.file);
    return this.state;
  }

  async reload() {
    this.state = await loadDevelopmentSessions(this.file);
    return this.state;
  }
}

function findProjectConfig(config, project) {
  if (!config || !Array.isArray(config.projects)) return null;
  const wanted = projectKey(project.targetId, project.path);
  return config.projects.find((entry) => projectKey(entry.targetId, entry.path) === wanted) || null;
}

// path文字列の最後のセグメント（repoディレクトリ名相当）だけを取り出す。
// \ と / のどちらの区切りにも対応する
function pathBasename(rawPath) {
  const segments = String(rawPath || '').split(/[\\/]+/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : '';
}

// projectのtargetId/pathが、診断済み設定（invalidなファイルでもbest-effortで
// 読み取れた範囲）とどう照合するかを判定する。5状態: not-configured /
// target-id-mismatch / path-mismatch / invalid / configured。
// この関数の結果はUI表示専用であり、実行許可には使わない
// （実行はresolveConfiguredSelection + 厳格validationのみが判断する）
//
// 現在のschemaにはproject固有の安定IDが無く、targetId + pathの組み合わせだけで
// 識別している。repo-directories型targetでは同じtargetIdに多数のprojectが
// 属するため、「targetIdが同じ」というだけでは同一projectの根拠にならない
// （例: sample-workspace配下のsample-projectが設定済みでも、同じsample-workspace配下の
// 未設定projectであるagent-workbenchをpath-mismatchと誤診断してはいけない）。
// path-mismatchは、configureされたpathの末尾セグメント（repoディレクトリ名）が
// 閲覧中projectの名前と一致する場合だけに限定し、それ以外はnot-configuredへ寄せる
function diagnoseProjectMatch(diagnostic, project) {
  if (diagnostic.status === 'missing') {
    return { state: 'not-configured', reason: 'missing-file' };
  }

  const wantedKey = projectKey(project.targetId, project.path);
  const exact = diagnostic.projects.find((entry) => {
    if (typeof entry.targetId !== 'string' || typeof entry.path !== 'string') return false;
    try {
      return projectKey(entry.targetId, entry.path) === wantedKey;
    } catch (error) {
      return false;
    }
  });
  if (exact) {
    return diagnostic.status === 'valid'
      ? { state: 'configured' }
      : { state: 'invalid', issues: diagnostic.issues };
  }

  let normalizedActualPath;
  try {
    normalizedActualPath = normalizeProjectPath(project.path);
  } catch (error) {
    normalizedActualPath = null;
  }
  const pathMatch = normalizedActualPath && diagnostic.projects.find((entry) => {
    if (typeof entry.path !== 'string') return false;
    try {
      return normalizeProjectPath(entry.path) === normalizedActualPath;
    } catch (error) {
      return false;
    }
  });
  if (pathMatch) {
    return {
      state: 'target-id-mismatch',
      configuredTargetId: pathMatch.targetId,
      looksLikeLabel: pathMatch.targetId === project.targetLabel,
    };
  }

  const actualName = String(project.name || '').toLowerCase();
  const targetMatch = actualName && diagnostic.projects.find((entry) => {
    if (entry.targetId !== project.targetId) return false;
    if (typeof entry.path !== 'string') return false;
    return pathBasename(entry.path).toLowerCase() === actualName;
  });
  if (targetMatch) {
    return { state: 'path-mismatch', configuredPath: targetMatch.path };
  }

  if (diagnostic.status === 'invalid') {
    return { state: 'invalid', issues: diagnostic.issues };
  }
  return { state: 'not-configured', reason: 'project-not-configured' };
}

// Phase 1: 設定に使う正確な識別情報（表示label/内部ID/正規path）。
// pathやtargetIdをユーザー入力から受け取ることはない（scan結果のみを使う）
function buildProjectIdentity(project) {
  return {
    targetLabel: project.targetLabel || project.targetId,
    targetId: project.targetId,
    path: project.path,
  };
}

function formatCommandForDisplay(command, args) {
  const quote = (value) => /^[A-Za-z0-9_./:\\=@%+,-]+$/.test(value) ? value : JSON.stringify(value);
  return [command, ...args].map(quote).join(' ');
}

function publicProjectSession(projectConfig) {
  if (!projectConfig) return null;
  return {
    defaultProfileId: projectConfig.defaultProfileId,
    presetId: projectConfig.presetId || null,
    presetLabel: projectConfig.presetLabel || null,
    additionalItemIds: projectConfig.additionalItemIds || [],
    profiles: projectConfig.profiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      items: profile.items.map((item) => ({
        id: item.id,
        label: item.label,
        kind: item.kind,
        enabledByDefault: item.enabledByDefault,
        displayCommand: formatCommandForDisplay(item.command, item.args),
        cwd: item.cwd,
      })),
    })),
  };
}

// 起動プリセット一覧をUI表示用（command/argsはdisplayCommandへ統合）に変換する
function publicPresetSummary(preset) {
  return {
    id: preset.id,
    label: preset.label,
    platform: preset.platform,
    items: preset.items.map((item) => ({
      id: item.id,
      label: item.label,
      kind: item.kind,
      enabledByDefault: item.enabledByDefault,
      displayCommand: formatCommandForDisplay(item.command, item.args),
      cwd: item.cwd,
    })),
  };
}

// 閲覧中projectのplatformに適合する起動プリセットだけを返す（windows project
// にはwindows/any、WSL projectにはwsl/anyだけ）。未設定project UIの
// プリセット選択に使う
function availablePresetsForProject(diagnostic, project) {
  const presets = (diagnostic && diagnostic.presets) || [];
  const platform = projectPlatform(project.path);
  return presets
    .filter((preset) => preset.platform === 'any' || preset.platform === platform)
    .map(publicPresetSummary);
}

function validateStartRequest(scanCache, body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    throw new DevelopmentSessionError('invalid-request', 'Development sessionのrequestが必要です。', 400);
  }
  const allowed = new Set(['path', 'targetId', 'profileId', 'itemIds']);
  const extra = Object.keys(body).filter((field) => !allowed.has(field));
  if (extra.length > 0) {
    throw new DevelopmentSessionError(
      'unsupported-fields',
      'path、targetId、profileId、itemIdsのみ受け付けます。',
      400
    );
  }
  const authorization = authorizeVscodeProject(scanCache, {
    path: body.path,
    targetId: body.targetId,
  });
  if (!authorization.ok) {
    throw new DevelopmentSessionError(
      authorization.code,
      authorization.error,
      authorization.status
    );
  }
  if (!ID_PATTERN.test(body.profileId || '')) {
    throw new DevelopmentSessionError('invalid-profile', '有効なprofileIdが必要です。', 400);
  }
  if (!Array.isArray(body.itemIds) || body.itemIds.length === 0 ||
      body.itemIds.some((id) => !ID_PATTERN.test(id || ''))) {
    throw new DevelopmentSessionError('no-items', '起動対象を1つ以上選択してください。', 400);
  }
  if (new Set(body.itemIds).size !== body.itemIds.length) {
    throw new DevelopmentSessionError('duplicate-items', '重複したitem IDは指定できません。', 400);
  }
  return authorization.project;
}

function resolveConfiguredSelection(config, project, profileId, itemIds) {
  const projectConfig = findProjectConfig(config, project);
  if (!projectConfig) {
    throw new DevelopmentSessionError(
      'project-not-configured',
      'このprojectにはDevelopment session設定がありません。',
      404
    );
  }
  const profile = projectConfig.profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    throw new DevelopmentSessionError('profile-not-found', '設定されたprofileが見つかりません。', 404);
  }
  const byId = new Map(profile.items.map((item) => [item.id, item]));
  const items = itemIds.map((id) => byId.get(id));
  if (items.some((item) => !item)) {
    throw new DevelopmentSessionError('item-not-found', '選択されたitemが見つかりません。', 404);
  }
  return { projectConfig, profile, items };
}

// Phase 6: localhostからのpreset登録request。requestはtargetId/path/presetIdの
// 識別子だけを受け付ける（command/args/cwd/preset内容の指定は一切許可しない）
function validateRegisterPresetRequest(scanCache, body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    throw new DevelopmentSessionError('invalid-request', 'requestが必要です。', 400);
  }
  const allowed = new Set(['targetId', 'path', 'presetId']);
  const extra = Object.keys(body).filter((field) => !allowed.has(field));
  if (extra.length > 0) {
    throw new DevelopmentSessionError(
      'unsupported-fields',
      'targetId、path、presetIdのみ受け付けます。',
      400
    );
  }
  const authorization = authorizeVscodeProject(scanCache, {
    path: body.path,
    targetId: body.targetId,
  });
  if (!authorization.ok) {
    throw new DevelopmentSessionError(authorization.code, authorization.error, authorization.status);
  }
  if (!ID_PATTERN.test(body.presetId || '')) {
    throw new DevelopmentSessionError('invalid-preset-id', '有効なpresetIdが必要です。', 400);
  }
  return { project: authorization.project, presetId: body.presetId };
}

// Phase 6: 生JSON（version 2）へ、確認済みproject/presetの参照だけを追加する。
// I/Oは行わない純関数。呼び出し側（server.js）がこの戻り値をatomicに書き込む。
// - presetIdはfile内に既に定義されている必要がある（ブラウザからpreset内容を
//   作ることはできない）
// - platform不一致・重複登録・現在の設定が既にinvalidな場合はここで拒否する
// - 追加後の設定全体を再validationしてから返す（安全側）
function registerPresetProject(raw, project, presetId) {
  if (!raw) {
    throw new DevelopmentSessionError(
      'config-file-missing',
      'preset登録の前に、data/development-sessions.jsonへ起動プリセットを定義してください。',
      404
    );
  }
  if (typeof raw !== 'object' || Array.isArray(raw) || raw.version !== CONFIG_VERSION_PRESETS) {
    throw new DevelopmentSessionError(
      'unsupported-version',
      'preset登録はversion 2の設定でのみ行えます。',
      409
    );
  }

  const before = collectConfigV2(raw);
  if (before.issues.length > 0) {
    throw new DevelopmentSessionError(
      'config-validation-error',
      `現在の設定が不正です（${before.issues.length}件のissue）。`,
      422,
      before.issues
    );
  }

  const preset = before.presets.find((entry) => entry.id === presetId);
  if (!preset) {
    throw new DevelopmentSessionError('preset-not-found', `preset "${presetId}" が見つかりません。`, 404);
  }
  const platform = projectPlatform(project.path);
  if (preset.platform !== 'any' && preset.platform !== platform) {
    throw new DevelopmentSessionError(
      'platform-mismatch',
      `preset "${presetId}" はこのprojectのplatform(${platform})に対応していません。`,
      409
    );
  }
  if (findProjectConfig({ projects: before.projects }, project)) {
    throw new DevelopmentSessionError(
      'project-already-configured',
      'このprojectは既にDevelopment session設定があります。',
      409
    );
  }

  const nextRaw = {
    version: CONFIG_VERSION_PRESETS,
    presets: raw.presets,
    projects: [
      ...(Array.isArray(raw.projects) ? raw.projects : []),
      { targetId: project.targetId, path: project.path, presetId, additionalItems: [] },
    ],
  };

  const after = collectConfigV2(nextRaw);
  if (after.issues.length > 0) {
    throw new DevelopmentSessionError(
      'config-validation-error',
      `登録後の設定が不正です（${after.issues.length}件のissue）。`,
      500,
      after.issues
    );
  }

  return nextRaw;
}

function buildWslFolderUri(distro, linuxPath) {
  const encodedPath = linuxPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `vscode-remote://wsl+${encodeURIComponent(distro)}${encodedPath}`;
}

function taskCwd(relativeCwd) {
  if (relativeCwd === '.') return '${workspaceFolder}';
  const suffix = relativeCwd.split(/[\\/]+/).filter((segment) => segment && segment !== '.').join('/');
  return suffix ? `\${workspaceFolder}/${suffix}` : '${workspaceFolder}';
}

function buildWorkspaceDocument(project, profile, items) {
  const wsl = parseWslUncPath(project.path);
  const folder = wsl
    ? { name: project.name, uri: buildWslFolderUri(wsl.distro, wsl.linuxPath) }
    : { name: project.name, path: project.path };
  return {
    folders: [folder],
    tasks: {
      version: '2.0.0',
      tasks: items.map((item) => ({
        label: `${item.label} [${item.id}]`,
        type: 'process',
        command: item.command,
        args: [...item.args],
        options: { cwd: taskCwd(item.cwd) },
        presentation: {
          reveal: 'always',
          panel: 'dedicated',
          focus: false,
          clear: false,
          showReuseMessage: true,
        },
        problemMatcher: [],
        runOptions: {
          runOn: 'folderOpen',
          instanceLimit: 1,
          instancePolicy: 'warn',
        },
      })),
    },
  };
}

function generatedWorkspacePath(generatedRoot, project, profileId) {
  const target = safeFileId(project.targetId, 'target');
  const hash = crypto.createHash('sha256').update(projectKey(project.targetId, project.path)).digest('hex').slice(0, 16);
  const profile = safeFileId(profileId, 'profile');
  return path.join(generatedRoot, target, hash, `${profile}.code-workspace`);
}

async function writeGeneratedWorkspace(generatedRoot, project, profile, items) {
  const workspacePath = generatedWorkspacePath(generatedRoot, project, profile.id);
  await fsp.mkdir(path.dirname(workspacePath), { recursive: true });
  const tempPath = `${workspacePath}.${process.pid}.tmp`;
  const document = buildWorkspaceDocument(project, profile, items);
  try {
    await fsp.writeFile(tempPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
    await fsp.rename(tempPath, workspacePath);
  } catch (error) {
    try { await fsp.unlink(tempPath); } catch (cleanupError) { /* best effort */ }
    throw new DevelopmentSessionError(
      'workspace-write-failed',
      '生成workspaceを作成できませんでした。',
      500
    );
  }
  return { workspacePath, document };
}

// Phase 6: 登録APIが更新前に読む生JSON。ファイルが無ければ raw:null を返す
// （読み込みエラー・JSON構文エラーは例外にする。診断用の
// loadDevelopmentSessionsDiagnosticとは別に、更新系はmtimeも併せて必要とする）
async function readRawConfigForUpdate(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { raw: null, mtimeMs: undefined };
    throw new DevelopmentSessionError('config-read-error', 'Development session設定を読み込めませんでした。', 500);
  }
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    throw new DevelopmentSessionError('config-read-error', 'Development session設定を読み込めませんでした。', 500);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new DevelopmentSessionError('config-parse-error', 'Development session設定のJSONが不正です。', 422);
  }
  return { raw, mtimeMs: stat.mtimeMs };
}

// data/development-sessions.json への安全な書き込み。一時ファイルへ書いてから
// atomic renameする。expectedMtimeMsを渡した場合、書き込み直前のmtimeがそれと
// 異なれば外部変更が割り込んだとみなして拒否する（読み込みから書き込みまでの
// 間に他プロセス・手動編集がファイルを変えていないかを確認する）。
// backupは最新1世代（<file>.bak）だけを保持し、世代を増やし続けない
async function writeConfigFileAtomic(file, nextRaw, { expectedMtimeMs } = {}) {
  if (expectedMtimeMs !== undefined) {
    let currentMtimeMs = null;
    try {
      currentMtimeMs = (await fsp.stat(file)).mtimeMs;
    } catch (error) {
      currentMtimeMs = null;
    }
    if (currentMtimeMs !== expectedMtimeMs) {
      throw new DevelopmentSessionError(
        'config-conflict',
        '設定ファイルが別の変更と競合しています。設定を再読み込みしてやり直してください。',
        409
      );
    }
  }

  const text = JSON.stringify(nextRaw, null, 2) + '\n';
  const tempPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backupPath = `${file}.bak`;
  try {
    try {
      const currentText = await fsp.readFile(file, 'utf8');
      await fsp.writeFile(backupPath, currentText, 'utf8');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    await fsp.writeFile(tempPath, text, 'utf8');
    await fsp.rename(tempPath, file);
  } catch (error) {
    try { await fsp.unlink(tempPath); } catch (cleanupError) { /* best effort */ }
    throw new DevelopmentSessionError('config-write-failed', '設定ファイルを書き込めませんでした。', 500);
  }
}

// Phase 6: preset登録（設定ファイル書き込み）はlocalhostからのrequestだけを許可する。
// 呼び出し側はreq.ipではなくreq.socket.remoteAddressをそのまま渡すこと
// （'trust proxy'を有効化していない限り同じ値になるが、将来trust proxyが
// 設定されてもX-Forwarded-For等の転送ヘッダに影響されない判定にするため）。
// このprocessはproxyを経由しない構成を前提にしている
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLoopbackAddress(remoteAddress) {
  return typeof remoteAddress === 'string' && LOOPBACK_ADDRESSES.has(remoteAddress);
}

// 設定ファイルの読み込み→更新→書き込みを直列化するための単純なmutex。
// 同時request同士が互いのread-modify-writeを踏み潰さないようにする
class AsyncMutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(fn) {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

class RecentLaunchGuard {
  constructor(windowMs = 8000, now = () => Date.now()) {
    this.windowMs = windowMs;
    this.now = now;
    this.recent = new Map();
  }

  begin(key) {
    const current = this.now();
    const previous = this.recent.get(key);
    if (previous !== undefined && current - previous < this.windowMs) {
      throw new DevelopmentSessionError(
        'duplicate-launch',
        'Development sessionの起動要求は少し前に送信済みです。',
        409
      );
    }
    this.recent.set(key, current);
  }

  clear(key) {
    this.recent.delete(key);
  }
}

function launchKey(project, profileId) {
  return `${projectKey(project.targetId, project.path)}\n${profileId}`;
}

module.exports = {
  CONFIG_VERSION,
  CONFIG_VERSION_PRESETS,
  PLACEHOLDER_COMMAND,
  AsyncMutex,
  DevelopmentSessionError,
  DevelopmentSessionStore,
  RecentLaunchGuard,
  availablePresetsForProject,
  isLoopbackAddress,
  buildProjectIdentity,
  buildWorkspaceDocument,
  diagnoseProjectMatch,
  findProjectConfig,
  formatCommandForDisplay,
  generatedWorkspacePath,
  launchKey,
  loadDevelopmentSessions,
  loadDevelopmentSessionsDiagnostic,
  locateJsonParseError,
  projectKey,
  projectPlatform,
  publicPresetSummary,
  publicProjectSession,
  readRawConfigForUpdate,
  registerPresetProject,
  resolveConfiguredSelection,
  validateDevelopmentSessions,
  validateRegisterPresetRequest,
  validateRelativeCwd,
  validateStartRequest,
  writeConfigFileAtomic,
  writeGeneratedWorkspace,
};
