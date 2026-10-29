#!/usr/bin/env node
/**
 * LANG-ERR-01：**错误码 ↔ 前端词条**对齐守卫（漂移门禁）。
 *
 * ## 为什么需要它
 *
 * 「后端抛码、前端翻译」把同一句话拆到了两个仓位置。两边各写必然漂移，三种
 * 形态全都**静默**（不报错、不影响构建）：
 *   ① 后端加了码、前端没加词条 → i18next 查不到 key 会把 **key 原样返回**，
 *      用户读到的不是文案而是 `err.EXECUTOR_NOT_FOUND` 这种标识符（本仓
 *      i18n-source-guard 记录过同类生产故障）；
 *   ② zh 两侧措辞不一致 → 同一个失败在 API 文档里一种说法、在界面上另一种；
 *   ③ 前端有词条而后端已删码 → 孤儿词条，永远渲染不到却一直被翻译与评审。
 *
 * 本仓的裁决与 `gen:api-types` 同构：**码表是唯一真值源，前端 locale 是产物**
 * （`scripts/gen-error-i18n.mjs` 生成）。故本守卫做三件事：
 *   A. 生成的 `error-codes.{zh,en}.ts` 与码表**逐字节一致**（漂移即红）；
 *   B. 手写的 `zh.ts` / `en.ts` 里**不得**再出现 `err.*` 词条——生成物在 spread
 *      链的前面，后写的同名键会**静默覆盖**生成值，于是"改了码表却看不到生效"
 *      （最难排查的一类：产物是对的，界面是旧的）；
 *   C. 每个码都有 zh 与 en（防"只写中文"的半成品被合并）；
 *   D. zh 与 en 的**占位符集合必须一致**——`zh` 用了 `{{id}}` 而 `en` 写成
 *      `{{ID}}`/漏写时，中文界面正常、**英文界面渲染出未替换的原文或空白**，
 *      且只在切到英文时才暴露（同 i18next 双花括号那次真 bug 的形态）。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的假绿
 *
 *   · **`--report` 吞结构错（最贵的一条）**：旧 `--report` 读完码表就打印表格并
 *     return 0，**完全不看**生成物与手写 locale 是否还在。而「跑 --report 确认词条
 *     齐不齐」正是这个开关唯一的用法——于是「生成物被删/改名/没生成」这种最该红
 *     的形态被报成成功。现在结构检查在 report 之前跑：结构错一律 exit 1
 *     （`--report` 只改变**输出形态**，不改变**判据**）。
 *   · **事实源缺失 = 崩栈**：生成物不在时旧实现直接 `readFileSync` 抛 ENOENT，
 *     CI 日志里是一段 stack，看不出「该跑 gen-error-i18n」；码表目录不在时报的是
 *     `ENOENT: … scandir`。现在两者都是**结构红**并点名缺的是哪个路径。
 *   · **解析口径塌方 = 静默零差异**：生成物改成双引号/改结构时 `parseLocaleKeys`
 *     一条也抓不到，此时若码表也一起塌（分片被清空），两侧都是空集合 ⇒
 *     「无差异」全绿。现在码表条目数有下界（`MIN_CATALOG_CODES`，实测 425），
 *     生成物解析出 0 条词条 = 结构红。
 *   · **`--root` 缺失**：旧实现把根钉死在 `path.resolve(here, '..')`，selftest 只能
 *     对内存字符串断言函数级性质，**守卫本身还会不会红**从未被验证过。现在所有
 *     路径相对 `root`，selftest 在 tmp fixture 树里跑真子进程。
 *   · **只数条数**：旧 selftest 断言 `parseLocaleKeys(...).size === 1`、
 *     `placeholderSet(a) === placeholderSet(b)` 之类的函数级性质——把 CLI 末尾的
 *     `process.exit(...)` 删掉，它照样全绿（这是最贵的失效形态：闸不关门）。
 *     现在逐条断言**退出码 + 关键报错文本**（13 条，含 5 条反证）。
 *   · **import 有副作用**：旧文件末尾无条件 `process.exit(...)`，任何 import 它的
 *     脚本都会顺手退出（还可能带出一个不该有的退出码）。现在只在被直接调用时跑。
 *
 * ## 用法
 *   node scripts/check-error-i18n.mjs              # 守卫
 *   node scripts/check-error-i18n.mjs --report     # 打印码表（结构错照样红）
 *   node scripts/check-error-i18n.mjs --selftest   # 验证判据本身（防永真）
 *   node scripts/check-error-i18n.mjs --root <dir> # 把该目录当仓库根（默认脚本上级目录）
 *
 * 退出码：0 = 一致；1 = 存在漂移，**或判据本身不可信**（结构错）。
 *
 * 纯静态读取源码，无需 npm ci / PG / Redis，秒级。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCatalog } from './lib/error-catalog.mjs';
import { expectExit, makeFixtureRepo, reportCases, runGuard } from './lib/guard-selftest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 默认仓库根：脚本位于 `<repo>/scripts/`。**由脚本位置推出，不依赖调用方 cwd。** */
export const DEFAULT_ROOT = path.resolve(HERE, '..');

