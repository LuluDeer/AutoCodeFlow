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
 * 两种运行模式：
 *   node scripts/i18n-scan.mjs            盘点：列出所有疑似硬编码中文串
 *   node scripts/i18n-scan.mjs --check    守卫：只报「不在基线里」的新增项
 *
 * 守卫模式配合 scripts/i18n-baseline.json 使用：基线内的存量（合法的标签
 * 映射 fallback、内部不变量错误信息等，见基线文件内注释）不算失败，**新增**
 * 才算。这样守卫能真正拦住"新页面又写死中文"，而不是一上来就红一片被关掉。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const SRC_ROOT = join(ROOT, 'src');
const BASELINE_PATH = join(ROOT, 'scripts', 'i18n-baseline.json');
const CJK = /[\u4e00-\u9fff]/;

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'locales' || entry === 'node_modules') continue;
      collect(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) acc.push(p);
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

const only = process.argv.indexOf('--file');
const targets = only !== -1 ? [resolve(SRC_ROOT, process.argv[only + 1])] : collect(SRC_ROOT);

const report = [];
for (const f of targets) {
  const hits = scanFile(f);
  if (hits.length) {
    report.push({
      file: relative(SRC_ROOT, f).replace(/\\/g, '/'),
      count: hits.length,
      hits: hits.sort((a, b) => a.line - b.line),
    });
  }
}
report.sort((a, b) => b.count - a.count);

if (process.argv.includes('--check')) {
  // ── 守卫模式 ───────────────────────────────────────────────────────────────
  // 基线里记录"已知且已接受"的存量串（按 文件 + 串内容 比对，不按行号——
  // 行号会随无关编辑漂移，用它做基线会导致每次改动都误报）。
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
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
    console.log(`✅ i18n 守卫通过：未发现新增硬编码中文界面串（基线内 ${acceptedTotal} 处已接受）。`);
    process.exit(0);
  }

  console.error(`❌ i18n 守卫失败：发现 ${violations.length} 处**新增**硬编码中文界面串。`);
  console.error('   英文界面下这些串不会随语言切换，会造成中英混排。');
  console.error('   修法：改用 t(\'key\')，并在 src/locales/zh.ts 与 en.ts 成对补词条。');
  console.error('   若确属有意保留（如不面向用户的内部错误信息），在 scripts/i18n-baseline.json');
  console.error('   的 accepted 里按 文件→串 追加，并在 PR 里说明理由。\n');
  for (const v of violations) {
    console.error(`   ${v.file}:${v.line}  [${v.kind}]  ${v.text}`);
  }
  process.exit(1);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const total = report.reduce((s, r) => s + r.count, 0);
  console.log(`共 ${report.length} 个文件、${total} 处疑似硬编码中文串\n`);
  for (const r of report) console.log(`${String(r.count).padStart(4)}  ${r.file}`);
}
