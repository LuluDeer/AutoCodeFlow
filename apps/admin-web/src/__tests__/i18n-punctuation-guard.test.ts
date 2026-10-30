/**
 * R6-P3（第 6 轮审计 P3）：**用户可见标点必须来自词条**，不得写死在 JSX/字符串里。
 *
 * ## 缺陷形态（英文界面才会撞见，tsc/lint/vitest 全看不见）
 *
 *   <Text>{t('agents.col.tool')}：</Text>      → 英文界面渲染 `Tool：`
 *   {t('taskForm.window.add')}（…）             → 英文界面渲染 `（1/10）`
 *   .join('；')                                 → 英文界面渲染 `a；b`
 *   {'：'} / {'（'}                             → 同上，只是把标点单独放在一个字面量里
 *
 * 这些串本身合法、key 也在字典里，所以类型检查、ESLint、既有 i18n 守卫
 * （`i18n-scan` 只认 CJK 汉字；`i18n-key-check` 只认键集）都**看不见**它们：
 * 全角标点既不是汉字，也不影响键的存在性。只有把界面切到英文的人会发现
 * `Tool：` 这种中英混排。故需要一条**结构判据**，而不是文案判据。
 *
 * ## 判据（命中即红，无基线豁免）
 *
 *   ① `t('…')` 的紧邻位置出现全角标点——前后各允许跨 ≤40 个**结构字符**
 *      （空白、`{}`、`()`、`,`、`+`、引号），因此跨行、跨 JSX 花括号、
 *      `` `${v}（${t('x')}）` `` 这类插值都能抓到；
 *   ② 全角标点**单独成字面量**：JSX 容器 `{'：'}` 与列表分隔符 `.join('；')`。
 *
 * 刻意**不算**违规的符号（它们在 en 里同样正确，属语言无关排版）：
 * `—`（em dash，空值占位）、`…`（省略号）、`·`（中点）。这把「全角标点全禁」
 * 收窄成「中文标点禁」，避免守卫制造假红（假红会驱使人去改对的东西）。
 *
 * ## 口径（与 docs/atlas/07-testing/testing-conventions.md「i18n 文案标点」一致）
 *
 *   · **标点并入词条值**，只有一种口径：zh 用全角（`：` `（）` `、` `；`），
 *     en 用半角 + 该语言应有的空格（`: ` `() ` `, ` `; `）。
 *   · key 只在该语境出现 ⇒ 直接改值（`'池目录'` → `'池目录：'`，见
 *     `execDetail.interpreter.poolDir`）；
 *   · 同一 key 在别处被复用（表头/表单标签，**不带**标点）⇒ 加 `<key>_colon`
 *     变体（`agents.col.tool` / `agents.col.tool_colon`），**不复制上下文不同的
 *     key**，也不改基词条（否则表头变成 `工具：`）；
 *   · 绝不按语言在代码里取标点（`isZh ? '：' : ': '`）——判断会散到各处且不可测；
 *   · 列表分隔符同样是语言资源：`common.listSep.{semicolon,comma,space}`。
 *
 * ## 反证（「守卫有牙」，防假绿）
 *
 * `守卫自身有牙` 用例喂合成的违规片段，必须逐条抓到；同一条合规写法必须放过。
 * 手工反证：把任一处改回 `{t('agents.col.tool')}：`（或 `.join('；')`），
 * 本文件立即红——这就是它防复发的方式。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC_ROOT = resolve(__dirname, '..');

/** 全角（中文）标点集合。刻意不含 `—`/`…`/`·`：那三个在 en 里同样正确。 */
const FULLWIDTH = '：（）【】，。、；！？';
const FULLWIDTH_SET = new Set([...FULLWIDTH, '\u3000']);

/** 判据①允许跨过的「结构字符」：空白、JSX 花括号、调用/表达式符号、引号。 */
const STRUCTURAL = new Set([' ', '\t', '\n', '\r', '{', '}', '(', ')', ',', '+', "'", '"', '`', '$']);

