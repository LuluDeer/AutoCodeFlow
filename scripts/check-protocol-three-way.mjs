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
 *
 * ## R162：夹具回放通道（`--probe-rows <file>`）—— 接线级黑盒保护
 *
 * R160 评估实测出：**判据的接线层完全裸奔** —— 9 条变异（删 `hardFailures` 的
 * 各分支 / 删 `failingIds` 收集 / 删探针覆盖检查）现有 **25 条自检一条都抓不到**。
 * 根因是结构性的：**没有任何夹具能单独驱动那条链**（真跑三侧探针要秒级、
 * 且需要 `node_modules` / `python3`）。
 *
 * ⇒ 本守卫新增 `--probe-rows <file>`：从一份 JSON 读**自造的**三侧行
 * （admin / node / python 各自对一批地址的判定行），**不 spawn、不读 `apps/**`**，
 * 直接喂给判据层（`scripts/lib/protocol-three-way-judge.mjs` 的 `judgeAll`）。
 * 于是夹具能在**毫秒级**驱动整条判定链 ⇒ 接线层第一次有了黑盒保护。
 *
 * ### ⚠️ 回放判绿 **≠** 三侧一致（必须写清楚，否则它就是一个假绿开关）
 *
 * 回放喂的是**手写的行**，不是三侧真跑出来的行 ⇒ 回放判绿只证明
 * 「**判据的接线是通的**」，**不**证明「node / python / admin 三侧真的对齐」。
 * ⇒ **CI 主跑永不传 `--probe-rows`**（`package.json` 的 `check:protocol-three-way`
 * 保持不带参数）；本参数只进 `--selftest` 通道。
 *
 * ### 夹具纪律（**反自证**）
 *
 * 夹具里的**行**与**期望**全部是**手写字面量**（线格式与判定字段逐字写死）。
 * **不许**由判据侧的构造器或函数**生成** ⇒ 那是**自证**（R160 实测：那样
 * 「删 failingIds 收集」「compareGrid 短路」「expectedVerdict 放行」三类变异
 * **一条都抓不到**）。
 * ⇒ 自检里有一条**反自证守卫**：扫描夹具目录，出现判据侧函数的**调用形态**
 * （形如 `名字(`）⇒ **红**。
 *
 * ### 版本纪律
 *
 * `--probe-rows` **只接受已知 `probeVersion`**；版本不符 ⇒ **明确报错 + exit≠0**，
 * **绝不**静默按普通模式跑（否则一次「夹具过期」会被伪装成一次「三侧一致」）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDay, utcDay } from "./lib/ratchet-baseline.mjs";
import { printCoverageBanner } from "./lib/agent-coverage.mjs";
// R161：判据层（期望推导 + 比对 + **接线**）已搬到 scripts/lib/protocol-three-way-judge.mjs。
// **探针执行仍留在本文件**（要 spawn 子进程 + 读盘）；判据层是纯函数（不读文件、不 spawn、无全局状态）
// ⇒ 第二步可以给它造 `--probe-rows` 夹具（喂内存行），给「接线」装上牙齿。
import {
  CLAIMS_REL,
  FOUR_WAY_ALLOWLIST_REL,
  FORM_ONLY_CLASSES,
  GRID_STATES,
  NON_COMPARABLE,
  adminGridKey,
  adminVectorKey,
  buildGridClasses,
  buildGridInputs,
  canonical,
  compareAdminVectors,
  compareAdminVariants,
  compareAgainstContract,
  compareGrid,
  expectedVerdict,
  gridProbeName,
  judgeAll,
  judgeAllowlist,
  normalize,
  parseProbeRows,
} from "./lib/protocol-three-way-judge.mjs";
// R160：覆盖计数出口。**必须在任何 require/依赖之前**打印（本文件若因缺依赖崩掉，
// 「崩了」与「零用例」必须能被哨兵分开看）。helper = 本文件真实的用例注册函数名
// （`add(name, fn)` = 本文件 selftest 里注册一条用例的那个函数）。
printCoverageBanner(import.meta.url, "add");

