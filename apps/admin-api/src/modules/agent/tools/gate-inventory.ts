import type { AgentToolSpec } from "./tool-registry";

/**
 * 门判据的**显式清单**（S1-C5）。
 *
 * ## 这份清单防的是什么
 * 本仓的「需不需要人工门」是**逐工具手标**的（`AgentToolSpec.approvalRequired`
 * 一个可选布尔），默认策略里 `writeRequiresApproval=false`
 * （`boundary/agent-boundary.service.ts:68`）——也就是说：
 *
 * > **新增一个 `tier: "write"` 的工具、不写 `approvalRequired`，它天生就是无门的，
 * > 而且没有任何一处会因此变红。**
 *
 * 后果不是理论上的：`docs/design/agent-and-deployment/03-agent-tools-and-boundary.md`
 * 曾逐字声称 `deploy_application`「需审批（强制走 DEP-04）」，而代码里它一个审批
 * 标记都没有（本轮已按代码事实改文档）。文档与代码之所以能长期不一致，就是因为
 * 判据只存在于人的记忆里，没有可机械复核的落点。
 *
 * 所以这份清单的职责只有一条：**把「今天哪些 `tier === "write"` 的工具没有人工门」
 * 变成仓内可 grep、可 diff、可断言的显式数据**。新增/改名一个无门写工具必须在这里
 * 加一行并写理由（否则 `__tests__/gate-inventory.spec.ts` 红）；删掉一行而工具还在
 * （或名字压根不存在）同样红。
 *
 * ## 登记 ≠ 认可
 * 这是**登记册**，不是批准书。`kind` 里刻意区分了两类完全不同的东西：
 *   · 一类是「按设计就不该有门」（收敛性/可逆/只新建/草稿/已在上游被闸）；
 *   · 一类是 `"known-gap"`——**它确实该有门，但今天没有**，必须带 `ref` 指向
 *     登记它的地方（候选编号 / 设计决策）。把缺口登记成「已知」是为了让它可见、
 *     可追踪，不是为了让守卫闭嘴。
 *
 * **已修复的条目仍然留着**（棘轮，不是快照）：`deploy_application` / `deploy_app`
 * 的零门已于 2026-11-01 实施轮修复（Agent 侧 fail-closed 前置，见设计文档 §3.1.1），
 * 但两条 `known-gap` **条目本身保留**——登记册要能回答「这个缺口是什么时候被发现的、
 * 怎么修的」，而不是把历史抹掉。`note` 里逐条写明修复状态。
 *
 * **2026-11-02：两条 `kind: "unbound"` 条目已出清**（`update_application` /
 * `cancel_deployment`）。它们的旧 note 逐字是「注册表声明了但 tool-binder 里没有
 * register —— 调用即『尚未实现』，今天不可执行」。本轮把执行体绑上（真调
 * `ApplicationService.update` / `AppDeploymentService.cancelDeployment`），
 * 并在注册表补了 `approvalRequired: true`。
 *
 * 这两条为什么**删掉**而不是改成别的 kind：判据①只收「`write` 且**无**审批」的
 * 工具——补了审批它们就不属于本清单；留在清单里会让判据①自相矛盾，也会让
 * 「清单 = 今天没有门的写工具」这句唯一的用途失真。棘轮在这里的含义是**理由
 * 不能静默过期**：一条登记错了的豁免，正确动作是出清并在本注释里写清「它
 * 什么时候、因为什么被移出」，而不是换个 kind 继续占位。历史见本条与
 * `tool-binder.service.ts` 的 `update_application` / `cancel_deployment` 头注。
 *
 * **2026-11-02（同日第二批）：`create_task_from_template` 的 `known-gap` 出清。**
 * 它的旧 note 逐字是「已知零门缺口（登记册 S1-C1，P0/b2）：overrides 走
 * freeTextFields 且绑定时原样展开进 CreateTaskDto，glueSource 一路到执行器
 * ——默认策略下等于零审批把任意代码送到执行器」。核实结论：**登记属实且比
 * note 写的更宽**——第⑦道闸（C1，2026-10-31）只覆盖「参数里确实带了代码源」
 * 这一种载荷，而该工具在默认策略（`writeRequiresApproval=false`）下，**不带**
 * 代码源的 `overrides`（cron/params/timeout）同样零门，而它的
 * `effectBound` 是 `persisted`（产物会在会话之外被定时/无门执行）。
 * 修法三件（全部落地）：① 注册表补 `approvalRequired: true`（**逐工具**闸，
 * 不随全局写策略放宽）；② 闸门顺序修正——⑦ 现在**早于** ⑥ 的
 * `approvalRequired` 求值，故自动化会话拿到的仍是 `DENY` 而不是降级成
 * 「可以申请审批」（`agent-boundary.service.ts` 的 `sourceVerdictBeforeApproval`）；
 * ③ **审批预览显示代码本体**——`executableSourceFields` 声明字段里的
 * `glueSource` 等键不再只给 16 位摘要，而是「代码头部 + 长度 + 行数 + 摘要」
 * （`tool-executor.service.ts` 的 `previewExecutableSource`）。③ 是这条缺口
 * 的真正难点：只补 ①② 会得到一个**盲批**入口——人看不见自己批的代码，责任
 * 却被转移给了签字人，比零门更糟。
 * 按判据①它不再属于本清单 ⇒ **条目删除**；保留本段作为历史说明。
 *
 * 判据（与 spec 一一对应，可人工复核）：
 *   ① `write` 且无 `approvalRequired` 的工具集合 == 本清单的名字集合（双向）；
 *   ② 每条理由非空、非占位；`known-gap` 必须带 `ref`；
 *   ③ 高危动词命名的工具不得被标成 `read`（见 `HIGH_RISK_NAME_PATTERN`）；
 *   ④ `kind: "unbound"` 的条目必须真的没有执行体（理由不会静默过期）。
 */

