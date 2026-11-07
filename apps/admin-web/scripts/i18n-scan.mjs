#!/usr/bin/env node
/**
 * i18n 硬编码中文扫描 / 守卫。
 *
 * 用 TypeScript 官方 parser 走 AST，而不是正则/grep：
 *  - 注释被 parser 天然排除（本仓库中文注释占比极高，TaskFormPage 350 行含
 *    中文里只有 ~72 行带引号、且**全是注释**——grep 会高估近 5 倍并误导迁移
 *    排期，本项目就发生过一次"清单说 350 处、实际 0 处"）；
 *  - JSX 文本节点（JsxText）与字符串字面量（StringLiteral）语义分明，
 *    不会把 `// 中文` 或 `/* 中文 *​/` 或 `{/* 中文 *​/}` 算进来；
 *  - 自带容错（parse 失败仍返回树），文件里有解析器不认识的新语法也不会让
 *    整个扫描静默变空——上一版手写状态机就栽在这里（漏掉整个 TaskFormPage）。
 *
 * ## 运行模式
 *
 *   node scripts/i18n-scan.mjs             盘点：列出所有疑似硬编码中文串（exit 0）
 *   node scripts/i18n-scan.mjs --check     守卫：只报「不在基线里」的新增项（红 = exit 1）
 *   node scripts/i18n-scan.mjs --json      盘点（机器可读 JSON）
 *   node scripts/i18n-scan.mjs --selftest  自检：在临时夹具树里跑**真子进程**，
 *                                          逐条断言真实 exit code 与关键输出
 *
 * 选项：
 *   --file <rel>   只扫 src/ 下单个文件（路径相对 src/）。**显式点名**，不受下面的
 *                  SKIP_FILES 影响——它是人手动做的单点探针，不是自动采集面。
 *   --root <dir>   把该目录当 admin-web 根（默认本脚本的上一级）；自检/夹具专用。
 *
 * ## 模式互斥（显式报错，不静默取其一）
 *
 * `--selftest` 与 `--check` / `--json` / `--file` **同时给 ⇒ exit 2（用法错误）**。
 * 理由：自检内部要拉子进程跑 `--check`；若命令行把两者混在一起，就无法从参数读出
 * 这次运行到底是"自检"还是"被自检的守卫"，CI 里很容易变成"以为跑了自检、实际跑
 * 的是主判据"（反方向的假绿同理）。**不定义优先级**——定义优先级等于允许混用，
 * 混用时的那一半永远是猜的。
 *
 * ## 退出码
 *
 *   0 = 通过 / 盘点完成
 *   1 = 守卫失败（新增硬编码、基线陈旧）或自检失败
 *   2 = 用法错误（未知参数、--root 下没有 src/、--file 越界/不存在、selftest 混用主判据开关）
 *
 * 守卫模式配合 scripts/i18n-baseline.json 使用：基线内的存量（合法的语言名自称、
 * 内部不变量错误信息等，见基线文件内注释）不算失败，**新增**才算。这样守卫能真正
 * 拦住"新页面又写死中文"，而不是一上来就红一片被关掉。
 *
 * ## 采集面与排除（为什么"界面串"这三个字是判据的边界）
 *
 * 采集面 = `src/**` 下所有 `.ts` / `.tsx`。排除分两类，都是**显式**的：
 *
 *   1. **目录级**（既有，保持不变）：`__tests__/`、`locales/`、`node_modules/`。
 *      tests 会 stub 词条、locales 是键集本体，都不是界面代码。
 *   2. **文件级**（`SKIP_FILES`，本守卫新增）：见下节。
 *
 * ### 测试基础设施文件：SKIP_FILES（显式列举确切文件名）
 *
 * `test-setup.ts`、`test-setup-scheduler-guard.ts` 是 vitest 的 `setupFiles`
 * （见 `apps/admin-web/vite.config.ts` 的 `test.setupFiles`）。它们**只在测试期运行**，
 * 其中的中文字符串是抛给**开发者/CI 日志**的诊断信息（如浮空 rejection 收割器：
 * 「请在该调用点消费 rejection…」），在浏览器里**永远不会渲染**，连测试用例本身
 * 都读不到它们（只有断言失败时人眼才看）。
 *
 * 本守卫的判据是「**会显示给中文用户以外观感**的硬编码中文串」——
 * 诊断信息不在这个集合里。把它们记进 `i18n-baseline.json` 的 `accepted` 是
 * 「登记代替修复」的形态：判据面会随每次新增诊断串一起膨胀，最后没人读得懂
 * 「已接受 N 处」这个数字代表什么。故排除放在**采集面**上，理由放在这里与
 * `scripts/README-i18n-guard.md` 里。
 *
 * **三条边界（别把这条规则写宽，写宽了守卫就瞎了）**：
 *
 *   · 只排除**确切文件名**，不是 `*test*` / `*.test.ts` / `*.spec.ts` 通配。
 *     `src/**` 下若将来真的出现**界面代码写在 `*.test.ts(x)` 里**（本不该有），
 *     它**仍然会被扫到并报红**——selftest 用例⑤钉住这条边界；
 *   · 不按内容/目录猜：没有"文件名含 setup 就跳过"的启发式，新增测试基础设施
 *     文件必须在这里**加一行名字**，否则它会立刻进采集面（大概率马上红，这正是
 *     我们要的信号：诊断串 vs 界面串由人显式判定，不由命名模式推断）；
 *   · 目录级排除保持不变，且对 `--file` 不做隐式跳过：显式点名就扫。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** admin-web 根（本脚本在 `apps/admin-web/scripts/` 下）。 */
