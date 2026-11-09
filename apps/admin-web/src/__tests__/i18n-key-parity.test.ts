/**
 * i18n 键集**双向**守卫（R2 / i18n-guard）：`locales/zh.ts` ↔ `locales/en.ts`
 * 的键集合必须**严格相等**，且同一键在两边的**取值形态**必须一致。
 *
 * ## 为什么另开一条（已有 i18n-infra.test.tsx 里那条不够）
 *
 * `i18n-infra.test.tsx` 里只有一句 `expect(enKeys).toEqual(zhKeys)`。它能红，
 * 但**失败信息没有定位力**：`toEqual` 对三千多键的数组只吐"长度不同"或一大段
 * 难以阅读的差异，改字典的人拿不到「哪几个键、哪个方向」；更要紧的是它只比
 * **键名**，键在但取值形态变了（一侧是 `'a.b'` 字符串、另一侧被写成嵌套对象
 * `a: { b: ... }`）时，`Object.keys` 依然相等，而运行时 `i18n.t('a.b')` 一侧
 * 拿到字符串、另一侧拿到对象——渲染出 `[object Object]` 或直接报错。这类
 * 「键在但结构不同」是单纯键集比对的盲区。
 *
 * ## 本守卫的判据（四条，全部双向）
 *
 *  ① zh 有而 en 无 ⇒ 红（英文界面回退中文，静默中英混排）；
 *  ② en 有而 zh 无 ⇒ 红（zh 是 fallbackLng，缺则在两种语言下都可能裸 key）；
 *  ③ 同键形态不一致（string vs array/object/number/...）⇒ 红；
 *  ④ 字典源文件里同一键被**字面量写两次** ⇒ 红（JS 对象字面量后者静默覆盖
 *     前者，`Object.keys` 完全看不见——"3,310 条键"可能是 3,311 行键去掉一个
 *     重复）。这是 `toEqual` 那条判据结构上不可能发现的一类漂移。
 *
 * 当前基线是 **0/0 差异、0 形态不一致**，所以本文件首跑即绿——它的价值是
 * "钉住"这个对齐状态：任何一边单方面加/删键、或把扁平键改成嵌套对象，立刻红。
 *
 * ## 报差异的形态：计数 + 前 N 条键名
 *
 * 只断言 `toHaveLength(0)` 会让人再去手工二分；这里统一走 `reportDiff()`，
 * 输出形如 `zh 有而 en 无：共 3 条（仅列前 20 条）：a.b, c.d, e.f`，让失败
 * 信息自带定位与规模感（只列前 N 条是因为真实漂移可能上百条，刷屏反而难读）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import zh from '../locales/zh';
import en from '../locales/en';

/** 差异列表在失败信息里最多展示多少条键名（其余只计数）。 */
const MAX_SHOWN = 20;
/** 规模下限：远低于真实值，只用于挡住"字典被清空/导入坏掉 ⇒ 全部判绿"的假绿。 */
const MIN_KEYS = 3000;

/** 取值形态标签。不用 `typeof` 直出，是为了把 array/null 与 object 分开报。 */
type Shape =
  | 'string'
  | 'array'
  | 'object'
  | 'null'
  | 'number'
  | 'boolean'
  | 'undefined'
  | 'function'
  | `other:${string}`;

export function shapeOf(value: unknown): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined' || t === 'function') {
    return t;
  }
  if (t === 'object') return 'object';
  return `other:${t}`;
}

/** 统一的差异文案：计数 + 前 N 条（超出部分明确说明被截断）。 */
export function reportDiff(label: string, entries: string[]): string {
  if (entries.length === 0) return `${label}：共 0 条`;
  const shown = entries.slice(0, MAX_SHOWN).join(', ');
  const truncated =
    entries.length > MAX_SHOWN ? `（已截断，另有 ${entries.length - MAX_SHOWN} 条未列出）` : '';
  return `${label}：共 ${entries.length} 条（列前 ${Math.min(entries.length, MAX_SHOWN)} 条）：${shown}${truncated}`;
}

