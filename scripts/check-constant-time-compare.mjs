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
 * 判据：一行里出现 `===` 或 `==`，任一侧标识符**名字**含 token/secret/password/passwd/hash/signature/
 * apikey(apiKey/api_key)/credential/hmac/digest（大小写与 snake_case 变体都算，**裸关键字本身也算**），
 * 且另一侧不是字面量（null/None/true/false/undefined/''/数字）。
 * 该行**代码面**含 `timingSafeEqual` / `compare_digest` / `compareDigest` / `constantTimeEqual` 的一律放行。
 * 确属非凭据的行用 `constant-time-exempt: <理由>` 豁免，**理由必填**（缺失即红，见 T5）。
 *
 * ## 什么时候**必须**恒定时间（这一句就是判据，别扩成「所有比较都要」）
 *
 * **一侧由攻击者可控、另一侧是服务端持有的秘密/摘要** ⇒ 必须恒定时间：`===`/`==` 在第一个不同的
 * 字节处提前返回，攻击者能逐位试出秘密（MAC/token/密码的经典时序预言机）。
 * 反之，两侧都是**同源值**——自己刚算出的内容哈希、两个自己持有的令牌做「变没变」检测、掩码哨兵
 * 常量（`'******'`）、文件清单缓存键、重试次数上界——**没有攻击者可控输入参与**，定时差异里没有
 * 秘密可泄，这是加 `constant-time-exempt: <理由>` 的正当场景，不是「我不想改」。豁免的措辞必须
 * 能回答一句话：**「如果攻击者量到这一行快了几个纳秒，他能学到什么秘密？」** 答不上来才叫非凭据。
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
 * ## T5（2026-10-29）修掉的第三处假绿：**裸关键字不识别**
 *
 * 旧 `SECRET_IDENT = /\b[A-Za-z_$][\w$]*(?:token|…)[\w$]*\b/i` 要求关键字前**至少还有一个字符**
 * （`[A-Za-z_$][\w$]*` 打头），于是**裸** `token` / `password` / `secret` 整词不被识别 ——
 * 最典型的 `token === expected`（真凭据比较）反而漏判，而 `accessToken === expected` 才报。
 * 现在改为 `\b\w*(?:…)\w*\b`：前缀可有可无，**裸关键字成立**，`accessToken` / `checkToken` 不变；
 * 词表同时补齐 `hmac` / `digest` / `credential` / `api_key`（原正则只写 `api_key`，`apiKey` 靠
 * `\b…[\w$]*\b` 才勉强命中，现在显式 `api_?key`）。
 *
 * 同轮把豁免从「有标记就放行」收紧为**理由必填**：`constant-time-exempt` 后必须跟 `:` 与非空理由
 * （≥4 个字符）。裸标记 / 空理由一律红并点名 —— 豁免是「这不是秘密」的**声明**，不是「我不想改」。
 * 标记写在本行或紧邻前两行都算（窗口不变）。
 *
 * 顺带补上 python 侧的同类假绿：`#` 注释此前从不剥，`if token == expected:  # TODO 改
 * compare_digest` 会因为注释里的 SAFE 关键字整行放行。现在按**文件类型**剥（`.py` 认 `#`；
 * TS/JS 不认，否则 `this.#token` 私有字段会把代码面截掉）。
 *
 * 放宽判据后在真仓（apps+packages，1020 文件）实测 **12 处**（旧判据下是 0 处）：
 *   · 5 处此前 R81 已写带理由豁免（sop 内容哈希 / 桌面缓存键 / `***` 导出掩码 / 两处对象身份哨兵），
 *     本轮逐条复核理由仍成立；
 *   · 7 处本轮补豁免：admin-api 掩码哨兵、admin-web 3 处 UI 掩码占位、admin-web 载荷掩码剥离、
 *     executor-node 重试次数上界、executor-python 401 自愈的**同源令牌变更检测**；
 *   · **0 处是真凭据比较** —— 真正的验凭据面（`verify_token`、`verifyExecutorToken`、webhook HMAC、
 *     execution-callback-token、metrics scraper、registry-pypi basic auth、executor-node shared token）
 *     早已全在 `compare_digest` / `timingSafeEqual` 上，本轮逐处核对过（见 T5 报告）。
 * 这条结论本身就是判据的价值：**放宽后依然没有一处「攻击者可控 vs 服务端秘密」用 `==`**。
 *
 * 已知边界（如实写，未改）：
 *   · 只看**同一行内**的单次比较；跨行表达式交给 review（跨行正则很快变成噪声源）；
 *   · 算子只认 `==` / `===`；`!=` / `!==` 未纳入。为什么：真仓 `!==` 面有 18 处同族命中，绝大多数
 *     是「这次拿到的 token 与手里的是否同一份」这类变更检测（`refreshToken !== refreshToken`），
 *     纳入只会逼出一批豁免、把判据稀释成噪声。真正的验凭据面（`verify_token` / `verifyExecutorToken`
 *     / webhook HMAC）早已是恒定时间实现。**这是算子边界，不是安全结论**：新写 `!=` 比较凭据一样该用
 *     恒定时间，review 仍要盯；
 *   · `.spec/.test` / `_test.py` 不扫（它们断言源码文本，会有 `timingSafeEqual` 之类字符串）；
 *   · `--report` 是**历史参数**：不改变判据、不影响退出码（绿 0 / 红 1），也别在 CI 里依赖它的
 *     输出形态。想列出全部命中，红的时候本来就会逐条打印。
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

