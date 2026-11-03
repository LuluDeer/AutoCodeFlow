/**
 * i18n **孤儿词条棘轮**（R2 / i18n-guard）：字典 → 源码方向。
 *
 * ## 现状：这个方向此前完全没有守卫
 *
 * 已有的两道闸都只走"源码 → 字典"：`i18n-source-guard.test.ts` 与
 * `scripts/i18n-key-check.mjs` 断言"代码里 `t('x')` 用到的键必须在字典里"。
 * 反过来的问题——**字典里有、但没有任何代码会去取**的键——无人检查：它们
 * 长期驻留、逐轮被复制粘贴（下一个页面抄上一页的键块，连已经没人用的那几条
 * 一起抄），既让"到底哪些文案还活着"不可判，也让 zh/en 对齐的维护成本翻倍。
 *
 * 但"孤儿"不能直接等同于"死词条"：本仓大量存在**映射表**消费，例如
 * `src/pages/SsoCompletePage.tsx` 把后端状态码做成 `Record`：
 *
 *     const STATE_KEY: Record<string, string> = {
 *       state_invalid: 'sso.error.state',   // ← 键只以「字符串字面量」出现
 *     };
 *     t(STATE_KEY[state])                     // ← 调用实参不是字面量
 *
 * 只按 `t('...')` 字面量扫，会把 300+ 条活词条误判成孤儿，于是这道闸第一天
 * 就得靠一张巨大的豁免表活着——那等于把误报固化，闸也就废了。所以检测器
 * 分档收集（口径由宽到严，档位越高越保守）：
 *
 *   ① **字面量翻译调用**：`t('k')` / `T('k')` / `i18n.t('k')` / `i18next.t('k')`
 *      （第一实参是字符串字面量或无插值模板；含 `t(variable)` 这种调用则
 *      记入"动态调用点"，用于触发 ③ 的宽松档）。
 *      `T` 不是笔误：`src/utils/*.ts` 有一族"非组件路径"工具函数用
 *      `const T = t ?? ((k) => i18n.t(k))` 的别名（`cron-desc.ts`、`timeFormat.ts`、
 *      `priority.ts`、`failure-runbook.ts` 等，21 处字面量键）。只认小写 `t`
 *      会把这些键**全部误判成孤儿**，正是本仓"检测器口径写窄 ⇒ 基线灌满误报"
 *      的典型形态。
 *   ② **点号形态字符串字面量**：任何匹配 `xx.yy.zz` 形态的字符串字面量都当
 *      作可能被取用的键。这一档专门捕获上面的映射表形态（值即键）。
 *   ③ **宽松档**：只要该文件里出现过翻译调用（含动态实参），就把**整个文件
 *      内的所有字符串字面量**当作"可能动态 key"。这是最保守的口径：宁可把
 *      孤儿漏判（进基线冻结），也不要把活词条误报成孤儿。
 *   ④ **模板前缀推断**（本守卫自加的补充档，见下）：`` t(`err.${code}`) ``
 *      的静态前缀是 `err.`，于是所有以 `err.` 开头的键都算"可能被取用"。
 *
 * ## 为什么还要 ④：否则 400+ 条生成词条会被冻结成"死词条"
 *
 * `src/utils/error.ts` 用 `` const key = `err.${code}` `` 取全部 `err.<CODE>`
 * 词条（428 条，由 `scripts/gen-error-i18n.mjs` 生成）。①②③ 都抓不到它
 * ——前缀片段 `err.` 不等于任何完整键名。若不补这一档，基线会一次性吞下
 * 400+ 条**其实是活词条**的键，正是"基线把误报固化"的反面教材。故 ④ 的扫描
 * 面是"**含翻译调用的文件里所有模板表达式**"（不只是调用实参）——`error.ts`
 * 正是先把模板赋给 `const key`，再 `i18n.t(key)`。④ 只做前缀匹配、不建豁免表。
 *
 * ## 口径分档 + 基线（只减不增）
 *
 * 报告里按三档给数：**仅①②** / **含③** / **含④（=最终口径）**，另附基线长度。
 * 三档的数字必须单调不增——那是"档位真的在扩面"的自证，而不是一句说明。
 *
 * 孤儿 = zh 键 − (①②③④ ∪ 基线)。基线记的是**检测器静态不可判**的存量：
 * 它们可能是真死词条，也可能是经更绕的动态路径取用（拼字符串、运行时查表），
 * 静态不可证。基线的纪律与仓库既有 `scripts/i18n-key-baseline.json` 同源：
 *
 *   · **新增孤儿 ⇒ 红**：新写的文案没人取用，立刻拦住；
 *   · **基线陈旧 ⇒ 红**：基线里的键一旦被源码引用，必须**从基线删掉**，
 *     否则"只减不增"就是一句空话——棘轮只会朝更紧的方向转；
 *   · **基线不得凭口径放宽而增**：`i18n-orphans-baseline.json` 的
 *     `keys.length` 与 `maxKeys` 必须相等，且 ≤ 本文件的 `ORPHAN_BASELINE_MAX`。
 *     想加一条孤儿进基线要同时改 JSON 与这个常量——两处 diff 都看得见。
 *
 * 基线与检测器**同 commit**：先跑检测器、把结果落盘，判据与基线一起提交，
 * 避免"口径改了、基线还是老口径"的静默漂移。
 *
 * ## 重新生成基线（口径变更 / 首次接入时）
 *
 *     cd apps/admin-web && I18N_ORPHANS_WRITE=1 npx vitest run src/__tests__/i18n-orphans.test.ts
 *
 * 平时**永不写盘**（写盘测试在无该环境变量时 skip）。生成后务必人工过一遍
 * 新增条数：如果 orphan 数一次性涨了两位数的百分比，先怀疑检测器漏档，而
 * 不是急着把新孤儿塞进基线。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import zh from '../locales/zh';
import en from '../locales/en';

const SRC_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = resolve(__dirname, 'i18n-orphans-baseline.json');

/**
 * 基线规模上限（棘轮牙齿）：等于当前基线条数。**只能下调**。
 * 上调的唯一正当理由是"检测器口径被有意收窄"（例如新增了一档推断），
 * 且必须在同一个 commit 的说明里写清是哪一档、为什么。
 */
