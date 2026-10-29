#!/usr/bin/env node
/**
 * 「守卫必须被跑到」的自检 —— 防「加了守卫，但没人跑它」。
 *
 * 由来：这个仓库现在有 40+ 个 `scripts/check-*.mjs`。加一个守卫很便宜，**接进
 * CI 才是让它生效的那一步**，而漏接是**完全静默**的：脚本存在、本地能跑、
 * README 里可能还写着它，但 CI 从不执行 —— 于是它保护不了任何东西。
 *
 * 三条判据（③ 为 2026-10-29 新增）：
 *
 *   ① CI 直接执行：守卫文件名出现在任一 `.github/workflows/*.yml` 的 `run:` 段里；
 *   ② CI 经 npm script 执行：文件名出现在 package.json 的某个 script 里，且**那个
 *      script 名**被某个 workflow 调用（CI 常写 `npm run check:xxx`，不写文件名）；
 *   ③ **自检被真的执行**：凡「有自检」的守卫，本地 `test:guards` 与 CI 都必须真的
 *      展开到这条自检的调用。①② 只说「脚本被跑」，对「它自称有自检、但自检永远
 *      不执行」完全盲 —— 2026-10-29 审计实测有 13 处这种长期存活且前后都绿。
 *
 * ## 判据 ③ 的三个概念（可复用、可审计）
 *
 * 「有自检」= 脚本源码里出现**字符串字面量** `--selftest`（`argv.includes("--selftest")`、
 * `a === "--selftest"` 形态；纯注释/纯文档里的 `--selftest` 不算，因为没加引号）
 * **或**存在伴生文件 `<stem>.selftest.mjs`（如 `scripts/docs/check-docs.mjs`）。
 *
 * 「本地跑自检」= 从 package.json 的 `test:guards` 出发，按 `&&` / `||` / `;` / 换行
 * 切分命令（`\` 续行先接上），递归展开 `npm run <name>`（深度上限 10 ≥ 判据要求的
 * 8，带环检测），收集所有 `node <file>` 调用；命中
 * `node <守卫本体> [args] --selftest` 或 `node <伴生 selftest 文件>` 即算跑。
 * **只展开 `npm run`**：`npm test` / `npm start` 这类别名不展开 —— 方向是「少匹配」，
 * 只会造成误红（有人把守卫挂进 `test` 脚本时会被要求显式接线），不会误绿。
 * 同理，`npm run <name> -- --selftest` 这种**参数透传**不跟随（透传到哪一条命令不可
 * 静态判定，跟错会误绿），需要真接自检时请把它写进 script 本体或直接写 `node … --selftest`。
 *
 * 「CI 跑自检」= 对每个 workflow：先剥 YAML 注释（整行 `#` 与行内 ` #`，含 block
 * scalar 内部），取出所有 `run:` 的值（行内标量与 `|` / `>` block scalar，按缩进
 * dedent），再同样递归展开 npm script 后收集调用。**只认 `run:`**：守卫若藏在
 * composite action / 外部 shell 脚本里，本闸看不见 —— 同样是误红方向，已在 CI
 * 里接线的东西不会被漏判成绿。`working-directory:` 也**不参与**路径解析（一律按
 * 仓库根解析）：今天没有任何 check-*.mjs 靠它调用，若将来有人这么挂，本闸会误红，
 * 而不是把「其实没跑」判成绿。
 *
 * ## 第 4 轮守卫审计修正的三处误绿（2026-10-29）
 *
 * 旧实现用 `workflows.includes(文件名)` 做纯子串匹配，两种形态会被判成「已接线」：
 *   ① **把 CI 步骤注释掉**：`#   node scripts/check-x.mjs` 仍然是子串命中 ——
 *      守卫实际从不运行，本闸却报绿（审计已用假根实证）。
 *   ② **脚本名前缀误配**：workflow 写 `npm run check:all`，而 package.json 里
 *      有个 `check` 脚本也调同一守卫时，`includes("npm run check")` 会命中
 *      `npm run check:all` —— 「只被别的 script 间接带跑」与「根本没接线」不可区分。
 * 现在：YAML 注释先剥掉；文件名匹配要求非脚本名字符边界；`npm run <name>`
 *   后必须是非脚本名字符（空白/行尾/引号/`&&`）。
 *
 * ③ 沿用同一套剥注释与边界规则，另外记住「同一文件既有主跑又有 `--selftest` 调用」
 *   必须**合并**而不是后写覆盖（原型实现曾因此把 `--selftest &&` 判成没有自检）。
 *
 * ## 例外（ALLOWLIST / SELFTEST_ALLOWLIST）与「豁免必须可证」
 *
 * ALLOWLIST 管判据①②（脚本要不要被 CI 跑），SELFTEST_ALLOWLIST 管判据③（自检要
 * 不要两面都跑）。两套分开是刻意的：一个守卫可以「CI 跑了主跑」却「自检没人跑」，
 * 合并成一张表就会让第二种情形被前一种豁免顺带盖掉。两套都守同一条纪律——
 * **豁免必须可证，且理由要与事实一致**：
 *
 *   · `report-only`（仅 ALLOWLIST）：不产生红绿判定，reason 必填；
 *   · `covered-elsewhere`：判据本体由别的收集面跑，`mustProve` 必须指向**仓库内
 *     真实存在**的文件（防止「理由是一句假设」）；
 *   · `one-side`（仅 SELFTEST_ALLOWLIST）：只接一面的自检。`sides` 里把一面标
 *     `wired`、另一面标 `exempt` 并给逐面理由。标 `wired` 的那一面是**声明**，
 *     本闸会做**事实核对**：实际没接线 → 结构红「理由与事实不符」（这就是
 *     「声称 CI 跑了，但 ci.yml 里其实没有」这种豁免腐烂的检测口）。
 *
 * 陈旧豁免（目录里已没有这个守卫 / 守卫根本没有自检）同样是结构红——豁免必须回收。
 * 唯一从宽的方向：某面标了 `exempt` 而它**其实已经接线**，只打 `⚠`（多跑一次自检
 * 不产生假绿，且并发改动常顺手把豁免变成多余），不判红。
 *
 * 用法：`node scripts/check-guards-wired.mjs [--selftest] [--root <dir>]`
 *   --selftest：**跑真脚本的子进程**，在临时假根里复现上述误绿/误红 + 判据③ 的
 *              六种形态 + 解析器细节 + 豁免校验（每条用例断言退出码与关键报错文本）。
 *   --root    ：只给 selftest 用：把 fixture 树当仓库根扫（默认 process.cwd()）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expectExit, makeFixtureRepo, reportCases, runGuard } from "./lib/guard-selftest.mjs";

/**
 * 判据①② 的豁免：只报告 / 由别的收集面覆盖的脚本。
 *
 * 每条必须声明 kind：
 *   · `report-only`：不产生红绿判定（只给人看的雷达），reason 必填；
 *   · `covered-elsewhere`：判据本体已被测试/其它 job 收集，`mustProve` 必须
 *     指向**仓库内真实存在**的文件（防止「理由是一句假设」）。
 */
