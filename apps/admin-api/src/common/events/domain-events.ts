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
export const DOMAIN_EVENTS = {
  /** 执行以 SUCCESS 终态落库（唯一 winner 之后，恰好一次）。 */
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
   * NETOPT-G P1-6（状态机对称性）：执行器由非 ONLINE 恢复为 ONLINE 后发布。
   *
   * 为什么补这一条：修复前状态机是**非对称**的——OFFLINE 有事件 + 通知，而
   * `heartbeat()` 里 `e.status = ONLINE` 是无条件赋值且**不发任何事件**。后果
   * 有两层：
   *   1. 排障困难：`event_outbox` 里永远只有 offline，看不到恢复时刻，无法
   *      还原「判死 → 恢复」的完整时间线（本次生产事故复盘中就卡在这里——需要
   *      靠执行器侧日志反推中台何时把它改回 ONLINE）；
   *   2. 订阅方（通知 / 外部 webhook）只能看到"掉线"，看不到"回来了"。
   *
   * 语义与 executor.offline 对称：**状态落库后** emit、fail-open、载荷同形。
   * 只在**真实跃迁**（prev !== ONLINE → ONLINE）时发，避免每 30s 心跳刷一条
   * 事件（心跳是高频路径，无脑 emit 会把 outbox 打爆）。
   */
  EXECUTOR_ONLINE: "executor.online",
  /**
   * FEAT-07: 应用部署进入 RUNNING 终态（心跳确认）后发布（状态落库后
   * emit，fail-open）。失败类部署态不单列事件——与 execution.* 的
   * 「终态才发」语义一致，部署失败经既有通知渠道外发。
   */
  DEPLOYMENT_COMPLETED: "deployment.completed",
  /**
   * P0-4（生产报告 2026-10-22 §4.4/§7）：pull 通道的控制面命令**执行失败**后
   * 发布（执行器经 `POST /executors/command-result` 上报 ok=false 之后）。
   *
   * 为什么需要这件事事件：pull 部署命令「已入队」不等于「已执行」。旧实现的
   * 失败只落一条日志 + 一个 600s 的 Redis 结果键，**不推进 app_deployments**，
   * 于是那条行会一直停在 DEPLOYING，直到卡死扫描（带 `Deploy command queued`
   * 前缀的 pull 未决行豁免到命令 TTL 30 分钟）才判 FAILED——期间同一应用的
   * 任何后续部署都被在途锁拒成 409（现场 6 次）。订阅方（部署域）据此把窗口
   * 从 30 分钟压到秒级。
   *
   * 只发**失败**：成功路径的终态由执行器 /app-deployments/heartbeat 收敛
   * （deployment.completed 已覆盖），再发一条会制造双写竞争。
   */
  EXECUTOR_COMMAND_FAILED: "executor.command.failed",
  /**
   * P0-4 附带（生产报告 2026-10-22 §7 P0-3 末条）：执行器**地址漂移**已采纳后
   * 发布（同一安装换网/换 IP，ADR-017 §2/§5 的正常形态）。
   *
   * 为什么需要事件：`app_deployments.executorAddress` 是**快照**，此前从不随
   * 漂移更新——push 回退（或任何按快照地址出站的路径）会打到**已失效的旧地址**，
   * 而管理台展示的"部署在哪台"也停在旧值。订阅方（部署域）据此把该执行器名下
   * 的**未终结**部署行快照滚到新地址。
   *
   * 只在**真实跃迁**（漂移被采纳）时发：心跳 30s 一台，无脑 emit 会打爆 outbox。
   */
  EXECUTOR_ADDRESS_DRIFTED: "executor.address.drifted",
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
 * NETOPT-G P1-6: executor.online 载荷——与 ExecutorOfflineEventPayload 同形，
 * 便于订阅方用同一套解析逻辑处理两个方向。
 */
export type ExecutorOnlineEventPayload = ExecutorOfflineEventPayload;

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

/**
 * P0-4: executor.command.failed 载荷（全原始类型，common 层不 import 实体）。
 *
 * `deploymentId` 在入队时随命令载荷一起存进 Redis 元数据（`acf:cmdmeta:{id}`），
 * 执行器上报结果时回填——执行器自己不知道部署行 id，也不该知道。
 */
export interface ExecutorCommandFailedEventPayload {
  /** 中台生成的命令 id（与 pull 响应里的 commandId 一致）。 */
  commandId: string;
  /** 命令类型（deploy / app-stop / app-uninstall / config-reload / kill-execution / update-package）。 */
  type: string;
  /** 上报结果的执行器地址（排障用）。 */
  address: string;
  /** 部署行 id；非部署类命令为 null。 */
  deploymentId: string | null;
  /** 执行器回报的错误信息（可能为 null）。 */
  error: string | null;
  /** 事件产生时刻（ISO）。 */
  occurredAt: string;
}

/**
 * P0-4 附带: executor.address.drifted 载荷（全原始类型）。
 *
 * `previousAddress` 是**漂移前**的地址，订阅方用它做条件更新的旧值谓词
 * （避免把已经被别的路径改过的行又覆盖回来）。
 */
export interface ExecutorAddressDriftedEventPayload {
  executorId: string;
  appName: string;
  previousAddress: string;
  address: string;
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
  /**
   * 回调日志的**首行摘要**（硬切 500 字符，`logHeadOf()` 派生，与告警摘要
   * 同口径）。rt-3：此字段此前是回调原始 `logs`（DTO 上限 512_000 字符）——
   * 那份载荷要经 Redis PUBLISH 逐副本广播、并被每条 SSE 连接各自再
   * `JSON.stringify` 一遍，而唯一消费方（告警摘要回退）只取首行。
   *
   * **契约**：事件只传「事实 + 句柄」。日志全文在数据面——DB
   * `task_executions.logs` 与 S3 对象（`logStorage`/`logObjectKey`），需要全文
   * 的消费方走 `GET /tasks/:id/executions/:execId/logs` 一次性拉取，不从事件
   * 广播里取（CloudEvents「notifications, not data dumps」同理）。
   */
  logHead?: string;
  /** 该执行已有的 AI 分析（若有），随通知透传——与迁移前读取时序等价。 */
  aiAnalysis?: string | null;
  /** 执行时长（毫秒，回调上报或按 startTime 推算）。 */
  durationMs?: number | null;
  /** 终态落库时刻（ISO）。 */
  finishedAt: string;
  /**
   * 第四轮审计（A3）: 跨实例 relay 补发标记——true 表示该载荷是从其他实例经
   * Redis pub/sub 转发的（本实例并非回调处理方）。SSE 流照常转发；**产生副
   * 作用的订阅方（通知/出站 webhook/Agent 触发）必须跳过**——起源实例已经
   * 在本地 emit 时执行过同一副作用，不跳过 = 多副本下双倍告警/双份 outbox。
   * PK-14：增量可选字段不升 major，忽略未知字段的旧消费方天然兼容。
   */
  viaRelay?: boolean;
}
