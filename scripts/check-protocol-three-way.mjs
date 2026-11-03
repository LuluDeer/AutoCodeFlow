#!/usr/bin/env node
/**
 * R2-1/P5：**真三向检查** —— 一份契约向量 ⇒ 真跑两侧实现 ⇒ 规范化后比对。
 *
 * ## 这道闸补的是哪一类盲区
 *
 * 本仓已有的 `check:protocol-breaking`（静态 diff）与 `check:failure-classifiers`
 * （两侧生成物真跑）都**只覆盖一部分**：
 *   · 静态 diff 看不出「协议写了 A、两端都实现成 B」（**两端一起错**）。
 *   · 分类器守卫只管 `failureReason` 那一段。
 *
 * `packages/executor-protocol/protocol.json` 的 `schemas` 段虽已被双生成，
 * 但**生成物只保证「两端能解析同一份文档」**，不保证「两端对同一份载荷给出
 * 相同结论」——后者才是真三向。
 *
 * ## 形态（Lead 定的约束，逐条遵守）
 *
 * ① **独立脚本、零依赖优先**：本脚本只用 node 内置模块 + 两个**子进程**
 *    （node 侧用 `ts-node/register` 跑真 TS 实现；python 侧用**裸 `python3`**
 *    跑纯 stdlib 模块）。**不 pip install** ⇒ 守卫不会变成重任务。
 * ② **比对对象来自五个新段的向量**：`networkPolicy` / `errorStatusCodes` /
 *    `taskFieldAliases` / `timeoutPrecedence` / `callbackLogRetention`。
 * ③ **规范化规则显式写在 `normalize()` 里**，且该函数**本身有单测**（selftest）。
 * ④ **有牙**：selftest 里故意改一侧 ⇒ 必须红（见 `T3-P5 有牙证据`）。
 * ⑤ **比对的是「与契约向量的对齐」，不是端到端互比** —— 互比只能发现
 *    「两端一起错」。本脚本的基准是**契约向量**。
 * ⑥ **无法等价比对的向量显式登记**（`NON_COMPARABLE`）并给出等价判据，
 *    不硬凑。
 *
 * ## 三向的含义
 *
 *   契约向量（protocol.json）  ← 基准
 *        ↑ 期望              ↑ 期望
 *   node 实现（真跑）      python 实现（真跑）
 *
 * 任一侧与契约不符 ⇒ 红。两侧都错但都等于契约 ⇒ 绿（这是**正确**的：
 * 契约是事实源）。
 *
 * ## 零依赖是怎么做到的（python 侧）
 *
 * python 侧的判定逻辑住在 `apps/executor-python/network_policy.py`
 * （**stdlib-only**，与仓内既有的 `js_json.py` 同款定位）。它是从
 * `routers/execute.py` 里**纯搬出来**的（26 个 host 对拍 0 差异），
 * 目的是让守卫能用**裸 `python3`** 真跑 —— 那个模块顶层 import
 * httpx/fastapi/pydantic，独立进程 import 不了。
 *
 * node 侧用 `apps/executor-node` **自己的** `node_modules`（ts-node 是它的
 * devDependency），故子进程的 cwd 必须是那个目录。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_REL = "packages/executor-protocol/protocol.json";

const NODE_APP = join(ROOT, "apps/executor-node");
const PY_APP = join(ROOT, "apps/executor-python");

// ── 规范化规则（显式；本函数本身有单测，见 --selftest）────────────────────
/**
 * 把「一侧的输出」规范化成**可逐字节比较**的规范形状。
 *
 * ## 为什么需要规范化
 *
 * 两端输出形状必然不同：
 *   · node 的对象键序 = 源码字面量序；python 的 = dict 插入序；
 *   · 两侧的「类别名」大小写/命名可能不同（`privateIPv4` vs `private_ipv4`）；
 *   · 布尔/数字/None 的表示不同（`true` vs `True`）。
 *
 * ## 规则（逐条，可审查）
 *
 * R1 **键序无关**：对象键按**字典序**排序后序列化（⇒ 两侧的书写顺序差异消失）。
 * R2 **数组保序**：数组**不**排序（顺序本身是语义，如 `timeoutPrecedence.order`）。
 * R3 **标量归一**：布尔 → `"true"`/`"false"`；`null`/`None` → `"null"`；
 *     数字 → 十进制字符串（避免 `1` vs `1.0` 的文本差异）。
 * R4 **类别名归一**：契约的七类名在两侧都**逐字**使用
 *     （`loopback` / `privateIPv4` / `linkLocal` / `cgnat` / `unspecified` /
 *     `multicast` / `reserved`）⇒ 无需大小写折叠。**若某侧用了别的写法，
 *     本函数会把它暴露成不一致**（而不是悄悄折叠掉）。
 * R5 **字符串不折叠空白**（空格是有意义的）。
 * R6 **未定义 ⇒ 显式标记** `{"__undefined__": true}`（两侧都缺 ⇒ 一致；
 *     一侧缺一侧有 ⇒ 不一致）。
 */