export const ALLOWLIST = {
  "apps/admin-api/scripts/check-route-authz-matrix.mjs": {
    kind: "covered-elsewhere",
    reason:
      "判据本体 route-authz-matrix.spec.ts 已被 admin-api jest job（--shard）作为普通 spec 收集；本文件只是 CLI 外壳",
    mustProve:
      "apps/admin-api/src/common/guards/__tests__/route-authz-matrix.spec.ts",
  },
};

/**
 * 判据③ 的豁免：有自检、但**刻意**不是两面都跑。
 *
 * 两种 kind：
 *   · `covered-elsewhere`：自检本体由别的收集面跑（如 jest spec 已经收集同一份
 *     判据，再跑一遍 `--selftest` 只是重复），两面都不要求；`mustProve` 必填且
 *     文件必须存在。
 *   · `one-side`：只接一面。`sides` 必须恰好一面 `wired`、一面 `exempt`；
 *     `reason` 必填（为什么另一面不需要），可用 `reasons[side]` 逐面补充。
 *     `wired` 那面会被**事实核对**：实际没跑 → 结构红（理由与事实不符）。
 *
 * 本仓库当前只有一条：route-authz-matrix 的 `--selftest` 只是把 admin-api 的
 * jest spec 再跑一遍，本地零依赖门禁与 CI 的 admin-api 分片都已经收集了那份 spec。
 * `check-release-hygiene` / `check-npm-audit-exemptions` 不需要豁免：它们的**主跑**
 * 要网络/Token，但**自检**是离线 fixture，两面都已真的接线（见 package.json 的
 * `check:release-hygiene:selftest` / `check:npm-audit:selftest` 与 ci.yml 的对应 step）。
 */
export const SELFTEST_ALLOWLIST = {
  "apps/admin-api/scripts/check-route-authz-matrix.mjs": {
    kind: "covered-elsewhere",
    reason:
      "该守卫的 --selftest 只是把 route-authz-matrix.spec.ts 再跑一遍；同一份 spec 已由 admin-api jest job（--shard=*）作为普通 spec 收集，本地 test:guards 也刻意不引入 apps/admin-api 的依赖",
    mustProve:
      "apps/admin-api/src/common/guards/__tests__/route-authz-matrix.spec.ts",
  },
};

const MIN_GUARD_COUNT = 20;

/** 判据③ 的本地起点：本地门禁总入口。 */
const LOCAL_GATE = "test:guards";

/** npm script 递归展开深度上限（判据要求 ≥8；16 级链路在本仓库不存在，留足余量）。 */
const MAX_SCRIPT_DEPTH = 10;

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
      if (e.name === "node_modules" || e.name === ".venv") continue;
      walk(p, out);
    } else if (
      /^check-.*\.mjs$/.test(e.name) &&
      !/\.selftest\.mjs$/.test(e.name)
    ) {
      out.push(p);
    }
  }
}

