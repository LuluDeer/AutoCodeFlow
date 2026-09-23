#!/usr/bin/env node
/**
 * Shell「变量名吞掉多字节字符」守卫（macOS bash 3.2 实证）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 * 2026-09-23 desktop-v1.6.0 补发（run 35864019734）实证：macOS job 的
 * `gh release upload` **已经成功上传全部 6 个资产**，紧接着却红着退出：
 *
 *     /Users/runner/work/_temp/….sh: line 28: count�: unbound variable
 *
 * 出事的行是（变量后面紧跟一个全角括号）：
 *
 *     echo "release 现有资产数 = $count（本 job 上传 ${#files[@]} 个）"
 *
 * 根因：`（` 是 U+FF08，UTF-8 编码 `EF BC 88`。macOS runner 的
 * `shell: bash` 走**系统 /bin/bash（3.2）**，且在非 UTF-8 locale 下，bash 3.2
 * 不把 0xEF 当作「标识符结束」，而是**把它并进变量名**——于是变量名成了
 * `count\xEF`，`set -u` 立刻判定 unbound 并中止整个 step。
 *
 * 危害形态特别阴险：**这一步是发布链路的最后一道校验**，它挂了以后
 * 「发布其实成功了」会被渲染成 job 红。同类问题若落在真正决定成败的位置
 * （例如把 `$count` 参与 `-lt` 比较），就是**假绿/假红**两种方向的误判。
 * 而且同一行在 ubuntu（bash 5.x + UTF-8 locale）**完全正常**，只在 macOS
 * 单点复现——最容易被当成"环境抖动"重跑糊过去。
 *
 * 修法一律是加花括号界定变量名边界：`$count（` → `${count}（`。
 * 花括号形态与裸形态在被多字节字符跟随的场景下**语义完全相同或更正确**，
 * 故该替换永远安全（本守卫的自动修复即为纯文本替换）。
 *
 * ── 判据 ──────────────────────────────────────────────────────────────
 * 扫描 `.github/workflows/*.yml` 与仓库内 `*.sh`，找出「裸 `$NAME` 紧跟
 * 一个非 ASCII 字符」的每一处。`${NAME}` 形态天然安全，不报。
 *
 * 用法：
 *   node scripts/check-shell-multibyte-var.mjs            # 校验
 *   node scripts/check-shell-multibyte-var.mjs --selftest # 自测（含反例，证明有牙）
 *   node scripts/check-shell-multibyte-var.mjs --fix      # 自动加花括号
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 裸 `$NAME` 紧跟一个非 ASCII 字符——bash 3.2 会把该字符的高字节并进变量名。 */
export const RISKY_RE = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/g;

/** 目录名一律不进入扫描（第三方/产物/版本库元数据）。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "out",
  ".workbuddy",
]);

export function findRepoRoot(startDir = HERE) {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, "package.json"), "utf-8");
      readdirSync(join(dir, ".github", "workflows"));
      return dir;
    } catch {
      /* 继续上溯 */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到仓库根（需同时存在 package.json 与 .github/workflows）");
}

/** 递归收集待扫描文件：.github/workflows/*.yml + 任意 *.sh。 */
export function collectTargets(root) {
  const out = [];
  const wfDir = join(root, ".github", "workflows");
  try {
    for (const name of readdirSync(wfDir)) {
      if (/\.ya?ml$/.test(name)) out.push(join(wfDir, name));
    }
  } catch {
    /* 无 workflows 目录则只扫 sh */
  }
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (e.isFile() && e.name.endsWith(".sh")) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

/** 返回 [{line, text, match}] —— 1-based 行号。 */
export function scanText(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    RISKY_RE.lastIndex = 0;
    let m;
    while ((m = RISKY_RE.exec(line)) !== null) {
      hits.push({ line: i + 1, text: line.trim(), match: m[0] });
    }
  }
  return hits;
}