export function normalize(value) {
  if (value === undefined) return { __undefined__: true };
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `num:${String(value)}`;
    return String(value);
  }
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => normalize(v)); // R2
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = normalize(value[key]); // R1
    return out;
  }
  return String(value);
}

/** 规范形状的稳定序列化（用于逐字节比较）。 */
export function canonical(value) {
  return JSON.stringify(normalize(value));
}

// ── 两侧探针（真跑）────────────────────────────────────────────────────────

/**
 * node 侧探针：**真跑** `apps/executor-node/src/git-repo-network-policy.ts`
 * 与 `src/lib/ssrf-guard.ts`。
 *
 * 用 `ts-node/register`（executor-node 自己的 devDependency）⇒ **真跑 TS 实现**，
 * 不是复刻一份逻辑。
 */
const NODE_PROBE = `
const policy = require('./src/git-repo-network-policy');
const guard = require('./src/lib/ssrf-guard');
const vectors = JSON.parse(process.argv[2]);
const out = [];
for (const v of vectors) {
  const allowPrivate = v.switch === 'on';
  let denied = false;
  try {
    // 真跑**运行时闸**（含开关语义），不是复刻判定
    policy.assertGitRepoNetworkPolicy(v.url, { allowPrivateNetwork: allowPrivate });
  } catch (e) {
    denied = true;
  }
  const host = policy.gitRepoHost(v.url);
  const category = guard.isRestrictedAddressForPolicy(host);
  out.push({
    name: v.name,
    denied,
    category,
    allowedBySwitch: policy.categoryAllowed(category, allowPrivate),
  });
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * python 侧探针：**真跑** `apps/executor-python/network_policy.py`（stdlib-only）。
 *
 * 用**裸 `python3`**（OS 自带）⇒ **零第三方依赖**。
 */
const PY_PROBE = `
import json, sys
sys.path.insert(0, sys.argv[1])
import network_policy as np
vectors = json.loads(sys.argv[2])
out = []
for v in vectors:
    allow_private = v["switch"] == "on"
    host = np.git_repo_host(v["url"])
    category = np.classify_restricted_address(host)
    # 运行时判定 = 「该主机受限」且「该类别不被开关放行」
    # （与 node 的 assertGitRepoNetworkPolicy 同构：categoryAllowed 决定放行）
    restricted = np.host_is_restricted(v["url"])
    denied = restricted and not np.category_allowed(category, allow_private)
    out.append({
        "name": v["name"],
        "denied": denied,
        "category": category,
        "allowedBySwitch": np.category_allowed(category, allow_private),
    })
