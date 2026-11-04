#!/usr/bin/env node
/**
 * 三端 SSRF 分类**判定矩阵**导出（R10，2026-11-05）。
 *
 * ## 为什么要有它（`check:ssrf-deny-parity` 的输入源统一）
 *
 * 旧守卫（`scripts/check-ssrf-deny-parity.mjs`）比对的是**测试文件里的地址清单**
 * （admin 的 `DANGER_ADDRESSES` ↔ node 的 `DANGER_ADDRESSES` ↔ python 的 `DANGER_ADDRESSES`），
 * 判据是「清单里有没有这个地址」——它能抓**漏项**，但抓不到**同地址不同判定**
 * （三端都列了 `192.0.0.192`，但 python 判 `None`、admin 判 `public` ⇒ 旧守卫全绿）。
 *
 * R10 要做的是「同地址**同判定**」。为此判定必须**可机读导出**，而且三端
 * **用同一种输入源**（同一份地址清单）+ **同一种输出格式**（`地址 → 判定标签`）。
 *
 * ## 输入源（单一事实源）
 *
 * 地址清单 = **`packages/executor-protocol/protocol.json` 的 `networkPolicy`**：
 * `addresses` 各类的 `examples`（契约自己登记的例子）+ `metadataAddresses.addresses`。
 * 三端探针**都从这一份清单取地址**，谁都不自己抄（与 ADR-029「三端从生成物同读」同纪律）。
 *
 * ## 输出（stdout 一行 JSON）
 *
 * `[{"addr":"127.0.0.1","category":"loopback"}, …]`；`category` 为该端的**分类标签**
 * （admin: `AddressRisk`；node: `RestrictedCategory`；python: `RestrictedCategory`）。
 * 标签在两端命名不同（`private-lan` vs `privateIPv4`、`link-local` vs `linkLocal`），
 * 由 `normalizeCategory()` 归一到**契约口径**（`packages/executor-protocol/protocol.json`
 * 的 `addresses` 键名），守卫比的是归一后的值。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/ssrf-category-matrix.mjs                 # 打印三端矩阵（JSON）
 * node scripts/ssrf-category-matrix.mjs --side=admin    # 只跑某一端
 * ```
 *
 * 三端各用**自己的**运行时真跑（admin/node 用各自 `node_modules` 的 `ts-node/register`
 * 跑真 TS 实现；python 用**裸 `python3`** 跑真实现）——与 `check-protocol-three-way.mjs`
 * 的探针手法同款（那里已证明可行）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
const ADMIN_APP = path.join(ROOT, "apps/admin-api");
const NODE_APP = path.join(ROOT, "apps/executor-node");
const PY_APP = path.join(ROOT, "apps/executor-python");

/** 契约地址类名 → 三端各自的标签写法（归一表；**契约口径是准绳**）。 */
export const CATEGORY_ALIASES = {
  public: "public",
  privateIPv4: "privateIPv4",
  "private-lan": "privateIPv4",
  loopback: "loopback",
  linkLocal: "linkLocal",
  "link-local": "linkLocal",
  cgnat: "cgnat",
  restricted: "cgnat",
  unspecified: "unspecified",
  multicast: "multicast",
  reserved: "reserved",
};

/** 把某端的标签归一到契约口径；未知标签原样返回（守卫会把它当成"两端都未知"或点名）。 */
export function normalizeCategory(raw) {
  if (raw === null || raw === undefined) return "public";
  const key = String(raw).trim();
  return CATEGORY_ALIASES[key] ?? key;
}

/**
 * 从契约取出矩阵地址清单（**单一事实源**）。
 *
 * `addresses.*.examples`（各类的例子）+ `metadataAddresses.addresses`（元数据地址）。
 * 去重、保序。
 */
export function collectMatrixAddresses(protocol) {
  const out = [];
  const seen = new Set();
  const push = (addr) => {
    if (typeof addr !== "string" || !addr.trim()) return;
    const bare = addr.split("/")[0].trim();
    if (!bare || seen.has(bare)) return;
    seen.add(bare);
    out.push(bare);
  };
  const addresses = protocol?.networkPolicy?.addresses ?? {};
  for (const spec of Object.values(addresses)) {
    for (const ex of spec?.examples ?? []) push(ex);
  }
  for (const addr of protocol?.networkPolicy?.metadataAddresses?.addresses ?? []) push(addr);
  // 只留 **IP 字面量**：主机名（`localhost` / `foo.localhost`）在三端是**不同层**判的
  // —— node/python 在**名字层**判 loopback，admin 只在**DNS 结果层**判（`classifyAddressRisk`
  // 只处理字面量，主机名走 `lookup()`）。把它们塞进"字面量分类"矩阵只会造出**层错配的假差异**，
  // 而主机名的拒绝行为由各端自己的测试 + 四向检查（DNS 桩 `localhost ⇒ 127.0.0.1`）覆盖。
  return out.filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a) || a.includes(":"));
}

/**
 * 契约口径的**行为等价类**（决策轴，比标签粗但安全相关）。
 *
 * 契约 `networkPolicy.switch.semantics` 只分三档：
 *   · `allow`      —— public：恒放行；
 *   · `switch-only`—— privateIPv4：开关开启才放行；
 *   · `deny`       —— 其余五类：任何开关状态都拒。
 *
 * 为什么要这一轴：admin 的标签体系比契约**粗**（它把 `unspecified`/`multicast` 并进
 * `reserved`），但**行为完全相同**（都恒拒）。若直接比标签，守卫会永远红 ⇒ 变成噪音源，
 * 终将被关掉（R02 的教训）。而 R09 那类真缺陷（`192.0.0.192` 被判 public ⇒ 恒放行）
 * 在**决策轴**上是分得出来的 ⇒ 门禁必须比决策，标签差异另走豁免。
 */