/** 把 `$NAME` 改成 `${NAME}`（仅针对紧跟非 ASCII 的裸形态）。 */
export function applyFix(text) {
  return text.replace(
    /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])/g,
    (_all, name) => `\${${name}}`,
  );
}

function rel(root, p) {
  return relative(root, p).split(sep).join("/");
}

function runSelftest() {
  let pass = 0;
  const fails = [];
  const check = (name, cond) => (cond ? pass++ : fails.push(name));

  // 反证①：正是线上炸掉的那一行，必须被抓到。
  const real = 'echo "release 现有资产数 = $count（本 job 上传 ${#files[@]} 个）"';
  check("抓到线上真实肇事行", scanText(real).length === 1);

  // 反证②：修好之后必须不再报（否则守卫会永远红，等于没牙）。
  check("花括号形态不误报", scanText(applyFix(real)).length === 0);

  // 反证③：ASCII 紧跟不算问题（`$count,` / `$count"` / `$count）` 里的半角括号）。
  check("ASCII 跟随不误报", scanText('echo "$count, ok"').length === 0);
  check("半角括号不误报", scanText('echo "$count) x"').length === 0);

  // 反证④：`${NAME}` 本来就安全。
  check("已是花括号不误报", scanText('echo "${count}（x）"').length === 0);

  // 反证⑤：多个变量名形态都要覆盖（下划线/数字/大写）。
  check("下划线数字大写", scanText('echo "$A_1（x）"').length === 1);

  // 反证⑥：修复必须逐字节保留变量名（不能吃掉名字或改语义）。
  check("修复保留变量名", applyFix('x="$myVar（a）"') === 'x="${myVar}（a）"');
  check("修复不动已是花括号", applyFix('x="${myVar}（a）"') === 'x="${myVar}（a）"');
  check("修复不动 ASCII 场景", applyFix('echo "$count, ok"') === 'echo "$count, ok"');

  // 反证⑦：一行里出现两次也要全抓到（守卫不能只报第一处）。
  check("一行两处全抓到", scanText('echo "$a（x）$b（y）"').length === 2);

  if (fails.length) {
    console.error(`[check-shell-multibyte-var] selftest 失败 ${fails.length} 项：`);
    for (const f of fails) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`[check-shell-multibyte-var] selftest 通过（${pass} 项断言，含反证）`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) return runSelftest();

  const root = findRepoRoot();
  const targets = collectTargets(root);
  const doFix = argv.includes("--fix");

  let total = 0;
  const report = [];
  for (const file of targets) {
    let text;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const hits = scanText(text);
    if (!hits.length) continue;
    if (doFix) {
      writeFileSync(file, applyFix(text));
      report.push(`  fixed ${rel(root, file)}（${hits.length} 处）`);
    } else {
      for (const h of hits) {
        report.push(`  ${rel(root, file)}:${h.line}  ${h.match}  ←  ${h.text}`);
      }
    }
    total += hits.length;
  }

  if (doFix) {
    console.log(`[check-shell-multibyte-var] 自动修复 ${total} 处：`);
    for (const r of report) console.log(r);
    console.log("  请复查 diff 后重新提交。");
    return;
  }

  if (total) {
    console.error(
      `[check-shell-multibyte-var] 发现 ${total} 处「裸 $VAR 紧跟多字节字符」：`,
    );
    for (const r of report) console.error(r);
    console.error(
      "\n  macOS runner 的 /bin/bash 是 3.2，在非 UTF-8 locale 下会把该多字节字符的\n" +
        "  首字节并进变量名 → set -u 下 `VAR\\xEF: unbound variable` 直接中止 step。\n" +
        "  修法：给变量名加花括号（$count（ → ${count}（）。可跑 --fix 自动修。",
    );
    process.exit(1);
  }
  console.log(
    `[check-shell-multibyte-var] OK：${targets.length} 个文件（workflows + *.sh）无多字节变量名陷阱`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
