#!/usr/bin/env node
// scripts/check-desktop-update-chain.mjs 自检：构造配置矩阵，断言判据逐条有齿。
// 每个负例都对应一个**本仓真实发生过或极易发生**的更新链断点。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, parseYamlSubset, placeholdersOf } from './check-desktop-update-chain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function assert(name, cond) {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.error(`  ✘ ${name}`);
  }
}

const GOOD_UPDATER = "autoUpdater.setFeedURL({ provider: 'generic', url });\napp-update.yml";

/** 造一份最小可解析的 electron-builder.yml。 */
function builder({ artifactName = 'AutoCodeFlow-Executor-${version}.${ext}', publish = 'publish:\n  provider: github\n  owner: O\n  repo: R\n', linuxExtra = '' } = {}) {
  return [
    'appId: com.x',
    'linux:',
    '  target:',
    '    - target: AppImage',
    `  artifactName: ${artifactName}`,
    linuxExtra,
    publish,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── 正例 ────────────────────────────────────────────────────────
{
  const { failures: f } = check({ builderText: builder(), updaterText: GOOD_UPDATER });
  assert('正例（合法 artifactName + github publish + updater 接线）无违规', f.length === 0);
}

// ── ① artifactName 嵌套（desktop-v1.5.1 实爆形态） ──────────────
{
  const nested = ['appId: com.x', 'linux:', '  target:', '    - target: AppImage', '  AppImage:', '    artifactName: Foo-${version}.${ext}', 'publish:', '  provider: github'].join('\n');
  const { failures: f } = check({ builderText: nested, updaterText: GOOD_UPDATER });
  assert('artifactName 嵌套在 AppImage: 下必须被检出（v1.5.1 三平台全挂根因）', f.some((x) => x.includes('嵌套')));
}

// ── ② 未知占位符 ───────────────────────────────────────────────
{
  const { failures: f } = check({
    builderText: builder({ artifactName: 'Foo-${verison}.${ext}' }), // 拼错 version
    updaterText: GOOD_UPDATER,
  });
  assert('拼错的占位符必须被检出', f.some((x) => x.includes('未知占位符') && x.includes('verison')));
}

// ── ③ 缺 ${version}（同名覆盖 → 版本比较基准失真） ─────────────
{
  const { failures: f } = check({
    builderText: builder({ artifactName: 'Foo-static.${ext}' }),
    updaterText: GOOD_UPDATER,
  });
  assert('artifactName 缺 ${version} 必须被检出', f.some((x) => x.includes('缺少 ${version}')));
}

// ── ④ publish 缺失 / provider 非法 / generic 缺 url ────────────
{
  const { failures: f } = check({ builderText: builder({ publish: '' }), updaterText: GOOD_UPDATER });
  assert('无 publish 段必须被检出', f.some((x) => x.includes('无 publish 段')));
}
{
  const { failures: f } = check({
    builderText: builder({ publish: 'publish:\n  provider: ftp\n' }),
    updaterText: GOOD_UPDATER,
  });
  assert('非法 provider 必须被检出', f.some((x) => x.includes('provider 非法')));
}
{
  const { failures: f } = check({
    builderText: builder({ publish: 'publish:\n  provider: generic\n' }),
    updaterText: GOOD_UPDATER,
  });
  assert('generic 缺 url 必须被检出', f.some((x) => x.includes('缺少 url')));
}

// ── ⑤ updater 接线被移除 ───────────────────────────────────────
{
  const { failures: f } = check({ builderText: builder(), updaterText: 'export function initUpdater() {}' });
  assert('updater 更新源接线缺失必须被检出', f.some((x) => x.includes('updater.ts 未见')));
}

// ── ⑥ 两种 publish 形态都要能解析（首版只支持列表形态 → 假阳性） ──
{
  const mapForm = parseYamlSubset('publish:\n  provider: github\n  owner: O\n');
  const listForm = parseYamlSubset('publish:\n  - provider: generic\n    url: https://x\n');
  assert('映射形态 publish 可解析', mapForm.publish.length === 1 && mapForm.publish[0].provider === 'github');
  assert('列表形态 publish 可解析', listForm.publish.length === 1 && listForm.publish[0].provider === 'generic');
}

// ── ⑦ 占位符提取 ───────────────────────────────────────────────
{
  assert('占位符提取正确', JSON.stringify(placeholdersOf('A-${version}.${ext}')) === '["version","ext"]');
  assert('无占位符返回空数组', placeholdersOf('static-name').length === 0);
}

// ── ⑧ 反证有牙：真实配置喂进去必须绿（守卫不能空转） ────────────
{
  const builderText = readFileSync(join(here, '..', 'apps', 'executor-desktop', 'electron-builder.yml'), 'utf8');
  const updaterText = readFileSync(join(here, '..', 'apps', 'executor-desktop', 'src', 'main', 'updater.ts'), 'utf8');
  const { failures: f } = check({ builderText, updaterText });
  assert('真实 electron-builder.yml + updater.ts 全绿（守卫真的在跑）', f.length === 0);
  const p = parseYamlSubset(builderText);
  assert('真实配置的 publish 被解析出（映射形态）', p.publish.length === 1 && p.publish[0].provider === 'github');
}

console.log(failures === 0 ? '\ncheck-desktop-update-chain selftest: all passed' : `\ncheck-desktop-update-chain selftest: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);