import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AgentSession } from "../entities/agent-session.entity";
import {
  AGENT_TOOL_BY_NAME,
  HARD_DISABLED_REASON,
  toolsForSessionKind,
  type AgentToolSpec,
} from "../tools/tool-registry";
import { recordRuntime } from "../../metrics/runtime-metrics-entry";

/**
 * P3（agent-and-deployment）：边界闸门（设计文档 03 §5）。
 *
 * ## 这是唯一的一道闸门
 * `ToolExecutorService` 是工具执行的**唯一入口**，它在执行前强制调用本服务。
 * 没有任何工具能绕过——这是「模型行为不可信，全靠代码层闸门」的实现。
 *
 * ## 七道检查（顺序固定，任一 DENY 即终止）
 *   ① 工具白名单：该 session.kind 是否允许此工具
 *   ② 硬禁用：任何情况下不可执行且不可配置（approve/reject_deployment）
 *   ③ 参数校验：schema + 危险模式扫描（shell / 路径 / SSRF / 超长）
 *   ④ 资源范围：能否操作该 resource（scope 交叉验证）
 *   ⑤ 速率与熔断：同工具频次 / 连续失败
 *   ⑥ 分级审批：可批准的最后一道（dangerous / 逐工具 / write 策略）
 *   ⑦ 可执行代码源：自动化会话不得经工具参数引入 glueSource 等代码源
 *      （C1，2026-10-31；判据见 validateExecutableSource）
 *
 * ## 判定顺序为什么重要
 * 固定的顺序让同一份输入总是得到同一个 verdict——便于测试断言与指标
 * 聚合。若顺序随机，`autoflow_agent_denied_total{reason}` 就会漂移，
 * 「为什么被拒」的统计失去意义。
 */

/** 闸门判定结果。 */
export type BoundaryVerdict =
  // approvedApprovalKey：本次放行所依据的审批单键（执行体据此原子领取；
  // 无审批闸的工具为 undefined）。带出来是为了让「放行」与「领取」绑定同
  // 一个键，调用方不必重算。
  | { kind: "ALLOW"; spec: AgentToolSpec; approvedApprovalKey?: string }
  | { kind: "DENY"; reason: DenyReason; message: string }
  | { kind: "NEED_APPROVAL"; spec: AgentToolSpec; message: string };

/** 拒绝原因——与 `autoflow_agent_denied_total{reason}` 的标签取值一一对应。 */
export type DenyReason =
  | "not_in_toolset"
  | "needs_approval"
  | "invalid_params"
  | "out_of_scope"
  | "rate_limited"
  | "circuit_open"
  | "hard_disabled"
  // C1（2026-10-31 实施轮）：自动化会话试图经工具参数引入可执行代码源
  // （glueSource 等）。见第⑦道闸 validateExecutableSource 的攻击链注释。
  | "executable_source_in_automation";

/** 审批策略：哪些 tier 需要人工点头。 */
export interface ApprovalPolicy {
  /** write 类是否需要审批。默认 false（收敛性写操作默认放行）。 */
  writeRequiresApproval: boolean;
  /** dangerous 类是否需要审批。默认 true（且需显式启用该类工具）。 */
  dangerousRequiresApproval: boolean;
  /** 是否允许 dangerous 类工具（false = 直接拒，不给审批机会）。 */
  allowDangerous: boolean;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  writeRequiresApproval: false,
  dangerousRequiresApproval: true,
  // 默认不允许危险工具——要用必须显式打开，且届时仍需审批
  allowDangerous: false,
};

