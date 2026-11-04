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
 * ## 第四面（admin-api）—— 2026-11-05 补的洞
 *
 * 上面那套只覆盖 contract ↔ node ↔ python **三面**，而**真正会发出站请求的还有
 * 第四面**：`apps/admin-api/src/common/utils/safe-http.util.ts` 的
 * `assertAndPinHttpUrl({policy:'executor'})` —— dispatch / broadcast /
 * reload-config / package push / gitRepo 全走它。它此前**不在任何一致性判据里**，
 * 于是「三向全绿」给出的是**虚假完备感**（方法学 59：名字里的数字是**声称**的
 * 覆盖面，不是**实际**的覆盖面）。第十二轮真机实测：它与契约 `networkPolicy`
 * **有五格相反**，而且这五格谁都没发现过。
 *
 * ⇒ 本脚本现在是**四向**。文件名保留 `three-way` 是**历史包袱**（改名会连带
 * package.json / CI / 文档）；这里显式说明，就是为了不让名字第二次制造同样的错觉。
 *
 * 三条设计（与前三面同款，可逐条审查）：
 *   ⓪ 覆盖的是 admin 的**两个**执行器出站入口（`assertAndPinHttpUrl({policy:'executor'})`
 *      与 `assertSafeExecutorUrl`——后者今天仍有 5 个非测试调用点），且要求两者对同一
 *      输入给出同一结论（这条**不可豁免**：两个入口分歧没有任何正当理由）。
 *   ① 第四面**真跑**，不是静态读源码：用 admin-api **自己的** `ts-node/register`
 *      （devDependency）起子进程，跑真 `assertAndPinHttpUrl`。理由见 `ADMIN_PROBE`
 *      头注 —— 这处分叉的源码**读起来各自都自洽**（"private-lan 恒放行"在 executor
 *      姿态里是有注释的有意行为），只有跑起来才知道每格给的是 allow 还是 deny。
 *   ② 判据是**逐格**的：`networkPolicy.addresses` 里每个「地址类」× 开关两态 =
 *      一格（由**数据**推出，不是数文案里的"六类"——`switch.semantics` 那句
 *      "其余五类"后面其实列了六个名字，数文案就会把覆盖面写成假的）。
 *      **每一格都要求 node / python / admin 三侧**都与契约一致。
 *   ③ 不一致**不直接判红**：必须先被 `scripts/protocol-four-way-allowlist.json`
 *      显式登记（`id/scope/why/owner/review_by/knownGapId`）。没登记 ⇒ 红；
 *      登记了但那一格**已经变一致** ⇒ 红（**腐烂：豁免必须回收**）；
 *      `review_by` 过期 ⇒ 红（到期即红）。这与本仓 `check-handwritten-copies` /
 *      `check-guards-wired` 的豁免纪律同族。
 *
 * ⚠️ 已知分叉 `knownGap: admin-side-outbound-posture-diverges-from-contract`
 * （owner=`executor-parity`，`review_by=2026-12-15`）**本轮不修行为**：改姿态是
 * "安全收紧 + 有部署影响"的变更（内网执行器未开开关会立刻被拒，须同批补
 * compose/.env），必须独立一轮做四步收口。本脚本只负责让"它还在不在"变成
 * **每条 CI 都会回答**的问题，而不是靠人记得。
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
 * devDependency），故子进程的 cwd 必须是那个目录。第四面（admin-api）同款。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isoDay, parseDay, utcDay } from "./lib/ratchet-baseline.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL_REL = "packages/executor-protocol/protocol.json";

const NODE_APP = join(ROOT, "apps/executor-node");
const PY_APP = join(ROOT, "apps/executor-python");
const ADMIN_APP = join(ROOT, "apps/admin-api");

/** 第四面被测文件（仓库相对路径；探针按绝对路径 require）。 */
const ADMIN_UTIL_REL = "src/common/utils/safe-http.util.ts";
/** 显式登记当前分叉的豁免账（与 `protocol-breaking-acknowledgements.json` 同款定位）。 */
const FOUR_WAY_ALLOWLIST_REL = "scripts/protocol-four-way-allowlist.json";
/** knownGap 台账（只在**读得到**时做"豁免必须指向真实缺口"的子判据）。 */
const CLAIMS_REL = "docs/PLAN-CLAIMS.md";

/** 网格键的分隔符：地址里不含 `~`（含 `:` 的 IPv6 会毁掉 `::` 分隔）。 */
const GRID_SEP = "~";
const GRID_PREFIX = "grid";
const GRID_STATES = ["off", "on"];
/**
 * `networkPolicy.addresses` 里**不是地址类**的条目。
 *
 * `ipv4Mapped` 的规则是「按内嵌 IPv4 判定」⇒ 同一个"类"里不同例子结论不同
 * （`::ffff:8.8.8.8` 放行、`::ffff:127.0.0.1` 拒），一个
 * `allowedUnderPrivateNetwork` 布尔**表达不了**它 ⇒ 不进网格，由 `ipv4Mapped`
 * 的**向量族**逐条覆盖。**显式排除而不是悄悄少一行。**
 */
const FORM_ONLY_CLASSES = new Set(["ipv4Mapped"]);

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

// ── 第四面：admin-api 出站闸（真跑；不是静态读源码）──────────────────────
/**
 * admin 侧探针：**真跑** `apps/admin-api/src/common/utils/safe-http.util.ts` 的
 * `assertAndPinHttpUrl(rawUrl, { policy: "executor", allowPrivateNetwork })`。
 *
 * ## 为什么必须是子进程真跑
 *
 * 这处分叉的源码**读起来各自都自洽**：`allowedExecutor` 里"private-lan 恒放行"
 * 有一条完整注释解释"执行器就住在内网"—— 静态 diff 会判它"符合注释所述设计"。
 * 只有跑起来才知道**这一格给的是 allow 还是 deny**，以及 admin 自己把它归成了
 * 哪一类（`classifyAddressRisk` / `addressRiskSegmentId` 一并回传，用来解释分叉）。
 *
 * ## 三个必须说清的边界（都是"不许伪造结论"那条纪律的落地）
 *
 * ① **DNS**：`assertAndPinHttpUrl` 对**主机名**形态会真的 `lookup()`。本探针把
 *    「名字 ⇒ 地址」钉成**固定表**（只登记 `localhost ⇒ 127.0.0.1`），父进程
 *    **只把 IP 字面量与该表里的名字**送进来。其它主机名一律标 `unsupported`
 *    （`dns-required`）而**不**调用实现 —— 否则实现会走 fail-closed 的
 *    `SSRF_HOST_DNS_LOOKUP_FAILED` 分支，把**环境**（这台机器不解析那个名字）
 *    误读成**契约判定**（"契约也要求拒"）。那是假绿的一种。
 * ② **副作用**：本函数只做校验 + 构造 `{url,pinnedIp,pinned}`，**不打开 socket**。
 *    探针**刻意不调用** `pinnedAxiosConfig()`（那才会造 http(s).Agent），也不
 *    `require` http/https ⇒ 结构上不可能发出请求。
 * ③ **不依赖环境变量**：开关两态由 `allowPrivateNetwork` 显式传入，**不读**
 *    `EXECUTOR_ALLOW_PRIVATE_NETWORK` 的真实取值（否则判据跟着 `.env` 走）。
 */