/**
 * 豁免理由的**类别**。这是判据词汇表，不是自由文本——
 * 新增一个类别等于新增一条「为什么可以没有门」的成文规则，必须能被人复核。
 */
export type GateExemptionKind =
  /** 收敛性动作：只触发/重试/终止**既有**产物，方向安全且可再触发。 */
  | "convergent"
  /** 可逆：存在同 tier 且同样无门的逆操作，或状态可自愈。 */
  | "reversible"
  /** 只新建对象，不改任何既有对象的行为。 */
  | "create-only"
  /** 只写草稿/工作副本，尚未成为执行依据。 */
  | "draft-only"
  /** 关键决策已在别处被人工闸（已发布对象 / 独立审批面），本工具只做搬运。 */
  | "upstream-gated"
  /** 靠会话白名单收窄暴露面：任何自动化会话都拿不到，只有 chat 能用。 */
  | "session-allowlist"
  /** 受控修订：对象与 bump 固定，且走与被闸动作同一套严格校验/版本闸。 */
  | "scoped-amendment"
  /**
   * 注册表声明了，但执行体未绑定——调用即「尚未实现」，今天不可执行。
   *
   * 2026-11-02：**今天没有任何条目用这个 kind**（原有的
   * `update_application` / `cancel_deployment` 已绑定执行体并补了
   * `approvalRequired`，见文件头注）。保留这个类别不是僵尸代码：它是
   * 「为什么可以暂时没有门」的一种**真实形态**——注册表先有声明、执行体
   * 后补是常态，而这段窗口里工具对模型是可见的。将来再出现同形态的声明
   * （声明了、未绑定、又恰好是 write 且无审批）仍应登记在这里，spec ④ 会
   * 在绑定执行体的那一刻逼人回来重新裁定要不要门。
   */
  | "unbound"
  /** **确实没有门**的已知缺口。必须带 `ref`（登记它的候选编号/设计决策）。 */
  | "known-gap";

export interface GateInventoryEntry {
  /** 工具名，必须与 `ALL_AGENT_TOOL_SPECS` 里的 `name` 逐字一致。 */
  readonly name: string;
  /** 豁免类别（判据）。 */
  readonly kind: GateExemptionKind;
  /** 一句理由 + 证据（file:line）。**空理由等于没登记。** */
  readonly note: string;
  /** 仅 `known-gap` 必填：登记它的地方（如 `S1-C1`）。 */
  readonly ref?: string;
}