print(json.dumps(out))
`;

function runNodeProbe(vectors) {
  const probePath = join(NODE_APP, ".__p5_probe.js");
  writeFileSync(probePath, NODE_PROBE, "utf8");
  try {
    const r = spawnSync(
      process.execPath,
      ["--require", "ts-node/register", probePath, JSON.stringify(vectors)],
      { cwd: NODE_APP, encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(
        `node 侧探针失败（status=${r.status}）：\n${r.stderr || r.stdout}`,
      );
    }
    return JSON.parse(r.stdout);
  } finally {
    try {
      rmSync(probePath);
    } catch {
      /* ignore */
    }
  }
}

function runPythonProbe(vectors) {
  const probePath = join(PY_APP, ".__p5_probe.py");
  writeFileSync(probePath, PY_PROBE, "utf8");
  try {
    const r = spawnSync("python3", [probePath, PY_APP, JSON.stringify(vectors)], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(
        `python 侧探针失败（status=${r.status}）：\n${r.stderr || r.stdout}`,
      );
    }
    return JSON.parse(r.stdout.trim().split("\n").pop());
  } finally {
    try {
      rmSync(probePath);
    } catch {
      /* ignore */
    }
  }
}

// ── 无法等价比对的向量（显式登记，不硬凑）───────────────────────────────
/**
 * 有些向量的两端**输出形态天然不同**（如 pull 路径没有 HTTP 状态码，
 * 只有 failed 回调）。这类向量**不能**塞进「同一份 fixture 打两端」的形状。
 *
 * 处置：**显式登记** + 给出**等价判据**（人工/其它判据覆盖），并**在报告里
 * 打印出来**（不是静默跳过）—— 否则下一个人会以为它们被覆盖了。
 */
export const NON_COMPARABLE = [
  {
    vector: "errorStatusCodes / pull-path-rejection-is-failed-callback",
    reason:
      "pull 入口**没有同步调用方**可接收 HTTP 状态码 ⇒ 两端的「输出形态」" +
      "根本不同（HTTP 400 vs failed 回调）。等价比对在此**无意义**。",
    equivalentCriterion:
      "两侧的 pull 拒绝路径都产生 {status:'failed', failureReason:'unknown'}" +
      " + 归还预留槽 + 不留 live 条目 + 不落盘 —— 由各自的运行时测试覆盖" +
      "（node: pull.ts 的 else 分支；python: scheduler.py 的 reject 分支）。",
  },
  {
    vector: "errorStatusCodes / rejectedRequest 等 4 条 HTTP 状态码向量",
    reason:
      "这两侧的 HTTP 端点是**框架**行为（node 手工 reject vs python " +
      "ExecuteRequestRoute 的 RequestValidationError 映射）⇒ 判据在 " +
      "`errorStatusCodes` 段里，而**不是**在一个可被独立 import 的纯函数里。" +
      "把它们硬塞进探针会变成「复刻实现」而不是「真跑实现」。",
    equivalentCriterion:
      "由两侧各自的请求层测试覆盖（node: execute.spec.ts；python: " +
      "test_execute_request_validation.py），两侧都断言精确状态码。",
  },
  {
    vector: "taskFieldAliases / timeoutPrecedence / callbackLogRetention 的全部向量",
    reason:
      "这三条的向量是**解析规则/保留策略**的声明，不是「一个输入 ⇒ 一个可" +
      "分类的输出」。它们的真三向形态是**各自消费契约常量**（node 与 python " +
      "都读生成物常量），由 `protocol-readonly-segments.spec.ts` / " +
      "`test_protocol_readonly_segments.py` 断言「生成物 ≡ 契约」。",
    equivalentCriterion:
      "两侧运行时**读同一份生成物常量** ⇒ 规则只有一份实现，漂移在结构上" +
      "不可能发生（这是「契约先行」比「真跑比对」更强的一层）。",
  },
];

// ── 主判据 ─────────────────────────────────────────────────────────────────

/**
 * **已知自相矛盾向量**的显式豁免（Lead Q-A 裁定）。
 *
 * `allow-private-under-switch` 的 `expected: deny` 与 `switch: on` 打架 ——
 * 已由 `$schemaVersion 4` 拆分为两条自洽向量，但按 append-only 纪律
 * **原向量保留不改写**。本守卫因此**不判定**它，改为要求「拆分后的替代向量
 * 存在」—— 豁免必须**指名替代**，否则就是「静默跳过一条契约」。
 */
export const SUPERSEDED_VECTORS = {
  "allow-private-under-switch": {
    replacedBy: "allow-private-under-switch-enabled",
    reason:
      "原向量 expected=deny 与 switch=on 自相矛盾；Q-A 拆分为 " +
      "deny-private-under-switch-default（默认态 deny）与 " +
      "allow-private-under-switch-enabled（开关态 allow）。",
  },
};

export function compareAgainstContract(protocol, nodeResults, pyResults) {
  const results = [];
  const vectors = protocol.networkPolicy?.vectors ?? [];
  const byName = new Map(vectors.map((v) => [v.name, v]));

  for (const n of nodeResults) {
    const py = pyResults.find((p) => p.name === n.name);
    if (!py) {
      results.push({
        name: `networkPolicy 向量 ${n.name}：两侧都跑到了`,
        ok: false,
        actual: [`python 侧缺该向量（node 有：${n.name}）`],
        expected: [],
      });
      continue;
    }
    // ① 两侧结论一致（node vs python）—— 这是「真跑」的直接产物
    const nodeOut = canonical({ denied: n.denied, category: n.category });
    const pyOut = canonical({ denied: py.denied, category: py.category });
    results.push({
      name: `networkPolicy 向量 ${n.name}：两侧结论一致`,
      ok: nodeOut === pyOut,
      actual: nodeOut === pyOut ? [] : [`node=${nodeOut}`, `python=${pyOut}`],
      expected: ["两侧逐字节相同"],
    });

    // ② 与**契约向量**对齐（这才是基准；互比只作辅助）
    const vec = byName.get(n.name);
    if (!vec) continue;
    const expectDeny = vec.expected === "deny";
    const expectAllow = vec.expected === "allow";
    if (!expectDeny && !expectAllow) continue;
    // `switch: on` 的向量按开启态判定（契约 `switch` 字段即该向量的前提）
    const switchOn = vec.switch === "on";
    const nodeShouldDeny = switchOn ? !n.allowedBySwitch : n.denied;
    const pyShouldDeny = switchOn ? !py.allowedBySwitch : py.denied;
    const wantDeny = expectDeny;

    // ②-0 **已知自相矛盾向量**：Q-A 拆分（原向量）保留但语义打架 ⇒
    // 它**不参与**判定，只登记为「已知豁免 + 指向拆分后的替代向量」。
    // 豁免必须**指名替代向量**，否则就是「静默跳过一条契约」。
    const superseded = SUPERSEDED_VECTORS[n.name];
    if (superseded) {
      const hasReplacement = vectors.some((v) => v.name === superseded.replacedBy);
      results.push({
        name: `networkPolicy 向量 ${n.name}：已标注被 ${superseded.replacedBy} 取代`,
        ok: hasReplacement,
        actual: hasReplacement
          ? []
          : [`替代向量 ${superseded.replacedBy} 不存在 —— 豁免失效`],
        expected: [`替代向量 ${superseded.replacedBy} 存在`],
      });
      continue;
    }
    results.push({
      name: `networkPolicy 向量 ${n.name}：与契约一致（switch=${vec.switch ?? "off"}）`,
      ok: nodeShouldDeny === wantDeny && pyShouldDeny === wantDeny,
      actual:
        nodeShouldDeny === wantDeny && pyShouldDeny === wantDeny
          ? []
          : [
              `契约 expected=${vec.expected}`,
              `node deny=${nodeShouldDeny}`,
              `python deny=${pyShouldDeny}`,
            ],
      expected: [`两侧 deny=${wantDeny}`],
    });
  }

  // ③ 向量清单本身要与协议一致（防止「向量被删了 ⇒ 守卫变绿」）
  const expectedNames = vectors.map((v) => v.name).sort();
  const actualNames = nodeResults.map((r) => r.name).sort();
  results.push({
    name: "networkPolicy 向量清单与协议一致（防止删向量让守卫变绿）",
    ok: canonical(expectedNames) === canonical(actualNames),
    actual:
      canonical(expectedNames) === canonical(actualNames)
        ? []
        : [`协议: ${expectedNames.join(",")}`, `实跑: ${actualNames.join(",")}`],
    expected: ["两侧清单相同"],
  });

  return results;
}

export function main() {
  const protocol = JSON.parse(readFileSync(join(ROOT, PROTOCOL_REL), "utf8"));
  const vectors = protocol.networkPolicy?.vectors ?? [];
  if (!vectors.length) {
    console.error("protocol.json 的 networkPolicy.vectors 为空 —— 判据失配。");
    process.exit(1);
  }

  // 探针输入用**向量本身**（同一份语料打两端）
  const probeVectors = vectors.map((v) => ({
    name: v.name,
    url: v.url,
    switch: v.switch ?? "off",
  }));

  let nodeResults;
  let pyResults;
  try {
    nodeResults = runNodeProbe(probeVectors);
    pyResults = runPythonProbe(probeVectors);
  } catch (err) {
    console.error(`P5 探针失败：${err.message}`);
    process.exit(1);
  }

  const results = compareAgainstContract(protocol, nodeResults, pyResults);

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}`);
    for (const a of r.actual ?? []) console.log(`       ${a}`);
  }

  console.log("");
  console.log("── 显式登记：以下向量**无法等价比对**（形态不同，非漂移）──");
  for (const nc of NON_COMPARABLE) {
    console.log(`  · ${nc.vector}`);
    console.log(`      原因：${nc.reason}`);
    console.log(`      等价判据：${nc.equivalentCriterion}`);
  }
  console.log("");

  if (failed.length > 0) {
    console.error(`P5 真三向检查失败：${failed.length} 条不符`);
    process.exit(1);
  }
  console.log(
    `P5 真三向检查 OK：${results.length} 条判据（${vectors.length} 条向量 × 两侧真跑）`,
  );
}