const ADMIN_PROBE = `
const ADMIN = process.argv[2];
const { isIP } = require("node:net");
const dns = require("node:dns/promises");

// 离线 DNS 桩（见本文件头注的边界①）：只有 localhost 有确定答案。
const DNS_STUB = { localhost: ["127.0.0.1"] };
dns.lookup = async (host) => {
  const hit = DNS_STUB[String(host).toLowerCase()];
  if (!hit) { const e = new Error("ENOTFOUND " + host); e.code = "ENOTFOUND"; throw e; }
  return hit.map((address) => ({ address, family: 4 }));
};

const util = require(ADMIN + "/${ADMIN_UTIL_REL}");
const inputs = JSON.parse(process.argv[3]);
const out = [];
(async () => {
for (const input of inputs) {
  let url;
  try { url = new URL(input.url); } catch { out.push({ key: input.key, unsupported: "invalid-url" }); continue; }
  const host = url.hostname.replace(/^\\[|\\]$/g, "");
  const literal = isIP(host) !== 0;
  const stubbed = Object.prototype.hasOwnProperty.call(DNS_STUB, host.toLowerCase());
  if (!literal && !stubbed) { out.push({ key: input.key, unsupported: "dns-required", host }); continue; }
  const probeHost = literal ? host : DNS_STUB[host.toLowerCase()][0];
  const row = { key: input.key, offline: literal ? "ip-literal" : "stubbed-dns", verdicts: {}, envVerdicts: {} };
  for (const state of ["off", "on"]) {
    // 第二个入口：assertSafeExecutorUrl 是**同一姿态的第二份实现**（5 个调用点仍在用它）。
    // 它没有 allowPrivateNetwork 参数，只能经 EXECUTOR_ALLOW_PRIVATE_NETWORK 两态。
    // 判据见 compareAdminVariants：两个入口对同一输入必须同结论。
    process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK = state === "on" ? "true" : "false";
    try {
      await util.assertSafeExecutorUrl(input.url);
      row.envVerdicts[state] = "accept";
    } catch (err) {
      row.envVerdicts[state] = "reject";
    }
    try {
      const target = await util.assertAndPinHttpUrl(input.url, {
        policy: "executor",
        allowPrivateNetwork: state === "on",
      });
      row.verdicts[state] = {
        verdict: "accept",
        pinnedIp: target.pinnedIp,
        pinned: target.pinned === true,
        risk: util.classifyAddressRisk(target.pinnedIp),
        segment: util.addressRiskSegmentId(target.pinnedIp),
        errorCode: null,
      };
    } catch (err) {
      row.verdicts[state] = {
        verdict: "reject",
        pinnedIp: null,
        pinned: false,
        risk: util.classifyAddressRisk(probeHost),
        segment: util.addressRiskSegmentId(probeHost),
        errorCode: err && err.errorCode ? String(err.errorCode) : null,
      };
    }
  }
  out.push(row);
}
process.stdout.write(JSON.stringify(out));
})();
`;

/**
 * 起子进程真跑 admin 侧实现。
 *
 * 通道：admin-api **自己的** `ts-node/register`（devDependency，与 node 侧同款）。
 * cwd 必须是 `apps/admin-api`（ts-node 的 tsconfig 解析根）；探针文件写在**临时
 * 目录**（不落 `apps/**` —— 本守卫对被测目录只读）。
 *
 * **ts-node 缺失 ⇒ 硬失败**，不许退化成"静态读源码猜一下"：那正是本洞的成因。
 */