export const CATALOG_DIR = 'apps/admin-api/src/common/errors/catalog';
export const GEN_ZH = 'apps/admin-web/src/locales/generated/error-codes.zh.ts';
export const GEN_EN = 'apps/admin-web/src/locales/generated/error-codes.en.ts';
export const HAND_ZH = 'apps/admin-web/src/locales/zh.ts';
export const HAND_EN = 'apps/admin-web/src/locales/en.ts';

/**
 * 码表规模下界（2026-10-29 实测 425 个码）。
 *
 * 解析器一旦因格式变化失配，`parseCatalog` 会返回空 Map；`readCatalog` 对
 * "0 条" 已抛错，但对"只认出 3 条"不抛——两侧同时塌时就变成永久绿。下界按
 * 实测值的 ~1/4 取，既容忍真实删码，又能抓住口径失效。
 */
export const MIN_CATALOG_CODES = 100;

/** 从生成物里抽 `'err.<CODE>': '<text>'`。 */
export function parseLocaleKeys(src) {
  const out = new Map();
  const re = /^\s*'err\.([A-Z][A-Z0-9_]*)':\s*'((?:[^'\\]|\\.)*)',\s*$/gm;
  for (const m of src.matchAll(re)) {
    out.set(m[1], m[2].replace(/\\'/g, "'"));
  }
  return out;
}

/**
 * 手写 locale 里是否残留 `err.*` 词条。
 *
 * 只统计**真正的词条行**（`'err.X': '…',`），不误伤注释与 import。
 */
export function countHandWrittenErrKeys(src) {
  return (src.match(/^\s*'err\.[A-Z][A-Z0-9_]*':\s*'/gm) || []).length;
}

/**
 * 抽出一条文案里的占位符名字集合（排序后拼串，便于比较）。
 *
 * 双花括号是 i18next 的插值语法（见 `error-code-def.ts` 的说明）。
 */
export function placeholderSet(template) {
  return [...String(template).matchAll(/\{\{(\w+)\}\}/g)]
    .map((m) => m[1])
    .sort()
    .join(',');
}

/**
 * 全量判据。
 *
 * @param {string} [root] 仓库根
 * @returns {{errors: string[], structure: string[], catalog: Map<string,{status:number,zh:string,en:string}>|null,
 *            stats: {codes:number, zhKeys:number, enKeys:number, handZh:number, handEn:number}}}
 *   `errors` = 真实漂移；`structure` = **判据本身不可信**（事实源缺失、解析口径塌方）。
 */
export function check(root = DEFAULT_ROOT) {
  const errors = [];
  const structure = [];

  // ── ① 码表（唯一真值源）────────────────────────────────────────────────────
  const catalogAbs = path.join(root, CATALOG_DIR);
  /** @type {Map<string,{status:number,zh:string,en:string}>|null} */
  let catalog = null;
  if (!fs.existsSync(catalogAbs)) {
    structure.push(
      `事实源缺失：${CATALOG_DIR} —— 判据无从比对（路径改名/分片没生成都会这样，不是「没有漂移」）。`,
    );
  } else {
    try {
      catalog = readCatalog(root, CATALOG_DIR);
    } catch (error) {
      structure.push(`码表不可读：${error.message}`);
    }
    if (catalog !== null && catalog.size < MIN_CATALOG_CODES) {
      structure.push(
        `只解析出 ${catalog.size} 个错误码（下界 ${MIN_CATALOG_CODES}）—— ` +
          '解析口径与源码格式已失配（或分片塌方）；这种分母下「0 条漂移」毫无意义。',
      );
      catalog = null;
    }
  }

  // ── ② 生成物（zh / en）────────────────────────────────────────────────────
  /** @type {{zh: Map<string,string>|null, en: Map<string,string>|null}} */
  const generated = { zh: null, en: null };
  for (const [lang, rel] of [
    ['zh', GEN_ZH],
    ['en', GEN_EN],
  ]) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      structure.push(
        `事实源缺失：${rel} —— 生成物不在（跑 node scripts/gen-error-i18n.mjs 后提交产物）。`,
      );
      continue;
    }
    const keys = parseLocaleKeys(fs.readFileSync(abs, 'utf-8'));
    if (keys.size === 0) {
      structure.push(
        `从 ${rel} 解析出 0 条 err.* 词条 —— 解析口径与文件格式已失配（判据失效，不是「词条齐备」）。`,
      );
      continue;
    }
    generated[lang] = keys;
  }

  // ── ③ 手写 locale ────────────────────────────────────────────────────────
  /** @type {Record<string, number|null>} */
  const hand = { 'zh.ts': null, 'en.ts': null };
  for (const [label, rel] of [
    ['zh.ts', HAND_ZH],
    ['en.ts', HAND_EN],
  ]) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      structure.push(
        `事实源缺失：${rel} —— 手写 locale 不在，判据 B（不得残留 err.*）无从执行。`,
      );
      continue;
    }
    hand[label] = countHandWrittenErrKeys(fs.readFileSync(abs, 'utf-8'));
  }

  const stats = {
    codes: catalog?.size ?? 0,
    zhKeys: generated.zh?.size ?? 0,
    enKeys: generated.en?.size ?? 0,
    handZh: hand['zh.ts'] ?? 0,
    handEn: hand['en.ts'] ?? 0,
  };

  // 结构不可信时不再逐条报噪声：先修判据，再谈漂移。
  if (structure.length > 0) return { errors, structure, catalog, stats };

  // C：每个码都必须有 zh 与 en（解析层已保证字段存在，这里防"空串占位"）
  for (const [code, def] of catalog) {
    if (!def.zh.trim()) errors.push(`${code} 的 zh 为空`);
    if (!def.en.trim()) errors.push(`${code} 的 en 为空`);
  }

  // D：zh 与 en 的占位符集合必须一致（否则英文界面渲染未替换原文/漏参）
  for (const [code, def] of catalog) {
    const pz = placeholderSet(def.zh);
    const pe = placeholderSet(def.en);
    if (pz !== pe) {
      errors.push(
        `${code} 的中英占位符不一致：zh=[${pz}] en=[${pe}]` +
          `（英文界面会渲染出未替换的原文或漏掉参数）`,
      );
    }
  }

  // A：生成物与码表一致
  for (const [code, def] of catalog) {
    if (generated.zh.get(code) !== def.zh) {
      errors.push(`生成物 zh 与码表不一致：err.${code}（跑 gen-error-i18n.mjs）`);
    }
    if (generated.en.get(code) !== def.en) {
      errors.push(`生成物 en 与码表不一致：err.${code}（跑 gen-error-i18n.mjs）`);
    }
  }
  for (const code of generated.zh.keys()) {
    if (!catalog.has(code)) errors.push(`孤儿 zh 词条（码表里没有）：err.${code}`);
  }
  for (const code of generated.en.keys()) {
    if (!catalog.has(code)) errors.push(`孤儿 en 词条（码表里没有）：err.${code}`);
  }

  // B：手写 locale 不得残留 err.* （会静默覆盖生成值）
  for (const [label, rel] of [
    ['zh.ts', HAND_ZH],
    ['en.ts', HAND_EN],
  ]) {
    const n = hand[label];
    if (n > 0) {
      errors.push(
        `${label} 里仍有 ${n} 条手写 err.* 词条——生成物在 spread 链前面，` +
          `同名键会被静默覆盖（改了码表却看不到生效）。请删掉手写条目，只改后端码表分片。`,
      );
    }
  }

  return { errors, structure, catalog, stats };
}