/** 单个 t() 调用的键字面量（`t('k')` / `i18n.t("k")` / `` t(`k`) ``）。 */
const T_CALL_KEY = /\bt\(\s*(?:(['"])(?:\\.|(?!\1)[^\\\n])*\1|`(?:\\.|[^`\\])*`)/g;

/** 判据②：全角标点单独成字面量的两种真实形态。 */
const PUNCT_LITERAL_PATTERNS: { rule: string; re: RegExp }[] = [
  // JSX 表达式容器里的纯标点：{that colon} / {'（'}
  { rule: 'jsx-punct-literal', re: new RegExp(`\\{\\s*(['"\`])([${FULLWIDTH}\\u3000]+)\\1\\s*\\}`, 'g') },
  // 列表分隔符：join('；') / join('、') / join(U+3000 全角空格)
  { rule: 'join-punct-literal', re: new RegExp(`\\.join\\(\\s*(['"\`])([${FULLWIDTH}\\u3000]+)\\1\\s*\\)`, 'g') },
];

export interface PunctViolation {
  line: number;
  rule: string;
  char: string;
  snippet: string;
}

/**
 * 抹掉注释，保留换行（行号不漂移）。
 *
 * 必须剥注释：本仓注释里中文标点遍地都是（那正是「写给人看的中文」），
 * 不剥就是几千条假红。剥法对 `//` 做协议名保护（`https://` 不能被当成行注释
 * 吃掉整行——否则同一行后面的违规会被一起隐藏，守卫假绿）。
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

function lineAt(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

function snippetAt(src: string, offset: number): string {
  const start = src.lastIndexOf('\n', offset) + 1;
  const end = src.indexOf('\n', offset);
  return src
    .slice(start, end === -1 ? src.length : end)
    .trim()
    .slice(0, 120);
}

/** 判据①：从 t() 键字面量末尾向前找第一个非结构字符，是全角标点即违规。 */
function punctAfterT(clean: string, out: PunctViolation[]): void {
  for (const m of clean.matchAll(T_CALL_KEY)) {
    let i = (m.index ?? 0) + m[0].length;
    const limit = Math.min(clean.length, i + 40);
    while (i < limit && STRUCTURAL.has(clean[i])) i += 1;
    const ch = clean[i];
    if (i < limit && FULLWIDTH_SET.has(ch)) {
      out.push({ line: lineAt(clean, i), rule: 'punct-after-t', char: ch, snippet: snippetAt(clean, m.index ?? 0) });
    }
  }
}

/**
 * 判据①（反向）：全角标点后紧跟 t()——覆盖 `{'（'}{t('x')}` 与
 * `` `${v}（${t('x')}）` `` 两种「括号先出现」的写法。
 */
function punctBeforeT(clean: string, out: PunctViolation[]): void {
  for (const m of clean.matchAll(T_CALL_KEY)) {
    const start = m.index ?? 0;
    let i = start - 1;
    const limit = Math.max(-1, start - 41);
    while (i > limit && STRUCTURAL.has(clean[i])) i -= 1;
    const ch = clean[i];
    if (i > limit && FULLWIDTH_SET.has(ch)) {
      out.push({ line: lineAt(clean, i), rule: 'punct-before-t', char: ch, snippet: snippetAt(clean, start) });
    }
  }
}

/** 判据②：全角标点单独成字面量。 */
function punctLiteral(clean: string, out: PunctViolation[]): void {
  for (const { rule, re } of PUNCT_LITERAL_PATTERNS) {
    for (const m of clean.matchAll(re)) {
      const char = (m[2] ?? '')[0] ?? '';
      out.push({ line: lineAt(clean, m.index ?? 0), rule, char, snippet: snippetAt(clean, m.index ?? 0) });
    }
  }
}

/** 在**源码文本**上做全部判据（导出给「守卫有牙」用例喂合成片段）。 */
export function findPunctuationViolations(source: string): PunctViolation[] {
  const clean = stripComments(source);
  const out: PunctViolation[] = [];
  punctAfterT(clean, out);
  punctBeforeT(clean, out);
  punctLiteral(clean, out);
  return out.sort((a, b) => a.line - b.line);
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      // 口径同 i18n-scan / i18n-key-check：语言包与测试本身不扫
      if (entry === '__tests__' || entry === 'locales' || entry === 'node_modules') continue;
      collectSourceFiles(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

describe('R6-P3：用户可见标点必须来自词条（源码守卫）', () => {
  const files = collectSourceFiles(SRC_ROOT);

  it('扫描面非空（反永真：目录遍历本身没坏）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('源码里没有「t(...) 紧邻全角标点」', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const v of findPunctuationViolations(readFileSync(file, 'utf-8'))) {
        const rel = file.replace(SRC_ROOT, '').replace(/\\/g, '/');
        violations.push(`${rel}:${v.line}  [${v.rule}] ${v.char}  ←  ${v.snippet}`);
      }
    }
    // 失败信息带 file:line + 触发字符 + 该行源码：不需要再手跑一遍才知道改哪。
    // 修法见本文件头注「口径」：标点并进词条值；被复用的 key 用 _colon 变体。
    expect(violations).toEqual([]);
  });

  it('列表分隔符/孤立标点没有写死成字面量（join(\'；\') / {\'：\'}）', () => {
    const violations: string[] = [];
    for (const file of files) {
      const clean = stripComments(readFileSync(file, 'utf-8'));
      const out: PunctViolation[] = [];
      punctLiteral(clean, out);
      for (const v of out) {
        const rel = file.replace(SRC_ROOT, '').replace(/\\/g, '/');
        violations.push(`${rel}:${v.line}  [${v.rule}] ${v.char}  ←  ${v.snippet}`);
      }
    }
    // 分隔符也是语言资源：用 common.listSep.{semicolon,comma,space}
    // （zh `；`/`、`/U+3000 全角空格，en `; `/`, `/` `）。
    expect(violations).toEqual([]);
  });

  it('守卫自身有牙：合成片段必须被抓到，合规写法必须放过', () => {
    // —— 该红的形态（每条都对应一处真实修过的缺陷）——
    const expectedRed: [string, string][] = [
      ["<Text>{t('agents.col.tool')}：</Text>", 'punct-after-t'], // 本轮起点（UserManagementPage 同款）
      ["{t('users.col.createdAt')}：{formatDateTime(x)}", 'punct-after-t'],
      ["{\n  t('taskForm.field.gitRepo')\n}\n：<Text code>{v}</Text>", 'punct-after-t'], // 跨行的三元表达式
      ["{t('agents.col.args')}{'：'}", 'punct-after-t'],
      ['title={`${v}（${t(\'audit.resourceId.open\')}）`}', 'punct-after-t'],
      ["{'（'}{t('security.password.strength.unmetHint')}{'）'}", 'punct-before-t'],
      ["<Text>{'：'}</Text>", 'jsx-punct-literal'],
      ["list.map((x) => x.error).join('；')", 'join-punct-literal'],
      ["list.join('、')", 'join-punct-literal'],
      ["bits.join('　')", 'join-punct-literal'],
    ];
    for (const [src, rule] of expectedRed) {
      const hits = findPunctuationViolations(src);
      expect(hits.map((h) => h.rule), `应判红但放过了：${src}`).toContain(rule);
    }

    // —— 该绿的形态（防「一律判红」的假红）——
    const expectedGreen: string[] = [
      "{t('agents.col.tool_colon')}", // 标点已并入词条
      "{t('taskForm.window.add', { current: 1, max: 10 })}",
      "list.join(t('common.listSep.semicolon'))", // 分隔符走词条
      "{t('x')} · {t('y')}", // 中点 `·` 是语言无关排版
      "{t('x')}—{formatDateTime(v)}", // em dash 同上
      "// 注释里的：标点不算（注释是写给人看的）", // 注释剥掉
      "const url = 'https://example.com'; // 协议名不能被当成行注释", // `//` 保护
    ];
    for (const src of expectedGreen) {
      expect(findPunctuationViolations(src), `不该判红：${src}`).toEqual([]);
    }
  });
});