export const DECISION_BY_CATEGORY = {
  public: "allow",
  privateIPv4: "switch-only",
  loopback: "deny",
  linkLocal: "deny",
  cgnat: "deny",
  unspecified: "deny",
  multicast: "deny",
  reserved: "deny",
};

/** 由归一后的标签推出决策轴上的行为。 */
export function decisionFor(category) {
  return DECISION_BY_CATEGORY[category] ?? `unknown(${category})`;
}

// ── 三端探针 ────────────────────────────────────────────────────────────────

const ADMIN_PROBE = `
const m = require(process.env.ACF_ADMIN_UTIL);
const addrs = JSON.parse(process.argv[2]);
const out = [];
for (const a of addrs) {
  let cat = null;
  try { cat = m.classifyAddressRisk(a); } catch (e) { cat = "ERROR:" + e.message; }
  out.push({ addr: a, category: cat });
}
console.log(JSON.stringify(out));
`;

const NODE_PROBE = `
const m = require(process.env.ACF_NODE_GUARD);
const addrs = JSON.parse(process.argv[2]);
const out = [];
for (const a of addrs) {
  let cat = null;
  try {
    const host = a.includes(":") ? a : a;
    cat = m.classifyRestrictedIpv4(host);
    if (!cat && host.includes(":")) cat = m.classifyRestrictedIpv6(host);
  } catch (e) { cat = "ERROR:" + e.message; }
  out.push({ addr: a, category: cat });
}
console.log(JSON.stringify(out));
`;

const PY_PROBE = `
import json, sys
sys.path.insert(0, ".")
from network_policy import classify_restricted_address
addrs = json.loads(sys.argv[1])
out = []
for a in addrs:
    try:
        cat = classify_restricted_address(a)
    except Exception as e:
        cat = "ERROR:" + str(e)
    out.append({"addr": a, "category": cat})
print(json.dumps(out))
`;

/** 用子进程真跑某端的实现，返回 `[{addr, category}]`。 */
export function runSide(side, addresses, { root = ROOT } = {}) {
  const json = JSON.stringify(addresses);
  if (side === "admin") {
    const probePath = path.join(ADMIN_APP, ".__r10_probe.cjs");
    writeFileSync(probePath, ADMIN_PROBE, "utf8");
    try {
      const r = spawnSync(process.execPath, ["--require", "ts-node/register", probePath, json], {
        cwd: ADMIN_APP,
        encoding: "utf8",
        env: { ...process.env, ACF_ADMIN_UTIL: path.join(ADMIN_APP, "src/common/utils/safe-http.util.ts") },
      });
      if (r.status !== 0) throw new Error(`admin 探针失败（status=${r.status}）：${r.stderr || r.stdout}`);
      return JSON.parse(r.stdout);
    } finally {
      rmSync(probePath, { force: true });
    }
  }
  if (side === "node") {
    const probePath = path.join(NODE_APP, ".__r10_probe.cjs");
    writeFileSync(probePath, NODE_PROBE, "utf8");
    try {
      const r = spawnSync(process.execPath, ["--require", "ts-node/register", probePath, json], {
        cwd: NODE_APP,
        encoding: "utf8",
        env: { ...process.env, ACF_NODE_GUARD: path.join(NODE_APP, "src/lib/ssrf-guard.ts") },
      });
      if (r.status !== 0) throw new Error(`node 探针失败（status=${r.status}）：${r.stderr || r.stdout}`);
      return JSON.parse(r.stdout);
    } finally {
      rmSync(probePath, { force: true });
    }
  }
  if (side === "python") {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "acf-r10-py-"));
    const probePath = path.join(tmp, "probe.py");
    writeFileSync(probePath, PY_PROBE, "utf8");
    try {
      const r = spawnSync("python3", [probePath, json], {
        cwd: PY_APP,
        encoding: "utf8",
        env: { ...process.env, PYTHONPATH: PY_APP },
      });
      if (r.status !== 0) throw new Error(`python 探针失败（status=${r.status}）：${r.stderr || r.stdout}`);
      const parsed = JSON.parse(r.stdout.trim().split("\n").pop());
      return parsed;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  throw new Error(`未知端：${side}`);
}

/** 三端矩阵：`{ admin: [...], node: [...], python: [...] }`（标签已归一）。 */
export function collectMatrix({ root = ROOT, sides = ["admin", "node", "python"] } = {}) {
  const protocol = JSON.parse(
    readFileSync(path.join(root, "packages/executor-protocol/protocol.json"), "utf8"),
  );
  const addresses = collectMatrixAddresses(protocol);
  const matrix = {};
  for (const side of sides) {
    matrix[side] = runSide(side, addresses, { root }).map((r) => ({
      addr: r.addr,
      category: normalizeCategory(r.category),
    }));
  }
  return { addresses, matrix };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sideArg = process.argv.find((a) => a.startsWith("--side="));
  const sides = sideArg ? [sideArg.slice("--side=".length)] : ["admin", "node", "python"];
  const { addresses, matrix } = collectMatrix({ sides });
  console.log(JSON.stringify({ addresses, matrix }, null, 2));
}
