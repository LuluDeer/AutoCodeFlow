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
 * ## T4（第 4 轮守卫自检审计）：伴生 selftest **收编**进 `--selftest`
 *
 * 原 `scripts/check-desktop-update-chain.selftest.mjs` 已删除，全部断言并入下面的
 * `selftest()`（用例对照见该函数）。**为什么收编而不是保留**：
 *   · 该伴生文件的每一条用例都在测**本脚本的判据**——它 `import { check,
 *     parseYamlSubset, placeholdersOf }`，喂一段 yml/ts 文本再断言 failures。
 *     它读的是两份**仓内配置事实源**（`electron-builder.yml` 与 `updater.ts`），
 *     既不需要 `electron-builder` 打包、不需要 `dist-electron/` 产物、也不联网
 *     ——所以「保留伴生文件」的理由（独立工具 / 打包产物 / 网络）在这里不成立。
 *   · 旧形态的共同失效模式正好落在「函数级断言」的盲区：它直接调 `check()`，
 *     于是删掉 CLI 的 `process.exit(1)`、`--root` 把路径吃掉、报错文案改两个
 *     字符，它一条都看不见。收编时全部改写为 `runGuard` 真子进程 + `expectExit`。
 *   · 原 ⑥（两种 publish 形态）与 ⑦（占位符提取）不再直接调解析器，改为**经判据的
 *     后果断言**：列表形态若解析不出来，真脚本会报「publish 条目缺少 provider」；
 *     占位符若提取错，多占位符模板会被报「未知占位符」。更强（连"解析对了但没
 *     接线"也能抓住），且不再与实现共享同一个函数。
 *
 * ## T4 同时补的两件事（不改判据语义，只补「事实源缺失」与「扫描面塌陷」）
 *   · **`--root`**：模块级 `const root = path.resolve(here,'..')` 收成参数，
 *     `import` 本文件时不实扫、不 `process.exit`；selftest 才能在 fixture 树上跑真脚本。
 *   · **结构红**：① 两份事实源缺失（旧版 `readFileSync` 直接崩栈，只看到 ENOENT）；
 *     ② `parseYamlSubset` 从 `linux` 段解析出的顶层键少于 `MIN_LINUX_TOP_KEYS`
 *     ——本守卫的解析器是手写的缩进状态机，yml 改成 inline / 缩进风格变化时它会
 *     **静默产出空对象**，于是除了「缺少 artifactName」之外每条判据都在空集上成立
 *     （「0 个 publish 条目 = 0 个非法 provider」）。扫描面塌陷必须自成一类红灯。
 *
 * ## 用法
 *   node scripts/check-desktop-update-chain.mjs             # 守卫
 *   node scripts/check-desktop-update-chain.mjs --report    # 打印当前配置面
 *   node scripts/check-desktop-update-chain.mjs --selftest  # 有齿自检（真子进程）
 *   node scripts/check-desktop-update-chain.mjs --root <dir> # 只给 selftest：把 fixture 当仓库根
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectExit, makeFixtureRepo, reportCases, runGuard } from './lib/guard-selftest.mjs';

const SELF = fileURLToPath(import.meta.url);

/** 两份事实源（相对仓库根）。 */
export const BUILDER_YML = 'apps/executor-desktop/electron-builder.yml';
export const UPDATER_TS = 'apps/executor-desktop/src/main/updater.ts';

/**
 * 扫描面下界：`linux` 段至少要解析出 1 个顶层键（实测 11 个）。
 *
 * 取 1 而不是取「接近实测值」是有意的：下界只负责区分**解析面塌陷**（0 个键，
 * 解析器什么都没认出来）与**配置退化**（少了一两个键——那由 ①③④ 逐条判红，
 * 例如只写 `target` 而漏 `artifactName` 是"违规"，不是"判据不可信"）。
 * 把下界抬高到 2 就会把「漏写 artifactName」错报成结构错误，丢掉具体文案。
 */
