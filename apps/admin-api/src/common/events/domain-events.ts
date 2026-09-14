/**
 * ARCH-21: 领域事件总线——事件名常量与载荷类型的集中定义。
 *
 * 背景：通知/AI 分析此前直接以 service 调用耦合在 handleCallback 主链，
 * 本层把「执行终态落库」与「副作用（告警通知、未来的出站 webhook）」解耦：
 * 主链只 emit 事件，副作用方以 listener 消费。FEAT-07（出站 webhook）届时
 * 只需新增一个 listener 订阅同名事件，主链零改动。
 *
 * 设计约束：
 * - 载荷只放原始类型（字符串字面量 status/failureReason 与实体枚举值逐字
 *   一致），common 层不反向依赖 task 模块实体——listener 若需要实体级数据
 *   自行按 id 查询（如通知侧查 Task 告警配置），与迁移前语义等价。
 * - 事件名是稳定契约：只增不改；命名 `execution.<终态语义>`。
 *
 * PK-14（DEEP_REVIEW 0ef3bbe）：跨进程/跨服务事件载荷（webhook 信封、pull
 * 派发载荷）全程无版本标记——载荷形状演进时消费方无法区分新旧，兼容性问题只能
 * 运行时发现。现统一加 `schemaVersion` 机器可辨标记。
 *
 * ## 版本演进规则（语义化主版本）
 * - 向后兼容的增量（新增可选字段、新增事件名）**不升 major**，订阅方/执行器
 *   忽略未知字段即可（天然兼容）。
 * - 改字段语义、删字段、改字段类型 = **breaking**，必须 bump major（旧消费方
 *   读 schemaVersion 识别后走旧分支或拒绝）。
 * - 当前所有载荷处于 v1：信封 `{event, occurredAt, data, schemaVersion}`；
 *   pull 派发载荷顶层附 `schemaVersion`。SSE 事件面（日志流/指标流/执行流）
 *   改动面大，本轮仅在派发侧加版本头注释标注路线，待契约面收口时统一补。
 */

/**
 * PK-14: 跨进程事件载荷（webhook 信封 + pull 派发载荷）的 schema 主版本。
 * 消费方读此字段区分载荷形状演进；增量字段新增不升 major。
 */
export const EVENT_SCHEMA_VERSION = 1 as const;

/** 事件名常量（集中导出，emit/on 两侧统一引用，禁止裸字符串）。 */
export const DOMAIN_EVENTS = {  /** 执行以 SUCCESS 终态落库（唯一 winner 之后，恰好一次）。 */
  EXECUTION_COMPLETED: "execution.completed",
  /** 执行以失败类终态落库（FAILED/TIMEOUT，唯一 winner 之后）。 */
  EXECUTION_FAILED: "execution.failed",
  /**
   * FEAT-18（ARCH-21 预留补发）：执行被管理员手动 kill，KILLED 终态落库后
   * 发布（task.service.killExecution 条件 UPDATE 命中后，fail-open）。
   * 与 execution.failed 分立的原因：KILLED 的翻转点不在 handleCallback 主链
   * （管理员动作直连 killExecution），单独命名便于订阅方区分「任务自己失败」
   * 与「被人终止」；载荷形状与 ExecutionTerminalEventPayload 完全一致。
   */
  EXECUTION_KILLED: "execution.killed",
  /**
   * FEAT-07: 执行器翻转 OFFLINE 后发布（心跳超时 sweep / 优雅停机
   * markOffline / 管理台 setOfflineById 三路，状态落库后 emit，fail-open）。
   */
  EXECUTOR_OFFLINE: "executor.offline",
  /**
   * FEAT-07: 应用部署进入 RUNNING 终态（心跳确认）后发布（状态落库后
   * emit，fail-open）。失败类部署态不单列事件——与 execution.* 的
   * 「终态才发」语义一致，部署失败经既有通知渠道外发。
   */
  DEPLOYMENT_COMPLETED: "deployment.completed",
} as const;

export type DomainEventName =
  (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/**
 * FEAT-07: executor.offline 载荷（全原始类型，common 层不 import 实体）。
 */
export interface ExecutorOfflineEventPayload {
  executorId: string;
  appName: string;
  address: string;
  occurredAt: string;
}

/**
 * FEAT-07: deployment.completed 载荷（全原始类型，common 层不 import 实体）。
 */
export interface DeploymentCompletedEventPayload {
  deploymentId: string;
  applicationId: string;
  executorAddress: string;
  status: string;
  deployedVersion: string | null;
  deployedCommit: string | null;
  occurredAt: string;
}

/** 执行终态载荷。execution.completed / execution.failed 共用。 */
export interface ExecutionTerminalEventPayload {
  executionId: string;
  /** 归属任务 id（可能因级联清理为 null——与实体列一致）。 */
  taskId: string | null;
  /** 冗余任务名（通知标题用，免去 listener 回查）。 */
  taskName: string;
  /** 终态：与 ExecutionStatus 枚举值逐字一致（common 层不 import 实体）。 */
  status: "success" | "failed" | "timeout" | "killed";
  /** 失败分类（与 ExecutionFailureReason 值一致）；success 时为 null。 */
  failureReason: string | null;
  /** 回调上报的错误信息（若有）。 */
  errorMessage?: string;
  /** 回调上报的日志（可能截断）——仅够 listener 做头行摘要回退，不落库。 */
  logs?: string;
  /** 该执行已有的 AI 分析（若有），随通知透传——与迁移前读取时序等价。 */
  aiAnalysis?: string | null;
  /** 执行时长（毫秒，回调上报或按 startTime 推算）。 */
  durationMs?: number | null;
  /** 终态落库时刻（ISO）。 */
  finishedAt: string;
}