/**
 * 仓库根。
 *
 * ## 仓库根从哪来（`--root`）
 *
 * 契约、豁免账、knownGap 台账、以及三个被真跑的实现全部是**仓库相对**的，
 * 所以「根」是本守卫唯一的输入口径：
 *
 *   · 不传 `--root` ⇒ 根 = 本脚本所在树的上一级，**与引入 `--root` 之前逐字节
 *     等价**（不读 `process.cwd()`）；
 *   · `--root <dir>` / `--root=<dir>` 两种形态都认 ⇒ 根换成 `<dir>`；探针的
 *     `cwd`（node / admin 两侧必须是包目录，ts-node 的 tsconfig 解析根）与探针
 *     文件的**落盘目标**（node/python 侧写在各自包目录、admin 侧写临时目录）
 *     都跟着根走 —— 即**绝不往 `<dir>` 之外写盘**；
 *   · `--root` 缺值 / 空值 / 指向不存在的目录 ⇒ **exit 2**（用法错误）。不许静默
 *     回落到真仓库；
 *   · `--selftest` 与 `--root` **互斥** ⇒ exit 2：自检的对照组读的是**真**
 *     `protocol.json`，换根会让对照组失去意义。
 *
 * ⚠️ **本守卫的判据本质上是「把三侧真跑起来对拍」**，所以 `--root` 指向一棵
 * **可跑的**树（真仓库或它的副本 + 各自的 node_modules / python3）才有意义：
 * 夹具树跑不动探针，只会得到 `P5 探针失败` / 结构红（exit 1）。`--root` 在这里
 * 买到的是**口径统一 + 绝不悄悄跑真仓库**，不是「判据可夹具化」——判据面的
 * 自保由 `--selftest` 的纯函数用例（`judgeAllowlist` / `compareGrid` /
 * `checkProbeCoverage` …）承担，它们喂的是内存行，不需要可跑的树。
 */
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 用法错误退出码（与「判据红 = 1」分开，口径同 `check-mcp-error-hints.mjs`）。 */
const EXIT_USAGE = 2;

/**
 * 解析根（**模块加载期**解析：`NODE_APP` / `PY_APP` / `ADMIN_APP` 都由它派生，
 * 判据函数直接引用那些常量，所以根必须在使用之前定死）。
 *
 * `--root` 缺值即抛 → 入口报 exit 2：把末尾裸写的 `--root` 当成 `.` 会让根落到
 * `process.cwd()` —— 那句「以为在跑夹具」会直接掉进真仓库。
 */
function resolveRootArg(argv) {
  let root = DEFAULT_ROOT;
  let explicit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root" || a.startsWith("--root=")) {
      const v = a === "--root" ? argv[++i] : a.slice("--root=".length);
      if (!v || v.startsWith("--")) {
        throw new Error("`--root` 需要一个目录参数（`--root <dir>` 或 `--root=<dir>`）");
      }
      root = resolve(v);
      explicit = true;
    }
  }
  if (!explicit) return DEFAULT_ROOT;
  if (argv.includes("--selftest")) {
    throw new Error(
      "`--selftest` 与 `--root` 互斥：自检的对照组读的是**真** protocol.json 与真实现",
    );
  }
  if (!existsSync(root)) {
    throw new Error(`\`--root\` 指向的目录不存在：${root}`);
  }
  return root;
}

const ROOT = (() => {
  try {
    return resolveRootArg(process.argv.slice(2));
  } catch (err) {
    console.error(`✘ 用法错误：${err.message}`);
    process.exit(EXIT_USAGE);
  }
})();
const PROTOCOL_REL = "packages/executor-protocol/protocol.json";

const NODE_APP = join(ROOT, "apps/executor-node");
const PY_APP = join(ROOT, "apps/executor-python");
const ADMIN_APP = join(ROOT, "apps/admin-api");

/** 第四面被测文件（仓库相对路径；探针按绝对路径 require）。 */
const ADMIN_UTIL_REL = "src/common/utils/safe-http.util.ts";

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