const ORPHAN_BASELINE_MAX = 44; // 由生成器跑出真实值后填定（只准下调）

// ── 采集面 ──────────────────────────────────────────────────────────────

/** 扫 src 下所有 ts/tsx，跳过 `__tests__`（测试里的 key 是断言不是消费）与 `locales`（字典本身）。 */
export function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'locales' || entry === 'node_modules') continue;
      collectSourceFiles(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

// ── 检测器 ──────────────────────────────────────────────────────────────

/** 命中一条 key 的现场（报错时用来定位，不必再手工翻文件）。 */
export interface KeySite {
  file: string;
  line: number;
}

export interface ScanReport {
  /** ① 字面量翻译调用的键。 */
  literalCalls: Map<string, KeySite>;
  /** ② 点号形态字符串字面量（映射表的值等）。 */
  dottedLiterals: Map<string, KeySite>;
  /** ③ 含翻译调用的文件里的**全部**字符串字面量（宽松档）。 */
  looseLiterals: Map<string, KeySite>;
  /** ④ 动态调用的模板静态前缀（`` `err.${x}` `` → `err.`）。 */
  templatePrefixes: Map<string, KeySite>;
  /** 含翻译调用的文件数（诊断用）。 */
  filesWithTranslateCall: number;
  /** 扫描的文件数。 */
  filesScanned: number;
}

/** `xx.yy.zz` 形态：至少一个点，首段以字母开头，各段由字母/数字/下划线组成。 */
const DOTTED_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

const isTranslateCall = (node: ts.Node): node is ts.CallExpression => {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 't' || callee.text === 'T';
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text !== 't') return false;
    const obj = callee.expression;
    return ts.isIdentifier(obj) && (obj.text === 'i18n' || obj.text === 'i18next');
  }
  return false;
};

