#!/usr/bin/env node
/**
 * S6-6-5：桌面执行器「升级失败 → 回退」**可见路径**守卫（纯静态，零依赖）。
 *
 * ## 为什么需要它（两个文档互相矛盾，且没有第三条证据）
 *
 * `docs/deployment.md` 明说桌面自动更新**不做降级**（回退 = 下旧包重装），
 * 而 `docs/UPGRADING.md` 把桌面 `1.9.3 → 1.10.0` 列为「建议升」。两句话放
 * 在一起就是：**一次失败的升级，没有演练过、也没有文档钉住的退路**。
 * 既有 `scripts/check-desktop-update-chain.mjs` 只覆盖「元数据三处对齐」，
 * 它保证的是「更新能被发现」，不保证「升级砸了能退回去」。
 *
 * ## 本守卫的立场（主会话裁定：只做可见的回退路径，**不实现自动降级**）
 *
 * 不碰 `allowDowngrade`、不碰安装器、不新增命令；只把「下旧包重装」这条路
 * 用三条静态一致性钉住，让它**可定位、可照抄、可验证**：
 *
 *   ① 发布产物命名规则 → 能定位上一版安装包
 *      `electron-builder.yml` 的 win/mac/linux `artifactName` 必须含 `${version}`
 *      （每版产物名唯一 ⇒ 旧版本文件名可推导），且用文档里的示例版本展开出的
 *      三个平台文件名，必须**逐字**出现在回退段里。
 *      反过来说：改 `artifactName` 而不同步文档 ⇒ 文档命令指向一个不存在的
 *      资产（用户按命令下载 404），守卫转红。
 *   ② 回退段可复制：从哪拿旧包（`gh release download desktop-v<ver>` + `--pattern`）
 *      + 怎么装（用下载到的 AppImage 覆盖）+ 装完怎么验证（config.json 仍在）。
 *   ③ 配置路径在 Electron `userData` 下（回退不丢配置）
 *      读 `config-store.ts` 的 `configFilePath()`，要求它的函数体基于
 *      `app.getPath('userData')`；文档里的配置路径必须等于
 *      `<userData>/<package.json 的 name>/config.json`。
 *      目录名取 `name` 而不是 electron-builder 的 `productName`：本轮实测
 *      `electron-builder --dir` 产出的 `app.asar/package.json` 只有
 *      `name: executor-desktop`（无 `productName`），Electron 的 `app.getName()`
 *      因此回落 `name` ⇒ Linux userData 是 `~/.config/executor-desktop/`。
 *      文档旧值 `~/.config/autocodeflow-executor/` 就是这么被这条判据抓出来的。
 *   ④ 选边写死：仓库里不得悄悄打开自动降级（`allowDowngrade = true`），
 *      文档回退段必须写明「不做降级」。否则「重装回退」的叙述与代码相反。
 *
 * ## 结构红（判据面消失时红，不是绿）
 *
 *   · 任一事实源缺失（打包配置 / updater / config-store / package.json /
 *     两份文档）→ 结构红（不是「0 条违规」）；
 *   · `electron-builder.yml` 一个平台的 `artifactName` 都解析不出来 → 结构红；
 *   · `docs/deployment.md` 找不到含「回退/回滚」的标题段 → 结构红
 *     （文档缺回退步骤 = 判据面消失，不能当成「没问题」）；
 *   · `config-store.ts` 里找不到 `configFilePath()` → 结构红。
 *
 * ## 明确**不**检查（避免被当成「回退已演练」的证据）
 *
 *   · 真实下载 / 安装 / 覆盖安装是否成功（需真机 + 两个已发布版本）；
 *   · electron-updater 的 feed 语义、`latest*.yml` 与本地版本的比较
 *     （属 `check-desktop-update-chain.mjs`）；
 *   · 用户数据 / 库结构兼容性（旧版能否在新库上启动，S6 §8-3 仍是未验证项）；
 *   · deb 手动升级包名（`deb.artifactName` 用 `${name}/${arch}`，不参与自动
 *     更新；本文档只给示例，守卫不钉）；
 *   · 真机演练记录（优先级登记册 §6-V13，一次性人工项）。
 *
 * ## 用法
 *   node scripts/check-desktop-rollback-path.mjs             # 守卫
 *   node scripts/check-desktop-rollback-path.mjs --report    # 打印当前回退面
 *   node scripts/check-desktop-rollback-path.mjs --selftest  # 有齿自检（真子进程）
 *   node scripts/check-desktop-rollback-path.mjs --root <dir> # 只给 selftest
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPO_ROOT,
  expectExit,
  makeFixtureRepo,
  reportCases,
  runGuard,
} from './lib/guard-selftest.mjs';

const SELF = fileURLToPath(import.meta.url);

/** 事实源（相对仓库根）。 */
export const BUILDER_YML = 'apps/executor-desktop/electron-builder.yml';
export const UPDATER_TS = 'apps/executor-desktop/src/main/updater.ts';
export const CONFIG_STORE_TS = 'apps/executor-desktop/src/main/config-store.ts';
export const PKG_JSON = 'apps/executor-desktop/package.json';
export const DEPLOYMENT_MD = 'docs/deployment.md';
export const UPGRADING_MD = 'docs/UPGRADING.md';