/** 速率限制配置。 */
export interface RateLimit {
  /** 同一工具在会话内的最大调用次数。 */
  maxCallsPerTool: number;
  /** 同一工具连续失败多少次后熔断。 */
  maxConsecutiveFailures: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = {
  maxCallsPerTool: 15,
  maxConsecutiveFailures: 3,
};

/** 参数长度上限（超长载荷拒绝）。 */
const MAX_STRING_LEN = 100_000;

/**
 * 可执行代码源的字段名全集（C1，2026-10-31 实施轮）。
 *
 * 这八个键是**任务定义里决定「执行什么代码」的列**（`Task` 实体：
 * `glueSource`/`glueLanguage` :364-367、`gitRepo`/`gitBranch`/`gitCommit`
 * :100-108 的代码接入优先级、`codeSource` :245、`entrypoint` :164、
 * `runtimeVersion` :149；`CreateTaskDto` 同名可选字段 :162/:218/:457-458），
 * 与 `AgentToolSpec.executableSourceFields` 一起构成第⑦道闸的唯一判据。
 *
 * 为什么是「键名集合」而不是内容扫描：规格 §6-C1 ④ 明确**不做前缀匹配、
 * 不引外部依赖**——判据要可复核、结果要确定（与 DANGEROUS_PATTERNS 的
 * 启发式扫描不同，后者带 false positive，这里只回答「这次调用的参数里
 * 有没有一个键会直通代码源列」）。导出它是为了让红队脚本
 * `scripts/agent-boundary-check.mjs` 逐个键验证闸门真的覆盖，防止本表
 * 与实现漂移。
 */
export const EXECUTABLE_SOURCE_KEYS: ReadonlySet<string> = new Set([
  "glueSource",
  "glueLanguage",
  "gitRepo",
  "gitBranch",
  "gitCommit",
  "codeSource",
  "entrypoint",
  "runtimeVersion",
]);

/**
 * 嵌套扫描深度上限。
 *
 * scanValue 对嵌套对象/数组递归；参数来自 LLM 的 JSON 输出，`[[[…]]]`
 * 形态在 100KB 字符预算内可嵌数万层——递归本身会先于任何模式匹配爆栈
 * （RangeError 从闸门逃出去 = 「边界服务自己崩了」）。深度超限按
 * invalid_params 拒绝：合法工具参数没有这么深的嵌套（工具 schema 都是
 * 两三层结构），拒绝是如实的语义而不是猜测。
 */
const MAX_SCAN_DEPTH = 32;

/**
 * 危险模式扫描（设计文档 03 §5.2）。
 *
 * 工具的字符串参数来自 LLM，**必须视为不可信输入**。这里的模式针对
 * 「会被拼进 shell / 路径 / URL」三类注入面。
 *
 * 注意：本表的目的是**纵深防御**，不是唯一防线——真正执行时各工具自身
 * 还有校验（如 executor-package 上传走既有安全校验链）。
 */
const DANGEROUS_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  // shell 元字符（命令注入）
  { re: /[;&|`$]|\$\(|\|\||&&/, label: "shell metacharacter" },
  { re: /\r|\n/, label: "newline (command injection vector)" },
  // 路径穿越
  { re: /\.\.[/\\]/, label: "path traversal" },
  { re: /^\/etc\/|^\/proc\/|^\/sys\//, label: "sensitive absolute path" },
  { re: /^~[/\\]/, label: "home-dir expansion" },
  // SSRF（内网/元数据地址）
  {
    re: /^https?:\/\/(127\.|localhost|0\.0\.0\.0|10\.|192\.168\.|169\.254\.)/i,
    label: "SSRF (private/link-local address)",
  },
];

@Injectable()
export class AgentBoundaryService {
  private readonly logger = new Logger(AgentBoundaryService.name);

  /**
   * 熔断计数：`${sessionId}:${toolName}` → 连续失败次数。
   *
   * 为什么放进程内而非 DB：熔断是**会话级瞬时状态**，进程重启后清空是
   * 可接受的（重启后 Agent 重新开始，连续失败计数从头累计）。放 DB 会
   * 让每次工具调用都多一次写，得不偿失。
   */
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  /**
   * 主判定入口。
   *
   * @param session 会话（白名单 + scope 来源）
   * @param toolName 请求的工具名
   * @param args 工具参数（**不可信**）
   * @param callCountForTool 该工具在本会话内已调用次数（调用方从 DB 数）
   * @param approvedApprovalKey 调用方持有的**已批准审批单键**（实施轮 #14）
   *
   * `approvedApprovalKey` 只放行「⑥ 分级审批」这一步，其余六道闸（工具集、
   * 硬禁用、参数、scope、速率/熔断、⑦ 可执行代码源）**照旧生效**——人工点头
   * 放行的是「这个具体调用可以做」，不是「这个会话此后不受约束」。是否允许
   * 放行由执行体判定（它查库确认该键存在且状态为 granted，并在执行前原子
   * 领取），闸门本身不读库（纯函数，可单测）。
   */
  check(
    session: AgentSession,
    toolName: string,
    args: Record<string, unknown> | null,
    callCountForTool: number,
    approvedApprovalKey: string | null = null,
  ): BoundaryVerdict {
    const spec = AGENT_TOOL_BY_NAME.get(toolName);

    // ── ① 工具存在性 + 会话白名单 ──────────────────────────────────
    if (!spec) {
      return this.deny(
        "not_in_toolset",
        `未知工具 ${toolName}——不在 Agent 工具集内。`,
      );
    }

    const allowed = toolsForSessionKind(session.kind);
    if (allowed !== null && !allowed.includes(toolName)) {
      return this.deny(
        "not_in_toolset",
        `工具 ${toolName} 不在会话类型「${session.kind}」的可用集合内。`,
      );
    }

    // ── ② 硬禁用（在审批之前——它连审批机会都没有）────────────────
    if (spec.hardDisabled) {
      return this.deny(
        "hard_disabled",
        `${toolName} 硬禁用。${HARD_DISABLED_REASON}`,
      );
    }

    // ── ③ 参数校验 ────────────────────────────────────────────────
    const paramVerdict = this.validateParams(spec, args);
    if (paramVerdict) return paramVerdict;

    // ── ④ 资源范围（scope 交叉验证）───────────────────────────────
    const scopeVerdict = this.validateScope(session, spec, args);
    if (scopeVerdict) return scopeVerdict;

    // ── ⑤ 速率与熔断 ──────────────────────────────────────────────
    const rateLimit = this.resolveRateLimit();

    const breakerKey = `${session.id}:${toolName}`;
    const failures = this.consecutiveFailures.get(breakerKey) ?? 0;
    if (failures >= rateLimit.maxConsecutiveFailures) {
      return this.deny(
        "circuit_open",
        `工具 ${toolName} 在本会话内已连续失败 ${failures} 次，已熔断。` +
          `请改用其他途径，不要重复调用同一工具。`,
      );
    }

    if (callCountForTool >= rateLimit.maxCallsPerTool) {
      return this.deny(
        "rate_limited",
        `工具 ${toolName} 在本会话内已调用 ${callCountForTool} 次（上限 ${rateLimit.maxCallsPerTool}）。`,
      );
    }

    // ── ⑥ 分级审批（可批准的最后一道；⑦ 是它后面的一道「一律拒绝」）──
    const policy = this.resolveApprovalPolicy();

    // 已获批的**这一具体调用**：跳过三处 NEED_APPROVAL。
    // 注意 policy 级禁用（allowDangerous=false）**不**被审批覆盖——那是
    // 「这个能力没开」，不是「这次需要人点头」；用审批去覆盖等于绕过配置。
    // 同理：⑦ 可执行代码源闸也不被审批覆盖（故本分支不 early return）。
    if (approvedApprovalKey) {
      if (spec.tier === "dangerous" && !policy.allowDangerous) {
        return this.deny(
          "needs_approval",
          `危险类工具 ${toolName} 当前未启用（agent.policy.allowDangerous=false）。` +
            `已批准的审批单 ${approvedApprovalKey} 不能覆盖配置级禁用。`,
        );
      }
      // C1：批准单**不是**第⑦道闸的通行证，故这里不 early return——
      // 继续落到 ⑦（自动化会话即便持批准单也 DENY；chat 会话的「批准」
      // 恰好就是 ⑦ 要求的那个点头，见 validateExecutableSource）。
      // 末尾统一放行时回带 approvedApprovalKey 供执行体原子领取。
    } else {
      if (spec.tier === "dangerous") {
        if (!policy.allowDangerous) {
          return this.deny(
            "needs_approval",
            `危险类工具 ${toolName} 当前未启用（agent.policy.allowDangerous=false）。`,
          );
        }
        if (policy.dangerousRequiresApproval) {
          return {
            kind: "NEED_APPROVAL",
            spec,
            message: `危险类工具 ${toolName} 需人工审批。`,
          };
        }
      }

      // ⑦ 必须**早于**下面两道审批闸求值（2026-11-02，S1-C1 出清轮）。
      //
      // 为什么顺序是语义的一部分：`create_task_from_template` 补上
      // `approvalRequired` 之后，若 ⑥ 先返回 NEED_APPROVAL，自动化会话
      // （app_scaffold / sop_authoring）拿到的结论就从 ⑦ 的
      // `DENY(executable_source_in_automation)` **降级**成「可以申请审批」——
      // 而 ⑦ 对自动化会话的语义逐字是「连批准机会都不给」（能力没开，
      // 与 ② 硬禁用同类）。降级后管理员点了头、会话恢复，⑦ 仍然 DENY：
      // 一次白点的审批 + 一条注定失败的会话，且「审批可以触达代码源」的
      // 假象被写进了审计面。故这里先跑 ⑦（`approved=false`：此刻还没有票），
      // 已批准路径的 ⑦ 仍在末尾照跑——两处调用都是纯函数，重复求值无副作用。
      const sourceVerdictBeforeApproval = this.validateExecutableSource(
        session,
        spec,
        args,
        false,
      );
      if (sourceVerdictBeforeApproval) return sourceVerdictBeforeApproval;

      // 逐工具的审批闸（如 sop_publish）：**不随**全局写策略放宽而放宽——
      // 发布权 = 间接指令注入权（SOP 会成为执行器 Agent 的执行依据）。
      if (spec.approvalRequired) {
        return {
          kind: "NEED_APPROVAL",
          spec,
          message: `工具 ${toolName} 需人工审批（发布/修订会改变执行器 Agent 的执行依据）。`,
        };
      }

      if (spec.tier === "write" && policy.writeRequiresApproval) {
        return {
          kind: "NEED_APPROVAL",
          spec,
          message: `写类工具 ${toolName} 需人工审批。`,
        };
      }
    }

    // ── ⑦ 可执行代码源（C1；审批不能把它放宽）────────────────────────
    //
    // 2026-11-02：⑦ 现在求值**两次**——无票路径上先于 ⑥ 的审批闸跑一次
    // （见上面 `sourceVerdictBeforeApproval` 的顺序说明），这里再跑一次覆盖
    // 「持已批单」的路径（自动化会话即便持票也 DENY；chat 的「批准」恰好
    // 就是 ⑦ 要求的那个点头）。
    const sourceVerdict = this.validateExecutableSource(
      session,
      spec,
      args,
      approvedApprovalKey !== null,
    );
    if (sourceVerdict) return sourceVerdict;

    return approvedApprovalKey
      ? { kind: "ALLOW", spec, approvedApprovalKey }
      : { kind: "ALLOW", spec };
  }

  // ── ⑦ 可执行代码源（C1）──────────────────────────────────────────

  /**
   * C1（2026-10-31 实施轮）：**自动化会话不得通过工具参数引入可执行代码源**。
   *
   * ## 挡的是什么攻击链（每一环我亲自核过）
   *   1. `create_task_from_template` 是 `tier: "write"`、**无**
   *      `approvalRequired`（`tools/tool-registry.ts:529-561` 的 spec）；
   *   2. 它的 `overrides` 在 TOOLS-05 下走 `freeTextFields`，跳过危险模式
   *      扫描（本文件 validateParams 的 freeText 分支）；
   *   3. 绑定时被**原样展开**进 CreateTaskDto
   *      （`tools/tool-binder.service.ts:470-480` 的 `{...args.overrides}`）；
   *   4. `overrides.glueSource` 一路落到执行器并被执行
   *      （`executor/dispatch-task-payload.util.ts:46-47` 的派发白名单 →
   *      执行器 `apps/executor-node/src/task-worker.ts:14` 读 glueSource）。
   *   ⇒ `app_scaffold` / `sop_authoring` 会话能在**零审批**下把任意脚本落成
   *     可定时执行的任务。沙箱默认关闭的部署里，这等于执行器权限上的任意
   *     代码执行（调研切片 S1 §4-S1 的六步链）。
   *
   * ## 判据（只回答一个问题，不猜内容）
   *   取工具用 `executableSourceFields` 显式声明的那些 args 字段；其中任一
   *   字段的值是**对象**且其键命中 `EXECUTABLE_SOURCE_KEYS` ⇒
   *     · `session.kind === "chat"`：`NEED_APPROVAL`（管理员可在审批链上
   *       本人点头；已获批的调用 `approved === true` 时本闸通过——否则 chat
   *       会话会陷入「批准 → 重放 → 又要批准」的死循环，把规格承诺的
   *       兜底路径堵死）；
   *     · 其余 kind：`DENY`（连批准机会都不给——自动化会话不该有人替它
   *       逐次背书代码源，与 ② 硬禁用同一种「能力没开」语义）。
   *
   * ## 明确**不**检查什么（防止被误当成内容审查而误伤）
   *   · 不看代码内容：不做前缀匹配、不做正则、不判危害、不引外部依赖
   *     （规格 §6-C1 ④）；
   *   · 不下钻嵌套：`overrides`/`patch` 只有在**与 CreateTaskDto 同层**时
   *     才会落进任务定义（DTO 白名单，`task/dto/create-task.dto.ts`），
   *     嵌一层就写不进实体，不是绕过；
   *   · 不管 `trigger_task` 的 `params`：C1 堵的是「产物怎么来的」，触发
   *     既有任务是 incident 会话的排障主力（规格 §6-C1 ③ 明确不加门）；
   *   · 不拦「只改 timeout/name/description」这类非代码字段的 overrides
   *     ——它们不含 `EXECUTABLE_SOURCE_KEYS` 任一键。
   *
   * 回退开关 `agent.policy.executableSourceGate`（默认 **开** = fail-closed）。
   */
  private validateExecutableSource(
    session: AgentSession,
    spec: AgentToolSpec,
    args: Record<string, unknown> | null,
    approved: boolean,
  ): BoundaryVerdict | null {
    const fields = spec.executableSourceFields;
    if (!fields || fields.length === 0) return null;
    // 关掉开关时本闸整体不生效（回退路径；默认开，见 resolveExecutableSourceGate）。
    if (!this.resolveExecutableSourceGate()) return null;

    const a = args ?? {};
    const hits: string[] = [];
    for (const field of fields) {
      const value = a[field];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (EXECUTABLE_SOURCE_KEYS.has(key)) hits.push(`${field}.${key}`);
      }
    }
    if (hits.length === 0) return null;

    const where = `${spec.name} 的 ${hits.join(" / ")}`;
    if (session.kind === "chat") {
      // 已批准的这次调用就是这个点头本身——放行（末尾统一 ALLOW 并回带键）。
      if (approved) return null;
      return {
        kind: "NEED_APPROVAL",
        spec,
        message:
          `${where} 含可执行代码源（会落到任务定义的代码源列，随后由执行器` +
          `执行）——需人工确认这是本人意图，而不是被注入的载荷。`,
      };
    }

    return this.deny(
      "executable_source_in_automation",
      `自动化会话（kind=${session.kind}）不得经 ${where} 引入可执行代码源：` +
        `该产物会在本会话之外被无门执行（定时/手动触发），` +
        `等于把任意代码送到执行器。请改由 chat 会话（人工点头）或管理员直接操作。`,
    );
  }

  // ── ③ 参数校验 ──────────────────────────────────────────────────

  private validateParams(
    spec: AgentToolSpec,
    args: Record<string, unknown> | null,
  ): BoundaryVerdict | null {
    const a = args ?? {};

    // 必填项
    const required = (spec.parameters.required as string[] | undefined) ?? [];
    for (const key of required) {
      const v = a[key];
      if (v === undefined || v === null || v === "") {
        return this.deny("invalid_params", `${spec.name}: 缺少必填参数 ${key}`);
      }
    }

    // 未知键（对齐后端 forbidNonWhitelisted 的严格姿态）
    const props = Object.keys(
      (spec.parameters.properties as Record<string, unknown> | undefined) ?? {},
    );
    if (props.length > 0) {
      for (const key of Object.keys(a)) {
        if (!props.includes(key)) {
          return this.deny(
            "invalid_params",
            `${spec.name}: 未知参数 ${key}（后端 forbidNonWhitelisted 会 400）`,
          );
        }
      }
    }

    // 逐字段扫描
    for (const [key, value] of Object.entries(a)) {
      // TOOLS-05：自由文本字段（SOP 正文/YAML、脚本 patch、澄清答复）跳过
      // 危险模式，只保留长度/深度闸——否则正常的多行文本会被判成注入。
      const freeText = spec.freeTextFields?.includes(key) ?? false;
      const strVerdict = this.scanValue(spec.name, key, value, 0, freeText);
      if (strVerdict) return strVerdict;
    }

    return null;
  }

  /** 递归扫描字符串值（含嵌套对象/数组；深度超限按 invalid_params 拒绝）。 */
  private scanValue(
    toolName: string,
    key: string,
    value: unknown,
    depth: number,
    freeText = false,
  ): BoundaryVerdict | null {
    if (depth > MAX_SCAN_DEPTH) {
      return this.deny(
        "invalid_params",
        `${toolName}.${key}: 参数嵌套超过 ${MAX_SCAN_DEPTH} 层（畸形/恶意载荷）`,
      );
    }
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LEN) {
        return this.deny(
          "invalid_params",
          `${toolName}.${key}: 参数过长（${value.length} > ${MAX_STRING_LEN}）`,
        );
      }
      if (freeText) return null;
      for (const { re, label } of DANGEROUS_PATTERNS) {
        if (re.test(value)) {
          return this.deny(
            "invalid_params",
            `${toolName}.${key}: 参数含危险模式（${label}）`,
          );
        }
      }
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const v = this.scanValue(toolName, key, item, depth + 1, freeText);
        if (v) return v;
      }
      return null;
    }

    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const nested = this.scanValue(
          toolName,
          `${key}.${k}`,
          v,
          depth + 1,
          freeText,
        );
        if (nested) return nested;
      }
      return null;
    }

    return null;
  }

  // ── ④ 资源范围 ──────────────────────────────────────────────────

  /**
   * scope 交叉验证（设计文档 03 §5.3）。
   *
   * 解决「Agent 在排查 app-foo 时顺手把 app-bar 删了」——即使 tool tier 允许，
   * 越出 scope 也拒。
   *
   * scope 语义：
   *   `{}`（空对象，缺省） → **不可操作任何资源**（安全默认）
   *   `{ applications: [] }` → 显式空列表，同样不可操作
   *   `{ applications: ["a"] }` → 只能操作 a
   *   `{ unrestricted: true }` → 不限制（仅 chat 类会用到，需显式设置）
   */
  private validateScope(
    session: AgentSession,
    spec: AgentToolSpec,
    args: Record<string, unknown> | null,
  ): BoundaryVerdict | null {
    // 不绑定资源的工具无需 scope 校验（如 list_tasks / get_scheduler_health）
    if (!spec.resourceKind || spec.resourceKind === "none") return null;

    const scope = (session.scopeJson ?? {}) as Record<string, unknown>;
    if (scope.unrestricted === true) return null;

    const idParam = spec.resourceIdParam;
    const targetId = idParam ? args?.[idParam] : undefined;

    // 按资源类型取允许集合。命名约定：applications / executors / tasks / projects
    const collectionKey = `${spec.resourceKind}s`;
    const allowedRaw = scope[collectionKey];
    const allowed = Array.isArray(allowedRaw) ? (allowedRaw as string[]) : [];

    if (allowed.length === 0) {
      return this.deny(
        "out_of_scope",
        `会话作用域未授权任何 ${spec.resourceKind}——` +
          `工具 ${spec.name} 不可用。`,
      );
    }

    // B-2：绑定资源的工具必须携带目标 id——「未提供 id 直接放行」等于
    // 白名单可以被参数缺省绕过（如 sop_get 只传 slug 时 targetId 缺失，
    // 任意 SOP 都能读）。id 的归一（slug → id）是执行体入口的职责，
    // 闸门语义保持单一：必须有 id，且 id 必须命中白名单。
    if (typeof targetId !== "string") {
      return this.deny(
        "out_of_scope",
        `${spec.name}: 缺少资源 id 参数 ${idParam ?? "(未声明)"}——` +
          `绑定资源的工具必须显式指定目标 ${spec.resourceKind}。`,
      );
    }

    if (!allowed.includes(targetId)) {
      return this.deny(
        "out_of_scope",
        `${spec.name}: 目标 ${spec.resourceKind} ${targetId} 不在本会话作用域内。`,
      );
    }

    return null;
  }

  // ── 熔断记账（由执行器调用）────────────────────────────────────

  /**
   * 记录一次工具执行结果，维护连续失败计数。
   *
   * 为什么由执行器回调而不是闸门自己判断：闸门在**执行前**运行，拿不到
   * 本次结果。执行器执行后回调，下一步闸门即可看到累计值。
   */
  recordOutcome(sessionId: string, toolName: string, ok: boolean): void {
    const key = `${sessionId}:${toolName}`;
    if (ok) {
      this.consecutiveFailures.delete(key);
    } else {
      this.consecutiveFailures.set(
        key,
        (this.consecutiveFailures.get(key) ?? 0) + 1,
      );
    }
  }

  /** 会话结束后清理熔断状态（防内存泄漏——会话数会持续增长）。 */
  clearSession(sessionId: string): void {
    for (const key of [...this.consecutiveFailures.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.consecutiveFailures.delete(key);
      }
    }
  }

  // ── 判定记录（指标埋点）────────────────────────────────────────

  /** 统一出口：记录拒绝指标并返回 verdict。 */
  private deny(reason: DenyReason, message: string): BoundaryVerdict {
    recordRuntime("autoflow_agent_denied_total", { reason });
    this.logger.warn(`Agent boundary DENY [${reason}]: ${message}`);
    return { kind: "DENY", reason, message };
  }

  // ── 配置解析 ────────────────────────────────────────────────────

  resolveApprovalPolicy(): ApprovalPolicy {
    return {
      writeRequiresApproval: this.readBool(
        "agent.policy.writeRequiresApproval",
        DEFAULT_APPROVAL_POLICY.writeRequiresApproval,
      ),
      dangerousRequiresApproval: this.readBool(
        "agent.policy.dangerousRequiresApproval",
        DEFAULT_APPROVAL_POLICY.dangerousRequiresApproval,
      ),
      allowDangerous: this.readBool(
        "agent.policy.allowDangerous",
        DEFAULT_APPROVAL_POLICY.allowDangerous,
      ),
    };
  }

  /**
   * C1 开关：`agent.policy.executableSourceGate`（默认 **true** = fail-closed）。
   *
   * 回退口径（规格 §6-C1「风险与回退」）：现场若确有「自动化会话用 overrides
   * 改脚本」的既有用法且一时改不过来，可显式置 false 回退到旧行为；但被回退
   * 掉的正是「零审批代码源」这条链，故默认必须是关闸——安全默认不可由
   * 「没配」变成「放开」（G3.6）。关闸与否都不影响 chat 会话的审批语义。
   */
  resolveExecutableSourceGate(): boolean {
    return this.readBool("agent.policy.executableSourceGate", true);
  }

  private resolveRateLimit(): RateLimit {
    return {
      maxCallsPerTool: this.readInt(
        "agent.policy.maxCallsPerTool",
        DEFAULT_RATE_LIMIT.maxCallsPerTool,
      ),
      maxConsecutiveFailures: this.readInt(
        "agent.policy.maxConsecutiveFailures",
        DEFAULT_RATE_LIMIT.maxConsecutiveFailures,
      ),
    };
  }

  private readBool(key: string, fallback: boolean): boolean {
    const raw = this.config.get<unknown>(key);
    if (raw === undefined || raw === null || raw === "") return fallback;
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
    return fallback;
  }

  private readInt(key: string, fallback: number): number {
    const raw = this.config.get<unknown>(key);
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
}