export const MIN_LINUX_TOP_KEYS = 1;

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

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
  const structure = [];
  const parsed = parseYamlSubset(builderText);

  // 结构：扫描面塌陷。手写缩进状态机产出空 linux 段时，下面除「缺少 artifactName」
  // 之外的判据全部在空集上成立（0 个 publish 条目 = 0 个非法 provider）——
  // 那种"绿"没有信息量，必须单独判红。
  if (parsed.linuxInlineUnsupported) {
    // inline 形态优先：它有更具体的诊断（"改块形态或扩展解析器"），
    // 若让扫描面下界先报，读者只会看到一句"0 个顶层键"。
    failures.push(
      `electron-builder.yml 的 linux 段是 inline 形态（linux: ${parsed.linuxInlineUnsupported}）——` +
        `本守卫只解析块形态；请改块形态，或同步扩展解析器（不得静默放过）`,
    );
    return { failures, notes, parsed, structure };
  }

  const linuxKeys = Object.keys(parsed.linux);
  if (linuxKeys.length < MIN_LINUX_TOP_KEYS) {
    structure.push(
      `electron-builder.yml 的 linux 段一个顶层键都没解析出来（下界 ${MIN_LINUX_TOP_KEYS}）——` +
        `解析面已塌陷（缩进风格变化 / 段名改了 / 文件被截断），此时"无非法 publish 条目"是永真断言。`,
    );
    return { failures, notes, parsed, structure };
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

  return { failures, notes, parsed, structure };
}

// ── 自检（T4：原伴生 checks 全部改写为真子进程断言）─────────────────────────
/** 造一份最小可解析的 electron-builder.yml（两份事实源之一）。 */
function builderYml({
  artifactName = 'AutoCodeFlow-Executor-${version}.${ext}',
  publish = 'publish:\n  provider: github\n  owner: O\n  repo: R\n',
  linuxExtra = '',
  linuxBody = null,
} = {}) {
  const linux =
    linuxBody ??
    ['linux:', '  target:', '    - target: AppImage', `  artifactName: ${artifactName}`, linuxExtra]
      .filter(Boolean)
      .join('\n');
  return ['appId: com.x', linux, publish].filter(Boolean).join('\n');
}

/** updater.ts（两份事实源之一）：默认含 feed 接线。 */
const GOOD_UPDATER = "autoUpdater.setFeedURL({ provider: 'generic', url });\napp-update.yml\n";

/** fixture 树：写两份事实源（传 null 表示该事实源不存在）。 */
function deskTree({ builder = builderYml(), updater = GOOD_UPDATER, extra = {} } = {}) {
  const files = { ...extra };
  if (builder !== null) files[BUILDER_YML] = builder;
  if (updater !== null) files[UPDATER_TS] = updater;
  return files;
}