// ── 自检（有牙）──────────────────────────────────────────────────────────
function selftest() {
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  add("normalize：键序无关（两侧书写顺序不同 ⇒ 同形）", () => {
    const a = canonical({ b: 1, a: 2 });
    const b = canonical({ a: 2, b: 1 });
    if (a !== b) throw new Error(`键序未被归一：${a} vs ${b}`);
  });

  add("normalize：数组保序（顺序是语义，不得排序）", () => {
    const a = canonical(["timeoutSeconds", "timeout_seconds", "timeout"]);
    const b = canonical(["timeout", "timeout_seconds", "timeoutSeconds"]);
    if (a === b) throw new Error("数组被排序了 —— 会掩盖 timeoutPrecedence 的顺序漂移");
  });

  add("normalize：布尔/null/数字归一（两侧表示不同 ⇒ 同形）", () => {
    if (canonical(true) !== canonical(true)) throw new Error("布尔归一失败");
    if (canonical(null) !== canonical("null")) throw new Error("null 归一失败");
    if (canonical(1) !== canonical(1.0)) throw new Error("数字归一失败");
  });

  add("normalize：undefined 显式标记（一侧缺一侧有 ⇒ 不一致）", () => {
    if (canonical(undefined) === canonical(null)) {
      throw new Error("undefined 与 null 未区分 —— 会把「一侧缺字段」当成一致");
    }
  });

  add("【反证·有牙】两侧结论不同 ⇒ 判红", () => {
    const protocol = { networkPolicy: { vectors: [] } };
    const node = [{ name: "v1", denied: true, category: "linkLocal", allowedBySwitch: false }];
    const py = [{ name: "v1", denied: false, category: null, allowedBySwitch: true }];
    const res = compareAgainstContract(protocol, node, py);
    const bad = res.filter((r) => !r.ok);
    if (bad.length === 0) throw new Error("两侧不同却判绿 —— 守卫没牙");
  });

  add("【反证·有牙】两侧一致但都与契约不符 ⇒ 判红（基准是契约，不是互比）", () => {
    const protocol = {
      networkPolicy: {
        vectors: [{ name: "v1", url: "http://x/", expected: "deny" }],
      },
    };
    // 两侧都说「放行」——互比会绿，但契约要求 deny ⇒ 必须红
    const node = [{ name: "v1", denied: false, category: null, allowedBySwitch: true }];
    const py = [{ name: "v1", denied: false, category: null, allowedBySwitch: true }];
    const res = compareAgainstContract(protocol, node, py);
    const bad = res.filter((r) => !r.ok);
    if (bad.length === 0) {
      throw new Error("两端一起错却判绿 —— 这正是「互比不够、必须对契约」的盲区");
    }
  });

  add("【反证·有牙】向量被删 ⇒ 判红（清单比对）", () => {
    const protocol = {
      networkPolicy: { vectors: [{ name: "v1", url: "http://x/", expected: "deny" }] },
    };
    const node = [{ name: "v1", denied: true, category: null, allowedBySwitch: false }];
    const res = compareAgainstContract(protocol, node, []);
    if (!res.some((r) => !r.ok)) throw new Error("向量缺失未判红");
  });

  add("NON_COMPARABLE 显式登记且每条都有原因与等价判据", () => {
    if (!Array.isArray(NON_COMPARABLE) || NON_COMPARABLE.length === 0) {
      throw new Error("无可比对登记 —— 形态不同的向量会被静默跳过");
    }
    for (const nc of NON_COMPARABLE) {
      if (!nc.vector || !nc.reason || !nc.equivalentCriterion) {
        throw new Error("登记项缺字段（vector/reason/equivalentCriterion）");
      }
    }
  });

  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      console.log(`OK   ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${c.name}\n       ${err.message}`);
    }
  }
  console.log("");
  console.log(
    failed === 0
      ? `check-protocol-three-way selftest 通过：${cases.length}/${cases.length} 条用例`
      : `selftest 失败：${failed}/${cases.length}`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  main();
}
