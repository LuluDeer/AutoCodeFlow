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
  cases.forEach((c, i) => {
    const got = {
      admin: Boolean(ends.admin.verdicts?.[i]?.allowed),
      node: Boolean(ends.node.verdicts?.[i]?.allowed),
      python: Boolean(ends.python.verdicts?.[i]?.allowed),
    };
    const tag = `地址 ${c.addr}（${c.cat}）× 开关 ${c.on ? "on" : "off"}`;
    for (const [who, v] of Object.entries(got)) {
      if (v !== c.expected) {
        errors.push(`${tag} ⇒ 契约期望 ${c.expected ? "放行" : "拒绝"} / **${who} 实得 ${v ? "放行" : "拒绝"}**`);
      }
    }
    const vals = Object.values(got);
    if (new Set(vals).size > 1) {
      errors.push(
        `${tag} ⇒ **三端不一致**：` +
          Object.entries(got).map(([w, v]) => `${w}=${v ? "放行" : "拒绝"}`).join(" / "),
      );
    }
  });
  errors.meta = { cases: cases.length, ends: Object.keys(ends).length };
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