const DEFAULT_ROOT = resolve(import.meta.dirname, '..');
/** 本脚本自身：自检要把"真脚本"当黑盒再跑一遍。 */
const SELF = fileURLToPath(import.meta.url);
const CJK = /[\u4e00-\u9fff]/;

/**
 * 测试基础设施文件（**确切文件名**）⇒ 不进「界面硬编码中文」采集面。
 * 依据与边界见头注「测试基础设施文件：SKIP_FILES」。新增项必须写进这里，
 * 不要改成通配模式。
 */
const SKIP_FILES = new Set([
  'test-setup.ts',
  'test-setup-scheduler-guard.ts',
]);

/** 目录级排除（既有口径，保持不变）。 */
const SKIP_DIRS = new Set(['__tests__', 'locales', 'node_modules']);

function usageError(message) {
  console.error(`❌ i18n-scan 用法错误：${message}`);
  console.error('   用法：node scripts/i18n-scan.mjs [--check | --json] [--file <相对 src/ 的路径>] [--root <目录>]');
  console.error('         node scripts/i18n-scan.mjs --selftest');
  process.exit(2);
}

/**
 * 解析命令行。
 *
 * 位置参数 / 未知开关一律**报错**（exit 2）而不是忽略：拼错的开关会让守卫
 * 扫错面或跑错模式，静默忽略是假绿的第一入口。
 */