/**
 * 从模板字符串的静态片段里推"键前缀"：`err.${code}` → `err.`；
 * `projects.role.${role}` → `projects.role.`。只认"片段里出现过点"的情形，
 * 且截到最后一个点（含点），因为点之前才是可判定前缀。
 * `projects/${id}` 这类无点片段返回 null（猜不出前缀就不猜）。
 */
function templatePrefixOf(chunks: string[]): string | null {
  for (const chunk of chunks) {
    const cut = chunk.lastIndexOf('.');
    if (cut > 0) return chunk.slice(0, cut + 1);
  }
  return null;
}

/** 深度优先遍历（不用 TS 的 transform API，避免为一次扫描建 Visitor 工厂）。 */
function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((child) => visit(child, fn));
}

/**
 * 扫一批源码，返回四档收集结果。
 *
 * 入参是可注入的 `{ file, source }[]`（不是为了架构洁癖：反证用例要能喂假源码，
 * 而"检测器只能跑真实仓库"的写法没法自证有牙）。
 */
export function scanSources(inputs: { file: string; source: string }[]): ScanReport {
  const report: ScanReport = {
    literalCalls: new Map(),
    dottedLiterals: new Map(),
    looseLiterals: new Map(),
    templatePrefixes: new Map(),
    filesWithTranslateCall: 0,
    filesScanned: inputs.length,
  };

  for (const { file, source } of inputs) {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lineOf = (node: ts.Node) =>
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const record = (map: Map<string, KeySite>, key: string, node: ts.Node) => {
      if (!map.has(key)) map.set(key, { file, line: lineOf(node) });
    };

    const translateCalls: ts.CallExpression[] = [];
    const stringLiterals: ts.StringLiteralLike[] = [];
    const templateExpressions: ts.TemplateExpression[] = [];

    visit(sf, (node) => {
      if (isTranslateCall(node)) translateCalls.push(node);
      if (ts.isStringLiteralLike(node)) stringLiterals.push(node);
      if (ts.isTemplateExpression(node)) templateExpressions.push(node);
    });

    if (translateCalls.length > 0) report.filesWithTranslateCall += 1;

    // ① 字面量实参
    for (const call of translateCalls) {
      const arg = call.arguments[0];
      if (!arg) continue;
      if (ts.isStringLiteralLike(arg)) record(report.literalCalls, arg.text, arg);
    }

    // ② 点号形态字面量（全库扫，不限文件——映射表可能在任何文件里）
    for (const lit of stringLiterals) {
      if (DOTTED_KEY_RE.test(lit.text)) record(report.dottedLiterals, lit.text, lit);
    }

    // ③ 宽松档：文件里一旦出现翻译调用，整个文件的字符串字面量都算"可能动态 key"
    if (translateCalls.length > 0) {
      for (const lit of stringLiterals) record(report.looseLiterals, lit.text, lit);

      // ④ 模板前缀推断（同属宽松档：只在"该文件真会取文案"时启用）：
      // 覆盖 ``const key = `err.${code}`; i18n.t(key)`` 这种"模板先落变量"的形态。
      for (const tpl of templateExpressions) {
        const prefix = templatePrefixOf([
          tpl.head.text,
          ...tpl.templateSpans.map((s) => s.literal.text),
        ]);
        if (prefix) record(report.templatePrefixes, prefix, tpl);
      }
    }
  }

  return report;
}

/** 口径档位：tier1 = ①②；tier2 = +③；tier3 = +④。 */
export type Tier = 1 | 2 | 3;

export interface OrphanResult {
  /** 该档口径下的孤儿（已减去基线）。 */
  orphans: string[];
  /** 该档口径下、未被任何档覆盖的键（未减基线）。 */
  uncovered: string[];
}

/**
 * 计算孤儿。`baseline` 传空数组即"纯检测器口径"（报告里的三档数字用它）。
 * 返回的 `orphans` 是**减去基线后**的集合，maintainers 的红/绿判据看它。
 */
