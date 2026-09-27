#!/usr/bin/env node
/**
 * N-11 / DSK-02·03：桌面**更新链元数据**一致性守卫。
 *
 * ## 为什么需要它（本仓已实爆两次的同型事故）
 *
 * electron-updater 的更新链不靠"包能装"，而靠**三处元数据严格对齐**：
 *   ① `electron-builder.yml` 的 `artifactName`（决定产物文件名）
 *   ② 打包生成的 `latest-linux.yml` / `latest.yml` 里 `path` + `files[].url`
 *   ③ `publish` 段指向的 provider 与 `updater.ts` 的 `setFeedURL` 语义
 * 三者一旦错位，**打包成功、安装成功、更新永远 404**——用户侧表现为
 * "点了检查更新没反应"（updater 对 4xx/5xx 一律静默 log.warn，不打扰用户），
 * 即**绿灯但不干活**，最难被 CI 发现的一类。
 *
 * 本仓真实事故（均记录在 workflow 注释里）：
 *   · `desktop-v1.5.1` 首次 tag：Linux 段嵌套 `AppImage:` 键非法，
 *     electron-builder scheme 校验三平台全挂（已修为顶层 artifactName）。
 *   · `v1.5.0`：SDK 发版抢占 GitHub `latest` release，桌面端更新 404
 *     （结构性复发，见 release.yml 注释）。
 *
 * ## 判据（纯静态读配置，不需要打包、不需要网络，秒级）
 *
 *   ① `artifactName` 必须是**顶层** Linux 配置键（嵌套 `AppImage:`/`deb:` 下
 *      的 artifactName 会被 electron-builder scheme 校验拒绝——v1.5.1 实爆）。
 *   ② `artifactName` 模板里的占位符必须是 electron-builder 支持的集合
 *      （`${version}` / `${ext}` / `${name}` / `${arch}` / `${os}` / `${productName}` /
 *      `${channel}`），拼错的占位符会原样进文件名 → latest yml 的 url 对不上。
 *   ③ `artifactName` 必须包含 `${version}`——否则同名产物覆盖，`latest.yml`
 *      的版本比较基准失真（updater 会认为"已是最新"）。
 *   ④ `publish` provider 必须是 electron-updater 支持的枚举；`generic` 时
 *      必须有 `url`（updater.ts 的 `setFeedURL({provider:'generic',url})` 依赖它）。
 *   ⑤ `updater.ts` 声明的 feed 语义与 `electron-builder.yml` 的 publish 段
 *      **必须同时存在**（一方被删则另一方的注释承诺落空）。
 *
 * ## 用法
 *   node scripts/check-desktop-update-chain.mjs             # 守卫
 *   node scripts/check-desktop-update-chain.mjs --report    # 打印当前配置面
 *   node scripts/check-desktop-update-chain.mjs --selftest
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const BUILDER_YML = 'apps/executor-desktop/electron-builder.yml';
const UPDATER_TS = 'apps/executor-desktop/src/main/updater.ts';

/** electron-builder 支持的 artifactName 占位符（v26 scheme 实测集合）。 */
export const ALLOWED_PLACEHOLDERS = new Set([
  'version',
  'ext',
  'name',
  'arch',
  'os',
  'productName',
  'channel',
  'platform',
]);

/** electron-updater 支持的 publish provider 枚举。 */
export const ALLOWED_PROVIDERS = new Set([
  'generic',
  'github',
  's3',
  'spaces',
  'bintray',
  'snap',
  'keygen',
  'bitbucket',
  'gitlab',
]);

/**
 * 极简 YAML 子集解析：只取本守卫需要的键路径。
 * 不引 js-yaml（本脚本必须零依赖秒级跑）；`electron-builder.yml` 的结构
 * 由本仓维护，缩进风格稳定，故用「缩进层级 + 行首键」提取足够可靠，
 * 且**解析失败即失败**（不静默放过）。
 */
