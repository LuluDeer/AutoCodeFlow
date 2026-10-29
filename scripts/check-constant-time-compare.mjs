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
 * 该行**代码面**含 `timingSafeEqual` / `compare_digest` / `compareDigest` / `constantTimeEqual` 的一律放行。
 *
 * ## T4（第 4 轮守卫自检审计）修掉的两处假绿
 *
 *   · **只认一行里的第一处比较**：旧实现用非 global 的 `.exec(line)`，于是
 *     `if (attempts === 3 && token === expected)` 只看到了 `attempts === 3`（右侧是数字 ⇒
 *     字面量 ⇒ 放行），后面那处真正的凭据比较**永远不被看见**。现在逐处扫描。
 *   · **注释里出现 SAFE 关键字即算安全**：旧实现 `if (SAFE_CALL.test(line)) return null` 是整行
 *     文本匹配，`// TODO: 用 timingSafeEqual 比较：token === expected` 这种**注释**会给整行开
 *     绿灯。现在 SAFE 关键字只看**剥掉行注释后的代码面**（`//` 在字符串里不算注释）。
 *     豁免标记 `constant-time-exempt` 仍按设计在注释里生效（它本来就是个注释标记）。
 *
 * 已知边界（如实写，未改）：
 *   · 只看**同一行内**的单次比较；跨行表达式交给 review（跨行正则很快变成噪声源）；
 *   · `.spec/.test` / `_test.py` 不扫（它们断言源码文本，会有 `timingSafeEqual` 之类字符串）；
 *   · `--report` 目前**不改变退出码**（恒为 1）—— 它只是历史参数，别在 CI 里依赖它的输出形态。
 *
 * 用法：
 *   node scripts/check-constant-time-compare.mjs            # 守卫（CI）
 *   node scripts/check-constant-time-compare.mjs --report   # 同上（列出全部命中）
 *   node scripts/check-constant-time-compare.mjs --selftest [--root <dir>]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

export const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set([
  "node_modules", ".venv", "dist", "dist-selftest", "build", "out", "coverage", ".git",
  "resources", "generated", "__snapshots__",
]);
const SKIP_FILE_RE = /\.(spec|test)\.(ts|tsx|js|mjs)$|_test\.py$|^test_.*\.py$|\.d\.ts$/;

/** 允许豁免的调用前标记（与 ADR-026 守卫同一惯例：标记 + 理由写在同一行或上一行）。 */
export const EXEMPT_MARKER = "constant-time-exempt";

const SECRET_IDENT =
  /\b[A-Za-z_$][\w$]*(?:token|secret|password|passwd|hash|signature|apikey|api_key|credential)[\w$]*\b/i;
/** 字面量：与凭据比较无关。 */
const LITERAL_RHS =
  /^(?:null|true|false|undefined|void 0|0|-1|''|""|``|\d+)$/;
/** 一行里出现这些即视为已用恒定时间比较（只在**代码面**上认，见 `violationsOnLine`）。 */
const SAFE_CALL = /timingSafeEqual|compare_digest|compareDigest|constantTimeEqual/;

/**
 * SCAN-FLOOR（2026-10-27 审计轮 #7）：扫描规模下界。
 * 0 个文件 → 0 处命中 → 永远绿——这是本仓反复踩过的"守卫假绿"形态：扫描根
 * 改名、glob 失效、忽略规则写反都会让分母归零，而输出仍是一句令人安心的 ✔。
 * 2026-10-29 实测 1020 个文件，取下界 900（≈88%）：正常增删不误伤，真正的"扫不到
 * 东西"立刻红。对照同族先例：check-ssrf-deny-parity.mjs 的「解析出 0 条即红」、
 * check-cron-leader-gate.mjs 的 MIN_EXPECTED。
 */
export const MIN_FILES = 900;

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
 * 剥掉行尾注释（`//` **在字符串/模板串里不算**注释）。
 *
 * 为什么需要它：`SAFE_CALL` 的旧判定是整行文本匹配，一句注释就能给整行开绿灯。
 * 方向刻意是「只剥注释」——被剥掉的注释里即便藏着真比较，也只是少报一处**注释行**，
 * 不会让代码行漏判。
 */
export function stripLineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/**
 * 一行里所有构成「凭据用了普通比较」的比较（**不再只看第一处**）。
 *
 * 刻意只处理**同一行内的**比较：跨行的表达式交给 review —— 静态正则跨行会迅速变成噪声源。
 * 豁免标记允许写在**本行或紧邻的上一行**（注释紧贴代码是更自然的写法；`ADR-026` 守卫用 5 行窗口，
 * 这里收紧到 3 行，因为本守卫的误报本来就靠「同一行」收敛过一轮）。
 */