function runAdminProbe(inputs) {
  const dir = mkdtempSync(join(tmpdir(), "p5-admin-"));
  const probePath = join(dir, "admin-probe.cjs");
  writeFileSync(probePath, ADMIN_PROBE, "utf8");
  try {
    const register = join(ADMIN_APP, "node_modules", "ts-node", "register", "index.js");
    if (!existsSync(register)) {
      throw new Error(
        `admin 侧 ts-node/register 不存在（${register}）—— 第四面要求**真跑** TS 实现，` +
          "本守卫拒绝退化成静态读源码（静态读源码看不出这处分叉）",
      );
    }
    const r = spawnSync(
      process.execPath,
      ["--require", register, probePath, ADMIN_APP, JSON.stringify(inputs)],
      { cwd: ADMIN_APP, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
    );
    if (r.status !== 0) {
      throw new Error(
        `admin 侧探针失败（status=${r.status}）：\n${r.stderr || r.stdout}`,
      );
    }
    const lines = String(r.stdout).trim().split("\n");
    return JSON.parse(lines[lines.length - 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

// ── 逐格判据：契约 × 三侧（node / python / admin）× 开关两态 ─────────────
/**
 * 网格的「类」从**数据**推，不从文案数。
 *
 * `networkPolicy.switch.semantics` 写「开关开启 ⇒ 放行 privateIPv4；**其余五类**
 * 一律仍拒」，括号里却列了**六个**名字（loopback / linkLocal / cgnat /
 * unspecified / multicast / reserved）。**数文案会把覆盖面写成假的**（方法学 59
 * 的同一个坑）⇒ 类从 `addresses` 里推：凡带布尔 `allowedUnderPrivateNetwork`
 * 的条目就是一个地址类（本轮 **7 个**），`ipv4Mapped` 例外（见 `FORM_ONLY_CLASSES`）。
 */
export function buildGridClasses(protocol) {
  const addresses = protocol?.networkPolicy?.addresses ?? {};
  const classes = [];
  for (const [name, spec] of Object.entries(addresses)) {
    if (FORM_ONLY_CLASSES.has(name)) continue;
    if (typeof spec?.allowedUnderPrivateNetwork !== "boolean") continue;
    const declared = Array.isArray(spec?.examples) ? spec.examples : [];
    classes.push({
      name,
      examples: declared.filter((e) => typeof e === "string" && e.length > 0),
      declaredCount: declared.length,
      allowedUnderPrivateNetwork: spec.allowedUnderPrivateNetwork,
    });
  }
  return classes;
}

/**
 * 契约的开关语义本身：**只有** `allowedUnderPrivateNetwork: true` 的类在 `on` 态放行。
 * 这就是"开关开启 ⇒ 放行 privateIPv4；其余一律仍拒"的机器可判形态。
 */
export function expectedVerdict(cls, state) {
  return cls.allowedUnderPrivateNetwork === true && state === "on" ? "accept" : "reject";
}

/** IPv6 字面量进 URL 必须带方括号；主机名形态原样。 */
export function probeUrlForHost(host) {
  return `http://${String(host).includes(":") ? `[${host}]` : host}/x.git`;
}

export function buildGridInputs(classes) {
  return classes.flatMap((cls) =>
    cls.examples.map((example) => ({ cls: cls.name, example, url: probeUrlForHost(example) })),
  );
}

export function gridProbeName(cls, example, state) {
  return [GRID_PREFIX, cls, example, state].join(GRID_SEP);
}

export function splitGridProbeName(name) {
  const parts = String(name ?? "").split(GRID_SEP);
  if (parts.length !== 4 || parts[0] !== GRID_PREFIX) return null;
  return { cls: parts[1], example: parts[2], state: parts[3] };
}

export function adminGridKey(cls, example) {
  return [GRID_PREFIX, cls, example].join(GRID_SEP);
}

export function adminVectorKey(name) {
  return ["vector", name].join(GRID_SEP);
}

/**
 * 逐格比对：**任何一侧**与契约不一致，该格就是不一致。
 *
 * 三条刻意的设计：
 *   · 格 id 带**侧名**（`grid:<类>@<态>:<侧>`）⇒ "admin 的分叉豁免"**不会**顺带
 *     盖住"将来 node 的新分叉"。这与 `check-guards-wired` 把 ALLOWLIST 与
 *     SELFTEST_ALLOWLIST 分开是同一条理由：合并豁免会让第二种情形被第一种盖掉。
 *   · **缺行 ⇒ 红**（不是"这一项跳过"）：`check-agent-index-names` 那一轮的教训
 *     就是「只识别 2 条却报'2 条一致' = 绿」。
 *   · 唯一允许的"不判"是 admin 侧**显式标了 `unsupported`** 的例子（需要真实
 *     DNS），且它被**打印出来**而不是静默跳过；若一整格全是 unsupported ⇒ 结构红。
 */
export function compareGrid({ classes, nodeRows = [], pyRows = [], adminRows = [] }) {
  const structural = [];
  const cells = [];
  if (!Array.isArray(classes) || classes.length === 0) {
    structural.push(
      "网格为空：契约 networkPolicy.addresses 里没有任何可判的地址类（或解析失败）—— " +
        "空网格下「零不一致」是一句永真断言，必须结构红",
    );
    return { structural, cells };
  }
  const sides = ["node", "python", "admin"];
  const collect = (rows, side) => {
    const m = new Map();
    for (const row of rows ?? []) {
      if (side === "admin") {
        for (const state of GRID_STATES) {
          const v = row?.verdicts?.[state];
          if (!v) continue;
          m.set(`${row.key}#${state}`, {
            verdict: v.verdict === "accept" ? "accept" : "reject",
            label: [v.risk, v.segment].filter(Boolean).join("/") || "—",
          });
        }
        continue;
      }
      const k = splitGridProbeName(row?.name);
      if (!k) continue;
      m.set(`${GRID_PREFIX}${GRID_SEP}${k.cls}${GRID_SEP}${k.example}#${k.state}`, {
        verdict: row.denied ? "reject" : "accept",
        label: row.category ?? "—",
      });
    }
    return m;
  };
  const bySide = {
    node: collect(nodeRows, "node"),
    python: collect(pyRows, "python"),
    admin: collect(adminRows, "admin"),
  };
  const adminUnsupported = new Map();
  for (const row of adminRows ?? []) {
    if (row?.unsupported) adminUnsupported.set(row.key, row.unsupported);
  }

  for (const cls of classes) {
    if (cls.examples.length === 0) {
      structural.push(
        `grid:${cls.name} 在契约里没有任何可判例子（声明 ${cls.declaredCount} 个）—— 该类的两格没有判据`,
      );
      continue;
    }
    for (const state of GRID_STATES) {
      const expected = expectedVerdict(cls, state);
      const cell = {
        id: `grid:${cls.name}@${state}`,
        cls: cls.name,
        state,
        expected,
        checked: { node: 0, python: 0, admin: 0 },
        deviations: [],
        unsupported: [],
      };
      for (const example of cls.examples) {
        const base = adminGridKey(cls.name, example);
        for (const side of sides) {
          const got = bySide[side].get(`${base}#${state}`);
          if (!got) {
            const why = side === "admin" ? adminUnsupported.get(base) : null;
            if (why) {
              cell.unsupported.push(`${example}（admin: ${why}）`);
              continue;
            }
            cell.deviations.push({
              side,
              id: `${cell.id}:${side}`,
              detail: `${example} 没有判定（探针缺行 = 漏检，不是一致）`,
            });
            continue;
          }
          cell.checked[side] += 1;
          if (got.verdict !== expected) {
            cell.deviations.push({
              side,
              id: `${cell.id}:${side}`,
              detail: `${example} ⇒ ${got.verdict}（该侧判为 ${got.label}）`,
            });
          }
        }
      }
      if (cell.checked.admin === 0) {
        structural.push(
          `${cell.id} 没有任何 admin 判据（全部 unsupported）—— 该格不许算作一致`,
        );
      }
      cells.push(cell);
    }
  }
  return { structural, cells };
}

/**
 * 第四面的**向量级**判据：每条向量在它声明的状态（`switch`）下，admin 的结论必须
 * 等于契约 `expected`。
 *
 * 为什么向量级与逐格级都要：逐格说"哪一类错了"，向量级说"**哪条已发布的断言**
 * 错了"——后者是回归时第一个被人引用的东西。向量的**另一态**不在这里判（契约没
 * 断言它），由逐格覆盖。
 */
export function compareAdminVectors(protocol, adminRows = []) {
  const vectors = protocol?.networkPolicy?.vectors ?? [];
  const structural = [];
  const results = [];
  const byKey = new Map((adminRows ?? []).map((r) => [r.key, r]));
  for (const v of vectors) {
    const state = v.switch === "on" ? "on" : "off";
    const id = `vector:${v.name}@${state}`;
    if (SUPERSEDED_VECTORS[v.name]) {
      results.push({
        id,
        name: `${id}：已标注被 ${SUPERSEDED_VECTORS[v.name].replacedBy} 取代 ⇒ 不判`,
        ok: true,
        judged: false,
        actual: [],
      });
      continue;
    }
    if (v.expected !== "allow" && v.expected !== "deny") {
      structural.push(`${id} 的 expected=${JSON.stringify(v.expected)} 既不是 allow 也不是 deny`);
      continue;
    }
    const row = byKey.get(adminVectorKey(v.name));
    if (row?.unsupported) {
      results.push({
        id,
        name: `${id}：unsupported（${row.unsupported}）`,
        ok: true,
        judged: false,
        actual: ["主机名需要真实 DNS —— 本守卫不把「这台机器不解析」当成「契约要求拒」"],
      });
      continue;
    }
    const got = row?.verdicts?.[state];
    if (!got) {
      structural.push(`${id}：admin 侧探针没有这一行（漏检 = 红）`);
      continue;
    }
    const want = v.expected === "allow" ? "accept" : "reject";
    const ok = got.verdict === want;
    results.push({
      id,
      name: `${id}：admin ${ok ? "与契约一致" : "与契约不一致"}`,
      ok,
      judged: true,
      actual: ok
        ? []
        : [
            `契约 expected=${v.expected}（${state} 态）`,
            `admin ⇒ ${got.verdict}（判为 ${[got.risk, got.segment].filter(Boolean).join("/") || "—"}）`,
          ],
    });
  }
  return { structural, results };
}

/**
 * admin 侧**两个**执行器出站入口的一致性（`assertAndPinHttpUrl({policy:'executor'})`
 * 与 `assertSafeExecutorUrl`）。
 *
 * 为什么单列一条判据：这两份实现是**同一个姿态两处写**（前者带
 * `allowPrivateNetwork` 参数，后者只能经 `EXECUTOR_ALLOW_PRIVATE_NETWORK` 两态），
 * 而 `assertSafeExecutorUrl` 到今天仍有 5 个非测试调用点。两者 2026-11-05 实测
 * 37 个输入 × 两态 **0 差异** ⇒ 这条判据现在应当是绿的；它约束的是**将来**：
 * 改了一个忘了另一个 ⇒ 红。
 *
 * 它**不可豁免**：两个入口给出不同结论没有任何正当理由（要给理由就得先改设计）。
 */
export function compareAdminVariants(adminRows = []) {
  const structural = [];
  const diffs = [];
  for (const row of adminRows ?? []) {
    if (row?.unsupported) continue;
    for (const state of GRID_STATES) {
      const pin = row?.verdicts?.[state]?.verdict;
      const env = row?.envVerdicts?.[state];
      if (!pin || !env) {
        structural.push(`${row.key}@${state}：两个 admin 入口有一侧没有判定（漏检 = 红）`);
        continue;
      }
      if (pin !== env) {
        diffs.push(
          `admin-variant:${row.key}@${state}：assertAndPinHttpUrl=${pin} 但 assertSafeExecutorUrl=${env}`,
        );
      }
    }
  }
  return { structural, diffs };
}

// ── 豁免账（显式登记当前分叉 + 腐烂检测 + 到期即红）──────────────────────
export function readFourWayAllowlist(root = ROOT, rel = FOUR_WAY_ALLOWLIST_REL) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    return {
      data: null,
      error:
        `${rel} 不存在 —— 当前分叉必须有**显式豁免账**；` +
        "缺文件不许解释成「没有豁免 = 没有分叉」",
    };
  }
  try {
    return { data: JSON.parse(readFileSync(abs, "utf8")), error: null };
  } catch (err) {
    return { data: null, error: `${rel} 解析失败：${err.message}` };
  }
}

const SCOPE_ID_RE = /^(grid|vector):\S+@(off|on)(?::(node|python|admin))?$/;

/**
 * 豁免账的四条判据（与 `check-handwritten-copies` / `check-guards-wired` 同族）。
 *
 *   ① **结构**：entries 非空；每条 `id/scope/why/owner/review_by/knownGapId` 齐且形制
 *      正确；同一格不许被两条同时登记（双重登记 ⇒ 删一条时另一条静默接管）；
 *      `knownGapId` 必须在 knownGap 台账里真实出现（豁免必须**指名**缺口）。
 *   ② **到期即红**：`review_by` 已过 ⇒ 红 —— 过期的意思是"当初答应复核的人没有
 *      复核"，不是"继续躺着"。
 *   ③ **覆盖**：每个当前不一致的格都必须被登记 ⇒ 否则红（这是本守卫的核心价值：
 *      把"哪一格不一致"说清，而不是笼统一句"姿态不同"）。
 *   ④ **腐烂**：登记的格**已经一致** ⇒ 红，要求删条目（豁免必须回收；这条与
 *      `check-size-caps` 的"已降回阈值内 ⇒ 删基线条目"是同一台棘轮）。
 */
export function judgeAllowlist({
  failing = [],
  allowlist,
  today,
  rel = FOUR_WAY_ALLOWLIST_REL,
  knownGapDoc = null,
}) {
  const results = [];
  const fail = (name, actual = []) => results.push({ name: `${rel}：${name}`, ok: false, actual });
  const pass = (name, actual = []) => results.push({ name: `${rel}：${name}`, ok: true, actual });

  const entries = Array.isArray(allowlist?.entries) ? allowlist.entries : null;
  if (!entries) {
    fail("结构：缺少 `entries` 数组 —— 豁免账退化成空文档");
    return results;
  }
  // R05（2026-11-05）：**空表不再无条件红** —— 判据意图是「有分叉却空表 = 判据被关灯」。
  // 本轮把 admin 姿态的最后两格按契约收口后，真实分叉数为 **0**，此时「必须非空」会让
  // 守卫永远无法变绿（等价于逼人留一条假豁免）。⇒ 改为**有条件**：零分叉时空表是**终态**；
  // 有分叉时空表仍红（原意图原样保留，且由 selftest 两个方向各自钉住）。
  if (entries.length === 0) {
    if (Array.isArray(failing) && failing.length === 0) {
      pass("结构：豁免账为空且当前零分叉（顶格收口，不是关灯）");
      return results;
    }
    fail("结构：`entries` 为空 —— 当前仍有分叉却无登记（空表 = 判据被关灯）", failing ?? []);
    return results;
  }

  const seenIds = new Set();
  const owner = new Map();
  const structureIssues = [];
  const expired = [];
  const rotten = [];
  const scoped = new Set();
  for (const [i, e] of entries.entries()) {
    const tag = `entries[${i}]（${e?.id ?? "无 id"}）`;
    for (const field of ["id", "owner", "review_by", "knownGapId"]) {
      if (typeof e?.[field] !== "string" || e[field].trim() === "") {
        structureIssues.push(`${tag} 缺必填字段 ${field}`);
      }
    }
    if (typeof e?.why !== "string" || e.why.trim().length < 20) {
      structureIssues.push(`${tag} 的 why 不足 20 字 —— 说不清"为什么现在不改"的豁免不是豁免`);
    }
    if (e?.id && seenIds.has(e.id)) structureIssues.push(`${tag} 的 id 重复`);
    if (e?.id) seenIds.add(e.id);
    if (!Array.isArray(e?.scope) || e.scope.length === 0) {
      structureIssues.push(`${tag} 缺 scope（哪几格不一致）—— 没有 scope 的豁免是"整表放行"`);
      continue;
    }
    if (typeof e.review_by === "string") {
      const day = parseDay(e.review_by);
      if (day === null) {
        structureIssues.push(
          `${tag} 的 review_by=${JSON.stringify(e.review_by)} 不是合法 YYYY-MM-DD —— 没有可判定的期限 = 无限期豁免`,
        );
      } else if (typeof today === "number" && day < today) {
        expired.push(`${tag} 的 review_by=${e.review_by} 已于 ${isoDay(day)} 过期（今天 ${isoDay(today)}）`);
      }
    }
    if (typeof e.knownGapId === "string" && knownGapDoc !== null && !knownGapDoc.includes(e.knownGapId)) {
      structureIssues.push(`${tag} 的 knownGapId=${e.knownGapId} 在 ${CLAIMS_REL} 里找不到 —— 豁免指向一个不存在的缺口`);
    }
    for (const id of e.scope) {
      if (typeof id !== "string" || !SCOPE_ID_RE.test(id)) {
        structureIssues.push(`${tag} 的 scope 项 ${JSON.stringify(id)} 形制不对（应形如 grid:<类>@<态>:<侧> 或 vector:<名>@<态>）`);
        continue;
      }
      if (owner.has(id)) {
        structureIssues.push(`格 ${id} 被 ${owner.get(id)} 与 ${e.id} 双重登记 —— 删一条时另一条会静默接管`);
      }
      owner.set(id, e.id);
      scoped.add(id);
    }
  }

  if (structureIssues.length > 0) {
    fail("结构校验未通过", structureIssues);
  } else {
    pass(`结构校验通过（${entries.length} 条，共登记 ${scoped.size} 格）`);
  }

  if (expired.length > 0) fail("到期即红：以下豁免的 review_by 已过期", expired);
  else pass("到期检查通过（无过期豁免）");

  const failingSet = new Set(failing);
  const unregistered = [...failingSet].filter((id) => !scoped.has(id));
  if (unregistered.length > 0) {
    fail(
      `未登记的格不一致（${unregistered.length} 格）—— 逐格点名如下`,
      unregistered.map((id) => `${id}：与契约不一致且没有登记在 ${rel}`),
    );
  } else {
    pass(`覆盖检查通过（当前 ${failingSet.size} 格不一致，全部已登记）`);
  }

  for (const id of scoped) {
    if (!failingSet.has(id)) rotten.push(`${id}：登记的格**已经一致**`);
  }
  if (rotten.length > 0) {
    fail(
      `豁免腐烂（${rotten.length} 格）—— 分叉已修好，必须删掉对应 scope 项（整条的 scope 全腐烂 ⇒ 删掉整条）`,
      rotten,
    );
  } else {
    pass("腐烂检查通过（登记的格都还在分叉 —— 豁免没有变成摆设）");
  }

  return results;
}

export function main() {
  const protocol = JSON.parse(readFileSync(join(ROOT, PROTOCOL_REL), "utf8"));
  const vectors = protocol.networkPolicy?.vectors ?? [];
  if (!vectors.length) {
    console.error("protocol.json 的 networkPolicy.vectors 为空 —— 判据失配。");
    process.exit(1);
  }

  const classes = buildGridClasses(protocol);
  const gridInputs = buildGridInputs(classes);

  // 同一份语料打三侧：node / python 的探针形状是 {name,url,switch}
  const probeVectors = [
    ...vectors.map((v) => ({ name: v.name, url: v.url, switch: v.switch ?? "off" })),
    ...gridInputs.flatMap((g) =>
      GRID_STATES.map((state) => ({
        name: gridProbeName(g.cls, g.example, state),
        url: g.url,
        switch: state,
      })),
    ),
  ];
  // 第四面的输入：网格例子（每个一次，回传两态）+ 向量（每条一次，回传两态）
  const adminInputs = [
    ...gridInputs.map((g) => ({ key: adminGridKey(g.cls, g.example), url: g.url })),
    ...vectors.map((v) => ({ key: adminVectorKey(v.name), url: v.url })),
  ];

  let nodeResults;
  let pyResults;
  let adminResults;
  try {
    nodeResults = runNodeProbe(probeVectors);
    pyResults = runPythonProbe(probeVectors);
    adminResults = runAdminProbe(adminInputs);
  } catch (err) {
    console.error(`P5 探针失败：${err.message}`);
    process.exit(1);
  }

  // 探针覆盖完整性：「漏检却报绿」只有条数能挡（方法学 53）
  const structural = [
    ...checkProbeCoverage("node", probeVectors, nodeResults, "name"),
    ...checkProbeCoverage("python", probeVectors, pyResults, "name"),
    ...checkProbeCoverage("admin", adminInputs, adminResults, "key"),
  ];

  const isGridRow = (r) => String(r?.name ?? "").startsWith(`${GRID_PREFIX}${GRID_SEP}`);
  const results = compareAgainstContract(
    protocol,
    nodeResults.filter((r) => !isGridRow(r)),
    pyResults.filter((r) => !isGridRow(r)),
  );
  const grid = compareGrid({ classes, nodeRows: nodeResults, pyRows: pyResults, adminRows: adminResults });
  const adminVectors = compareAdminVectors(protocol, adminResults);
  const adminVariants = compareAdminVariants(adminResults);
  structural.push(...grid.structural, ...adminVectors.structural, ...adminVariants.structural);

  // 当前不一致的格（幂等 id，带侧名）—— 只有「与契约不一致」进这张表
  const failingIds = [];
  for (const cell of grid.cells) for (const d of cell.deviations) failingIds.push(d.id);
  for (const r of adminVectors.results) if (!r.ok) failingIds.push(r.id);

  const allow = readFourWayAllowlist();
  const claimsPath = join(ROOT, CLAIMS_REL);
  const allowlistResults = allow.error
    ? [{ name: `${FOUR_WAY_ALLOWLIST_REL}：结构`, ok: false, actual: [allow.error] }]
    : judgeAllowlist({
        failing: failingIds,
        allowlist: allow.data,
        today: utcDay(),
        knownGapDoc: existsSync(claimsPath) ? readFileSync(claimsPath, "utf8") : null,
      });
  const scopedIds = new Set(
    (Array.isArray(allow.data?.entries) ? allow.data.entries : []).flatMap((e) =>
      Array.isArray(e?.scope) ? e.scope : [],
    ),
  );

  // ── 打印 ──────────────────────────────────────────────────────────────
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
  console.log(`── 第四面（admin-api 真跑）：逐格判据 —— ${classes.length} 类 × ${GRID_STATES.length} 态 = ${grid.cells.length} 格`);
  for (const cell of grid.cells) {
    const markOf = (devs) =>
      devs.length === 0 ? "OK   " : devs.every((d) => scopedIds.has(d.id)) ? "ALLOW" : "FAIL ";
    console.log(
      `${markOf(cell.deviations)} ${cell.id}  契约=${cell.expected}  ` +
        `判据数 node=${cell.checked.node}/python=${cell.checked.python}/admin=${cell.checked.admin}` +
        (cell.unsupported.length > 0 ? `  未判=${cell.unsupported.length}` : ""),
    );
    for (const d of cell.deviations) console.log(`         ${d.side}: ${d.detail}   [${d.id}]`);
    for (const u of cell.unsupported) console.log(`         · unsupported ${u}`);
  }

  console.log("");
  console.log("── 第四面：向量级（每条向量在它声明的状态下与契约比对）──");
  for (const r of adminVectors.results) {
    const mark =
      r.judged === false ? "N/A  " : r.ok ? "OK   " : scopedIds.has(r.id) ? "ALLOW" : "FAIL ";
    console.log(`${mark} ${r.name}`);
    for (const a of r.actual ?? []) console.log(`       ${a}`);
  }

  // 原始判定（**两态都取了**，不只是被判的那一态）：判据用哪一态写在名字里，
  // 但两态都打印出来 ⇒ 复核的人不用改脚本就能看到"开关翻转时它到底变没变"。
  console.log("");
  console.log("── 第四面：每条向量 × 开关两态（原始判定，accept / reject + 拒因分类）──");
  const adminByKey = new Map(adminResults.map((r) => [r.key, r]));
  for (const v of vectors) {
    const row = adminByKey.get(adminVectorKey(v.name));
    if (!row) {
      console.log(`  ${v.name}：admin 侧没有这一行（漏检）`);
      continue;
    }
    if (row.unsupported) {
      console.log(`  ${v.name}：unsupported（${row.unsupported}）`);
      continue;
    }
    const describe = (state) => {
      const got = row.verdicts?.[state];
      if (!got) return "—";
      return got.verdict === "accept"
        ? `accept(${got.pinnedIp ?? "?"}${got.pinned ? ",pinned" : ""})`
        : `reject(${got.errorCode ?? "?"}/${got.risk ?? "—"})`;
    };
    console.log(`  ${v.name}  off=${describe("off")}  on=${describe("on")}  [${row.offline}]`);
  }

  console.log("");
  console.log("── 第四面：admin 两个执行器入口互比（assertAndPinHttpUrl ↔ assertSafeExecutorUrl）──");
  console.log(
    `  ${adminVariants.diffs.length === 0 ? "OK   两个入口逐输入逐态同结论" : "FAIL 两个入口出现分歧（不可豁免）"}` +
      `（${adminInputs.length} 个输入 × 两态）`,
  );
  for (const d of adminVariants.diffs) console.log(`       ${d}`);

  console.log("");
  console.log("── 豁免账（显式登记当前分叉 / 腐烂检测 / 到期即红）──");
  for (const r of allowlistResults) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}`);
    for (const a of r.actual ?? []) console.log(`       ${a}`);
  }

  console.log("");
  console.log("── 覆盖边界（如实声明，别当成已覆盖）──");
  console.log(
    "  · 第四面真跑 **admin 的两个执行器出站入口**：`assertAndPinHttpUrl({policy:'executor'})`" +
      "（dispatch / broadcast / package push 等 8 处）与 `assertSafeExecutorUrl`（另 5 处），" +
      "并要求两者逐输入逐态同结论。" +
      "**不在本判据内**：`policy:'webhook'`（webhook/AI 目标）与 `assertSafeGitRepoUrl` 的姿态。",
  );
  console.log(
    "  · DNS：只有本探针固定表里的名字能离线判（当前仅 `localhost ⇒ 127.0.0.1`）；" +
      "其它主机名一律标 unsupported，**不伪造 DNS 结论**。",
  );
  console.log(
    `  · 网格不含 ${[...FORM_ONLY_CLASSES].join("/")}（规则是"按内嵌 IPv4 判"，一个布尔表达不了）——` +
      " 它由 ipv4Mapped 向量族覆盖；但向量只在各自**声明的**状态判 ⇒ " +
      "mapped 形态的**另一态**未判（要判它必须复刻「按内嵌 IPv4 分类」的逻辑，本守卫不复刻实现）。",
  );
  console.log(
    "  · 向量只在它**声明的** `switch` 状态下判；另一态由逐格覆盖（契约没断言它）。",
  );

  const hardFailures = [
    ...results.filter((r) => !r.ok).map((r) => `三向：${r.name}`),
    ...structural,
    ...allowlistResults.filter((r) => !r.ok).map((r) => `豁免账：${r.name}`),
    ...adminVariants.diffs,
  ];
  console.log("");
  if (hardFailures.length > 0) {
    console.error(`P5 真四向检查失败：${hardFailures.length} 条不符`);
    for (const h of hardFailures) console.error(`  · ${h}`);
    process.exit(1);
  }
  const judged = grid.cells.filter((c) => c.deviations.length > 0).length;
  console.log(
    `P5 真四向检查 OK：三向 ${results.length} 条 + 逐格 ${grid.cells.length} 格` +
      `（其中 ${judged} 格不一致但已显式登记）+ 第四面向量 ${adminVectors.results.filter((r) => r.judged).length} 条`,
  );
}

/**
 * 探针覆盖完整性：送进去 N 个输入，就必须回 N 行。
 *
 * 为什么单列一条：本仓已有一个「只识别 2 条却报'2 条一致'= 绿」的真事故
 * （`check-agent-index-names`）。**抽到的条数**是唯一能挡"漏检却报绿"的东西。
 */
function checkProbeCoverage(label, inputs, rows, keyField) {
  const issues = [];
  const want = inputs.map((i) => i[keyField]);
  const got = new Set((rows ?? []).map((r) => r?.[keyField]));
  const missing = want.filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !want.includes(k));
  if (missing.length > 0) {
    issues.push(
      `${label} 侧探针漏了 ${missing.length}/${want.length} 个输入（${missing.slice(0, 3).join(", ")}…）—— 漏检 = 红`,
    );
  }
  if (extra.length > 0) {
    issues.push(`${label} 侧探针回了 ${extra.length} 个没送进去的输入（${extra.slice(0, 3).join(", ")}…）`);
  }
  return issues;
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

  // ── 第四面（admin-api）与豁免账：有牙证据 ─────────────────────────────
  /**
   * 造一个**最小但自洽**的四向 fixture（2 类 × 2 态 = 4 格）。
   *
   * 先证明"自洽时全绿"，再逐项变异 —— 否则每条反证都可能只是"又造了一个必然
   * 会红的输入"，证明不了判据在哪一格上有牙。
   */
  const gridFixture = () => {
    const protocol = {
      networkPolicy: {
        addresses: {
          privateIPv4: { allowedUnderPrivateNetwork: true, examples: ["10.0.0.1"] },
          loopback: { allowedUnderPrivateNetwork: false, examples: ["127.0.0.1"] },
          // 形态类：不进网格（见 FORM_ONLY_CLASSES）。fixture 里刻意放进来钉住这一点。
          ipv4Mapped: { allowedUnderPrivateNetwork: false, examples: ["::ffff:10.0.0.1"] },
        },
      },
    };
    const classes = buildGridClasses(protocol);
    const nodeRows = [];
    const pyRows = [];
    const adminRows = [];
    for (const cls of classes) {
      for (const example of cls.examples) {
        for (const state of GRID_STATES) {
          const name = gridProbeName(cls.name, example, state);
          const denied = expectedVerdict(cls, state) === "reject";
          nodeRows.push({ name, denied, category: cls.name });
          pyRows.push({ name, denied, category: cls.name });
        }
        const verdicts = {};
        for (const state of GRID_STATES) {
          verdicts[state] = { verdict: expectedVerdict(cls, state), risk: cls.name };
        }
        adminRows.push({ key: adminGridKey(cls.name, example), verdicts });
      }
    }
    return { protocol, classes, nodeRows, pyRows, adminRows };
  };

  /** 自检用的假豁免条目（结构合法；`...over` 用来逐项变异）。 */
  const ackEntry = (over = {}) => ({
    id: "e1",
    scope: ["grid:privateIPv4@off:admin"],
    why: "自检用的假条目：为什么现在不改、改它会牵动什么，都写在这里，够二十个字。",
    owner: "executor-parity",
    review_by: "2099-01-01",
    knownGapId: "admin-side-outbound-posture-diverges-from-contract",
    ...over,
  });
  const TODAY = parseDay("2026-11-05");

  add("【正证】四向自洽的 fixture ⇒ 逐格零不一致（反证的前提）", () => {
    const f = gridFixture();
    const { structural, cells } = compareGrid(f);
    if (structural.length > 0) throw new Error(`自洽 fixture 却结构红：${structural.join("；")}`);
    if (cells.length !== 4) throw new Error(`格数=${cells.length}（期望 2 类 × 2 态 = 4；形态类不许进网格）`);
    const bad = cells.filter((c) => c.deviations.length > 0);
    if (bad.length > 0) {
      throw new Error(`自洽 fixture 却判不一致：${bad.map((c) => `${c.id}×${c.deviations.length}`).join(",")}`);
    }
  });

  add("【反证·有牙】admin 某一格不一致 ⇒ 红，并**点名该格 + 该侧**", () => {
    const f = gridFixture();
    const row = f.adminRows.find((r) => r.key === adminGridKey("privateIPv4", "10.0.0.1"));
    row.verdicts.off = { verdict: "accept", risk: "private-lan" }; // 契约拒 / admin 放行
    const { cells } = compareGrid(f);
    const cell = cells.find((c) => c.id === "grid:privateIPv4@off");
    if (!cell || cell.deviations.length === 0) throw new Error("admin 放行而契约要求拒，却没判红");
    const ids = cell.deviations.map((d) => d.id);
    if (!ids.includes("grid:privateIPv4@off:admin")) throw new Error(`没点名该格/该侧：${ids.join(",")}`);
    const other = cells.find((c) => c.id === "grid:privateIPv4@on");
    if (other.deviations.length > 0) throw new Error("另一态被牵连 —— 格之间没有互相独立");
  });

  add("【反证·有牙】某侧探针缺行 ⇒ 红（漏检不许当成一致）", () => {
    const f = gridFixture();
    f.nodeRows = f.nodeRows.filter((r) => r.name !== gridProbeName("loopback", "127.0.0.1", "on"));
    const { cells } = compareGrid(f);
    const cell = cells.find((c) => c.id === "grid:loopback@on");
    if (!cell || !cell.deviations.some((d) => d.id === "grid:loopback@on:node")) {
      throw new Error("node 缺该行却判绿 —— 「漏检却报绿」是本仓最危险的一类");
    }
  });

  add("【反证·有牙】某格 admin 全部 unsupported ⇒ 结构红（unsupported 不许变成全绿）", () => {
    const f = gridFixture();
    f.adminRows = f.adminRows.map((r) =>
      r.key === adminGridKey("loopback", "127.0.0.1") ? { key: r.key, unsupported: "dns-required" } : r,
    );
    const { structural } = compareGrid(f);
    if (!structural.some((s) => s.includes("grid:loopback@on") && s.includes("没有任何 admin 判据"))) {
      throw new Error(`整格无可判据却没结构红：${structural.join("；")}`);
    }
  });

  add("【结构红】网格为空 / 契约解析失败 ⇒ 红（不是「零不一致全绿」）", () => {
    for (const protocol of [{}, { networkPolicy: {} }, { networkPolicy: { addresses: {} } }]) {
      const classes = buildGridClasses(protocol);
      if (classes.length !== 0) throw new Error("解析失败却造出了类");
      const { structural, cells } = compareGrid({ classes, nodeRows: [], pyRows: [], adminRows: [] });
      if (structural.length === 0) throw new Error(`空网格被判绿：${JSON.stringify(protocol)}`);
      if (cells.length !== 0) throw new Error("空网格不该产出格");
    }
  });

  add("【结构红】向量 expected 既不是 allow 也不是 deny ⇒ 红（不许静默跳过一条契约）", () => {
    const protocol = {
      networkPolicy: { vectors: [{ name: "v", url: "http://10.0.0.1/", expected: "maybe" }] },
    };
    const { structural, results } = compareAdminVectors(protocol, []);
    if (structural.length === 0) throw new Error("非法 expected 被静默跳过");
    if (results.length !== 0) throw new Error("非法 expected 不该产出「已判定」的结果");
  });

  add("【反证·有牙】不一致的格没登记 ⇒ 红并逐格点名", () => {
    const res = judgeAllowlist({
      failing: ["grid:privateIPv4@off:admin"],
      allowlist: { entries: [ackEntry({ scope: ["grid:loopback@on:admin"] })] },
      today: TODAY,
    });
    const hit = res.find((r) => !r.ok && (r.actual ?? []).some((a) => a.includes("grid:privateIPv4@off:admin")));
    if (!hit) throw new Error("未登记的不一致没被逐格点名 —— 豁免账形同虚设");
  });

  add("【反证·有牙】allowlist 里那格**已经一致** ⇒ 红（腐烂：豁免必须回收）", () => {
    const res = judgeAllowlist({
      failing: [],
      allowlist: { entries: [ackEntry({ scope: ["grid:privateIPv4@off:admin"] })] },
      today: TODAY,
    });
    const hit = res.find((r) => !r.ok && r.name.includes("腐烂"));
    if (!hit) throw new Error("分叉修好了却仍绿 —— 豁免会变成永久放行");
    if (!(hit.actual ?? []).some((a) => a.includes("grid:privateIPv4@off:admin"))) {
      throw new Error("腐烂没点名是哪一格");
    }
  });

  // R05（2026-11-05）：两个方向各钉一条 —— 这轮把最后 5 格按契约收口后，豁免账合法为空。
  add("【R05 契约自洽】只有 privateIPv4 的 allowedUnderPrivateNetwork=true（switch.semantics 的机器可判形态）", () => {
    // 直接读**真契约**（不是 fixture）：这条判据的价值就在于它盯的是线上那份文件。
    const realProtocol = JSON.parse(readFileSync(join(ROOT, PROTOCOL_REL), "utf8"));
    const classes = buildGridClasses(realProtocol);
    const unlocked = classes.filter((c) => c.allowedUnderPrivateNetwork).map((c) => c.name);
    if (unlocked.length !== 1 || unlocked[0] !== "privateIPv4") {
      throw new Error(
        `契约 switch.semantics 说「开关开启 ⇒ 放行 privateIPv4；其余一律仍拒」，` +
          `但 allowedUnderPrivateNetwork=true 的类是 ${JSON.stringify(unlocked)} —— 契约与自身文案不一致`,
      );
    }
    // 逐类把「开关的期望结论」钉死：loopback 任何状态都拒。
    const loopback = classes.find((c) => c.name === "loopback");
    if (!loopback) throw new Error("契约缺 loopback 类");
    for (const state of GRID_STATES) {
      if (expectedVerdict(loopback, state) !== "reject") {
        throw new Error(`契约 loopback@${state} 期望放行 —— 与 allowedUnderPrivateNetwork=false 矛盾`);
      }
    }
  });

  add("【R05 空表有条件】零分叉 + 空表 ⇒ 绿（顶格收口）；有分叉 + 空表 ⇒ 红（判据被关灯）", () => {
    const closed = judgeAllowlist({ failing: [], allowlist: { entries: [] }, today: TODAY });
    if (!closed.every((r) => r.ok)) {
      throw new Error(`零分叉时空表被判红 —— 守卫将永远无法变绿：${JSON.stringify(closed.filter((r) => !r.ok))}`);
    }
    const open = judgeAllowlist({ failing: ["grid:loopback@on:admin"], allowlist: { entries: [] }, today: TODAY });
    if (open.every((r) => r.ok)) {
      throw new Error("有分叉却空表被判绿 —— 空表退化成关灯键");
    }
    if (!open.some((r) => !r.ok && (r.actual ?? []).some((a) => a.includes("grid:loopback@on:admin")))) {
      throw new Error("有分叉 + 空表时没有逐格点名");
    }
  });

  add("【反证·有牙】review_by 过期 ⇒ 红（到期即红）", () => {
    const res = judgeAllowlist({
      failing: ["grid:privateIPv4@off:admin"],
      allowlist: { entries: [ackEntry({ review_by: "2026-01-01" })] },
      today: TODAY,
    });
    if (!res.some((r) => !r.ok && (r.actual ?? []).some((a) => a.includes("过期")))) {
      throw new Error("过期豁免仍绿 —— 到期即红是这张账唯一的牙齿");
    }
  });

  add("【反证·有牙】knownGapId 在台账里找不到 ⇒ 红（豁免必须指名真实缺口）", () => {
    const res = judgeAllowlist({
      failing: ["grid:privateIPv4@off:admin"],
      allowlist: { entries: [ackEntry({ knownGapId: "no-such-gap" })] },
      today: TODAY,
      knownGapDoc: "admin-side-outbound-posture-diverges-from-contract",
    });
    if (!res.some((r) => !r.ok && (r.actual ?? []).some((a) => a.includes("no-such-gap")))) {
      throw new Error("指向不存在缺口的豁免被判绿");
    }
  });

  add("【反证·有牙】admin 两个执行器入口结论不同 ⇒ 红（不可豁免，约束「改一个忘另一个」）", () => {
    const rows = [
      { key: "grid~loopback~127.0.0.1", verdicts: { off: { verdict: "reject" }, on: { verdict: "accept" } }, envVerdicts: { off: "reject", on: "reject" } },
    ];
    const same = compareAdminVariants([
      { key: "k", verdicts: { off: { verdict: "reject" }, on: { verdict: "accept" } }, envVerdicts: { off: "reject", on: "accept" } },
    ]);
    if (same.diffs.length !== 0) throw new Error("同结论却判红 —— 自检前提不成立");
    const { diffs, structural } = compareAdminVariants(rows);
    if (structural.length !== 0) throw new Error(`不该结构红：${structural.join("；")}`);
    if (!diffs.some((d) => d.startsWith("admin-variant:grid~loopback~127.0.0.1@on"))) {
      throw new Error(`两个入口分歧却没判红/没点名：${diffs.join(",")}`);
    }
  });

  add("【结构红】豁免账：空表 / 缺字段 / why 太短 / 重复登记 / scope 形制错 ⇒ 红", () => {
    const bad = [
      { entries: [] },
      { entries: [ackEntry({ owner: "" })] },
      { entries: [ackEntry({ why: "太短" })] },
      { entries: [ackEntry(), ackEntry({ id: "e2" })] },
      { entries: [ackEntry({ scope: ["grid:privateIPv4@off"] })] }, // 缺侧名
      { entries: [ackEntry({ review_by: "2026-02-31" })] }, // 格式对、日期不存在
    ];
    for (const allowlist of bad) {
      const res = judgeAllowlist({ failing: ["grid:privateIPv4@off:admin"], allowlist, today: TODAY });
      if (!res.some((r) => !r.ok)) {
        throw new Error(`结构坏掉却判绿：${JSON.stringify(allowlist).slice(0, 80)}`);
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
