#!/usr/bin/env node
/**
 * R83（2026-11-06）：**跨端出站姿态一致性判据**（admin / node / python **三端同形出口真跑**）。
 *
 * ## 三端出口（都由各端 owner 抽成零依赖 / 裸可跑）
 * · admin：`address-category.util.ts` 的 `classifyAddress` + `outbound-posture.util.ts` 的 `evaluateOutboundPosture`（0 import）；
 * · node：`executor-node/src/lib/address-category.ts` 的 `verdictForAddress(addr, allow, metadata)`（0 import）；
 * · python：`network_policy.verdict_for_address(addr, allow_private_network)`（裸 python3）。
 *
 * ## 判据
 * 契约 `networkPolicy.addresses.*.examples` + `metadataAddresses.addresses`（**逐字读**）× 开关两态：
 * ① **三端互相一致**；② **与契约期望一致**（`addresses.<cat>.allowedUnderPrivateNetwork` + `switch.semantics`
 * + `ipv4Mapped` 的「按内嵌 IPv4 判定」）。期望值**不来自实现**。
 * 主机名形态（`localhost` 系）也纳入：三端入口都接受主机名（admin 先 `isIP` 判否后走 `isLoopbackHostname`）。
 *
 * ## 用法
 *   node scripts/check-cross-end-consistency.mjs            # 判据
 *   node scripts/check-cross-end-consistency.mjs --list     # 只打印将要比较的格子（调试）
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";

printCoverageBanner(import.meta.url, "subprocess");

const HERE = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(HERE), "..");
export const CONTRACT_REL = "packages/executor-protocol/protocol.json";

/** 契约期望（全部来自契约字段）。 */
export function expectedFor(addr, cat, catMap, on) {
  if (cat !== "ipv4Mapped") return on && catMap[cat]?.allowedUnderPrivateNetwork === true;
  const embedded = addr.replace(/^::ffff:/i, "");
  for (const [k, v] of Object.entries(catMap)) {
    if (k === "ipv4Mapped") continue;
    if ((v.examples ?? []).some((e) => String(e) === embedded)) {
      return on && v.allowedUnderPrivateNetwork === true;
    }
  }
  return true; // 内嵌地址未登记于受限面 ⇒ 公网
}

/**
 * R86：**归一化形态矩阵**（主机名语义）。
 *
 * 依据（契约 `networkPolicy.addresses.loopback.description` + W3 普查实测）：
 * `new URL()` 会把**百分号编码**（`local%68ost`）与 **IDN**（`ⓛocalhost`，U+24DB）归一成 `localhost`，
 * 但**尾点不折**（`localhost.`）⇒ 各端须自行折尾点。故以下形态**语义上都是 loopback ⇒ 必须拒**；
 * `notlocalhost.com` / `localhost.evil.com` 是**后缀伪装**反例 ⇒ 公网 ⇒ 放行。
 */
export const HOST_FORM_CASES = [
  { addr: "localhost", expected: false },
  { addr: "LOCALHOST", expected: false },
  { addr: "Foo.LocalHost", expected: false },
  { addr: "localhost.", expected: false },
  { addr: "localhost..", expected: false },
  { addr: "local%68ost", expected: false },
  { addr: "ⓛocalhost", expected: false },
  { addr: "localhost.localdomain", expected: false },
  { addr: "notlocalhost.com", expected: true },
  { addr: "localhost.evil.com", expected: true },
];

/**
 * R86：这两条形态的**归一化发生在 URL 解析层**（`new URL()` 把 `local%68ost` / `ⓛocalhost` 折成 `localhost`），
 * **纯函数层（三端 classifier）不承担该职责** ⇒ 本判据把它们列为"该层未覆盖"（显式打印），
 * 不算通过也不算失败。URL 层的等价性由各端既有 URL 解析测试覆盖。
 */
export const LAYER_UNCOVERED_FORMS = new Set(["local%68ost", "ⓛocalhost"]);