/**
 * 跑一次守卫（供 CLI 与 selftest 共用）。
 *
 * `--report` **不跳过结构检查**：它只改变输出形态（表格 vs 通过/失败），
 * 不改变判据。这是 T4 修掉的假绿之一（旧实现 `--report` 直接 return 0）。
 *
 * @param {{root?: string, report?: boolean}} [options]
 * @returns {number} 退出码
 */
export function run({ root = DEFAULT_ROOT, report = false } = {}) {
  const { errors, structure, catalog } = check(root);

  if (structure.length > 0) {
    console.error('');
    console.error('✘ LANG-ERR-01 守卫结构错误（判据本身不可信，先修事实源）：');
    for (const e of structure) console.error(`   · ${e}`);
    console.error('');
    return 1;
  }

  if (report) {
    console.log(`LANG-ERR-01 报告：码表 ${catalog.size} 个码`);
    for (const [code, def] of catalog) {
      console.log(`  ${code.padEnd(30)} ${String(def.status).padEnd(4)}`);
    }
    return 0;
  }

  if (errors.length > 0) {
    console.error(`✘ LANG-ERR-01 失败（${errors.length} 项）：`);
    for (const p of errors) console.error(`   · ${p}`);
    console.error(
      `\n  处置：改 ${CATALOG_DIR}/*.ts（真值源）后跑 node scripts/gen-error-i18n.mjs 并提交产物。`,
    );
    return 1;
  }

  console.log(
    `✔ LANG-ERR-01 通过：${catalog.size} 个错误码中英齐备、生成物无漂移、手写 locale 无残留。`,
  );
  return 0;
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本 + <1s）────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

const BASE_CODES = [
  { code: 'FOO_NOT_FOUND', status: 404, zh: '未找到「{{name}}」', en: 'Not found: {{name}}' },
  { code: 'BAR_FAILED', status: 400, zh: '操作失败', en: 'Operation failed' },
];

/** 造 N 条码（默认正好顶到 MIN_CATALOG_CODES：下界本身也顺带被每条用例钉住）。 */
function codeList({ count = MIN_CATALOG_CODES, extra = [] } = {}) {
  const list = [...BASE_CODES, ...extra];
  for (let i = list.length; i < count; i += 1) {
    list.push({
      code: `FILLER_${String(i).padStart(3, '0')}`,
      status: 400,
      zh: `填充文案 ${i}`,
      en: `Filler text ${i}`,
    });
  }
  return list;
}

const catalogSource = (list) =>
  '// fixture 码表分片（selftest 用）\n' +
  'export const fixture = {\n' +
  list
    .map((d) => `  ${d.code}: {\n    status: ${d.status},\n    zh: "${d.zh}",\n    en: "${d.en}",\n  },`)
    .join('\n') +
  '\n} as const;\n';

const localeSource = (list, { lang = 'zh', override = {}, extra = [] } = {}) =>
  `// fixture 生成物（${lang}，selftest 用）\n` +
  'export default {\n' +
  [
    ...list.map((d) => `  'err.${d.code}': '${override[d.code] ?? d[lang]}',`),
    ...extra.map(([code, text]) => `  'err.${code}': '${text}',`),
  ].join('\n') +
  '\n};\n';

const handSource = (residue = []) =>
  '// fixture 手写 locale（selftest 用）\n' +
  'export default {\n' +
  ["  'common.ok': '好的',"]
    .concat(residue.map((code) => `  'err.${code}': '手写残留',`))
    .join('\n') +
  '\n};\n';

/** fixture 树：`omit` 用于造"事实源缺失"，`list` 让码表/生成物用同一份码。 */
function tree({ list = codeList(), files = {}, omit = [] } = {}) {
  const base = {
    'package.json': { name: 'fixture', private: true },
    [`${CATALOG_DIR}/common.ts`]: catalogSource(list),
    [GEN_ZH]: localeSource(list),
    [GEN_EN]: localeSource(list, { lang: 'en' }),
    [HAND_ZH]: handSource(),
    [HAND_EN]: handSource(),
  };
  for (const key of omit) delete base[key];
  return { ...base, ...files };
}

/** 自检：13 条子进程用例（每条断言退出码 + 关键文本 + <1s）。 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect, args = []) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: 'error-i18n-selftest-' });
        try {
          expectExit(runGuard(SELF, { args: [...args, '--root', repo.dir] }), {
            ...expect,
            withinMs: 1000,
            label: name,
          });
        } finally {
          repo.cleanup();
        }
      },
    });
  };

  subprocess('① 合规树：100 码中英齐备、生成物逐字一致、手写 locale 干净 → 绿', tree(), {
    code: 0,
    contains: ['LANG-ERR-01 通过', `${MIN_CATALOG_CODES} 个错误码中英齐备`],
    absent: ['LANG-ERR-01 失败', '结构错误'],
  });

  subprocess(
    '② 生成物 zh 漂移一条 → 红（点名 err.FOO_NOT_FOUND，不是笼统「有漂移」）',
    tree({
      files: {
        [GEN_ZH]: localeSource(codeList(), { override: { FOO_NOT_FOUND: '改过的文案' } }),
      },
    }),
    {
      code: 1,
      contains: ['生成物 zh 与码表不一致：err.FOO_NOT_FOUND', 'LANG-ERR-01 失败（1 项）'],
      absent: ['LANG-ERR-01 通过'],
    },
  );

  subprocess(
    '③ 【反证·判据 B】手写 locale 残留 err.* → 红（会被生成物静默覆盖）',
    tree({ files: { [HAND_ZH]: handSource(['FOO_NOT_FOUND']) } }),
    {
      code: 1,
      contains: ['手写 err.* 词条', '静默覆盖'],
      absent: ['LANG-ERR-01 通过'],
    },
  );

  subprocess(
    '④ 【反证·注释算数】手写 locale 里只在注释中出现 err.* → 仍绿（注释不算词条）',
    tree({
      files: {
        [HAND_ZH]:
          "export default {\n  // 'err.GHOST': '注释里的示例',\n  /* 'err.GHOST2': '块注释里的示例' */\n  'common.ok': '好的',\n};\n",
      },
    }),
    {
      code: 0,
      contains: ['LANG-ERR-01 通过'],
      absent: ['手写 err.* 词条', '结构错误'],
    },
  );

  subprocess(
    '⑤ 【反证·判据 D】中英占位符大小写不一致 → 红（英文界面会渲染未替换原文）',
    tree({
      list: codeList({
        extra: [
          {
            code: 'PLACEHOLDER_DRIFT',
            status: 400,
            zh: '任务 {{id}} 失败',
            en: 'Task {{ID}} failed',
          },
        ],
      }),
    }),
    {
      code: 1,
      contains: ['PLACEHOLDER_DRIFT 的中英占位符不一致', 'zh=[id] en=[ID]'],
      absent: ['LANG-ERR-01 通过'],
    },
  );

  subprocess(
    '⑥ 生成物多出一条码表里没有的词条 → 红（孤儿词条）',
    tree({
      files: {
        [GEN_ZH]: localeSource(codeList(), { extra: [['GHOST_CODE', '幽灵词条']] }),
      },
    }),
    {
      code: 1,
      contains: ['孤儿 zh 词条（码表里没有）：err.GHOST_CODE'],
      absent: ['LANG-ERR-01 通过'],
    },
  );

  subprocess(
    '⑦ 【反证·判据 C】某码 zh 为空串 → 红（防"只写英文"的半成品被合并）',
    tree({
      list: codeList({
        extra: [{ code: 'EMPTY_ZH', status: 400, zh: '', en: 'English only' }],
      }),
    }),
    {
      code: 1,
      contains: ['EMPTY_ZH 的 zh 为空'],
      absent: ['LANG-ERR-01 通过'],
    },
  );

  subprocess(
    '⑧ 事实源缺失（生成物 en 不在）→ 结构红并点名路径，不是崩栈',
    tree({ omit: [GEN_EN] }),
    {
      code: 1,
      contains: ['结构错误', `事实源缺失：${GEN_EN}`],
      absent: ['LANG-ERR-01 通过', 'Error:', 'ENOENT'],
    },
  );

  subprocess(
    '⑨ 事实源缺失（码表目录不在）→ 结构红并点名路径',
    tree({ omit: [`${CATALOG_DIR}/common.ts`] }),
    {
      code: 1,
      contains: ['结构错误', `事实源缺失：${CATALOG_DIR}`],
      absent: ['LANG-ERR-01 通过', 'Error:', 'ENOENT'],
    },
  );

  subprocess(
    '⑩ 【反证·下界】码表只剩 2 个码 → 结构红（分母塌了不是"没有漂移"）',
    tree({
      files: {
        [`${CATALOG_DIR}/common.ts`]: catalogSource(codeList({ count: 2 })),
      },
    }),
    {
      code: 1,
      contains: ['只解析出 2 个错误码', `下界 ${MIN_CATALOG_CODES}`],
      absent: ['LANG-ERR-01 通过'],
    },
  );

  subprocess(
    '⑪ 【反证·`--report` 吞结构错】结构错时 --report 也必须红（只换输出形态，不换判据）',
    tree({ omit: [GEN_EN] }),
    {
      code: 1,
      contains: ['结构错误', `事实源缺失：${GEN_EN}`],
      absent: ['LANG-ERR-01 报告', 'LANG-ERR-01 通过'],
    },
    ['--report'],
  );

  subprocess(
    '⑫ --report 在合规树上仍正常打印码表（正例控制组）',
    tree(),
    {
      code: 0,
      contains: ['LANG-ERR-01 报告', `码表 ${MIN_CATALOG_CODES} 个码`],
      absent: ['结构错误', 'LANG-ERR-01 失败'],
    },
    ['--report'],
  );

  subprocess(
    '⑬ 【反证·解析口径塌方】生成物改成双引号（一条词条都解析不出）→ 结构红，不是「无差异」',
    tree({
      files: {
        [GEN_ZH]: 'export default {\n  "err.FOO_NOT_FOUND": "未找到「{{name}}」",\n};\n',
      },
    }),
    {
      code: 1,
      contains: ['结构错误', '解析出 0 条 err.* 词条', '判据失效'],
      absent: ['LANG-ERR-01 通过'],
    },
  );

  const failed = reportCases(cases, { title: 'check-error-i18n selftest' });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const invoked = process.argv[1]?.replace(/\\/g, '/').split('/').pop();

if (invoked === 'check-error-i18n.mjs') {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    const rootArg = argValue(process.argv, '--root');
    process.exit(
      run({
        root: rootArg ? path.resolve(rootArg) : DEFAULT_ROOT,
        report: process.argv.includes('--report'),
      }),
    );
  }
}