/** 理由的最短长度（trim 后）。低于此值视为「没写」。 */
export const MIN_REASON_LENGTH = 12;

/** 占位理由的黑名单——写了这些等于没写。 */
const PLACEHOLDER_REASONS = [
  "todo",
  "tbd",
  "fixme",
  "待补",
  "待定",
  "占位",
  "xxx",
];

/**
 * 高危动词命名判据。
 *
 * 为什么是**锚定**的正则而不是规格里的裸 `delete_|kill_|...`：
 * 裸子串会误伤 `list_deployments` / `upgrade_deployment` / `approve_deployment`
 * （`deploy` 后面跟的是名词后缀不是动词宾语），一旦误伤，守卫就会被迫加豁免，
 * 豁免一多守卫就死了。这里只认「动词在名字开头」或「动词是名字的最后一段」：
 *   - `deploy_application` / `delete_mutex_group` / `kill_execution` ✓（开头）
 *   - `sop_publish` ✓（最后一段）；`list_deployments` / `upgrade_deployment` ✗
 */
export const HIGH_RISK_NAME_PATTERN =
  /^(?:delete|kill|stop|deploy|rollback|offline)_|_(?:delete|kill|stop|deploy|rollback|publish|offline)(?:_|$)/;

/**
 * 冻结清单：**2026-11-01 / HEAD f1eaf3cc** 时「`tier === "write"` 且没有
 * `approvalRequired`」的全部 16 个工具，按 registry 产出顺序。
 *
 * 2026-11-02：其中的 `update_application` / `cancel_deployment`（当时都是
 * `kind: "unbound"`）已绑定执行体并在注册表补了 `approvalRequired: true`，
 * 按判据①不再属于本清单 ⇒ 两条**已删除**（理由见文件头注）。同日第二批
 * `create_task_from_template`（`known-gap` / S1-C1）补了逐工具审批 ⇒ 再删
 * 一条（理由见文件头注那段）。今天的清单是 **13 条**，仍然是「今天所有无门
 * 写工具」的全集（判据①双向）。
 *
 * 这是**棘轮**不是快照：它不会自动跟随注册表变化，任何一侧变动都要在这里显式表态。
 */