export function computeOrphans(
  dict: Record<string, unknown>,
  report: ScanReport,
  tier: Tier,
  baseline: readonly string[] = [],
): OrphanResult {
  const covered = new Set<string>([
    ...report.literalCalls.keys(),
    ...report.dottedLiterals.keys(),
  ]);
  if (tier >= 2) for (const k of report.looseLiterals.keys()) covered.add(k);
  if (tier >= 3) {
    for (const prefix of report.templatePrefixes.keys()) {
      for (const key of Object.keys(dict)) {
        if (key.startsWith(prefix)) covered.add(key);
      }
    }
  }
  const base = new Set(baseline);
  const uncovered: string[] = [];
  const orphans: string[] = [];
  for (const key of Object.keys(dict).sort()) {
    if (covered.has(key)) continue;
    uncovered.push(key);
    if (!base.has(key)) orphans.push(key);
  }
  return { orphans, uncovered };
}

/** 统一差异文案：计数 + 前 N 条键名（与 i18n-key-parity.test.ts 同款，便于对齐阅读）。 */
export function reportDiff(label: string, entries: readonly string[], maxShown = 20): string {
  if (entries.length === 0) return `${label}：共 0 条`;
  const head = entries.slice(0, maxShown).join(', ');
  const rest = entries.length > maxShown ? `（另有 ${entries.length - maxShown} 条未列出）` : '';
  return `${label}：共 ${entries.length} 条（列前 ${Math.min(entries.length, maxShown)} 条）：${head}${rest}`;
}

// ── 真实仓库的一次性采集（模块求值期只跑一次，10 个用例共享）───────────

const files = collectSourceFiles(SRC_ROOT);
const report = scanSources(
  files.map((file) => ({ file: file.replace(SRC_ROOT, '').replace(/\\/g, '/'), source: readFileSync(file, 'utf-8') })),
);
const zhRec = zh as unknown as Record<string, unknown>;
const enRec = en as unknown as Record<string, unknown>;

interface BaselineFile {
  _note: string;
  _regen: string;
  maxKeys: number;
  keys: string[];
}

const baselineRaw = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as BaselineFile;
const baseline = baselineRaw.keys;

const tier1 = computeOrphans(zhRec, report, 1);
const tier2 = computeOrphans(zhRec, report, 2);
const tier3 = computeOrphans(zhRec, report, 3);
/** 正式判据：④ 档口径 **减去基线**。棘轮看的是这个，不是纯检测器数字。 */
const finalResult = computeOrphans(zhRec, report, 3, baseline);

// ── 用例 ────────────────────────────────────────────────────────────────