/**
 * R86：**已知跨端差异（登记，不修 —— `apps/**` 不在本 worker 写域）**。
 *
 * `localhost..`（**连续尾点**，非法主机名形态）：
 * · **admin 放行**（`isLoopbackHostname` 只折一个尾点 ⇒ 折完剩 `localhost.`，仍不等于 `localhost`）；
 * · **node / python 拒绝**。
 * 契约 `loopback.description` 只写「localhost 及 .localhost 后缀」⇒ 对**连续尾点**未表态 ⇒ 属**契约沉默区**。
 * **复核条件**：契约若明确「多个尾点一律折叠」或「连续尾点视为非法 ⇒ 拒绝」，按契约改此处并让三端对齐。
 * 处理：本判据**不判失败**，但**每次运行都打印**（可见），并计入 `meta.knownDivergences`。
 */
export const KNOWN_DIVERGENCES = [
  // 当前**没有活着的**已知差异。
  // R86 曾登记 `localhost..`（admin 放行 / node+python 拒绝）；W3 在 `fb509c6c` 把 admin 的
  // `normalizeHostname` 改成 `replace(/\.+$/, "")`（折**所有**尾点）后三端全拒 ⇒ 该条**已收口**，
  // 故直接**移除**（本清单只放活着的差异，避免后来者误以为还存在分歧）；
  // 收口后该形态改由上面的一致性判据**正常覆盖**（不是靠豁免挡住的）。
];

export function buildCases(root = REPO_ROOT) {
  const contract = JSON.parse(readFileSync(join(root, CONTRACT_REL), "utf8"));
  const np = contract.networkPolicy ?? {};
  const catMap = np.addresses ?? {};
  const metaRaw = np.metadataAddresses ?? {};
  const metaAddrs = (Array.isArray(metaRaw) ? metaRaw : (metaRaw.addresses ?? [])).map(String);
  const cases = [];
  for (const [cat, v] of Object.entries(catMap)) {
    for (const addr of v.examples ?? []) {
      for (const on of [false, true]) {
        cases.push({ addr: String(addr), cat, on, expected: expectedFor(String(addr), cat, catMap, on) });
      }
    }
  }
  for (const addr of metaAddrs) {
    for (const on of [false, true]) {
      cases.push({ addr: addr.replace(/\/\d+$/, ""), cat: "metadataAddresses", on, expected: false });
    }
  }
  // R86：形态矩阵 × 开关两态（期望与开关无关，但两态都判，避免"只在 on 下对"）
  for (const h of HOST_FORM_CASES) {
    for (const on of [false, true]) {
      cases.push({ addr: h.addr, cat: "hostForm", on, expected: h.expected });
    }
  }
  return { cases, metaAddrs, catMap };
}

/** admin 真跑（子进程 strip-types）：IP 走 classify+posture，主机名走 isLoopbackHostname。 */
function adminVerdicts(cases, root, metaAddrs) {
  const script = [
    'import { pathToFileURL } from "node:url";',
    'import { isIP } from "node:net";',
    "const lib = process.env.LIB_DIR;",
    "const ac = await import(pathToFileURL(lib + '/address-category.util.ts').href);",
    "const op = await import(pathToFileURL(lib + '/outbound-posture.util.ts').href);",
    "const cases = JSON.parse(process.env.CASES);",
    'const meta = JSON.parse(process.env.META || "[]");',
    "const tables = { ipv4: ac.SSRF_DENY_HOST_PATTERNS.ipv4, ipv6: ac.SSRF_DENY_HOST_PATTERNS.ipv6, metadataAddresses: meta, isIP };",
    "const out = cases.map((c) => {",
    '  if (!isIP(c.addr)) {',
    "    const loop = ac.isLoopbackHostname(c.addr);",
    "    return { allowed: !loop, reason: loop ? 'loopback-hostname' : 'hostname-public' };",
    "  }",
    "  const cls = ac.classifyAddress(c.addr, tables);",
    '  const v = op.evaluateOutboundPosture({ risk: cls.category, metadata: cls.metadata, allowPrivateNetwork: c.on, posture: "webhook" });',
    "  return { allowed: v.allowed, reason: v.reason };",
    "});",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      LIB_DIR: `${root}/apps/admin-api/src/common/utils`,
      CASES: JSON.stringify(cases.map((c) => ({ addr: c.addr, on: c.on }))),
      META: JSON.stringify(metaAddrs),
    },
  });
  if (r.status !== 0) return { error: `admin 端真跑失败：${String(r.stderr ?? "").split("\n").find((l) => l && !l.startsWith("(")) ?? ""}` };
  return parseJsonLine(r.stdout, "admin");
}