/** 每个平台「自动更新产物」的扩展名（deb 不参与自动更新，见头注）。 */
const PLATFORM_EXT = { win: 'exe', mac: 'dmg', linux: 'AppImage' };

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/** 顶层段 → 其直接子键（缩进取该段内最小缩进）。够用且不引 yaml 依赖。 */
export function parseSections(text) {
  const sections = new Map();
  let current = null;
  let childIndent = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (indent === 0) {
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(body);
      if (!m) {
        current = null;
        continue;
      }
      current = {};
      childIndent = null;
      sections.set(m[1], current);
      continue;
    }
    if (!current) continue;
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue; // 更深的是嵌套段（如 linux.target）
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(body);
    if (m) current[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return sections;
}

/** 把 artifactName 模板展开成「某一版」的具体文件名；`${arch}` 展开为 *。 */
export function expandAssetName(template, { version, ext, name, productName, os = '*' }) {
  return String(template)
    .replace(/\$\{version\}/g, version)
    .replace(/\$\{ext\}/g, ext)
    .replace(/\$\{arch\}/g, '*')
    .replace(/\$\{name\}/g, name)
    .replace(/\$\{productName\}/g, productName)
    .replace(/\$\{os\}/g, os);
}

/** 取 markdown 里所有标题匹配 headingRe 的段（到下一个同级/更高级标题为止）。
 *  代码块里的 `# 0) …` 是 shell 注释，不是标题——不跳过围栏就会把回退段截断
 *  在第一个 shell 注释处（首版实测：四条判据全部「在段内找不到」）。 */
export function markdownSections(text, headingRe) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m) headings.push({ i, level: m[1].length, title: m[2] });
  }
  const out = [];
  for (let h = 0; h < headings.length; h++) {
    if (!headingRe.test(headings[h].title)) continue;
    let end = lines.length;
    for (let k = h + 1; k < headings.length; k++) {
      if (headings[k].level <= headings[h].level) {
        end = headings[k].i;
        break;
      }
    }
    out.push({
      heading: lines[headings[h].i].trim(),
      line: headings[h].i + 1,
      body: lines.slice(headings[h].i + 1, end).join('\n'),
    });
  }
  return out;
}

/**
 * 找「桌面」回退段：标题含回退/回滚，且正文提到桌面产物名。
 * 只按标题找会命中 `### 回滚`（deploy.sh 的部署回滚，第 293 行）——那是另一条路径，
 * 用它当判据面等于永远绿（它本来就没有 gh release download）。
 */
export function findDesktopRollbackSection(text, appName) {
  const hits = markdownSections(text, /回退|回滚/);
  return (
    hits.find(
      (s) => s.body.includes('AutoCodeFlow-Executor') || s.body.includes(`${appName}/config.json`),
    ) ?? null
  );
}

