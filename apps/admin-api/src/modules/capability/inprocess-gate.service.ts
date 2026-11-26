/**
 * N24 中间形态 —— 进程内能力权限层的生产接线（P1/P2，进程外 host 不在本切片）。
 *
 * 判据零重写：权限三态 / 相对预算 / 失败降级分别直接调用 inprocess-gate.ts 的
 * 三个纯函数，严格按 classify → budget → degrade 顺序；只有 classify=allow 且
 * budget=allow 且 slots/streams 放行时才执行真实下游 invoke。
 *
 * 副作用全部落在本文件：预算计数 inc、降级动作执行（缓存 / 空结果 / 关闭）、
 * 审计 `capability.degraded`、slots 归还 / streams 退出。inprocess-gate.ts 纯函数
 * 与 capability-activation 的 record(dto, scope?) 契约逐字不动。
 *
 * 验收级别：单测 / 内存替身（真 PG / 真 Nest DI 由主控收口）。
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { CapabilityService } from "./capability.service";
import type {
  CapabilityActor,
  CapabilityResolution,
} from "./capability.service";
import {
  checkInProcessBudget,
  classifyCapabilityPermission,
  degradeOnFailure,
  type BudgetGenerationUsage,
  type BudgetVerdict,
  type CapabilityInvokeMode,
  type Decision,
  type DegradeAction,
  type DegradeVerdict,
  type InProcessBudgetState as BudgetVerdictState,
  type InProcessCapability,
} from "./inprocess-gate";
import {
  createBackpressure,
  type BackpressureController,
} from "./backpressure";

/** 降级审计 action 字面量（audit.md 表格 / 前端标签由主控集成）。 */
export const CAPABILITY_DEGRADED_ACTION = "capability.degraded";

/** 默认相对预算上限：调用方 provider 可在 options 覆盖。 */
export const DEFAULT_BUDGET_LIMIT = 64;
export const DEFAULT_MAX_SLOTS = 8;
export const DEFAULT_MAX_STREAMS = 4;

/**
 * 预算 state 由调用方 provider 持有；默认实现是进程内 Map 桶（per capability）。
 * get/inc 都是同步纯内存操作，judgement 仍交给 checkInProcessBudget。
 */
export interface InProcessBudgetState {
  readonly usage: Map<string, BudgetGenerationUsage[]>;
  readonly limitPerGeneration: number;
}

export interface InProcessBudgetStore {
  get(state: InProcessBudgetState, key: string, generation: string): number;
  inc(
    state: InProcessBudgetState,
    key: string,
    generation: string,
    units: number,
  ): void;
}

export interface InProcessCache {
  get(key: string): unknown | Promise<unknown>;
}

export interface InProcessGateOptions {
  readonly budgetState?: InProcessBudgetState;
  readonly budgetStore?: InProcessBudgetStore;
  readonly limitPerGeneration?: number;
  readonly backpressure?: BackpressureController;
  readonly maxSlots?: number;
  readonly maxStreams?: number;
  readonly cache?: InProcessCache | null;
}

export const INPROCESS_GATE_OPTIONS = Symbol("INPROCESS_GATE_OPTIONS");

export interface InProcessInvokeRequest {
  readonly key: string;
  /** 直接送 classify 的调用面；非法值 deny。 */
  readonly mode: CapabilityInvokeMode | string;
  /** 唯一真实副作用口；未通过任何闸时零调用。 */
  readonly invoke: () => unknown | Promise<unknown>;
  /** 已解析的 CapabilityResolution；缺省时由 resolveFor 现场投影。 */
  readonly resolution?: CapabilityResolution | null;
  /** generation 优先，缺席回落投影的 version。 */
  readonly generation?: string | null;
  readonly units?: number;
  readonly actor?: CapabilityActor;
  /** 下游抛错时的错误类别，送 degradeOnFailure。 */
  readonly errorKind?: string | null;
  /** use-cached 且无外部 cache 时返回的替身。 */
  readonly cachedResult?: unknown;
  /** empty-result 的替身；缺省 null。 */
  readonly emptyResult?: unknown;
  /** 运行时标记，不落库、不进 entity。 */
  readonly access?: "read" | "write";
  readonly dangerous?: boolean;
}

