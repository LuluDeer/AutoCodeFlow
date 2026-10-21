#!/usr/bin/env node
/**
 * 恒定时间比较守卫：**凭据类值不得用 `===` / `==` 比较**。
 *
 * 由来：`R80` 的同族雷达显示「凭据比较（恒定时间）」跨 4 个 app / 12 个文件 —— 也就是说这条纪律
 * 被实现了至少四遍。抽查后当前**没有真实缺陷**（python 侧 `hmac.compare_digest` / `secrets.compare_digest`
 * 都在位；node 侧 `timingSafeEqual` 在位；命中的几处 `isSecret === true`、`token === null` 是布尔/空判，
 * 与凭据比较无关）。
 *
 * 但**没有任何东西阻止将来有人把某处退化成 `===`**：那种退化不会让任何测试变红（行为在功能上完全
 * 一致，只有时序不同），Code Review 也很难看出来。所以把它变成一条静态判据。
 *
 * 判据（刻意保守，只抓最典型的形态）：一行里出现 `===` 或 `==`，任一侧标识符**名字**含 token/secret/
 * password/hash/signature/apikey/credential，且另一侧不是字面量（null/true/false/undefined/''/数字）。
 * 该行含 `timingSafeEqual` / `compare_digest` 的一律放行。
 *
 * 用法：
 *   node scripts/check-constant-time-compare.mjs            # 守卫（CI）
 *   node scripts/check-constant-time-compare.mjs --report   # 列出全部命中（含豁免）
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules", ".venv", "dist", "dist-selftest", "build", "out", "coverage", ".git",
  "resources", "generated", "__snapshots__",
]);
const SKIP_FILE_RE = /\.(spec|test)\.(ts|tsx|js|mjs)$|_test\.py$|^test_.*\.py$|\.d\.ts$/;

/** 允许豁免的调用前标记（与 ADR-026 守卫同一惯例：标记 + 理由写在同一行或上一行）。 */
const EXEMPT_MARKER = "constant-time-exempt";

const SECRET_IDENT =
  /\b[A-Za-z_$][\w$]*(?:token|secret|password|passwd|hash|signature|apikey|api_key|credential)[\w$]*\b/i;
/** 字面量：与凭据比较无关。 */
const LITERAL_RHS =
  /^(?:null|true|false|undefined|void 0|0|-1|''|""|``|\d+)$/;
/** 一行里出现这些即视为已用恒定时间比较。 */
const SAFE_CALL = /timingSafeEqual|compare_digest|compareDigest|constantTimeEqual/;

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|js|mjs|py)$/.test(e.name) && !SKIP_FILE_RE.test(e.name)) {
      out.push(p);
    }
  }
}

/**
 * 一行是否构成「凭据用了普通比较」。刻意只处理**同一行内的单次比较**：跨行的表达式交给 review
 * —— 静态正则跨行会迅速变成噪声源。
 *
 * 豁免标记允许写在**本行或紧邻的上一行**（注释紧贴代码是更自然的写法；`ADR-026` 守卫用 5 行窗口，
 * 这里收紧到 3 行，因为本守卫的误报本来就靠「同一行」收敛过一轮）。
 */
function violationOnLine(line, prevLine, prevPrevLine) {
  if (SAFE_CALL.test(line)) return null;
  if (line.includes(EXEMPT_MARKER)) return null;
  if (prevLine && prevLine.includes(EXEMPT_MARKER)) return null;
  if (prevPrevLine && prevPrevLine.includes(EXEMPT_MARKER)) return null;
  const m = /([\w$.[\]]+)\s*(===|==)\s*([\w$.[\]]+)/.exec(line);
  if (!m) return null;
  const [, lhs, op, rhs] = m;
  if (LITERAL_RHS.test(rhs) || LITERAL_RHS.test(lhs)) return null;
  const secretSide = SECRET_IDENT.test(lhs) ? lhs : SECRET_IDENT.test(rhs) ? rhs : null;
  if (!secretSide) return null;
  // `x === y` 里若另一侧也明显是布尔命名（is* / has* / *Enabled），属配置位而非凭据。
  const other = secretSide === lhs ? rhs : lhs;
  if (/^(?:is|has|can|should)[A-Z_]/.test(other) || /[Ee]nabled$/.test(other)) return null;
  return { lhs, op, rhs, secretSide };
}

const files = [];
for (const root of ROOTS) walk(join(ROOT, root), files);

const hits = [];
for (const f of files) {
  const rel = relative(ROOT, f).split(sep).join("/");
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const v = violationOnLine(line, lines[i - 1] ?? "", lines[i - 2] ?? "");
    if (v) hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120), why: v.secretSide });
  });
}

const report = process.argv.includes("--report");
if (hits.length > 0) {
  console.error("");
  console.error("✖ 恒定时间比较：" + hits.length + " 处凭据类值用了 ===/==");
  for (const h of hits) {
    console.error("  " + h.file + ":" + h.line + "  (" + h.why + ")");
    console.error("      " + h.text);
  }
  console.error("");
  console.error("  修法：用 crypto.timingSafeEqual / hmac.compare_digest / secrets.compare_digest 比较，");
  console.error("  先把两侧归一成 Buffer/bytes（长度不同要显式处理成 false）。");
  console.error("  确有理由（例如与自己的旧值比较、非秘钥的标识符）时，在该行写 " + EXEMPT_MARKER + ": <理由>。");
  process.exit(1);
}

console.log(
  "✔ 恒定时间比较守卫通过：" + files.length + " 个文件里没有凭据类值与 ===/== 混用。",
);
