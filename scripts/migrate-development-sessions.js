#!/usr/bin/env node
'use strict';

// data/development-sessions.json を version 1 → version 2（起動プリセット方式）へ
// 変換するCLI。既定はdry-run（変換後JSONと検証結果を表示するだけ）。
// 明示的に --write を付けた場合だけ、byte単位のbackupを作ってから書き換える。
//
// 使い方:
//   node scripts/migrate-development-sessions.js                 # dry-run（既定ファイル）
//   node scripts/migrate-development-sessions.js --file=<path>   # 別ファイルをdry-run
//   node scripts/migrate-development-sessions.js --write         # 検証成功時のみ書き換え
//
// 安全方針:
// - 変換前の設定が丸ごとinvalidな場合は書き込まない（migrateV1ToV2が例外を投げる）
// - 変換後、各projectの展開後itemsが変換前と完全一致することをverifyMigrationで
//   確認できなければ書き込まない
// - --write時は既存ファイルを <file>.v1.bak へbyte単位でbackupしてから
//   atomic rename（lib/development-sessions.jsのwriteConfigFileAtomicを再利用）
// - 推測でcommand/args/targetIdを書き換えることはしない（元の値をそのまま移すだけ）

const fs = require('fs');
const path = require('path');
const { migrateV1ToV2, verifyMigration } = require('../lib/migrate-development-sessions');
const { writeConfigFileAtomic } = require('../lib/development-sessions');

function parseArgs(argv) {
  const args = { write: false, file: null };
  for (const arg of argv) {
    if (arg === '--write') args.write = true;
    else if (arg.startsWith('--file=')) args.file = arg.slice('--file='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function printUsage() {
  console.log([
    'Usage: node scripts/migrate-development-sessions.js [--file=<path>] [--write]',
    '',
    '  (no flags)   dry-run: prints the candidate version 2 JSON and a verification summary',
    '  --write      only after a successful dry-run verification, back up the original file',
    '               to <file>.v1.bak and atomically replace it with the version 2 JSON',
    '  --file=PATH  operate on PATH instead of the default data/development-sessions.json',
  ].join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  const file = args.file
    ? path.resolve(args.file)
    : path.join(__dirname, '..', 'data', 'development-sessions.json');

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.error(`ファイルが見つかりません: ${file}`);
      return 1;
    }
    console.error(`ファイルを読み込めませんでした: ${file}`);
    console.error(error && error.message ? error.message : error);
    return 1;
  }

  let rawV1;
  try {
    rawV1 = JSON.parse(text);
  } catch (error) {
    console.error('JSONとして読み込めませんでした。構文エラーを修正してから再実行してください。');
    console.error(error && error.message ? error.message : error);
    return 1;
  }

  let migration;
  try {
    migration = migrateV1ToV2(rawV1);
  } catch (error) {
    console.error('変換できませんでした（変換前の設定が不正です）。');
    console.error(`code: ${error && error.code}`);
    console.error(error && error.message ? error.message : error);
    if (error && Array.isArray(error.details)) {
      for (const detail of error.details) {
        console.error(`  - ${detail.path}: [${detail.code}] ${detail.message}`);
      }
    }
    console.error('\n実データは変更していません。上記issueを解消してから再実行してください。');
    return 1;
  }

  const verification = verifyMigration(rawV1, migration.v2Raw);

  console.log('=== 変換後の version 2 (候補) ===');
  console.log(JSON.stringify(migration.v2Raw, null, 2));
  console.log('');
  console.log(`=== 検証結果: ${verification.ok ? 'OK（展開後itemsが完全一致）' : 'NG（不一致あり）'} ===`);
  for (const mapping of migration.projectMappings) {
    console.log(`  ${mapping.targetId}  ${mapping.path}  -> preset: ${mapping.presetId}`);
  }
  if (!verification.ok) {
    console.log('');
    console.log('不一致の詳細:');
    console.log(JSON.stringify(verification.mismatches, null, 2));
  }

  if (!args.write) {
    console.log('\ndry-runのため、ファイルは変更していません。書き換えるには --write を付けて再実行してください。');
    return verification.ok ? 0 : 1;
  }

  if (!verification.ok) {
    console.error('\n検証NGのため --write は実行しません。実データは変更していません。');
    return 1;
  }

  const backupPath = `${file}.v1.bak`;
  fs.writeFileSync(backupPath, text, 'utf8');
  await writeConfigFileAtomic(file, migration.v2Raw);
  console.log(`\n書き換えました: ${file}`);
  console.log(`変換前のversion 1設定はこちらにbackupしてあります: ${backupPath}`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error('予期しないエラーが発生しました。実データは変更していない可能性がありますが、念のため内容を確認してください。');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