export function parseYamlSubset(text) {
  const lines = text.split(/\r?\n/);
  const result = { linux: {}, publish: [], topLevelKeys: [] };
  let section = null; // 'linux' | 'publish' | null
  let linuxIndent = null;
  let inPublishList = false;
  let currentPublish = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();

    // 顶层键（缩进 0）
    if (indent === 0) {
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(body);
      if (m) {
        result.topLevelKeys.push(m[1]);
        if (m[1] === 'linux') {
          section = 'linux';
          linuxIndent = null;
        } else if (m[1] === 'publish') {
          section = 'publish';
          inPublishList = false;
          currentPublish = null;
        } else {
          section = null;
        }
        // 顶层 linux 的 inline 形态（linux: {target: ...}）不支持，如实标记
        if (m[1] === 'linux' && m[2] && m[2] !== '') {
          result.linuxInlineUnsupported = m[2];
        }
      }
      continue;
    }

    if (section === 'linux') {
      if (linuxIndent === null) linuxIndent = indent;
      // linux 段内：比 linuxIndent 更深的是嵌套键（如 AppImage:/deb:）
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(body);
      if (m) {
        if (indent === linuxIndent) {
          result.linux[m[1]] = m[2];
          result.linuxNestedKeys = result.linuxNestedKeys ?? [];
        } else if (indent > linuxIndent) {
          result.linuxNestedKeys = result.linuxNestedKeys ?? [];
          result.linuxNestedKeys.push({ key: m[1], value: m[2], indent });
        }
      }
      continue;
    }

    if (section === 'publish') {
      // publish 段有**两种合法形态**（首版只处理了列表形态，于是把本仓的
      // 映射形态误报成"无 publish 段"——守卫自身的假阳性，实测暴露后修正）：
      //   映射形态：publish:\n  provider: github\n  owner: ...
      //   列表形态：publish:\n  - provider: github\n    owner: ...
      if (/^-\s/.test(body)) {
        const rest = body.replace(/^-\s*/, '');
        const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(rest);
        currentPublish = {};
        if (m) currentPublish[m[1]] = m[2].replace(/^["']|["']$/g, '');
        result.publish.push(currentPublish);
        inPublishList = true;
      } else {
        const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(body);
        if (!m) continue;
        if (!inPublishList) {
          // 映射形态：整段就是单个 publish 配置
          if (!currentPublish) {
            currentPublish = {};
            result.publish.push(currentPublish);
          }
          currentPublish[m[1]] = m[2].replace(/^["']|["']$/g, '');
        } else if (currentPublish) {
          currentPublish[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
      continue;
    }
  }
  return result;
}

/** 从 artifactName 模板里抽出占位符名。 */
export function placeholdersOf(template) {
  const names = [];
  for (const m of String(template).matchAll(/\$\{([^}]*)\}/g)) names.push(m[1].trim());
  return names;
}

/**
 * @param {object} opts
 * @param {string} opts.builderText  electron-builder.yml 内容
 * @param {string} opts.updaterText  updater.ts 内容
 */
export function check({ builderText, updaterText }) {
  const failures = [];
  const notes = [];
  const parsed = parseYamlSubset(builderText);

  if (parsed.linuxInlineUnsupported) {
    failures.push(
      `electron-builder.yml 的 linux 段是 inline 形态（linux: ${parsed.linuxInlineUnsupported}）——` +
        `本守卫只解析块形态；请改块形态，或同步扩展解析器（不得静默放过）`,
    );
  }

  // ① artifactName 必须是 linux 段**顶层**键
  const nestedArtifact = (parsed.linuxNestedKeys ?? []).find((k) => k.key === 'artifactName');
  if (nestedArtifact) {
    failures.push(
      `artifactName 出现在 linux 的**嵌套**键下（缩进 ${nestedArtifact.indent}）——` +
        `electron-builder v26 scheme 校验会拒（desktop-v1.5.1 首次 tag 三平台全挂的根因）。` +
        `必须提到 linux 段顶层。`,
    );
  }
  const artifactName = parsed.linux.artifactName;
  if (!artifactName) {
    failures.push('electron-builder.yml 的 linux 段缺少顶层 artifactName——产物名将由默认模板决定，与 latest-linux.yml 的 url 易错位');
  } else {
    // ② 占位符集合
    const names = placeholdersOf(artifactName);
    const bad = names.filter((n) => !ALLOWED_PLACEHOLDERS.has(n));
    if (bad.length > 0) {
      failures.push(
        `artifactName 含未知占位符：${bad.map((b) => '${' + b + '}').join(', ')}` +
          `（支持：${[...ALLOWED_PLACEHOLDERS].join('/')}）。拼错的占位符会原样进文件名，latest yml 的 url 对不上。`,
      );
    }
    // ③ 必须含 ${version}
    if (!names.includes('version')) {
      failures.push(
        `artifactName 缺少 \${version}——同名产物会互相覆盖，latest.yml 的版本比较基准失真（updater 会误判"已是最新"）`,
      );
    }
    if (bad.length === 0 && names.includes('version')) {
      notes.push(`artifactName 合法：${artifactName}（占位符 ${names.join('/')}）`);
    }
  }

  // ④ publish provider 枚举 + generic 必须有 url
  if (parsed.publish.length === 0) {
    failures.push(
      'electron-builder.yml 无 publish 段——默认源（GitHub Releases）缺失，打包不会生成 app-update.yml，' +
        'updater 的 setFeedURL 回落路径落空（更新链断）',
    );
  } else {
    for (const p of parsed.publish) {
      if (!p.provider) {
        failures.push(`publish 条目缺少 provider：${JSON.stringify(p)}`);
        continue;
      }
      if (!ALLOWED_PROVIDERS.has(p.provider)) {
        failures.push(`publish.provider 非法：${p.provider}（支持：${[...ALLOWED_PROVIDERS].join('/')}）`);
      }
      if (p.provider === 'generic' && !p.url) {
        failures.push('publish.provider=generic 但缺少 url——updater 的 setFeedURL({provider,url}) 无源可依');
      }
    }
    notes.push(`publish provider：${parsed.publish.map((p) => p.provider).join(', ')}`);
  }

  // ⑤ updater.ts 的 feed 语义必须与 publish 段同时存在
  if (!/setFeedURL|app-update\.yml|AUTOUPDATE_URL/.test(updaterText)) {
    failures.push(
      'updater.ts 未见 setFeedURL / AUTOUPDATE_URL / app-update.yml 任一面——' +
        '更新源接线被移除？publish 段的承诺将无人消费',
    );
  } else {
    const hasGeneric = /provider:\s*['"]generic['"]/.test(updaterText);
    const hasPublishGeneric = parsed.publish.some((p) => p.provider === 'generic');
    if (hasGeneric && !hasPublishGeneric) {
      notes.push('updater.ts 支持 generic 覆盖源（AUTOUPDATE_URL），但 builder 未声明 generic publish——属正常（generic 是运行时覆盖）');
    }
    notes.push('updater.ts 的更新源接线在位（setFeedURL / AUTOUPDATE_URL / app-update.yml）');
  }

  return { failures, notes, parsed };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    const r = spawnSync(process.execPath, [path.join(here, 'check-desktop-update-chain.selftest.mjs')], {
      stdio: 'inherit',
    });
    process.exit(r.status ?? 1);
  }

  const builderText = fs.readFileSync(path.join(root, BUILDER_YML), 'utf8');
  const updaterText = fs.readFileSync(path.join(root, UPDATER_TS), 'utf8');

  if (args.includes('--report')) {
    const p = parseYamlSubset(builderText);
    console.log(`artifactName（linux 顶层）：${p.linux.artifactName ?? '(缺失)'}`);
    console.log(`publish：${JSON.stringify(p.publish)}`);
    console.log(`linux 段顶层键：${Object.keys(p.linux).join(', ')}`);
    process.exit(0);
  }

  const { failures, notes } = check({ builderText, updaterText });
  for (const n of notes) console.log(`  ● ${n}`);
  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error('\n桌面更新链元数据守卫失败——三者错位会导致"打包/安装都成功、更新永远 404"。');
    process.exit(1);
  }
  console.log('\n桌面更新链元数据一致（artifactName / publish / updater 接线）。');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}