/** ① / ②：单向键差集。 */
export function diffKeys(left: Record<string, unknown>, right: Record<string, unknown>): string[] {
  return Object.keys(left)
    .filter((k) => !(k in right))
    .sort();
}

/** ③：两边都有的键里，形态不一致的（形如 `key: zh=string, en=object`）。 */
export function shapeMismatches(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(left).sort()) {
    if (!(key in right)) continue;
    const a = shapeOf(left[key]);
    const b = shapeOf(right[key]);
    if (a !== b) out.push(`${key} (zh=${a}, en=${b})`);
  }
  return out;
}

/**
 * ④：从字典**源文件**里抠出"被字面量写过的键"，找出重复出现的。
 *
 * 走 TS AST 而不是逐行正则：字典里实际存在 **一行两条键** 的写法
 * （`zh.ts:340` / `en.ts:334`：`'taskList.adminOnly': '…',  'taskList.deleteConfirm': '…',`）。
 * 逐行正则只取行首一条 ⇒ 数出 3,309 条，而运行时 `Object.keys` 是 3,738
 * （3,310 手写 + 428 生成）——**少的那一条正是藏在同一行里**，而且"同一行把
 * 同一个键写两遍"这种真重复也会被整行正则漏掉。AST 里每个 PropertyAssignment
 * 都是独立节点，这类形态天然覆盖。
 */
export function duplicateLiteralKeys(source: string, fileLabel = 'locale.ts'): string[] {
  const sf = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true);
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name;
      if (ts.isStringLiteral(name) || ts.isIdentifier(name)) {
        counts.set(name.text, (counts.get(name.text) ?? 0) + 1);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([k, n]) => `${k} ×${n}`)
    .sort();
}

describe('i18n 键集双向守卫：zh ↔ en 键集合严格相等', () => {
  const zhRec = zh as unknown as Record<string, unknown>;
  const enRec = en as unknown as Record<string, unknown>;

  it('规模守卫：两边键数都超过下限（挡"字典导入坏掉 ⇒ 空集相等 ⇒ 假绿"）', () => {
    expect(Object.keys(zhRec).length).toBeGreaterThan(MIN_KEYS);
    expect(Object.keys(enRec).length).toBeGreaterThan(MIN_KEYS);
  });

  it('① zh 有而 en 无 ⇒ 红（英文界面会静默回退中文）', () => {
    expect(reportDiff('zh 有而 en 无', diffKeys(zhRec, enRec))).toBe(
      'zh 有而 en 无：共 0 条',
    );
  });

  it('② en 有而 zh 无 ⇒ 红（zh 是 fallbackLng，缺两侧都不安全）', () => {
    expect(reportDiff('en 有而 zh 无', diffKeys(enRec, zhRec))).toBe(
      'en 有而 zh 无：共 0 条',
    );
  });

  it('③ 同键在两边的取值形态一致（string vs array/object —— 键集比对的盲区）', () => {
    expect(reportDiff('形态不一致', shapeMismatches(zhRec, enRec))).toBe('形态不一致：共 0 条');
  });

  it('字典取值形态单一：顶层键的值全是 string（嵌套/数组需先扩展本守卫）', () => {
    // 现状：运行时 3,738 个键（3,310 手写 + 428 生成）全部是 string。若将来有人引入嵌套对象承载复数/多形态
    // 文案，本断言会红——那是**提示**而不是缺陷：届时需要把 shapeOf 的比较
    // 扩展到递归结构，否则 ③ 的字符串比较会退化成恒真。
    const odd: string[] = [];
    for (const [key, value] of Object.entries(zhRec)) {
      const s = shapeOf(value);
      if (s !== 'string') odd.push(`${key} (zh=${s})`);
    }
    for (const [key, value] of Object.entries(enRec)) {
      const s = shapeOf(value);
      if (s !== 'string') odd.push(`${key} (en=${s})`);
    }
    // 注意：空串（`execs.col.action` 是故意的表格列头留白）形态仍是 string，
    // 与本条无关；本守卫**不**判「翻译是否为空」，那是产品口径问题。
    expect(reportDiff('非 string 取值', odd)).toBe('非 string 取值：共 0 条');
  });

  it('④ 字典源文件里没有"同一键写两次"（后者静默覆盖前者，键集比对看不见）', () => {
    const localesDir = resolve(__dirname, '../locales');
    for (const file of ['zh.ts', 'en.ts']) {
      const src = readFileSync(resolve(localesDir, file), 'utf-8');
      expect(reportDiff(`${file} 重复键`, duplicateLiteralKeys(src))).toBe(
        `${file} 重复键：共 0 条`,
      );
    }
  });
});

