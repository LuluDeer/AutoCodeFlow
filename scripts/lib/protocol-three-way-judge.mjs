/**
 * protocol-three-way-judge —— 「真四向检查」的**判据层**（期望推导 + 比对 + 接线）。
 *
 * ## 为什么抽它（不是为了「文件看起来整齐」）
 *
 * R160 的只读评估（`artifacts/autonomy/R160/assess-protocol-three-way.md`）实测出：
 * `scripts/check-protocol-three-way.mjs`（1694 行）里**判据的接线层完全裸奔** ——
 * 9 条变异（删 `hardFailures` 的各分支 / 删 `failingIds` 收集 / 删探针覆盖检查），
 * 现有 **25 条自检一条都抓不到**（25/25 全绿）；只有 4 条**函数级**变异有牙。
 * 也就是说：自检保护的是「**函数算得对不对**」，没有保护「**这些函数被接上了没有**」。
 *
 * 根因是结构性的：**判据函数**（纯）与**接线**（把它们串起来 + 决定红不红）挤在**同一个
 * 1694 行文件**里 ⇒「接线」既不在自检的覆盖范围内，也**没有任何夹具**能让它被单独测。
 *
 * ⇒ 本轮只做**第一步**：把**判据层**搬到这里，让它成为一个**可被 import 的纯库**：
 * **不读文件、不 spawn、无全局状态**。同型先例：`3b8b9ea2` 抽
 * `scripts/lib/ratchet-baseline.mjs`（9 个守卫共用同一套基线纪律）。
 *
 * ## 抽了哪两段（+ 接线）
 *
 *   ① **期望推导**（契约 → 可判的格/向量）：
 *      `normalize` / `canonical` / `buildGridClasses` / `expectedVerdict` /
 *      `probeUrlForHost` / `buildGridInputs` / `gridProbeName` / `splitGridProbeName` /
 *      `adminGridKey` / `adminVectorKey`。
 *   ② **比对**（三侧真跑出来的行 → 该不该红）：
 *      `compareAgainstContract` / `compareGrid` / `compareAdminVectors` /
 *      `compareAdminVariants` / `judgeAllowlist` / `checkProbeCoverage`。
 *   ③ **接线**（本轮**新增导出**）：`judgeAll(...)` —— 原先埋在主脚本里的那 37 行
 *      「把探针结果接成判据输入」的全部逻辑，现在是**一个纯函数**：
 *      入参 = 三侧探针跑出来的行 + 已读好的豁免账 + 已算好的「今天」+ 已读好的台账全文；
 *      出参 = `results` / `grid` / `adminVectors` / `adminVariants` / `structural` /
 *      `failingIds` / `allowlistResults` / `scopedIds` / `hardFailures`。
 *
 * ## 没抽哪段：**探针执行**（以及 IO）—— 理由
 *
 * `runNodeProbe` / `runPythonProbe` / `runAdminProbe`（以及 `readFourWayAllowlist`、
 * 读 `protocol.json`、读 `docs/PLAN-CLAIMS.md`、`utcDay()`）**留在主脚本**，因为：
 *   · 它们要 **spawn 子进程**（两侧 `ts-node/register` + 裸 `python3`）和**读盘** ——
 *     本模块的纪律是**纯函数**（不读文件、不 spawn、无全局状态）；
 *   · 探针必须**真跑被测实现**（不是复刻一份逻辑）⇒ 它的失败（`P5 探针失败`）是
 *     **结构红**（exit 1），与「判据判红」是两种语义；混在一个模块里会让人分不清
 *     「守卫没跑起来」和「守卫跑起来判了红」。
 *   · `judgeAll` 因此把「今天」「豁免账内容」「台账全文」当作**入参**收进来 ——
 *     IO 留在主脚本，判据层只做纯计算。
 *
 * ## 盲区（如实声明，别当成已覆盖）
 *
 * ✅ **接线级保护已建立（R162）** —— 本模块现在**不只**是「可测」，
 * 而且**被测**了：
 *   · 主脚本新增 `--probe-rows <file>` **回放通道**：从一份 JSON 读**自造的**
 *     三侧行（**不 spawn、不读 `apps/**`**）⇒ 直接喂给 `judgeAll`。
 *   · 夹具在 `scripts/fixtures/protocol-three-way/*.json`（**golden 字面量**：
 *     行与期望**全部手写**，**不许**由本模块的函数生成 —— 那是**自证**）。
 *   · 判据接线（`hardFailures` 的各分支 / `failingIds` 的收集 / 探针覆盖检查）
 *     现在**有牙**了：R162 实测三条变异（删 `...structural` / 删 `failingIds`
 *     收集 / 删 `checkProbeCoverage("admin", …)`）**自检全部转红**
 *     （R161 时它们全绿 —— 见回执
 *     `artifacts/autonomy/R161/impl-protocol-split.md` §4）。
 *   · 另有一条**反自证守卫**：夹具里出现判据侧函数的**调用形态** ⇒ 红。
 *
 * ⚠️ **仍然未覆盖的（如实声明）**：
 *   · **三侧实现的语义**（node / python / admin 到底怎么判）—— 那**必须真跑**，
 *     夹具在结构上买不到（夹具喂的是手写的行，不是真跑出来的行）。
 *   · **探针与夹具之间的漂移盲区**：回放只认 `probeVersion`，认不出
 *     「探针字段改名了但夹具还是老字段」。R160 §5.2 建议的「回放时校验必备键
 *     集合」**本轮未做**（回放模式读的是夹具自带的三侧行，键集合由夹具格式
 *     校验兜住；真跑路径的键集合漂移仍靠主跑兜）。
 *   · **D2（网格偏差与 `hardFailures` 的关系）—— R163 只读评估的更正（此前这段
 *     注释本身就是误判源头）**：**网格偏差并非「只印不红」**。deviation 的 id 会进
 *     `failingIds`（:942）⇒ 经 `judgeAllowlist` 落到 `hardFailures` 的「豁免账：」那一支
 *     ⇒ **偏差默认是红的**；只有在**豁免账里显式登记**（`owner` / `why≥20` / `review_by` /
 *     `knownGapId` + 到期 + 腐烂检查）时才放行。
 *     ⇒ 红责任在**豁免账（登记制）**，**不是漏判**，**不需要**把 `deviations` 再塞进
 *     `hardFailures`（实测那样做会**让网格豁免机制整体废掉**，且真仓库**零收益**）。
 *     ⇒ 因此 R163 评估的裁决是「**不该改**」；R160「不需要 ADR」的结论**不翻转**
 *     （它的翻转条件是「真去改 D2」）。若将来有人硬改 ⇒ 那是**撤掉网格豁免** ⇒ 须 ADR，
 *     且必答「同一偏差会一偏差双红、两处判据策略相反」（实测红项 2 vs 1）。
 *     ⚠️ **禁动**：:942（deviations → failingIds）、:959-964（豁免账读取）、
 *     `scripts/fixtures/protocol-three-way/*.json`、`packages/executor-protocol/protocol.json`。
 *
 * ## 其它边界
 *
 * · 本模块**不含**探针执行、**不含**任何 IO；`readFourWayAllowlist` 留在主脚本。
 * · **判据语义一字未改**：搬过来的函数体与主脚本里的原文**逐字节相同**（只改了
 *   「哪些名字被 `export`」）；R162 新增的只有**回放通道的格式契约**
 *   （`PROBE_ROWS_VERSIONS` / `parseProbeRows`，**纯函数**：只吃文本、不读文件）
 *   与夹具本身 —— **判据语义（D2）仍然一字未改**。
 */