export function violationsOnLine(line, prevLine = "", prevPrevLine = "") {
  if ([line, prevLine, prevPrevLine].some((l) => l && l.includes(EXEMPT_MARKER))) return [];
  // 安全调用只在代码面上认：注释里写一句 timingSafeEqual 不该给整行开绿灯。
  if (SAFE_CALL.test(stripLineComment(line))) return [];

  const out = [];
  const re = /([\w$.[\]]+)\s*(===|==)\s*([\w$.[\]]+)/g;
  for (const m of line.matchAll(re)) {
    const [, lhs, op, rhs] = m;
    if (LITERAL_RHS.test(rhs) || LITERAL_RHS.test(lhs)) continue;
    const secretSide = SECRET_IDENT.test(lhs) ? lhs : SECRET_IDENT.test(rhs) ? rhs : null;
    if (!secretSide) continue;
    // `x === y` 里若另一侧也明显是布尔命名（is* / has* / *Enabled），属配置位而非凭据。
    const other = secretSide === lhs ? rhs : lhs;
    if (/^(?:is|has|can|should)[A-Z_]/.test(other) || /[Ee]nabled$/.test(other)) continue;
    out.push({ lhs, op, rhs, secretSide });
  }
  return out;
}

/**
 * 判据本体。`root` 是仓库根（selftest 传 fixture 树）。
 * 返回 `{ errors, hits, files }`：errors = 分母/扫描面不可信，hits = 命中。
 */
export function check({ root = process.cwd() } = {}) {
  const errors = [];

  for (const r of SCAN_ROOTS) {
    if (!existsSync(join(root, r))) {
      errors.push(
        `扫描根 ${r}/ 不存在 —— 目录改名/换布局后本守卫会零命中，那是假绿不是干净。`,
      );
    }
  }

  const files = [];
  for (const r of SCAN_ROOTS) walk(join(root, r), files);

  if (files.length < MIN_FILES) {
    errors.push(
      `只扫到 ${files.length} 个文件（下界 ${MIN_FILES}）——分母塌了，不是代码变干净了。` +
        `检查扫描目标与忽略规则是否仍覆盖 ${SCAN_ROOTS.join(" / ")}。`,
    );
  }

  const hits = [];
  for (const f of files) {
    const rel = relative(root, f).split(sep).join("/");
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const v of violationsOnLine(line, lines[i - 1] ?? "", lines[i - 2] ?? "")) {
        hits.push({
          file: rel,
          line: i + 1,
          text: line.trim().slice(0, 120),
          why: v.secretSide,
        });
      }
    });
  }

  return { errors, hits, files: files.length };
}

// ── 自检（T4：全部跑真脚本子进程）─────────────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/**
 * fixture 必须过 `MIN_FILES`（900）下界，否则**每条**用例都会先撞分母红，
 * 分不清是哪个判据在生效。950 个小文件的生成实测 ~25ms，可以每棵树都造。
 */
const FIXTURE_FILES = 950;

function bigTree({ extra = {}, drop = [], apps = true, packages = true } = {}) {
  const files = {};
  if (apps) {
    for (let i = 0; i < FIXTURE_FILES - 1; i += 1) {
      files[`apps/fixture/src/mod${String(i).padStart(4, "0")}.ts`] = "export const value = 1;\n";
    }
  }
  if (packages) files["packages/fixture/src/index.ts"] = "export const ok = true;\n";
  Object.assign(files, extra);
  for (const d of drop) delete files[d];
  return files;
}

const hitFile = (body) => ({ "apps/fixture/src/credential.ts": body });

/**
 * 自检：9 条用例，全部 `spawn` 真脚本。
 *
 * 旧版**没有 selftest**：判据是一个模块级 IIFE，`process.exit(1)` 没人验证，上面那两处
 * 假绿（只认第一处比较 / 注释里的 SAFE 关键字）也从来没人反证过。
 */