/** 允许豁免的行级标记（与 ADR-026 守卫同一惯例：标记 + 理由写在同一行或紧邻上一行）。 */
export const EXEMPT_MARKER = "constant-time-exempt";

/**
 * 豁免**必须带理由**：`constant-time-exempt: <理由>`，理由 ≥ 4 个非空白字符。
 *
 * 为什么收紧（T5）：旧实现只认标记文本本身，于是 `// constant-time-exempt`（不带任何解释）
 * 就能静默关掉一处真凭据比较——豁免退化成「我不想改」的橡皮图章。豁免是**声明**（「这行比的
 * 不是秘密」），声明必须可被 review 反驳，所以理由必填、缺失即红。
 */
export const EXEMPT_RE = /constant-time-exempt\s*:\s*(\S[\s\S]*)$/;
export const MIN_REASON_CHARS = 4;

/**
 * 凭据类标识符判据（T5 放宽到**裸关键字**）。
 *
 * 旧写法 `\b[A-Za-z_$][\w$]*(?:token|…)[\w$]*\b` 要求关键字前至少还有一个字符 ⇒ 裸 `token`
 * 整词不匹配 ⇒ 最典型的 `token === expected` 漏判。现在 `\b\w*(?:…)\w*\b`：前缀零个或多个，
 * `accessToken` / `checkToken` / `EXECUTOR_TOKEN` / `token_hash` 与裸 `token` 一视同仁。
 * 词表补 `hmac` / `digest` / `credential`，`api_?key` 同时覆盖 `apiKey` / `api_key` / `APIKEY`。
 */
export const SECRET_WORDS =
  "token|secret|password|passwd|hash|signature|api_?key|credential|hmac|digest";
export const SECRET_IDENT = new RegExp(`\\b\\w*(?:${SECRET_WORDS})\\w*\\b`, "i");

/** 字面量：与凭据比较无关（`None` 是 python 侧的 null）。 */
const LITERAL_RHS =
  /^(?:null|None|true|false|undefined|void 0|0|-1|''|""|``|\d+)$/;
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
 *
 * `hashComments`（T5）：python 的行注释是 `#`。**必须按文件类型开启**——TS/JS 里 `#` 是
 * 私有字段前缀（`this.#token`），当成注释起点会把后半行代码面截掉，反而制造假绿。
 * 不开这个开关时旧行为逐字不变。
 */
export function stripLineComment(line, { hashComments = false } = {}) {
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
    if (hashComments && ch === "#") return line.slice(0, i);
  }
  return line;
}

/**
 * 校验一行里的豁免标记：`"none"`（没有标记）/ `"valid"`（有标记**且**有理由）/ `"no-reason"`。
 *
 * `no-reason` 必须红：裸 `constant-time-exempt` 是「我不想改」的橡皮图章，不是声明。
 * 注意判定只看**标记本身**，不看代码面 —— 否则 `// constant-time-exempt` 加在已经用
 * `timingSafeEqual` 的行上就会被当作合理，两件事混在一起判断。
 */
export function exemptStatus(line) {
  if (!line || !line.includes(EXEMPT_MARKER)) return "none";
  const m = line.match(EXEMPT_RE);
  if (!m) return "no-reason";
  return m[1].trim().length >= MIN_REASON_CHARS ? "valid" : "no-reason";
}

/** 本行或紧邻前两行里有**带理由**的豁免标记。 */
function exemptedNearby(line, prevLine, prevPrevLine) {
  return [line, prevLine, prevPrevLine].some((l) => exemptStatus(l) === "valid");
}

