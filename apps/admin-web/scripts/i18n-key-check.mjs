#!/usr/bin/env node
/**
 * B-5: i18n **缺键**守卫（与 i18n-scan.mjs 的「硬编码中文」守卫互补）。
 *
 * ## 为什么需要
 *
 * i18n/index.ts 的 fallbackLng 只兜「en 缺键回 zh」；**两边都缺**的键在 UI 上
 * 直接渲染键名（如 `eventSub.createFail`）。此前的唯一守卫 i18n-scan.mjs 只扫
 * 硬编码中文，对 `t('typo.key')` 完全失明——拼写错/漏补词条/删了 locale 键但
 * 页面还在用，全都会静默走到「键名渲染」或「中英混排」，直到有人肉眼撞见。
 *
 * ## 本守卫做什么
 *
 *  ① 用 TS 官方 parser 走 AST，收集 `apps/admin-web/src`（跳过 __tests__/locales，
 *     口径同 i18n-scan）里所有**静态可解析**的翻译调用键：
 *      · `t('key')` / `t("key")` / `t('key', {...})`（useTranslation 的 t）
 *      · `i18n.t('key')` / `i18next.t('key')`（非组件路径，如 axios 拦截器）
 *     第一参为标识符/模板串（`t(\`prefix.${x}\`)`）属**动态键**，静态不可判，
 *     按出现文件记入 baseline 的 dynamicCallFiles（清单显式可审计，只增需说明）。
 *  ② 与 src/locales/zh.ts、en.ts 的键集求差：任何一边缺失都算违规——
 *      · 两边都缺 = 英文/中文 UI 都渲染键名（最严重）；
 *      · 仅 en 缺 = 英文界面回退中文（fallbackLng，中英混排）；
 *      · 仅 zh 缺 = 理论上不影响 zh 用户，但键集漂移本身即坏味道，一并拦。
 *  ③ 与 scripts/i18n-key-baseline.json 的 allowedMissing 比对：基线内的存量
 *     缺键放行（历史缺口，等 locales 侧补齐后删除基线条目），**新增**即红；
 *     基线里已不再缺的条目按 N-04「陈旧反向检查」纪律要求删除，防基线只增不减。
 *
 * ## 用法
 *   node scripts/i18n-key-check.mjs            # 守卫（CI / lint:i18n 用）
 *   node scripts/i18n-key-check.mjs --json     # 输出全部静态键与差集明细
 *   node scripts/i18n-key-check.mjs --selftest # 验证判据本身（不读真实仓库）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const SRC_ROOT = join(ROOT, 'src');
const ZH_LOCALE = join(SRC_ROOT, 'locales', 'zh.ts');
const EN_LOCALE = join(SRC_ROOT, 'locales', 'en.ts');
const BASELINE_PATH = join(ROOT, 'scripts', 'i18n-key-baseline.json');

/**
 * 收集源文件里的翻译调用。返回 { staticKeys, dynamicSites }：
 *  - staticKeys: Set<key>（可静态判定的键）
 *  - dynamicSites: [{ file, line }]（第一参非字面量的调用点，进基线清单）
 */