import { isoDay, parseDay } from "./ratchet-baseline.mjs";

/** 显式登记当前分叉的豁免账（与 `protocol-breaking-acknowledgements.json` 同款定位）。 */
export const FOUR_WAY_ALLOWLIST_REL = "scripts/protocol-four-way-allowlist.json";
/** knownGap 台账（只在**读得到**时做"豁免必须指向真实缺口"的子判据）。 */
export const CLAIMS_REL = "docs/PLAN-CLAIMS.md";

/** 网格键的分隔符：地址里不含 `~`（含 `:` 的 IPv6 会毁掉 `::` 分隔）。 */
export const GRID_SEP = "~";
export const GRID_PREFIX = "grid";
export const GRID_STATES = ["off", "on"];
/**
 * `networkPolicy.addresses` 里**不是地址类**的条目。
 *
 * `ipv4Mapped` 的规则是「按内嵌 IPv4 判定」⇒ 同一个"类"里不同例子结论不同
 * （`::ffff:8.8.8.8` 放行、`::ffff:127.0.0.1` 拒），一个
 * `allowedUnderPrivateNetwork` 布尔**表达不了**它 ⇒ 不进网格，由 `ipv4Mapped`
 * 的**向量族**逐条覆盖。**显式排除而不是悄悄少一行。**
 */
