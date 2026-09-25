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
 * ## 五道检查（顺序固定，任一 DENY 即终止）
 *   ① 工具白名单：该 session.kind 是否允许此工具
 *   ② 分级审批：tier 与策略对照（含硬禁用）
 *   ③ 参数校验：schema + 危险模式扫描（shell / 路径 / SSRF / 超长）
 *   ④ 资源范围：能否操作该 resource（scope 交叉验证）
 *   ⑤ 速率与熔断：同工具频次 / 连续失败
 *
 * ## 判定顺序为什么重要
 * 固定的顺序让同一份输入总是得到同一个 verdict——便于测试断言与指标
 * 聚合。若顺序随机，`autoflow_agent_denied_total{reason}` 就会漂移，
 * 「为什么被拒」的统计失去意义。
 */

/** 闸门判定结果。 */
export type BoundaryVerdict =
  | { kind: "ALLOW"; spec: AgentToolSpec }
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
  | "hard_disabled";

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
   */
  check(
    session: AgentSession,
    toolName: string,
    args: Record<string, unknown> | null,
    callCountForTool: number,
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

    // ── ⑥ 分级审批（最后一道——前面都是「一律拒绝」，这里是「可批准」）──
    const policy = this.resolveApprovalPolicy();

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

    return { kind: "ALLOW", spec };
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
      const strVerdict = this.scanValue(spec.name, key, value);
      if (strVerdict) return strVerdict;
    }

    return null;
  }

  /** 递归扫描字符串值（含嵌套对象/数组）。 */
  private scanValue(
    toolName: string,
    key: string,
    value: unknown,
  ): BoundaryVerdict | null {
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LEN) {
        return this.deny(
          "invalid_params",
          `${toolName}.${key}: 参数过长（${value.length} > ${MAX_STRING_LEN}）`,
        );
      }
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
        const v = this.scanValue(toolName, key, item);
        if (v) return v;
      }
      return null;
    }

    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const nested = this.scanValue(toolName, `${key}.${k}`, v);
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

    if (typeof targetId === "string" && !allowed.includes(targetId)) {
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
