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
 * ## 用法
 *   node scripts/check-error-i18n.mjs              # 守卫
 *   node scripts/check-error-i18n.mjs --report     # 打印码表
 *   node scripts/check-error-i18n.mjs --selftest   # 验证判据本身（防永真）
 *
 * 纯静态读取源码，无需 npm ci / PG / Redis，秒级。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalog, parseCatalog } from './lib/error-catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CATALOG_DIR = 'apps/admin-api/src/common/errors/catalog';
const GEN_ZH = 'apps/admin-web/src/locales/generated/error-codes.zh.ts';
const GEN_EN = 'apps/admin-web/src/locales/generated/error-codes.en.ts';
const HAND_ZH = 'apps/admin-web/src/locales/zh.ts';
const HAND_EN = 'apps/admin-web/src/locales/en.ts';

/** 从生成物里抽 `'err.<CODE>': '<text>'`。 */
export function parseLocaleKeys(src) {
  const out = new Map();
  const re = /^\s*'err\.([A-Z][A-Z0-9_]*)':\s*'((?:[^'\\]|\\.)*)',\s*$/gm;
  for (const m of src.matchAll(re)) {
    out.set(m[1], m[2].replace(/\\'/g, "'"));
  }
  return out;
}

function read(p) {
  return fs.readFileSync(path.join(root, p), 'utf-8');
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

export function run({ report = false } = {}) {
  let catalog;
  try {
    catalog = readCatalog(root, CATALOG_DIR);
  } catch (e) {
    console.error(`✘ ${e.message}`);
    return 1;
  }

  if (report) {
    console.log(`LANG-ERR-01 报告：码表 ${catalog.size} 个码`);
    for (const [code, def] of catalog) {
      console.log(`  ${code.padEnd(30)} ${String(def.status).padEnd(4)}`);
    }
    return 0;
  }

  const problems = [];

  // C：每个码都必须有 zh 与 en（解析层已保证字段存在，这里防"空串占位"）
  for (const [code, def] of catalog) {
    if (!def.zh.trim()) problems.push(`${code} 的 zh 为空`);
    if (!def.en.trim()) problems.push(`${code} 的 en 为空`);
  }

  // D：zh 与 en 的占位符集合必须一致（否则英文界面渲染未替换原文/漏参）
  for (const [code, def] of catalog) {
    const pz = placeholderSet(def.zh);
    const pe = placeholderSet(def.en);
    if (pz !== pe) {
      problems.push(
        `${code} 的中英占位符不一致：zh=[${pz}] en=[${pe}]` +
          `（英文界面会渲染出未替换的原文或漏掉参数）`,
      );
    }
  }

  // A：生成物与码表一致
  const zh = parseLocaleKeys(read(GEN_ZH));
  const en = parseLocaleKeys(read(GEN_EN));
  for (const [code, def] of catalog) {
    if (zh.get(code) !== def.zh) {
      problems.push(`生成物 zh 与码表不一致：err.${code}（跑 gen-error-i18n.mjs）`);
    }
    if (en.get(code) !== def.en) {
      problems.push(`生成物 en 与码表不一致：err.${code}（跑 gen-error-i18n.mjs）`);
    }
  }
  for (const code of zh.keys()) {
    if (!catalog.has(code)) problems.push(`孤儿 zh 词条（码表里没有）：err.${code}`);
  }
  for (const code of en.keys()) {
    if (!catalog.has(code)) problems.push(`孤儿 en 词条（码表里没有）：err.${code}`);
  }

  // B：手写 locale 不得残留 err.* （会静默覆盖生成值）
  for (const [label, file] of [
    ['zh.ts', HAND_ZH],
    ['en.ts', HAND_EN],
  ]) {
    const n = countHandWrittenErrKeys(read(file));
    if (n > 0) {
      problems.push(
        `${label} 里仍有 ${n} 条手写 err.* 词条——生成物在 spread 链前面，` +
          `同名键会被静默覆盖（改了码表却看不到生效）。请删掉手写条目，只改后端码表分片。`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`✘ LANG-ERR-01 失败（${problems.length} 项）：`);
    for (const p of problems) console.error(`   · ${p}`);
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

function selftest() {
  let fail = 0;
  const t = (name, cond) => {
    if (cond) console.log(`  ✔ ${name}`);
    else {
      fail++;
      console.error(`  ✘ ${name}`);
    }
  };
  console.log('LANG-ERR-01 selftest:');

  // 解析层：必须认**多行**条目（首版只认单行，导致"解析不到任何码"）
  const cat = parseCatalog(`
export const X = {
  FOO_NOT_FOUND: {
    status: 404,
    zh: "未找到「{{name}}」",
    en: "Not found: {{name}}",
  },
  BAR_FAILED: {
    status: 400,
    zh: "操作失败",
    en: "Operation failed",
  },
} as const satisfies Record<string, ErrorCodeDef>;
`);
  t('解析多行条目', cat.size === 2);
  t('解析 status/zh/en', cat.get('FOO_NOT_FOUND')?.en === 'Not found: {{name}}');
  t('双花括号占位原样保留', cat.get('FOO_NOT_FOUND')?.zh === '未找到「{{name}}」');

  // 生成物词条解析
  const loc = parseLocaleKeys(`
  'err.FOO_NOT_FOUND': '未找到「{{name}}」',
  'other.key': '不计入',
`);
  t('只抓 err.* 词条', loc.size === 1 && loc.has('FOO_NOT_FOUND'));

  // B 判据：手写残留必须能被识别（否则"静默覆盖"这条守卫是永假的）
  t(
    '识别手写 err.* 残留',
    countHandWrittenErrKeys(`  'err.FOO': 'x',\n  'common.a': 'y',`) === 1,
  );
  t(
    '注释里的 err.* 不误判',
    countHandWrittenErrKeys(`// 'err.FOO': 'x',\n  /* 'err.BAR': 'y' */`) === 0,
  );

  // D 判据：占位符集合比较（否则"中英占位符不一致"这条守卫是永假的）
  t(
    '占位符集合：同名同序视为一致',
    placeholderSet('任务 {{id}} 失败') === placeholderSet('Task {{id}} failed'),
  );
  t(
    '占位符集合：名字不同即不一致（大小写敏感）',
    placeholderSet('任务 {{id}}') !== placeholderSet('Task {{ID}}'),
  );
  t(
    '占位符集合：英文漏参即不一致',
    placeholderSet('{{a}} 与 {{b}}') !== placeholderSet('only {{a}}'),
  );
  t(
    '占位符集合：顺序无关（都排序后比较）',
    placeholderSet('{{b}} 先于 {{a}}') === placeholderSet('{{a}} before {{b}}'),
  );
  t('占位符集合：无占位为一致', placeholderSet('失败') === placeholderSet('Failed'));

  console.log(fail === 0 ? '\n✔ selftest 全通过' : `\n✘ selftest ${fail} 项失败`);
  return fail === 0 ? 0 : 1;
}

const argv = process.argv.slice(2);
process.exit(
  argv.includes('--selftest') ? selftest() : run({ report: argv.includes('--report') }),
);