describe('守卫自身有牙（反证：绿不能是"正则/比较写错了 ⇒ 恒真"造成的）', () => {
  it('① 只缺一边能抓到：zh 多一个键 ⇒ 判决为"zh 有而 en 无"', () => {
    const fakeZh = { 'a.b': 'x', 'a.onlyZh': 'y' };
    const fakeEn = { 'a.b': 'x' };
    expect(diffKeys(fakeZh, fakeEn)).toEqual(['a.onlyZh']);
    // 反方向必须是空的——证明两个方向是独立的判据，不是同一条式子跑两遍
    expect(diffKeys(fakeEn, fakeZh)).toEqual([]);
  });

  it('② 反向同样有牙：en 多一个键 ⇒ 判决为"en 有而 zh 无"', () => {
    // 注意实参顺序：diffKeys(left, right) 判的是 left 有而 right 无，方向靠入参
    // 决定（① 传 zh,en；② 传 en,zh）。写错顺序会让两条断言变成同一条式子的
    // 复读——本用例就是被自己这条"反向"抓出来的，故保留注释。
    expect(diffKeys({ 'a.b': 'x', 'a.onlyEn': 'z' }, { 'a.b': 'x' })).toEqual(['a.onlyEn']);
  });

  it('③ 键都在但形态不同能抓到（string vs object，键集比对必绿的那种）', () => {
    const left = { 'a.b': 'flat string' };
    const right = { 'a.b': { nested: 'object' } as unknown as string };
    expect(Object.keys(left).sort()).toEqual(Object.keys(right).sort()); // 键集相同 ⇒ 前两条判据全绿
    expect(shapeMismatches(left, right)).toEqual(['a.b (zh=string, en=object)']);
  });

  it('④ 重复键能抓到（同键写两次，含"一行两键"形态）', () => {
    const fake = [
      'export default {',
      "  'a.b': '1',",
      "  'a.b': '2',",
      "  // 'c.d': 注释里的不算重复",
      "  'c.d': '3',",
      "  'e.f': 'x',  'e.f': 'y',", // 一行两键且同键 ⇒ 必须数到 2 次
      "  'g.h': 'x',  'i.j': 'y',", // 一行两键、不同键 ⇒ 各 1 次
      '};',
    ].join('\n');
    expect(duplicateLiteralKeys(fake)).toEqual(['a.b ×2', 'e.f ×2']);
    // 控制组：把重复换成不同键 ⇒ 必须为空（证明不是"见到两键就报"）
    const clean = "export default {\n  'a.b': '1',  'a.c': '2',\n};";
    expect(duplicateLiteralKeys(clean)).toEqual([]);
  });

  it('reportDiff 在大规模差异时截断并给出计数（失败信息不刷屏）', () => {
    const many = Array.from({ length: MAX_SHOWN + 5 }, (_, i) => `k.${i}`);
    const text = reportDiff('示例', many);
    expect(text).toContain(`共 ${MAX_SHOWN + 5} 条`);
    expect(text).toContain(`另有 5 条未列出`);
    expect(text).not.toContain('k.24'); // 第 21 条起不再列名
  });
});