/** 按大括号配对取函数体（找不到函数返回 null）。 */
export function functionBody(text, signatureRe) {
  const m = signatureRe.exec(text);
  if (!m) return null;
  const open = text.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * 判据主体（纯函数，便于 selftest 复用）。
 *
 * @returns {{failures: string[], notes: string[], structure: string[], facts: object}}
 */
export function check({ builderText, updaterText, configStoreText, pkgText, deploymentText, upgradingText }) {
  const failures = [];
  const notes = [];
  const structure = [];
  const facts = { platforms: {}, version: null, appName: null, assets: {} };

  // ── 结构：打包配置的扫描面 ───────────────────────────────────────
  const sections = parseSections(builderText);
  for (const platform of Object.keys(PLATFORM_EXT)) {
    const artifactName = sections.get(platform)?.artifactName;
    if (artifactName) facts.platforms[platform] = artifactName;
  }
  if (Object.keys(facts.platforms).length === 0) {
    structure.push(
      'electron-builder.yml 未解析出任何平台的 artifactName（win/mac/linux 段改名、' +
        '缩进风格变化或文件被截断）——此时「命名规则可定位上一版」是空集永真断言。',
    );
    return { failures, notes, structure, facts };
  }

  // ── 事实：package.json 的 name 决定 userData 目录名（productName 优先）──
  let pkg;
  try {
    pkg = JSON.parse(pkgText);
  } catch (err) {
    structure.push(`apps/executor-desktop/package.json 不是合法 JSON：${err.message}`);
    return { failures, notes, structure, facts };
  }
  const appName = pkg.productName || pkg.name;
  facts.appName = appName;

  // ── 结构：文档回退段 ───────────────────────────────────────────
  const section = findDesktopRollbackSection(deploymentText, appName);
  if (!section) {
    structure.push(
      'docs/deployment.md 找不到「桌面回退」段（标题含回退/回滚且正文提到桌面产物名）' +
        '——文档缺回退步骤，本守卫无法区分「路径没写」与「路径断了」' +
        '（按判据面消失处理，不是绿）。',
    );
    return { failures, notes, structure, facts };
  }
  facts.section = section;

  // ── ① 命名规则：每个平台都要含 ${version} ───────────────────────
  for (const [platform, artifactName] of Object.entries(facts.platforms)) {
    if (!artifactName.includes('${version}')) {
      failures.push(
        `electron-builder.yml 的 ${platform}.artifactName 不含 \${version}` +
          `（当前：${artifactName}）——同名产物互相覆盖，上一版安装包无法按名字定位。`,
      );
    }
  }

  // ── ①（续）文档示例版本 → 回退段必须逐字含三个平台的旧包名 ────────
  const versionMatch = /desktop-v(\d+\.\d+\.\d+)/.exec(section.body);
  if (!versionMatch) {
    failures.push(
      `docs/deployment.md 的回退段（第 ${section.line} 行起）没有引用 desktop-v<版本> 的 Release tag` +
        '——读者无从得知「从哪里拿旧包」。',
    );
  } else {
    facts.version = versionMatch[1];
    for (const [platform, artifactName] of Object.entries(facts.platforms)) {
      const asset = expandAssetName(artifactName, {
        version: facts.version,
        ext: PLATFORM_EXT[platform],
        name: pkg.name,
        productName: pkg.productName || pkg.name,
      });
      facts.assets[platform] = asset;
      if (!section.body.includes(asset)) {
        failures.push(
          `文档回退段定位不到上一版安装包：按 electron-builder.yml 的 ${platform}.artifactName ` +
            `展开应为 ${asset}，但 docs/deployment.md 的回退段没有出现该文件名` +
            '（改命名规则必须同步改文档，否则用户按文档下载 404）。',
        );
      }
    }
  }

  // ── ② 文档：取包命令 / 覆盖安装 / 装完验证 ──────────────────────
  if (!/gh release download desktop-v\d+\.\d+\.\d+/.test(section.body)) {
    failures.push(
      `docs/deployment.md 的回退段没有「从 Releases 取旧包」的可复制命令` +
        '（期望形如 `gh release download desktop-v<版本> --repo … --pattern …`）。',
    );
  }
  const linuxAsset = facts.assets.linux;
  const installAt = linuxAsset ? section.body.indexOf(`./${linuxAsset}`) : -1;
  if (linuxAsset && installAt < 0) {
    failures.push(
      `docs/deployment.md 的回退段没有「用下载到的旧包覆盖安装」的命令` +
        `（期望出现 \`./${linuxAsset}\`）。`,
    );
  }
  // 验证必须在**覆盖安装之后**：回退段开头也会 `ls -l "$CFG"`（记下路径），
  // 只查「出现过」会把「装前记录」当成「装后验证」（首版实测：删掉装后那行仍绿）。
  const verifyAt = section.body.lastIndexOf('ls -l "$CFG"');
  if (
    !/config\.json/.test(section.body) ||
    !/\$CFG/.test(section.body) ||
    verifyAt < 0 ||
    (installAt >= 0 && verifyAt <= installAt)
  ) {
    failures.push(
      `docs/deployment.md 的回退段缺少「装完怎么验证」的可复制命令` +
        '（期望：覆盖安装之后再 `ls -l "$CFG"`，确认 config.json 仍在 userData 下）。',
    );
  }
  if (!/不做(自动)?降级/.test(section.body)) {
    failures.push(
      `docs/deployment.md 的回退段没有写明「不做降级」——选边必须写死，` +
        '否则「重装回退」的叙述与 updater 行为可能相反。',
    );
  }

  // ── ③ 配置路径必须在 userData 下，且与文档一致 ─────────────────
  const configPathBody = functionBody(
    configStoreText,
    /static\s+configFilePath\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/,
  );
  if (configPathBody === null) {
    structure.push(
      'apps/executor-desktop/src/main/config-store.ts 里找不到 configFilePath()' +
        '——配置路径判据面消失（改名/重构），无法确认回退不丢配置。',
    );
  } else {
    if (!/getPath\(\s*['"]userData['"]\s*\)/.test(configPathBody)) {
      failures.push(
        'config-store.ts 的 configFilePath() 不再基于 app.getPath(\'userData\')' +
          '——配置落到安装目录（或别处）时，覆盖安装/回退会丢配置。',
      );
    }
    if (!/STORE_FILE_NAME|config\.json/.test(configPathBody)) {
      failures.push('config-store.ts 的 configFilePath() 里找不到配置文件名（STORE_FILE_NAME / config.json）。');
    }
  }
  const docConfig = `/${appName}/config.json`;
  if (!section.body.includes(docConfig)) {
    failures.push(
      `文档里的配置路径与 app.asar/package.json 的 ${pkg.productName ? 'productName' : 'name'} 不符：` +
        `期望出现 ${docConfig}（Electron userData 目录名 = package.json 的 ` +
        `${pkg.productName ? 'productName' : 'name'}）。写错路径会让「回退后配置仍在」的核对指向空目录。`,
    );
  }
  if (!/(XDG_CONFIG_HOME|~\/\.config)/.test(section.body)) {
    failures.push('文档回退段没有给出 Linux userData 根（`${XDG_CONFIG_HOME:-$HOME/.config}` 或 `~/.config`）。');
  }

  // ── ④ 选边：不得悄悄打开自动降级 ───────────────────────────────
  for (const [label, text] of [
    [UPDATER_TS, updaterText],
    [BUILDER_YML, builderText],
  ]) {
    if (/allowDowngrade\s*(?:=|:)\s*true/.test(text)) {
      failures.push(
        `${label} 打开了 allowDowngrade=true——本仓选的是「不做自动降级」（重装回退），` +
          '要改这条产品决策必须同时改文档与本守卫，不能静默切换。',
      );
    }
  }

  // ── ⑤ UPGRADING 必须给出回退指针（矛盾的另一半）──────────────────
  if (facts.version && !upgradingText.includes(`desktop-v${facts.version}`)) {
    failures.push(
      `docs/UPGRADING.md 未给出桌面回退指针：应包含 desktop-v${facts.version}（与 deployment.md 回退段同一版本）。`,
    );
  }
  if (!/回退/.test(upgradingText) || !/deployment\.md/.test(upgradingText)) {
    failures.push(
      'docs/UPGRADING.md 未指向 docs/deployment.md 的回退段——「建议升」的同一页必须看得到退路。',
    );
  }

  notes.push(`命名规则：${Object.entries(facts.platforms).map(([p, a]) => `${p}=${a}`).join(' / ')}`);
  if (facts.version) {
    notes.push(
      `回退示例 ${facts.version} → ${Object.entries(facts.assets)
        .map(([p, a]) => `${p}=${a}`)
        .join(' / ')}`,
    );
  }
  notes.push(`userData 目录名 ${appName}（Linux：\${XDG_CONFIG_HOME:-\$HOME/.config}/${appName}/config.json）`);
  notes.push(`回退文档段：${section.heading}（第 ${section.line} 行）`);
  notes.push('allowDowngrade：未开启（默认 false）');

  return { failures, notes, structure, facts };
}

// ── 自检（真子进程；正例控制组用**真实仓库**，负例用真实文件的定点变异）──────
function readReal(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const CASES = [];
function caseRun(name, { mutate = {}, drop = [], expect }) {
  CASES.push({
    name,
    fn: () => {
      const files = {};
      for (const rel of [BUILDER_YML, UPDATER_TS, CONFIG_STORE_TS, PKG_JSON, DEPLOYMENT_MD, UPGRADING_MD]) {
        files[rel] = readReal(rel);
      }
      for (const [rel, fn] of Object.entries(mutate)) files[rel] = fn(files[rel]);
      for (const rel of drop) delete files[rel];
      const repo = makeFixtureRepo(files, { prefix: 'desktop-rollback-path-selftest-' });
      try {
        expectExit(runGuard(SELF, { args: ['--root', repo.dir] }), {
          ...expect,
          withinMs: 3000,
          label: name,
        });
      } finally {
        repo.cleanup();
      }
    },
  });
}

/** 定点替换：找不到/没变化就直接抛（防止变异失效而用例假绿）。 */
function replaceOnce(from, to) {
  return (text) => {
    if (!text.includes(from)) throw new Error(`变异失效：源文本里找不到 ${JSON.stringify(from)}`);
    const next = text.replace(from, to);
    if (next === text) throw new Error(`变异失效：替换后文本未变化（${from}）`);
    return next;
  };
}

/** 正则整体替换：没匹配到就直接抛（同上，防止「改坏」其实是空操作）。 */
function replaceRe(re, to) {
  return (text) => {
    const next = text.replace(re, to);
    if (next === text) throw new Error(`变异失效：正则未命中 ${re}`);
    return next;
  };
}

export function selftest() {
  // ① 正例控制组：真实仓库（默认根）必须绿——否则「全绿」没有意义。
  CASES.push({
    name: '① 正例控制组：真实配置 + 真实文档 → 绿（守卫真的在跑）',
    fn: () =>
      expectExit(runGuard(SELF), {
        code: 0,
        withinMs: 3000,
        contains: [
          '桌面回退路径一致',
          '命名规则：win=',
          'allowDowngrade：未开启',
          'userData 目录名 executor-desktop',
        ],
        absent: ['✘', '结构错误'],
        label: '① 正例控制组',
      }),
  });

  caseRun('② artifactName 改名（Setup 加 -portable）→ 红：文档定位不到上一版', {
    mutate: {
      [BUILDER_YML]: replaceOnce(
        'artifactName: AutoCodeFlow-Executor-Setup-${version}.${ext}',
        'artifactName: AutoCodeFlow-Executor-Setup-${version}-portable.${ext}',
      ),
    },
    expect: {
      code: 1,
      contains: ['文档回退段定位不到上一版安装包', 'AutoCodeFlow-Executor-Setup-1.9.3-portable.exe'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('③ linux.artifactName 去掉 ${version} → 红：同名覆盖、无法按版本定位', {
    mutate: {
      [BUILDER_YML]: replaceOnce(
        'artifactName: AutoCodeFlow-Executor-${version}.${ext}',
        'artifactName: AutoCodeFlow-Executor.${ext}',
      ),
    },
    expect: {
      code: 1,
      contains: ['linux.artifactName 不含 ${version}', '无法按名字定位'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('④ 回退段没有 desktop-v<版本> tag → 红：不知道从哪拿旧包', {
    mutate: { [DEPLOYMENT_MD]: replaceRe(/desktop-v1\.9\.3/g, '上一版') },
    expect: {
      code: 1,
      contains: ['没有引用 desktop-v<版本> 的 Release tag'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑤ 删掉 gh release download 命令 → 红：取包步骤不可复制', {
    mutate: {
      [DEPLOYMENT_MD]: replaceRe(/^gh release download .*$/gm, 'echo TODO 取旧包'),
    },
    expect: {
      code: 1,
      contains: ['没有「从 Releases 取旧包」的可复制命令'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑥ 删掉装完验证（ls -l "$CFG"）→ 红：没有验证步骤', {
    mutate: { [DEPLOYMENT_MD]: replaceRe(/^ls -l "\$CFG".*$/gm, '') },
    expect: {
      code: 1,
      contains: ['缺少「装完怎么验证」的可复制命令', '覆盖安装之后'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑦ package.json name 改变 → 红：文档的配置路径指向旧目录', {
    mutate: {
      [PKG_JSON]: replaceOnce('"name": "executor-desktop"', '"name": "executor-desktop-next"'),
    },
    expect: {
      code: 1,
      contains: ['文档里的配置路径与 app.asar/package.json', '/executor-desktop-next/config.json'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑧ configFilePath 改用 getPath(\'home\') → 红：配置不在 userData 下', {
    mutate: {
      [CONFIG_STORE_TS]: replaceOnce(
        "return path.join(app.getPath('userData'), `${STORE_FILE_NAME}.json`);",
        "return path.join(app.getPath('home'), `${STORE_FILE_NAME}.json`);",
      ),
    },
    expect: {
      code: 1,
      contains: ['不再基于 app.getPath(\'userData\')', '回退会丢配置'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑨ config-store.ts 删掉 configFilePath() → 结构红（判据面消失）', {
    mutate: {
      [CONFIG_STORE_TS]: replaceRe(/static\s+configFilePath\s*\([^)]*\)\s*(?::\s*[^{]+)?\{[\s\S]*?\n  \}/, ''),
    },
    expect: {
      code: 1,
      contains: ['结构错误', '找不到 configFilePath()'],
      absent: ['桌面回退路径一致', 'Error:'],
    },
  });

  caseRun('⑩ updater.ts 打开 allowDowngrade=true → 红：与「不做降级」相反', {
    mutate: {
      [UPDATER_TS]: replaceOnce(
        'autoUpdater.autoDownload = false;',
        'autoUpdater.autoDownload = false;\n  autoUpdater.allowDowngrade = true;',
      ),
    },
    expect: {
      code: 1,
      contains: ['打开了 allowDowngrade=true', '不做自动降级'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑪ 缺 electron-builder.yml → 结构红，不崩栈', {
    drop: [BUILDER_YML],
    expect: {
      code: 1,
      contains: ['结构错误', `事实源不存在：${BUILDER_YML}`],
      absent: ['桌面回退路径一致', 'ENOENT'],
    },
  });

  caseRun('⑫ 缺 docs/UPGRADING.md → 结构红（矛盾的另一半不可查）', {
    drop: [UPGRADING_MD],
    expect: {
      code: 1,
      contains: ['结构错误', `事实源不存在：${UPGRADING_MD}`],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑬ UPGRADING 删掉回退指针 → 红：「建议升」旁边看不到退路', {
    mutate: {
      [UPGRADING_MD]: replaceRe(/desktop-v1\.9\.3/g, 'desktop-v0.0.0'),
    },
    expect: {
      code: 1,
      contains: ['未给出桌面回退指针', 'desktop-v1.9.3'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑭ electron-builder.yml 无 win/mac/linux 段 → 结构红（扫描面塌陷）', {
    mutate: {
      [BUILDER_YML]: (text) => text.replace(/^(win|mac|linux):$/gm, '$1-disabled:'),
    },
    expect: {
      code: 1,
      contains: ['结构错误', '未解析出任何平台的 artifactName'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑮ 回退段删掉 macOS 的 --pattern → 红：漏一个平台也算定位不到', {
    mutate: {
      [DEPLOYMENT_MD]: replaceRe(
        /^gh release download desktop-v1\.9\.3 --repo LuluDeer\/AutoCodeFlow \\\n  --pattern 'AutoCodeFlow-Executor-1\.9\.3-\*\.dmg'.*$/gm,
        '',
      ),
    },
    expect: {
      code: 1,
      contains: ['文档回退段定位不到上一版安装包', 'AutoCodeFlow-Executor-1.9.3-*.dmg'],
      absent: ['桌面回退路径一致'],
    },
  });

  caseRun('⑯ 回退段标题被改名（不含「回退/回滚」）→ 结构红：文档步骤不可达', {
    mutate: {
      [DEPLOYMENT_MD]: replaceOnce(
        '#### 回退：从 Releases 重装上一版（不做自动降级）',
        '#### 手动重装：从 Releases 取旧包',
      ),
    },
    expect: {
      code: 1,
      contains: ['结构错误', '找不到「桌面回退」段'],
      absent: ['桌面回退路径一致'],
    },
  });

  const failed = reportCases(CASES, { title: 'check-desktop-rollback-path selftest' });
  if (failed > 0) process.exit(1);
}

function main(argv = process.argv.slice(2)) {
  const root = path.resolve(argValue(argv, '--root') ?? process.cwd());
  const sources = [BUILDER_YML, UPDATER_TS, CONFIG_STORE_TS, PKG_JSON, DEPLOYMENT_MD, UPGRADING_MD];

  const missing = sources.filter((rel) => !fs.existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    console.error('');
    console.error('✖ 桌面回退路径守卫结构错误（判据本身不可信）：');
    for (const rel of missing) console.error(`  · 事实源不存在：${rel}（在 ${root} 下找不到）`);
    console.error('');
    process.exit(1);
  }

  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const input = {
    builderText: read(BUILDER_YML),
    updaterText: read(UPDATER_TS),
    configStoreText: read(CONFIG_STORE_TS),
    pkgText: read(PKG_JSON),
    deploymentText: read(DEPLOYMENT_MD),
    upgradingText: read(UPGRADING_MD),
  };

  const { failures, notes, structure, facts } = check(input);

  if (argv.includes('--report')) {
    for (const n of notes) console.log(`  ● ${n}`);
    console.log(
      `  allowDowngrade=true 出现次数：${(input.updaterText.match(/allowDowngrade\s*=\s*true/g) ?? []).length}`,
    );
    process.exit(0);
  }

  if (structure.length > 0) {
    console.error('');
    console.error('✖ 桌面回退路径守卫结构错误（判据本身不可信）：');
    for (const e of structure) console.error(`  · ${e}`);
    console.error('');
    process.exit(1);
  }
  for (const n of notes) console.log(`  ● ${n}`);
  if (failures.length > 0) {
    console.error('');
    for (const f of failures) console.error(`  ✘ ${f}`);
    console.error(
      '\n桌面回退路径守卫失败——「下旧包重装」这条路与命名规则/文档/配置路径不一致。',
    );
    process.exit(1);
  }
  console.log('\n桌面回退路径一致（命名规则 → 上一版安装包 → 文档可复制步骤 → 配置在 userData）。');
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