/** 收集 root 下的守卫脚本（根 scripts/ + apps/<pkg>/scripts + packages/<pkg>/scripts）。 */
export function scanGuards(root) {
  const guards = [];
  walk(join(root, "scripts"), guards);
  for (const group of ["apps", "packages"]) {
    let children = [];
    try {
      children = readdirSync(join(root, group), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const child of children) {
      walk(join(root, group, child, "scripts"), guards);
    }
  }
  return guards;
}

/**
 * 剥掉 YAML 注释（整行 + 行内 ` #…`）。
 *
 * 目标只有一个：**注释掉的 CI 步骤不能算接线**。行内剥离可能切掉引号里的 `#`
 * 之后内容，方向是「少匹配」——只会造成误红，不会造成误绿。block scalar 内部的
 * `#` 本是字面量，同样被剥掉，方向一致。
 */
export function stripYamlComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

export function readWorkflows(root) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

/**
 * 取出一个 workflow 里所有 `run:` 命令文本。
 *
 * 支持三种写法：`- run: node x`（行内）、`run: |` / `run: >-`（block scalar）、
 * `run: "node x"`（带引号的行内）。block scalar 按首行缩进 dedent，保留相对缩进
 * （shell 的 `if` / 续行都靠它）。注释在进入本函数前已被剥离。
 */
export function extractRunBlocks(yamlText) {
  const lines = stripYamlComments(String(yamlText ?? "")).split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const keyIndent = match[1].length;
    const inline = match[2].trim();
    if (/^[|>][-+]?\d*$/.test(inline)) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.trim() === "") {
          body.push("");
          continue;
        }
        if (line.length - line.trimStart().length <= keyIndent) break;
        body.push(line);
      }
      i = j - 1;
      const nonEmpty = body.filter((line) => line.trim() !== "");
      const minIndent = nonEmpty.length
        ? Math.min(...nonEmpty.map((line) => line.length - line.trimStart().length))
        : 0;
      blocks.push(
        body.map((line) => (line.trim() === "" ? "" : line.slice(minIndent))).join("\n"),
      );
    } else {
      blocks.push(inline.replace(/^["']|["']$/g, ""));
    }
  }
  return blocks;
}

/** 按 `&&` / `||` / `;` / 换行切命令；`\` 续行先接上（否则 `--selftest` 会落单）。 */
export function splitCommand(text) {
  return String(text ?? "")
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n|&&|\|\||;/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 递归展开 npm script：输入若干命令文本，返回**全部**命令文本（含输入本身）。
 *
 * 只认 `npm|pnpm|yarn run <name>`（`npm test` 别名不展开，见文件头）。环检测按
 * script 名，深度超过 `maxDepth` 即停——两者都让「自引用 / 互相引用」的
 * package.json 不至于把 selftest 卡死。
 */
export function expandNpmScripts(texts, scripts, { maxDepth = MAX_SCRIPT_DEPTH } = {}) {
  const out = [];
  const visited = new Set();
  const queue = (Array.isArray(texts) ? texts : [texts]).map((text) => ({
    text: String(text ?? ""),
    depth: 0,
  }));
  while (queue.length > 0) {
    const { text, depth } = queue.shift();
    out.push(text);
    if (depth >= maxDepth) continue;
    for (const segment of splitCommand(text)) {
      const re = /(?:npm|pnpm|yarn)\s+run\s+([A-Za-z0-9:@._/-]+)/g;
      let match;
      while ((match = re.exec(segment)) !== null) {
        const name = match[1].replace(/[.,]+$/, "");
        if (visited.has(name)) continue;
        const command = scripts[name];
        if (typeof command !== "string") continue;
        visited.add(name);
        queue.push({ text: command, depth: depth + 1 });
      }
    }
  }
  return out;
}

/** 命令里 `node <script>` 的路径归一：去引号、去 `$GITHUB_WORKSPACE`/`$PWD` 前缀。 */
function normalizeScriptToken(token) {
  return String(token)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^\$\{?GITHUB_WORKSPACE\}?\/?/, "")
    .replace(/^\$\{?(?:PWD|CI_PROJECT_DIR)\}?\/?/, "")
    .replace(/^\.\//, "");
}

/**
 * 从命令文本里收集 `node <file> [args]` 调用。
 *
 * 返回 Map<绝对路径, { selftest, invocations }>。同一文件被调用多次时**合并**
 * `selftest`（`--selftest && 主跑` 是仓库标准写法，后一次主跑不能把前一次的自检
 * 覆盖掉 —— 本脚本的原型实现就在这儿出过 bug）。
 */
export function collectInvocations(text, root) {
  const map = new Map();
  const source = String(text ?? "").replace(/\\\r?\n/g, " ");
  const invokeRe =
    /(?:^|[\s;&|(`])(?:node|tsx)\s+((?:--?[^\s]+|-[A-Za-z])\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|()]+))([^\n;&|]*)/g;
  for (const line of source.split(/\r?\n/)) {
    invokeRe.lastIndex = 0;
    let match;
    while ((match = invokeRe.exec(line)) !== null) {
      const file = normalizeScriptToken(match[2] ?? match[3] ?? match[4] ?? "");
      const args = match[5] ?? "";
      if (!/\.(?:mjs|cjs|js)$/i.test(file)) continue;
      const abs = resolve(root, file);
      const selftest = /(?:^|\s)--selftest(?:\s|$)/.test(args);
      const prev = map.get(abs);
      map.set(abs, {
        selftest: selftest || Boolean(prev?.selftest),
        invocations: (prev?.invocations ?? 0) + 1,
      });
    }
  }
  return map;
}

/**
 * 判断一个守卫有没有自检。
 *
 * `viaFlag` 要求**字符串字面量**（`"`/`'`/`` ` `` 包住 `--selftest`）：注释或
 * 文档里裸写的 `--selftest` 不算实现，否则「文档写了但没实现」会被要求接线。
 */
export function detectSelftest(abs) {
  const source = readFileSync(abs, "utf8");
  const viaFlag = /["'`]--selftest["'`]/.test(source);
  const companionAbs = abs.endsWith(".mjs") ? abs.replace(/\.mjs$/, ".selftest.mjs") : null;
  const hasCompanion = companionAbs !== null && existsSync(companionAbs);
  return {
    has: viaFlag || hasCompanion,
    viaFlag,
    companionAbs: hasCompanion ? companionAbs : null,
  };
}

const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const relOf = (root, abs) => abs.slice(root.length + 1).split("\\").join("/");

/** 本地（test:guards 展开）与 CI（所有 workflow 的 run: 展开）两侧的自检调用面。 */
function collectSelftestSurfaces(root, scripts) {
  const local = { invocations: new Map(), expanded: [] };
  if (typeof scripts[LOCAL_GATE] === "string") {
    local.expanded = expandNpmScripts([scripts[LOCAL_GATE]], scripts);
    local.invocations = collectInvocations(local.expanded.join("\n"), root);
  }

  const ci = { invocations: new Map(), files: [] };
  const dir = join(root, ".github", "workflows");
  let names = [];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const blocks = extractRunBlocks(readFileSync(join(dir, name), "utf8"));
    const expanded = expandNpmScripts(blocks, scripts);
    const invocations = collectInvocations(expanded.join("\n"), root);
    ci.files.push({ name, blocks: blocks.length, invocations });
    for (const [abs, rec] of invocations) {
      const prev = ci.invocations.get(abs);
      ci.invocations.set(abs, {
        selftest: rec.selftest || Boolean(prev?.selftest),
        invocations: rec.invocations + (prev?.invocations ?? 0),
        workflows: new Set([...(prev?.workflows ?? []), name]),
      });
    }
  }
  return { local, ci };
}

/**
 * 校验一条判据③ 豁免，返回「被豁免的侧」数组；不合法返回 null（错误已入 errors）。
 *
 * 可证性检查：
 *   · 缺 reason → 红；
 *   · covered-elsewhere 缺 mustProve / mustProve 文件不存在 → 红；
 *   · one-side 的 sides 不是「恰好一面 wired + 一面 exempt」→ 红；
 *   · one-side 标 `wired` 的那面**事实核对**失败 → 红（理由与事实不符）；
 *   · 标 `exempt` 的那面其实已经接线 → 只告警（方向安全，见文件头）。
 */
function validateSelftestExemption({ rel, entry, fact, root, errors, warnings }) {
  const tag = `自检豁免（${rel}）`;
  const reasons = entry?.reasons ?? {};

  if (!entry || typeof entry !== "object") {
    errors.push(`${tag}格式非法（必须是对象）。`);
    return null;
  }
  if (!entry.reason || String(entry.reason).trim().length === 0) {
    errors.push(`${tag}缺理由 reason —— 豁免必须说明「为什么这一面不需要自检」。`);
  }

  if (entry.kind === "covered-elsewhere") {
    const proofs = toArray(entry.mustProve);
    if (proofs.length === 0) {
      errors.push(`${tag}（covered-elsewhere）必须给 mustProve（判据本体的真实文件路径）。`);
    }
    for (const proof of proofs) {
      if (!existsSync(join(root, String(proof)))) {
        errors.push(`自检豁免的 mustProve 文件不存在：${rel} → ${proof}（理由已过期，请重核或撤除豁免）`);
      }
    }
    for (const side of ["local", "ci"]) {
      if (fact[side].selftest) {
        warnings.push(`${rel} 的 ${sideName(side)} 面其实已经在跑自检了（covered-elsewhere 豁免已多余，可撤除）。`);
      }
    }
    return ["local", "ci"];
  }

  if (entry.kind !== "one-side") {
    errors.push(`${tag}的 kind 非法（只能是 covered-elsewhere / one-side）：${entry.kind}`);
    return null;
  }

  const sides = entry.sides ?? {};
  const values = ["local", "ci"].map((side) => sides[side]);
  const valid = values.every((v) => v === "wired" || v === "exempt");
  if (!valid || values.filter((v) => v === "wired").length !== 1) {
    errors.push(
      `${tag}（one-side）的 sides 必须恰好一面 wired、一面 exempt，收到 ${JSON.stringify(sides)}。`,
    );
    return null;
  }

  let invalid = false;
  const exemptSides = [];
  for (const side of ["local", "ci"]) {
    if (sides[side] === "wired") {
      if (!fact[side].selftest) {
        errors.push(
          `自检豁免的理由与事实不符：${rel} 声明 ${sideName(side)} 面已执行自检，实际没有（该豁免不能成立，先接线或改成 covered-elsewhere）。`,
        );
        invalid = true;
      }
    } else {
      exemptSides.push(side);
      const sideReason = reasons[side];
      if (reasons[side] !== undefined && String(sideReason).trim().length === 0) {
        errors.push(`${tag}（one-side）的 ${sideName(side)} 面理由为空。`);
      }
      if (fact[side].selftest) {
        warnings.push(
          `${rel} 的 ${sideName(side)} 面其实已经在跑自检了（one-side 豁免已过期，请撤除或改成两面都接）。`,
        );
      }
    }
  }
  return invalid ? null : exemptSides;
}

const sideName = (side) => (side === "local" ? "本地（test:guards）" : "CI（workflows）");

/** 找 package.json 里包装了这个守卫的 script 名（按文件名边界，避免 check-x 命中 check-x2）。 */
function findWrappers(scripts, base) {
  const re = new RegExp(escapeRe(base) + "(?![\\w.])");
  return Object.entries(scripts)
    .filter(([, cmd]) => re.test(String(cmd)))
    .map(([name]) => name);
}

/**
 * 判据：返回 { problems, selftestProblems, errors, warnings, counts, facts }。
 *
 * problems = 「守卫存在但没接线」；selftestProblems = 「有自检但自检没被跑」；
 * errors = 结构性问题（扫描面失效、豁免不合法）。
 */
export function checkGuardsWired({
  root,
  allowlist = ALLOWLIST,
  selftestAllowlist = SELFTEST_ALLOWLIST,
} = {}) {
  const problems = [];
  const selftestProblems = [];
  const errors = [];
  const warnings = [];

  const guards = scanGuards(root);
  if (guards.length === 0) {
    errors.push("一个守卫脚本都没扫到 —— 路径或正则失效了。");
    return {
      problems,
      selftestProblems,
      errors,
      warnings,
      counts: { guards: 0, allowlisted: 0, withSelftest: 0, selftestAllowlisted: 0 },
      facts: [],
    };
  }
  if (guards.length < MIN_GUARD_COUNT) {
    errors.push(
      `只扫到 ${guards.length} 个守卫 —— 明显少于历史规模（${MIN_GUARD_COUNT}+），扫描面可能失效。`,
    );
  }

  const workflows = stripYamlComments(readWorkflows(root));
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    errors.push("package.json 不可读 —— 无法解析 npm script 间接接线。");
  }
  const scripts = pkg.scripts ?? {};

  if (typeof scripts[LOCAL_GATE] !== "string") {
    errors.push(
      `package.json 里没有 ${LOCAL_GATE} 脚本 —— 判据③ 的本地起点失效（自检面会全盲）。`,
    );
  }

  const { local, ci } = collectSelftestSurfaces(root, scripts);

  const seenAllow = new Set();
  const seenSelftestAllow = new Set();
  const facts = [];

  for (const abs of guards) {
    const rel = relOf(root, abs);
    const base = rel.split("/").pop();

    // ── 判据①②：CI 有没有跑到这个脚本 ────────────────────────────────
    let wiringExempt = false;
    if (allowlist[rel]) {
      seenAllow.add(rel);
      wiringExempt = true;
      const entry = allowlist[rel];
      if (!entry.reason || entry.reason.trim().length === 0) {
        errors.push(`豁免缺理由：${rel}`);
      }
      if (entry.kind === "covered-elsewhere") {
        if (!entry.mustProve) {
          errors.push(`豁免（covered-elsewhere）必须给 mustProve：${rel}`);
        } else if (!existsSync(join(root, entry.mustProve))) {
          errors.push(
            `豁免的 mustProve 文件不存在：${rel} → ${entry.mustProve}（理由已过期，请重核或撤除豁免）`,
          );
        }
      } else if (entry.kind !== "report-only") {
        errors.push(`豁免 kind 非法（只能是 report-only / covered-elsewhere）：${rel}`);
      }
    }

    if (!wiringExempt) {
      // ① 直接出现文件名；要求边界不是脚本名字符（避免 check-x 命中 check-x2）。
      const directRe = new RegExp(escapeRe(base) + "(?![\\w.])");
      const directHit = directRe.test(workflows);

      // ② 经 npm script 间接接线；`npm run <name>` 后必须是非脚本名字符。
      const invoking = Object.entries(scripts).filter(([, cmd]) =>
        String(cmd).includes(base),
      );
      const wiredViaNpm = invoking.some(([name]) =>
        new RegExp("npm run " + escapeRe(name) + "(?![\\w:-])").test(workflows),
      );

      if (!directHit && !wiredViaNpm) {
        problems.push({ rel, invoking: invoking.map(([n]) => n) });
      }
    }

    // ── 判据③：有自检的，自检必须真的被跑（本地 + CI）─────────────────
    const info = detectSelftest(abs);
    if (!info.has) {
      facts.push({ rel, hasSelftest: false });
      continue;
    }

    const localRec = local.invocations.get(abs);
    const ciRec = ci.invocations.get(abs);
    const companionRel = info.companionAbs ? relOf(root, info.companionAbs) : null;
    const fact = {
      rel,
      hasSelftest: true,
      companionRel,
      local: {
        main: Boolean(localRec),
        selftest: Boolean(localRec?.selftest) ||
          (info.companionAbs ? local.invocations.has(info.companionAbs) : false),
      },
      ci: {
        main: Boolean(ciRec),
        selftest: Boolean(ciRec?.selftest) ||
          (info.companionAbs ? ci.invocations.has(info.companionAbs) : false),
        workflows: [...(ciRec?.workflows ?? [])],
      },
    };
    facts.push(fact);

    const exemption = selftestAllowlist[rel];
    if (exemption) {
      seenSelftestAllow.add(rel);
      const exemptSides = validateSelftestExemption({
        rel,
        entry: exemption,
        fact,
        root,
        errors,
        warnings,
      });
      if (exemptSides === null) continue;
      const missing = ["local", "ci"].filter(
        (side) => !exemptSides.includes(side) && !fact[side].selftest,
      );
      if (missing.length > 0) {
        selftestProblems.push({
          rel,
          fact,
          missing,
          wrappers: findWrappers(scripts, base),
          scripts,
        });
      }
      continue;
    }

    const missing = ["local", "ci"].filter((side) => !fact[side].selftest);
    if (missing.length > 0) {
      selftestProblems.push({
        rel,
        fact,
        missing,
        wrappers: findWrappers(scripts, base),
        scripts,
      });
    }
  }

  for (const rel of Object.keys(allowlist)) {
    if (!seenAllow.has(rel)) {
      errors.push(`陈旧豁免（目录里已没有这个守卫）：${rel} —— 豁免必须回收`);
    }
  }

  for (const [rel, entry] of Object.entries(selftestAllowlist)) {
    if (!seenSelftestAllow.has(rel)) {
      const exists = existsSync(join(root, rel));
      errors.push(
        exists
          ? `陈旧自检豁免（该守卫没有自检，豁免无意义）：${rel} —— 豁免必须回收`
          : `陈旧自检豁免（目录里已没有这个守卫）：${rel} —— 豁免必须回收`,
      );
    }
  }

  const withSelftest = facts.filter((f) => f.hasSelftest).length;
  const oneSide = Object.values(selftestAllowlist).filter((e) => e?.kind === "one-side").length;

  return {
    problems,
    selftestProblems,
    errors,
    warnings,
    counts: {
      guards: guards.length,
      allowlisted: seenAllow.size,
      withSelftest,
      selftestAllowlisted: seenSelftestAllow.size,
      oneSide,
    },
    facts,
  };
}

function argValue(argv, flag) {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const at = argv.indexOf(flag);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return null;
}

/** 判据③ 的「该补哪一行」建议。 */
function selftestFix({ rel, fact, wrappers, scripts, side }) {
  const companionRel = fact.companionRel;
  const selftestWrappers = wrappers.filter((name) => {
    const cmd = String(scripts[name] ?? "");
    if (/:selftest$/.test(name)) return true;
    if (/(?:^|\s)--selftest(?:\s|$)/.test(cmd)) return true;
    return companionRel ? cmd.includes(companionRel.split("/").pop()) : false;
  });
  const mainWrappers = wrappers.filter((name) => !selftestWrappers.includes(name));
  const command = companionRel ? `node ${companionRel}` : `node ${rel} --selftest`;

  if (side === "local") {
    if (selftestWrappers.length > 0) {
      return `在 test:guards:repo 里加一行 \`npm run ${selftestWrappers[0]}\`（该 script 已执行自检）。`;
    }
    if (mainWrappers.length > 0) {
      const name = mainWrappers[0];
      const next = companionRel
        ? `${command} && node ${rel}`
        : `node ${rel} --selftest && node ${rel}`;
      return `把 package.json 的 "${name}" 改成 "${next}"（旧调用点只会变强，不会变红）；或在 test:guards:repo 里加 \`${command}\`。`;
    }
    const slug = rel.split("/").pop().replace(/^check-/, "").replace(/\.mjs$/, "");
    const name = `check:${slug}:selftest`;
    return `在 package.json 加 "${name}": "${command}"，并在 test:guards:repo 里加 \`npm run ${name}\`。`;
  }

  if (selftestWrappers.length > 0) {
    return `在 .github/workflows/ci.yml 的守卫 job 里加一行 \`- run: npm run ${selftestWrappers[0]}\`。`;
  }
  if (mainWrappers.length > 0) {
    return `在 .github/workflows/ci.yml 的守卫 job 里加一行 \`- run: ${command}\`（或把 "${mainWrappers[0]}" 改成自带 --selftest 后接 \`npm run ${mainWrappers[0]}\`）。`;
  }
  return `在 .github/workflows/ci.yml 的守卫 job 里加一行 \`- run: ${command}\`。`;
}

function printSelftestProblems({ selftestProblems, warns }) {
  console.error("");
  console.error(
    `✖ ${selftestProblems.length} 个守卫有自检、但自检没有被真正执行（有自检 ≠ 自检被跑）：`,
  );
  for (const p of selftestProblems) {
    console.error("  · " + p.rel);
    for (const side of p.missing) {
      console.error(`    缺${side === "local" ? "本地面" : " CI 面"}：${sideHint(p, side)}`);
      const where = side === "ci" && p.fact.ci.workflows.length > 0
        ? `（${p.fact.ci.workflows.join("、")}）`
        : "";
      console.error(
        `      现状：${p.fact[side].main ? `${sideName(side)}只跑了主跑，没有带 --selftest${where}` : `${sideName(side)}完全没跑到这个脚本`}`,
      );
      console.error(`      该补的一行：${selftestFix({ ...p, side })}`);
    }
  }
  console.error("");
  console.error("  修法通则：① 主跑与自检合并进同一条 npm script（`node <guard> --selftest && node <guard>`），");
  console.error("            然后本地与 CI 只接那个 script；② 或给自检单独建 `check:<name>:selftest`，");
  console.error("            同时挂进 test:guards:repo 与 ci.yml。");
  console.error(
    "  若某面本来就跑在别处（判据本体是 jest spec / 需要 apps 依赖 / 需要网络），在 SELFTEST_ALLOWLIST 里",
  );
  console.error(
    "  声明 covered-elsewhere（必须给 mustProve 文件）或 one-side（必须给 sides + 逐面理由）；",
  );
  console.error("  声称「另一面已经跑了」会被事实核对 —— 实际没跑就是结构错误。");
  if (warns.length > 0) {
    console.error("");
    console.error("  ⚠ 提示（不判红，方向安全）：");
    for (const w of warns) console.error("    · " + w);
  }
}

const sideHint = (p, side) =>
  side === "local"
    ? `从 ${LOCAL_GATE} 递归展开，没有执行到这条自检`
    : "所有 .github/workflows/*.yml 的 run: 展开后都没有执行到这条自检";

/**
 * `--root` 是 selftest 专用参数：ALLOWLIST / SELFTEST_ALLOWLIST 里写的是**本仓库**
 * 的路径，套到临时树上只会被当成「陈旧豁免」而全线报错，所以显式给 `--root` 时按
 * 空豁免跑。方向是**变严**（豁免少了只可能多报问题，不可能漏报）；扫真实仓库请
 * 不带 `--root`。
 */
function runCli(root, { allowlist = ALLOWLIST, selftestAllowlist = SELFTEST_ALLOWLIST } = {}) {
  const { problems, selftestProblems, errors, warnings, counts } = checkGuardsWired({
    root,
    allowlist,
    selftestAllowlist,
  });

  if (errors.length > 0) {
    console.error("");
    console.error("✖ 守卫接线自检结构错误：");
    for (const e of errors) console.error("  · " + e);
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error("");
    console.error(`✖ ${problems.length} 个守卫**没有被任何 CI workflow 执行**：`);
    for (const p of problems) {
      console.error("  · " + p.rel);
      if (p.invoking.length > 0) {
        console.error(
          "    （package.json 里有 " +
            p.invoking.join(", ") +
            "，但 workflow 没调用它）",
        );
      } else {
        console.error("    （package.json 里也没有脚本包装它）");
      }
    }
    console.error("");
    console.error(
      "  修法：把它接进 .github/workflows/ci.yml（直接 node scripts/… 或 npm run check:…）。",
    );
    console.error(
      "  若它本就只报告、不该产生红绿判定，加进本脚本的 ALLOWLIST 并写明理由。",
    );
  }

  if (selftestProblems.length > 0) {
    printSelftestProblems({ selftestProblems, warns: warnings });
  }

  if (problems.length > 0 || selftestProblems.length > 0) {
    process.exit(1);
  }

  console.log(
    `✔ 守卫接线自检通过：${counts.guards - counts.allowlisted} 个 check-*.mjs 全部被 CI 执行` +
      `（另有 ${counts.allowlisted} 个显式豁免）。`,
  );
  console.log(
    `✔ 自检面：${counts.withSelftest} 个守卫有自检，其中 ${counts.withSelftest - counts.selftestAllowlisted} 个在本地 ${LOCAL_GATE} 与 CI 都真的执行了自检` +
      `（另有 ${counts.selftestAllowlisted} 个自检豁免，${counts.oneSide} 个只接一面）。`,
  );
  if (warnings.length > 0) {
    // 只告警不判红：这些豁免已经多余，但不是假绿（方向安全，见文件头）。
    console.log("");
    console.log("⚠ 豁免提示（已过期但方向安全，建议回收）：");
    for (const w of warnings) console.log("  · " + w);
  }
}

// ── 自检（T4：真子进程 + 退出码 + 报错文本）────────────────────────────────
const SELF = fileURLToPath(import.meta.url);

/** 一份最小 CI workflow：只要求「有 steps:」，判据本身是纯文本匹配。 */
const workflowYaml = (stepLines) =>
  ["name: fixture", "on: push", "jobs:", "  check:", "    runs-on: ubuntu-latest", "    steps:", ...stepLines].join("\n") + "\n";

const SELF_GUARD_BODY =
  'if (process.argv.includes("--selftest")) { console.log("selftest ok"); process.exit(0); }\n' +
  'console.log("main ok");\n';

/**
 * 造一棵 fixture 仓库树。
 *
 * 每棵树都放 22 个守卫：判据里有 `MIN_GUARD_COUNT = 20` 的扫描面下界，小于它
 * 就是结构性错误。这样「下界」本身在**每条**用例里都被顺带钉住，而不是只在
 * 专门的下界用例里。
 *
 * `selftests` 里的守卫带 `--selftest` 实现；`companions` 里的守卫有伴生
 * `<stem>.selftest.mjs`（不带 --selftest 字面量，专测「伴生自检」这条识别路径）。
 * 默认 `test:guards` 存在但什么都不跑（判据③ 的本地起点必须存在，否则是结构错误）。
 */
function guardTree({ guards, stepLines, scripts = {}, selftests = [], companions = [] }) {
  const files = {
    "package.json": {
      name: "fixture",
      private: true,
      scripts: {
        "test:guards": "npm run test:guards:repo",
        "test:guards:repo": "echo no-selftest-here",
        ...scripts,
      },
    },
    ".github/workflows/ci.yml": workflowYaml(stepLines),
  };
  for (const g of guards) {
    files[`scripts/${g}`] = selftests.includes(g)
      ? SELF_GUARD_BODY
      : "// fixture guard（本守卫只看文件名，不看内容）\n";
    if (companions.includes(g)) {
      files[`scripts/${g.replace(/\.mjs$/, ".selftest.mjs")}`] =
        'console.log("companion selftest ok");\n';
    }
  }
  return files;
}

const names = (n) => Array.from({ length: n }, (_, i) => `check-fake${String(i).padStart(2, "0")}.mjs`);
const direct = (guards) => guards.map((g) => `      - run: node scripts/${g}`);

/**
 * 自检：11 条子进程用例（每条断言退出码 + 关键文本 + <1s）+ 9 条 API 级用例。
 *
 * 为什么要子进程：本脚本的事故形态恰好都发生在 **CLI 层**（`process.exit`
 * 是否真的执行、报错文本是否还在），抽函数在内存里断言的 selftest 对它们完全盲。
 * 旧版 selftest 正是「函数级 + 手搓 ok 布尔」，删掉 runCli 里的 exit(1) 它照样全绿。
 *
 * 判据③ 的 6 条（⑥–⑪）各钉一件事：缺本地面 / 缺 CI 面 / 两面都接（经 npm 间接）/
 * 注释掉的 step 不算接 / 伴生 selftest 只接一面 / 只接主跑（没带 --selftest）。
 *
 * 9 条 API 级用例（⑫–⑳）走子进程做不到：CLI 没有 `--allowlist` 参数，给 fixture
 * 加一个可写 allowlist 的开关等于给判据开后门，所以这些直接调用导出函数
 * `checkGuardsWired({ root, allowlist, selftestAllowlist })`（runCli 调的就是它）。
 */
function runSelftest() {
  const cases = [];
  const subprocess = (name, files, expect) => {
    cases.push({
      name,
      fn: () => {
        const repo = makeFixtureRepo(files, { prefix: "guards-wired-selftest-" });
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
  const api = (name, fn) => cases.push({ name, fn });

  // ① 正常树：21 条直接接线 + 1 条经 npm script 间接接线 → 绿
  {
    const guards = names(22);
    subprocess(
      "① 正常树（直接 + npm 间接都算接线；守卫无自检）→ 绿",
      guardTree({
        guards,
        stepLines: [...direct(guards.slice(0, 21)), "      - run: npm run check:last"],
        scripts: { "check:last": `node scripts/${guards[21]}` },
      }),
      {
        code: 0,
        contains: ["守卫接线自检通过", "22 个 check-*.mjs 全部被 CI 执行", "0 个显式豁免", "0 个守卫有自检"],
        absent: ["没有被任何 CI workflow 执行", "结构错误", "自检没有被真正执行"],
      },
    );
  }

  // ② 注释掉的 CI 步骤不算接线（第 4 轮审计实证的误绿形态）
  {
    const guards = names(22);
    subprocess(
      "② 注释掉的 CI 步骤不算接线 → 红",
      guardTree({
        guards,
        stepLines: [...direct(guards.slice(0, 21)), `#      - run: node scripts/${guards[21]}`],
      }),
      {
        code: 1,
        contains: [guards[21], "没有被任何 CI workflow 执行", "package.json 里也没有脚本包装它"],
        absent: ["守卫接线自检通过"],
      },
    );
  }

  // ③ `npm run check:all` 不得把名为 `check` 的脚本判成已接线（前缀误配）
  {
    const guards = names(22);
    subprocess(
      "③ npm run 名字边界：check:all 不得命中 check → 红",
      guardTree({
        guards,
        stepLines: [...direct(guards.slice(0, 21)), "      - run: npm run check:all"],
        scripts: { check: `node scripts/${guards[21]}`, "check:all": "echo all" },
      }),
      {
        code: 1,
        contains: [guards[21], "package.json 里有 check，但 workflow 没调用它"],
        absent: ["守卫接线自检通过"],
      },
    );
  }

  // ④ 脚本完全没被调用（workflow 不提、package.json 也不包装）
  {
    const guards = names(22);
    subprocess(
      "④ 守卫完全没被调用（没接线、也没脚本包装）→ 红",
      guardTree({ guards, stepLines: direct(guards.slice(0, 21)) }),
      {
        code: 1,
        contains: [guards[21], "package.json 里也没有脚本包装它", "修法：把它接进"],
        absent: ["守卫接线自检通过"],
      },
    );
  }

  // ⑤ 扫描面下界：守卫少到不可能是真的（正则/路径失效）
  {
    const guards = names(3);
    subprocess(
      "⑤ 扫描面失效（只扫到 3 个守卫）→ 结构错误红",
      guardTree({ guards, stepLines: direct(guards) }),
      {
        code: 1,
        contains: ["守卫接线自检结构错误", "明显少于历史规模", "只扫到 3 个守卫"],
        absent: ["守卫接线自检通过"],
      },
    );
  }

  // ── 判据③ 的六条（⑥–⑪）────────────────────────────────────────────
  const guardWithSelf = names(22);
  const selfGuard = guardWithSelf[21];

  // ⑥ 有自检、CI 跑了自检，但本地 test:guards 没跑 → 红（只点名本地面）
  subprocess(
    "⑥ 自检未接本地（test:guards 展开不到）→ 红，只点名本地面",
    guardTree({
      guards: guardWithSelf,
      selftests: [selfGuard],
      stepLines: [...direct(guardWithSelf.slice(0, 21)), `      - run: node scripts/${selfGuard} --selftest`],
    }),
    {
      code: 1,
      contains: [
        selfGuard,
        "自检没有被真正执行",
        "缺本地面",
        "test:guards",
        "该补的一行",
        "完全没跑到这个脚本",
      ],
      absent: ["缺 CI 面", "没有被任何 CI workflow 执行", "守卫接线自检通过"],
    },
  );

  // ⑦ 有自检、本地跑了，但 CI 只跑主跑 → 红（只点名 CI 面）
  subprocess(
    "⑦ 自检未接 CI（CI 只跑主跑、没带 --selftest）→ 红，只点名 CI 面",
    guardTree({
      guards: guardWithSelf,
      selftests: [selfGuard],
      stepLines: [...direct(guardWithSelf.slice(0, 21)), `      - run: node scripts/${selfGuard}`],
      scripts: { "test:guards:repo": `node scripts/${selfGuard} --selftest` },
    }),
    {
      code: 1,
      contains: [selfGuard, "缺 CI 面", "只跑了主跑", "该补的一行"],
      absent: ["缺本地面", "没有被任何 CI workflow 执行", "守卫接线自检通过"],
    },
  );

  // ⑧ 两面都接（且都经 npm script 间接接）→ 绿
  subprocess(
    "⑧ 自检两面都接（经 npm script 间接）→ 绿",
    guardTree({
      guards: guardWithSelf,
      selftests: [selfGuard],
      stepLines: [...direct(guardWithSelf.slice(0, 21)), "      - run: npm run check:self"],
      scripts: {
        "check:self": `node scripts/${selfGuard} --selftest && node scripts/${selfGuard}`,
        "test:guards:repo": "npm run check:self",
      },
    }),
    {
      code: 0,
      contains: [
        "守卫接线自检通过",
        "1 个在本地 test:guards 与 CI 都真的执行了自检",
        "0 个自检豁免",
      ],
      absent: ["自检没有被真正执行", "缺本地面", "缺 CI 面"],
    },
  );

  // ⑨ 注释掉的 CI step 不算接（判据③ 沿用同一套剥注释逻辑）
  subprocess(
    "⑨ CI 里的自检 step 被注释掉 → 红（注释不算接）",
    guardTree({
      guards: guardWithSelf,
      selftests: [selfGuard],
      stepLines: [
        ...direct(guardWithSelf.slice(0, 21)),
        `      - run: node scripts/${selfGuard}`,
        "      - run: |",
        "          npm ci",
        `          # node scripts/${selfGuard} --selftest`,
      ],
      scripts: { "test:guards:repo": `node scripts/${selfGuard} --selftest` },
    }),
    {
      code: 1,
      contains: [selfGuard, "缺 CI 面"],
      absent: ["守卫接线自检通过"],
    },
  );

  // ⑩ 伴生 <stem>.selftest.mjs 只接本地 → 红（CI 面缺失；证明伴生识别路径）
  subprocess(
    "⑩ 伴生 selftest 只接本地、CI 没跑 → 红（伴生识别）",
    guardTree({
      guards: guardWithSelf,
      companions: [selfGuard],
      stepLines: [...direct(guardWithSelf.slice(0, 21)), `      - run: node scripts/${selfGuard}`],
      scripts: {
        "test:guards:repo": `node scripts/${selfGuard.replace(/\.mjs$/, ".selftest.mjs")}`,
      },
    }),
    {
      code: 1,
      contains: [selfGuard, "缺 CI 面", ".selftest.mjs"],
      absent: ["守卫接线自检通过"],
    },
  );

  // ⑪ 两面都只跑主跑（没有 --selftest）→ 红，两面都点名
  subprocess(
    "⑪ 两面都只跑主跑（没带 --selftest）→ 红，两面都点名",
    guardTree({
      guards: guardWithSelf,
      selftests: [selfGuard],
      stepLines: direct(guardWithSelf),
    }),
    {
      code: 1,
      contains: [selfGuard, "缺本地面", "缺 CI 面"],
      absent: ["守卫接线自检通过"],
    },
  );

  // ── 豁免校验（API 级：CLI 无法注入 allowlist，加开关等于开后门）─────────
  const withFixture = (fn) => {
    const guards = names(22);
    const repo = makeFixtureRepo(
      guardTree({
        guards,
        selftests: [guards[21]],
        stepLines: [...direct(guards.slice(0, 21)), `      - run: node scripts/${guards[21]} --selftest`],
      }),
      { prefix: "guards-wired-selftest-" },
    );
    try {
      fn(repo, guards);
    } finally {
      repo.cleanup();
    }
  };

  api("⑫ 判据①②豁免（covered-elsewhere）的 mustProve 文件不存在 → 结构错误", () => {
    withFixture((repo, guards) => {
      const r = checkGuardsWired({
        root: repo.dir,
        selftestAllowlist: {},
        allowlist: {
          [`scripts/${guards[0]}`]: {
            kind: "covered-elsewhere",
            reason: "fixture 理由（必须可证）",
            mustProve: "does/not/exist.spec.ts",
          },
        },
      });
      const errs = r.errors.join("\n");
      if (!errs.includes("mustProve 文件不存在")) {
        throw new Error(`预期 mustProve 结构错误，实际 errors=${JSON.stringify(r.errors)}`);
      }
      if (r.counts.allowlisted !== 1) {
        throw new Error(`豁免应被计入 counts.allowlisted=1，实际 ${r.counts.allowlisted}`);
      }
    });
  });

  api("⑬ 陈旧豁免（目录里已没有这个守卫）→ 结构错误", () => {
    withFixture((repo) => {
      const r = checkGuardsWired({
        root: repo.dir,
        selftestAllowlist: {},
        allowlist: { "scripts/check-already-deleted.mjs": { kind: "report-only", reason: "fixture" } },
      });
      if (!r.errors.some((e) => e.includes("陈旧豁免"))) {
        throw new Error(`预期陈旧豁免错误，实际 errors=${JSON.stringify(r.errors)}`);
      }
    });
  });

  api("⑭ 自检豁免（one-side）缺理由 → 结构错误", () => {
    withFixture((repo, guards) => {
      const r = checkGuardsWired({
        root: repo.dir,
        allowlist: {},
        selftestAllowlist: {
          [`scripts/${guards[21]}`]: {
            kind: "one-side",
            reason: "   ",
            sides: { local: "wired", ci: "exempt" },
          },
        },
      });
      if (!r.errors.some((e) => e.includes("缺理由"))) {
        throw new Error(`预期「自检豁免缺理由」，实际 errors=${JSON.stringify(r.errors)}`);
      }
    });
  });

  api("⑮ 自检豁免声明「另一面已跑」但事实没有 → 结构错误（理由与事实不符）", () => {
    // 该 fixture 的守卫只接了 CI 自检，本地没跑；豁免却声明 local=wired。
    withFixture((repo, guards) => {
      const r = checkGuardsWired({
        root: repo.dir,
        allowlist: {},
        selftestAllowlist: {
          [`scripts/${guards[21]}`]: {
            kind: "one-side",
            reason: "声称本地已跑（假的）",
            sides: { local: "wired", ci: "exempt" },
          },
        },
      });
      if (!r.errors.some((e) => e.includes("理由与事实不符"))) {
        throw new Error(`预期「理由与事实不符」，实际 errors=${JSON.stringify(r.errors)}`);
      }
    });
  });

  api("⑯ 自检豁免指向没有自检的守卫 / 已删除的守卫 → 结构错误（豁免必须回收）", () => {
    withFixture((repo, guards) => {
      const r = checkGuardsWired({
        root: repo.dir,
        allowlist: {},
        selftestAllowlist: {
          [`scripts/${guards[0]}`]: { kind: "covered-elsewhere", reason: "该守卫根本没有自检", mustProve: "package.json" },
          "scripts/check-gone.mjs": { kind: "covered-elsewhere", reason: "已删除", mustProve: "package.json" },
        },
      });
      const errs = r.errors.join("\n");
      if (!errs.includes("没有自检")) {
        throw new Error(`预期「该守卫没有自检」，实际 errors=${JSON.stringify(r.errors)}`);
      }
      if (!errs.includes("陈旧自检豁免")) {
        throw new Error(`预期「陈旧自检豁免」，实际 errors=${JSON.stringify(r.errors)}`);
      }
    });
  });

  api("⑰ 解析器：`>` 折叠块 / 引号内 $GITHUB_WORKSPACE / `\\` 续行 三种写法都识别得出自检", () => {
    const yaml = [
      "jobs:",
      "  check:",
      "    steps:",
      "      - run: >-",
      "          node scripts/check-deep.mjs \\",
      "            --selftest",
      '      - run: node "$GITHUB_WORKSPACE/scripts/check-quoted.mjs" --selftest',
      "      - run: |",
      "          # node scripts/check-commented.mjs --selftest",
      '          node "scripts/check-block.mjs" --selftest',
      "",
    ].join("\n");
    const blocks = extractRunBlocks(yaml);
    const inv = collectInvocations(blocks.join("\n"), "/repo");
    for (const name of ["check-deep", "check-quoted", "check-block"]) {
      const rec = inv.get(`/repo/scripts/${name}.mjs`);
      if (!rec?.selftest) {
        throw new Error(
          `预期 ${name}.mjs 被识别成「跑了自检」，实际 ${JSON.stringify([...inv.keys()])}`,
        );
      }
    }
    if (inv.has("/repo/scripts/check-commented.mjs")) {
      throw new Error("注释掉的 selftest 步骤不该被识别（剥注释失效）");
    }
  });

  api("⑱ detectSelftest：注释里裸写 --selftest 不算自检；引号字面量 / 伴生文件才算", () => {
    const repo = makeFixtureRepo(
      {
        "scripts/check-comment-only.mjs": "// 用法: node scripts/check-comment-only.mjs --selftest\nprocess.exit(0);\n",
        "scripts/check-flag.mjs": 'if (process.argv.includes("--selftest")) process.exit(0);\n',
        "scripts/check-companion.mjs": "process.exit(0);\n",
        "scripts/check-companion.selftest.mjs": "process.exit(0);\n",
      },
      { prefix: "guards-wired-selftest-" },
    );
    try {
      const commentOnly = detectSelftest(repo.pathOf("scripts/check-comment-only.mjs"));
      if (commentOnly.has) {
        throw new Error("只有注释/文档里的 --selftest 不应算「有自检」");
      }
      const flagged = detectSelftest(repo.pathOf("scripts/check-flag.mjs"));
      if (!flagged.has || !flagged.viaFlag) {
        throw new Error("argv.includes(\"--selftest\") 应被识别成有自检");
      }
      const companion = detectSelftest(repo.pathOf("scripts/check-companion.mjs"));
      if (!companion.has || companion.viaFlag || !companion.companionAbs) {
        throw new Error("伴生 <stem>.selftest.mjs 应被识别成有自检（viaFlag=false）");
      }
    } finally {
      repo.cleanup();
    }
  });

  api("⑲ 递归展开深度 ≥8：8 层 npm run 链路仍能展开到自检", () => {
    const scripts = {};
    for (let i = 0; i < 9; i += 1) {
      scripts[`s${i}`] = i === 8 ? "node scripts/check-deep.mjs --selftest" : `npm run s${i + 1}`;
    }
    const expanded = expandNpmScripts(["npm run s0"], scripts);
    if (expanded.length < 10) {
      throw new Error(`8 层链路应展开出 ≥10 条命令，实际 ${expanded.length} 条`);
    }
    const inv = collectInvocations(expanded.join("\n"), "/repo");
    if (!inv.get("/repo/scripts/check-deep.mjs")?.selftest) {
      throw new Error("深度 8 处的自检没有被展开到（MAX_SCRIPT_DEPTH 太小？）");
    }
  });

  api("⑳ 合法的豁免真的能免红：covered-elsewhere + one-side 同时存在 → 无 problem 且计数正确", () => {
    const guards = names(22);
    const repo = makeFixtureRepo(
      guardTree({
        guards,
        selftests: [guards[20], guards[21]],
        stepLines: [
          ...direct(guards.slice(0, 20)),
          `      - run: node scripts/${guards[20]}`,
          `      - run: node scripts/${guards[21]}`,
        ],
        scripts: { "test:guards:repo": `node scripts/${guards[21]} --selftest` },
      }),
      { prefix: "guards-wired-selftest-" },
    );
    try {
      const r = checkGuardsWired({
        root: repo.dir,
        allowlist: {},
        selftestAllowlist: {
          [`scripts/${guards[20]}`]: {
            kind: "covered-elsewhere",
            reason: "判据本体在别处跑（fixture）",
            mustProve: "package.json",
          },
          [`scripts/${guards[21]}`]: {
            kind: "one-side",
            reason: "CI 面刻意不跑自检（fixture）",
            sides: { local: "wired", ci: "exempt" },
          },
        },
      });
      if (r.errors.length > 0) {
        throw new Error(`合法豁免不该产生结构错误，实际 ${JSON.stringify(r.errors)}`);
      }
      if (r.selftestProblems.length > 0) {
        throw new Error(`合法豁免不该再报缺面，实际 ${JSON.stringify(r.selftestProblems.map((p) => p.rel))}`);
      }
      if (r.counts.selftestAllowlisted !== 2 || r.counts.oneSide !== 1) {
        throw new Error(
          `计数应为 selftestAllowlisted=2 / oneSide=1，实际 ${JSON.stringify(r.counts)}`,
        );
      }
    } finally {
      repo.cleanup();
    }
  });

  const failed = reportCases(cases, { title: "check-guards-wired selftest" });
  if (failed > 0) process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop())
) {
  if (process.argv.includes("--selftest")) {
    runSelftest();
  } else {
    const rootArg = argValue(process.argv, "--root");
    runCli(
      resolve(rootArg ?? process.cwd()),
      rootArg ? { allowlist: {}, selftestAllowlist: {} } : {},
    );
  }
}