describe('i18n 孤儿棘轮：字典 → 源码方向（只减不增）', () => {
  it('扫描面非空（反永真：目录遍历坏了不该判绿）', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(report.filesWithTranslateCall).toBeGreaterThan(50);
  });

  it('打印三档口径数字（口径必须自证：宽 → 窄，孤儿数单调不增）', () => {
    // 这三行是**给人看的**：口径漂移时先看数字怎么变，而不是直接读基线 diff。
    const withoutLiteral = Object.keys(zhRec).filter((k) => !report.literalCalls.has(k)).length;
    const prefixDetail = [...report.templatePrefixes.keys()]
      .map((p) => `${p}(${Object.keys(zhRec).filter((k) => k.startsWith(p)).length})`)
      .join(' ');
    console.log(
      [
        '[i18n-orphans] 字典键数 zh/en：' + `${Object.keys(zhRec).length}/${Object.keys(enRec).length}`,
        `[i18n-orphans] 漏斗：字典 ${Object.keys(zhRec).length} → ①后 ${withoutLiteral} → ①②后 ${tier1.uncovered.length} → +③ ${tier2.uncovered.length} → +④ ${tier3.uncovered.length}`,
        `[i18n-orphans] ①② 字面量调用+点号字面量：孤儿 ${tier1.uncovered.length}`,
        `[i18n-orphans] 含③ 宽松档（含 t( 文件的全部字面量）：孤儿 ${tier2.uncovered.length}`,
        `[i18n-orphans] 含④ 模板前缀推断：孤儿 ${tier3.uncovered.length}`,
        `[i18n-orphans] 基线条数：${baseline.length}，最终新增孤儿 ${finalResult.orphans.length}`,
        `[i18n-orphans] 采集量：①${report.literalCalls.size} ②${report.dottedLiterals.size} ③${report.looseLiterals.size} ④${report.templatePrefixes.size}`,
        `[i18n-orphans] ④ 前缀明细（前缀(覆盖键数)）：${prefixDetail}`,
      ].join('\n'),
    );
    // 单调性是口径自洽的证据：档位只增不减覆盖面 ⇒ 孤儿只能变少。
    expect(tier1.uncovered.length).toBeGreaterThanOrEqual(tier2.uncovered.length);
    expect(tier2.uncovered.length).toBeGreaterThanOrEqual(tier3.uncovered.length);
  });

  it('无新增孤儿（新写的文案必须有人取用，否则进基线要显式评审）', () => {
    expect(reportDiff('新增孤儿（不在基线内）', finalResult.orphans)).toBe(
      '新增孤儿（不在基线内）：共 0 条',
    );
  });

  it('无陈旧基线（基线键一旦被引用 ⇒ 必须从基线删除，逼棘轮收紧）', () => {
    const uncoveredSet = new Set(tier3.uncovered);
    const stale = baseline.filter((key) => !uncoveredSet.has(key)).sort();
    expect(reportDiff('陈旧基线（已被源码引用，请删除这些条目）', stale)).toBe(
      '陈旧基线（已被源码引用，请删除这些条目）：共 0 条',
    );
  });

  it('基线本身卫生：排序、去重、键真实存在、zh/en 都有', () => {
    expect(baseline).toEqual([...baseline].sort()); // 稳定排序 ⇒ diff 可读
    expect(new Set(baseline).size).toBe(baseline.length); // 无重复
    const phantom = baseline.filter((k) => !(k in zhRec) || !(k in enRec));
    expect(reportDiff('基线与字典对不上的键（字典删键后基线没回收）', phantom)).toBe(
      '基线与字典对不上的键（字典删键后基线没回收）：共 0 条',
    );
  });

  it('基线只减不增：条数与 maxKeys 一致且不超过常量上限', () => {
    // 三道锁叠在一起：JSON 里的 keys / JSON 里的 maxKeys / 本文件的常量。
    // 想让基线变大，必须同时改两处源码文件——评审时跑不掉。
    expect(baselineRaw.maxKeys).toBe(baseline.length);
    expect(baseline.length).toBeLessThanOrEqual(ORPHAN_BASELINE_MAX);
  });
});