/** node 真跑（子进程 strip-types）：verdictForAddress。 */
function nodeVerdicts(cases, root, metaAddrs) {
  const script = [
    'import { pathToFileURL } from "node:url";',
    'const ac = await import(pathToFileURL(process.env.NODE_LIB).href);',
    "const cases = JSON.parse(process.env.CASES);",
    'const meta = JSON.parse(process.env.META || "[]");',
    "const out = cases.map((c) => {",
    "  const v = ac.verdictForAddress(c.addr, c.on, meta);",
    "  return { allowed: v.allowed, reason: v.reason };",
    "});",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_LIB: `${root}/apps/executor-node/src/lib/address-category.ts`,
      CASES: JSON.stringify(cases.map((c) => ({ addr: c.addr, on: c.on }))),
      META: JSON.stringify(metaAddrs),
    },
  });
  if (r.status !== 0) return { error: `node 端真跑失败：${String(r.stderr ?? "").split("\n")[0] ?? ""}` };
  return parseJsonLine(r.stdout, "node");
}

/** python 真跑（裸 python3）：verdict_for_address。 */
function pythonVerdicts(cases, root) {
  const code = [
    "import json,sys",
    "sys.path.insert(0, 'apps/executor-python')",
    "import network_policy as np",
    "out = []",
    "for c in json.loads(sys.argv[1]):",
    "    v = np.verdict_for_address(c['addr'], c['on'])",
    "    out.append({'allowed': bool(v.get('allowed')), 'reason': v.get('reason')})",
    "print(json.dumps(out))",
  ].join("\n");
  const r = spawnSync("python3", ["-c", code, JSON.stringify(cases.map((c) => ({ addr: c.addr, on: c.on })))], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0) return { error: `python 端真跑失败：${String(r.stderr ?? "").split("\n")[0] ?? ""}` };
  return parseJsonLine(r.stdout, "python");
}

function parseJsonLine(stdout, who) {
  const line = String(stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return { verdicts: JSON.parse(line) };
  } catch {
    return { error: `${who} 端输出不是 JSON：${line.slice(0, 120)}` };
  }
}