/**
 * 一行里所有构成「凭据用了普通比较」的比较（**不再只看第一处**）。
 *
 * 刻意只处理**同一行内的**比较：跨行的表达式交给 review —— 静态正则跨行会迅速变成噪声源。
 * 豁免标记允许写在**本行或紧邻的上一行**（注释紧贴代码是更自然的写法；`ADR-026` 守卫用 5 行窗口，
 * 这里收紧到 3 行，因为本守卫的误报本来就靠「同一行」收敛过一轮）。标记只在**带理由**时生效
 * （T5），裸标记由 `check()` 单独报红。
 *
 * `isPython`（T5）：python 用 `#` 起注释。不传就按 JS 口径（`//`）剥——见 `stripLineComment`
 * 为什么不能无条件剥 `#`。
 */
export function violationsOnLine(line, prevLine = "", prevPrevLine = "", { isPython = false } = {}) {
  if (exemptedNearby(line, prevLine, prevPrevLine)) return [];
  // 安全调用只在代码面上认：注释里写一句 timingSafeEqual 不该给整行开绿灯。
  if (SAFE_CALL.test(stripLineComment(line, { hashComments: isPython }))) return [];

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
 * 返回 `{ errors, hits, badExempts, files }`：errors = 分母/扫描面不可信，hits = 凭据用了 `==`，
 * badExempts = 没写理由的豁免（T5：豁免必须有理由）。
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
  const badExempts = [];
  for (const f of files) {
    const rel = relative(root, f).split(sep).join("/");
    const isPython = f.endsWith(".py");
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (exemptStatus(line) === "no-reason") {
        badExempts.push({ file: rel, line: i + 1, text: line.trim().slice(0, 120) });
      }
      for (const v of violationsOnLine(line, lines[i - 1] ?? "", lines[i - 2] ?? "", { isPython })) {
        hits.push({
          file: rel,
          line: i + 1,
          text: line.trim().slice(0, 120),
          why: v.secretSide,
        });
      }
    });
  }

  return { errors, hits, badExempts, files: files.length };
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
 * 自检：17 条用例，全部 `spawn` 真脚本。
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

  // ⑩ T5 修掉的假绿（原为「已知盲区」契约）：旧 SECRET_IDENT 要求关键字前至少还有一个字符
  //    （`[A-Za-z_$][\w$]*` 打头），于是**裸** `token` / `secret` / `password` 整词不被识别 ——
  //    最典型的 `token === expected` 反而漏判。放宽到 `\b\w*(?:…)\w*\b` 后这条必须报。
  subprocess(
    "⑩ 【反证·原盲区】裸 `token` 用 === 比较 → 红（旧判据这里是绿的）",
    bigTree({ extra: hitFile("export function f(token, expected) {\n  return token === expected;\n}\n") }),
    {
      code: 1,
      contains: [
        "1 处凭据类值用了 ===/==",
        "apps/fixture/src/credential.ts:2",
        "(token)",
        "token === expected",
      ],
      absent: ["守卫通过"],
    },
  );

  // ⑪ 变体全覆盖：裸 password / secret、snake_case（token_hash）、camelCase（apiKey）、
  //    新入词表的 hmac-digest / signature，以及 python 形态 `fresh == token`。
  subprocess(
    "⑪ 变体：裸 password/secret、snake_case、apiKey、digest、python `==` 全部要报",
    bigTree({
      extra: {
        "apps/fixture/src/credential.ts": [
          "export function f(password, expected, secret, other, apiKey, wanted) {",
          "  const a = password === expected;",
          "  const b = secret == other;",
          "  const c = apiKey === wanted;",
          "  return [a, b, c];",
          "}",
          "",
        ].join("\n"),
        "apps/fixture/src/digest.ts": [
          "export function g(signature, expectedSignature, digest, expectedDigest, tokenHash, knownHash) {",
          "  const a = signature === expectedSignature;",
          "  const b = digest === expectedDigest;",
          "  const c = tokenHash === knownHash;",
          "  return [a, b, c];",
          "}",
          "",
        ].join("\n"),
        "apps/fixture/src/credential.py": [
          "def heal(fresh, token):",
          "    if not fresh or fresh == token:",
          "        return False",
          "    return True",
          "",
        ].join("\n"),
      },
    }),
    {
      code: 1,
      contains: ["7 处凭据类值用了 ===/==", "apps/fixture/src/credential.py:2", "(token)"],
      absent: ["守卫通过"],
    },
  );

  // ⑫ 裸 token 也吃豁免：豁免是**行级声明**，与标识符怎么命名无关。
  subprocess(
    "⑫ 裸 `token` + 带理由豁免 → 绿",
    bigTree({
      extra: hitFile(
        "export function f(token, expected) {\n  // constant-time-exempt: 两个都是本地占位符不是凭据\n  return token === expected;\n}\n",
      ),
    }),
    { code: 0, contains: ["守卫通过"], absent: ["处凭据类值用了", "缺理由"] },
  );

  // ⑬/⑭ T5 新增判据：豁免**必须带理由**。裸标记与空理由都要红并点名 —— 否则
  //    `// constant-time-exempt` 就成了「我不想改」的橡皮图章。
  subprocess(
    "⑬ 【反证·豁免缺理由】只写 `constant-time-exempt`（无冒号无理由）→ 红并点名",
    bigTree({
      extra: hitFile(
        "export function f(token, expected) {\n  // constant-time-exempt\n  return token === expected;\n}\n",
      ),
    }),
    {
      code: 1,
      contains: ["1 处 constant-time-exempt 缺理由", "apps/fixture/src/credential.ts:2"],
      absent: ["守卫通过"],
    },
  );

  subprocess(
    "⑭ 【反证·豁免空理由】`constant-time-exempt:` 后面什么都没有 → 红并点名",
    bigTree({
      extra: hitFile(
        "export function f(token, expected) {\n  // constant-time-exempt:   \n  return token === expected;\n}\n",
      ),
    }),
    {
      code: 1,
      contains: ["1 处 constant-time-exempt 缺理由", "apps/fixture/src/credential.ts:2"],
      absent: ["守卫通过"],
    },
  );

  // ⑮ 改造后的合法形态：裸 token 走 timingSafeEqual（长度判 + 等长比较）→ 绿。
  //    这条同时是「把 auth.py:440 / updater-runcheck 那类比较改回恒定时间后守卫转绿」的反证。
  subprocess(
    "⑮ 裸 `token` 改成 timingSafeEqual（长度判 + 比较）→ 绿",
    bigTree({
      extra: hitFile(
        "export function f(token, expected) {\n  const a = Buffer.from(token);\n  const b = Buffer.from(expected);\n  return a.length === b.length && timingSafeEqual(a, b);\n}\n",
      ),
    }),
    { code: 0, contains: ["守卫通过"], absent: ["处凭据类值用了", "缺理由"] },
  );

  // ⑯ T5：python 的行注释是 `#`。不剥的话 `if token == expected:  # TODO 改 compare_digest`
  //    里的 SAFE 关键字会给整行开绿灯 —— 与 T4 修掉的 `//` 假绿是同一个洞，只是另一半扫描面。
  subprocess(
    "⑯ 【反证·python 注释即安全】`#` 注释里提到 compare_digest，代码仍用 `==` → 红",
    bigTree({
      extra: {
        "apps/fixture/src/credential.py": [
          "def f(token, expected):",
          "    if token == expected:  # TODO: 改成 hmac.compare_digest",
          "        return True",
          "    return False",
          "",
        ].join("\n"),
      },
    }),
    { code: 1, contains: ["1 处凭据类值用了 ===/==", "apps/fixture/src/credential.py:2"], absent: ["守卫通过"] },
  );

  // ⑰ `#` 只在 .py 里当注释：TS 的私有字段 `this.#token` 若被当注释起点，整行代码面会被截掉
  //    → 假绿。这条钉住「按文件类型开关」这个前提。
  subprocess(
    "⑰ 【反证·私有字段】TS 里 `this.#token === expected` 照旧要报（`#` 不当注释）",
    bigTree({
      extra: hitFile(
        "export function f(expected: string): boolean {\n  if (this.#token === expected) return true;\n  return false;\n}\n",
      ),
    }),
    { code: 1, contains: ["处凭据类值用了", "token === expected"], absent: ["守卫通过"] },
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
    const { errors, hits, badExempts, files } = check({ root });

    if (errors.length > 0) {
      console.error("");
      console.error("✖ 恒定时间比较守卫结构错误（分母不可信）：");
      for (const e of errors) console.error("  · " + e);
      console.error("");
      process.exit(1);
    }

    if (badExempts.length > 0) {
      console.error("");
      console.error("✖ 恒定时间比较守卫：" + badExempts.length + " 处 constant-time-exempt 缺理由");
      for (const h of badExempts) {
        console.error("  " + h.file + ":" + h.line);
        console.error("      " + h.text);
      }
      console.error("");
      console.error("  豁免是「这不是秘密」的声明，必须能被 review 反驳：写成");
      console.error("    " + EXEMPT_MARKER + ": <为什么这行比的不是凭据>（理由 ≥" + MIN_REASON_CHARS + " 字）。");
      console.error("  裸标记 / 空理由不算豁免 —— 那是「我不想改」。");
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
      console.error("  确有理由（例如与自己刚算出的哈希比较、非秘钥的标识符）时，在该行写 "
        + EXEMPT_MARKER + ": <理由>（理由必填）。");
      process.exit(1);
    }

    console.log(
      "✔ 恒定时间比较守卫通过：" + files + " 个文件里没有凭据类值与 ===/== 混用。",
    );
  }
}