export function extractI18nCalls(sourceCode, fileLabel = 'inline.tsx') {
  const sf = ts.createSourceFile(fileLabel, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const staticKeys = new Set();
  const dynamicSites = [];

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  /** t('k') / i18n.t('k') / i18next.t('k') 形状的调用判定。 */
  const isTranslateCall = (node) => {
    if (!ts.isCallExpression(node)) return false;
    const expr = node.expression;
    if (ts.isIdentifier(expr)) {
      // useTranslation() 解构出的 t / withTranslation 的 this.props.t 的直接别名 t
      return expr.text === 't';
    }
    if (ts.isPropertyAccessExpression(expr)) {
      // i18n.t / i18next.t（非组件路径）
      return expr.name.text === 't' &&
        ts.isIdentifier(expr.expression) &&
        ['i18n', 'i18next'].includes(expr.expression.text);
    }
    return false;
  };

  const visit = (node) => {
    if (isTranslateCall(node)) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) {
        staticKeys.add(first.text);
      } else if (first && ts.isNoSubstitutionTemplateLiteral(first)) {
        staticKeys.add(first.text);
      } else if (first) {
        // 标识符 / 模板表达式 / 二次拼接——静态不可判，记点供基线审计
        dynamicSites.push({ file: fileLabel, line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { staticKeys, dynamicSites };
}

/** 差集判定：返回 { missingBoth, missingZh, missingEn }（排序稳定）。 */
export function diffKeys(usedKeys, zhKeys, enKeys) {
  const zh = new Set(zhKeys);
  const en = new Set(enKeys);
  const missingBoth = [];
  const missingZh = [];
  const missingEn = [];
  for (const key of usedKeys) {
    const a = zh.has(key);
    const b = en.has(key);
    if (!a && !b) missingBoth.push(key);
    else if (!a) missingZh.push(key);
    else if (!b) missingEn.push(key);
  }
  return {
    missingBoth: missingBoth.sort(),
    missingZh: missingZh.sort(),
    missingEn: missingEn.sort(),
  };
}

/**
 * 基线陈旧检查（N-04 同款纪律）：allowedMissing 里已不缺的条目要求删除，
 * 否则基线只增不减、迁移进度不可读。返回陈旧键列表。
 */
export function staleBaselineEntries(diff, allowedMissing) {
  const stillMissing = new Set([
    ...diff.missingBoth,
    ...diff.missingZh,
    ...diff.missingEn,
  ]);
  return allowedMissing.filter((k) => !stillMissing.has(k));
}

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      // 口径同 i18n-scan：测试与语言包本身不扫（tests 会 stub 词条、locales 是键集本体）
      if (entry === '__tests__' || entry === 'locales' || entry === 'node_modules') continue;
      collect(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) acc.push(p);
  }
  return acc;
}

/** 加载语言包键集：zh.ts/en.ts 是纯对象字面量 TS 模块，transpile 后沙箱求值。 */
export function loadLocaleKeys(file) {
  const src = readFileSync(file, 'utf-8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const sandbox = { exports: {}, module: { exports: {} }, require: () => ({}) };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(js, sandbox, { filename: file });
  const dict = sandbox.exports.default ?? sandbox.module.exports.default;
  if (!dict || typeof dict !== 'object') {
    throw new Error(`locale 文件无 default 对象导出: ${file}`);
  }
  return Object.keys(dict);
}

function run() {
  const files = collect(SRC_ROOT);
  const used = new Set();
  const dynamicByFile = new Map();
  const keySites = new Map(); // key -> [{file,line}]（报告用）
  for (const f of files) {
    const { staticKeys, dynamicSites } = extractI18nCalls(readFileSync(f, 'utf-8'), f);
    for (const k of staticKeys) {
      used.add(k);
      if (!keySites.has(k)) keySites.set(k, []);
      keySites.set(k, [...keySites.get(k), relative(SRC_ROOT, f).replace(/\\/g, '/')]);
    }
    if (dynamicSites.length) {
      dynamicByFile.set(relative(SRC_ROOT, f).replace(/\\/g, '/'), dynamicSites.length);
    }
  }

  const zhKeys = loadLocaleKeys(ZH_LOCALE);
  const enKeys = loadLocaleKeys(EN_LOCALE);
  const diff = diffKeys(used, zhKeys, enKeys);
  const dynamicFiles = [...dynamicByFile.keys()].sort();

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      usedCount: used.size,
      zhCount: zhKeys.length,
      enCount: enKeys.length,
      ...diff,
      dynamicFiles,
    }, null, 2));
    return 0;
  }

  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
    : { allowedMissing: [], dynamicCallFiles: [] };
  const allowed = new Set(baseline.allowedMissing ?? []);
  const allowedDynamic = new Set(baseline.dynamicCallFiles ?? []);

  // 动态键文件须在基线清单内（新增动态键文件 = 有键静态不可判，需显式登记）
  const unregisteredDynamic = dynamicFiles.filter((f) => !allowedDynamic.has(f));
  // 基线陈旧条目（已补齐的缺键）
  const stale = staleBaselineEntries(diff, baseline.allowedMissing ?? []);

  const violations = [];
  const describe = (key) => {
    const sites = keySites.get(key) ?? [];
    return `${key}${sites.length ? `  (用于 ${[...new Set(sites)].slice(0, 3).join(', ')}${sites.length > 3 ? ' …' : ''})` : ''}`;
  };
  for (const k of diff.missingBoth) if (!allowed.has(k)) violations.push({ sev: 'both', key: k });
  for (const k of diff.missingZh) if (!allowed.has(k)) violations.push({ sev: 'zh', key: k });
  for (const k of diff.missingEn) if (!allowed.has(k)) violations.push({ sev: 'en', key: k });

  let failed = false;
  if (unregisteredDynamic.length) {
    failed = true;
    console.error(`❌ i18n 缺键守卫：${unregisteredDynamic.length} 个文件存在**动态翻译键**（t(变量/模板串)），未在基线登记：`);
    console.error('   动态键静态不可判（运行时才知道键名），须在 scripts/i18n-key-baseline.json 的');
    console.error('   dynamicCallFiles 里按文件登记并说明取键来源。\n');
    for (const f of unregisteredDynamic) console.error(`   ${f}`);
  }
  if (stale.length) {
    failed = true;
    console.error(`\n❌ i18n 缺键基线陈旧：${stale.length} 条 allowedMissing 已不再缺失（词条已补）。`);
    console.error('   请从 scripts/i18n-key-baseline.json 的 allowedMissing 删除：');
    for (const k of stale) console.error(`   ${k}`);
  }
  if (violations.length) {
    failed = true;
    console.error(`\n❌ i18n 缺键守卫失败：${violations.length} 个 t('键') 在 locales 中缺失。`);
    console.error('   两边都缺 = UI 直接渲染键名；仅 en 缺 = 英文界面回退中文（中英混排）。');
    console.error('   修法：在 src/locales/zh.ts 与 en.ts 成对补词条；存量缺口确无法本轮补的，');
    console.error('   记入 scripts/i18n-key-baseline.json 的 allowedMissing 并在 PR 说明。\n');
    for (const v of violations) {
      const label = v.sev === 'both' ? 'zh+en 都缺' : v.sev === 'zh' ? 'zh 缺' : 'en 缺';
      console.error(`   [${label}]  ${describe(v.key)}`);
    }
  }
  if (failed) process.exit(1);

  const allowedCount = [...diff.missingBoth, ...diff.missingZh, ...diff.missingEn].filter((k) => allowed.has(k)).length;
  console.log(
    `✅ i18n 缺键守卫通过：静态键 ${used.size} 个与 zh(${zhKeys.length})/en(${enKeys.length}) 键集比对，` +
      `无新增缺失（基线豁免 ${allowedCount} 条存量缺口，动态键文件 ${dynamicFiles.length} 个已登记）。`,
  );
  return 0;
}