export type InProcessInvokeStatus = "ok" | "denied" | "degraded";
export type DegradeStage = "budget" | "slots" | "streams" | "failure";

export interface InProcessInvokeResult {
  readonly status: InProcessInvokeStatus;
  readonly decision: Decision;
  readonly reason: string;
  readonly value?: unknown;
  readonly budget?: BudgetVerdict;
  readonly action?: DegradeAction;
}

/** 降级审计 detail 的固定形状：stage + 纯函数原始判据字段，不多不少。 */
export interface CapabilityDegradedDetail {
  readonly key: string;
  readonly generation: string;
  readonly stage: DegradeStage;
  readonly action: DegradeAction;
  readonly errorKind: string;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
}

export function createBudgetState(
  limitPerGeneration: number = DEFAULT_BUDGET_LIMIT,
): InProcessBudgetState {
  return { usage: new Map(), limitPerGeneration };
}

export function createInMemoryBudgetStore(): InProcessBudgetStore {
  return {
    get(state, key, generation) {
      const rows = state.usage.get(key) ?? [];
      return rows.reduce(
        (sum, row) => (row.generation === generation ? sum + row.units : sum),
        0,
      );
    },
    inc(state, key, generation, units) {
      const rows = state.usage.get(key) ?? [];
      state.usage.set(key, [...rows, { generation, units }]);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * CapabilityResolution → InProcessCapability 投影。字段优先取 effective（由
 * resolveFor 的层叠合并产出），顶层同名键仅作向后兼容兜底；scope/attestation
 * 畸形一律投影成 null，让 classify 前置消毒 fail-closed。access/dangerous 是
 * 调用面运行时标记，不来自落库 manifest。
 */
export function projectInProcessCapability(
  resolution: CapabilityResolution | null | undefined,
  runtime?: {
    readonly access?: "read" | "write";
    readonly dangerous?: boolean;
  },
): InProcessCapability {
  const effective = isRecord(resolution?.effective) ? resolution.effective : {};
  const top = isRecord(resolution) ? resolution : {};
  const pick = (field: string): unknown =>
    Object.prototype.hasOwnProperty.call(effective, field)
      ? effective[field]
      : top[field];

  const scopeRaw = pick("scope");
  const attRaw = pick("attestation");
  const scope = isRecord(scopeRaw)
    ? {
        mode: typeof scopeRaw.mode === "string" ? scopeRaw.mode : undefined,
        guidance:
          typeof scopeRaw.guidance === "string" ? scopeRaw.guidance : undefined,
      }
    : null;
  const attestation =
    isRecord(attRaw) && typeof attRaw.signer === "string"
      ? {
          signer: attRaw.signer,
          ...(typeof attRaw.scope === "string" ? { scope: attRaw.scope } : {}),
        }
      : null;

  return {
    key: typeof resolution?.key === "string" ? resolution.key : undefined,
    kind:
      typeof pick("kind") === "string" ? (pick("kind") as string) : undefined,
    version:
      typeof pick("version") === "string" ? (pick("version") as string) : null,
    versionPin:
      typeof pick("versionPin") === "string"
        ? (pick("versionPin") as string)
        : null,
    scope,
    attestation,
    access: runtime?.access,
    dangerous: runtime?.dangerous,
  };
}

@Injectable()
export class InProcessCapabilityService {
  private readonly budgetState: InProcessBudgetState;
  private readonly budgetStore: InProcessBudgetStore;
  private readonly backpressure: BackpressureController;
  private readonly cache: InProcessCache | null;

  constructor(
    @Optional() private readonly capabilities: CapabilityService | null = null,
    @Optional()
    @Inject(AuditService)
    private readonly audit: AuditService | null = null,
    @Optional()
    @Inject(INPROCESS_GATE_OPTIONS)
    options: InProcessGateOptions = {},
  ) {
    this.budgetState =
      options?.budgetState ??
      createBudgetState(options?.limitPerGeneration ?? DEFAULT_BUDGET_LIMIT);
    this.budgetStore = options?.budgetStore ?? createInMemoryBudgetStore();
    this.backpressure =
      options?.backpressure ??
      createBackpressure({
        maxSlots: options?.maxSlots ?? DEFAULT_MAX_SLOTS,
        maxStreams: options?.maxStreams ?? DEFAULT_MAX_STREAMS,
      });
    this.cache = options?.cache ?? null;
  }

  /** 测试缝：暴露调用方持有的预算/背压状态，便于断言真实副作用。 */
  get budget(): InProcessBudgetState {
    return this.budgetState;
  }

  get pressure(): BackpressureController {
    return this.backpressure;
  }

  /** 唯一入口：classify → budget → slots/streams → invoke → degrade。 */
  async invoke(
    request: InProcessInvokeRequest,
  ): Promise<InProcessInvokeResult> {
    const key = typeof request?.key === "string" ? request.key.trim() : "";
    const mode = request?.mode;
    if (key.length === 0 || (mode !== "read" && mode !== "write")) {
      return { status: "denied", decision: "deny", reason: "invalid-request" };
    }

    // ① 权限判定：deny / ask 都 fail-closed，预算闸与下游一律不执行。
    const capability = await this.resolveCapability(request, key);
    const decision = classifyCapabilityPermission(capability, mode);
    if (decision !== "allow") {
      return { status: "denied", decision, reason: "permission-denied" };
    }

    // ② 相对预算：判据完全复用纯函数；degraded 时不 inc、不 invoke。
    const generation = this.generationOf(request, capability);
    const units = request.units;
    const budgetVerdict = checkInProcessBudget(this.verdictState(), {
      capabilityKey: key,
      generation,
      ...(units === undefined ? {} : { units }),
    });
    if (budgetVerdict.decision === "degraded") {
      return this.fail(
        "budget",
        "budget-exceeded",
        budgetVerdict,
        capability,
        request,
        decision,
        key,
      );
    }

    // ③ 双限流：槽位占用 + 流并发；任一拒绝即 fail-closed 降级。
    const token = this.backpressure.acquireSlot();
    if (token === null) {
      return this.fail(
        "slots",
        "slots-exhausted",
        budgetVerdict,
        capability,
        request,
        decision,
        key,
      );
    }
    let entered = false;
    try {
      entered = this.backpressure.enterStream();
      if (!entered) {
        return this.fail(
          "streams",
          "streams-exhausted",
          budgetVerdict,
          capability,
          request,
          decision,
          key,
        );
      }

      this.budgetStore.inc(
        this.budgetState,
        key,
        budgetVerdict.generation,
        units === undefined ? 1 : units,
      );
      try {
        const value = await request.invoke();
        return {
          status: "ok",
          decision,
          reason: "ok",
          value,
          budget: budgetVerdict,
        };
      } catch (err: unknown) {
        const errorKind = this.errorKindOf(request, err);
        return this.fail(
          "failure",
          errorKind,
          budgetVerdict,
          capability,
          request,
          decision,
          key,
        );
      }
    } finally {
      if (entered) this.backpressure.leaveStream();
      this.backpressure.releaseSlot(token);
    }
  }

  /** resolveFor 投影；现场解析失败一律投影成空能力（classify ⇒ deny）。 */
  private async resolveCapability(
    request: InProcessInvokeRequest,
    key: string,
  ): Promise<InProcessCapability> {
    const runtime = {
      access: request.access,
      dangerous: request.dangerous,
    };
    if (request.resolution) {
      return projectInProcessCapability(request.resolution, runtime);
    }
    if (!this.capabilities) return projectInProcessCapability(null, runtime);
    try {
      const rows = await this.capabilities.findAll();
      const cap = rows.find((row) => row && row.key === key);
      if (!cap) return projectInProcessCapability(null, runtime);
      const config: Record<string, unknown> = {};
      if (typeof cap.kind === "string") config.kind = cap.kind;
      if (cap.scope != null) config.scope = cap.scope;
      if (typeof cap.version === "string") config.version = cap.version;
      if (typeof cap.versionPin === "string") {
        config.versionPin = cap.versionPin;
      }
      if (cap.attestation != null) config.attestation = cap.attestation;
      const resolution = await this.capabilities.resolveFor({
        key,
        layers: [{ name: "managed", config }],
      });
      return projectInProcessCapability(resolution, runtime);
    } catch {
      // fail-closed：解析异常不产生授权证据。
      return projectInProcessCapability(null, runtime);
    }
  }

  private generationOf(
    request: InProcessInvokeRequest,
    capability: InProcessCapability,
  ): string {
    if (
      typeof request.generation === "string" &&
      request.generation.length > 0
    ) {
      return request.generation;
    }
    return typeof capability.version === "string" ? capability.version : "";
  }

  private errorKindOf(request: InProcessInvokeRequest, err: unknown): string {
    const raw =
      typeof request.errorKind === "string" && request.errorKind.length > 0
        ? request.errorKind
        : err instanceof Error
          ? err.message
          : "";
    return raw.trim().toLowerCase();
  }

  /** 纯函数读取的只读快照（state 由 provider 持有，这里只做投影）。 */
  private verdictState(): BudgetVerdictState {
    const usage: Record<string, BudgetGenerationUsage[]> = {};
    for (const [key, rows] of this.budgetState.usage) {
      usage[key] = rows.slice();
    }
    return { usage, limitPerGeneration: this.budgetState.limitPerGeneration };
  }

  /** 按 DegradeVerdict.action 执行真实副作用；动作判据不在此重写。 */
  private async executeDegrade(
    verdict: DegradeVerdict,
    key: string,
    request: InProcessInvokeRequest,
  ): Promise<unknown> {
    switch (verdict.action) {
      case "use-cached":
        return this.cache ? await this.cache.get(key) : request.cachedResult;
      case "empty-result":
        return request.emptyResult === undefined ? null : request.emptyResult;
      case "fail-closed":
      default:
        return undefined;
    }
  }

  private async fail(
    stage: DegradeStage,
    errorKind: string,
    budget: BudgetVerdict,
    capability: InProcessCapability,
    request: InProcessInvokeRequest,
    decision: Decision,
    key: string,
  ): Promise<InProcessInvokeResult> {
    const verdict = degradeOnFailure(capability, errorKind);
    const value = await this.executeDegrade(verdict, key, request);
    await this.writeDegradeAudit(
      {
        key,
        generation: budget.generation,
        stage,
        action: verdict.action,
        errorKind: verdict.errorKind,
        used: budget.used,
        limit: budget.limit,
        remaining: budget.remaining,
      },
      request.actor,
    );
    return {
      status: "degraded",
      decision,
      reason: stage,
      value,
      budget,
      action: verdict.action,
    };
  }

  /** best-effort 审计：失败只 warn，不改变降级结果（先例 capability.service）。 */
  private async writeDegradeAudit(
    detail: CapabilityDegradedDetail,
    actor?: CapabilityActor,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        // 字面量：audit guard 只认 action: "<域>.<动作>"，常量引用会失明（历史教训）
        action: "capability.degraded",
        resource: "capability",
        resourceId: detail.key,
        detail: { ...detail },
        result: "failure",
        ...(actor ? { userId: actor.id, username: actor.username } : {}),
      });
    } catch (err: unknown) {
      console.warn(
        `[InProcessCapabilityService] audit write failed for ${CAPABILITY_DEGRADED_ACTION}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