/**
 * 自检：15 条用例，全部 `runGuard` 真子进程（`--root` 指向 fixture 树）。
 *
 * ①–⑩ 对应原伴生 `check-desktop-update-chain.selftest.mjs` 的用例（判据逐条保留）：
 *   ① 正例　② artifactName 嵌套（desktop-v1.5.1 实爆）　③ 拼错占位符
 *   ④ 缺 ${version}　⑤ 无 publish 段　⑥ provider 非法　⑦ generic 缺 url
 *   ⑧ updater 接线缺失　⑨ 列表形态 publish（原"两种形态"的列表侧）
 *   ⑩ 多合法占位符（原"占位符提取"的正向）
 * ⑪–⑮ 是 T4 补的 inline 形态、结构红、扫描面下界与真实配置反证（原 ⑧）。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, { files = deskTree(), expect: exp }) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: 'desktop-update-chain-selftest-' });
        try {
          expectExit(runGuard(SELF, { args: ['--root', repo.dir] }), {
            ...exp,
            withinMs: 3000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  // ── 正例 ────────────────────────────────────────────────────────
  subprocess('① 正例（顶层 artifactName + github publish + updater 接线）→ 绿', {
    expect: {
      code: 0,
      contains: [
        '桌面更新链元数据一致（artifactName / publish / updater 接线）。',
        'artifactName 合法：AutoCodeFlow-Executor-${version}.${ext}',
        'publish provider：github',
      ],
      absent: ['✘', '结构错误'],
    },
  });

  // ── ① artifactName 嵌套（desktop-v1.5.1 实爆形态） ──────────────
  subprocess('② artifactName 嵌套在 AppImage: 下 → 红（v1.5.1 三平台全挂根因）', {
    files: deskTree({
      builder: builderYml({
        linuxBody: [
          'linux:',
          '  target:',
          '    - target: AppImage',
          '  AppImage:',
          '    artifactName: Foo-${version}.${ext}',
        ].join('\n'),
      }),
    }),
    expect: {
      code: 1,
      contains: ['出现在 linux 的**嵌套**键下', 'v1.5.1', '必须提到 linux 段顶层'],
      absent: ['桌面更新链元数据一致'],
    },
  });

  // ── ② 未知占位符 ───────────────────────────────────────────────
  subprocess('③ artifactName 拼错占位符（${verison}）→ 红', {
    files: deskTree({ builder: builderYml({ artifactName: 'Foo-${verison}.${ext}' }) }),
    expect: {
      code: 1,
      contains: ['未知占位符：${verison}', 'latest yml 的 url 对不上'],
      absent: ['桌面更新链元数据一致'],
    },
  });

  // ── ③ 缺 ${version}（同名覆盖 → 版本比较基准失真） ─────────────
  subprocess('④ artifactName 缺 ${version} → 红（同名覆盖、版本比较基准失真）', {
    files: deskTree({ builder: builderYml({ artifactName: 'Foo-static.${ext}' }) }),
    expect: {
      code: 1,
      contains: ['缺少 ${version}', '同名产物会互相覆盖'],
      absent: ['桌面更新链元数据一致'],
    },
  });

  // ── ④ publish 缺失 / provider 非法 / generic 缺 url ────────────
  subprocess('⑤ 无 publish 段 → 红（app-update.yml 不会生成）', {
    files: deskTree({ builder: builderYml({ publish: '' }) }),
    expect: { code: 1, contains: ['无 publish 段', 'app-update.yml'], absent: ['桌面更新链元数据一致'] },
  });
  subprocess('⑥ publish.provider=ftp → 红（不在 electron-updater 枚举里）', {
    files: deskTree({ builder: builderYml({ publish: 'publish:\n  provider: ftp\n' }) }),
    expect: {
      code: 1,
      contains: ['publish.provider 非法：ftp', '支持：generic/github/s3'],
      absent: ['桌面更新链元数据一致'],
    },
  });
  subprocess('⑦ publish.provider=generic 但缺 url → 红（setFeedURL 无源可依）', {
    files: deskTree({ builder: builderYml({ publish: 'publish:\n  provider: generic\n' }) }),
    expect: { code: 1, contains: ['publish.provider=generic 但缺少 url'], absent: ['桌面更新链元数据一致'] },
  });

  // ── ⑤ updater 接线被移除 ───────────────────────────────────────
  subprocess('⑧ updater.ts 无 setFeedURL / app-update.yml → 红（publish 承诺无人消费）', {
    files: deskTree({ updater: 'export function initUpdater() {}\n' }),
    expect: {
      code: 1,
      contains: ['updater.ts 未见 setFeedURL', '更新源接线被移除'],
      absent: ['桌面更新链元数据一致'],
    },
  });

  // ── ⑥ 列表形态 publish（首版只支持映射形态 → 假阳性） ──────────
  subprocess('⑨ 列表形态 publish（- provider: generic + url）→ 绿（两种形态都要能解析）', {
    files: deskTree({
      builder: builderYml({ publish: 'publish:\n  - provider: generic\n    url: https://x/updates\n' }),
    }),
    expect: { code: 0, contains: ['publish provider：generic', '桌面更新链元数据一致'], absent: ['✘'] },
  });

  // ── ⑦ 占位符提取（经判据的后果断言，不再直接调 placeholdersOf） ──
  subprocess('⑩ 多个合法占位符（productName/version/arch/ext）→ 绿（提取器不误报）', {
    files: deskTree({ builder: builderYml({ artifactName: '${productName}-${version}-${arch}.${ext}' }) }),
    expect: {
      code: 0,
      contains: [
        'artifactName 合法：${productName}-${version}-${arch}.${ext}',
        '占位符 productName/version/arch/ext',
      ],
      absent: ['未知占位符'],
    },
  });

  // ── ⑪ linux 段 inline 形态（本守卫只支持块形态） ────────────────
  subprocess('⑪ linux 段是 inline 形态 → 红并给修法（不得静默放过）', {
    files: deskTree({
      builder: [
        'appId: com.x',
        'linux: {target: AppImage, icon: i.png}',
        'publish:\n  provider: github',
      ].join('\n'),
    }),
    expect: { code: 1, contains: ['inline 形态', '本守卫只解析块形态'], absent: ['桌面更新链元数据一致'] },
  });

  // ── ⑫ 结构红：事实源缺失（electron-builder.yml 被删） ───────────
  subprocess('⑫ 事实源缺失（electron-builder.yml 不存在）→ 结构红，不崩栈', {
    files: deskTree({ builder: null }),
    expect: {
      code: 1,
      contains: ['结构错误', `事实源不存在：${BUILDER_YML}`],
      absent: ['桌面更新链元数据一致', 'ENOENT', 'Error:'],
    },
  });

  // ── ⑬ 结构红：事实源缺失（updater.ts 被删） ─────────────────────
  subprocess('⑬ 事实源缺失（updater.ts 不存在）→ 结构红，不崩栈', {
    files: deskTree({ updater: null }),
    expect: {
      code: 1,
      contains: ['结构错误', `事实源不存在：${UPDATER_TS}`],
      absent: ['桌面更新链元数据一致', 'ENOENT', 'Error:'],
    },
  });

  // ── ⑭ 结构红：扫描面塌陷（linux 段一个键都解析不出来） ──────────
  subprocess(`⑭ linux 段 0 个顶层键 → 结构红（下界 ${MIN_LINUX_TOP_KEYS}，不是"无 publish 违规"）`, {
    files: deskTree({ builder: ['appId: com.x', 'linux:', 'publish:\n  provider: github'].join('\n') }),
    expect: {
      code: 1,
      contains: ['结构错误', `一个顶层键都没解析出来（下界 ${MIN_LINUX_TOP_KEYS}）`],
      absent: ['桌面更新链元数据一致', '无 publish 段'],
    },
  });

  // ── ⑮ 反证有牙：真实配置（默认根=仓库根）必须绿 ─────────────────
  cases.push({
    name: '⑮ 真实 electron-builder.yml + updater.ts 全绿（守卫真的在跑，默认根=仓库根）',
    fn: () => {
      expectExit(runGuard(SELF), {
        code: 0,
        withinMs: 3000,
        contains: ['桌面更新链元数据一致', 'publish provider：github', 'updater.ts 的更新源接线在位'],
        absent: ['✘'],
        label: '⑮ 真实配置',
      });
    },
  });

  const failed = reportCases(cases, { title: 'check-desktop-update-chain selftest' });
  if (failed > 0) process.exit(1);
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argValue(argv, '--root') ?? process.cwd());
  const builderPath = path.join(root, BUILDER_YML);
  const updaterPath = path.join(root, UPDATER_TS);

  // 事实源缺失 → 结构红（旧版 readFileSync 直接崩栈，读者只看到一句 ENOENT）
  const missing = [
    [builderPath, BUILDER_YML],
    [updaterPath, UPDATER_TS],
  ].filter(([abs]) => !fs.existsSync(abs));
  if (missing.length > 0) {
    console.error('');
    console.error('✖ 桌面更新链元数据守卫结构错误（判据本身不可信）：');
    for (const [, rel] of missing) console.error(`  · 事实源不存在：${rel}（在 ${root} 下找不到）`);
    console.error('');
    process.exit(1);
  }

  const builderText = fs.readFileSync(builderPath, 'utf8');
  const updaterText = fs.readFileSync(updaterPath, 'utf8');

  if (argv.includes('--report')) {
    const p = parseYamlSubset(builderText);
    console.log(`artifactName（linux 顶层）：${p.linux.artifactName ?? '(缺失)'}`);
    console.log(`publish：${JSON.stringify(p.publish)}`);
    console.log(`linux 段顶层键：${Object.keys(p.linux).join(', ')}`);
    process.exit(0);
  }

  const { failures, notes, structure } = check({ builderText, updaterText });
  if (structure.length > 0) {
    console.error('');
    console.error('✖ 桌面更新链元数据守卫结构错误（判据本身不可信）：');
    for (const e of structure) console.error(`  · ${e}`);
    console.error('');
    process.exit(1);
  }
  for (const n of notes) console.log(`  ● ${n}`);
  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error('\n桌面更新链元数据守卫失败——三者错位会导致"打包/安装都成功、更新永远 404"。');
    process.exit(1);
  }
  console.log('\n桌面更新链元数据一致（artifactName / publish / updater 接线）。');
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    main();
  }
}