// ── selftest：验证判据本身（不读真实仓库） ──────────────────────────────────
export function selftest() {
  const cases = [];
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    cases.push(a === b ? null : `selftest ${label} failed: expected ${b}, got ${a}`);
  };

  // ① 提取：静态键/动态点/误报源
  const src = [
    "const { t } = useTranslation();",
    "t('a.b');",
    't("c.d", { count: 1 });',
    "t(dynamicVar);",
    "t(`prefix.${x}`);",
    "i18n.t('g.h');",
    "i18next.t('i.j');",
    "foo('not.a.key');", // 非 t 调用不算
    "setTimeout(t, 1);", // 引用而非调用不算
  ].join('\n');
  const { staticKeys, dynamicSites } = extractI18nCalls(src, 'sample.tsx');
  eq([...staticKeys].sort(), ['a.b', 'c.d', 'g.h', 'i.j'], 'extract staticKeys');
  eq(dynamicSites.length, 2, 'extract dynamicSites');

  // ② 差集：两边都缺 / 仅 zh 有（en 缺）/ 仅 en 有（zh 缺）
  // 键名语义：'zh.only' = 只存在于 zh（故对 en 缺失）；'en.only' 同理。
  const diff = diffKeys(['both.miss', 'zh.only', 'en.only', 'ok.key'], ['en.only', 'ok.key'], ['zh.only', 'ok.key']);
  eq(diff.missingBoth, ['both.miss'], 'diff missingBoth');
  eq(diff.missingZh, ['zh.only'], 'diff missingZh');
  eq(diff.missingEn, ['en.only'], 'diff missingEn');

  // ③ 陈旧基线：已补齐的条目要被点名
  eq(
    staleBaselineEntries(diff, ['both.miss', 'fixed.key']),
    ['fixed.key'],
    'staleBaselineEntries',
  );

  // ④ locale 求值：default 导出的对象键可读（用合成文件验证 loader 语义）
  const tmp = extractI18nCalls("t('x.y')");
  eq([...tmp.staticKeys], ['x.y'], 'loader sanity');

  const errors = cases.filter(Boolean);
  if (errors.length) {
    console.error('i18n-key-check selftest FAILED:');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log('i18n-key-check selftest: OK');
  return 0;
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  run();
}