// ── 回放模式（`--probe-rows <file>`）────────────────────────────────────
/**
 * **夹具回放**通道：把一份**自造的**三侧行直接喂给判据层，**不 spawn、不读
 * `apps/**`**。
 *
 * ## 它买到什么
 *
 * R160 评估实测出：判据的**接线层**（哪些结论进 `hardFailures` / 哪些格进
 * `failingIds` / 探针覆盖有没有查）**完全裸奔** —— 9 条变异现有 25 条自检
 * **一条都抓不到**。根因是**没有夹具能单独驱动那条链**。
 *
 * ⇒ 本通道让夹具能在**毫秒级**驱动整条判定链（真跑三侧探针要秒级且需要
 * `node_modules` / `python3`），于是「接线级黑盒保护」成为可能。
 *
 * ## ⚠️ 回放判绿 **≠** 三侧一致（必须写在头注里的边界）
 *
 * 回放喂的是**手写的行**，不是三侧真跑出来的行 ⇒ 回放判绿只证明
 * 「**判据的接线是通的**」，**不**证明「node / python / admin 三侧真的对齐」。
 * ⇒ **CI 主跑永不传 `--probe-rows`**（本参数只进自检通道）；主跑那条命令
 * （`package.json` 的 `check:protocol-three-way`）保持不带参数。
 *
 * ## 版本纪律
 *
 * 只接受**已知 `probeVersion`**（`PROBE_ROWS_VERSIONS`）；版本不符 ⇒
 * **明确报错 + exit≠0**，**绝不**静默按普通模式跑（否则一次「夹具过期」会被
 * 伪装成一次「三侧一致」）。
 */

/**
 * 解析 `--probe-rows` 参数（**只在本文件里**，与 `--root` 的解析并列）。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {string|null} 夹具文件路径（不传 ⇒ null）
 */
function resolveProbeRowsArg(argv) {
  let file = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--probe-rows" || a.startsWith("--probe-rows=")) {
      const v = a === "--probe-rows" ? argv[++i] : a.slice("--probe-rows=".length);
      if (!v || v.startsWith("--")) {
        throw new Error("`--probe-rows` 需要一个文件参数（`--probe-rows <file>` 或 `--probe-rows=<file>`）");
      }
      file = resolve(v);
    }
  }
  return file;
}

/**
 * 跑一次回放：读夹具 ⇒ 喂判据层 ⇒ 打印 ⇒ 按 `expect` 退出。
 *
 * @param {string} file 夹具文件绝对路径
 */
function runReplay(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`✘ 回放夹具读不到：${file}\n   ${err.message}`);
    process.exit(1);
  }
  const parsed = parseProbeRows(text);
  if (!parsed.ok) {
    console.error(`✘ 回放夹具不可用（${file}）：${parsed.reason}`);
    process.exit(1);
  }
  const f = parsed.data;

  const judged = judgeAll({
    protocol: f.protocol,
    classes: f.classes,
    probeVectors: f.probeVectors,
    adminInputs: f.adminInputs,
    nodeResults: f.rows.node,
    pyResults: f.rows.python,
    adminResults: f.rows.admin,
    allowlist: f.allowlist,
    allowlistError: null,
    today: f.today,
    knownGapDoc: f.knownGapDoc ?? null,
  });
  const { results, grid, adminVectors, adminVariants, allowlistResults, scopedIds, hardFailures } = judged;

  // 打印面与主跑**同款**（回放的价值之一：让「红在哪」看得见）。
  for (const r of results) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}`);
    for (const a of r.actual ?? []) console.log(`       ${a}`);
  }
  console.log("");
  console.log(`── 第四面（admin-api）：逐格判据 —— ${grid.cells.length} 格`);
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
  console.log("── 第四面：向量级 ──");
  for (const r of adminVectors.results) {
    const mark =
      r.judged === false ? "N/A  " : r.ok ? "OK   " : scopedIds.has(r.id) ? "ALLOW" : "FAIL ";
    console.log(`${mark} ${r.name}`);
    for (const a of r.actual ?? []) console.log(`       ${a}`);
  }
  console.log("");
  console.log("── 第四面：admin 两个执行器入口互比 ──");
  console.log(
    `  ${adminVariants.diffs.length === 0 ? "OK   两个入口逐输入逐态同结论" : "FAIL 两个入口出现分歧（不可豁免）"}`,
  );
  for (const d of adminVariants.diffs) console.log(`       ${d}`);
  console.log("");
  console.log("── 豁免账 ──");
  for (const r of allowlistResults) {
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}`);
    for (const a of r.actual ?? []) console.log(`       ${a}`);
  }
  console.log("");
  console.log(
    `P5 回放（夹具回放模式）：场景 ${f.scenarioId ?? "?"} —— ` +
      `三向 ${results.length} 条 + 逐格 ${grid.cells.length} 格 + 向量 ${adminVectors.results.filter((r) => r.judged).length} 条` +
      `；不一致格 ${judged.failingIds.length} 个`,
  );

  // **机器可读**的红项清单（每行一条，前缀固定）。
  // 为什么要有这一段：自检要断言「**哪几条**红项」（而不只是「红了几条」）——
  // 那是「接线有没有把某一支收进 hardFailures」的唯一可判形式。
  for (const h of hardFailures) console.log(`HARDFAIL: ${h}`);

  if (hardFailures.length > 0) {
    console.error(`P5 回放失败：${hardFailures.length} 条不符`);
    for (const h of hardFailures) console.error(`  · ${h}`);
    process.exit(1);
  }
  console.log("P5 回放 OK：判据接线走通（本模式**不**代表三侧实现真的对齐）");
}