describe('检测器自身有牙（反证：假源码 + 假字典，不依赖真实仓库状态）', () => {
  it('① 字面量调用被抓到；② 映射表里的点号字面量被当作键', () => {
    const sample = [
      "t('login.submit');",
      "i18n.t('http.error.403');",
      'const STATE_KEY = { state_invalid: \'sso.error.state\' };',
      't(STATE_KEY[state]);',
    ].join('\n');
    const rep = scanSources([{ file: 'sample.tsx', source: sample }]);
    expect(rep.literalCalls.has('login.submit')).toBe(true);
    expect(rep.literalCalls.has('http.error.403')).toBe(true);
    // `STATE_KEY[state]` 的实参不是字面量 ⇒ 不算字面量调用，但值进了 ②
    expect(rep.dottedLiterals.has('sso.error.state')).toBe(true);
    expect(rep.filesWithTranslateCall).toBe(1);
  });

  it('① `T` 别名（`const T = t ?? …`）也认作翻译调用，否则整族工具函数的键全被误判孤儿', () => {
    const rep = scanSources([
      {
        file: 'cron-desc.ts',
        source:
          "const T = t ?? ((k: string) => i18n.t(k));\nreturn T('cron.desc.everyMinute') + T(`cron.desc.dow.${d}`);",
      },
    ]);
    expect(rep.literalCalls.has('cron.desc.everyMinute')).toBe(true);
    // 模板前缀要从"赋值给变量的模板"里推（error.ts 的 `const key = \`err.${code}\``）
    expect([...rep.templatePrefixes.keys()]).toContain('cron.desc.dow.');
    expect(rep.filesWithTranslateCall).toBe(1);
  });

  it('③ 宽松档只在"该文件有翻译调用"时生效（别把全库字面量都吞了）', () => {
    const withCall = scanSources([
      { file: 'a.tsx', source: "const label = 'plain.word';\nt('x.y');" },
    ]);
    expect(withCall.looseLiterals.has('plain.word')).toBe(true);
    const withoutCall = scanSources([{ file: 'b.tsx', source: "const label = 'plain.word';" }]);
    expect(withoutCall.looseLiterals.has('plain.word')).toBe(false);
    expect(withoutCall.literalCalls.size).toBe(0);
  });

  it('④ 模板前缀推断：`err.${code}` 覆盖所有 err.* 键，且不越界到别的命名空间', () => {
    const rep = scanSources([{ file: 'error.ts', source: 'const key = `err.${code}`;\nt(key);' }]);
    expect([...rep.templatePrefixes.keys()]).toEqual(['err.']);
    const dict = { 'err.A': 'a', 'err.B': 'b', 'other.C': 'c' };
    const { uncovered } = computeOrphans(dict, rep, 3, []);
    expect(uncovered).toEqual(['other.C']);
  });

  it('人为制造一个孤儿键 ⇒ 经同一判决被判为"新增孤儿"（红路径真的会红）', () => {
    const rep = scanSources([{ file: 'x.tsx', source: "t('used.key');" }]);
    const dict = { 'used.key': '在用', 'nobody.uses': '没人用' };
    // 空基线：新增孤儿必须被抓出
    expect(computeOrphans(dict, rep, 3, []).orphans).toEqual(['nobody.uses']);
    // 进基线后放行 —— 证明棘轮的放行是"显式登记"而不是"检测不到"
    expect(computeOrphans(dict, rep, 3, ['nobody.uses']).orphans).toEqual([]);
  });

  it('基线键一旦被源码引用 ⇒ 判为"陈旧基线"（红路径），逼着删条目', () => {
    const dict = { 'was.dead': '曾被冻结' };
    const before = scanSources([{ file: 'y.tsx', source: "const x = 'nothing';" }]);
    expect(computeOrphans(dict, before, 3, []).uncovered).toEqual(['was.dead']);

    const after = scanSources([{ file: 'y.tsx', source: "t('was.dead');" }]);
    const uncoveredSet = new Set(computeOrphans(dict, after, 3, []).uncovered);
    const stale = ['was.dead'].filter((key) => !uncoveredSet.has(key));
    expect(stale).toEqual(['was.dead']); // ⇒ 主用例里那条断言会红
  });

  it('点号形态判据不误吞相对路径/URL/IP（形态边界）', () => {
    const rep = scanSources([
      { file: 'z.tsx', source: "import a from './a/b'; const u = 'http://x/y'; const ip = '10.0.0.1'; t('real.key');" },
    ]);
    expect(rep.dottedLiterals.has('real.key')).toBe(true);
    expect(rep.dottedLiterals.has('./a/b')).toBe(false);
    expect(rep.dottedLiterals.has('http://x/y')).toBe(false);
    expect(rep.dottedLiterals.has('10.0.0.1')).toBe(false);
  });
});

describe('基线生成（仅 I18N_ORPHANS_WRITE=1 时执行，平时 skip）', () => {
  it.skipIf(process.env.I18N_ORPHANS_WRITE !== '1')('用当前检测器落盘基线', () => {
    const payload: BaselineFile = {
      _note:
        'i18n 孤儿棘轮基线：字典里存在、但静态检测器无法证明被引用的键。只减不增——' +
        '键一旦被源码引用必须删掉本条目（i18n-orphans.test.ts 会红）。由 I18N_ORPHANS_WRITE=1 生成。',
      _regen:
        'cd apps/admin-web && I18N_ORPHANS_WRITE=1 npx vitest run src/__tests__/i18n-orphans.test.ts',
      maxKeys: tier3.uncovered.length,
      keys: tier3.uncovered,
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  });
});