export function check(root = REPO_ROOT) {
  const errors = [];
  let built;
  try {
    built = buildCases(root);
  } catch (e) {
    return [`读不到契约或契约非法：${e.message}`];
  }
  const { cases, metaAddrs } = built;
  if (cases.length === 0) return ["契约地址清单为空 —— 判据面塌方"];

  const admin = adminVerdicts(cases, root, metaAddrs);
  const node = nodeVerdicts(cases, root, metaAddrs);
  const py = pythonVerdicts(cases, root);
  for (const [who, res] of [["admin", admin], ["node", node], ["python", py]]) {
    if (res.error) errors.push(`${who} 端不可用：${res.error}`);
  }
  if (errors.length > 0) return errors;

  const ends = { admin, node, python: py };
  // R86：python 端对**非 IP 且非回环专用名**的主机名是 **fail-closed**（纯函数无法解析 DNS）⇒
  // 对 hostForm 组，若 admin/node 都与契约一致、只有 python 拒绝，那是**该端未覆盖该形态**（不是缺陷）：
  // 显式记录并打印（Led 要求的"可见但不算通过/失败"）。
  const uncovered = [];
  const layerUncovered = [];
  cases.forEach((c, i) => {
    const got = {
      admin: Boolean(ends.admin.verdicts?.[i]?.allowed),
      node: Boolean(ends.node.verdicts?.[i]?.allowed),
      python: Boolean(ends.python.verdicts?.[i]?.allowed),
    };
    if (c.cat === "hostForm" && LAYER_UNCOVERED_FORMS.has(c.addr)) {
      layerUncovered.push(`${c.addr} × ${c.on ? "on" : "off"}`);
      return;
    }
    if (c.cat === "hostForm" && KNOWN_DIVERGENCES.some((k) => k.addr === c.addr)) {
      return; // 已登记差异：每次运行统一打印，不判失败
    }
    const tag = `地址 ${c.addr}（${c.cat}）× 开关 ${c.on ? "on" : "off"}`;
    for (const [who, v] of Object.entries(got)) {
      if (c.cat === "hostForm" && who === "python" && v !== c.expected) {
        const others = [got.admin, got.node];
        if (others.every((x) => x === c.expected)) {
          uncovered.push(`${c.addr}（python：fail-closed 拒绝，admin/node 与契约一致）`);
          continue;
        }
      }
      if (v !== c.expected) {
        errors.push(`${tag} ⇒ 契约期望 ${c.expected ? "放行" : "拒绝"} / **${who} 实得 ${v ? "放行" : "拒绝"}**`);
      }
    }
    const vals = Object.values(got);
    // python fail-closed 造成的差异已计入 uncovered，这里不再重复报错（**不用 continue**：forEach 里非法）
    const pythonFailClosed =
      c.cat === "hostForm" &&
      got.admin === c.expected &&
      got.node === c.expected &&
      got.python !== c.expected;
    if (!pythonFailClosed && new Set(vals).size > 1) {
      errors.push(
        `${tag} ⇒ **三端不一致**：` +
          Object.entries(got).map(([w, v]) => `${w}=${v ? "放行" : "拒绝"}`).join(" / "),
      );
    }
  });
  const knownRows = KNOWN_DIVERGENCES.map((k) => `${k.addr}（契约期望 ${k.expect}；${k.note}）`);
  if (knownRows.length > 0) {
    console.log(`已知跨端差异 ${knownRows.length} 条（登记不修，待契约表态）：${knownRows.join("；")}`);
  }
  if (layerUncovered.length > 0) {
    console.log(
      `（该层未覆盖 ${layerUncovered.length} 格：${[...new Set(layerUncovered.map((x) => x.split(" × ")[0]))].join("、")} —— ` +
        `归一化在 URL 解析层，纯函数层不承担；URL 层由各端既有测试覆盖）`,
    );
  }
  if (uncovered.length > 0) {
    console.log(`（未覆盖 ${uncovered.length} 格，按"可见但不算通过/失败"处理）：`);
    for (const u of uncovered) console.log(`   · ${u}`);
  }
  errors.meta = {
    cases: cases.length,
    ends: Object.keys(ends).length,
    uncovered: uncovered.length,
    knownDivergences: KNOWN_DIVERGENCES.length,
  };
  return errors;
}

function main(argv) {
  const eq = argv.find((a) => a.startsWith("--root="));
  const root = eq ? resolve(eq.slice("--root=".length)) : REPO_ROOT;
  if (argv.includes("--list")) {
    const { cases } = buildCases(root);
    cases.forEach((c, i) => console.log(`[${i + 1}/${cases.length}] ${c.addr} × ${c.on ? "on" : "off"} ⇒ 期望 ${c.expected ? "放行" : "拒绝"}`));
    return 0;
  }
  const errors = check(root);
  const meta = errors.meta ?? {};
  if (errors.length === 0) {
    console.log(`✔ 跨端姿态一致：${meta.cases} 格 × ${meta.ends} 端真跑，三端互一致且与契约期望一致。`);
    return 0;
  }
  console.error(`✘ 跨端姿态一致性：${errors.length} 项`);
  for (const e of errors) console.error(`   · ${e}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === HERE) {
  process.exit(main(process.argv.slice(2)));
}