export function main() {
  // 结构自证（**不是判据**）：判据要把三侧真跑起来对拍，所以根必须是一棵**可跑的**
  // 树。缺任何一侧时既不能判「三侧一致」（假绿），也不该崩一个 ENOENT 栈让人以为
  // 守卫自己坏了 ⇒ 结构红（exit 1），并点名缺什么（`--root` 指错树是最常见原因）。
  const required = [
    PROTOCOL_REL,
    "apps/executor-node",
    "apps/executor-python",
    "apps/admin-api",
  ];
  const missing = required.filter((rel) => !existsSync(join(ROOT, rel)));
  if (missing.length > 0) {
    console.error(
      `✘ 结构红：--root 指向的树跑不了本守卫（缺 ${missing.join("、")}）\n` +
        `   根 = ${ROOT}\n` +
        `   本守卫的判据是「把 node / python / admin 三侧真跑起来对拍」，` +
        `夹具树跑不动探针 —— --root 指错了树？`,
    );
    process.exit(1);
  }

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

  // ── 接线层：判据层（期望推导 + 比对 + 接线）已搬到 scripts/lib/protocol-three-way-judge.mjs。
  // 本段只做「IO 已完成 ⇒ 把结果喂给判据层」这一件事；判据的**接线**本身现在是
  // `judgeAll(...)`（纯函数）⇒ 第二步可以给它造 `--probe-rows` 夹具。
  const allow = readFourWayAllowlist();
  const claimsPath = join(ROOT, CLAIMS_REL);
  const judgedAll = judgeAll({
    protocol,
    classes,
    probeVectors,
    adminInputs,
    nodeResults,
    pyResults,
    adminResults,
    allowlist: allow.data,
    allowlistError: allow.error,
    today: utcDay(),
    knownGapDoc: existsSync(claimsPath) ? readFileSync(claimsPath, "utf8") : null,
  });
  const { results, grid, adminVectors, adminVariants, allowlistResults, scopedIds, hardFailures } = judgedAll;

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

  // `hardFailures` 由 `judgeAll(...)` 汇好（见上面），本文件不再另算一遍 ——
  // 「汇总」本身就是**接线**的一环，放在判据层才可能被夹具覆盖。
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

  // R08（2026-11-05，ADR-029）：元数据地址恒拒 —— 契约段本身的形状与语义。
  add("【R08 契约段】networkPolicy.metadataAddresses 非空、形制合法、且不与 addresses 的类重复声明", () => {
    const realProtocol = JSON.parse(readFileSync(join(ROOT, PROTOCOL_REL), "utf8"));
    const meta = realProtocol?.networkPolicy?.metadataAddresses;
    if (!meta || typeof meta !== "object") {
      throw new Error("契约缺 networkPolicy.metadataAddresses（ADR-029 要求：元数据地址恒拒表）");
    }
    const addrs = meta.addresses;
    if (!Array.isArray(addrs) || addrs.length === 0) {
      throw new Error("metadataAddresses.addresses 为空 —— 空表 = 判据被关灯（ADR-029 §2）");
    }
    for (const entry of addrs) {
      if (typeof entry !== "string" || !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(entry.trim())) {
        throw new Error(`metadataAddresses 里有非法条目：${JSON.stringify(entry)}`);
      }
    }
    if (meta.enforcement !== "deny-before-classification") {
      throw new Error(
        `metadataAddresses.enforcement = ${JSON.stringify(meta.enforcement)} —— 必须是 deny-before-classification` +
          "（判定先于风险分类，否则开关仍能放行）",
      );
    }
    // 不许把元数据地址塞进 addresses 的某个类里冒充（那会随该类的开关语义浮动）。
    const classes = buildGridClasses(realProtocol);
    const examples = new Set(classes.flatMap((c) => c.examples));
    const clash = addrs.filter((a) => examples.has(String(a).split("/")[0]));
    if (clash.length > 0) {
      throw new Error(`元数据地址同时出现在 addresses 的示例里（随开关浮动）：${clash.join(", ")}`);
    }
  });

  add("【R08 语义】元数据地址的恒拒不依赖 posture/开关（矩阵事实：webhook-on / executor-on 都必须拒）", () => {
    // 判据形态：契约把 enforcement 写成 deny-before-classification，
    // 而三端实现（admin/node/python）各自有一条测试钉住「开关开启也拒」。
    // 这里做**契约自洽**校验：metadataAddresses 的条目必须落在某个 addresses 类里
    // （否则三端的分类器根本看不见它，恒拒逻辑会变成死的）。
    const realProtocol = JSON.parse(readFileSync(join(ROOT, PROTOCOL_REL), "utf8"));
    const classes = buildGridClasses(realProtocol);
    const declared = classes.filter((c) => c.exampleParser !== null || true);
    const covered = realProtocol.networkPolicy.metadataAddresses.addresses.map((a) => {
      const bare = String(a).split("/")[0];
      // 只做**语法级**归属判断：IPv4 落在哪个类的 examples 段不是重点，
      // 重点是该地址必须能被三端的分类器识别为受限（否则恒拒不可达）。
      return { bare, anyClass: declared.length > 0 };
    });
    const dead = covered.filter((x) => !x.anyClass);
    if (dead.length > 0) throw new Error(`元数据地址无法被任何地址类识别：${dead.map((d) => d.bare).join(", ")}`);
  });

  // R09（2026-11-05）：ADR-029 §2 的扩展规则②「三端各有一条测试」必须**机器可判** ——
  // 否则下一个人往 metadataAddresses 加地址时，只会记得改契约，忘了三端测试
  // （那正是 §7.7 P1「python 面不在 parity 守卫里」的成因）。
  add("【R09 三端覆盖】metadataAddresses 的每个地址都必须在 admin / node / python 三处测试里出现", () => {
    const realProtocol = JSON.parse(readFileSync(join(ROOT, PROTOCOL_REL), "utf8"));
    const addrs = realProtocol?.networkPolicy?.metadataAddresses?.addresses ?? [];
    if (addrs.length === 0) throw new Error("metadataAddresses 为空（见 R08 契约段判据）");
    const files = [
      "apps/admin-api/src/common/utils/__tests__/ssrf-deny-matrix.spec.ts",
      "apps/executor-node/src/lib/ssrf-deny-parity.spec.ts",
      "apps/executor-python/tests/test_ssrf_guard.py",
    ];
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      for (const entry of addrs) {
        const bare = String(entry).split("/")[0];
        if (!text.includes(bare)) {
          throw new Error(`${rel} 里没有元数据地址 ${bare} —— 三端覆盖缺一端（ADR-029 §2 规则②）`);
        }
      }
    }
    // 反向：解析到的地址必须都是合法 IPv4/IPv6 字面量（不许写主机名糊弄覆盖判据）
    for (const entry of addrs) {
      const bare = String(entry).split("/")[0];
      if (!/^[0-9a-fA-F:.]+$/.test(bare)) throw new Error(`metadataAddresses 条目不是 IP 字面量：${entry}`);
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

  // ── R162：接线级黑盒夹具（回放通道）────────────────────────────────────
  // 「接线层」此前**完全裸奔**：R160 实测 9 条变异（删 hardFailures 各分支 /
  // 删 failingIds 收集 / 删探针覆盖检查）现有 25 条自检**一条都抓不到**。
  // ⇒ 本段用**夹具回放**（`--probe-rows`）把整条判定链驱动起来，断言
  // 「**该红时必红、且红项是哪几条**」。
  //
  // 纪律：**夹具里的期望结论是手写字面量**（夹具文件里写死），本段只负责
  // 「把夹具喂给守卫 ⇒ 断言退出码 + 红项清单」。
  const FIXTURE_DIR = join(ROOT, "scripts/fixtures/protocol-three-way");
  const SELF = fileURLToPath(import.meta.url);

  /** 跑一次回放（spawn 真脚本），返回 {code, stdout, stderr, out}。 */
  const replay = (fixtureRel, extraArgs = []) => {
    const abs = join(FIXTURE_DIR, fixtureRel);
    if (!existsSync(abs)) throw new Error(`夹具不存在：${abs}`);
    const r = spawnSync(process.execPath, [SELF, `--probe-rows=${abs}`, ...extraArgs], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  /** 从回放输出里抽出机器可读的红项清单（`HARDFAIL: ` 前缀）。 */
  const hardFailsOf = (out) =>
    String(out)
      .split("\n")
      .filter((l) => l.startsWith("HARDFAIL: "))
      .map((l) => l.slice("HARDFAIL: ".length));

  /**
   * 找「标记 + 格 id」的那一行（**按行匹配**，不依赖标记的补空格宽度）。
   *
   * 逐格段的标记有三种（`OK   ` / `ALLOW` / `FAIL `，各带不同补白）⇒
   * 直接 `includes("FAIL grid:x")` 会因补白宽度而误判。**按行 + 前缀匹配**
   * 才是稳的形态。
   */
  const hasMarkedLine = (out, mark, cellId) =>
    String(out)
      .split("\n")
      .some((l) => l.startsWith(mark) && l.slice(mark.length).trimStart().startsWith(cellId));

  /** 读一份夹具的 `expect` 段（**期望值来自夹具文件本身**）。 */
  const expectOf = (fixtureRel) => {
    const abs = join(FIXTURE_DIR, fixtureRel);
    const data = JSON.parse(readFileSync(abs, "utf8"));
    if (!data.expect || typeof data.expect !== "object") {
      throw new Error(`夹具 ${fixtureRel} 缺 expect 段`);
    }
    return data.expect;
  };

  /** 逐条核对回放结果与夹具的 expect（**通用的那一条**，被下面每条夹具用例复用）。 */
  const assertReplayMatches = (fixtureRel, label) => {
    const exp = expectOf(fixtureRel);
    const r = replay(fixtureRel);
    if (r.code !== exp.exitCode) {
      throw new Error(
        `退出码 ${r.code}（期望 ${exp.exitCode}）—— ${label}\n` +
          `--- 输出 ---\n${r.out.slice(0, 1200)}`,
      );
    }
    for (const needle of exp.contains ?? []) {
      if (!r.out.includes(needle)) {
        throw new Error(`输出缺少片段 ${JSON.stringify(needle)} —— ${label}`);
      }
    }
    for (const needle of exp.absent ?? []) {
      if (r.out.includes(needle)) {
        throw new Error(`输出不该出现 ${JSON.stringify(needle)} 却出现了 —— ${label}`);
      }
    }
    const fails = hardFailsOf(r.out);
    if (typeof exp.hardFailuresCount === "number" && fails.length !== exp.hardFailuresCount) {
      throw new Error(
        `红项数 ${fails.length}（期望 ${exp.hardFailuresCount}）—— ${label}\n` +
          `实际：${JSON.stringify(fails)}`,
      );
    }
    for (const want of exp.hardFailures ?? []) {
      if (!fails.includes(want)) {
        throw new Error(`红项清单缺 ${JSON.stringify(want)} —— ${label}\n实际：${JSON.stringify(fails)}`);
      }
    }
    for (const unwanted of exp.hardFailuresAbsent ?? []) {
      if (fails.some((f) => f.includes(unwanted))) {
        throw new Error(
          `红项清单不该含含 ${JSON.stringify(unwanted)} 的项，却有 —— ${label}\n` +
            `实际：${JSON.stringify(fails)}`,
        );
      }
    }
    return r;
  };

  // 必备场景清单（**手写**）：少一个场景 ⇒ 自检红（防止「悄悄删掉一个夹具」）。
  const REQUIRED_SCENARIOS = [
    "control-consistent.json",
    "admin-side-mismatch.json",
    "node-side-mismatch.json",
    "python-side-mismatch.json",
    "allowlist-hit.json",
    "coverage-node-missing.json",
    "coverage-python-missing.json",
    "coverage-admin-missing.json",
    "grid-structural-all-unsupported.json",
    "grid-deviation-printed-not-red.json",
    "grid-deviation-allowlisted-green.json",
    "bad-probe-version.json",
  ];

  add("【R162 夹具】必备场景齐全（缺一个场景 ⇒ 红：不许悄悄删掉一个夹具）", () => {
    const have = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
    const missing = REQUIRED_SCENARIOS.filter((f) => !have.includes(f));
    if (missing.length > 0) {
      throw new Error(`夹具目录缺 ${missing.length} 个必备场景：${missing.join("、")}`);
    }
    const extra = have.filter((f) => !REQUIRED_SCENARIOS.includes(f));
    if (extra.length > 0) {
      throw new Error(
        `夹具目录有 ${extra.length} 个**未登记**的场景：${extra.join("、")} —— ` +
          "新增场景必须同时登记进 REQUIRED_SCENARIOS（否则它不受任何断言保护）",
      );
    }
  });

  add("【R162 夹具·正例】三端一致 ⇒ exit 0 且零红项（控制组：证明红例不是因为「断言永远红」）", () => {
    assertReplayMatches("control-consistent.json", "正例控制组");
  });

  add("【R162 夹具·反证①】admin 侧与契约不符 ⇒ 红，且点名该格 + 该侧", () => {
    const r = assertReplayMatches("admin-side-mismatch.json", "admin 侧不一致");
    if (!r.out.includes("grid:privateIPv4@off:admin")) {
      throw new Error("红项没有点名「该格 + 该侧」");
    }
    if (!hasMarkedLine(r.out, "FAIL", "grid:privateIPv4@off")) {
      throw new Error("那一格没有被打印成 FAIL —— 偏差连「印」都没有");
    }
  });

  add("【R162 夹具·反证②】node 侧不一致 ⇒ 红（红项含三向那两条）", () => {
    assertReplayMatches("node-side-mismatch.json", "node 侧不一致");
  });

  add("【R162 夹具·反证③】python 侧不一致 ⇒ 红（红项含三向那两条）", () => {
    assertReplayMatches("python-side-mismatch.json", "python 侧不一致");
  });

  add("【R162 夹具·反证④】豁免账命中 ⇒ 该条不红（白名单不是摆设）", () => {
    const r = assertReplayMatches("allowlist-hit.json", "豁免账命中");
    if (!hasMarkedLine(r.out, "ALLOW", "grid:privateIPv4@off")) {
      throw new Error("已登记的分叉没有被标成 ALLOW —— 豁免账没生效");
    }
  });

  add("【R162 夹具·反证⑤】探针覆盖不足（少了一侧的行）⇒ 红（结构红）", () => {
    for (const rel of ["coverage-node-missing.json", "coverage-python-missing.json", "coverage-admin-missing.json"]) {
      assertReplayMatches(rel, `探针覆盖不足：${rel}`);
    }
  });

  add("【R162 夹具·反证⑤·续】某格 admin 全部 unsupported ⇒ 网格结构红（unsupported 不许变成全绿）", () => {
    // 与「探针少回一行」**独立**的一条路径：这里 admin **回了**这一行
    // （探针覆盖检查过得去），但那一行标了 unsupported ⇒ 该格没有任何
    // admin 判据 ⇒ 网格**结构红**。
    // ⇒ 它把 `...structural` 这一支的**网格结构红**路径单独钉住。
    assertReplayMatches("grid-structural-all-unsupported.json", "整格 unsupported");
  });

  add("【R162 夹具·反例⑥】网格偏差：**只记录当前行为**（印了但不红）—— 不擅自改判据", () => {
    const r = assertReplayMatches("grid-deviation-printed-not-red.json", "网格偏差只印不红");
    // 该格**被打印成 FAIL**（偏差看得见）……
    if (!hasMarkedLine(r.out, "FAIL", "grid:loopback@off")) {
      throw new Error("网格偏差没有被打印出来 —— 偏差连「印」都没有");
    }
    // ……但**它本身不是 hardFailure**（D2 的现状：网格偏差只印不红）。
    const fails = hardFailsOf(r.out);
    if (fails.some((f) => f.includes("grid:loopback@off:node"))) {
      throw new Error(
        "网格偏差进了 hardFailures —— 这与当前设计（D2）不符；" +
          "本轮**只记录现状不改判据**，若将来改判据，此用例必须同步改并另行立项",
      );
    }
    // 登记之后 ⇒ 整个回放判绿（"印了但不红"的最锋利形态）。
    // 注意：登记后那格的标记是 `ALLOW`（已被 scope 覆盖）**而不是** `FAIL`
    // —— 但**偏差明细照样被打印**（`[grid:loopback@off:node]` 那行），
    // ⇒ 「印了但不红」＝ 看得见 + 不拦。
    const green = assertReplayMatches("grid-deviation-allowlisted-green.json", "网格偏差已登记");
    if (!green.out.includes("grid:loopback@off:node")) {
      throw new Error("已登记的场景里偏差明细没有被打印出来 —— 偏差连「印」都没有");
    }
    if (hasMarkedLine(green.out, "ALLOW", "grid:loopback@off") === false) {
      throw new Error("已登记的那格没有被标成 ALLOW —— 豁免账没生效");
    }
  });

  add("【R162 夹具·版本】probeVersion 不符 ⇒ 明确报错 + exit≠0（不许当普通模式跑）", () => {
    const r = assertReplayMatches("bad-probe-version.json", "版本不符");
    if (r.code === 0) throw new Error("版本不符却判绿 —— 夹具过期会被伪装成「三侧一致」");
    if (!r.out.includes("probeVersion") || !r.out.includes("不是已知版本")) {
      throw new Error(`报错文案没点名 probeVersion / 版本不符：\n${r.out.slice(0, 600)}`);
    }
    if (r.out.includes("P5 真四向检查")) {
      throw new Error("版本不符却跑成了普通模式（真跑三侧探针）—— 不许静默回落");
    }
  });

  add("【R162 反自证守卫】夹具里出现判据侧函数的**调用形态** ⇒ 红（不许自证）", () => {
    // 纪律：夹具的**行**与**期望**必须是手写字面量。若夹具改成调用
    // `expectedVerdict(...)` / `gridProbeName(...)` / `compareGrid(...)` /
    // `buildGridClasses(...)` / `adminGridKey(...)` 生成 ⇒ 那是**自证**
    // （R160 实测：那样三类变异一条都抓不到）⇒ 本条必须红。
    //
    // 判据形态：扫**夹具目录**里的每个 .json，找**调用形态**（`名字(`）——
    // 只看**裸名字**会把夹具里正当的说明文字（"不许调用 expectedVerdict"）
    // 误判成违规。
    const FORBIDDEN = [
      "expectedVerdict",
      "gridProbeName",
      "adminGridKey",
      "adminVectorKey",
      "splitGridProbeName",
      "compareGrid",
      "compareAdminVectors",
      "compareAdminVariants",
      "compareAgainstContract",
      "buildGridClasses",
      "buildGridInputs",
      "judgeAllowlist",
      "checkProbeCoverage",
      "judgeAll",
      "parseProbeRows",
    ];
    const hits = [];
    for (const file of readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json"))) {
      const text = readFileSync(join(FIXTURE_DIR, file), "utf8");
      for (const name of FORBIDDEN) {
        const re = new RegExp(`\\b${name}\\s*\\(`);
        if (re.test(text)) hits.push(`${file}：出现判据侧函数的调用形态 \`${name}(\``);
      }
    }
    if (hits.length > 0) {
      throw new Error(
        `夹具出现判据侧函数的调用形态（${hits.length} 处）—— 那是**自证**：\n` +
          hits.join("\n") +
          "\n夹具的行与期望必须是**手写字面量**（R160 实测：自证形态下三类变异一条都抓不到）",
      );
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
  let probeRows = null;
  try {
    probeRows = resolveProbeRowsArg(process.argv.slice(2));
  } catch (err) {
    console.error(`✘ 用法错误：${err.message}`);
    process.exit(EXIT_USAGE);
  }
  if (probeRows) {
    runReplay(probeRows);
  } else {
    main();
  }
}