export function selftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "constant-time-selftest-" });
        try {
          expectExit(runGuard(SELF, { args: ["--root", repo.dir] }), {
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

  subprocess("① 干净树（950 个文件）→ 绿且报出分母", bigTree(), {
    code: 0,
    contains: [`恒定时间比较守卫通过：${FIXTURE_FILES} 个文件里没有凭据类值`],
    absent: ["处凭据类值用了", "结构错误"],
  });

  subprocess(
    "② 凭据用 === 比较 → 红，点名文件:行 + 命中的那一侧",
    bigTree({
      extra: hitFile("export function f(accessToken, expectedToken) {\n  return accessToken === expectedToken;\n}\n"),
    }),
    {
      code: 1,
      contains: [
        "1 处凭据类值用了 ===/==",
        "apps/fixture/src/credential.ts:2",
        "(accessToken)",
        "accessToken === expectedToken",
      ],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "③ 豁免标记（上一行注释）→ 绿（既有语义，钉住别悄悄失效）",
    bigTree({
      extra: hitFile(
        "export function f(candidateSecret, storedSecret) {\n  // constant-time-exempt: 与迁移期旧值比较\n  return candidateSecret === storedSecret;\n}\n",
      ),
    }),
    { code: 0, contains: ["守卫通过"], absent: ["处凭据类值用了"] },
  );

  subprocess(
    "④ 真仓库的合法形态：长度判 + timingSafeEqual 同一行 → 绿",
    bigTree({
      extra: hitFile(
        "export function f(tokenBuf, validBuf) {\n  return tokenBuf.length === validBuf.length && timingSafeEqual(tokenBuf, validBuf);\n}\n",
      ),
    }),
    { code: 0, contains: ["守卫通过"], absent: ["处凭据类值用了"] },
  );

  // ⑤ 修掉的假绿：整行文本匹配 SAFE_CALL → 注释里写一句 timingSafeEqual 就给整行开绿灯
  subprocess(
    "⑤ 【反证·注释即安全】**同一行**注释里提到 timingSafeEqual，代码仍用 === → 红",
    bigTree({
      extra: hitFile(
        "export function f(accessToken, expectedToken) {\n  return accessToken === expectedToken; // TODO: 改成 timingSafeEqual 比较\n}\n",
      ),
    }),
    { code: 1, contains: ["处凭据类值用了", "accessToken === expectedToken"], absent: ["守卫通过"] },
  );

  // ⑥ 修掉的假绿：非 global 的 exec 只看到第一处比较（attempts === 3 是字面量，直接放行）
  subprocess(
    "⑥ 【反证·只认第一处】一行里第二处比较才是凭据 → 红",
    bigTree({
      extra: hitFile(
        "export function f(attempts, accessToken, expectedToken) {\n  if (attempts === 3 && accessToken === expectedToken) return true;\n  return false;\n}\n",
      ),
    }),
    { code: 1, contains: ["处凭据类值用了", "accessToken === expectedToken"], absent: ["守卫通过"] },
  );

  subprocess("⑦ 扫描面下界：只有 5 个文件（零命中不许全绿）→ 结构红", (() => {
    const files = { "apps/fixture/src/a.ts": "export const a = 1;\n" };
    for (let i = 1; i < 5; i += 1) files[`apps/fixture/src/b${i}.ts`] = "export const b = 1;\n";
    return files;
  })(), {
    code: 1,
    contains: ["结构错误", "只扫到 5 个文件", `下界 ${MIN_FILES}`],
    absent: ["守卫通过"],
  });

  subprocess("⑧ 目录改名（apps/ 与 packages/ 都不存在）→ 结构红", { "README.md": "# fixture\n" }, {
    code: 1,
    contains: ["结构错误", "扫描根 apps/ 不存在", "扫描根 packages/ 不存在"],
    absent: ["守卫通过"],
  });

  // ⑨ 既有边界：spec/test 文件不扫（它们会断言源码文本）。钉住，防「顺手放宽」式改动。
  subprocess(
    "⑨ 既有边界：*.spec.ts 里出现凭据 === 不判（测试文件不在扫描面）",
    bigTree({
      extra: { "apps/fixture/src/credential.spec.ts": "export const t = accessToken === expectedToken;\n" },
    }),
    { code: 0, contains: ["守卫通过"], absent: ["处凭据类值用了"] },
  );

  // ⑩ 【已知盲区】SECRET_IDENT 要求关键字前至少还有一个字符（`[A-Za-z_$][\w$]*` 打头），
  //    于是**裸** `token` / `secret` / `password` 标识符不被识别 —— 最典型的
  //    `token === expected` 反而漏判（2026-10-29 实测真仓库有 13 处同族形态，多数是真凭据
  //    比较）。修它需要同时给 app 侧加豁免/改造，超出 T4「只动 scripts/」的范围，故此处
  //    把盲区钉成显式契约：哪天谁修了判据，这条会转红，届时应改成「必须报」并删掉本注释。
  subprocess(
    "⑩ 【已知盲区】裸 `token` 标识符不在 SECRET_IDENT 内（`token === expected` 当前不报）",
    bigTree({ extra: hitFile("export function f(token, expected) {\n  return token === expected;\n}\n") }),
    { code: 0, contains: ["守卫通过"], absent: ["处凭据类值用了"] },
  );

  const failed = reportCases(cases, { title: "check-constant-time-compare selftest" });
  if (failed > 0) process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else {
    const root = resolve(argValue(process.argv, "--root") ?? process.cwd());
    const { errors, hits, files } = check({ root });

    if (errors.length > 0) {
      console.error("");
      console.error("✖ 恒定时间比较守卫结构错误（分母不可信）：");
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (hits.length > 0) {
      console.error("");
      console.error("✖ 恒定时间比较守卫：" + hits.length + " 处凭据类值用了 ===/==");
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
      "✔ 恒定时间比较守卫通过：" + files + " 个文件里没有凭据类值与 ===/== 混用。",
    );
  }
}