export const GATE_INVENTORY: readonly GateInventoryEntry[] = [
  {
    name: "trigger_task",
    kind: "convergent",
    note:
      "只触发既有任务定义，不创造新的代码源；产物受任务自身定义与 scope 约束，" +
      "且可被 kill_execution 终止——方向安全（03 §2 Tier 2）。",
  },
  {
    name: "retry_execution",
    kind: "convergent",
    note:
      "admin API 无原生 retry 端点（NF-06），执行体回放原执行 params 走 manual-trigger，" +
      "产生新执行行但不改任务定义（tool-binder.service.ts:415-432）。",
  },
  {
    name: "pause_task",
    kind: "reversible",
    note: "resume_task 可原地恢复，无数据销毁、不改任务定义。",
  },
  {
    name: "resume_task",
    kind: "reversible",
    note: "pause_task 的逆操作本身；恢复只动运行态，不改任务定义。",
  },
  {
    name: "kill_execution",
    kind: "convergent",
    note: "只能终止在跑执行，不能启动或改配置——终止是收敛性动作（03 §2 Tier 2）。",
  },
  {
    name: "create_application",
    kind: "create-only",
    note: "只新建应用对象，不改任何既有应用的行为；新建对象要真正跑起来仍需 deploy。",
  },
  {
    name: "create_mutex_group",
    kind: "create-only",
    note: "新建组不改任何既有应用行为——应用只在 update_application 里显式挂组才入组（MUTEX-01）。",
  },
  {
    name: "update_mutex_group",
    kind: "session-allowlist",
    note:
      "不在任何自动化会话的白名单里（SESSION_TOOL_ALLOWLIST 只有 chat 的 null 覆盖它）；" +
      "收紧 scope/maxConcurrentPerDevice 会立即限流在跑业务，属「人该拍板」，故靠白名单而非逐工具审批。",
  },
  {
    name: "sop_draft",
    kind: "draft-only",
    note:
      "只写 SOP 工作副本（draft 语义）；已发布版本是快照，改工作副本不影响它，" +
      "成为执行依据仍需 sop_publish（该工具有逐工具审批闸）。",
  },
  {
    name: "sop_reply_clarification",
    kind: "scoped-amendment",
    note:
      "修订只作用于**在途指派**的既有澄清行、bump 固定 patch，且走与 publish 同一严格校验 + 版本快照" +
      "（sop.service.ts:1230-1268）；sop_review 白名单刻意不给 sop_publish/sop_draft。",
  },
  {
    name: "sop_assign",
    kind: "upstream-gated",
    note: "搬运的是**已发布**的 SOP 版本（发布那一步有人工闸），指派单只决定「哪台执行器跑哪个已批版本」。",
  },
  {
    name: "deploy_application",
    kind: "known-gap",
    ref: "03 §3 方案 C",
    note:
      "已核实并修复（2026-11-01 实施轮）：方案 C 把门全交给 DEP-04，而 DEP-04 是**按应用**的开关且默认 false" +
      "（application.entity.ts:60）——修复前「从未开过审批的应用，Agent 部署零门」。" +
      "现由 Agent 执行体（tool-binder.service.ts 的 deployApp）传 intent.forceApproval=" +
      "= agentDeployApprovalRequired()（默认 true = 一律要求人工审批；应用开了走同一条既有 pending_approval 路径，语义不变）；" +
      "逃生门 AGENT_DEPLOY_APPROVAL_REQUIRED=false 回退旧行为，默认开（安全侧）。" +
      "人工路径（控制台/API）行为逐字节不变——DEP-04 的默认值未改。",
  },
  {
    name: "deploy_app",
    kind: "known-gap",
    ref: "03 §3 方案 C",
    note:
      "deploy_application 的别名，共用同一个执行体（tool-binder.service.ts 的 deployApp），同一缺口、" +
      "同一修复（Agent 侧 fail-closed 前置，2026-11-01 实施轮）。",
  },
];

/** 审计结果：全为空才算绿。 */
export interface GateInventoryAudit {
  /** write 且无审批、却没登记 ⇒ 新增高危写工具忘了想审批这件事。 */
  unregistered: string[];
  /** 登记了、工具还在，但它已不再「write 且无审批」⇒ 清单该删这一行。 */
  noLongerExempt: string[];
  /** 登记了、注册表里却没有这个名 ⇒ 幽灵名（改名后没更新/手滑）。 */
  missingFromRegistry: string[];
  /** 理由空/占位，或 known-gap 缺 ref。 */
  badReasons: string[];
  /** 清单内重名。 */
  duplicateNames: string[];
  /** 高危动词命名却被标成 read ⇒ 分类可疑（既无审批也无 dangerous 兜底）。 */
  unexplainedHighRisk: string[];
}

const EMPTY_AUDIT: GateInventoryAudit = {
  unregistered: [],
  noLongerExempt: [],
  missingFromRegistry: [],
  badReasons: [],
  duplicateNames: [],
  unexplainedHighRisk: [],
};

/**
 * 纯函数审计：不读文件、不碰注册表单例，两个入参都由调用方给。
 *
 * 之所以做成纯函数：守卫要能对**合成夹具**跑（红队自证），而不是只能对今天的
 * 注册表跑一次——「只对当前数据成立的断言」无法证明守卫本身会红。
 */