export const FORM_ONLY_CLASSES = new Set(["ipv4Mapped"]);

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

/**
 * 探针覆盖完整性：送进去 N 个输入，就必须回 N 行。
 *
 * 为什么单列一条：本仓已有一个「只识别 2 条却报'2 条一致'= 绿」的真事故
 * （`check-agent-index-names`）。**抽到的条数**是唯一能挡"漏检却报绿"的东西。
 */
export function checkProbeCoverage(label, inputs, rows, keyField) {
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

// ── 夹具回放通道（`--probe-rows`）的文件格式契约 ─────────────────────────
/**
 * 回放夹具的**已知版本**（`probeVersion`）。
 *
 * ## 为什么版本必须被校验（而不是「读到什么算什么」）
 *
 * `--probe-rows` 是一个**能把「判据」喂成任意输入**的入口 ⇒ 如果它接受任何
 * 文件，那么「回放判绿」就可能来自一份**格式已经漂移**的夹具（例如探针改了
 * 字段名 `denied → deniedFlag`，而夹具还是老字段 ⇒ 判据读到 `undefined`
 * ⇒ 两侧都"缺字段"⇒ 反而"一致"）。
 *
 * ⇒ **只接受已知版本**；版本不认识 ⇒ **明确报错 + exit≠0**，**绝不**静默按普通
 * 模式跑（那等于把一次「夹具过期」伪装成一次「三侧一致」）。
 *
 * 改夹具格式时**必须**同时：① 加一个新版本号；② 保留旧版本一个发布周期
 * （否则历史夹具一夜全红，且没人知道为什么）；③ 在本文件的
 * `PROBE_ROWS_VERSIONS` 里登记。
 */
export const PROBE_ROWS_VERSIONS = ["p5-probe-rows/1"];

/**
 * 解析并**校验**一份回放夹具（纯函数：只吃文本，不读文件）。
 *
 * ## 夹具格式（自描述）
 *
 * ```jsonc
 * {
 *   "probeVersion": "p5-probe-rows/1",   // **必填**，且必须是已知版本
 *   "scenarioId":   "control-consistent", // 场景标识（自检据此认领「必备场景」）
 *   "scenario":     "正例控制组：三端一致 ⇒ 判绿",
 *   "protocol":     { … },   // 契约（字段与真 protocol.json 同构）
 *   "classes":      [ … ],   // 地址类（字面量，不许由判据侧函数推出）
 *   "probeVectors": [ … ],   // 送进 node/python 探针的输入清单
 *   "adminInputs":  [ … ],   // 送进 admin 探针的输入清单
 *   "rows": {                 // **三侧的行**（字段名固定）
 *     "node":   [ { "name": "…", "denied": true, "category": "…", "allowedBySwitch": false } ],
 *     "python": [ … 同构 … ],
 *     "admin":  [ { "key": "…", "verdicts": { "off": {…}, "on": {…} }, "envVerdicts": {…} } ]
 *   },
 *   "allowlist":    { "entries": [] },
 *   "today":        20706,
 *   "knownGapDoc":  "…",
 *   "expect":       { "exitCode": 0, "contains": [ … ], "absent": [ … ] }
 * }
 * ```
 *
 * ## 校验的取向
 *
 * **宁严勿松**：字段缺了 / 类型不对 ⇒ 结构红（`ok:false`），**不**带着半个数据
 * 继续跑（那会得到一个「看起来判了红、其实只是字段缺失」的结果）。唯一的
 * 硬性要求是：`probeVersion` 必须在已知列表里。
 *
 * @param {string} text 夹具文件全文
 * @returns {{ok: true, data: object} | {ok: false, reason: string}}
 */
export function parseProbeRows(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch (err) {
    return { ok: false, reason: `不是合法 JSON：${err.message}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "顶层必须是 JSON 对象" };
  }
  const version = data.probeVersion;
  if (typeof version !== "string" || version.trim() === "") {
    return {
      ok: false,
      reason:
        `缺 probeVersion —— 回放只接受已知版本（${PROBE_ROWS_VERSIONS.join(" / ")}）；` +
        "不许当普通模式跑",
    };
  }
  if (!PROBE_ROWS_VERSIONS.includes(version)) {
    return {
      ok: false,
      reason:
        `probeVersion=${JSON.stringify(version)} 不是已知版本` +
        `（已知：${PROBE_ROWS_VERSIONS.join(" / ")}）—— 拒绝按普通模式跑`,
    };
  }

  const problems = [];
  if (!data.protocol || typeof data.protocol !== "object" || Array.isArray(data.protocol)) {
    problems.push("缺 protocol（契约）");
  }
  if (!Array.isArray(data.classes)) {
    problems.push("缺 classes（地址类数组）");
  } else {
    data.classes.forEach((c, i) => {
      if (typeof c?.name !== "string" || c.name === "") problems.push(`classes[${i}] 缺 name`);
      if (!Array.isArray(c?.examples) || c.examples.length === 0) {
        problems.push(`classes[${i}] 缺 examples（至少一个可判例子）`);
      }
      if (typeof c?.allowedUnderPrivateNetwork !== "boolean") {
        problems.push(`classes[${i}] 缺 allowedUnderPrivateNetwork（布尔）`);
      }
    });
  }
  if (!Array.isArray(data.probeVectors)) {
    problems.push("缺 probeVectors（送进 node/python 探针的输入清单）");
  }
  if (!Array.isArray(data.adminInputs)) {
    problems.push("缺 adminInputs（送进 admin 探针的输入清单）");
  }
  if (!data.rows || typeof data.rows !== "object" || Array.isArray(data.rows)) {
    problems.push("缺 rows（三侧的行）");
  } else {
    for (const side of ["node", "python", "admin"]) {
      const rows = data.rows[side];
      if (!Array.isArray(rows)) {
        problems.push(`rows.${side} 不是数组`);
        continue;
      }
      rows.forEach((r, i) => {
        if (side === "admin") {
          if (typeof r?.key !== "string" || r.key === "") {
            problems.push(`rows.admin[${i}] 缺 key`);
          } else if (r?.unsupported === undefined && !r?.verdicts) {
            problems.push(`rows.admin[${i}]（${r.key}）缺 verdicts`);
          }
        } else {
          if (typeof r?.name !== "string" || r.name === "") problems.push(`rows.${side}[${i}] 缺 name`);
          if (typeof r?.denied !== "boolean") problems.push(`rows.${side}[${i}] 缺 denied（布尔）`);
        }
      });
    }
  }
  if (!data.allowlist || !Array.isArray(data.allowlist.entries)) {
    problems.push("缺 allowlist.entries（豁免账）");
  }
  if (typeof data.today !== "number" || !Number.isFinite(data.today)) {
    problems.push("缺 today（UTC 日序号，必须是数字）");
  }
  if (problems.length > 0) {
    return {
      ok: false,
      reason:
        `字段校验未通过（${problems.length} 项）：` +
        `${problems.slice(0, 6).join("；")}${problems.length > 6 ? " …" : ""}`,
    };
  }
  return { ok: true, data };
}

// ── 接线层（原主脚本 `:1110-1147` 的 37 行 + `hardFailures` 汇总）────────────
/**
 * **接线**：把三侧探针跑出来的行，接成「该不该红」的完整判据。
 *
 * ## 为什么它现在是一个**纯函数**（本轮唯一的新增导出）
 *
 * R160 评估实测出**判据的接线层完全裸奔**：9 条变异（删 `hardFailures` 的各分支 /
 * 删 `failingIds` 收集 / 删探针覆盖检查）现有 25 条自检**一条都抓不到**。
 * 根因不是判据写错了，而是**接线既不在自检的覆盖范围内、也没有夹具能让它被单独测**。
 *
 * 本轮只做**第一步**：把接线搬到这里、让它成为**纯函数**（不读文件、不 spawn、
 * 无全局状态）⇒ **第二步**才可能给它造 `--probe-rows` 夹具（喂内存行），
 * 逐条变异 `hardFailures` 的每个分支并断言「该红时必红」。
 * **本轮没有装那个夹具 ⇒ 接线现在仍然没有牙齿**（见文件头「盲区」段）。
 *
 * ## 数据流（入参 = IO 已完成的产物；出参 = 判据的全部结论）
 *
 *   入参（全部由主脚本准备好 —— IO 只在主脚本发生）：
 *     · `protocol`        —— 契约（`protocol.json` 解析结果）
 *     · `classes`         —— 从契约推出的地址类（`buildGridClasses` 的产物）
 *     · `probeVectors` / `adminInputs` —— 送进探针的输入清单（用于覆盖完整性检查）
 *     · `nodeResults` / `pyResults` / `adminResults` —— 三侧探针**真跑**出来的行
 *     · `allowlist` / `allowlistError` —— 已读好的豁免账（读失败时传错误串）
 *     · `today`           —— 已算好的「今天」（UTC 日序号；由主脚本算，不在本模块取时钟）
 *     · `knownGapDoc`     —— 已读好的 knownGap 台账全文（读不到 ⇒ null）
 *
 *   出参：
 *     · `results`         —— 三向比对结果（报告的第一段）
 *     · `grid`            —— 逐格比对结果（`{structural, cells}`）
 *     · `adminVectors`    —— 第四面向量级结果（`{structural, results}`）
 *     · `adminVariants`   —— admin 两个入口互比（`{structural, diffs}`）
 *     · `structural`      —— 全部结构性红项（探针覆盖 + 网格/向量/变体结构红）
 *     · `failingIds`      —— 当前不一致的格（幂等 id，带侧名）
 *     · `allowlistResults`—— 豁免账判据结果
 *     · `scopedIds`       —— 豁免账里登记过的 scope id 集合（报告用它标 `ALLOW`）
 *     · `hardFailures`    —— **最终红项清单**（决定 exit 1）
 *
 * @param {object} input 入参（见上）
 * @returns {object} 出参（见上）
 */
export function judgeAll({
  protocol,
  classes,
  probeVectors = [],
  adminInputs = [],
  nodeResults = [],
  pyResults = [],
  adminResults = [],
  allowlist = null,
  allowlistError = null,
  today,
  knownGapDoc = null,
}) {
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

  const allowlistResults = allowlistError
    ? [{ name: `${FOUR_WAY_ALLOWLIST_REL}：结构`, ok: false, actual: [allowlistError] }]
    : judgeAllowlist({
        failing: failingIds,
        allowlist,
        today,
        knownGapDoc,
      });
  const scopedIds = new Set(
    (Array.isArray(allowlist?.entries) ? allowlist.entries : []).flatMap((e) =>
      Array.isArray(e?.scope) ? e.scope : [],
    ),
  );

  const hardFailures = [
    ...results.filter((r) => !r.ok).map((r) => `三向：${r.name}`),
    ...structural,
    ...allowlistResults.filter((r) => !r.ok).map((r) => `豁免账：${r.name}`),
    ...adminVariants.diffs,
  ];

  return {
    results,
    grid,
    adminVectors,
    adminVariants,
    structural,
    failingIds,
    allowlistResults,
    scopedIds,
    hardFailures,
  };
}