function parseArgs(argv) {
  const opts = { check: false, json: false, selftest: false, file: null, root: DEFAULT_ROOT };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      opts.check = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--selftest') {
      opts.selftest = true;
    } else if (arg === '--root' || arg === '--file') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usageError(`${arg} 需要一个值`);
      i += 1;
      if (arg === '--root') opts.root = resolve(value);
      else opts.file = value;
    } else {
      usageError(`未知参数 ${JSON.stringify(arg)}（拒绝静默忽略：拼错的开关会让守卫扫错面）`);
    }
  }

  const mixedWithSelftest = [];
  if (opts.check) mixedWithSelftest.push('--check');
  if (opts.json) mixedWithSelftest.push('--json');
  if (opts.file) mixedWithSelftest.push('--file');
  if (opts.selftest && mixedWithSelftest.length > 0) {
    usageError(
      `--selftest 与 ${mixedWithSelftest.join(' / ')} 互斥：自检要跑的是真子进程里的守卫，` +
        '不能与主判据开关混用（混用时"这次到底跑了哪个"无法从命令行判定）',
    );
  }

  return opts;
}

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collect(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry) && !SKIP_FILES.has(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * 找出「会显示给中文用户以外观感」的硬编码中文串。
 * 判定：JsxText / StringLiteral / NoSubstitutionTemplateLiteral / TemplateExpression
 * 的头部文本里含 CJK。
 */
function scanFile(file) {
  const src = readFileSync(file, 'utf-8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  function record(node, kind, text) {
    if (!CJK.test(text)) return;
    hits.push({ line: lineOf(node), kind, text: text.trim().slice(0, 120) });
  }

  function visit(node) {
    switch (node.kind) {
      case ts.SyntaxKind.JsxText:
        record(node, 'jsx-text', node.text);
        break;
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        record(node, 'string', node.text);
        break;
      case ts.SyntaxKind.TemplateExpression:
        record(node, 'template', node.head.text);
        for (const span of node.templateSpans) record(span.literal, 'template', span.literal.text);
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

/** 按 root 采集并扫描，返回按命中数降序的报告。 */
function scanTree(root, onlyFile) {
  const srcRoot = join(root, 'src');
  if (!existsSync(srcRoot)) {
    // 没有 src/ 时 collect() 会抛 ENOENT，或（若有人改成容错）得到「0 命中 = 假绿」。
    // 这里直接按用法错误退出，不让"扫了个空目录"看起来像通过。
    usageError(`根目录下没有 src/：${srcRoot}（--root 指错时会扫到空树并假绿，故直接报错）`);
  }

  let targets;
  if (onlyFile) {
    const abs = resolve(srcRoot, onlyFile);
    if (abs !== srcRoot && !abs.startsWith(srcRoot + sep)) {
      usageError(`--file 越界（必须是 src/ 下的相对路径）：${onlyFile}`);
    }
    if (!existsSync(abs)) usageError(`--file 指向的文件不存在：${abs}`);
    if (!/\.(ts|tsx)$/.test(abs)) usageError(`--file 只接受 .ts / .tsx：${onlyFile}`);
    targets = [abs];
  } else {
    targets = collect(srcRoot);
  }

  const report = [];
  for (const f of targets) {
    const hits = scanFile(f);
    if (hits.length) {
      report.push({
        file: relative(srcRoot, f).replace(/\\/g, '/'),
        count: hits.length,
        hits: hits.sort((a, b) => a.line - b.line),
      });
    }
  }
  report.sort((a, b) => b.count - a.count);
  return report;
}

/** 守卫模式：返回 0（通过）或 1（新增/陈旧）。 */
function checkReport(report, root) {
  // 基线里记录"已知且已接受"的存量串（按 文件 + 串内容 比对，不按行号——
  // 行号会随无关编辑漂移，用它做基线会导致每次改动都误报）。
  const baselinePath = join(root, 'scripts', 'i18n-baseline.json');
  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf-8'))
    : { accepted: {} };
  const accepted = baseline.accepted ?? {};

  // 按「文件 + 串内容」计数比对，而不是做成 Set：
  // 同一文件里同一串可能出现多次（如 api/tasks.ts 的分页信息里 "第"/"页"
  // 各出现多次）。若只用 Set，第二次出现会被静默放行；用计数则新增一处
  // 同类串也能被抓住。
  const budget = new Map();
  for (const [file, strs] of Object.entries(accepted)) {
    for (const s of strs) {
      const k = `${file}\u0000${s}`;
      budget.set(k, (budget.get(k) ?? 0) + 1);
    }
  }
  const acceptedTotal = [...budget.values()].reduce((s, n) => s + n, 0);

  const violations = [];
  for (const r of report) {
    // 该文件内每串的出现次数，从多到少消耗预算
    for (const h of r.hits) {
      const k = `${r.file}\u0000${h.text}`;
      const left = budget.get(k) ?? 0;
      if (left > 0) {
        budget.set(k, left - 1);
        continue;
      }
      violations.push({ ...h, file: r.file });
    }
  }

  if (violations.length === 0) {
    // ── N-04 反向检查：基线里「已经不存在」的条目 ──────────────────────
    // 此前守卫只查「新增」（实串 ∉ 基线），不查「陈旧」（基线 ∉ 实串）。
    // 后果是**迁移完成后基线不会自己缩小**：把一处硬编码改成 t('key') 之后，
    // 那条基线记录永远留在文件里，"已接受 N 处"这个数字只增不减，
    // 于是迁移进度读不出来、也没有任何东西提醒该删它。
    // 本项目已实测踩到：`pages/executor-mode.ts` 的 4 条中文映射，其**值从未被渲染**
    // （循环只取 Object.keys，展示由调用方按 field 走 i18n），属死数据却一直计在
    // 待迁移量里——改成语义化字段清单后才暴露。
    // 故：实串消耗不掉的预算余额 = 陈旧条目，一律失败并要求删除。
    const stale = [];
    for (const [k, left] of budget.entries()) {
      if (left > 0) {
        const [file, text] = k.split('\u0000');
        stale.push({ file, text, left });
      }
    }
    if (stale.length > 0) {
      console.error(`❌ i18n 基线陈旧：${stale.length} 条已接受项在源码中**已不存在**。`);
      console.error("   成因通常是「该处已迁移为 t('key')」，但基线记录没同步删除——");
      console.error('   不删的话「已接受 N 处」只增不减，迁移进度无法从该数字读出。');
      console.error('   修法：从 scripts/i18n-baseline.json 的 accepted 里删掉下列条目。\n');
      for (const s of stale) {
        console.error(`   ${s.file}  ${JSON.stringify(s.text)}${s.left > 1 ? `  (×${s.left} 未消耗)` : ''}`);
      }
      return 1;
    }
    console.log(`✅ i18n 守卫通过：未发现新增硬编码中文界面串（基线内 ${acceptedTotal} 处已接受，无陈旧项）。`);
    return 0;
  }

  console.error(`❌ i18n 守卫失败：发现 ${violations.length} 处**新增**硬编码中文界面串。`);
  console.error('   英文界面下这些串不会随语言切换，会造成中英混排。');
  console.error("   修法：改用 t('key')，并在 src/locales/zh.ts 与 en.ts 成对补词条。");
  console.error('   若确属有意保留（如不面向用户的内部错误信息），在 scripts/i18n-baseline.json');
  console.error('   的 accepted 里按 文件→串 追加，并在 PR 里说明理由。');
  console.error('   但**测试基础设施文件**（vitest setup 等）不要登记基线——那会把判据面越滚越大；');
  console.error('   按头注的 SKIP_FILES 口径把它显式排除在采集面外。\n');
  for (const v of violations) {
    console.error(`   ${v.file}:${v.line}  [${v.kind}]  ${v.text}`);
  }
  return 1;
}

/**
 * 自检：验证**判据本身**。
 *
 * 不读真实 `src/`：每个用例在 `mkdtempSync` 的夹具树里跑**本脚本的真子进程**，
 * 断言真实 exit code + 关键输出。理由（本仓第 4 轮守卫审计的结论）：只断言
 * "函数返回了几条"测不到 CLI 入口、`process.exit(1)`、基线比对与采集面这些真正
 * 会坏掉的地方；夹具不隔离则"扫的是真实仓库"，删掉源码时用例还会碰巧变绿。
 */
function runSelftest() {
  const cases = [];

  const fixture = (files, fn) => {
    const dir = mkdtempSync(join(tmpdir(), 'acf-i18n-scan-selftest-'));
    try {
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const run = (args, cwd) => {
    const child = spawnSync(process.execPath, [SELF, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (child.error) throw new Error(`子进程启动失败：${child.error.message}`);
    return { code: child.status, output: `${child.stdout ?? ''}${child.stderr ?? ''}` };
  };

  const expectRun = (result, expected) => {
    const problems = [];
    if (result.code !== expected.code) problems.push(`exit=${result.code}（期望 ${expected.code}）`);
    for (const needle of expected.contains ?? []) {
      if (!result.output.includes(needle)) problems.push(`输出缺少 ${JSON.stringify(needle)}`);
    }
    for (const needle of expected.absent ?? []) {
      if (result.output.includes(needle)) problems.push(`输出不该包含 ${JSON.stringify(needle)}`);
    }
    if (problems.length > 0) {
      throw new Error([problems.join('；'), '——— 输出 ———', result.output.trim() || '(空)'].join('\n'));
    }
  };

  // ① StringLiteral 命中（被扫文件里）
  cases.push({
    name: '① 被扫文件里的 CJK StringLiteral ⇒ 命中（check exit 1，点名文件:行）',
    fn: () =>
      fixture({ 'src/pages/demo.tsx': "export function Demo() {\n  return <div>{'保存'}</div>;\n}\n" }, (dir) => {
        expectRun(run(['--root', dir, '--check'], dir), {
          code: 1,
          contains: ['守卫失败', 'pages/demo.tsx:2', '[string]', '保存'],
        });
      }),
  });

  // ② JsxText 命中
  cases.push({
    name: '② JSX 文本节点里的中文 ⇒ 命中（kind = jsx-text）',
    fn: () =>
      fixture({ 'src/pages/jsx.tsx': 'export const C = () => <div>取消</div>;\n' }, (dir) => {
        expectRun(run(['--root', dir, '--check'], dir), {
          code: 1,
          contains: ['pages/jsx.tsx:1', '[jsx-text]', '取消'],
        });
      }),
  });

  // ③ 注释里的中文不命中（AST 天然排除；防止以后有人退回正则/把注释算进来）
  cases.push({
    name: '③ 注释里的中文 ⇒ 不命中（AST 排除注释，不能退回 grep 口径）',
    fn: () =>
      fixture(
        { 'src/pages/comment.tsx': '// 保存\n/* 取消 */\nexport const N = 1; // 确定\n' },
        (dir) => {
          expectRun(run(['--root', dir, '--check'], dir), {
            code: 0,
            contains: ['守卫通过'],
            absent: ['守卫失败', 'comment.tsx'],
          });
        },
      ),
  });

  // ④ 被排除文件（SKIP_FILES）里的中文不命中 —— 这正是本轮既有红的成因，也是反证点
  cases.push({
    name: '④ SKIP_FILES（vitest setupFiles）里的中文 ⇒ 不命中（不进采集面）',
    fn: () =>
      fixture(
        {
          'src/test-setup.ts':
            'throw new Error(`[ACF][unhandledRejection] 本用例期间出现 条浮空 rejection`);\n',
          'src/test-setup-scheduler-guard.ts': "const msg = '调度器守卫';\n",
        },
        (dir) => {
          expectRun(run(['--root', dir, '--check'], dir), {
            code: 0,
            contains: ['守卫通过'],
            absent: ['守卫失败', 'test-setup'],
          });
        },
      ),
  });

  // ⑤ 边界：排除不是「所有 test 文件」——src 下的 *.test.ts 仍在采集面
  cases.push({
    name: '⑤ 边界：src 下的 *.test.ts 仍被扫（排除只认确切文件名，不是通配）',
    fn: () =>
      fixture({ 'src/helpers.test.ts': "export const label = '保存';\n" }, (dir) => {
        expectRun(run(['--root', dir, '--check'], dir), {
          code: 1,
          contains: ['helpers.test.ts:1', '[string]'],
        });
      }),
  });

  // ⑥ 基线仍然生效（重构后 baseline 口径不能坏）
  cases.push({
    name: '⑥ 夹具基线里的 accepted 串 ⇒ 放行（exit 0，且计数正确）',
    fn: () =>
      fixture(
        {
          'src/pages/ok.tsx': "export const O = () => <div>{'保存'}</div>;\n",
          'scripts/i18n-baseline.json': JSON.stringify({ accepted: { 'pages/ok.tsx': ['保存'] } }),
        },
        (dir) => {
          expectRun(run(['--root', dir, '--check'], dir), {
            code: 0,
            contains: ['基线内 1 处已接受'],
          });
        },
      ),
  });

  // ⑦ 基线陈旧反向检查仍然生效
  cases.push({
    name: '⑦ 基线陈旧项 ⇒ exit 1（N-04 反向检查没被本次重构弄丢）',
    fn: () =>
      fixture(
        {
          'src/pages/real.tsx': 'export const R = 1;\n',
          'scripts/i18n-baseline.json': JSON.stringify({
            accepted: { 'pages/gone.tsx': ['取消'] },
          }),
        },
        (dir) => {
          expectRun(run(['--root', dir, '--check'], dir), {
            code: 1,
            contains: ['基线陈旧', 'pages/gone.tsx'],
          });
        },
      ),
  });

  // ⑧ 模式互斥：--selftest 与 --check 不能混用（且不会递归跑自检）
  cases.push({
    name: '⑧ --selftest 与 --check 互斥 ⇒ exit 2（不定义优先级）',
    fn: () =>
      fixture({}, (dir) => {
        expectRun(run(['--root', dir, '--selftest', '--check'], dir), {
          code: 2,
          contains: ['互斥', '--check'],
        });
      }),
  });

  // ⑨ 盘点模式（无开关）在夹具树上照常列出命中，且 exit 0
  cases.push({
    name: '⑨ 盘点模式（无开关）⇒ exit 0 并列出「文件数、命中数」',
    fn: () =>
      fixture({ 'src/pages/one.tsx': 'export const X = () => <div>保存</div>;\n' }, (dir) => {
        expectRun(run(['--root', dir], dir), {
          code: 0,
          contains: ['共 1 个文件、1 处'],
        });
      }),
  });

  let failed = 0;
  console.log(`i18n-scan selftest：临时夹具树 + 真子进程，逐条断言真实 exit code（${cases.length} 条用例）`);
  for (const c of cases) {
    try {
      c.fn();
      console.log(`  ✔ ${c.name}`);
    } catch (error) {
      failed += 1;
      console.error(`  ✘ ${c.name}`);
      for (const line of String(error?.message ?? error).split('\n')) console.error(`      ${line}`);
    }
  }

  if (failed > 0) {
    console.error(
      `\n✖ i18n-scan selftest 失败：${failed}/${cases.length} 条用例未按预期（判据被改宽了？别把断言改松）`,
    );
    return 1;
  }
  console.log(`\n✔ i18n-scan selftest 通过：${cases.length}/${cases.length} 条用例`);
  return 0;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.selftest) {
  process.exit(runSelftest());
}

const report = scanTree(opts.root, opts.file);

if (opts.check) {
  process.exit(checkReport(report, opts.root));
}

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const total = report.reduce((s, r) => s + r.count, 0);
  console.log(`共 ${report.length} 个文件、${total} 处疑似硬编码中文串\n`);
  for (const r of report) console.log(`${String(r.count).padStart(4)}  ${r.file}`);
}