export function auditGateInventory(
  specs: readonly AgentToolSpec[],
  inventory: readonly GateInventoryEntry[] = GATE_INVENTORY,
): GateInventoryAudit {
  const byName = new Map<string, AgentToolSpec>();
  for (const s of specs) byName.set(s.name, s);

  const isExempt = (s: AgentToolSpec): boolean =>
    s.tier === "write" && s.approvalRequired !== true;

  const actual = specs.filter(isExempt).map((s) => s.name);
  const registered = inventory.map((e) => e.name);
  const registeredSet = new Set(registered);

  const unregistered = actual.filter((n) => !registeredSet.has(n));

  const noLongerExempt = registered.filter((n) => {
    const spec = byName.get(n);
    // 幽灵名单独报，不在这里重复计
    return spec !== undefined && !isExempt(spec);
  });

  const missingFromRegistry = registered.filter((n) => !byName.has(n));

  const badReasons: string[] = [];
  for (const e of inventory) {
    const note = (e.note ?? "").trim();
    const lower = note.toLowerCase();
    if (note.length < MIN_REASON_LENGTH) {
      badReasons.push(`${e.name}: 理由为空或过短（< ${MIN_REASON_LENGTH} 字）`);
      continue;
    }
    if (PLACEHOLDER_REASONS.some((p) => lower.includes(p))) {
      badReasons.push(`${e.name}: 理由是占位符（${note}）`);
      continue;
    }
    if (e.kind === "known-gap" && !(e.ref ?? "").trim()) {
      badReasons.push(`${e.name}: kind=known-gap 必须带 ref（登记它的地方）`);
    }
  }

  const seen = new Set<string>();
  const duplicateNames: string[] = [];
  for (const n of registered) {
    if (seen.has(n)) duplicateNames.push(n);
    seen.add(n);
  }

  // 高危动词命名却被标成 read：既没有 approvalRequired，也没有 dangerous tier 的
  // 「默认禁用 + 默认审批」兜底，等于一个名字听起来能删东西的只读工具。
  const unexplainedHighRisk = specs
    .filter((s) => HIGH_RISK_NAME_PATTERN.test(s.name) && s.tier === "read")
    .map((s) => s.name);

  return {
    unregistered,
    noLongerExempt,
    missingFromRegistry,
    badReasons,
    duplicateNames,
    unexplainedHighRisk,
  };
}

export function isGateInventoryClean(a: GateInventoryAudit): boolean {
  return (Object.keys(EMPTY_AUDIT) as (keyof GateInventoryAudit)[]).every(
    (k) => a[k].length === 0,
  );
}

/** 把审计结果渲染成人能直接照做的修复指引（守卫失败时原样打出来）。 */
export function formatGateInventoryAudit(a: GateInventoryAudit): string {
  const lines: string[] = [];
  if (a.unregistered.length > 0) {
    lines.push(
      `漏登记：这些工具是 tier=write 且没有 approvalRequired，却不在 gate-inventory.ts 里——` +
        `\n  ${a.unregistered.join(", ")}` +
        `\n  → 要么在 tool-registry.ts 给它加 approvalRequired: true，` +
        `\n  → 要么在 GATE_INVENTORY 里加一行并写明「为什么它不需要人工门」。`,
    );
  }
  if (a.noLongerExempt.length > 0) {
    lines.push(
      `清单陈旧：这些名字还在清单里，但已不再是「write 且无审批」（多半是补了 approvalRequired）——` +
        `\n  ${a.noLongerExempt.join(", ")}` +
        `\n  → 从 GATE_INVENTORY 删掉这些行。`,
    );
  }
  if (a.missingFromRegistry.length > 0) {
    lines.push(
      `幽灵名：清单里有、注册表里没有——` +
        `\n  ${a.missingFromRegistry.join(", ")}` +
        `\n  → 工具改名/删除后忘了同步清单。`,
    );
  }
  if (a.badReasons.length > 0) {
    lines.push(`理由不合格：\n  ${a.badReasons.join("\n  ")}`);
  }
  if (a.duplicateNames.length > 0) {
    lines.push(`清单内重名：\n  ${a.duplicateNames.join(", ")}`);
  }
  if (a.unexplainedHighRisk.length > 0) {
    lines.push(
      `高危动词命名却被标成 read（无任何闸）：\n  ${a.unexplainedHighRisk.join(", ")}` +
        `\n  → 改 tier（write/dangerous），或改名（` +
        `HIGH_RISK_NAME_PATTERN=${HIGH_RISK_NAME_PATTERN.source}）。`,
    );
  }
  return lines.join("\n\n");
}

/** 供测试与未来设置页（S1 §8-O3）复用的只读投影。 */
export function gateInventoryByName(): ReadonlyMap<string, GateInventoryEntry> {
  return new Map(GATE_INVENTORY.map((e) => [e.name, e]));
}
