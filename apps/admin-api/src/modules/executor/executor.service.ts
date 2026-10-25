import {
  Injectable,
  OnModuleInit,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
// LANG-ERR-01（后端错误码化）：用户面抛出统一走 AppError（带稳定码，前端按
// 用户语言渲染）。AppError 按状态码挂到对应内置异常原型上，故既有按异常类
// 断言的 spec 不受影响。
import { AppError } from "../../common/errors/app-error";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import * as bcrypt from "bcrypt";
import { InjectRepository } from "@nestjs/typeorm";
import {
  Repository,
  LessThan,
  In,
  Not,
  Brackets,
  QueryFailedError,
  // ADR-017 阶段 3：存量执行行没有 executorId，回落地址匹配时需限定
  // `executorId IS NULL`，避免把新派发（已有行身份）的行也按地址卷进来。
  IsNull,
  // R3-B：applyReportedAppVersions 整替事务用（dataSource.transaction）。
  DataSource,
} from "typeorm";
import { Cron } from "@nestjs/schedule";
import axios from "axios";
import {
  Executor,
  ExecutorOfflineReason,
  ExecutorStatus,
  ExecutorType,
} from "./entities/executor.entity";
import { ExecutorMetricsHistory } from "./entities/executor-metrics-history.entity";
// R3-A（部署模型评审 2026-10-23 §4.3 / §九 9.3-1）：设备级应用版本事实表 +
// 心跳上报契约（结构校验 deployed-apps.util.ts）。
import { ExecutorAppVersion } from "./entities/executor-app-version.entity";
import {
  MAX_DEPLOYED_APPS,
  normalizeDeployedApps,
  normalizeInstalledPackages,
  type DeployedAppReport,
  type InstalledPackageReport,
} from "./deployed-apps.util";
import { ExecutorTokenCacheSyncService } from "./token-cache-sync.service";
import {
  TaskExecution,
  ExecutionFailureReason,
  ExecutionStatus,
} from "../task/entities/task-execution.entity";
// A1: 终态跃迁的单一入口（纯函数，零 DI，不引入 task↔executor 模块耦合）。
// A6: 同文件再取终态集合常量——对账端点必须与跃迁门用同一份定义，否则「门里
// 认的终态」和「对账回的终态」会各自漂移。
import {
  transitionToTerminal,
  TERMINAL_EXECUTION_STATUSES,
} from "../task/execution-terminal";
import { Task, TaskCodeSource, TaskStatus } from "../task/entities/task.entity";
// A4: DB 优先级(4=紧急) → BullMQ 出队优先级(1=最高)的方向换算——restart/stale
// 恢复重试入队此前根本不带 priority，同样需要换算后补齐。
import { toBullPriority } from "../../common/utils/task-priority.util";
// normalizeTaskPriority：DB priority 列读回 PG label 字符串（'normal' 等），
// 入队边界必须先归一化为 1..4 数字再换算（同 scheduler/task.service）。
import { normalizeTaskPriority } from "../task/entities/task.entity";
// A4（第三轮审计·高）：派发体 task 白名单挑选（整实体直传收口为显式白名单）。
import {
  buildDispatchTaskPayload,
  DispatchTaskPayload,
} from "./dispatch-task-payload.util";
// python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：zip 渠道任务的
// `packageUrl` 由 admin 在派发时解析后附加到下发 task 上（任务实体只有
// `applicationId` 弱引用，执行器无法自行查库）。只加列/只读，不建关系，
// 避免 executor↔application 的实体关系耦合（ApplicationModule 反向 import
// TaskModule+ExecutorModule，加关系会引入模块环）。
import { Application } from "../application/entities/application.entity";
// ARCH-35 P1（生产事故 2026-09-23）：派发时读取「该应用部署在哪台执行器」。
// 只加 Repository，不 import ApplicationModule（反向 import 会成环，同上方
// Application 的注释）。AppDeployment 的 @ManyToOne(Application) 是实体关系，
// 只需 Application 实体已注册，不构成模块依赖。
import {
  AppDeployment,
  DeploymentStatus,
} from "../application/entities/app-deployment.entity";
// ARCH-35 P1：部署归属**偏好**（稳定分区，非过滤）——判据与「为什么不能硬
// 过滤」的完整论证见 util 头注（执行器侧任务执行不依赖本地部署，硬过滤会
// 误伤全部未部署任务与 python 执行器）。
// FEAT-22 方案 A v1：deploymentPolicy=strict 的**任务级显式硬约束**与偏好并存
// ——只对「存在部署行」的任务收窄候选集（用户显式指定过设备），与 ARCH-35
// 「无条件硬过滤误伤全员」的结论不冲突；strict 失败走 WAITING 排队不烧预算。
import {
  collectDeploymentExecutorKeys,
  DEPLOYMENT_CONSTRAINT_STATUSES,
  partitionByDeploymentAffinity,
  pickDeploymentVersionForExecutor,
} from "./executor-deployment-affinity.util";
// FEAT-22 方案 B（版本跟随部署）：版本快照只读仓库（deployedVersion →
// snapshot.packageUrl 解析）。与 AppDeployment 同款只加 Repository 不 import
// ApplicationModule（避免模块环）。
import { ApplicationVersion } from "../application/entities/application-version.entity";
// MUTEX-01（应用互斥组）：占坑互斥错误（processor 分类链最前面识别并置
// WAITING）；互斥组配置只读仓库（组内并发数）。
import { MutexWaitError } from "../task/execution-mutex";
// ADR-017 阶段 3：槽位冲销的单一事实源（与调度器/触发路径共用）。同地址多行
// 并存时地址无法指代行身份，util 内部保守跳过（见其头注）。
import { releaseExecutorSlotByAddress } from "../task/block-strategy-gate";
// FEAT-22 方案 A v1：strict 部署约束的排队错误（processor 与 MutexWaitError
// 同位识别，置 WAITING 不烧预算）。
import { DeploymentConstraintWaitError } from "../task/execution-deployment-wait";
import { MutexGroup } from "../application/entities/mutex-group.entity";
// python_task_multiversion（WS2 · CONTRACT §1.2/§2.2/§3.1）：解释器缓存池
// 匹配的唯一事实源（纯函数）。三处调度站点 + pinning 守卫 + 上报采纳共用，
// 杜绝三份漂移（对齐 executor-score.util.ts 的抽取先例）。
import {
  buildInterpreterMismatchMessage,
  hasRequestedVersion,
  interpreterSatisfies,
  normalizeInterpreters,
} from "./interpreter-match.util";
import type { ExecutorInterpreter } from "./interpreter-match.util";
// python_task_multiversion：在线可下载区间判定（3.8+）。调度侧据此区分
// "缓存缺失但执行器可自行 uv python install"（放行）与"离线层必须预填"（硬拦）。
import { isOnlineDownloadable } from "../task/runtime-version.util";
import { PaginationDto } from "../../common/dto/pagination.dto";
import { NotificationService } from "../notification/notification.service";
import { SystemConfigService } from "../config/config.service";
import {
  assertAndPinExecutorUrl,
  pinnedAxiosConfig,
} from "../../common/utils/safe-http.util";
// EXE-VER-1: 最低版本门禁（register 403）——比较与合规语义见 util 头注
import { isVersionCompliant } from "./version-compare.util";
// PROTOCOL-VER（B-3/U-2）：协议版本兼容矩阵（与实现版本门禁解耦）。
import {
  PROTOCOL_SUPPORTED_MIN,
  PROTOCOL_CONTROL_PLANE_MIN,
  isProtocolCompliant,
  supportsControlPlane,
} from "./protocol-compat.util";
// ARCH-32: pull 模式派发队列（ADR-015）——NAT 内执行器零入站回连
import { ExecutorPullService } from "./executor-pull.service";
// ARCH-34 P0（生产事故 2026-09-23）：address 冲突检测——`address` 是唯一键
// 但为执行器自报（NAT 下局域网 IP 可碰撞），两台机器共享同一行会导致注册
// 互相覆盖、pull 队列被抢、重启恢复互相误杀。本模块只做检测与可见性。
import {
  createAddressConflictTracker,
  type AddressConflictObservation,
} from "./executor-address-conflict.util";
// ARCH-36（ADR-017 阶段 2/3）：deviceFingerprint 校验 + 冲突/漂移观测 +
// legacy 身份兜底键。
// 与 P0 的 startupId 时序判据**并存**：P0 覆盖存量执行器（无新字段），本模块
// 给出跨重启稳定身份带来的**直接**判据（零误报），两者互不替代（见 util 头注）。
// 阶段 3 起 normalizeDeviceFingerprint 还是**定位键的规范化入口**（register/
// heartbeat 先按指纹定位行、命中即复用并更新 address）。
import {
  createDeviceFingerprintTracker,
  normalizeDeviceFingerprint,
  legacyExecutorIdentity,
  type FingerprintObservation,
  type FingerprintObserveContext,
} from "./executor-fingerprint.util";
// E-4（2026-10-26 执行器域审计）：register 身份键入站校验（宽严依据见 util 头注）。
import { validateRegisterIdentityFields } from "./executor-register-validate.util";
// SEC-02: 任务级 secrets 派发解密（落库加密在 TaskService 写路径）
import { SecretsCryptoService } from "../../common/utils/secret-crypto.util.service";
// FEAT-07: executor.offline 出站事件（总线 @Global；Optional 注入先例 task.service）
import {
  DOMAIN_EVENTS,
  ExecutorAddressDriftedEventPayload,
  ExecutorCommandFailedEventPayload,
  ExecutorOfflineEventPayload,
  ExecutorOnlineEventPayload,
} from "../../common/events/domain-events";
import { DomainEventBus } from "../../common/services/domain-event-bus.service";
import { Optional } from "@nestjs/common";
// ARCH-31 §5: cron 维护任务统一 Leader 门禁（@Optional 同 eventBus 先例——
// 既有单测直接 new 装配时 gate 缺席 → null → 门禁不生效）。
import { LeaderGateService } from "../../common/leader-gate/leader-gate.service";
// CORE-02: 重试退避抖动——±20% 摊开同刻重试（recovery re-enqueue 路径）
import { jitteredRetryDelayMs } from "../task/retry-backoff.util";
// CORE-05: 评分公式抽出（selectLeastLoaded / dispatch 双站点共享同一实现）
import { computeExecutorLoadScore } from "./executor-score.util";
import type { EstimatedDurations } from "./executor-score.util";

/**
 * ADR-017 阶段 3（决策 §7 读面富化）：估时样本池的**取值器**。
 *
 * 为什么不是 `Map<string, EstimatedDurations>`：阶段 3 起样本池有两个来源——
 * 新派发执行行按**行身份**归组（同址多行不互相污染），存量行（迁移 0055 刻意
 * 不回填 `executorId`）只能按**地址**归组。调用方要的是「这台执行器的样本」，
 * 由本取值器把两支合并，调用方无从只读其中一支（旧实现消费方只 `get(address)`，
 * 正是"改了归组键、忘了改取值键"的漏改形态）。
 */
export interface EstimatedDurationsIndex {
  forExecutor: (
    executor: Pick<Executor, "id" | "address">,
  ) => EstimatedDurations;
}

/** 空索引（无候选/查询失败降级）：恒返回空样本 → longTaskPenalty=0。 */
const EMPTY_ESTIMATED_INDEX: EstimatedDurationsIndex = {
  forExecutor: () => [],
};
// OBS-01: 派发链路追踪——dispatch span + traceparent 头透传执行器
import { TracingService } from "../../common/tracing/tracing.service";
// AUTH-05: 高危操作（rotate-token / 删除执行器）审计留痕
import { AuditService } from "../audit/audit.service";
// NETOPT-8①: task_executions retention 删行前回收 S3 日志对象——S3 GC 候选
// 只能来自存活行，行删指针消失即成永久孤儿（详见 deleteExpiredExecutionRowsBatch）
import { S3LogStorage } from "../task/log-storage/s3-log-storage";
// NETOPT-8④: 分批 DELETE 循环的轮数/墙钟双闸（LOG-RETENTION-01 回移植）
import { cappedBatchedDelete } from "../../common/utils/capped-batched-delete.util";
// A6: 对账端点响应契约（三端共载，见 DTO 头注）
import type { TerminalStatesResponseDto } from "./dto/executor-terminal-states.dto";

/**
 * A6（DEEP_REVIEW §七）：死信对账窗口的上界。
 *
 * 对账是**执行器主动拉**的：一台执行器在死信堆积时会反复来问。若不设上界，
 * 一个写坏的 since（或一台时钟错乱的执行器）就能让 admin 去扫整张
 * task_executions。30 天足够覆盖最长场景——死信文件本身会被执行器侧 TTL
 * 清理（node: removeOlderThan；python: _cleanup_dead_letter_files），活不过
 * 30 天。超过上界的 since 被**钳到**上界（不是报错）：对账是尽力而为的
 * 后台动作，因为参数写错就让整个对账停摆比多扫一点更糟。
 */
export const TERMINAL_STATES_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** 单页默认/最大条数。hasMore=true 时执行器下一轮继续取。 */
export const TERMINAL_STATES_DEFAULT_LIMIT = 500;
export const TERMINAL_STATES_MAX_LIMIT = 2000;
/**
 * since 缺省/非法时的回退窗口。取 24h 是为了与 E-05 的重发预算同量级：比一个
 * 预算期更早终态的执行，其死信文件在执行器侧早已被 TTL 清理（node
 * removeOlderThan / python _cleanup_dead_letter_files），对账它没有意义。
 */
export const TERMINAL_STATES_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Executor lifecycle audit（P3-9）：findAll() 的硬上限。管理台列表的筛选/
 * 搜索/计数全部在客户端对返回数组做，超过该上限的行会被**静默截断**——
 * 因此该值同时经 GET /executors/runtime-config 暴露给前端，让 UI 能给出
 * "仅显示前 N / 共 M 台"的提示，而不是把子集说成全量。需要更多行时应做
 * 服务端分页（见 findAll 注释）。
 */
export const EXECUTOR_LIST_LIMIT = 500;

/**
 * P1-A（2026-10-25 真机审计）：push 地址「死行接管」所需的静默窗（毫秒）。
 *
 * 场景：容器化执行器重建后安装身份漂移（指纹盐/容器 MAC 不落卷），新指纹
 * 撞上同地址的旧真实指纹行 → register/token 恒 409（旧判定把「同机重装」
 * 误判成「另一份安装占用」），执行器永远拿不回自己的行。接管的前置是占位行
 * 已被 stale sweep 判死（status=OFFLINE，自身约需判死窗 = 心跳超时 × 确认
 * 轮数 ≈ 3 分钟）——本静默窗在其上再加一段，双保险覆盖「容器重启耗时 +
 * 判死后短暂网络分区恢复」两类边界：静默不足 5 分钟不许接管。
 *
 * 可经 `executor.addressTakeoverSilenceMs` 覆盖（非法值回退本缺省，与
 * `executor.staleOfflineConfirmations` 同款纪律）。测试无需等待——用例把
 * 行的 lastHeartbeat/updatedAt 回拨即可立即命中。
 *
 * ⚠️ E-8（2026-10-26 执行器域审计）：**不要把覆盖值配成 0**。0 是合法值
 * （resolveAddressTakeoverSilenceMs 的 `>= 0` 判定）= 静默窗退化为零——
 * 接管的剩余前置只剩 `status=OFFLINE` 单闸，而 stale sweep 的判死只代表
 * 「两个心跳超时窗无心跳」：一次约 3 分钟的网络分区（两台机器、NAT 表项
 * 更替、VPN 重连）就足以让活安装被判死并立即被同地址的新安装（或攻击者
 * 的注册请求）接管，旧进程回来后进入 401 自愈风暴（与 P1-A 的 789 次重试
 * 同形）。建议 ≥60_000（1 分钟，覆盖「判死后立即重启」的正常重装节奏，
 * 又不至于让自愈明显变慢）；默认 5 分钟是「正常重装 < 5min 完成的概率
 * 极低」与「攻击者窗口最小化」的折中。
 */
export const EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS = 5 * 60_000;

/**
 * 执行器选择器（executor picker，GET /executors/picker）的硬上限。
 *
 * 为什么与 EXECUTOR_LIST_LIMIT 不是同一个值：findAll() 回**全列实体投影**
 * （interpreters / runningExecutionIds ≤10000 条的数组列 / tags / 心跳元数据…），
 * 单行重，500 是它的载荷护栏；picker 只回部署下拉（AppDeploymentPage 部署
 * 模态 / ApplicationListPage 快速部署）实际消费的 6 个轻列（见
 * findPickerOptions），单行轻一个数量级以上，2000 行的总载荷仍小于 findAll
 * 的 500 行全列——上限据此放宽。
 *
 * 超限**绝不静默**：findPickerOptions() 以 `truncated: true` + 全量 `total`
 * 显式上报，前端在选择器里展示「共 total 台，仅显示前 limit 台」告警（复用
 * execList.truncated 文案）。选择器的搜索是前端对返回数组做的客户端过滤——
 * 静默截断等于对被截掉的执行器假阴性（搜不到真实存在的机器），这正是本端点
 * 要修的缺陷形态，故截断必须可见。
 */
export const EXECUTOR_PICKER_LIMIT = 2000;
/** AgentHost 每 30 秒续报；两分钟无续报则撤去全部协作能力。 */
export const AGENT_CAPABILITIES_LEASE_MS = 2 * 60 * 1000;
const MAX_RUNNING_EXECUTION_IDS = 10_000; // NETOPT-C P2-1: 与 E9 maxConcurrentTasks 采纳上界一致

// NETOPT-D P3-3: 截断 warn 节流状态——模块级而非实例字段（sanitize 是实例
// 方法，节流跨心跳共享；多实例无状态部署下不重复刷日志）。
const lastTruncationWarn = new Map<string, { dropped: number; at: number }>();
/** 测试出口：清空 warn 节流状态——模块级 Map 跨测试残留会形成隐性顺序依赖
 *  （现测试靠换 address 规避；NETOPT-F P3 补 reset 消除依赖）。 */
export function __resetTruncationWarnStateForTest(): void {
  lastTruncationWarn.clear();
}
const TRUNCATION_WARN_THROTTLE_MS = 60_000;

/**
 * P1（生产报告 2026-10-22 §4.6 / 结论 H）：**「哪台执行器没带可解析指纹」的
 * 诊断节流**（address → 上次 warn 时刻）。
 *
 * 为什么需要：现场 36 次 `Identity resolution … is ambiguous` 只能证明「有一台
 * 不带指纹」，却无法回答**是哪一台**（应用日志不记录请求体，指纹又不进日志）。
 * 加这一行后，运维在日志里按 address/appName 就能定位到机；1h/地址的节流把
 * 存量 legacy 机队的噪音压到 ≤24 行/天/台。
 */
const lastMissingFingerprintWarn = new Map<string, number>();
const MISSING_FINGERPRINT_WARN_THROTTLE_MS = 60 * 60 * 1000;
/** 测试出口：清空上面那张节流表（模块级 Map 跨用例残留会形成隐性顺序依赖）。 */
export function __resetMissingFingerprintWarnForTest(): void {
  lastMissingFingerprintWarn.clear();
}

/**
 * R53-A1（ADR-026 规则 4）：心跳**真正拥有**的列 —— 正向白名单。
 *
 * 为什么需要它：heartbeat 在入口 `findOne` 拿到快照，跨多个 await
 * （observeAddressConflict / observeDeviceFingerprint / failRunningExecutionsAfterRestart /
 * metrics history）后就地改若干字段，此前用 `repo.save(e)` **整行**回写。
 * TypeORM 的 save 是「读当前行 → 按列 diff → 只写有差异的列」——快照里那些
 * **心跳从不修改**的列，只要在窗口内被别人改过，就会被 diff 判成"改动"按旧值
 * 写回。受害列由 register / 管理台拥有，而心跳**永不自纠正**：
 *   address / appName / capabilities / groupName / tags / description /
 *   maxConcurrentTasks / dispatchMode / protocolVersion / executorVersion。
 * 其中 groupName / tags / description / maxConcurrentTasks 恰是 `update()`
 * （管理台 PATCH）的四列 —— 管理台刚改完，一次心跳就把它回弹到旧值，且因为心跳
 * 不自纠正，会一直错到下一次 register（现象是"改一次弹一次"）。
 *
 * 正面清单**逐列**来自源码（行号为 R53-A1 落地时，改动时请同步核对）：
 *   - address                    :2408 / :2412（仅当漂移被采纳；被占用时不写）
 *   - status                     :2633
 *   - consecutiveHeartbeatMisses :2637
 *   - offlineReason              :2639
 *   - lastHeartbeat              :2640
 *   - executorStartedAt          :2642
 *   - executorStartupId          :2646
 *   - runningTaskCount           :2490 / :2507（重启清零）+ :2623（指标白名单环）
 *   - reservedSlots              :2494 / :2509（重启清零）+ :2695（合法采纳）
 *   - runningExecutionIds        :2655
 *   - cpuUsage / memUsage / diskUsage / networkLatency /
 *     totalTaskCount / failedTaskCount / maxConcurrentTasks /
 *     deadLetterCount            : 指标白名单环（:2621-2629）
 *   - interpreters               :2715
 *   - deviceFingerprint          :2733
 *
 * 注意 maxConcurrentTasks / address 是**双主人**列（管理台 PATCH 也写）：心跳只在
 * 「本轮真的采纳了值」时写它们（见 `adopted` 集合），未上报就一个字都不写。
 */
const HEARTBEAT_OWNED_COLUMNS = [
  "address",
  "status",
  "offlineReason",
  "consecutiveHeartbeatMisses",
  "lastHeartbeat",
  "executorStartedAt",
  "executorStartupId",
  "runningTaskCount",
  "reservedSlots",
  "runningExecutionIds",
  "cpuUsage",
  "memUsage",
  "diskUsage",
  "networkLatency",
  "totalTaskCount",
  "failedTaskCount",
  "maxConcurrentTasks",
  "deadLetterCount",
  "interpreters",
  "deviceFingerprint",
  // R3-A（§4.3/P10）：已安装执行器包清单（三态采纳同 interpreters；deployedApps
  // 落的是独立表 executor_app_versions，不走 executors 列白名单——见
  // applyReportedAppVersions）。
  "installedPackages",
] as const;

/** 心跳白名单列名(见 HEARTBEAT_OWNED_COLUMNS 的逐列依据)。 */
type HeartbeatOwnedColumn = (typeof HEARTBEAT_OWNED_COLUMNS)[number];

/**
 * R55-A1（ADR-026 规则 4）：register **真正拥有**的列 —— 正向白名单。
 *
 * 与 HEARTBEAT_OWNED_COLUMNS 同一套机制（正向白名单 ∩ 本次采纳集 → 列级
 * patch），但主人的边界不同：
 *  - register 是**身份/配置**的权威写者：appName / type / executorVersion /
 *    capabilities / maxConcurrentTasks / groupName / tags / description /
 *    dispatchMode / protocolVersion / deviceFingerprint / interpreters /
 *    executorStartedAt / executorStartupId；
 *  - 另有几条**双主人**列（register 与管理台/心跳各写一面）：address（地址漂移）、
 *    status / offlineReason / lastHeartbeat（注册即在线）、runningTaskCount
 *    （重启恢复清零）。
 *
 * **不在**本白名单里的列 = register 没有任何上报口径的列，最典型的是四个指标列
 * cpuUsage / memUsage / diskUsage / networkLatency（register DTO 里根本没有它们，
 * controller 的 F-7 白名单也不转发）——它们的主人是心跳。此前 register 尾巴上的
 * `repo.save(e)` 整行回写会把快照里的旧读数按 diff 写回，覆盖窗口内刚上报的
 * 真实指标（详见 register 尾部注释）。
 *
 * 逐列依据（行号为 R55-A1 落地时，改动时请同步核对）：
 *   - address            : 地址漂移分支（仅当 e.address !== data.address）
 *   - type / appName / executorVersion / capabilities / maxConcurrentTasks /
 *     groupName / tags / description / dispatchMode / protocolVersion /
 *     deviceFingerprint / interpreters : 「Update mutable fields」逐列守卫
 *   - runningTaskCount   : didRestart / shouldRecoverMissingBaseline 两分支清零
 *   - executorStartedAt / executorStartupId : 仅当上报
 *   - status / offlineReason / lastHeartbeat : 无条件（注册即在线）
 */
const REGISTER_OWNED_COLUMNS = [
  "address",
  "status",
  "offlineReason",
  "lastHeartbeat",
  "type",
  "appName",
  "executorVersion",
  "capabilities",
  "maxConcurrentTasks",
  "groupName",
  "tags",
  "description",
  "dispatchMode",
  "protocolVersion",
  "deviceFingerprint",
  "interpreters",
  "runningTaskCount",
  "executorStartedAt",
  "executorStartupId",
  // R3-A（§4.3/P10）：已安装执行器包清单（注册面同心跳三态采纳）。
  "installedPackages",
] as const;

/** register 白名单列名(见 REGISTER_OWNED_COLUMNS 的逐列依据)。 */
type RegisterOwnedColumn = (typeof REGISTER_OWNED_COLUMNS)[number];

/**
 * A-10（执行器域审计 P3）：PG 唯一约束冲突判定（SQLSTATE 23505）。
 * register 的「按地址 findOne → 无行则 insert」是 check-then-act——同地址并发
 * 首注册时败者的 save 会撞 uq_executors_address 抛 QueryFailedError（驱动把
 * SQLSTATE 放在 `code` 属性），此前未捕获直接 500。与 task.service 同名私有
 * 函数同款实现（TypeORM 跨驱动：`code` 在 PG driver 上挂顶层，pg 误差在
 * driverError 上也有副本，两处都查）。
 */
function isUniqueViolation(err: unknown): boolean {
  const maybe = err as
    | (QueryFailedError & { code?: string; driverError?: { code?: string } })
    | undefined
    | null;
  return (
    maybe instanceof QueryFailedError &&
    (maybe.code === "23505" || maybe.driverError?.code === "23505")
  );
}

/**
 * 控制面调用的传输判定结果（ADR-016 分流 + ADR-017 阶段 3 复查补口）。
 *
 * 三态而非两态：**「解析不到」既不是 pull，也不是「可以安全 push」**。
 * 旧实现把两者合并成 push，于是「部署行指向的执行器已被删除」这条确定性故障
 * 变成了「打一个陈旧快照地址、等 90 秒超时」（生产实证 2026-10-22）。
 */
export type ExecutorTransport =
  | { mode: "pull"; executor: Executor }
  /** pull 行 + 协议支持 → 入队；否则走 HTTP（executor 可能为 null = 纯地址寻址）。 */
  | { mode: "push"; executor: Executor | null }
  /**
   * 行身份无法解析（`executorId` 指向的行已被删除/自动清理）。
   *
   * 调用方**必须**按失败处理，不得再回退 push。
   */
  | {
      mode: "unresolved";
      executor: null;
      /** 稳定原因码：落 statusMessage / 审计用。 */
      reason: "executor-row-missing";
    };

/**
 * 机器面认证 + 行解析的**一次成型**结果（ADR-017 决策 §3 补全，工单 11）。
 *
 * 为什么把「认证」与「定位行」合成一个入口：两者分开时，同址多行 + 无指纹的
 * 请求会先被 fail-closed（解析不到行）→ 404，即使调用方持有**自己那行**的
 * per-executor 令牌、也自报了行 id。合并后可以按「令牌绑定的行」来定位，
 * 而不是靠地址猜。
 */
export interface MachineAuthResult {
  ok: boolean;
  /** 认证通过时定位到的行；共享令牌 + 同址多行歧义时为 null（维持既有 404 语义）。 */
  executor: Executor | null;
  /** 凭据来源：per-executor = 按行令牌；shared = 共享令牌；none = 未通过。 */
  via: "per-executor" | "shared" | "none";
  /** 行定位口径（排障用）。 */
  resolvedBy: "fingerprint" | "address" | "reported-id" | "none";
}

@Injectable()
export class ExecutorService implements OnModuleInit {
  private readonly logger = new Logger(ExecutorService.name);
  private readonly protocol: string;

  // F-5: short-lived in-process cache of SUCCESSFUL per-address token
  // validations. Each validation otherwise runs bcrypt (cost 12, ~100-300ms
  // of pure CPU), which made unauthenticated executor endpoints (callback,
  // heartbeat) a CPU-DoS vector. Only positive results are cached (bounded by
  // the fleet size), keyed by sha256(address|token) so raw tokens never sit in
  // memory. 值里额外存 address：键是单向哈希，无法按地址前缀删除，而
  // rotateToken()/removeById() 必须让该地址的全部旧凭据正结果立刻失效——
  // 否则「撤销」会有最长 TOKEN_CACHE_TTL_MS 的失效窗口（evictTokenValidationsFor
  // 按值扫描）。正缓存只是省 bcrypt，驱逐不会削弱 DoS 防护（轮换/删除是低频
  // 管理动作，旧凭据本就该重新走一次 bcrypt 并被拒）。
  private static readonly TOKEN_CACHE_TTL_MS = 60_000;
  private static readonly TOKEN_CACHE_MAX = 1000;
  /**
   * ADR-017 阶段 3：同地址回调密钥候选的行数上限。真实碰撞场景是 2~3 台；
   * 设上限是防御病态数据把回调验签退化成 O(全表) 的 bcrypt/ HMAC 循环。
   */
  private static readonly MAX_CALLBACK_SECRET_CANDIDATES = 16;
  private readonly tokenValidationCache = new Map<
    string,
    { address: string; cachedAt: number }
  >();

  // N26 (round-8): short-lived positive cache of per-address tokenHash
  // lookups, used as the per-executor HMAC candidate when verifying
  // `v1.` execution-callback tokens. Same 60s TTL / positive-only pattern
  // as tokenValidationCache above: misses are never cached (a freshly
  // registered executor must be usable immediately), and rotateToken()
  // evicts the address so a rotation is picked up without waiting for the
  // TTL. Trade-off mirrors F-5: a rotated-away hash stays a valid HMAC
  // candidate for at most TOKEN_CACHE_TTL_MS.
  private readonly callbackSecretCache = new Map<
    string,
    { hash: string; cachedAt: number; address: string }
  >();

  // R9 (round-8 P1 closure, W2): idempotency state for POST /executors/token.
  // The endpoint used to rotateToken() on EVERY call, so any client that
  // re-fetched on a loop (executor-node's envelope-parse bug made every fetch
  // "fail" and retry every 30s; executor-python still re-fetches per request)
  // put the stored tokenHash on a rotation cycle that broke the N26
  // per-execution callback-token invariant (docs/archive/verifies/verify-round8-e2e.md §1.5).
  // issueToken() now returns the CURRENT token while the caller proves it is
  // the same process life (same startupId — N4 register semantics), and only
  // rotates on a new/changed startupId, on a legacy (startupId-less) fetch
  // outside the short reuse window, or when the cached plaintext no longer
  // verifies against the stored hash (e.g. an admin-UI rotation).
  //
  // Plaintext-token constraint: rotateToken() persists only a bcrypt hash, so
  // the raw token cannot be recovered from the DB. Reuse therefore needs the
  // plaintext kept in-process (issuedTokenCache below) — bounded by fleet
  // size, evicted on rotation/removal, and never readable by anyone who
  // doesn't already pass verifyExecutorToken (shared token) for that address.
  // An admin-api restart simply cold-starts the cache: the next /token call
  // rotates once (harmless — the executor adopts the new hash from the same
  // response, see executor-node admin-envelope.ts).
  private static readonly TOKEN_ISSUE_REUSE_WINDOW_MS = 60_000;
  // N34 (round-9): defensive bounds for the plaintext issuance cache, same
  // MAX+TTL pattern as tokenValidationCache (F-5). Without them, a caller
  // holding the shared token could grow the Map unbounded by hitting
  // POST /executors/token with fresh addresses. The TTL is deliberately NOT
  // the 60s TOKEN_CACHE_TTL_MS: idempotent same-startupId reuse must survive
  // the executors' ~30min token-refresh cycle (docs/archive/verifies/verify-round9-e2e.md §1.3
  // observed reuse at 25.5min). An executor living past the TTL just rotates
  // once on its next fetch — the same harmless cold-start behavior as an
  // admin-api restart.
  private static readonly TOKEN_ISSUE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly TOKEN_ISSUE_CACHE_MAX = 1000;
  /**
   * 幂等签发的**明文令牌**正缓存。键 = **定位身份**（指纹优先，见
   * {@link tokenCacheIdentityKey}），而非裸 address。
   *
   * 为什么阶段 3 起必须改键：pull 模式允许同地址多行并存（ADR-017 §5）。按
   * address 做键时，同址两台的签发结果**共用一条缓存**——第二台请求会命中
   * 第一台那条「同 startupId / legacy 窗口」的幂等分支，把**第一台的明文
   * 令牌**发给第二台（越权级串台，且因为缓存的 token 与被轮换的
   * `executor.id` 不属于同一行，N4 的「同进程不轮换」语义也退化成
   * 「谁先到谁赢」的轮换风暴）。按定位身份分键后，各行的存续互不可见。
   *
   * `address` 随值保留：驱逐仍按 address 回扫（键是单向派生的，无法前缀
   * 删除——与 `callbackSecretCache` 同一处置）。
   */
  private readonly issuedTokenCache = new Map<
    string,
    {
      token: string;
      startupId: string | null;
      issuedAt: number;
      address: string;
    }
  >();

  // F-08（本轮审计）: applications.packageUrl 的短 TTL **正缓存**（30s）。
  // 背景：每次 dispatch/dispatchBroadcast 的 zip 分支都 applicationRepo.findOne
  // 查一次 packageUrl，对高频 zip 任务（如 cron 每分钟）每次派发多一次 DB 往返。
  // packageUrl 只在应用版本上传/回滚时变化（低频），30s 内短暂陈旧可接受。
  //
  // 只缓存**成功**结果（positive-only，对齐 tokenValidationCache 的既有先例）：
  // 应用不存在 / 未配置 packageUrl 的失败恒重新查库——失败态缓存会掩盖"管理员
  // 刚补上 packageUrl 就能恢复"的场景。条目数上界 = applications 行数（每应用
  // 一条），TTL 到期的条目在下次命中时惰性淘汰，不引入定时器。
  private static readonly PACKAGE_URL_CACHE_TTL_MS = 30_000;
  private readonly packageUrlCache = new Map<
    string,
    { packageUrl: string; packageVersion: string | null; cachedAt: number }
  >();

  /**
   * ARCH-34 P0：address 冲突跟踪器（**实例字段**，register 与 heartbeat 共享）。
   *
   * 为什么是实例而非模块级单例：两个入口跑在同一 provider 实例上，实例字段
   * 已满足共享需求；模块级状态会跨测试文件泄漏（仓库既有前科见
   * `__resetTruncationWarnStateForTest` 头注）。
   *
   * 多副本部署语义：各副本独立观察，状态不跨实例共享——漏报由「任一副本命中
   * 即告警」而非状态同步承担，与 tokenValidationCache 等既有进程内缓存同款。
   */
  private readonly addressConflictTracker = createAddressConflictTracker();

  /**
   * ARCH-36（ADR-017 阶段 2）：`deviceFingerprint` 冲突/漂移观测器。
   *
   * 与 `addressConflictTracker` **并存**，判据正交：
   * - 本跟踪器：同一 address 出现两个**不同指纹** → 两台不同安装共用一行
   *   （直接证据，零误报）；同一指纹换 address → 地址漂移（正常，只记 info）。
   * - P0 跟踪器：被顶替的**进程生命**复活 → 同一 address 上两个活进程
   *   （时序推断，覆盖未上报指纹的存量执行器；也覆盖「同机同 kind 同 workDir
   *   的两个实例共享指纹」这种指纹判不出的形态）。
   *
   * 为什么是实例字段而非模块级单例：同 P0 跟踪器（跨测试文件泄漏的前科）。
   */
  private readonly deviceFingerprintTracker = createDeviceFingerprintTracker();

  // F-07（本轮审计）: 调度候选执行器池上限（EXECUTOR_CANDIDATE_POOL_SIZE，
  // 默认 500，与既有硬编码逐字节一致）。容错解析：非法/非数字（如测试装配里
  // configService.get 的兜底返回值）一律回退 500——**绝不**把 0/NaN 传给
  // take（take:0 会查空集，take:NaN 会抛错）。
  private get candidatePoolSize(): number {
    const raw = this.configService.get("executor.candidatePoolSize");
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 500;
  }

  constructor(
    @InjectRepository(Executor) private repo: Repository<Executor>,
    @InjectRepository(TaskExecution)
    private execRepo: Repository<TaskExecution>,
    @InjectRepository(Task) private taskRepo: Repository<Task>,
    // FEAT-04: metrics-history pipeline. Heartbeat keeps the current executor
    // row fresh and appends a best-effort snapshot for the 24h trend read side.
    @InjectRepository(ExecutorMetricsHistory)
    private metricsHistoryRepo: Repository<ExecutorMetricsHistory>,
    @InjectQueue("task-queue") private taskQueue: Queue,
    private readonly configService: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly systemConfigService: SystemConfigService,
    // SEC-02: dispatch 时解密 task.secrets（与 params 合并注入执行器 env）。
    // 跨 task↔executor 模块环的 provider 注入：模块级 forwardRef 配套
    // （executor.module 同位置注释）。
    @Inject(forwardRef(() => SecretsCryptoService))
    private readonly secretsCrypto: SecretsCryptoService,
    // FEAT-07: executor.offline 出站事件发布（@Global 总线；@Optional 仅为
    // 既有单测装配兼容——provider 缺失 → null → 事件静默不发，主链行为不变，
    // 先例同 task.service 的 eventBus 注入）。
    @Optional()
    private readonly eventBus: DomainEventBus | null = null,
    // OBS-01: 派发追踪（@Global 恒提供；disabled 时全短路零开销）。
    // @Optional 仅为既有单测装配兼容（先例 eventBus）。
    @Optional()
    private readonly tracing: TracingService | null = null,
    // AUTH-05: 高危操作审计（rotate-token / 删除执行器）。@Optional 与
    // eventBus 同先例——存量单测未提供 AuditService 时降级为仅日志，主链
    // 不变（审计 best-effort，log() 抛错也绝不影响业务结果）。
    @Optional()
    private readonly audit: AuditService | null = null,
    // ARCH-31 §5: 多实例下 @Cron 维护任务仅 cron Leader 执行（@Global 恒提供；
    // @Optional 仅为既有单测装配兼容，先例 eventBus/tracing）。
    @Optional()
    private readonly leaderGate: LeaderGateService | null = null,
    // ARCH-32: pull 模式派发队列（ADR-015）。@Optional 同先例——存量单测
    // 装配未提供时为 null；pull 分支显式守卫抛错（不静默丢任务）。
    @Optional()
    private readonly pullService: ExecutorPullService | null = null,
    // python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：派发时解析
    // `applications.packageUrl`。@Optional 同先例——存量单测装配未提供时为
    // null；仅当任务确为 zip 渠道时才需要它，缺失即明确失败（不静默降级成
    // "下发无 packageUrl 的任务"，那会让执行器在运行时才炸）。**必须是最后
    // 一个位置参数**：既有 spec 以 14 个位置参数 `new ExecutorService(...)`
    // 直接装配，追加带默认值的尾参不破坏它们。
    @Optional()
    @InjectRepository(Application)
    private readonly applicationRepo: Repository<Application> | null = null,
    // ARCH-35 P1（生产事故 2026-09-23）：部署归属偏好所需的 `app_deployments`
    // 只读仓库。@Optional 同先例——存量单测装配未提供时为 null，此时**整条
    // 偏好逻辑短路**（与开关关闭同路径），派发顺序逐字节不变。同样**必须是
    // 最后一个位置参数**（15 个位置参数装配的兼容性约束同上）。
    @Optional()
    @InjectRepository(AppDeployment)
    private readonly appDeploymentRepo: Repository<AppDeployment> | null = null,
    // ARCH-31 §3.7 收口：跨实例令牌缓存驱逐广播（pub/sub）。@Optional 同
    // eventBus 先例——存量单测装配未提供时为 null，多实例失效窗口退化为
    // 改造前的 60s TTL（不劣化）。**必须是最后一个位置参数**（既有 spec
    // 以位置参数 `new ExecutorService(...)` 直接装配，带默认值的尾参不破坏）。
    @Optional()
    private readonly tokenCacheSync: ExecutorTokenCacheSyncService | null = null,
    // MUTEX-01（应用互斥组）：组内并发数只读仓库。@Optional 同先例——存量
    // 单测装配未提供时为 null，挂组执行降级为「不参与互斥」（宁可不约束，
    // 不可派不出去，见 claimExecutorSlotForExecution）。
    @Optional()
    @InjectRepository(MutexGroup)
    private readonly mutexGroupRepo: Repository<MutexGroup> | null = null,
    // FEAT-22 方案 B（版本跟随部署）：`application_versions` 只读仓库——
    // 派发命中部署设备时按 deployedVersion 取当版快照的 packageUrl。
    // @Optional 同先例——存量单测装配未提供时为 null，版本跟随整段短路
    // （派发一律用当前版，与未命中部署设备同路径）。**必须是最后一个位置
    // 参数**（既有 spec 以位置参数直接装配，带默认值的尾参不破坏）。
    @Optional()
    @InjectRepository(ApplicationVersion)
    private readonly applicationVersionRepo: Repository<ApplicationVersion> | null = null,
    // R3-A（§4.3）：`executor_app_versions` 读写仓库——心跳 deployedApps 落库
    // （applyReportedAppVersions）、getReleases devices 读面
    // （getAppVersionFacts）、派发版本跟随的事实源（resolveVersionFollowPackage）。
    // @Optional 同先例——存量单测装配未提供时为 null：落库静默跳过（warn）、
    // 读面返回空（调用方回退部署行推断），主链（注册/心跳/派发）不受影响。
    // 同样**必须是最后一个位置参数**（位置参数装配兼容性约束同上）。
    @Optional()
    @InjectRepository(ExecutorAppVersion)
    private readonly executorAppVersionRepo: Repository<ExecutorAppVersion> | null = null,
    // R3-B（服务层质量巡查）：applyReportedAppVersions 的整替事务
    // （dataSource.transaction；同 task.service storeLogLines 先例）。
    private readonly dataSource: DataSource,
  ) {
    this.protocol = this.configService.get<string>("app.protocol") || "http";
    // R-26（DEEP_REVIEW 0ef3bbe）: 关键 @Optional（事件总线 / 高危审计）缺失时
    // 一次性 warn，使静默降级在日志面可见——eventBus 缺失则 executor.offline
    // 事件静默不发；audit 缺失则 rotate-token 等高危操作审计静默不写。
    if (!this.eventBus) {
      this.logger.warn(
        "R-26: DomainEventBus 未装配——executor.offline 事件将静默不发",
      );
    }
    if (!this.audit) {
      this.logger.warn(
        "R-26: AuditService 未装配——executor 高危操作审计将静默不写",
      );
    }
    // ARCH-35 P1（R-26 同款纪律）：部署归属偏好**被期望生效**（开关非 false）
    // 却没有仓库时，偏好会静默不生效——用户会以为修复已上线，实际任务仍可能
    // 派到未部署该应用的执行器上（正是本次事故的现象）。故显式 warn。
    // 仅当开关**明确为 false**（主动关闭，见 configuration.ts）时不告警：
    // 那是运维的有意选择，不是装配缺失。
    if (
      !this.appDeploymentRepo &&
      this.configService.get("executor.preferDeployedExecutor") !== false
    ) {
      this.logger.warn(
        "R-26: AppDeployment 仓库未装配——ARCH-35 部署归属偏好将静默不生效" +
          "（任务可能被派到未部署该应用的执行器）",
      );
    }
    // FEAT-22 方案 B（R-26 同款纪律）：版本跟随被期望生效（master 开关非
    // false）却没有版本快照仓库时，派发会静默退化为「一律当前版」——用户
    // 以「设备上是什么版本就跑什么版本」预期部署升级/回滚，实际不生效且无
    // 报错。显式 warn；开关明确关闭时不告警（运维的有意选择）。
    if (
      !this.applicationVersionRepo &&
      this.configService.get("executor.preferDeployedExecutor") !== false
    ) {
      this.logger.warn(
        "R-26: ApplicationVersion 仓库未装配——FEAT-22 方案 B 版本跟随将不生效" +
          "（派发一律使用应用当前版本）",
      );
    }
  }

  /**
   * ARCH-31 §3.7：接通跨实例驱逐广播。本实例 rotate/remove 时广播；远端实例
   * 的广播与重连 flush 经这两个回调回到本地逐出。同步服务缺席（@Optional）
   * 或 Redis 不可用时是 no-op——多实例失效窗口退化为既有 60s TTL。
   */
  onModuleInit(): void {
    this.tokenCacheSync?.bindHandlers({
      onEvict: (address) => this.evictLocalTokenCaches(address),
      onFlush: () => this.flushLocalTokenCaches(),
    });
  }

  /** 三张令牌派生缓存的本地逐出（rotate/remove 的本实例半边；远端经广播触发）。 */
  private evictLocalTokenCaches(address: string): void {
    this.evictTokenValidationsFor(address);
    // ADR-017 阶段 3：`issuedTokenCache` / `callbackSecretCache` 的键是**定位
    // 身份**（指纹优先，非裸 address）——按 address 直接 delete 删不到指纹键的
    // 条目，轮换后旧明文/旧哈希会继续命中正缓存，出现最长一个 TTL 的「撤销
    // 凭据仍可用」窗口（与 evictTokenValidationsFor 注释所述同一类失效）。
    // 故两张表都按**值里的 address** 回扫（键是单向派生的，无法前缀删除）。
    for (const [key, entry] of this.issuedTokenCache) {
      if (key === address || entry.address === address) {
        this.issuedTokenCache.delete(key);
      }
    }
    for (const [key, entry] of this.callbackSecretCache) {
      if (key === address || entry.address === address) {
        this.callbackSecretCache.delete(key);
      }
    }
  }

  /** 订阅（重）连上的自愈：全量清空。正缓存只存成功结果，代价是多一轮 bcrypt。 */
  private flushLocalTokenCaches(): void {
    this.tokenValidationCache.clear();
    this.callbackSecretCache.clear();
    this.issuedTokenCache.clear();
  }

  /**
   * ADR-017 阶段 3：三张令牌派生缓存的**统一键口径**——指纹优先，地址兜底。
   *
   * 为什么收敛成一个方法：`tokenValidationCache` / `callbackSecretCache` /
   * `issuedTokenCache` 三张缓存若各写一份「指纹 ?? 地址」表达式，任一处漏改
   * 就会出现「一张表按行身份分键、另一张按地址混键」的不一致——而混键的那张
   * 恰是串台面（同址两台的凭据互相命中）。单一事实源让口径无法漂移。
   *
   * 缺省/非法指纹（legacy 执行器、采集失败）→ 回落 address：与引入前逐字节
   * 一致（那时 address 就是唯一键）；同址多行的 legacy 组合下地址键虽有歧义，
   * 但那种组合本就在 `resolveExecutorRow` 处 fail-closed，不会走到缓存判定。
   */
  private tokenCacheIdentityKey(
    address: string,
    deviceFingerprint?: string | null,
  ): string {
    return normalizeDeviceFingerprint(deviceFingerprint) ?? address;
  }

  /** 广播驱逐（fire-and-forget；同步服务缺席 = 其他实例走 60s TTL 兜底）。 */
  private broadcastTokenEviction(address: string): void {
    void this.tokenCacheSync?.publishTokenEviction(address);
  }

  /**
   * AUTH-05: best-effort audit write for high-risk executor operations.
   * Never throws — an audit failure must not fail the operation itself
   * (the operation already succeeded at this point). No operator identity is
   * captured here on purpose: the admin surface (JWT principal) lives in the
   * controller layer; the reason (when the caller supplied one) is recorded
   * in detail.
   */
  private async auditHighRisk(
    action:
      | "executor.rotate_token"
      | "executor.delete"
      | "executor.install_cmd_viewed",
    executor: Pick<Executor, "id" | "address" | "appName">,
    reason?: string,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        action,
        resource: "executor",
        resourceId: executor.id,
        detail: {
          address: executor.address,
          appName: executor.appName,
          ...(reason ? { reason } : {}),
        },
      });
    } catch (e) {
      this.logger.warn(
        `audit write failed for ${action} on executor ${executor.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * ARCH-34 P0（生产事故 2026-09-23）：`address` 冲突的观测与告警。
   *
   * 背景与判据见 `executor-address-conflict.util.ts` 头注（「被顶替的进程生命
   * 复活」= 同一 address 上两个活进程并存）。此处只负责**可见性**：
   * 记 ERROR 日志 + 走既有通知渠道。级别取 error 而非 notifyExecutorOffline
   * 的 warning——掉线是可用性事件，而串台会让**任务与部署跑到错误的机器上**，
   * 属数据正确性问题。
   *
   * 为什么 P0 阶段**不**直接拒绝注册：拒绝会让被顶替的一方彻底失联（用户看到
   * 「执行器在线但收不到任务」），而当前两侧都无唯一标识时无法判定「谁才是
   * 合法持有者」。先让问题可见；拒绝语义与身份体系按 ADR-017 分阶段落地
   * （本文件目前**不含**任何拒绝开关，注册行为与引入前逐字节一致）。
   *
   * fail-open：观测与通知的任何失败都绝不影响 register/heartbeat 主链。
   */
  private observeAddressConflict(
    address: string,
    startupId: string | null | undefined,
    source: "register" | "heartbeat",
  ): AddressConflictObservation | null {
    let obs: AddressConflictObservation | null = null;
    try {
      obs = this.addressConflictTracker.observe(address, startupId);
    } catch (err) {
      // 纯内存跟踪器不应抛错；真抛了也绝不阻断注册/心跳。
      this.logger.warn(
        `address conflict tracking failed for ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (!obs?.conflict) return obs;

    // 节流命中：确实冲突但刚告警过 → 只留 debug 痕迹，不重复外发。
    if (obs.throttled) {
      this.logger.debug(
        `Address conflict still present for ${address} (startupId=${obs.startupId}, ${obs.otherStartupIds} other life(s)); alert throttled`,
      );
      return obs;
    }

    const detail =
      `Executor address conflict detected on "${address}" via ${source}: ` +
      `startupId=${obs.startupId} is still alive after being displaced by ` +
      `${obs.displacedStartupId ?? "(unknown)"} (${obs.otherStartupIds} process life(s) seen on this address). ` +
      `Two executors are sharing one executors row — their registrations overwrite each other, ` +
      `they compete for the same pull queue (acf:pull:/acf:cmd:), and each one's restart detection ` +
      `fails the other's running executions. Give each machine a distinct EXECUTOR_ADDRESS_PUBLIC ` +
      `(or enable pull mode with unique addresses) to separate them.`;
    this.logger.error(detail);
    // 通知是 best-effort：`notificationService` 在部分测试装配里可能缺席
    // （位置参数 `{} as never`），且 sendAll 可能同步抛错——两者都绝不能
    // 影响注册/心跳主链（与 auditHighRisk 的 fail-open 同款纪律）。
    try {
      void Promise.resolve(
        this.notificationService?.sendAll({
          title: `Executor address conflict: ${address}`,
          content:
            `${detail}\n\n` +
            `Displaced (now active): ${obs.displacedStartupId ?? "(unknown)"}\n` +
            `Revived (still alive): ${obs.startupId}\n` +
            `Time: ${new Date().toLocaleString()}`,
          level: "error",
        }),
      ).catch((err: unknown) =>
        this.logger.warn(
          `Failed to send address-conflict notification for ${address}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to dispatch address-conflict notification for ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return obs;
  }

  /**
   * ARCH-36（ADR-017 阶段 2）：`deviceFingerprint` 冲突/漂移的观测与告警。
   *
   * 判据与方向见 `executor-fingerprint.util.ts` 头注。此处只负责**可见性**：
   * - **真冲突**（`conflictKind` 非空）→ ERROR 日志 + 既有通知渠道，级别与 P0
   *   冲突一致（会让任务与部署跑到错误的机器上，属数据正确性问题）。两种形态：
   *   · `push-address-collision`：该地址上有 push 行，而 push 行的 address 就是
   *     路由面（唯一索引只约束 push 行）——撞了必然投错机。
   *   · `row-identity-overwrite`：两个不同指纹落在**同一行 id** 上，一份安装的
   *     身份被另一份顶替（阶段 2 判据本来想抓的形态）。
   * - pull 模式的**同址多行**（`addressSharedByMultipleRows` 且无 conflictKind）
   *   → **info 日志**，不告警。ADR-017 §5 明确允许该形态：队列键是行 id、重启
   *   恢复按行身份，两台机器各自成行互不影响。生产实证（2026-10-22）：判据停在
   *   阶段 2 的「同址第二个指纹即冲突」，一屏全 pull 的机队因此每 10 分钟收到
   *   一条毫无意义的 ERROR 通知。
   * - 地址漂移（同一指纹换了 address）→ **info 日志**，不告警。这是刻意的：
   *   机器换网/换 IP 是正常运维动作，把它升级成告警会让告警面失去信噪比
   *   （P0 头注里说的"狼来了"）。
   *
   * 与 P0 的关系：两个跟踪器**同时**接线，各自独立外发。一台机器同时具备两个
   * 信号特征（已上报指纹 + 进程生命交替）时会收到两条告警——刻意保留：两条
   * 判据的证据面不同（一条是身份冲突的直接证据，一条是进程并存的时序证据），
   * 合并会丢失"哪条通路成立"的区分度，而运营侧可用**同一条**处置动作收敛两者
   * （给每台机器唯一 EXECUTOR_ADDRESS_PUBLIC）。去重不做，节流各自独立。
   *
   * fail-open：观测与通知的任何失败都绝不影响 register/heartbeat 主链。
   */
  private observeDeviceFingerprint(
    address: string,
    fingerprint: string | null | undefined,
    source: "register" | "heartbeat",
    ctx: FingerprintObserveContext = {},
  ): FingerprintObservation | null {
    let obs: FingerprintObservation | null = null;
    try {
      // 阶段 3 复查补口：判据从「按地址」改为「按行」——ctx 带 rowId 与
      // dispatchMode，跟踪器据此区分「地址是路由面被撞」（真故障）与
      // 「pull 同址多行」（ADR-017 §5 的设计形态，不是故障）。
      obs = this.deviceFingerprintTracker.observeWithContext(
        address,
        fingerprint,
        ctx,
      );
    } catch (err) {
      // 纯内存跟踪器不应抛错；真抛了也绝不阻断注册/心跳。
      this.logger.warn(
        `deviceFingerprint tracking failed for ${address}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
    // 未上报/非法指纹（存量旧执行器）：零动作、零日志——兼容性红线。
    if (!obs) return obs;

    const shortFingerprint = `${obs.fingerprint.slice(0, 12)}…`;
    const fingerprintList = obs.distinctFingerprintsOnAddress
      .map((f) => `${f.slice(0, 12)}…`)
      .join(", ");

    if (obs.conflictKind !== null) {
      if (obs.throttled) {
        this.logger.debug(
          `Address "${address}" still conflicts (${obs.conflictKind}, fingerprint=${shortFingerprint}, ` +
            `${obs.fingerprintsOnAddress} concurrent installs); alert throttled`,
        );
        return obs;
      }
      // 文案按 conflictKind 分叉——旧文案照抄的是**阶段 2** 的叙述（「两台机器
      // 共享一行 / 抢同一队列 / 重启互杀」），阶段 3 之后这三条在 pull 模式下
      // 全部不成立，照抄出去就是把运维指向错误的处置面。
      const detail = this.describeFingerprintConflict(
        obs,
        source,
        shortFingerprint,
        fingerprintList,
      );
      this.logger.error(detail);
      // 通知是 best-effort：`notificationService` 在部分测试装配里可能缺席，
      // 且 sendAll 可能同步抛错——两者都绝不能影响注册/心跳主链（与
      // observeAddressConflict 同款 fail-open 纪律）。
      try {
        void Promise.resolve(
          this.notificationService?.sendAll({
            title: this.fingerprintConflictTitle(obs),
            content:
              `${detail}\n\n` +
              `Address: ${address}\n` +
              `Conflict kind: ${obs.conflictKind}\n` +
              `Concurrent installs on this address: ${obs.fingerprintsOnAddress}\n` +
              `Fingerprints: ${fingerprintList}\n` +
              `This report: ${shortFingerprint}\n` +
              `Row id of this report: ${ctx.rowId ?? "(unknown)"}\n` +
              `Time: ${new Date().toLocaleString()}`,
            level: "error",
          }),
        ).catch((err: unknown) =>
          this.logger.warn(
            `Failed to send deviceFingerprint-conflict notification for ${address}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      } catch (err) {
        this.logger.warn(
          `Failed to dispatch deviceFingerprint-conflict notification for ${address}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return obs;
    }

    // pull 模式的同址多行是 ADR-017 §5 的设计形态：不告警、不外发通知。
    // 但也不能完全静音——它是「这份安装的 address 与别人撞了」的唯一可见面，
    // 排障时要查得到。故记一条 info，并按 (address, fingerprint) 节流（心跳
    // 30s 一次 × N 台，不节流会把日志刷成瀑布）。
    if (obs.addressSharedByMultipleRows) {
      if (obs.infoThrottled) return obs;
      this.logger.log(
        `Address "${address}" carries ${obs.fingerprintsOnAddress} concurrent pull-mode ` +
          `installs via ${source} (this report: ${shortFingerprint}; all: ${fingerprintList}) — ` +
          `same-address rows are the designed shape for dispatchMode=pull (ADR-017 §5): ` +
          `each install keeps its own row, its own queue (acf:pull:{executorId}) and its own ` +
          `restart detection. No conflict, no action needed. If you believe these are the ` +
          `SAME machine, check whether WORK_DIR/.device-identity salts were rebuilt (a new ` +
          `fingerprint creates a new row) — and do NOT try to fix that by changing ` +
          `EXECUTOR_ADDRESS_PUBLIC.`,
      );
      return obs;
    }

    if (obs.addressDrifted) {
      // 正常现象，只留一条 log（不告警）：这是阶段 3 把 address 降级为可达性
      // 元数据之后「执行器换网不再产生幽灵行」的行为预览，此处先让运维看得见。
      // 用 logger.log（Nest 的 info 级）而非 warn/error——详见上方「为什么不告警」。
      this.logger.log(
        `Install ${shortFingerprint} reported from a new address "${address}" via ${source} ` +
          `(now seen at ${obs.addressesForFingerprint} address(es)) — address drift, not a conflict`,
      );
    }
    return obs;
  }

  /** 冲突告警标题：按 conflictKind 分叉（两种形态的处置面不同）。 */
  private fingerprintConflictTitle(obs: FingerprintObservation): string {
    return obs.conflictKind === "row-identity-overwrite"
      ? `Two installations are overwriting one executor row: ${obs.address}`
      : `Executor address shared by multiple installs: ${obs.address}`;
  }

  /**
   * 冲突告警正文：按 conflictKind 分叉。
   *
   * 为什么必须分叉（复查发现）：旧正文描述的三条后果——共享同一 executors 行、
   * 抢同一条 pull 队列（acf:pull:/acf:cmd:）、重启检测互杀——在**阶段 3 之后**
   * 的 pull 行上全部不成立（队列键是行 id，恢复按行身份）；它给出的处置建议
   * 「给每台机器唯一 EXECUTOR_ADDRESS_PUBLIC」对「同一台机器指纹变了」这一
   * 形态也是无效的。文案照抄阶段 2 的叙述 ⇒ 运维被指向错误的处置面。
   */
  private describeFingerprintConflict(
    obs: FingerprintObservation,
    source: "register" | "heartbeat",
    shortFingerprint: string,
    fingerprintList: string,
  ): string {
    if (obs.conflictKind === "row-identity-overwrite") {
      return (
        `Two different installations are writing into the SAME executors row on "${obs.address}" ` +
        `via ${source}: ${obs.fingerprintsOnAddress} distinct deviceFingerprint values map to ` +
        `one row id (this report: ${shortFingerprint}; all: ${fingerprintList}). This is the ` +
        `phase-2 failure shape: their registrations overwrite each other, their per-executor ` +
        `tokens are rotated by each other, and each one's restart detection fails the other's ` +
        `running executions. Make the identity unambiguous: upgrade the executors to protocol ` +
        `v3 (reports deviceFingerprint) and give each machine a distinct ` +
        `EXECUTOR_ADDRESS_PUBLIC.`
      );
    }
    return (
      `Executor address shared by multiple installs on "${obs.address}" via ${source}: ` +
      `${obs.fingerprintsOnAddress} distinct deviceFingerprint values are concurrently present ` +
      `on this address (this report: ${shortFingerprint}; all: ${fingerprintList}). This ` +
      `address carries a PUSH-mode executor row, and for push rows the address IS the routing ` +
      `surface (unique index uq_executors_address WHERE "dispatchMode" = 'push'): a second ` +
      `install on it means HTTP control commands (deploy / kill / config-reload) can be ` +
      `delivered to the wrong machine. Give each push-mode machine a distinct ` +
      `EXECUTOR_ADDRESS_PUBLIC, or move the fleet to dispatchMode=pull, where the address is ` +
      `only a label and same-address rows are legal. (deviceFingerprint-based detection: a ` +
      `stable fingerprint cannot change across a normal restart, so this is direct evidence ` +
      `rather than the startupId timing heuristic.)`
    );
  }
  /**
   * P0-4（生产报告 2026-10-22 §4.4）：pull 控制面命令**失败**结果的事件发布。
   *
   * 调用点：`POST /executors/command-result` 收到 `ok=false` 且该命令是部署类
   * （旁路元数据里带 deploymentId）时。订阅方（部署域）据此把在飞行立刻收成
   * FAILED——旧实现只写日志 + 600s 的 Redis 结果键，行会一直停在 DEPLOYING
   * 直到卡死扫描（pull 未决行豁免到命令 TTL 30 分钟）才判失败，期间后续部署
   * 全被在途锁拒成 409。
   *
   * fail-open：与本模块其余事件同纪律——emit 抛错绝不改变上报响应，
   * eventBus 为 null（部分测试装配）时静默跳过。
   */
  publishControlCommandFailure(payload: {
    commandId: string;
    type: string;
    address: string;
    deploymentId: string | null;
    error: string | null;
  }): void {
    if (!this.eventBus) return;
    const event: ExecutorCommandFailedEventPayload = {
      commandId: payload.commandId,
      type: payload.type,
      address: payload.address,
      deploymentId: payload.deploymentId,
      error: payload.error,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.EXECUTOR_COMMAND_FAILED, event);
    } catch {
      /* bus contract is fail-open; second fuse */
    }
  }

  /**
   * P1（生产报告 2026-10-22 §4.6 / 结论 H）：带指纹缺失诊断的节流 warn。
   *
   * 语义是**诊断可见性**，不是判定：判定仍由 resolveExecutorRow / register 的
   * fail-closed 负责。这里只回答「刚才那条 409/404 是哪台机器发的」。
   */
  private warnMissingFingerprintOnce(
    address: string,
    executor: Executor,
  ): void {
    const now = Date.now();
    const last = lastMissingFingerprintWarn.get(address);
    if (
      last !== undefined &&
      now - last < MISSING_FINGERPRINT_WARN_THROTTLE_MS
    ) {
      return;
    }
    if (lastMissingFingerprintWarn.size > 5000)
      lastMissingFingerprintWarn.clear();
    lastMissingFingerprintWarn.set(address, now);
    this.logger.warn(
      `Heartbeat without a parseable deviceFingerprint: executor ${executor.id} ` +
        `(${executor.appName}) at ${address}, dispatchMode=${executor.dispatchMode ?? "push"}. ` +
        `ADR-017 phase 3 locates rows by fingerprint: with two rows on one address this ` +
        `request is fail-closed (pull returns 404, so the machine gets no tasks or commands). ` +
        `Fix: upgrade it to protocol v3 (reports deviceFingerprint) or give it a unique ` +
        `EXECUTOR_ADDRESS_PUBLIC.`,
    );
  }

  /**
   * P0-4 附带（§7 P0-3 末条）：地址漂移采纳后发布 executor.address.drifted。
   *
   * 订阅方（部署域）据此把该执行器名下的未终结部署行快照滚到新地址——
   * `app_deployments.executorAddress` 是**快照**，此前从不随漂移更新，于是
   * 任何按快照地址出站的路径（push 回退、UI 展示）都停在旧地址上。
   *
   * fail-open：与其余事件同纪律（emit 抛错绝不改变注册/心跳主链；eventBus
   * 为 null 时静默跳过）。只在**真实跃迁**时由调用方触发。
   */
  private emitExecutorAddressDrifted(
    executor: Pick<Executor, "id" | "appName" | "address">,
    previousAddress: string,
  ): void {
    if (!this.eventBus) return;
    if (!previousAddress || previousAddress === executor.address) return;
    const payload: ExecutorAddressDriftedEventPayload = {
      executorId: executor.id,
      appName: executor.appName,
      previousAddress,
      address: executor.address,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.EXECUTOR_ADDRESS_DRIFTED, payload);
    } catch {
      /* bus contract is fail-open; second fuse */
    }
  }

  /**
   * FEAT-07: 状态落库后发布 executor.offline（fail-open——emit 抛错绝不改变
   * 调用方结果；eventBus 为 null 时静默跳过）。载荷全为原始类型，与
   * domain-events.ts 设计约束一致。
   */
  private emitExecutorOffline(
    executor: Pick<Executor, "id" | "appName" | "address">,
  ): void {
    if (!this.eventBus) return;
    const payload: ExecutorOfflineEventPayload = {
      executorId: executor.id,
      appName: executor.appName,
      address: executor.address,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.EXECUTOR_OFFLINE, payload);
    } catch {
      /* bus contract is fail-open; second fuse */
    }
  }

  /**
   * NETOPT-G P1-6: 状态落库后发布 executor.online（与 emitExecutorOffline 对称：
   * fail-open、载荷同形）。
   *
   * 只在**真实跃迁**（prev !== ONLINE）时由调用方触发——心跳是 30s 高频路径，
   * 无条件 emit 会把 event_outbox 打爆并给订阅方造成无意义扇出。
   */
  private emitExecutorOnline(
    executor: Pick<Executor, "id" | "appName" | "address">,
  ): void {
    if (!this.eventBus) return;
    const payload: ExecutorOnlineEventPayload = {
      executorId: executor.id,
      appName: executor.appName,
      address: executor.address,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.eventBus.emit(DOMAIN_EVENTS.EXECUTOR_ONLINE, payload);
    } catch {
      /* bus contract is fail-open; second fuse */
    }
  }

  public getExecutorUrl(address: string, path: string): string {
    // SEC-SSRF-03：地址来自执行器自报的 register/heartbeat 字段，未做归一。
    // 若地址里含 '#'，URL 解析会把其后内容当作 fragment，导致我们拼出的
    // 路径被整体丢进 fragment —— 实测 `http://10.0.0.5#` + 'api/executions/x'
    // 解析出的 pathname 是 "/"（而非预期的 /api/executions/x），于是请求打到
    // 目标主机的根路径。这既会让调用错端点，也会在未守卫的调用点把
    // admin 的带 token 请求引到攻击者选定的路径上。
    // '?' 同理会把路径变成查询串的一部分。两者都不是合法执行器地址的一部分，
    // 一律先剥离，保证拼出的 URL 路径就是我们传入的 path。
    const sanitized = address.split(/[?#]/, 1)[0];
    if (address.startsWith("http://") || address.startsWith("https://")) {
      return `${sanitized.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    }
    return `${this.protocol}://${sanitized.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  /**
   * Resolve the executor shared credential for outbound requests (DB-first,
   * env fallback). Every admin→executor call site must go through this
   * resolver so a DB rotation propagates everywhere at once — a raw env read
   * sends a stale credential the executor's DB-first verification rejects.
   */
  async getSharedToken(): Promise<string> {
    try {
      const cfg = await this.systemConfigService.findOne(
        "executor.sharedToken",
      );
      if (cfg?.value) return cfg.value;
    } catch {
      // DB token is optional; fall back to environment/config-file value.
    }
    return this.configService.get<string>("executor.sharedToken") ?? "";
  }

  /**
   * SEC-02: build the executor-bound `params` payload = execution params
   * merged with decrypted task.secrets. Secrets WIN over params (a credential
   * set at task level must not be shadowable by a per-trigger param of the
   * same name — executors map every entry to AUTOFLOW_<KEY> env vars). The
   * merged map lives only on the dispatch HTTP payload: it is never persisted
   * back to TaskExecution.params, so plaintext never re-enters the database.
   * A decryption failure (e.g. key missing/rotated away) surfaces as a
   * dispatch error and the execution fails with a clear message instead of
   * silently running without its credentials.
   */
  private buildDispatchParams(
    task: Task,
    execution: TaskExecution,
  ): Record<string, unknown> {
    const params = (execution.params ?? task.params ?? {}) as Record<
      string,
      unknown
    >;
    let decrypted: Record<string, unknown> | null | undefined;
    try {
      decrypted = this.secretsCrypto.decryptForDispatch(task.secrets);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError("TASK_SECRET_DECRYPT_FAILED", {
        detail: message,
      });
    }
    return { ...(params ?? {}), ...(decrypted ?? {}) };
  }

  /**
   * SEC-02 续（生产故障）：把解密后的 secrets **单独**作为派发载荷的 `secrets`
   * 字段下发，供执行器按**原名**注入子进程 env。
   *
   * 为什么需要单独一份（而不是只走既有的 params 合并）：此前 secrets 与 params
   * 合并后统一加 `AUTOFLOW_` 前缀，于是"配置 FEISHU_APP_ID"实际注入的是
   * `AUTOFLOW_FEISHU_APP_ID`——脚本按提示读裸名永远取不到（生产实证），而
   * **第三方 SDK 认的就是规范名**（boto3 的 AWS_ACCESS_KEY_ID、openai 的
   * OPENAI_API_KEY），加前缀后脚本无法改写，凭据等于不可用。
   *
   * 兼容性（关键）：secrets **仍然**合并进 params（`buildDispatchParams`
   * 不动），所以：
   *   · 旧执行器（不认识 `secrets` 字段）行为与今日**逐字节一致**——它们照旧
   *     只读 params，照旧注入 `AUTOFLOW_<KEY>`；
   *   · 新执行器额外按原名注入一份，两种读法并存。
   * 因此本字段是**纯增量**，无需协议版本门禁（不 bump PROTOCOL_VERSION：没有
   * 任何行为依赖"对方是否认识它"）。这与 v2 `commands` 的情形不同——那里必须
   * 门禁，因为 v1 执行器会静默丢弃命令、中台却会误判投递成功。
   *
   * 解密失败与 `buildDispatchParams` 同策：抛错让派发失败，绝不静默裸跑。
   */
  private buildDispatchSecrets(task: Task): Record<string, unknown> | null {
    try {
      return this.secretsCrypto.decryptForDispatch(task.secrets) ?? null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError("TASK_SECRET_DECRYPT_FAILED", {
        detail: message,
      });
    }
  }

  /**
   * ADR-017 阶段 3：`address` 不再是唯一键——同地址多行并存（pull 模式，
   * ADR-017 §5）时 `WHERE address = :address` 会命中多行，一次冲销把**别人的**
   * `runningTaskCount` 也减 1。委托给共享 util（单一事实源，与调度器/触发路径
   * 同规则）：地址命中多行时**保守跳过**而非盲减（失败方向选保守侧——少减一次
   * 只是该执行器被保守少派，多减一次会让别人的计数虚低而被超发打爆）。
   * 单行命中时行为与引入前逐字节一致。
   */
  private async releaseExecutorSlot(address?: string | null): Promise<void> {
    await releaseExecutorSlotByAddress(this.repo.manager, address);
  }

  // NETOPT-F P3: releaseExecutorSlotBatch 已删除——批次 D 后重启恢复的计数
  // 权威改为"调用方 e.runningTaskCount=0 + save"（didRestart / missing-baseline
  // 两分支均清零），批量减槽不再有任何生产调用点。死代码若保留会诱导后人
  // 重新引入"恢复后再减槽"的双减 bug（恢复已清零、再减一次即虚低）。若未来
  // 确需批量减槽，须回到单计数权威语义重新设计。

  private parseExecutorStartedAt(value?: string | Date | null): Date | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private hasExecutorRestarted(
    executor: Executor,
    incomingStartedAt: Date | null,
    incomingStartupId: string | null,
  ): boolean {
    if (
      incomingStartupId &&
      executor.executorStartupId &&
      incomingStartupId !== executor.executorStartupId
    ) {
      return true;
    }
    if (
      incomingStartedAt &&
      executor.executorStartedAt &&
      incomingStartedAt.getTime() > executor.executorStartedAt.getTime()
    ) {
      return true;
    }
    return false;
  }

  /**
   * NETOPT-F P2-F1: 重启恢复的时间基线。startupId-only 重启（换了 startupId 但
   * 未上报 restartedAt）时 incomingStartedAt 为 null，而 shouldFailAfterRestart
   * 对 null 基线放行**全部** RUNNING 行——异步恢复会误杀恢复窗口内闸门新派发
   * 的行（startTime >= 重启时刻）。不得静默退化。
   * 早期实现退回 DB 侧旧基线 executorStartedAt（T0）作 onlyStartedBefore，但该
   * 基线实际"零恢复"：T0 那轮已终态化 startTime<T0 的行，当前存活 RUNNING 行
   * startTime 必然 >= T0，严格 < 过滤下一条都不终态化，旧进程死掉的行只能靠
   * stale sweep 回收（不丢任务——计数已清零、闸门不超派——但恢复路径空转）。
   * 修法：基线改取**服务端本次心跳处理时刻 now**——startTime<now 的旧行被
   * 终态化、恢复后新派发（startTime>now）存活；DB 旧基线仅作 warn 展示
   * （日志可审计），不参与判定。
   */
  private resolveRestartBaseline(
    address: string,
    incomingStartedAt: Date | null,
    incomingStartupId: string | null,
    dbBaseline: Date | string | null | undefined,
  ): Date {
    if (incomingStartedAt) return incomingStartedAt;
    const db = this.parseExecutorStartedAt(dbBaseline);
    const now = new Date();
    this.logger.warn(
      `Executor ${address} restarted with a new startupId=${incomingStartupId} ` +
        `but no restartedAt; using server-side now=${now.toISOString()} as the ` +
        `recovery baseline (startupId-only restart, time baseline degraded; ` +
        `DB executorStartedAt=${
          db ? db.toISOString() : "(null)"
        } was stale). Rows started after this baseline are NOT failed.`,
    );
    return now;
  }

  /**
   * P2: 重试预算语义的唯一来源（BullMQ attempts 语义：maxRetry 为总尝试预算，
   * retryCount 为已消耗的重试次数）。executor-restart 恢复路径与 scheduler
   * stale sweep 共用——sweep 此前只置 FAILED 不 re-enqueue，而 task.processor
   * 已将 RUNNING 移出 claimable，worker 崩溃型执行只能等 sweep 收敛，
   * task.maxRetry>0 的任务实际拿不到任何重试。
   */
  private static retryBudgetExhausted(
    task: Task,
    execution: TaskExecution,
  ): boolean {
    const maxAttempts = Math.max(1, task.maxRetry ?? 1);
    const nextRetryCount = (execution.retryCount ?? 0) + 1;
    return nextRetryCount >= maxAttempts;
  }

  /**
   * P2: 公开预算判定，供调用方把前置副作用（如 stale sweep 的 kill 通知）
   * 门控在"确实会安排重试"之上。scheduleRetryAfterRecovery 内部仍会复查，
   * 二者共享 retryBudgetExhausted，语义不会漂移。
   */
  hasRetryBudget(task: Task, execution: TaskExecution): boolean {
    return !ExecutorService.retryBudgetExhausted(task, execution);
  }

  /**
   * RUNNING→新 PENDING execution + 入队。executor-restart 恢复与 scheduler
   * stale sweep（P2）共用的重试兑现模式：预算耗尽则静默跳过（只保留 FAILED）。
   * fallbackTriggerType 仅在原执行未带 triggerType 时生效（restart 路径保持
   * 既有 "executor_restart"；sweep 传 "stale_recovery" 便于溯源）。
   */
  async scheduleRetryAfterRecovery(
    task: Task,
    execution: TaskExecution,
    fallbackTriggerType = "executor_restart",
  ): Promise<void> {
    const maxAttempts = Math.max(1, task.maxRetry ?? 1);
    const nextRetryCount = (execution.retryCount ?? 0) + 1;
    if (ExecutorService.retryBudgetExhausted(task, execution)) return;

    const retryExecution = this.execRepo.create({
      taskId: task.id,
      taskName: task.name,
      status: ExecutionStatus.PENDING,
      params: execution.params ?? task.params,
      triggerType: execution.triggerType ?? fallbackTriggerType,
      taskVersion: execution.taskVersion ?? task.currentVersion,
      retryCount: nextRetryCount,
      // MUTEX-01：重试执行继承原执行的互斥组快照——重试与原执行是同一条
      // 业务语义，若不继承，被互斥挡过的执行在重试时会绕开组约束。
      mutexGroupId: execution.mutexGroupId ?? null,
    });
    const saved = await this.execRepo.save(retryExecution);
    try {
      await this.taskQueue.add(
        "execute",
        { executionId: saved.id },
        {
          attempts: Math.max(1, maxAttempts - nextRetryCount),
          // CORE-02: recovery 重试的 attempt 序号 = retryCount+1（该执行行
          // 本身就是第 nextRetryCount 次重试的载体），delay 预乘指数基座并加
          // ±20% 抖动；返回 0（retryDelay<=0）保持 backoff: undefined 语义。
          backoff:
            task.retryDelay > 0
              ? {
                  type: "exponential",
                  delay: jitteredRetryDelayMs(task.retryDelay, nextRetryCount),
                }
              : undefined,
          // A4: 恢复重试此前漏传 priority（审计低项「restart 重试丢
          // priority」）——重试 job 无优先级地混入队列，紧急任务的重试被任意
          // 压后。与 trigger/rollback/scheduler.enqueue 同一口径：归一化 +
          // 方向换算（DB 4=紧急 → BullMQ 1=最先出队）。
          priority: toBullPriority(normalizeTaskPriority(task.priority)),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.execRepo.delete(saved.id).catch((deleteErr) => {
        const deleteMessage =
          deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        this.logger.warn(
          `Failed to delete unscheduled retry execution ${saved.id}: ${deleteMessage}`,
        );
      });
      this.logger.warn(
        `Failed to enqueue recovery retry for execution ${execution.id}: ${message}`,
      );
    }
  }

  /**
   * P2: best-effort 通知执行器终止指定 execution（stale sweep re-enqueue 前
   * 调用，防"执行器谎报/进程僵死但仍存活"场景下原进程与新执行双跑）。
   * 实现自 task.service.notifyExecutorKill 收敛至此（kill 端点 node/python
   * 两端均已就绪），TaskService 现委托本方法，避免两份逻辑。
   * 契约：地址为空跳过；任何失败（离线/404/超时）仅 warn，绝不抛出。
   *
   * ARCH-33（ADR-016）：pull 执行器（NAT 内）改走命令队列入队——此前本方法
   * 对 NAT 地址必然超时，而它是 stale sweep 的「防双跑」关键路径。
   */
  async notifyExecutorKill(
    executionId: string,
    executorAddress?: string | null,
  ): Promise<void> {
    if (!executorAddress) return;
    try {
      // ARCH-33: pull 执行器入队即返回（best-effort 语义不变——入队失败回退
      // push，下方 catch 仍把任何异常收敛为 warn）。
      const routed = await this.deliverControlCommand({
        address: executorAddress,
        type: "kill-execution",
        payload: { executionId },
      });
      if (routed.delivered === "pull") return;

      const token = await this.getSharedToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const url = this.getExecutorUrl(
        executorAddress,
        `api/executions/${executionId}/kill`,
      );
      // SEC-SSRF-02：与其他执行器出站调用保持一致——此前本处漏掉守卫，会把
      // 共享 token 作为 Bearer 发给 executorAddress 指定的任意主机（含
      // link-local 云元数据与 loopback）。守卫抛错由下方 catch 收敛为 warn，
      // 符合本方法「绝不抛出」的既有契约（调用方为调度器清扫与手动 kill，
      // 不应因一个可疑地址而中断）。
      // F-3（SEC-NEW）: 同时 pin 到校验通过的 IP（Host/SNI 保留）。
      const pinned = await assertAndPinExecutorUrl(url);
      const pinCfg = pinnedAxiosConfig(pinned);
      await axios.post(
        url,
        {},
        {
          headers,
          timeout: 3_000,
          maxRedirects: 0,
          ...pinCfg,
        },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to notify executor ${executorAddress} to kill execution ${executionId}: ${message}`,
      );
    }
  }

  private shouldFailAfterRestart(
    execution: TaskExecution,
    onlyStartedBefore?: Date | null,
  ): boolean {
    if (!onlyStartedBefore) return true;
    if (!execution.startTime) return true;
    return execution.startTime.getTime() < onlyStartedBefore.getTime();
  }

  /**
   * 执行器重启后终态化其遗留的 RUNNING 执行。
   *
   * ADR-017 阶段 3：匹配维度**优先按行身份 `executorId`**，仅当调用方没有
   * 行身份时才回落 `executorAddress`。
   *
   * 为什么必须改：阶段 3 允许 pull 同地址多行并存（ADR-017 §5），纯按地址匹配
   * 会把**另一台机器正在跑的健康执行**一并判成 EXECUTOR_RESTART —— 这正是
   * `executor-address-conflict.util.ts` 头注列为「三类静默故障」之一的形态，
   * 而 partial 索引恰好把这个状态合法化了。存量执行行没有 executorId（可空），
   * 那些行只能按地址匹配 —— 与引入前逐字节一致。
   *
   * @param executorId 行身份（新派发一律有）；null 时回落 address 匹配
   * @param executorAddress 派发当时的地址（存量行/恢复基准）
   */
  private async failRunningExecutionsAfterRestart(
    executorAddress: string,
    onlyStartedBefore?: Date | null,
    executorId?: string | null,
  ): Promise<number> {
    const runningExecutions = await this.execRepo.find({
      where: {
        // 有行身份 → 精确限定那一行；否则回落地址（存量行语义不变）。
        ...(executorId
          ? { executorId }
          : { executorAddress, executorId: IsNull() }),
        status: ExecutionStatus.RUNNING,
      },
      // NETOPT-C P3: take 与 E9 采纳域（maxConcurrentTasks ≤10000）对齐——旧 1000
      // 在并发 >1000 时第 1001+ 行不立即标 EXECUTOR_RESTART，滞留 RUNNING 直到
      // stale 兜底（分类降级为 STALE_RECOVERED）。ORDER BY 让重启恢复按启动时间
      // 确定性执行（无排序时 DB 行序不定，同批重复恢复会漂移）。
      take: 10_000,
      order: { startTime: "ASC" },
    });
    const executionsToFail = runningExecutions.filter((execution) =>
      this.shouldFailAfterRestart(execution, onlyStartedBefore),
    );
    // Batch-fetch tasks once instead of one query per execution (avoids N+1)
    const taskIds = [...new Set(executionsToFail.map((e) => e.taskId))];
    const tasks =
      taskIds.length > 0 ? await this.taskRepo.findBy({ id: In(taskIds) }) : [];
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    // NETOPT-D P2-D1: 重启恢复从"逐行 UPDATE+RETURNING + 逐行减槽 + 逐行入队"
    // 改为"单条批量终态 UPDATE + 按 address 一次性减槽"——满载执行器重启时
    // 逐行写放大（≈2×N 次 DB 往返 + N 次行锁竞争 + N 次 Redis enqueue）会把
    // register/heartbeat 单条请求推到全局 30s 超时（timeout.interceptor.ts）
    // 之外，触发 408 重复恢复。批量版与 scheduler.service 的 stale sweep 同构
    // （transitionToTerminal 批量入口，status-IN 条件 + RETURNING winner 语义）；
    // 单行乐观锁冲突在批量 UPDATE 中不适用（无 version 条件，行锁由 DB 排队），
    // R-11 的"不击穿整批"本意由"单条 UPDATE...IN 原子 + 整体 catch 交 stale
    // sweep 收敛"等价承接。
    if (executionsToFail.length === 0) {
      return 0;
    }
    let failedCount = 0;
    let errorCount = 0;
    try {
      const addressSnapshot = new Map<string, string | null>(
        executionsToFail.map((e) => [e.id, e.executorAddress]),
      );
      const terminal = await transitionToTerminal(this.execRepo, {
        ids: executionsToFail.map((e) => e.id),
        patch: {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          failureReason: ExecutionFailureReason.EXECUTOR_RESTART,
          errorMessage:
            "[System] Executor restarted before reporting completion",
          logs: () =>
            `CASE WHEN "logs" IS NULL THEN '' ELSE "logs"::text END || ` +
            `E'\n[System] Executor restarted; execution marked as FAILED'`,
        },
        from: [ExecutionStatus.RUNNING],
        addressSnapshot,
      });
      failedCount = terminal.rows.length;
      // NETOPT-E P2-1: 本函数**不再负责减槽**——计数权威交给调用方的
      // e.runningTaskCount = 0 + save（register/heartbeat 的 didRestart /
      // shouldRecoverMissingBaseline 分支均在同一请求内清零后落库；心跳带真实
      // 上报值时白名单覆盖优先）。此前异步路径（heartbeat 的 void 调用）在
      // save 之后按"旧 winner 数"对已含新派发的计数做 GREATEST 倒扣，会把
      // 新任务计数清零（如 save 写 N 后 GREATEST(N-8000,0)=0）——一个心跳窗
      // 内欠计超派。恢复完成前的计数归零语义不变：执行器重启后旧任务已全部
      // 终态化，runningTaskCount 本应归 0 或自报新值。
      // 重试入队仍逐行：每条需新建 PENDING 行（retryCount/params 各自不同）+
      // BullMQ add；预算检查在 scheduleRetryAfterRecovery 内部，逐行 try/catch
      // 保留异常隔离（入队失败不影响已完成的终态落库）。
      const winnerIds = new Set(terminal.rows.map((r) => r.id));
      for (const execution of executionsToFail) {
        if (!winnerIds.has(execution.id)) continue;
        const task = execution.taskId
          ? (taskMap.get(execution.taskId) ?? null)
          : null;
        if (!task) continue;
        try {
          await this.scheduleRetryAfterRecovery(task, execution);
        } catch (err: unknown) {
          errorCount++;
          this.logger.warn(
            `R-11: Failed to schedule retry for execution ${execution.id} after restart ` +
              `(executor=${executorAddress}): ${
                err instanceof Error ? err.message : String(err)
              }. Execution already marked FAILED; retry skipped.`,
          );
        }
      }
    } catch (err: unknown) {
      errorCount = executionsToFail.length;
      this.logger.warn(
        `R-11: Batch fail of ${executionsToFail.length} running execution(s) after restart ` +
          `(executor=${executorAddress}): ${
            err instanceof Error ? err.message : String(err)
          }. Stale sweep will pick them up.`,
      );
    }
    if (executionsToFail.length > 0) {
      this.logger.warn(
        `Marked ${failedCount}/${executionsToFail.length} running execution(s) as FAILED after executor restart: ${executorAddress}` +
          (errorCount > 0
            ? ` (${errorCount} row(s) had errors and will be retried by stale sweep)`
            : ""),
      );
    }
    // R-P0-009（NETOPT-F P3 注释更新）: 返回值曾供调用方按 winner 数倒扣
    // runningTaskCount——批次 D 后计数权威改为"调用方 e.runningTaskCount=0 +
    // save"（didRestart / missing-baseline 分支均清零），本函数返回值现仅用于
    // 日志/统计（failedCount），不再有减槽用途。
    return failedCount;
  }

  /**
   * ARCH-32: 按地址取执行器行（pull 端点解析队列归属 executorId 用）。
   * 地址是 register/heartbeat 的身份键（与 validateTokenByAddress 同源），
   * id 才是稳定的队列键——地址可漂移（重注册换网），id 不变。
   */
  async findByAddress(
    address: string,
    deviceFingerprint?: string | null,
  ): Promise<Executor | null> {
    // ADR-017 阶段 3：走统一解析（指纹优先 + 同址多行无指纹时 fail-closed）。
    // 纯 `findOne({where:{address}})` 在 pull 同址多行时会返回**任一行**——
    // `/executors/pull` 据此取 executor.id 去拉 Redis 队列，会拉到别人的任务。
    if (deviceFingerprint !== undefined) {
      return this.resolveExecutorRow(address, deviceFingerprint);
    }
    const byAddress = await this.repo.find({ where: { address }, take: 2 });
    if (byAddress.length > 1) {
      this.logger.warn(
        `findByAddress("${address}") is ambiguous: ${byAddress.length}+ rows ` +
          `share it (pull-mode duplicate address). Callers must pass ` +
          `deviceFingerprint to identify the row.`,
      );
      return null;
    }
    return byAddress[0] ?? null;
  }

  /**
   * ARCH-33（ADR-016）+ ADR-017 阶段 3 复查补口：解析一次「中台→执行器」控制面
   * 调用的传输方式。
   *
   * 这是所有控制面调用点（deploy / app-stop / app-uninstall / config-reload /
   * kill / update-package）的**唯一分流出口**。判定顺序：
   *
   *   1. 能定位到执行器行（按 id 优先，回退 address）——定位不到就没有
   *      dispatchMode/protocolVersion 可判，回退 push（存量行为）；
   *   2. `dispatchMode === 'pull'`——push 执行器照旧走 HTTP；
   *   3. `supportsControlPlane(protocolVersion)`——协议 < 2 的 pull 执行器会
   *      忽略 commands 字段，回退 push（失败可见，优于静默丢操作）。
   *
   * 返回 `executor` 便于调用方复用（避免二次查库）。
   */
  async resolveExecutorTransport(opts: {
    executorId?: string | null;
    address?: string | null;
  }): Promise<ExecutorTransport> {
    try {
      let executor: Executor | null = null;
      if (opts.executorId) {
        executor = await this.repo.findOne({ where: { id: opts.executorId } });
        if (!executor) {
          // P0-3（生产实证 2026-10-22）：**执行器行 id 悬空时绝不回退 push**。
          //
          // app_deployments.executorId 是普通可空列（无外键），执行器行被删除
          // 后它就是悬空 id；旧实现在这里静默 return { mode: "push" }，调用方
          // 于是拿**快照地址**打 HTTP 出站——现场是 198.18.0.1:8002（Clash TUN
          // 伪 IP / NAT 内网，全 pull 机队下永不可达），3 × 30s 超时后 FAILED，
          // 用户侧看到的就是「部署装不上」+ 后续 409 在途锁。
          // 悬空 id 是**确定性的**不可达：应当秒级失败并给出可操作提示，而不是
          // 打一个已知陈旧/不可达的地址等 90 秒。
          this.logger.warn(
            `Executor row ${opts.executorId} no longer exists — refusing to fall back to ` +
              `push for this control-plane call (a dangling row id would target a stale, ` +
              `possibly unreachable snapshot address). Re-select an executor and retry.`,
          );
          return {
            mode: "unresolved",
            executor: null,
            reason: "executor-row-missing",
          };
        }
      } else if (opts.address) {
        executor = await this.repo.findOne({
          where: { address: opts.address },
        });
      }
      // 只有地址可用时定位不到行 = 存量行为（push 执行器从未注册过也能被
      // 直接寻址），保持 push 回落；这**不是**悬空行身份。
      if (!executor) return { mode: "push", executor: null };
      if (executor.dispatchMode !== "pull") {
        return { mode: "push", executor };
      }
      if (!supportsControlPlane(executor.protocolVersion)) {
        // 可见的降级：pull 执行器但协议太旧。回退 push 后对 NAT 地址必然
        // 超时——但那是一条调用方**看得见**的失败，且与升级前行为一致；
        // 静默把命令丢进一个执行器不认识的字段才是真正的事故。
        this.logger.warn(
          `Executor ${executor.address} is pull-mode but reports protocolVersion=${executor.protocolVersion ?? "unset"} ` +
            `(< ${PROTOCOL_CONTROL_PLANE_MIN}); falling back to push for this control-plane call — ` +
            `upgrade the executor to enable the pull command channel`,
        );
        return { mode: "push", executor };
      }
      return { mode: "pull", executor };
    } catch (err) {
      this.logger.warn(
        `Transport resolution failed for executor ` +
          `${opts.executorId ?? opts.address ?? "(none)"}: ` +
          `${err instanceof Error ? err.message : String(err)} — falling back to push`,
      );
      return { mode: "push", executor: null };
    }
  }

  /**
   * ARCH-33（ADR-016）：把一条控制面命令投进执行器的 pull 命令队列。
   *
   * 返回 commandId（结果上报与排障的关联键）。抛错表示**未投递**——调用方
   * 据此决定回退 push 还是按既有失败路径处理（绝不静默吞掉）。
   */
  async enqueueExecutorCommand(
    executorId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    if (!this.pullService) {
      throw new AppError("EXECUTOR_PULL_UNAVAILABLE");
    }
    const commandId = await this.pullService.enqueueCommand(
      executorId,
      type,
      payload,
    );
    this.logger.log(
      `Queued control command ${type} (${commandId}) for pull executor ${executorId}`,
    );
    return commandId;
  }

  /**
   * ARCH-33（ADR-016）：命令下发的**统一入口**——按传输方式分流。
   *
   * push：调用方自行发 HTTP（各调用点的 URL/超时/载荷各不相同，收敛到此
   *       只会造出一个巨型 switch）。
   * pull：入队并返回 commandId；入队失败**回退 push**（Redis 抖动时宁可
   *       试一次 HTTP，也不要把操作丢掉）。
   *
   * 返回 `delivered: 'pull'` 表示已入队（**不等于已执行**——执行器异步取件
   * 后本地执行，终态由各自的回调通道收敛，见 ADR-016「语义边界」）。
   */
  async deliverControlCommand(opts: {
    executorId?: string | null;
    address: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<{
    /**
     * - `pull`：已入队（不等于已执行，终态由回调通道收敛）。
     * - `push`：请调用方自行发 HTTP。
     * - `unresolved`：**目标行已不存在**，调用方必须按失败处理（不得 push）。
     */
    delivered: "push" | "pull" | "unresolved";
    commandId?: string;
    /** `delivered === 'unresolved'` 时的稳定原因码。 */
    reason?: "executor-row-missing";
  }> {
    const transport = await this.resolveExecutorTransport({
      executorId: opts.executorId,
      address: opts.address,
    });
    if (transport.mode === "unresolved") {
      // 直通「解析不到」——不回退 push（见 resolveExecutorTransport 的 P0-3 注释）。
      return { delivered: "unresolved", reason: transport.reason };
    }
    const { mode, executor } = transport;
    if (mode !== "pull" || !executor) return { delivered: "push" };
    try {
      const commandId = await this.enqueueExecutorCommand(
        executor.id,
        opts.type,
        opts.payload,
      );
      return { delivered: "pull", commandId };
    } catch (err) {
      this.logger.warn(
        `Failed to queue ${opts.type} for pull executor ${executor.address}: ` +
          `${err instanceof Error ? err.message : String(err)} — falling back to push`,
      );
      return { delivered: "push" };
    }
  }

  async register(data: {
    appName: string;
    address: string;
    type?: string;
    version?: string;
    capabilities?: string[];
    runtime?: string[];
    maxConcurrentTasks?: number;
    maxConcurrent?: number;
    groupName?: string | null;
    tags?: string[] | null;
    description?: string | null;
    restartedAt?: string | Date | null;
    startupId?: string | null;
    dispatchMode?: string;
    // PROTOCOL-VER（B-3/U-2）：协议版本（可选整数；缺省 → 不动 DB）。
    protocolVersion?: number | null;
    // ARCH-36（ADR-017 阶段 2/3）：稳定设备指纹（可选；缺省/非法 → 不动 DB）。
    // 阶段 3 起它是本方法的**行定位键**（指纹优先，address 兜底）——命中即复用
    // 原行并更新 address；未上报的 legacy 执行器由服务端落 legacy 兜底键，
    // 行为与引入前逐字节一致（详见方法内「身份解析」段的注释）。
    deviceFingerprint?: string | null;
    // python_task_multiversion（WS2 · CONTRACT §2.3）：解释器缓存池清单。
    // 缺省 → 不动 DB；结构非法 → 拒绝采纳 + warn；合法（含 []）→ 覆盖。
    interpreters?: ExecutorInterpreter[] | null;
    // R3-A（部署模型评审 §4.3）：设备级应用版本事实。缺省 → 完全不动
    // executor_app_versions 既有行（旧执行器零影响）；结构非法 → 整字段拒绝
    // + warn；合法（含 [] = 设备无已部署应用）→ 整替该执行器全部行
    // （applyReportedAppVersions）。
    deployedApps?: DeployedAppReport[] | null;
    // R3-A（§4.3/P10）：已安装执行器包清单（三态语义同 interpreters）。
    installedPackages?: InstalledPackageReport[] | null;
  }) {
    // E-1（2026-10-26 执行器域审计）：接管路径的 **CAS 谓词参数**——方法级局部
    // 变量，跨「判定（foreignInstall 接管分支）→ 尾部 update」两段传递。
    //
    // 为什么必须是局部变量而非实例字段：register 全程含多个 await（findOne/
    // observeAddressConflict 等），两个并发 register 会交错执行——实例字段会让
    // 请求 B 的装填覆盖请求 A 尚未消费的谓词（串值 = 错误的 CAS 或误伤普通
    // 注册）。局部变量天然按调用帧隔离，无清理/泄漏问题（中途 409 的 throw
    // 路径也无需兜底清空）。
    //
    // 装填点：foreignInstall 接管分支（见该处注释，含 CAS 形态取舍）。消费点：
    // 尾部 repo.update（常规注册走裸 id update，行为逐字节不变）。
    let takeoverCasRowId: string | null = null;
    let takeoverCasHeartbeat: Date | null = null;
    // E-4（2026-10-26 执行器域审计）：身份键入站校验——先于一切 DB 读/写与
    // 身份解析路径（issueToken 复用本方法同样被覆盖）。非法 → 400
    // EXECUTOR_REGISTER_FIELD_INVALID（错误码注释里有「为什么不用逐字段拆码」
    // 的理由）。appName 必填缺失在此拒绝（appName 是行的身份列；controller
    // /token 端点的 "executor" 兜底值本身合法，不触发本闸）。
    if (!data.appName || !data.appName.trim()) {
      throw new AppError("EXECUTOR_REGISTER_FIELD_INVALID", {
        field: "appName",
        reason: "必填（不能为空白）",
      });
    }
    const invalidField = validateRegisterIdentityFields(data);
    if (invalidField) {
      throw new AppError("EXECUTOR_REGISTER_FIELD_INVALID", invalidField);
    }
    // ADR-017 阶段 3：身份解析——**指纹优先**（跨重启稳定的安装身份），
    // `address` 兜底（legacy 执行器/采集失败）。命中指纹行即**复用原行**并
    // 更新其 `address`：执行器换 IP = 同一台机器换地址，不产生「新设备幽灵行」，
    // 部署/执行历史不断裂（本变更要修的生产故障，ADR-017 §2）。
    //
    // 冲突姿态按派发模式分叉（ADR-017 §4/§5，用户明确要求的 push/pull 区分）：
    // - push（默认，中台主动连执行器）：`address` 是路由面 → 同地址出现**另一份
    //   安装**（不同真实指纹）= 真冲突 → 保留先注册者、后到者 **409**；
    // - pull（执行器主动连中台，零入站）：`address` 只是自报标签、不参与路由 →
    //   两家不同内网的同网段同 IP **必须允许各自成行**（各自独立的历史/部署），
    //   冲突只降级为既有观测告警（warn）。
    const incomingFingerprint = normalizeDeviceFingerprint(
      data.deviceFingerprint,
    );
    const incomingDispatchMode = data.dispatchMode === "pull" ? "pull" : "push";
    const byFingerprint =
      incomingFingerprint !== null
        ? await this.repo.findOne({
            where: { deviceFingerprint: incomingFingerprint },
          })
        : null;
    let e: Executor | null = byFingerprint;
    if (!e) {
      const byAddress = await this.repo.findOne({
        where: { address: data.address },
      });
      if (byAddress) {
        // R32-C5（L1，R32-C4 同族）：地址**不是身份**。ADR-017 §5 允许同址多行
        // （pull 双机同网段同 IP 各自成行 / 存量 legacy 行 + 已升级行 / 迁移前
        // NULL 行），此时只有 deviceFingerprint 能消歧。本次上报**未带指纹**时，
        // 下面的 findOne({ address })（无 ORDER BY ⇒ 首行获胜）就是在猜：
        //  - 首行可能是**别人的行** → 复用并就地改写它的 appName/executorVersion/
        //    capabilities/interpreters/executorStartupId，status 点亮成 ONLINE；
        //  - registerExecutor 随后按同一地址取 prior、判 didRestart 再
        //    rotateToken(executor.id) —— **别人那行的 per-executor 令牌被吊销**，
        //    而本该新建行的这一方拿到的是「绑在别人行上」的新令牌。
        // 落点只由 DB 行序决定、与身份无关（实测翻转行序，受害者从 v3 行换成
        // legacy 行）。故与认证面 resolveExecutorRow、心跳面（R32-C4）**同策
        // fail-closed**：拒绝（409，同码），让执行器升级到协议 v3（上报指纹）或
        // 配唯一的 EXECUTOR_ADDRESS_PUBLIC —— 宁可显式失败被运维看到，也不要
        // 两行互相覆盖身份。
        // pull 为何不「照常新建行」：无指纹时创建分支落下的兜底键恒为
        // legacy:{address}，而 deviceFingerprint 列**不唯一**（地址唯一索引是
        // partial：WHERE dispatchMode='push'），所以 pull 下真能建出第二行——
        // 但那一行**永远无法心跳**：心跳面对「同址多行 + 无指纹」恒 409
        // （R32-C4），且每次重注册都会再造一行（同址行数随注册次数膨胀，
        // 「首行获胜」下派发/历史归属更乱）。即「注册成功、随后永久 409」的死行，
        // 比在注册面显式失败更难被运维发现。
        // 单行地址（引入本改动前的全部现实形态）行为逐字节不变：bounded take:2
        // 只回答「是否不止一行」，不把同址大列表拉回来。
        if (incomingFingerprint === null) {
          const sameAddress = await this.repo.find({
            where: { address: data.address },
            take: 2,
            select: { id: true },
          });
          if (sameAddress.some((row) => row.id !== byAddress.id)) {
            this.logger.warn(
              `Registration from "${data.address}" refused (409): ${sameAddress.length}+ ` +
                `executor rows share this address and the request carried no ` +
                `deviceFingerprint, so the row cannot be identified. Reusing the ` +
                `first row would overwrite another install's identity/metadata and ` +
                `revoke its per-executor token (ADR-017 §5). Upgrade the executor to ` +
                `protocol v3 (reports deviceFingerprint) or give it a unique ` +
                `EXECUTOR_ADDRESS_PUBLIC.`,
            );
            throw new AppError("EXECUTOR_ADDRESS_TAKEN", {
              address: data.address,
            });
          }
        }
        // 同地址 + 不同真实指纹 = 该地址被**另一份安装**占用。
        // legacy 键（存量未升级行）与 NULL（迁移前）恒不算占用——那是存量行被
        // 同机指纹**接管**的升级路径，不是冲突。
        //
        // 判据用 isLegacyExecutorIdentity 显式表达「存量未升级行」，而不是让
        // 读代码的人从 `normalize(...) === null` 反推语义。storedReal 为 null
        // 只可能来自 legacy 键或 NULL 两种形态，故先排除 legacy 再比较即可。
        const storedReal = normalizeDeviceFingerprint(
          byAddress.deviceFingerprint,
        );
        const foreignInstall =
          incomingFingerprint !== null &&
          storedReal !== null &&
          storedReal !== incomingFingerprint;
        if (foreignInstall) {
          if (incomingDispatchMode === "push") {
            // P1-A（2026-10-25 真机审计）：容器化执行器**重建**（而非重启）后
            // 安装身份会漂移——指纹盐落 `<workDir>/.device-identity/`（不落卷
            // 即随容器层消失）、容器 MAC 每次创建随机 ⇒ deviceId 兜底也变。
            // 新指纹按地址找回来的旧行还是**真实旧指纹** ⇒ 本分支恒 409，
            // 执行器永远拿不回自己的行：register / token（issueToken 复用
            // register）双路全 409（真机实证单台 789 次 fetchToken failed），
            // 部署心跳 X-Executor-Token 恒 401，部署行永久在途、stop/删除
            // 全 409——整条部署链死锁。「地址是路由面」的冲突保护对**活着**
            // 的安装才有意义：占位行已被 sweep 判死（OFFLINE）且静默超过
            // 接管窗（canTakeOverAbandonedAddressRow）⇒ 视为前一轮安装已把
            // 地址**遗弃**，允许接管——复用该行，下方重注册路径把指纹/
            // 元数据/在线态一并刷新（与「存量 legacy 行被同机指纹接管」同一
            // 方向，只是入口从 legacy 键换成已判死的真实指纹行）。判活行
            // （ONLINE，或 OFFLINE 但静默未超窗）维持 409：双活安装争抢同一
            // push 地址仍是真冲突，宁可显式失败被运维看到。
            if (!this.canTakeOverAbandonedAddressRow(byAddress)) {
              throw new AppError("EXECUTOR_ADDRESS_TAKEN", {
                address: data.address,
              });
            }
            this.logger.warn(
              `Registration from "${data.address}" (fingerprint ${incomingFingerprint?.slice(0, 12)}…)` +
                ` takes over the abandoned row ${byAddress.id} (fingerprint ${String(
                  byAddress.deviceFingerprint,
                ).slice(
                  0,
                  12,
                )}…, OFFLINE and silent beyond the takeover window): ` +
                `the push address is treated as relinquished by its dead occupant ` +
                `(executor reinstall/container recreation changed the install identity).`,
            );
            // E-1（2026-10-26 执行器域审计）：接管是「读 OFFLINE 快照 → 复用行
            // → 尾部 repo.update({id}, patch)」的跨 await 写法，判定与写库之间
            // 存在窗口——两执行器同地址同时通过判定（都读到同一 OFFLINE 快照）
            // 时会先后 update 同一行，后写者覆盖 deviceFingerprint 与身份列，
            // 先写者持有被覆盖行的明文令牌 → 401 死循环（与 P1-A 修的 789 次
            // fetchToken failed 同形）。尾部 update 的「不加 CAS」论证
            // （R55-A1 注释）只覆盖 register 自身的覆盖式上报语义；接管的安全性
            // 却**完全建立在**「判定时刻 status=OFFLINE」这一前置之上，故写库
            // 必须复核该前置。
            //
            // CAS 形态取舍：谓词只钉 `status = OFFLINE`（markOffline/setOfflineById
            // 的 lastHeartbeat-CAS 先例在此**不可用**——接管判定基准是
            // `lastHeartbeat ?? updatedAt ?? createdAt` 三级回退，把「判定时读到的
            // lastHeartbeat」钉进谓词会误杀基准来自 updatedAt/createdAt 的合法
            // 接管；lastHeartbeat 为 NULL 的行其谓词又退化成 IS NULL 语义，正中
            // 「可空列谓词不稳」的坑）。status 单列即完备：任何会推翻接管判定的
            // 并发写者（并发注册/心跳点亮 ONLINE、管理员 setOfflineById 之外的状态
            // 迁移）都必然把 status 写成非 OFFLINE，谓词即失配；stale sweep 重写
            // OFFLINE 不改变谓词（幂等，不干扰）。失配 → update affected=0 →
            // 下方按既有 409 收口（让位给并发赢家），绝不静默吞掉。
            //
            // lastHeartbeat 快照仅用于失配时的诊断日志（见尾部 CAS 段）。
            takeoverCasRowId = byAddress.id;
            takeoverCasHeartbeat = byAddress.lastHeartbeat ?? null;
            // E-2（2026-10-26 执行器域审计）：接管语义 = 设备换魂。占位行的
            // runningTaskCount 是**旧进程**的容量占用；接管方若未携带重启信号
            // （restartedAt/startupId 缺失，或与旧行 startupId 恰好一致——模板化
            // 启动参数会出现），didRestart/shouldRecoverMissingBaseline 都判假，
            // 下方 ：2444 起的两个清零分支都不进 → 幻影计数残留到首个心跳
            // （≤30s）。期间派发闸 `runningTaskCount < max` 被幻影压容量（极端
            // 情况 0/0 型执行被永久排除）。与 didRestart 分支（R-P0-008）同语义：
            // 旧安装的槽位占用随「设备换魂」一并清零；真实并发占用由接管方
            // 心跳的真实上报值覆盖（心跳白名单对计数列覆盖写）。
            byAddress.runningTaskCount = 0;
            e = byAddress;
          } else {
            // pull：不拒注册——下走创建分支，建**独立行**（同地址允许重复）。
          }
        } else if (
          incomingFingerprint !== null &&
          storedReal === null &&
          (await this.hasOtherAddressRow(data.address, byAddress.id))
        ) {
          // R32-C6（C5 遗留①）：**升级接管只在无歧义时成立**。
          //
          // 上面 foreignInstall 把「存量 legacy 键 / 迁移前 NULL」判为"不算占用"，
          // 于是 condition 落到 else 分支直接 e = byAddress —— 语义是"这台机器
          // 升级上来了，接管自己那行老行"。单个地址只有一行时这个假设成立。
          // 但 ADR-017 §5 允许同址多行（pull 双机同网段同 IP 各自成行；存量
          // legacy 行与已升级行并存），此时 byAddress 只是**首行**：若它是
          // **另一份安装**的 legacy 墓碑行，接管就是把别人的行改写成自己
          // （appName/version/capabilities/startupId 全被覆盖、status 点亮
          // ONLINE、随后 rotateToken 吊销对方的 per-executor 令牌）——与 C5 修的
          // 无指纹形态同一后果，只是入口从「无指纹」换成「有真实指纹但首行是
          // legacy 行」。地址在这一步仍然不构成身份，故不能猜：
          //   · push（地址是路由面、地址唯一）→ 409，与 C5 / resolveExecutorRow
          //     同策（这台机器无法在该地址上成为唯一 push 行）；
          //   · pull（地址只是自报标签）→ 不接管，落下去**新建独立行**（它的
          //     指纹是真实的，新行可正常心跳，不像 C5 那个 legacy 键死行）。
          if (incomingDispatchMode === "push") {
            this.logger.warn(
              `Registration from "${data.address}" refused (409): the first row at this ` +
                `address is a legacy/NULL-fingerprint row while "${data.address}" also has ` +
                `other rows, so "adopt the legacy row" cannot be distinguished from ` +
                `"take over another install's row". Give this install a unique ` +
                `EXECUTOR_ADDRESS_PUBLIC.`,
            );
            throw new AppError("EXECUTOR_ADDRESS_TAKEN", {
              address: data.address,
            });
          }
          this.logger.warn(
            `Registration from "${data.address}" did not adopt the legacy row: ` +
              `${data.address} has other rows and the first row is legacy/NULL, so adoption ` +
              `is ambiguous. Creating a separate row for this install (R32-C6).`,
          );
          // 不赋 e → 走创建分支建独立行（pull 允许同址重复）。
        } else {
          // 同安装（同指纹）/ 存量 legacy 行且地址无歧义（升级接管）/ 无指纹
          // 存量行（迁移前 NULL）→ 复用该行。
          e = byAddress;
        }
      }
    }
    const isFirstTime = !e;
    const capabilities = data.capabilities ?? data.runtime;
    // N-09 微基准暴露的注册/心跳**采纳域不对称**（本轮净新发现）：
    // 心跳路径经 isAdoptableMaxConcurrentTasks 钳到正整数 1..10000（其注释写明
    // "防止执行器经心跳写入荒谬容量饿死派发闸门"），而 **register 路径此前零校验**
    // ——DTO 上 maxConcurrentTasks 连 @IsInt/@Min 都没有，服务层也直接落库。
    // 后果（实测链路）：`maxConcurrentTasks: 0` 落库后，
    //   ① `computeExecutorLoadScore` 的 `runningTaskCount / max` = 0/0 → **Infinity**
    //      （评分面被污染，同分排序失去意义）；
    //   ② 更严重的是 selectLeastLoaded 的容量闸 `runningTaskCount < max`
    //      → `0 < 0` 恒 false，**该执行器被永久排除在派发之外**（"注册成功、永远
    //      收不到一个任务"，与 P0-2 的 bindAddress 事故同型：绿灯但不干活）。
    // 故与心跳同口径：非法值视同**未上报**（不写 DB、保留既有值/列默认），
    // 而不是静默钳成某个值——执行器自报面不可信，猜它"想报几"比不采纳更危险。
    const rawMaxConcurrent = data.maxConcurrentTasks ?? data.maxConcurrent;
    let maxConcurrentTasks: number | undefined;
    if (rawMaxConcurrent !== undefined) {
      if (ExecutorService.isAdoptableMaxConcurrentTasks(rawMaxConcurrent)) {
        maxConcurrentTasks = rawMaxConcurrent;
      } else {
        this.logger.warn(
          `Executor ${data.address} registered invalid maxConcurrentTasks=${String(
            rawMaxConcurrent,
          )} (expected integer in 1..10000); treating as not reported`,
        );
      }
    }
    const incomingStartedAt = this.parseExecutorStartedAt(data.restartedAt);
    const incomingStartupId = data.startupId?.trim() || null;
    // ARCH-34 P0：address 冲突观测（register 入口）。必须在任何 DB 写入**之前**
    // 调用——register 会就地改写被共享行的 appName/capabilities/startupId，冲突
    // 的原始形态（两个进程生命并存）只有在此刻还能完整观察到。
    // fail-open：观测失败绝不影响注册（见 observeAddressConflict 头注）。
    this.observeAddressConflict(data.address, incomingStartupId, "register");
    // ARCH-36（ADR-017 阶段 2）：设备指纹冲突/漂移观测（register 入口）。
    // 与上一行同理必须在任何 DB 写入**之前**——冲突的原始形态（该地址上曾出现
    // 过哪些安装）与会话内已写入的 deviceFingerprint 无关，但"本次上报是否新增
    // 了一个指纹"这个事件只在本次上报时可见。
    // 规范化已在身份解析处完成（上方 const incomingFingerprint），此处直接观测。
    // 阶段 3 复查补口：同上，必须带上行身份与派发模式。register 是**新行**的
    // 诞生处（e 可能为 null，此时用本次上报的 dispatchMode），也是 pull 模式
    // 「同址建第二行」的裁决点——判据与裁决必须用同一套行语义。
    this.observeDeviceFingerprint(
      data.address,
      incomingFingerprint,
      "register",
      {
        rowId: e?.id ?? null,
        dispatchMode: e?.dispatchMode ?? incomingDispatchMode,
      },
    );
    const hasStartupBaseline = Boolean(
      e?.executorStartupId || e?.executorStartedAt,
    );
    const didRestart = e
      ? this.hasExecutorRestarted(e, incomingStartedAt, incomingStartupId)
      : false;
    const shouldRecoverMissingBaseline = Boolean(
      e && !didRestart && !hasStartupBaseline && incomingStartedAt,
    );
    // python_task_multiversion（WS2 · CONTRACT §2.2/§2.3）：注册面采纳
    // `interpreters`，规则与 heartbeat 的 deadLetterCount 完全一致——
    // 字段缺省（未发送）→ 不动 DB 值（**关键**：旧执行器的重注册不得把已
    // 上报的清单擦掉）；存在但结构非法 → 整字段拒绝采纳 + warn，DB 保留旧值；
    // 合法（**含 []**，"已上报且池空"）→ 覆盖。
    const interpretersReported = data.interpreters !== undefined;
    const normalizedInterpreters = interpretersReported
      ? normalizeInterpreters(data.interpreters)
      : null;
    if (interpretersReported && normalizedInterpreters === null) {
      this.logger.warn(
        `Executor ${data.address} reported an invalid interpreters payload ` +
          `(expected an array of { version: "X.Y" | "X.Y.Z" }); keeping stored value`,
      );
    }
    // R3-A（§4.3）：deployedApps / installedPackages 三态校验（deployed-apps.util.ts）。
    // 与 interpreters 同一纪律：缺省 → 不动 DB（旧执行器重注册不得把已上报的
    // 事实擦掉）；结构非法 → 整字段拒绝采纳 + warn（deployedApps 是全量快照，
    // 半采纳会让「整替」语义失真——宁可不采纳也不写错事实）。
    const installedPackagesReported = data.installedPackages !== undefined;
    const normalizedInstalledPackages = installedPackagesReported
      ? normalizeInstalledPackages(data.installedPackages)
      : null;
    if (installedPackagesReported && normalizedInstalledPackages === null) {
      this.logger.warn(
        `Executor ${data.address} reported an invalid installedPackages payload ` +
          `(expected an array of { name, type, version }); keeping stored value`,
      );
    }
    const deployedAppsReported = data.deployedApps !== undefined;
    const normalizedDeployedApps = deployedAppsReported
      ? normalizeDeployedApps(data.deployedApps)
      : null;
    if (deployedAppsReported && normalizedDeployedApps === null) {
      this.logger.warn(
        `Executor ${data.address} reported an invalid deployedApps payload ` +
          `(expected an array of { appId, currentVersion, retainedVersions, ... }, ` +
          `<=${MAX_DEPLOYED_APPS} items); keeping stored executor_app_versions rows`,
      );
    }
    if (!e) {
      // F-7: create the entity from an explicit field whitelist — never pass
      // caller-controlled data through repo.create(). A raw spread would let
      // a client supply `id` (hijacking an existing row via save()'s
      // update-on-pk semantics), `tokenHash` (auth backdoor), `status`,
      // `runningTaskCount` (scheduling manipulation) or the optimistic-lock
      // `version`. Server-owned columns are only ever written by
      // rotateToken()/the service itself.
      e = this.repo.create({
        appName: data.appName,
        address: data.address,
        type: data.type as ExecutorType,
        executorVersion: data.version,
        capabilities: capabilities,
        maxConcurrentTasks: maxConcurrentTasks,
        groupName: data.groupName,
        tags: data.tags,
        description: data.description,
        executorStartedAt: incomingStartedAt ?? undefined,
        executorStartupId: incomingStartupId ?? undefined,
        // ARCH-32: 派发模式（ADR-015）——仅接受 'pull'；缺省/非法 → undefined
        // → 列默认 'push'。执行器自报面不可信，枚举外值一律落回 push。
        dispatchMode: data.dispatchMode === "pull" ? "pull" : undefined,
        // PROTOCOL-VER（B-3/U-2）：首注册即上报则落列；缺省/非法 → undefined
        // → 列保持 NULL（= 未上报，按 protocolVersion=1 兜底）。
        protocolVersion:
          typeof data.protocolVersion === "number" &&
          Number.isInteger(data.protocolVersion)
            ? data.protocolVersion
            : undefined,
        // ADR-017 阶段 3：首注册的身份键——上报指纹则落真实指纹；未上报
        // （legacy 执行器/采集失败）则由**服务端生成** `legacy:{address}` 兜底
        // 键（列 NOT NULL；执行器永不收到该值）。legacy 行仍按 address 定位，
        // 行为与阶段 2 前逐字节一致（ADR-017 §6「兼容性红线」）。
        deviceFingerprint:
          incomingFingerprint ?? legacyExecutorIdentity(data.address),
        // python_task_multiversion：首注册即上报则落列；缺省/非法 → undefined
        // → 列保持 NULL（= 未上报，调度按 ["3.12"] 兜底）。
        interpreters: normalizedInterpreters ?? undefined,
        // R3-A（§4.3/P10）：已安装包清单首注册即上报则落列；缺省/非法 →
        // undefined → 列保持 NULL（= 未上报，与 interpreters 同款三态）。
        installedPackages: normalizedInstalledPackages ?? undefined,
        status: ExecutorStatus.ONLINE,
        lastHeartbeat: new Date(),
      } as Partial<Executor>);
      // A-10（执行器域审计 P3）：上面的「按身份 findOne → 无行则 insert」是
      // check-then-act——同身份并发首注册时败者的 save 撞唯一索引（23505）。
      // 处理分两种（ADR-017 §4 姿态，与身份解析同判据）：
      // - 同安装竞态（同指纹/legacy 对 legacy）：唯一冲突 → 按地址重读，把本次
      //   上报并入赢家的行走下方既有重注册分支（良性竞态收敛为一次普通重注册）；
      // - **push 模式 + 赢家是另一份安装（不同真实指纹）**：保留赢家、**409**
      //   （与上方 foreignInstall 分支同口径——并发竞态不能绕过冲突姿态）。
      // 非 23505、或重读仍无行（赢家刚被删除等罕见竞态）→ 按原错误失败。
      try {
        const saved = await this.repo.save(e);
        // R3-A（§4.3）：首注册携带 deployedApps → 落事实行（best-effort，
        // 失败不阻断注册主链——下一次心跳会重新上报同一份事实）。
        if (normalizedDeployedApps !== null) {
          await this.applyReportedAppVersions(
            saved.id,
            normalizedDeployedApps,
          ).catch((err: unknown) => {
            this.logger.warn(
              `deployedApps persistence failed for new executor ${data.address}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
        // E-03: send notification on first registration
        if (isFirstTime) {
          this.notificationService
            .notifyExecutorOnline(data.appName, data.address)
            .catch((err) =>
              this.logger.warn(
                `Failed to send executor online notification: ${err?.message}`,
              ),
            );
        }
        return saved;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const winner = await this.repo.findOne({
          where: { address: data.address },
        });
        if (!winner) throw err;
        const winnerReal = normalizeDeviceFingerprint(winner.deviceFingerprint);
        if (
          incomingFingerprint !== null &&
          winnerReal !== null &&
          winnerReal !== incomingFingerprint &&
          incomingDispatchMode === "push"
        ) {
          throw new AppError("EXECUTOR_ADDRESS_TAKEN", {
            address: data.address,
          });
        }
        this.logger.warn(
          `Concurrent first registration lost the unique-address race for ${data.address}; merging this report into the winning row`,
        );
        e = winner;
      }
    }
    // R55-A1（ADR-026 规则 4）：重注册的写面 = **register 拥有的列 ∩ 本次实际
    // 采纳的列**（与心跳 R53-A1 同款判据、同款投影 `pickOwnedColumns`）。
    //
    // 此前本方法的尾巴是 `repo.save(e)` 整行回写：e 是方法开头 findOne 读到的
    // 快照，而 save 的"读当前行 → 按列 diff → 只写差异列"会把**别人的列**按快照
    // 写回。最明确的受害者是四个指标列（cpuUsage/memUsage/diskUsage/
    // networkLatency）——它们的主人是心跳，register 连上报口径都没有（DTO 无这些
    // 字段、controller 的 F-7 白名单也不转发），却会把注册那一刻的旧读数盖到窗口
    // 内刚上报的真实读数上（评分公式 computeExecutorLoadScore 直接吃 cpuUsage/
    // memUsage ⇒ 派发被错的负载读数带偏），且 register 不自纠正，会一直错到下一次
    // 心跳。同一缺陷在"本次未上报"的拥有列上同样成立：register 没报 groupName/
    // tags/description 时，管理台刚 PATCH 的值也会被快照回弹。
    //
    // `adopted` = 「本次真的采纳了这一列」的证据集：每个 `e.x = …` 都会同时
    // `adopted.add("x")`，patch 由"白名单 ∩ adopted"投影，故"没上报"的列连键都
    // 不会出现在 patch 里（不是"值恰好相同"，是**根本不写**）。
    const adopted = new Set<RegisterOwnedColumn>();
    // E-2：接管分支已在「设备换魂」处清零幻影计数（见 foreignInstall 接管点
    // 注释）。此处把清零登记进采纳集——若后续 didRestart 判真，其清零分支的
    // `adopted.add("runningTaskCount")` 是幂等重登记，语义不变。
    if (takeoverCasRowId !== null && e) {
      e.runningTaskCount = 0;
      adopted.add("runningTaskCount");
    }
    // ADR-017 阶段 3：地址漂移——同一安装从**新地址**上报（机器换网/换 IP）。
    // 复用行 + 更新 `address`（这正是"换 IP 不再产生幽灵行"的落点）。
    // push 模式不许抢占他人地址（新地址若被另一份安装占用 → 409）；pull 模式
    // 地址只是标签，直接采纳（ADR-017 §5）。创建路径 e.address 已等于上报值，
    // 不会进本分支。
    // recoveryAddress：漂移前地址——重启恢复按它找 RUNNING 执行记录（漂移前
    // 派发的行都记着旧地址；漂移+重启同刻才需要区分，常态下等于 data.address）。
    let recoveryAddress = data.address;
    if (e.address !== data.address) {
      if (incomingDispatchMode === "push") {
        const owner = await this.repo.findOne({
          where: { address: data.address },
        });
        if (owner && owner.id !== e.id) {
          throw new AppError("EXECUTOR_ADDRESS_TAKEN", {
            address: data.address,
          });
        }
      }
      recoveryAddress = e.address;
      this.logger.log(
        `Executor ${e.id} install ${
          incomingFingerprint?.slice(0, 12) ?? "(legacy)"
        } reported from a new address: ${e.address} → ${data.address} ` +
          `(address drift, same executor; not a new device)`,
      );
      e.address = data.address;
      adopted.add("address");
      // P0-4 附带：让部署域把该行名下的**未终结**部署快照滚到新地址
      // （app_deployments.executorAddress 是快照，否则 push 回退/UI 都停在旧地址）。
      // 落库之后再发（事件 = 已提交的既成事实）；本处与心跳分支同一口径。
      this.emitExecutorAddressDrifted(e, recoveryAddress);
    }
    // Update mutable fields on re-registration (whitelisted per-field only)
    // 每个赋值都同步进 `adopted`：值写进 e（返回体要用），列名证明"本次采纳了
    // 这一列"（patch 只会包含它）。
    if (data.type) {
      e.type = data.type as ExecutorType;
      adopted.add("type");
    }
    if (data.appName) {
      e.appName = data.appName;
      adopted.add("appName");
    }
    if (data.version) {
      e.executorVersion = data.version;
      adopted.add("executorVersion");
    }
    if (capabilities) {
      e.capabilities = capabilities;
      adopted.add("capabilities");
    }
    if (maxConcurrentTasks !== undefined) {
      e.maxConcurrentTasks = maxConcurrentTasks;
      adopted.add("maxConcurrentTasks");
    }
    if (data.groupName !== undefined) {
      e.groupName = data.groupName;
      adopted.add("groupName");
    }
    if (data.tags !== undefined) {
      e.tags = data.tags;
      adopted.add("tags");
    }
    if (data.description !== undefined) {
      e.description = data.description;
      adopted.add("description");
    }
    // ARCH-32: pull↔push 切换随重注册生效（执行器改 EXECUTOR_PULL_MODE 后
    // 重启即触发 didRestart 路径）。
    if (data.dispatchMode === "push" || data.dispatchMode === "pull") {
      e.dispatchMode = data.dispatchMode;
      adopted.add("dispatchMode");
    }
    // python_task_multiversion：重注册采纳（仅在合法上报时覆盖；非法/缺省
    // 均不动 DB —— 非法情形上方已 warn）。
    if (normalizedInterpreters !== null) {
      e.interpreters = normalizedInterpreters;
      adopted.add("interpreters");
    }
    // R3-A（§4.3/P10）：重注册采纳已安装包清单（仅在合法上报时覆盖；含 []
    // =「已上报且没装任何执行器包」；非法/缺省均不动 DB）。
    if (normalizedInstalledPackages !== null) {
      e.installedPackages = normalizedInstalledPackages;
      adopted.add("installedPackages");
    }
    // PROTOCOL-VER（B-3/U-2）：重注册采纳协议版本（仅整数合法值覆盖；
    // 缺省/非法不动 DB，保持未上报/NULL 语义）。
    if (
      typeof data.protocolVersion === "number" &&
      Number.isInteger(data.protocolVersion)
    ) {
      e.protocolVersion = data.protocolVersion;
      adopted.add("protocolVersion");
    }
    // ARCH-36（ADR-017 阶段 2）：重注册采纳设备指纹（仅在规范化成功时覆盖；
    // 缺省/非法均不动 DB——旧执行器或采集失败的执行器不得把已存值擦成 NULL，
    // 与 interpreters 的「缺省即保留」纪律同款）。
    if (incomingFingerprint !== null) {
      e.deviceFingerprint = incomingFingerprint;
      adopted.add("deviceFingerprint");
    }
    if (didRestart) {
      // NETOPT-E P2-1: 同步恢复也传重启基准时刻（只终态化旧行），与心跳
      // didRestart 的异步恢复同语义；计数归零由下方 e.runningTaskCount=0 +
      // save 承担（本函数已不再减槽）。
      // NETOPT-F P2-1 / NETOPT-G P3: startupId-only 重启（无 restartedAt）时
      // resolveRestartBaseline 取**服务端本次心跳处理时刻 now**（DB 旧值只作
      // warn 展示、不参与判定）——旧注释"退回 DB 旧值"是已被否决的零恢复
      // 中间实现，勿改回。
      const baseline = this.resolveRestartBaseline(
        data.address,
        incomingStartedAt,
        incomingStartupId,
        e.executorStartedAt,
      );
      await this.failRunningExecutionsAfterRestart(
        recoveryAddress,
        baseline,
        e.id,
      );
      // R-P0-008: Reset runningTaskCount to 0 after executor restart
      e.runningTaskCount = 0;
      adopted.add("runningTaskCount");
    } else if (shouldRecoverMissingBaseline) {
      await this.failRunningExecutionsAfterRestart(
        recoveryAddress,
        incomingStartedAt,
        e.id,
      );
      // R-P0-008: Reset runningTaskCount to 0 after recovery
      e.runningTaskCount = 0;
      adopted.add("runningTaskCount");
    }
    if (incomingStartedAt) {
      e.executorStartedAt = incomingStartedAt;
      adopted.add("executorStartedAt");
    }
    if (incomingStartupId) {
      e.executorStartupId = incomingStartupId;
      adopted.add("executorStartupId");
    }
    e.status = ExecutorStatus.ONLINE;
    // 遗留 P1-24：恢复在线即清除离线原因标注。
    e.offlineReason = null;
    e.lastHeartbeat = new Date();
    // 这三列无条件写：注册成功 = 这一行此刻在线（与心跳的覆盖式上报同语义）。
    adopted.add("status");
    adopted.add("offlineReason");
    adopted.add("lastHeartbeat");
    // agentCapabilities 是**独立写面**（updateCapabilities 的覆盖写）：它不在
    // REGISTER_OWNED_COLUMNS 里 ⇒ patch 天然不含它（写面已无风险）；这里的 delete
    // 是给**返回体**用的——register 不得在回执里声称一个它没读过、可能已被并发
    // Agent 上报刷新的能力快照（DTO 里这两列因此标注"save() 回程 hydrated"可选）。
    delete (e as Partial<Executor>).agentCapabilities;
    delete (e as Partial<Executor>).agentCapabilitiesUpdatedAt;
    // R55-A1（ADR-026 规则 4）：**整行 save → 列级 patch**，写面 = 白名单 ∩ 采纳集。
    // 这就是本方法不再整行回写的落点：指标列（cpuUsage/memUsage/diskUsage/
    // networkLatency）、Agent 能力列、以及任何不在 REGISTER_OWNED_COLUMNS 里的
    // 列**根本没有进 patch 的路径**（不是"摘掉"，是"投影不出来"——比黑名单更难被
    // 下一次改动绕过：新增一列默认不写，要写必须同时改白名单与 adopted）。
    //
    // 为什么这里**不该**加 CAS 谓词（status / version / lastHeartbeat）：
    // register 是「整体刷新身份/配置」——与心跳同为**覆盖式上报**，last-writer-wins
    // 即正确语义；本 patch 里每一列都由本次上报重新确定（白名单 ∩ 采纳集），没有
    // 一列是"顺手带上的旧值"。若加"读取时刻的状态"谓词：注册被 stale sweep 恰好
    // 置 OFFLINE 的瞬间会 affected=0 ⇒ 本次注册**静默丢失**（配置没刷新、status
    // 没点亮），把"少写别人的列"换成"注册不可靠"，方向相反。
    // adr-026-exempt: 覆盖式上报（身份/配置 + 在线标记），写面 = 白名单 ∩ 采纳集，
    // 无「旧快照盖掉别人新状态」的可能；加 CAS 会变成注册静默丢失（理由见上五行）。
    const patch = this.pickOwnedColumns(e, adopted, REGISTER_OWNED_COLUMNS);
    // E-1：接管路径的 CAS 收口。takeoverCasRowId 只在「本请求走过接管分支」时
    // 非空（局部变量按调用帧隔离，见方法头注释）。常规注册走原有裸 id update，
    // 行为逐字节不变（R55-A1 的「不加 CAS」论证仍然成立）。
    if (takeoverCasRowId !== null) {
      // 谓词 = status 仍 OFFLINE（判定时刻的前置）。失配 = 并发赢家已把行
      // 点亮/改写（判定窗口内另一接管方 update 成功，或并发心跳/注册落地）
      // ——本次接管放弃，按既有 409 让位，**一行都不写**。
      const casResult = await this.repo.update(
        { id: takeoverCasRowId, status: ExecutorStatus.OFFLINE },
        patch,
      );
      if (!casResult.affected) {
        this.logger.warn(
          `Takeover of abandoned row ${takeoverCasRowId} at "${data.address}" lost the ` +
            `race: the row is no longer OFFLINE (a concurrent takeover/registration ` +
            `landed first). Refusing with 409; judgment-time lastHeartbeat was ` +
            `${takeoverCasHeartbeat ? takeoverCasHeartbeat.toISOString() : "null"}.`,
        );
        throw new AppError("EXECUTOR_ADDRESS_TAKEN", { address: data.address });
      }
    } else {
      await this.repo.update({ id: e.id }, patch);
    }
    // R3-A（§4.3）：重注册携带 deployedApps → 落事实行（best-effort 同首注册
    // 分支；键缺失（normalizedDeployedApps === null 含「未上报」与「非法」两态，
    // 后者上方已 warn）→ 完全不动既有行）。
    if (normalizedDeployedApps !== null) {
      await this.applyReportedAppVersions(e.id, normalizedDeployedApps).catch(
        (err: unknown) => {
          this.logger.warn(
            `deployedApps persistence failed for executor ${data.address}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    }
    // 返回值 = 内存实体（已是本次上报后的最终态）叠加 patch —— **不重新 findOne**
    // （与 heartbeat 里 `const saved = { ...e, ...patch }` 同款：多一次往返，且
    // 可能读到别人的并发写，返回体就会描述一个本次 register 没写的状态）。
    return { ...e, ...patch } as Executor;
  }

  /**
   * N4: register + per-executor token issuance in one step, idempotent per
   * (address, startupId). The previous flow rotated the token on EVERY
   * register call — under shared-token auth any duplicate register (e.g. a
   * residual executor process retrying every 30s) invalidated the live
   * executor's per-executor token, producing a rotation storm that made the
   * per-executor token mechanism useless. Rotation now happens only when:
   * - the address has no per-executor token yet (first issuance), or
   * - the registration is NOT provably from the same process life (missing
   *   startupId, a changed startupId, or a newer restartedAt — i.e. a
   *   restart), which includes legacy executors that never report startupId.
   * A same-process re-register returns perExecutorToken=null: the executor
   * keeps the token it already holds (heartbeats still fall back to the
   * shared token if it was lost). Explicit rotation endpoints are unchanged.
   */
  async registerExecutor(data: {
    appName: string;
    address: string;
    type?: string;
    version?: string;
    // PROTOCOL-VER（B-3/U-2）：协议版本（可选整数；低于下限 warn + 兜底）。
    protocolVersion?: number | null;
    capabilities?: string[];
    runtime?: string[];
    maxConcurrentTasks?: number;
    maxConcurrent?: number;
    groupName?: string | null;
    tags?: string[] | null;
    description?: string | null;
    restartedAt?: string | Date | null;
    startupId?: string | null;
    dispatchMode?: string;
    // ADR-017 阶段 3：稳定设备指纹（可选；与 register() 同源采纳规则——缺省/
    // 非法即按 legacy/address 定位。controller 已在 F-7 白名单转发）。
    deviceFingerprint?: string | null;
    interpreters?: ExecutorInterpreter[] | null;
    // R3-A（§4.3）：设备级应用版本事实/已安装包清单（透传 register() 采纳，
    // 语义与心跳完全一致）。
    deployedApps?: DeployedAppReport[] | null;
    installedPackages?: InstalledPackageReport[] | null;
  }): Promise<{ executor: Executor; perExecutorToken: string | null }> {
    // EXE-VER-1: 最低版本门禁。EXECUTOR_MIN_VERSION 非空时，执行器上报的
    // version 低于下限 → 403（报文含下限与升级指引），且发生在任何落库/
    // 发 token 副作用之前。未上报 version 的存量旧执行器放行 + warn（不
    // 锁死存量）；isVersionCompliant 对畸形版本号也放行（NaN 语义）。
    // 门禁关（默认空串）时此块整体短路，行为逐字节不变。
    const minVersion =
      this.configService.get<string>("executor.minVersion") || "";
    if (
      minVersion &&
      data.version &&
      !isVersionCompliant(data.version, minVersion)
    ) {
      throw new AppError("EXECUTOR_VERSION_TOO_LOW", {
        version: data.version,
        minVersion,
      });
    }
    if (minVersion && !data.version) {
      this.logger.warn(
        `Register from ${data.address} did not report a version; EXECUTOR_MIN_VERSION=${minVersion} cannot be enforced for it (legacy executor allowed)`,
      );
    }
    // PROTOCOL-VER（B-3/U-2）：协议版本兼容矩阵分支——低于下限**不拒绝注册**，
    // 只 warn + 按旧协议兜底（与 EXECUTOR_MIN_VERSION 实现版本门禁是两套闸；
    // 兼容性红线见 protocol.json `versioning` 段）。未上报（null/undefined）
    // 的存量旧执行器按基线协议 1 兜底，同样放行。
    if (
      typeof data.protocolVersion === "number" &&
      !isProtocolCompliant(data.protocolVersion, PROTOCOL_SUPPORTED_MIN)
    ) {
      this.logger.warn(
        `Register from ${data.address} reports protocolVersion=${data.protocolVersion}, below the supported minimum ${PROTOCOL_SUPPORTED_MIN}; ` +
          `treating it as the legacy baseline protocol (fields added after it will be omitted/ignored, not rejected)`,
      );
    }
    // Capture the pre-register row: register() overwrites executorStartupId
    // and the row's tokenHash is select:false, so read it explicitly here.
    // ADR-017 阶段 3：与 register() 同源的身份解析——**指纹优先**，address 兜底。
    // 换 IP 的重注册（同指纹）必须能命中旧行，否则 N4 的幂等语义退化（每次
    // 漂移都 rotate 一次 token）；legacy 执行器（无指纹）仍按 address 定位。
    const priorFingerprint = normalizeDeviceFingerprint(data.deviceFingerprint);
    let prior: Executor | null = null;
    if (priorFingerprint) {
      prior = await this.repo
        .createQueryBuilder("e")
        .addSelect("e.tokenHash")
        .where("e.deviceFingerprint = :fp", { fp: priorFingerprint })
        .getOne();
    }
    if (!prior) {
      prior = await this.repo
        .createQueryBuilder("e")
        .addSelect("e.tokenHash")
        .where("e.address = :address", { address: data.address })
        .getOne();
    }
    const executor = await this.register(data);
    const incomingStartedAt = this.parseExecutorStartedAt(data.restartedAt);
    const incomingStartupId = data.startupId?.trim() || null;
    const didRestart = prior
      ? this.hasExecutorRestarted(prior, incomingStartedAt, incomingStartupId)
      : false;
    const sameProcess =
      !didRestart &&
      Boolean(prior?.tokenHash) &&
      Boolean(incomingStartupId) &&
      prior?.executorStartupId === incomingStartupId;

    const perExecutorToken =
      prior?.tokenHash && sameProcess
        ? null
        : await this.issueTokenForDuplicateRegister(
            executor,
            incomingStartupId,
          );
    if (perExecutorToken === null) {
      this.logger.debug(
        `Idempotent re-register for executor ${executor.id} (${data.address}); keeping existing per-executor token`,
      );
    }
    return { executor, perExecutorToken };
  }

  /**
   * P0-5（生产报告 2026-10-22 §4.7）：**同一行的重复注册不得二次轮换令牌**。
   *
   * 现场（10:26:51 / 10:26:53，同一行 c55615af）：1.5 秒内两次 `rotate_token`，
   * 紧接着该执行器连续 20 次 `POST /executors/pull` → 401（每次间隔 1s），
   * 直到之后一次重注册才恢复——20 秒的取件真空期，比地址告警更接近「部署
   * 偶发装不上」的第二条真实成因。
   *
   * 机理：register 的 N4 幂等判据是**无状态**的
   * （`prior.executorStartupId === incomingStartupId`），而同一进程生命内
   * **并发两次 register**（启动 + 配置触发/重试）读到的 prior 是**改写前**的
   * 快照 ⇒ 两次都判 sameProcess=false ⇒ 两次轮换。两次轮换的明文若乱序返回，
   * 执行器最终保存的可能是**已作废**的那一份 → 401 直到重新注册。
   *
   * 修法与 `POST /executors/token`（issueToken）同源：缓存键 = 定位身份
   * （指纹优先），命中「同 startupId + 明文仍与库中哈希匹配」时**复用明文、
   * 不再轮换**。bcrypt 复核是必须的——它保证管理员在 UI 上轮换过的令牌
   * **不会**被这条路径复活（R10 的既有语义）。
   *
   * 与 N4 的分工：N4 是「无状态判据」（能覆盖串行重注册），本方法是「有状态
   * 兜底」（覆盖并发窗口里 N4 看不到的那一次轮换）。两者都不轮换时才真正轮换。
   */
  private async issueTokenForDuplicateRegister(
    executor: Executor,
    incomingStartupId: string | null,
  ): Promise<string> {
    if (incomingStartupId !== null) {
      const identityKey = this.tokenCacheIdentityKey(
        executor.address,
        executor.deviceFingerprint,
      );
      const cached = this.issuedTokenCache.get(identityKey);
      if (
        cached &&
        cached.startupId === incomingStartupId &&
        Date.now() - cached.issuedAt < ExecutorService.TOKEN_ISSUE_CACHE_TTL_MS
      ) {
        const stored = await this.getCallbackSecretById(executor.id);
        if (stored && (await bcrypt.compare(cached.token, stored))) {
          this.logger.log(
            `Reused per-executor token for executor ${executor.id} (${executor.address}) — ` +
              `duplicate registration for the same startupId; not rotating again (a second ` +
              `rotation here would 401 the executor that just adopted the first one)`,
          );
          return cached.token;
        }
      }
    }
    return (await this.rotateToken(executor.id)).token;
  }

  /**
   * E9: 心跳采纳 maxConcurrentTasks 的取值域——正整数 1..10000。
   * 越界/非整数/非数字一律视为未上报（不改 DB 值），防止执行器经心跳
   * 写入荒谬容量饿死派发闸门（selectLeastLoaded 以该列判满）。
   */
  private static isAdoptableMaxConcurrentTasks(
    value: unknown,
  ): value is number {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 10_000
    );
  }

  /**
   * U16: 心跳采纳 deadLetterCount 的取值域——非负整数 0..100000。
   * 越界/非整数/非数字一律视为未上报（不改 DB 值），与 maxConcurrentTasks
   * 采纳同模式：执行器上报面不可信，白名单字段必须先过范围校验再落列。
   */
  private static isAdoptableDeadLetterCount(value: unknown): value is number {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 100_000
    );
  }

  /**
   * E-01-RPT: 心跳采纳 `reservedSlots` 的取值域——非负整数 0..MAX_RUNNING_EXECUTION_IDS。
   *
   * 上界与 runningTaskCount 同源（NETOPT-D P2-D2）：reservedSlots 是
   * runningTaskCount 的**子集**，任何超出该上界的值都不可能自洽，越界一律视为
   * 未上报（不改 DB 值），与 maxConcurrentTasks/deadLetterCount 同模式——
   * 执行器上报面不可信，白名单字段必须先过范围校验再落列。
   *
   * 真实上界其实是 maxConcurrentTasks（pull 循环是单飞的，恒为 0/1），但此处
   * 刻意**不**按 maxConcurrentTasks 钳制：该列随心跳热更、且本校验发生在容量
   * 采纳之前，用它做上界会让两个字段的采纳顺序互相影响。真正的自洽性由调用方
   * 的 `reservedSlots <= effectiveRunningCount` 配对校验兜住（那才是硬约束）。
   */
  private static isAdoptableReservedSlots(value: unknown): value is number {
    return (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_RUNNING_EXECUTION_IDS
    );
  }

  /**
   * CONSISTENCY-02: heartbeat ingest for executor-node 上报的 runningExecutionIds。
   * 输入为 executor 可控字段，须严格防御：非数组视为未上报（返回 null）；逐项仅
   * 保留匹配安全字符集 [A-Za-z0-9_-] 的字符串（其余丢弃）；最多裁剪至 10000 项
   * （与 E9 采纳域 maxConcurrentTasks ≤10000 对齐——旧的 200 封顶在并发 >200 时
   * 让第 201+ 个在跑执行从 stale sweep 的 includes() 判据里消失，存活宽限静默
   * 失效，健康长任务被提前恢复成 FAILED）。
   * null 与 [] 语义不同——null = 旧版执行器未上报该字段（见实体注释），[] = 已
   * 上报且当前空闲。
   *
   * 注意：此处字符集 ^[A-Za-z0-9_-]+$ 比执行器侧（executor-node 的 id 生成/
   * 透传面）更窄，是刻意的防御面收窄——executionId 现为 UUID（仅十六进制 +
   * '-'，天然落在该集合内），收窄不损失合法输入，却把心跳可写入的字符串
   * 形态压到最小（防注入控制字符/超长垃圾项）。若未来 executionId 改用其他
   * 格式，须同步复核此集合而不是盲目放宽。
   */
  private sanitizeRunningExecutionIds(
    value: unknown,
    address?: string,
  ): string[] | null {
    if (!Array.isArray(value)) return null;
    // NETOPT-D P3-7: 防御超长垃圾数组的 CPU DoS 面。NETOPT-E P3-1 修订：不做
    // 前置 slice——>2× 上界时先截断会让窗口外合法 id 静默丢失，且 dropped 口径
    // 低估（25000 全合法时报丢 10000、实丢 15000）。改为全量线性遍历：数组在
    // JSON 解析时已物化进内存，正则 ^[A-Za-z0-9_-]+$ 是 O(1)/项，遍历成本由
    // 解析成本主导，不再显著放大 DoS 面；合法项 10000 封顶 + dropped 精确计数。
    const safe: string[] = [];
    let validCount = 0;
    for (const item of value) {
      if (typeof item === "string" && /^[A-Za-z0-9_-]+$/.test(item)) {
        validCount++;
        if (safe.length < MAX_RUNNING_EXECUTION_IDS) {
          safe.push(item);
        }
      }
    }
    // NETOPT-D P2-D2: warn 补 address 与丢弃条数——运维按执行器定位溢出源，
    // 而不是在全仓日志里猜是哪台机器超发。
    // NETOPT-D P3-3: warn 节流——执行器持续超发时每心跳一条会把日志刷成噪
    // 音；同 address 同丢弃量 60s 内只 warn 一次（丢弃量变化立即更新重计时）。
    if (validCount > MAX_RUNNING_EXECUTION_IDS) {
      const dropped = validCount - MAX_RUNNING_EXECUTION_IDS;
      const key = address ?? "?";
      const prev = lastTruncationWarn.get(key);
      const now = Date.now();
      if (
        !prev ||
        prev.dropped !== dropped ||
        now - prev.at > TRUNCATION_WARN_THROTTLE_MS
      ) {
        this.logger.warn(
          `runningExecutionIds exceeded ${MAX_RUNNING_EXECUTION_IDS} (executor=${key}, ${dropped} overflow id(s) dropped); ` +
            `overflow ids lose the stale-sweep survival grace (healthy long tasks may be recovered early)`,
        );
        lastTruncationWarn.set(key, { dropped, at: now });
        if (lastTruncationWarn.size > 100) {
          // 淘汰最旧一条，防 Map 无限膨胀（超发执行器是少数异常）
          let oldest: string | null = null;
          let oldestAt = Infinity;
          for (const [k, v] of lastTruncationWarn) {
            if (v.at < oldestAt) {
              oldestAt = v.at;
              oldest = k;
            }
          }
          if (oldest) lastTruncationWarn.delete(oldest);
        }
      }
    }
    return safe;
  }

  /**
   * python_task_multiversion（WS2 · CONTRACT §3.1）：解释器缓存池过滤——三处
   * 调度站点（`selectLeastLoaded` / `dispatch` / `dispatchBroadcast`）共享同一
   * 实现，杜绝三份漂移（对齐 `executor-score.util` 的抽取先例）。
   *
   * 语义全部由 `interpreter-match.util` 承载（NFR-08：纯内存、O(清单长度)、
   * **零** DB/网络往返）；本方法只做「过滤 + 失败时构造含快照的消息」。
   *
   * 返回 `{ kept, message }`：`message` 非 null 表示过滤后无候选，调用方按各自
   * 既有异常类型抛出（`ServiceUnavailableException` vs `Error` 的语义不变）。
   * `message` 里含**过滤前**每个候选执行器的已缓存解释器快照（AC-09b）。
   *
   * 未声明 `runtimeVersion` 时零过滤（`hasRequestedVersion` 判定）——存量任务
   * 的调度路径逐字节不变（兼容性红线 1）。
   */
  private applyInterpreterFilter(
    executors: Executor[],
    requested: string | null | undefined,
  ): { kept: Executor[]; message: string | null } {
    if (!hasRequestedVersion(requested)) {
      return { kept: executors, message: null };
    }
    const requestedVersion = (requested as string).trim();
    const kept = executors.filter((e) =>
      interpreterSatisfies(e.interpreters, requestedVersion),
    );
    if (kept.length > 0) return { kept, message: null };
    // 在线可下载版本（3.8+，CONTRACT §1.1 ONLINE_DOWNLOAD_MIN）：缓存缺失不拦——
    // 派到任意在线执行器，执行器侧 ensureVersion() 会用 `uv python install` 按需
    // 下载并缓存（执行器已内嵌 uv，见 bundle-executor.sh ACF_UV_REQUIRED=1）。
    // 前端 interpreterFleetAdvisory 对在线层同样只提示不阻断，此处对齐。
    // 仅离线层（3.7，uv 无法在线下载）才硬拦——必须由部署方预填缓存卷。
    if (isOnlineDownloadable(requestedVersion)) {
      return { kept: executors, message: null };
    }
    return {
      kept,
      message: buildInterpreterMismatchMessage(
        requestedVersion,
        executors.map((e) => ({
          appName: e.appName,
          interpreters: e.interpreters,
        })),
      ),
    };
  }

  /**
   * 调度期解释器不可获取的统一落日志 + 抛出。
   *
   * 分因经 `ExecutionFailureReason.INTERPRETER_UNAVAILABLE` 落日志（与消息里的
   * token 同源，CONTRACT §2.5 的"三处同步"之一）：调度阶段只抛错不落库，终态由
   * `task.processor` 的失败路径写，故日志是派发期唯一可检索的留痕。
   */
  private failInterpreterUnavailable(message: string): never {
    this.logger.warn(
      `Dispatch blocked: failureReason=${ExecutionFailureReason.INTERPRETER_UNAVAILABLE} ${message}`,
    );
    throw new AppError("NO_EXECUTOR_INTERPRETER_MISMATCH", {
      detail: message,
    });
  }

  /**
   * R53-A1（ADR-026 规则 4）：把心跳对实体的就地改动**投影**成一份列级 patch。
   *
   * 两个输入缺一不可：
   *  - `e`：已被心跳就地改过的实体（值面）；
   *  - `adopted`：本轮**实际采纳**了哪些列（面）。列不在白名单里 → 不写；
   *    在白名单里但本轮没采纳（没上报 / 上报非法被拒）→ 也不写。
   *
   * 为什么是"白名单 ∩ 采纳集"而不是单纯的白名单：`maxConcurrentTasks` 与
   * `address` 是**双主人**列（管理台 PATCH 也写）。单纯按白名单整批写，会在
   * "本次心跳没上报容量"时把管理台刚改的值按快照写回 —— 缺陷只是变窄，没有消失。
   *
   * 返回类型刻意是 `Partial<Pick<Executor, T>>`（T = 调用方给的白名单字面量
   * 联合）：调用方无法把白名单外的键塞进 patch，编译期即拦住（这是本条修复的
   * **正向**约束，比"删除 x 列"的黑名单更难被下一次改动绕过）。
   *
   * R55-A1：白名单由调用方传入，同一实现服务两个写面——心跳
   * （HEARTBEAT_OWNED_COLUMNS）与 register（REGISTER_OWNED_COLUMNS）。
   * 两份白名单分开维护是刻意的：两个写面的主人边界不同（指标列归心跳、
   * 身份/配置列归 register），共用一个白名单会让"谁拥有哪一列"重新变成
   * 无人负责的隐含假设。
   */
  private pickOwnedColumns<T extends keyof Executor & string>(
    e: Executor,
    adopted: ReadonlySet<T>,
    columns: readonly T[],
  ): Partial<Pick<Executor, T>> {
    const patch: Record<string, unknown> = {};
    for (const column of columns) {
      if (!adopted.has(column)) continue;
      patch[column] = e[column];
    }
    return patch as Partial<Pick<Executor, T>>;
  }

  async heartbeat(
    address: string,
    metrics: {
      cpuUsage?: number;
      memUsage?: number;
      diskUsage?: number;
      networkLatency?: number;
      runningTaskCount?: number;
      totalTaskCount?: number;
      failedTaskCount?: number;
      restartedAt?: string | Date | null;
      startupId?: string | null;
      runningExecutionIds?: string[] | null;
      // E-01-RPT（生产实证：RPA5「当前运行任务 1/10、活性上报 0 条」）：pull
      // 长轮询「已预留但尚未认领」的槽位数。只用于展示/告警换算（实际运行 =
      // runningTaskCount − reservedSlots），**不参与派发闸门**（见实体注释）。
      reservedSlots?: number | null;
      deadLetterCount?: number;
      // E9: 执行器热更新容量上报（可选，正整数 1..10000，非法/缺失不改 DB）
      maxConcurrentTasks?: number;
      // python_task_multiversion（WS2 · CONTRACT §2.3）：解释器缓存池清单。
      // 缺省 → 保留 DB 旧值；结构非法 → 拒绝采纳 + warn；合法（含 []）→ 覆盖。
      interpreters?: ExecutorInterpreter[] | null;
      // ARCH-36（ADR-017 阶段 2）：稳定设备指纹（可选；缺省/非法 → 保留 DB 旧值）。
      deviceFingerprint?: string | null;
      // R3-A（部署模型评审 §4.3）：设备级应用版本事实。缺省 → 完全不动
      // executor_app_versions 既有行（旧执行器零影响，这是兼容性红线）；
      // 结构非法 → 整字段拒绝采纳 + warn；合法（含 []）→ 整替该执行器
      // 全部行（数组外的应用 = 设备已卸载，行删除）。
      deployedApps?: DeployedAppReport[] | null;
      // R3-A（§4.3/P10）：已安装执行器包清单（三态语义同 interpreters）。
      installedPackages?: InstalledPackageReport[] | null;
    },
  ) {
    // ADR-017 阶段 3：身份解析——**指纹优先**（稳定安装身份），`address` 兜底。
    // 指纹路径承担两件注册路径做不了的事：
    //  1) 换 IP 后注册未到（竞态）时，按指纹命中旧行并把 address 补新——心跳
    //     不因「新地址查无此行」抛 NotFound（此前换 IP 即断心跳 → 旧行被 sweep
    //     判死 = 用户看到「旧设备离线」的直接成因）；
    //  2) pull 模式同地址多行并存时，按指纹命中**自己的行**（按地址查会查错行）。
    const incomingFingerprint = normalizeDeviceFingerprint(
      metrics.deviceFingerprint,
    );
    let e: Executor | null = null;
    if (incomingFingerprint) {
      e = await this.repo.findOne({
        where: { deviceFingerprint: incomingFingerprint },
      });
    }
    if (!e) {
      // R32-C4（L1）：地址**不是身份**。ADR-017 §5 明文允许同址多行（pull 模式
      // 两台机器同网段同 IP 各自成行），此时只有 deviceFingerprint 能消歧。
      // 认证面（validateTokenByAddress → resolveExecutorRow）对「同址多行 +
      // 无指纹」早已 fail-closed（返回 null），但**共享令牌兜底**会让这类请求
      // 仍然认证通过、走到这里。若此处继续用 findOne({ address })（无 ORDER BY
      // ⇒ 首行获胜），整行 status / runningTaskCount / cpu / lastHeartbeat 就会
      // 写进**别人那一行**：已下线的旧行被点亮成 ONLINE（派发闸门随后按它的空
      // 槽位派任务），或另一台机器的在跑读数被覆盖（两台互写状态）。
      // 故与认证面同策 fail-closed：拒绝写库，让这台执行器重注册（协议 v3 带
      // 指纹）或配唯一的 EXECUTOR_ADDRESS_PUBLIC —— 宁可让它显式失败被运维看到，
      // 也不要让两台互相覆盖状态。
      // 单行地址（引入本改动前的全部现实形态）行为逐字节不变：先按地址取行，
      // 仅当**同址还存在别的行**时拒绝（bounded take: 2，只要「是否不止一行」）。
      const resolved = await this.repo.findOne({ where: { address } });
      if (!resolved) throw new AppError("EXECUTOR_NOT_FOUND");
      // select 收窄到 id：本探针只需要「是否还有别的行」，不把 ±10000 条的
      // runningExecutionIds 等重列拉回来（心跳是 30s 高频面）。
      const sameAddress = await this.repo.find({
        where: { address },
        take: 2,
        select: { id: true },
      });
      if (sameAddress.some((r) => r.id !== resolved.id)) {
        this.logger.warn(
          `Heartbeat from "${address}" refused (409): ${sameAddress.length}+ ` +
            `executor rows share this address and the request carried no matching ` +
            `deviceFingerprint, so the row cannot be identified. Writing to the ` +
            `first row would overwrite another install's state (ADR-017 §5). ` +
            `Upgrade the executor to protocol v3 (reports deviceFingerprint) or ` +
            `give it a unique EXECUTOR_ADDRESS_PUBLIC.`,
        );
        throw new AppError("EXECUTOR_ADDRESS_TAKEN", { address });
      }
      e = resolved;
    }
    // 重启恢复按**漂移前**地址找 RUNNING 执行记录（`task_executions.
    // executorAddress` 记的是派发当时的地址）。
    //
    // 顺序纪律（与 register() 的 :1613 同源，勿调换）：本赋值必须在下面「采纳
    // 漂移」**之前**执行。放在之后会取到**新**地址，而漂移前派发的 RUNNING 行
    // 记的是**旧**地址 —— 按新地址一条都命中不了，那些行永远不被恢复（正是本
    // ADR 要修的「换 IP 后历史断裂」在重启恢复面上的复现）。常态下
    // e.address === address，取值与引入前逐字节一致。
    const recoveryAddress = e.address;
    // R53-A1：本轮**实际采纳**的列集合。只有登记在这里的列才会进最终 patch ——
    // 未登记的白名单列（更不用说白名单外的列）一个字都不写，因此快照里过期的
    // 旧值不会被 diff 判成"改动"写回。status / offlineReason /
    // consecutiveHeartbeatMisses / lastHeartbeat 是"心跳永远拥有"的四列：
    // 它们每次心跳都必须落库（哪怕值没变），否则并发写者刚落库的
    // status=OFFLINE 不会被本次心跳的 last-writer-wins 语义纠正回来。
    const adopted = new Set<HeartbeatOwnedColumn>([
      "status",
      "offlineReason",
      "consecutiveHeartbeatMisses",
      "lastHeartbeat",
    ]);
    if (e.address !== address) {
      // 漂移前的地址（事件载荷 + 条件更新谓词用）；仅在本次真的采纳了漂移时赋值。
      let previousAddress: string | null = null;
      // 地址漂移：同一安装换网/换 IP（正常现象，ADR-017 §2）。
      // push 不抢占他人地址：目标地址被另一份安装占用 → 保留原地址、仅 warn
      // （心跳是 30s 高频面，409 会打断心跳；注册面才是冲突裁决处）；
      // pull 地址只是标签，直接采纳（ADR-017 §5）。
      if (e.dispatchMode !== "pull") {
        const owner = await this.repo.findOne({ where: { address } });
        if (owner && owner.id !== e.id) {
          this.logger.warn(
            `Heartbeat from ${address} not adopted for executor ${e.id} ` +
              `(install ${incomingFingerprint.slice(0, 12)}…): address occupied ` +
              `by executor ${owner.id}; keeping ${e.address}`,
          );
        } else {
          previousAddress = e.address;
          e.address = address;
          adopted.add("address");
        }
      } else {
        previousAddress = e.address;
        e.address = address;
        adopted.add("address");
      }
      // P0-4 附带：漂移被采纳 → 让部署域把该行名下的未终结部署快照滚到新地址。
      // 与注册面同一口径（事件在落库之后发，订阅方按 previousAddress 做条件更新）。
      if (previousAddress) this.emitExecutorAddressDrifted(e, previousAddress);
    }
    const incomingStartedAt = this.parseExecutorStartedAt(metrics.restartedAt);
    const incomingStartupId = metrics.startupId?.trim() || null;
    // ARCH-34 P0：address 冲突观测（heartbeat 入口，30s 高频）。
    // 这里是冲突的**主要检出点**：两台机器并存时交替注册/心跳，被顶替者的
    // 心跳必然先于下一次注册到达。节流在跟踪器内按 (address, startupId) 收敛，
    // 高频路径不会刷日志/通知（见 CONFLICT_ALERT_THROTTLE_MS）。
    this.observeAddressConflict(address, incomingStartupId, "heartbeat");
    // ARCH-36（ADR-017 阶段 2）：设备指纹冲突/漂移观测（heartbeat 入口）。
    // 心跳是**主要**的重复观测点（register 只在启动与补注册时发生），也是
    // 「同一 address 上两个指纹」最容易先暴露的地方——两台机器并存时它们各自
    // 30s 一次的心跳都会走到这里。
    // 阶段 3 复查补口：把**行身份 + 派发模式**一并交给判据。缺了它们，pull
    // 模式里"同地址各自成行"（ADR-017 §5 明确允许）会被当成地址冲突外发
    // ERROR/通知——生产实证：6 台全 pull 的机队每 10 分钟收到一条毫无意义的
    // 告警。行已由指纹/地址解析（resolveExecutorRow 语义），其 dispatchMode
    // 才是"该地址是不是路由面"的权威来源（心跳载荷不携带该字段）。
    this.observeDeviceFingerprint(address, incomingFingerprint, "heartbeat", {
      rowId: e.id,
      dispatchMode: e.dispatchMode,
    });
    // 结论 H（§4.6）：这台机器**没带可解析指纹**——记一条节流 warn，回答
    // 「刚才那条 fail-closed 是哪台发的」（判定逻辑本身不在这里，见
    // resolveExecutorRow / register 的 fail-closed）。
    if (incomingFingerprint === null) {
      this.warnMissingFingerprintOnce(address, e);
    }
    const hasStartupBaseline = Boolean(
      e.executorStartupId || e.executorStartedAt,
    );
    const didRestart = this.hasExecutorRestarted(
      e,
      incomingStartedAt,
      incomingStartupId,
    );
    const shouldRecoverMissingBaseline = Boolean(
      !didRestart && !hasStartupBaseline && incomingStartedAt,
    );
    const {
      restartedAt: _r,
      startupId: _s,
      runningExecutionIds,
      // E-01-RPT: reservedSlots 不是数值指标列，从 metricValues 中摘出单独走
      // 「与 runningTaskCount 的一致性」采纳（见下方 reservedSlots 段）——
      // 它必须与本次上报的 runningTaskCount 配对校验，不能落进通用白名单环。
      reservedSlots,
      // python_task_multiversion：interpreters 不是数值指标列，从 metricValues
      // 中摘出单独走结构校验（不进 metricsWhitelist 的数值写入环）。
      interpreters,
      // ARCH-36（ADR-017 阶段 2）：deviceFingerprint 不是数值指标列，同样摘出
      // （上方已单独观测过，此处只为不让它落进数值白名单写入环）。
      deviceFingerprint: _f,
      // R3-A（§4.3）：deployedApps/installedPackages 不是数值指标列——
      // deployedApps 落独立表（executor_app_versions，不走 executors 列白名单），
      // installedPackages 走 interpreters 同款的三态列采纳。
      deployedApps,
      installedPackages,
      ...metricValues
    } = metrics;
    if (didRestart) {
      // NETOPT-D P2-3: 重启恢复不阻塞心跳线程——批量 FAILED 落库 + 批量减槽
      // 先行，逐行重试入队异步收敛；恢复中途失败的行由 stale sweep 兜底
      // （R-11 既有收敛路径）。E9 高容量下近万行逐行入队会让单次心跳拖到
      // 全局超时之外、触发 markStaleOffline 误判刚重启的执行器。
      // NETOPT-E P2-1: 异步恢复带 onlyStartedBefore（重启基准时刻）——恢复
      // find 谓词只有 address + RUNNING，无时间过滤时会把恢复期间闸门新派发
      // 的行（startTime >= 重启时刻）一并终态化误杀。传 incomingStartedAt 后
      // shouldFailAfterRestart 只放行 startTime < 重启时刻的旧行。
      // NETOPT-F P2-1 / NETOPT-G P3: startupId-only 重启（无 restartedAt）时
      // resolveRestartBaseline 取**服务端 now**（DB 旧基线仅 warn 展示）——对
      // startTime<now 的旧行终态化、恢复后新派发（startTime>now）存活。旧注释
      // "基线退回 DB 旧值"与实现矛盾，已改正，勿改回零恢复中间形态。
      const baseline = this.resolveRestartBaseline(
        address,
        incomingStartedAt,
        incomingStartupId,
        e.executorStartedAt,
      );
      void this.failRunningExecutionsAfterRestart(
        recoveryAddress,
        baseline,
        e.id,
      ).catch((err: unknown) => {
        this.logger.warn(
          `Restart recovery for ${recoveryAddress} failed asynchronously: ${
            err instanceof Error ? err.message : String(err)
          }. Stale sweep will pick up remaining RUNNING rows.`,
        );
      });
      // NETOPT-E P3-1: 重启分支同样清零内存 runningTaskCount（与 register
      // 分支 :870/:877 对齐）。异步恢复会批量减槽落库，但本心跳后续
      // save(e) 会把内存里的旧高值原样写回——用旧值覆盖恢复结果，派发
      // 闸门 runningTaskCount 虚高、欠派。清零后若本次心跳带真实上报值，
      // 白名单覆盖仍生效（见下方 metricValues 写入环）。
      e.runningTaskCount = 0;
      // E-01-RPT: 预留同样清零——重启后进程内的 pull 循环已消失，重启前的
      // 「预留中」槽位必然不复存在，留着会让 UI 把陈旧预留从新计数里减掉
      // （显示比真值少 1）。若本次心跳带真实上报值，下方采纳段仍会覆盖。
      e.reservedSlots = 0;
      adopted.add("runningTaskCount");
      adopted.add("reservedSlots");
    } else if (shouldRecoverMissingBaseline) {
      await this.failRunningExecutionsAfterRestart(
        recoveryAddress,
        incomingStartedAt,
        e.id,
      );
      // NETOPT-F P2-F2: missing-baseline 分支与 register 同型分支（:908）对称
      // ——异步恢复会批量减槽落库，但本心跳后续 save(e) 会把内存里的旧高值
      // 原样写回，用旧值覆盖恢复结果，闸门 runningTaskCount 虚高、欠派。
      // 清零后若本次心跳带真实上报值，白名单覆盖仍生效。
      e.runningTaskCount = 0;
      // E-01-RPT: 同 didRestart 分支——陈旧预留不得参与新计数的换算。
      e.reservedSlots = 0;
      adopted.add("runningTaskCount");
      adopted.add("reservedSlots");
    }

    // R-P0-006: Use save() without version check for heartbeat to avoid frequent conflicts
    // Heartbeat updates are mostly metrics and don't need strict concurrency control
    //
    // F-2: assign metrics EXPLICITLY — never spread untrusted request fields
    // onto the entity. A spread would let a caller overwrite server-owned
    // columns such as tokenHash (persistent auth backdoor surviving shared-
    // token rotation), the optimistic-lock version or executorStartupId.
    // Only the known metric columns below are writable via heartbeat.
    // E9 exception: maxConcurrentTasks is deliberately whitelisted so an
    // executor that hot-updates its capacity is adopted without re-register;
    // it goes through the range check below first (invalid → treated as
    // not-reported, DB value untouched). U16 applies the same posture to
    // deadLetterCount (non-negative integer 0..100000).
    const metricsWhitelist: Array<
      | "cpuUsage"
      | "memUsage"
      | "diskUsage"
      | "networkLatency"
      | "runningTaskCount"
      | "totalTaskCount"
      | "failedTaskCount"
      | "maxConcurrentTasks"
      | "deadLetterCount"
    > = [
      "cpuUsage",
      "memUsage",
      "diskUsage",
      "networkLatency",
      "runningTaskCount",
      "totalTaskCount",
      "failedTaskCount",
      "maxConcurrentTasks",
      "deadLetterCount",
    ];
    if (
      metricValues.maxConcurrentTasks !== undefined &&
      !ExecutorService.isAdoptableMaxConcurrentTasks(
        metricValues.maxConcurrentTasks,
      )
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid maxConcurrentTasks=${String(
          metricValues.maxConcurrentTasks,
        )} (expected integer in 1..10000); keeping stored value`,
      );
      delete metricValues.maxConcurrentTasks;
    }
    // NETOPT-D P2-D2: runningTaskCount 是派发闸门的数字列（selectLeastLoaded/
    // 容量守卫直接读它判满）——执行器上报面不可信，必须与数组截顶共享同一
    // 上界（MAX_RUNNING_EXECUTION_IDS）。否则真实在跑 >10000 时闸门误判有空位
    // 而超发；且被数组截断丢弃的 id 在 stale includes() 判据里被判"不在跑"，
    // 健康长任务被提前恢复成 FAILED。非法值视同未上报（DB 值不动）。
    if (
      metricValues.runningTaskCount !== undefined &&
      (!Number.isInteger(metricValues.runningTaskCount) ||
        metricValues.runningTaskCount < 0 ||
        metricValues.runningTaskCount > MAX_RUNNING_EXECUTION_IDS)
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid runningTaskCount=${String(
          metricValues.runningTaskCount,
        )} (expected integer in 0..${MAX_RUNNING_EXECUTION_IDS}); keeping stored value`,
      );
      // NETOPT-E P3-1: 越界只删字段、DB 值不动——持续越界上报期间派发闸门用
      // 陈旧计数判满（可能误判满/空），但下一次合法上报即自纠正；不为此引入
      // 半采纳状态（半采纳值同样不可信）。
      delete metricValues.runningTaskCount;
    }
    // U16: deadLetterCount 采纳（node ab4971f / python 001 起上报）。非法值
    // 视同未上报——从 metricValues 删除，DB 值不动，与上轮 maxConcurrentTasks
    // 采纳同模式。
    if (
      metricValues.deadLetterCount !== undefined &&
      !ExecutorService.isAdoptableDeadLetterCount(metricValues.deadLetterCount)
    ) {
      this.logger.warn(
        `Executor ${address} reported invalid deadLetterCount=${String(
          metricValues.deadLetterCount,
        )} (expected integer in 0..100000); keeping stored value`,
      );
      delete metricValues.deadLetterCount;
    }
    // A-6（执行器域审计 P3）：cpuUsage/memUsage 是评分公式的直接输入
    // （computeExecutorLoadScore 按 /100 归一到 [0,1]）——越界值会把评分推出
    // 量纲（负值 → 负分，>100 → cpu/mem 项越过权重上限），且该输入每 30s 心跳
    // 刷新一次。执行器自报面不可信：越界/非有限值视同**未上报**（删字段、
    // DB 值不动），与上方 maxConcurrentTasks / runningTaskCount 的非法采纳
    // 先例同策。
    for (const pctKey of ["cpuUsage", "memUsage"] as const) {
      const pctValue = metricValues[pctKey];
      if (
        pctValue !== undefined &&
        (!Number.isFinite(pctValue) || pctValue < 0 || pctValue > 100)
      ) {
        this.logger.warn(
          `Executor ${address} reported invalid ${pctKey}=${String(pctValue)} (expected a number in 0..100); treating as not reported`,
        );
        delete metricValues[pctKey];
      }
    }
    // metricsWhitelist 的键全部对应 Executor 的数值指标列（Pick<Executor, …>
    // 为纯上转型断言）——写入经由该视图而非 `(e as any)`，保持类型面精确；
    // 运行时行为与原逐键直写完全一致。
    const writableMetrics = e as Pick<
      Executor,
      (typeof metricsWhitelist)[number]
    >;
    for (const key of metricsWhitelist) {
      if (metricValues[key] !== undefined) {
        writableMetrics[key] = metricValues[key];
        // R53-A1：只有**本轮真的上报且通过校验**的指标才进 patch。未上报的
        // 指标不写（此前整行 save 会把快照值写回，双主人列 maxConcurrentTasks
        // 因此会把管理台刚改的容量顶掉）。
        adopted.add(key);
      }
    }
    // NETOPT-G P1-6：记录跃迁前的状态——executor.online 只在**真实恢复**
    // （非 ONLINE → ONLINE）时发布，避免每次 30s 心跳都刷一条事件。
    const wasOnline = e.status === ExecutorStatus.ONLINE;
    e.status = ExecutorStatus.ONLINE;
    // NETOPT-G P1-7：心跳到达即清零"连续超时"计数——这是迟滞判死能自愈的
    // 关键：一次成功心跳就把"疑似失联"状态彻底解除，下一轮 sweep 必须重新
    // 从 0 累计，因此"偶发失败 + 恢复"永远不会累积到判死阈值。
    e.consecutiveHeartbeatMisses = 0;
    // 遗留 P1-24：恢复在线即清除离线原因标注。
    e.offlineReason = null;
    e.lastHeartbeat = new Date();
    if (incomingStartedAt) {
      e.executorStartedAt = incomingStartedAt;
      adopted.add("executorStartedAt");
    }
    if (incomingStartupId) {
      e.executorStartupId = incomingStartupId;
      adopted.add("executorStartupId");
    }

    // CONSISTENCY-02: persist executor-node 的活性上报。缺省字段写 null
    // （= 旧版执行器未上报，区别于 [] 的"已上报且空闲"）；仅在字段上报时才
    // 覆盖，避免旧版心跳把新版已写入的活性集合擦回 null。deadLetterCount
    // 经上方白名单校验后采纳落列（U16），>0 时仍保留告警。
    if (runningExecutionIds !== undefined) {
      e.runningExecutionIds = this.sanitizeRunningExecutionIds(
        runningExecutionIds,
        address,
      );
      adopted.add("runningExecutionIds");
    }
    // E-01-RPT（生产实证：RPA5 恒显「当前运行任务 1/10」「活性上报 0 条，与运行
    // 计数 1 不一致」，而设备上无任务在跑）：采纳 pull 预留槽位数。
    //
    // 采纳时机刻意放在**这里**：此刻 e.runningTaskCount 已被上方白名单环写成
    // 本次上报的最终值（或重启分支清零值），配对校验才拿得到真值。
    //
    // 三态纪律（与 runningExecutionIds 同款，这是兼容性红线）：
    // - `undefined`（旧版执行器未上报）→ **保留 DB 旧值**，UI 回落「按已占槽位
    //   显示」的旧口径，行为与引入前逐字节一致；
    // - 非法（非整数/负数/超上界/与 runningTaskCount 不自洽）→ warn + 保留 DB
    //   旧值（不半采纳——半采纳值同样不可信，与 NETOPT-E P3-1 同调）；
    // - 合法（**含 0**）→ 覆盖。
    //
    // 自洽性硬约束 `reservedSlots <= runningTaskCount`：预留是「已占槽位」的
    // **子集**（E-01 让预留与正式占用共用同一账本），故预留数不可能超过总数。
    // 违反即说明该上报不可信（典型成因：本次 runningTaskCount 越界被删、留下
    // 陈旧低值），此时连 reservedSlots 一起拒绝，让 UI 走旧口径，下一次合法
    // 上报即自纠正。
    if (reservedSlots !== undefined) {
      if (!ExecutorService.isAdoptableReservedSlots(reservedSlots)) {
        this.logger.warn(
          `Executor ${address} reported invalid reservedSlots=${String(
            reservedSlots,
          )} (expected integer in 0..${MAX_RUNNING_EXECUTION_IDS}); keeping stored value`,
        );
      } else if (reservedSlots > e.runningTaskCount) {
        // 注意用 e.runningTaskCount（最终值）而非 metricValues.runningTaskCount
        // ——后者可能刚被越界校验删除，读它会是 undefined 而恒判不自洽。
        this.logger.warn(
          `Executor ${address} reported reservedSlots=${reservedSlots} exceeding ` +
            `runningTaskCount=${e.runningTaskCount} (reservations are a subset of ` +
            `occupied slots); keeping stored reservedSlots`,
        );
      } else {
        e.reservedSlots = reservedSlots;
        adopted.add("reservedSlots");
      }
    }
    // python_task_multiversion（WS2 · CONTRACT §2.2/§2.3 · 兼容性红线 3）：
    // 心跳采纳 `interpreters`——三态必须精确区分，任一态混淆都会造成调度错判：
    // - 字段 `undefined`（旧执行器心跳 / 新版未变化时不上报）→ **保留 DB 旧值**。
    //   这是红线 3 的字面要求：旧心跳绝不能把已上报的清单清空（清空后该执行器
    //   会被当成"池空"而彻底接不到带版本声明的任务）。
    // - 存在但结构非法（非数组 / 项缺 version / version 非 X.Y|X.Y.Z）→ 整字段
    //   拒绝采纳 + warn，DB 保留旧值（脏上报不得污染调度判据）。
    // - 合法（**含 `[]`**，"已上报且缓存池为空"）→ 覆盖。
    if (interpreters !== undefined) {
      const normalizedInterpreters = normalizeInterpreters(interpreters);
      if (normalizedInterpreters === null) {
        this.logger.warn(
          `Executor ${address} reported an invalid interpreters payload ` +
            `(expected an array of { version: "X.Y" | "X.Y.Z" }); keeping stored value`,
        );
      } else {
        e.interpreters = normalizedInterpreters;
        adopted.add("interpreters");
      }
    }
    // R3-A（§4.3/P10）：心跳采纳 `installedPackages`——三态与 interpreters
    // 完全同款（缺省 → 保留 DB 旧值；结构非法 → 整字段拒绝 + warn；
    // 合法含 [] → 覆盖「已上报且无安装包」）。executors 列白名单已登记
    // （HEARTBEAT_OWNED_COLUMNS），patch 投影由 adopted 集合把关。
    if (installedPackages !== undefined) {
      const normalizedInstalledPackages =
        normalizeInstalledPackages(installedPackages);
      if (normalizedInstalledPackages === null) {
        this.logger.warn(
          `Executor ${address} reported an invalid installedPackages payload ` +
            `(expected an array of { name, type, version }); keeping stored value`,
        );
      } else {
        e.installedPackages = normalizedInstalledPackages;
        adopted.add("installedPackages");
      }
    }
    // ARCH-36（ADR-017 阶段 2）：心跳采纳 `deviceFingerprint`。
    // 三态与 interpreters 同款，但**非法时只留 debug 不 warn**：指纹是机器
    // 自报的十六进制串，形态非法说明执行器侧采集/序列化有 bug，而这条路径
    // 每 30s 一次/台——warn 会给全部异常执行器刷屏，debug 已足够定位（真正的
    // 可观测价值在 `stats()` 的覆盖率口径：reportsWithFingerprint / reports）。
    // 关键：缺省/非法一律**不动 DB**——绝不让旧执行器或采集失败的心跳把已存的
    // 指纹擦成 NULL（那会让冲突观测失去历史，正是本阶段最需要的数据）。
    if (metrics.deviceFingerprint !== undefined) {
      if (incomingFingerprint === null) {
        this.logger.debug(
          `Executor ${address} reported a non-conformant deviceFingerprint ` +
            `(expected 64 hex chars); keeping stored value`,
        );
      } else {
        // P1-2（ADR-017 阶段 3 复查补口）：**绝不覆盖别人那行的真实指纹**。
        //
        // 行是按地址回落的（按指纹查不到本行），而本行已存着**另一份**安装的
        // 真实指纹 ⇒ 这是另一份安装在同址心跳。旧实现直接把本次指纹写进这一行：
        // DHCP 把同一 IP 先后分给两台机器时（现场 17:33/17:34 实证），两台机器
        // 会每 30s 互改同一行的指纹，行身份在两份安装之间来回漂移——注册面刚
        // 裁定的归属被心跳面悄悄推翻，冲突观测也失去历史。
        //
        // 现在：不采纳（不写该列），身份留在自己的行上；真正的碰撞由
        // observeDeviceFingerprint 的 row-identity-overwrite 判据以 ERROR +
        // 通知外发（可见、可处置），而不是靠静默改字段"自愈"。
        // 只 debug 不 warn：心跳 30s 一台，warn 会刷屏，而 ERROR 侧已覆盖可见性。
        // 存量 legacy/NULL 行（storedReal === null）不受影响——升级接管仍照旧。
        const storedReal = normalizeDeviceFingerprint(e.deviceFingerprint);
        if (storedReal !== null && storedReal !== incomingFingerprint) {
          this.logger.debug(
            `Heartbeat from ${address} carried deviceFingerprint ` +
              `${incomingFingerprint.slice(0, 12)}… but row ${e.id} belongs to ` +
              `${storedReal.slice(0, 12)}… — not adopting: a different install is sharing this ` +
              `address, so the fingerprint stays with its owner (the deviceFingerprint conflict ` +
              `observer reports the collision)`,
          );
        } else {
          e.deviceFingerprint = incomingFingerprint;
          adopted.add("deviceFingerprint");
        }
      }
    }
    if (
      typeof metricValues.deadLetterCount === "number" &&
      Number.isFinite(metricValues.deadLetterCount) &&
      metricValues.deadLetterCount > 0
    ) {
      this.logger.warn(
        `Executor ${address} reported ${metricValues.deadLetterCount} dead-letter execution(s) awaiting callback retries`,
      );
    }

    // R53-A1（ADR-026 规则 4）：这里此前是 `repo.save(e)` **整行回写**。
    // 缺陷（上一轮 R51-A1 登记）：save 是「读当前行 → 按列 diff → 只写差异列」，
    // 快照里那些**心跳从不修改**、却由 register / 管理台拥有的列，只要在
    // findOne 之后被改过，就会被 diff 判成"改动"按旧值写回。受害列：
    // address / appName / capabilities / groupName / tags / description /
    // maxConcurrentTasks / dispatchMode / protocolVersion / executorVersion。
    // 而心跳**永不自纠正**这些列 —— 管理台每改一次就被回弹一次，且一直错到
    // 下一次 register。原注释只为 runningTaskCount 的 ±1 偏差辩护（"下一心跳
    // 自纠正"），从未辩护过上面这批。
    //
    // NETOPT-F P3-3（读改写竞态，仅文档化，语义不变）：本 patch 仍可覆盖
    // dispatch 的原子 +1 与 stale sweep 的原子 -1——每事件至多 1 槽偏差，且
    // 下一心跳（执行器如实上报 runningTaskCount）即自纠正。不加锁/版本校验
    // 是有意取舍（R-P0-006：心跳高频、乐观锁冲突会反噬吞吐）；偏差窗口内的
    // 闸门判满/判空是暂时的，不上报的旧版执行器才依赖该近似。
    const patch = this.pickOwnedColumns(e, adopted, HEARTBEAT_OWNED_COLUMNS);
    // 为什么这里**不该**加 CAS（status / version / lastHeartbeat 谓词）：心跳是
    // 覆盖式上报（ADR-017 §2），last-writer-wins 即正确语义；而心跳 30s 一次、
    // 机队规模下每秒都有心跳在写，任何「读取时刻的活跃证据」谓词都会在恰好有并发
    // 写时凭空 affected=0 —— 丢一轮心跳 = lastHeartbeat 停在旧值 = stale sweep
    // 误判失联（判死 → 离线通知 → 运行中任务被误标）。那是把「少写列」的修复换成
    // 可用性回归。ADR-026 要挡的是「拿旧快照盖掉别人的新状态」，而这里写的每一列
    // 都由本次上报**重新确定**（白名单 ∩ 采纳集），没有一列是「顺手带上的旧值」。
    // adr-026-exempt: 心跳=覆盖式上报，last-writer-wins 即正确语义；加 CAS 会把
    // 「少写列」的修复变成可用性回归（理由见上五行）。
    await this.repo.update({ id: e.id }, patch);
    // R3-A（§4.3）：心跳携带 deployedApps → **整替**该执行器的
    // executor_app_versions 行（applyReportedAppVersions；键缺失 = 旧执行器
    // → 上面的 destructure 保持 undefined → 本分支整体跳过，行为与引入前
    // 逐字节一致）。best-effort（catch → warn）：事实落库失败不阻断心跳主链
    // （心跳响应携带 tokenHash/合规读数，30s 后同一份事实会重报），与下方
    // metrics history 写入同姿态——可观测降级，不是静默吞错。
    if (deployedApps !== undefined) {
      const normalizedDeployedApps = normalizeDeployedApps(deployedApps);
      if (normalizedDeployedApps === null) {
        this.logger.warn(
          `Executor ${address} reported an invalid deployedApps payload ` +
            `(expected an array of { appId, currentVersion, retainedVersions, ... }, ` +
            `<=${MAX_DEPLOYED_APPS} items); keeping stored executor_app_versions rows`,
        );
      } else {
        await this.applyReportedAppVersions(e.id, normalizedDeployedApps).catch(
          (err: unknown) => {
            this.logger.warn(
              `deployedApps persistence failed for executor ${address}: ` +
                `${err instanceof Error ? err.message : String(err)} ` +
                `(next heartbeat will re-report the same facts)`,
            );
          },
        );
      }
    }
    // 返回值 = 内存实体（已是本次上报后的最终态）叠加 patch —— **不重新 findOne**：
    // 多一次往返且可能读到别人的并发写（返回体与事件会描述一个本次心跳没写的状态）。
    const saved = { ...e, ...patch } as Executor;
    // NETOPT-G P1-6（状态机对称性）：恢复在线的事件在**落库之后**发布，与
    // emitExecutorOffline 的三处调用点同口径（状态先落库，事件后发）。
    // 只在真实跃迁时发——心跳 30s 一次，无条件 emit 会把 outbox 打爆。
    if (!wasOnline) {
      this.emitExecutorOnline(saved);
    }
    try {
      await this.metricsHistoryRepo.save(
        this.metricsHistoryRepo.create({
          executorAddress: saved.address,
          // ADR-017 阶段 3 复查补口：行身份（趋势图按行拆分，见实体注释）。
          executorId: saved.id,
          cpuUsage: saved.cpuUsage ?? null,
          memUsage: saved.memUsage ?? null,
          diskUsage: saved.diskUsage ?? null,
          runningTaskCount: saved.runningTaskCount ?? 0,
          totalTaskCount: saved.totalTaskCount ?? 0,
          failedTaskCount: saved.failedTaskCount ?? 0,
          avgExecutionTime: null,
          uptimeSeconds: 0,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `metrics history write failed for executor ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return saved;
  }

  // -------------------------------------------------------------------------
  // R3-A（部署模型评审 2026-10-23 §4.3）：设备级应用版本事实的写面与读面
  // -------------------------------------------------------------------------

  /**
   * R3-A（§4.3）：把执行器上报的 deployedApps 全量快照**整替**进
   * executor_app_versions（心跳/注册共用同一实现，语义必须逐字节一致）。
   *
   * 整替语义（评审 §4.3 的核心约定）：
   * - 上报数组里的应用 → upsert（无行则建，有行且内容有变则改写）；
   * - **不在数组里的既有行 → 删除**（设备已卸载该应用——executor-node 的
   *   apps/ 目录扫描是事实源，应用消失就是卸载了，留着旧行只会让
   *   getReleases devices / 版本跟随读到幽灵事实）；
   * - 调用方保证「键缺失不调本方法」（旧执行器完全不动 = fail-honest
   *   「无数据」，而不是把表清空）。
   *
   * 幂等：同一载荷重复上报不产生重复行（唯一键 executorId+applicationId
   * 兜底）、也不改写内容未变化的行（逐行 diff，含 retainedVersions 的
   * JSON 逐元素比对）——30s 心跳高频面不为无变化的行付写放大。
   * lastReportedAt 因此只在**行内容真的变化**时刷新；设备活性看
   * executors.lastHeartbeat（本列语义见实体注释）。
   *
   * 并发：同一执行器的心跳天然串行（executor-node 单循环发送）；跨进程
   * 并发（两份安装同址心跳）已被上游 R32-C4 fail-closed 拒绝，到达这里的
   * 都是已解析出行身份 e.id 的上报。
   */
  private async applyReportedAppVersions(
    executorId: string,
    apps: DeployedAppReport[],
  ): Promise<void> {
    if (!this.executorAppVersionRepo) return;
    // R3-B（服务层质量巡查·事务边界）：整替的读-判-写必须在**同一事务**内。
    // 心跳串行（方法头注）保证了同执行器不并发，但没有保护**中途失败**：
    // upsert 循环里任一写失败时，方法抛错被调用点 warn 吞掉，本轮已写下的
    // 部分 upsert 留在库里——事实面停在「半新半旧」的撕裂快照；更糟的是
    // 「设备已卸载全部应用、只新装一个」的整替：新行写失败 + 旧行删除
    // （或反向交错）后，getReleases devices 读到的是既不含新应用、又残留
    // 已卸载应用的错位状态，且**没有自愈通道**——卸载的应用从此不再上报，
    // 「下一次心跳重报」修的是新应用，修不回被误删/误留的旧行。包进事务：
    // 任一步失败全部回滚，表停在上一份完整快照（30s 后整份重报）。
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ExecutorAppVersion);
      const existing = await repo.find({
        where: { executorId },
      });
      const existingByAppId = new Map(
        existing.map((row) => [row.applicationId, row]),
      );
      const reportedAppIds = new Set(apps.map((a) => a.appId));
      const sameRetained = (a: string[], b: string[] | null): boolean =>
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((v, i) => v === b[i]);
      for (const app of apps) {
        const lastDeployedAt = app.lastDeployedAt
          ? new Date(app.lastDeployedAt)
          : null;
        const row = existingByAppId.get(app.appId);
        // 幂等短路：行已存在且内容逐字段一致 → 本轮不写（见方法注释的写放大
        // 论证；retainedVersions 是数组，比对必须逐元素而非引用相等）。
        if (
          row &&
          row.currentVersion === app.currentVersion &&
          row.currentReleaseKey === app.currentReleaseKey &&
          row.runMode === app.runMode &&
          row.lastDeployedAt?.getTime() === lastDeployedAt?.getTime() &&
          sameRetained(app.retainedVersions, row.retainedVersions)
        ) {
          continue;
        }
        if (row) {
          // adr-026-exempt: R3/§4.3 设备版本整替——写者唯一（同一 executorId
          // 的上报面），整替语义本就以最后一次上报为准，无跨写者覆盖风险
          // （完整理由见上方块注释）。
          await repo.update(
            { id: row.id },
            {
              currentVersion: app.currentVersion,
              currentReleaseKey: app.currentReleaseKey,
              retainedVersions: app.retainedVersions,
              runMode: app.runMode,
              lastDeployedAt,
              lastReportedAt: new Date(),
            },
          );
        } else {
          await repo.save(
            repo.create({
              executorId,
              applicationId: app.appId,
              currentVersion: app.currentVersion,
              currentReleaseKey: app.currentReleaseKey,
              retainedVersions: app.retainedVersions,
              runMode: app.runMode,
              lastDeployedAt,
              lastReportedAt: new Date(),
            }),
          );
        }
      }
      // 整替的删除半边：数组外的应用 = 设备已卸载。
      const staleIds = existing
        .filter((row) => !reportedAppIds.has(row.applicationId))
        .map((row) => row.id);
      if (staleIds.length > 0) {
        await repo.delete(staleIds);
      }
    });
  }

  /**
   * R3-A（§4.3）：getReleases devices 聚合的读面——按应用取全部设备版本事实，
   * 携带执行器可读名（executors.appName，useExecutorNames.nameOf 同口径）与
   * 在线状态（executors.status / lastHeartbeat；离线设备的事实可能已过期，
   * 由前端置灰标注「最后上报」时刻）。
   *
   * 行数上界：每执行器 deployedApps ≤ 50，按 applicationId 过滤后 =
   * 部署了该应用的设备数，量级与部署行同源（findAllByApp 同一面）。
   *
   * 降级：仓库未装配（存量单测）/读失败 → 抛给调用方？**不**——读面是
   * getReleases 的增量字段（devices），失败不应击穿整个版本追溯响应；返回
   * 空数组并 warn（devices 聚合缺席时前端按「无设备上报」渲染，部署行推断
   * 字段仍在，信息不缺失）。
   */
  async getAppVersionFacts(applicationId: string): Promise<
    Array<{
      executorId: string;
      executorName: string | null;
      currentVersion: string | null;
      retainedVersions: string[];
      lastHeartbeat: string | null;
      online: boolean;
    }>
  > {
    if (!this.executorAppVersionRepo) return [];
    try {
      const facts = await this.executorAppVersionRepo.find({
        where: { applicationId },
      });
      if (facts.length === 0) return [];
      const executorIds = [
        ...new Set(facts.map((f) => f.executorId).filter(Boolean)),
      ];
      const executors = executorIds.length
        ? await this.repo.find({
            where: { id: In(executorIds) },
            select: {
              id: true,
              appName: true,
              status: true,
              lastHeartbeat: true,
            } as never,
          })
        : [];
      const executorById = new Map(executors.map((e) => [e.id, e]));
      return facts.map((f) => {
        const executor = executorById.get(f.executorId);
        return {
          executorId: f.executorId,
          // 执行器行可能已被删除而事实行仍在（理论上 FK 级联会同步删，这里
          // 仍防御性给 null——名字缺席如实显示，不编造）。
          executorName: executor?.appName ?? null,
          currentVersion: f.currentVersion,
          retainedVersions: Array.isArray(f.retainedVersions)
            ? f.retainedVersions
            : [],
          lastHeartbeat: executor?.lastHeartbeat
            ? new Date(executor.lastHeartbeat).toISOString()
            : null,
          online: executor?.status === ExecutorStatus.ONLINE,
        };
      });
    } catch (err: unknown) {
      this.logger.warn(
        `executor_app_versions read failed for application ${applicationId}: ` +
          `${err instanceof Error ? err.message : String(err)} ` +
          `(releases devices aggregation will be empty; deployment-inferred fields remain)`,
      );
      return [];
    }
  }

  findAll() {
    // Cap the result set: an admin UI listing does not need every historical executor.
    // Use pagination if the UI needs more — the ExecutorListPage supports filters/search.
    // 上限值经 EXECUTOR_LIST_LIMIT 导出并由 getRuntimeConfig() 回传前端，
    // 超限时 UI 显示 "仅显示前 N / 共 M 台"（P3-9，不再静默截断）。
    //
    // UI-17: 逐行计算 versionCompliant（EXE-VER-1 门禁 EXECUTOR_MIN_VERSION 的
    // 读面投影）——执行器版本存于 register/心跳，下限在中心端配置，合规态是
    // 两者的派生值，不落库（列不加、心跳响应已有回显，此处供列表 UI 展示）。
    // 门禁关 / 执行器未上报版本 → true（isVersionCompliant 宽松语义）。
    const minVersion =
      this.configService.get<string>("executor.minVersion") || "";
    return this.repo
      .find({ order: { createdAt: "DESC" }, take: EXECUTOR_LIST_LIMIT })
      .then((rows) =>
        rows.map((e) => ({
          ...e,
          versionCompliant: isVersionCompliant(e.executorVersion, minVersion),
        })),
      );
  }

  /**
   * 执行器选择器（GET /executors/picker）：部署模态 / 快速部署两个执行器
   * 下拉的轻量数据源。
   *
   * 为什么不复用 findAll()：它回全列实体（含 runningExecutionIds ≤10000 条的
   * 数组列、interpreters、tags…），且 take=EXECUTOR_LIST_LIMIT(500) 按
   * createdAt DESC 静默截断——执行器总数超过 500 后，下拉对第 501+ 台执行器
   * **假阴性**（用户搜不到一台真实存在的机器）。这里以 SQL select 收窄到两个
   * 下拉实际消费的 6 列：
   *   - id / appName / address / status：选项文案 + 在线态禁用（disabled）；
   *   - runningTaskCount / maxConcurrentTasks：部署模态选项的负载进度条
   *     （AppDeploymentPage 的 ExecutorCard）。
   * 分组/标签/心跳时间等列表页字段下拉不消费，一并不回（载荷护栏与本仓库
   * 「读面按消费方声明」的纪律一致）。
   *
   * 截断显式化：total 以独立 COUNT 取得；items 按 createdAt DESC 取前
   * EXECUTOR_PICKER_LIMIT 行，`total > items.length` 时 `truncated: true`。
   * 返回**不抛错**——超限时下拉仍有前 2000 台可用，但前端必须把 truncated
   * 告警渲染出来（execList.truncated），不许把子集说成全量。
   *
   * RBAC 与 GET /executors 完全对齐（JwtAuthGuard、无 @Roles 收紧）：N11 复核
   * 结论同样适用本端点——任务 CRUD 对普通用户开放，且本读面是 list 的**严格
   * 子集**（不新增任何字段暴露），单独收紧既挡不住信息又会打断部署下拉。
   */
  async findPickerOptions(): Promise<{
    items: Array<{
      id: string;
      appName: string;
      address: string;
      status: ExecutorStatus;
      runningTaskCount: number;
      maxConcurrentTasks: number | null;
    }>;
    total: number;
    truncated: boolean;
    limit: number;
  }> {
    const [total, rows] = await Promise.all([
      this.repo.count(),
      // select 收窄是载荷护栏的主体：runningExecutionIds（≤10000 条/行）等重列
      // 不出库。列清单必须与上方返回类型逐一对应，多列即读面漂移。
      this.repo.find({
        order: { createdAt: "DESC" },
        take: EXECUTOR_PICKER_LIMIT,
        select: {
          id: true,
          appName: true,
          address: true,
          status: true,
          runningTaskCount: true,
          maxConcurrentTasks: true,
        },
      }),
    ]);
    return {
      items: rows.map((e) => ({
        id: e.id,
        appName: e.appName,
        address: e.address,
        status: e.status,
        runningTaskCount: e.runningTaskCount,
        maxConcurrentTasks: e.maxConcurrentTasks,
      })),
      total,
      truncated: total > rows.length,
      limit: EXECUTOR_PICKER_LIMIT,
    };
  }

  /**
   * A-9（执行器域审计 P3）：push 场景专用的目标执行器查询——**不经** findAll()
   * 的列表投影（take=500、createdAt DESC、无状态过滤）。
   *
   * 背景：executor-package 推送入口（空 executorIds = "推全部在线执行器"）
   * 原先直接拿 findAll() 的行当目标——在线机队 > 500 时列表投影只回最新
   * 500 行（老机器静默漏推），且包含离线行（对离线机产生一整片连接失败）。
   *
   *   - 空/缺省 executorIds → status=ONLINE **全量**分页扫描（每页
   *     EXECUTOR_LIST_LIMIT，翻页到取尽为止）；
   *   - 显式 executorIds → 按 id 直查（≤ PushExecutorPackageDto 的 100 上限），
   *     不做状态过滤——操作者明确点名，离线机的连接失败会在逐台结果里呈现。
   */
  async findPushTargets(executorIds?: string[]): Promise<Executor[]> {
    if (executorIds && executorIds.length > 0) {
      return this.repo.find({ where: { id: In(executorIds) } });
    }
    const pageSize = EXECUTOR_LIST_LIMIT;
    const all: Executor[] = [];
    for (let skip = 0; ; skip += pageSize) {
      const page = await this.repo.find({
        where: { status: ExecutorStatus.ONLINE },
        order: { createdAt: "DESC" },
        skip,
        take: pageSize,
      });
      all.push(...page);
      if (page.length < pageSize) return all;
    }
  }

  /**
   * Executor lifecycle audit（P2-5 / P3-9）：回传执行器面的**有效运行时参数**，
   * 供管理台与后端判定保持同源，消灭前端硬编码常量与后端配置漂移：
   *
   * - `heartbeatTimeoutMs` = heartbeatInterval（默认 30000ms）×
   *   heartbeatTimeoutMultiplier（默认 3）= 默认 90s。这正是
   *   markStaleOffline() 把 ONLINE 判成 OFFLINE 的截止阈值；前端此前硬编码
   *   5 分钟，于是后端判死后的约 3.5 分钟里 UI 仍把心跳画成"刚刚（绿）"。
   * - `listLimit` / `executorTotal`：findAll() 的截断上限与全量行数，
   *   total > limit 时 UI 必须提示只展示了子集（P3-9）。
   * - NETOPT-G P1-7 起追加 `staleOfflineConfirmations` 与 `effectiveOfflineAfterMs`：
   *   迟滞上线后真实判死窗口不再是 `heartbeatTimeoutMs`，而是它 × 确认轮数
   *   （+ 至多一个扫描周期）。不暴露这两项会让 UI 展示的"多久判离线"与后端
   *   实际行为不符——正是本字段当初要消灭的那类前后端漂移。
   */
  async getRuntimeConfig(): Promise<{
    heartbeatIntervalMs: number;
    heartbeatTimeoutMultiplier: number;
    heartbeatTimeoutMs: number;
    staleOfflineConfirmations: number;
    effectiveOfflineAfterMs: number;
    listLimit: number;
    executorTotal: number;
  }> {
    const heartbeatIntervalMs =
      this.configService.get<number>("executor.heartbeatInterval") || 30000;
    const heartbeatTimeoutMultiplier =
      this.configService.get<number>("executor.heartbeatTimeoutMultiplier") ||
      3;
    const executorTotal = await this.repo.count();
    // NETOPT-G P1-7：只解析一次确认轮数（下方两处引用）——重复调用会让
    // configService.get 在同一请求里被读两次，既浪费也让"有效窗口"与"轮数"
    // 理论上可能取到不同值（配置热更竞态）。
    const staleOfflineConfirmations = this.resolveStaleConfirmations();
    return {
      heartbeatIntervalMs,
      heartbeatTimeoutMultiplier,
      heartbeatTimeoutMs: heartbeatIntervalMs * heartbeatTimeoutMultiplier,
      // NETOPT-G P1-7：判死迟滞的确认轮数，以及据此算出的**实际**判死窗口。
      // 前端此前只按 heartbeatTimeoutMs（90s）展示"多久判离线"，而迟滞上线后
      // 真实窗口 = heartbeatTimeoutMs × staleOfflineConfirmations（+ 一个扫描
      // 周期）。不暴露这两项会让 UI 显示与真实行为不符。
      staleOfflineConfirmations,
      effectiveOfflineAfterMs:
        heartbeatIntervalMs *
        heartbeatTimeoutMultiplier *
        staleOfflineConfirmations,
      listLimit: EXECUTOR_LIST_LIMIT,
      executorTotal,
    };
  }

  async findOne(id: string): Promise<Executor> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new AppError("EXECUTOR_NOT_FOUND");
    return executor;
  }

  /**
   * Update executor metadata (group, tags, description, maxConcurrentTasks).
   * F-2 family: assign only the four allowed fields — the controller has
   * already whitelisted, but the service stays self-contained so any other
   * caller cannot smuggle entity columns (tokenHash, version, ...) through.
   */
  async update(
    id: string,
    data: {
      groupName?: string | null;
      tags?: string[] | null;
      description?: string | null;
      maxConcurrentTasks?: number | null;
    },
  ): Promise<Executor> {
    const executor = await this.findOne(id);
    // R51-A1（ADR-026 规则 4）：这里此前是「findOne 快照 → 就地改 4 个字段 → 整行
    // `save()`」。整行 save 的 diff 会把**快照里过期的其余列**判成"改动"写回：并发
    // 心跳刚落库的 status / lastHeartbeat / cpuUsage / runningTaskCount、sweep 刚置的
    // OFFLINE、派发原子 +1 的计数，都会被这条只管元数据的 PATCH 一起回滚。本方法语义上
    // 只拥有 4 个元数据列，故改成显式 patch（列级写）。
    // adr-026-exempt: 只写 groupName/tags/description/maxConcurrentTasks 四列，且这四列
    // **不是状态列**（无生命周期/凭据/计数语义）——管理台 PATCH 的语义就是 last-writer-wins，
    // 加前置断言（version/maxConcurrentTasks CAS）会让 PATCH 在心跳恰好落库时凭空 409。
    const patch: Partial<
      Pick<
        Executor,
        "groupName" | "tags" | "description" | "maxConcurrentTasks"
      >
    > = {};
    if (data.groupName !== undefined) patch.groupName = data.groupName;
    if (data.tags !== undefined) patch.tags = data.tags;
    if (data.description !== undefined) patch.description = data.description;
    if (data.maxConcurrentTasks !== undefined) {
      // A-5（执行器域审计 P3）：管理台 PATCH 的容量上限必须过与 register/
      // heartbeat 相同的 1..10000 整数闸（isAdoptableMaxConcurrentTasks 先例）
      // ——0/负数/超万/非整数落库会让 loadScore 变 Infinity、容量闸
      // `runningTaskCount < max` 恒 false，该执行器被永久排除在派发之外
      // （"注册成功、永远收不到一个任务"）。显式 null = 清除上限（列可空，
      // 容量闸按无上限处理），保留既有 PATCH 语义；非法值 400 拒绝、不落库。
      if (
        data.maxConcurrentTasks !== null &&
        !ExecutorService.isAdoptableMaxConcurrentTasks(data.maxConcurrentTasks)
      ) {
        throw new AppError("EXECUTOR_MAX_CONCURRENT_INVALID", {
          value: String(data.maxConcurrentTasks),
        });
      }
      patch.maxConcurrentTasks = data.maxConcurrentTasks;
    }
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    if (keys.length === 0) {
      // 空 patch：不发写请求（此前会发一条 no-op 的整行 save，同样是可交错窗口）。
      return executor;
    }
    // 内存对象同步一份：返回值（controller 回包）与既有调用方语义逐字节不变。
    Object.assign(executor, patch);
    // adr-026-exempt: 只写 groupName/tags/description/maxConcurrentTasks（非状态列，
    // 管理台 PATCH = last-writer-wins 即正确语义）；详见方法内上方论证。
    await this.repo.update({ id: executor.id }, patch);
    return executor;
  }

  /**
   * P7c：Agent 域能力覆盖式上报。与 register() 的运行时 capabilities 分列，
   * 因此 GUI 白名单撤销时 [] 能清空 Agent 能力，又不会擦掉 python/node。
   */
  async updateCapabilities(id: string, capabilities: string[]): Promise<void> {
    const allowed = new Set([
      "agent:sop",
      "filesystem",
      "http",
      "browser",
      "gui",
    ]);
    if (
      !Array.isArray(capabilities) ||
      capabilities.some((cap) => typeof cap !== "string" || !allowed.has(cap))
    ) {
      throw new AppError("EXECUTOR_AGENT_CAPABILITY_UNSUPPORTED");
    }
    // adr-026-exempt: 只写 agentCapabilities + 更新时间两列——**上报语义**（执行器每轮覆盖式
    // 上报能力），并发上报 last-writer-wins 即正确语义；不触碰状态/凭据/生命周期列。
    await this.repo.update(
      { id },
      {
        agentCapabilities: [...new Set(capabilities)],
        agentCapabilitiesUpdatedAt: new Date(),
      },
    );
  }

  /** 显式取 select:false 列；旧行、失联或撤销均按无 Agent 能力处理。 */
  async getAgentCapabilities(id: string): Promise<string[]> {
    const executor = await this.repo.findOne({
      where: { id },
      select: {
        id: true,
        agentCapabilities: true,
        agentCapabilitiesUpdatedAt: true,
      },
    });
    const updatedAt = executor?.agentCapabilitiesUpdatedAt?.getTime();
    const age = updatedAt === undefined ? NaN : Date.now() - updatedAt;
    if (!Number.isFinite(age) || age < 0 || age > AGENT_CAPABILITIES_LEASE_MS) {
      return [];
    }
    return executor?.agentCapabilities ?? [];
  }

  /**
   * SOP 指派的可选执行器：**当前租约内**声明了 `agent:sop` 的机器。
   *
   * 为什么不走 findAll 的列表投影：agentCapabilities 在列表响应里被刻意
   * 剥离（短效租约字段，快照会让「显示有能力」与「实际还有效」脱节）。
   * 这里逐台复用 getAgentCapabilities 的租约判定——同一份 TTL 语义，不为
   * 指派面另造一份（复刻必然漂移）。指派面还要求能看能力明细（中台可行性
   * 预检的展示需求），故原样返回能力清单。
   */
  async listSopCapableExecutors(): Promise<
    Array<{
      id: string;
      appName: string;
      address: string;
      status: string;
      lastHeartbeat: Date | null;
      agentCapabilities: string[];
    }>
  > {
    const rows = await this.repo.find({
      order: { lastHeartbeat: "DESC" },
      take: 100,
    });
    const out: Array<{
      id: string;
      appName: string;
      address: string;
      status: string;
      lastHeartbeat: Date | null;
      agentCapabilities: string[];
    }> = [];
    for (const e of rows) {
      const caps = await this.getAgentCapabilities(e.id);
      if (!caps.includes("agent:sop")) continue;
      out.push({
        id: e.id,
        appName: e.appName,
        address: e.address,
        status: e.status,
        lastHeartbeat: e.lastHeartbeat ?? null,
        agentCapabilities: caps,
      });
    }
    return out;
  }

  /**
   * Get all unique executor groups.
   */
  async getGroups(): Promise<string[]> {
    const execs = await this.repo
      .createQueryBuilder("e")
      .select("DISTINCT e.groupName", "groupName")
      .where("e.groupName IS NOT NULL")
      .getRawMany();
    return execs.map((x) => x.groupName).filter(Boolean);
  }

  /**
   * Get all unique executor tags.
   * `tags` is a simple-array (comma-separated string) column, so we still need to
   * load the rows and split in TS — but we cap the read with `take` to bound the
   * scan. Set is generous because tags are user-defined and rarely change.
   */
  async getTags(): Promise<string[]> {
    const execs = await this.repo.find({
      select: { tags: true },
      // Bound the scan; tag set converges quickly even with thousands of executors.
      take: 5000,
    });
    const tagSet = new Set<string>();
    execs.forEach((e) => {
      if (e.tags) e.tags.forEach((tag) => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  }

  /**
   * Select the least-loaded online executor.
   * Filters to the given group/tags/runtime when provided.
   * Throws if no eligible executor is available or all are at capacity.
   */
  async selectLeastLoaded(opts?: {
    group?: string | null;
    tags?: string[] | null;
    runtime?: string | null;
    // python_task_multiversion（WS2 · CONTRACT §3.1）：可选版本声明——传入时
    // 追加解释器缓存池过滤。**可选尾参**：既有唯一生产调用方
    // （app-deployment.service 的 `selectLeastLoaded()`）零参数调用，行为不变。
    runtimeVersion?: string | null;
  }): Promise<Executor> {
    const all = await this.repo.find({
      where: { status: ExecutorStatus.ONLINE },
      // O-1（中台↔执行器深度审查）：候选池由「随机取 N 行再内存排序」改为
      // **SQL 级 Top-K**（ORDER BY runningTaskCount ASC LIMIT K）。旧实现
      // take 截断是**静默的**：超过 K 台在线时，排名 K+1 的负载最小执行器
      // 永远不被考虑——"generous cap" 在万级机队下是容量盲区。按 runningTaskCount
      // 升序取前 K 保证**最空闲的一批**必入池，内存评分公式在其上择优（评分是
      // 复合指标，SQL 只做负载维度的下界保证，二者不冲突）。
      order: { runningTaskCount: "ASC" },
      // F-07（本轮审计）: 上限提为可配（EXECUTOR_CANDIDATE_POOL_SIZE，默认 500）。
      take: this.candidatePoolSize,
    });
    if (all.length === 0) {
      throw new AppError("NO_AVAILABLE_EXECUTOR_FOR_SELECTION");
    }

    let candidates = all;

    if (opts?.group) {
      candidates = candidates.filter((e) => e.groupName === opts.group);
    }
    if (opts?.tags && opts.tags.length > 0) {
      candidates = candidates.filter((e) => {
        if (!e.tags) return false;
        return opts.tags!.every((tag) => e.tags!.includes(tag));
      });
    }
    if (opts?.runtime) {
      candidates = candidates.filter((e) =>
        !e.capabilities || e.capabilities.length === 0
          ? true
          : e.capabilities.includes(opts.runtime!),
      );
    }

    // python_task_multiversion（WS2 · CONTRACT §3.1）：解释器缓存池过滤——
    // 与 dispatch / dispatchBroadcast 同一位置（runtime 之后）与同一共享实现。
    // NFR-08：纯内存过滤，**不**引入候选级 DB/网络往返。
    const interpreterFiltered = this.applyInterpreterFilter(
      candidates,
      opts?.runtimeVersion,
    );
    if (interpreterFiltered.message) {
      // 既有错误类型保持不变（ServiceUnavailableException = 调度面"无可用
      // 执行器"，与下方两条 no-eligible-executor 分支同类）。
      this.logger.warn(
        `selectLeastLoaded blocked: failureReason=${ExecutionFailureReason.INTERPRETER_UNAVAILABLE} ${interpreterFiltered.message}`,
      );
      throw new AppError("NO_EXECUTOR_INTERPRETER_MISMATCH", {
        detail: interpreterFiltered.message,
      });
    }
    candidates = interpreterFiltered.kept;

    if (candidates.length === 0) {
      throw new AppError("NO_EXECUTOR_MATCHING_FILTERS");
    }

    // Weighted scoring (see executor-score.util.ts for the formula and units):
    // 50% task load ratio + 25% CPU + 25% memory + 10% long-task penalty
    // (CORE-05: executors currently running long-estimated tasks score worse,
    // so a long task is preferentially steered to the emptier executor).
    // Executors at or above max capacity are excluded before scoring.
    const available = candidates.filter((e) => {
      const max = e.maxConcurrentTasks ?? Infinity;
      return e.runningTaskCount < max;
    });
    const estimatedDurations =
      await this.estimatedDurationsByExecutor(available);
    const scored = available
      .map((e) => ({
        executor: e,
        score: computeExecutorLoadScore(e, {
          estimatedDurations: estimatedDurations.forExecutor(e),
        }),
      }))
      .sort((a, b) => a.score - b.score);

    if (scored.length === 0) {
      throw new AppError("NO_EXECUTOR_CAPACITY_AVAILABLE");
    }
    // E-2（中台↔执行器深度审查）：与 dispatch 同款结构化决策日志——「为什么选
    // 这台、过滤掉多少、评分面多大、落选者差多少」可回溯。opts 恒为可选尾参，
    // 零参数调用（app-deployment）也正常输出。
    this.logger.log(
      JSON.stringify({
        event: "selectLeastLoaded.decision",
        poolSize: all.length,
        afterFilters: candidates.length,
        scoredCount: scored.length,
        selected: {
          address: scored[0].executor.address,
          score: Number(scored[0].score.toFixed(3)),
          runningTaskCount: scored[0].executor.runningTaskCount,
          maxConcurrentTasks: scored[0].executor.maxConcurrentTasks,
        },
        topRunners: scored.slice(1, 4).map((s) => ({
          address: s.executor.address,
          score: Number(s.score.toFixed(3)),
          runningTaskCount: s.executor.runningTaskCount,
          maxConcurrentTasks: s.executor.maxConcurrentTasks,
        })),
      }),
    );
    return scored[0].executor;
  }

  /**
   * CORE-05: 批量读取候选执行器当前 RUNNING 任务的预估时长集合（秒）。
   * 任何失败（查询异常/行丢失）按"无估时"降级 → longTaskPenalty=0，
   * 评分退化为旧公式，调度永不因可观测性辅助面中断。
   *
   * ADR-017 阶段 3（决策 §7）：返回**取值器**而非裸 Map——阶段 3 起样本池有两
   * 个来源（新派发执行行按行身份、存量行只能按地址），调用方要的是「这台执行器
   * 的样本」而不是「某个键的样本」。把两个来源的合并收进本方法，调用方无从漏掉
   * 其中一支（此前消费方只 `get(address)`，正是漏改的形态）。
   */
  private async estimatedDurationsByExecutor(
    executors: Executor[],
  ): Promise<EstimatedDurationsIndex> {
    const active = executors.filter((e) => e.runningTaskCount > 0);
    if (active.length === 0) return EMPTY_ESTIMATED_INDEX;

    try {
      const addresses = [...new Set(active.map((e) => e.address))];
      // A-11（执行器域审计 P3）：热路径上界——此前对候选地址集**无 take** 全量
      // 拉 RUNNING 行 + 大 In(ids) 二段查任务表，大机队高并发时每次派发都是
      // 一次无界读。估时只服务于 longTaskPenalty（0.1 权重的次级评分信号），
      // 每地址采样 50 行近似即可（无 order = 采样近随机，均值无偏）；总行数
      // 另加 5000 硬顶防病态候选集。截断只损失样本量，评分语义近似保持。
      //
      // ADR-017 阶段 3（决策 §7 读面富化）：同时取 `executorId` 以便**按行身份
      // 归组**——阶段 3 起同址多行并存（ADR-017 §5），纯按地址归组会把两台的
      // 在跑执行混成一个样本池，于是两台都拿到同一份（被对方污染过的）估时，
      // longTaskPenalty 对两台同时偏大或偏小。
      const running = await this.execRepo.find({
        where: {
          executorAddress: In(addresses),
          status: ExecutionStatus.RUNNING,
        },
        select: { executorAddress: true, executorId: true, taskId: true },
        take: Math.min(addresses.length * 50, 5000),
      });
      if (running.length === 0) return EMPTY_ESTIMATED_INDEX;

      const ids = [...new Set(running.map((r) => r.taskId))];
      const rows = await this.taskRepo.find({
        where: { id: In(ids) },
        select: { id: true, estimatedDurationSec: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r.estimatedDurationSec]));
      const byExecutorId = new Map<string, EstimatedDurations>();
      const byAddress = new Map<string, EstimatedDurations>();
      for (const row of running) {
        // 新派发执行行有行身份 → 归到**该行**（无歧义）；
        // 存量行（迁移 0055 刻意不回填）没有 → 只能归到地址，且同址并存时两台
        // 会共享这份池。这是**如实**的：那些历史执行在物理上无法归属到行。
        const [bucket, key] = row.executorId
          ? ([byExecutorId, row.executorId] as const)
          : ([byAddress, row.executorAddress] as const);
        const durations = bucket.get(key) ?? [];
        durations.push(byId.get(row.taskId) ?? null);
        bucket.set(key, durations);
      }
      return {
        forExecutor: (executor) => [
          ...(byExecutorId.get(executor.id) ?? []),
          // 地址支只含**存量行**样本，故新派发执行器（有自己的 id 池）不会
          // 因同址并存而读到别人的数据；反之存量执行器能拿回自己的历史近似。
          ...(byAddress.get(executor.address) ?? []),
        ],
      };
    } catch {
      return EMPTY_ESTIMATED_INDEX;
    }
  }

  /**
   * E-2（中台↔执行器深度审查）：调度决策的结构化日志出口。
   *
   * 输出 JSON 面（单行，便于 grep/日志系统索引）：
   * - poolSize：SQL Top-K 后的候选池基数（pinned=1）；
   * - afterFilters：group/tags/runtime/interpreters 过滤后的剩余候选；
   * - scoredCount：参与计分的候选数（== afterFilters）；
   * - selected：选中执行器地址 + 评分 + 负载；
   * - topRunners：占坑前评分前三名（地址+评分+负载）——「为什么没派到某台」
   *   凭此可回溯（评分差距 / 落选者的负载）。过滤的逐项原因仍由
   *   applyInterpreterFilter 的失败快照日志兜底。
   */
  private logExecutionDispatchDecision(input: {
    taskName: string;
    executionId: string;
    poolSize: number;
    afterFilters: number;
    scoredCount: number;
    selected: Executor;
    scoredSnapshot: Array<{
      address: string;
      score: number;
      runningTaskCount: number;
      maxConcurrentTasks: number | null;
    }>;
    /**
     * ARCH-35 P1：部署归属偏好命中面。null = 偏好未适用（开关关 / 任务无
     * applicationId / 仓库未装配 / 查询失败 / deploymentPolicy=strict）。
     * 非 null 时 `preferred=0` 且 `runningDeployments=0` 表示该应用没有运行
     * 中的部署。
     */
    deploymentAffinity?: {
      preferred: number;
      matchedByExecutorId: number;
      matchedByAddressOnly: number;
      runningDeployments: number;
    } | null;
    /**
     * FEAT-22 方案 A v1：strict 部署约束面。null = 非 strict（显式 null 与
     * 缺字段可区分，同 deploymentAffinity 纪律）。setSize 含 stopped 行
     * （once 部署跑完即 stopped，正是约束必须覆盖的场景）；onlineInSet 是
     * 绕开 Top-K 直查的 ONLINE 命中数（过滤前）；过滤后剩余看 afterFilters。
     * v2：source = 模式来源（task=任务级 deploymentPolicy 覆盖 / global=全局
     * EXECUTOR_DEPLOYMENT_POLICY）。
     */
    deploymentConstraint?: {
      mode: "strict";
      source: "task" | "global";
      setSize: number;
      onlineInSet: number;
    } | null;
  }): void {
    const selectedScore =
      input.scoredSnapshot.find((s) => s.address === input.selected.address)
        ?.score ?? null;
    this.logger.log(
      JSON.stringify({
        event: "dispatch.decision",
        task: input.taskName,
        executionId: input.executionId,
        poolSize: input.poolSize,
        afterFilters: input.afterFilters,
        scoredCount: input.scoredCount,
        selected: {
          address: input.selected.address,
          score: selectedScore,
          runningTaskCount: input.selected.runningTaskCount,
          maxConcurrentTasks: input.selected.maxConcurrentTasks,
        },
        topRunners: input.scoredSnapshot,
        // ARCH-35 P1：部署归属偏好命中面（见调用点与入参注释）。null 时
        // 显式输出 null 而非省略——「没这个字段」与「偏好未适用」必须可区分。
        deploymentAffinity: input.deploymentAffinity ?? null,
        // FEAT-22：strict 部署约束面（null=非 strict）。判读：setSize>0 且
        // onlineInSet=0 → 集合设备全离线；onlineInSet>0 且 afterFilters=0 →
        // 集合设备被 group/tags/解释器过滤挡光；两者皆 >0 仍失败 → 占坑全落
        // 空（满载/占坑竞态）。运维据此区分「约束把任务卡在哪一层」。
        deploymentConstraint: input.deploymentConstraint ?? null,
      }),
    );
  }

  /**
   * MUTEX-01（应用互斥组）：单候选占坑。
   *
   * 返回值三态：
   * - "claimed"    占坑成功（无组：容量+在线原子 UPDATE 命中；有组：事务内
   *                容量+在线+组占用三闸全过，且已把执行行地址落库为占用标记）；
   * - "unavailable" 该候选离线或容量已满（与引入互斥前的失败语义一致）；
   * - "mutex_full"  该候选在线且有余位，但同设备同组占用已达组内并发数。
   *
   * ── 为什么挂组路径要事务 + executors 行锁 ────────────────────────────────
   * 占用账本从执行行推导（status='running' AND executorAddress AND mutexGroupId），
   * 而执行行地址在旧流程里要等 dispatch HTTP 返回后才由 processor finally 落库
   * ——窗口横跨整个 HTTP 时长，两个同组派发会在窗口内互相看不见对方，双双
   * 通过占用检查。修复：把「执行行落地址」挪进占坑事务，并用 `SELECT ... FOR
   * UPDATE` 先锁 executors 行——同设备派发在行锁上串行化，后到者的事务读到的
   * 占用计数必然包含先到者**已提交**的占用标记（先到者持锁期间写后提交，
   * 后到者拿到锁时其写已可见），竞态窗口归零。事务失败的候选整体回滚（含
   * 地址标记与 runningTaskCount 增量），换下一个候选。
   *
   * 无组执行保持原有单条 UPDATE（QA-05 论证见调用点注释）——默认人群零行为
   * 变化、零事务开销。
   *
   * 组配置缺失（执行创建后组被删）：快照仍在但约束源已消失，按用户删除意图
   * 降级为「不参与互斥」，走无组路径并 warn 一次。
   */
  private async claimExecutorSlotForExecution(
    candidate: Executor,
    execution: TaskExecution,
  ): Promise<"claimed" | "unavailable" | "mutex_full"> {
    const legacyClaim = async (): Promise<"claimed" | "unavailable"> => {
      const maxConcurrent = candidate.maxConcurrentTasks ?? Infinity;
      // 原子占坑：容量与在线状态在同一条 UPDATE 内复查（无需版本谓词）
      const result = await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => '"runningTaskCount" + 1' })
        .where("id = :id", { id: candidate.id })
        .andWhere("status = :status", { status: ExecutorStatus.ONLINE })
        .andWhere(
          maxConcurrent === Infinity ? "1=1" : '"runningTaskCount" < :max',
          maxConcurrent === Infinity ? {} : { max: maxConcurrent },
        )
        .execute();
      return result.affected && result.affected > 0 ? "claimed" : "unavailable";
    };

    if (!execution.mutexGroupId) return legacyClaim();

    if (!this.mutexGroupRepo) {
      // 单测/极简装配未提供仓库：互斥约束无法求值，降级为不参与互斥（与
      // 组被删同向——宁可不约束，不可派不出去）。
      this.logger.warn(
        `MUTEX-01: MutexGroup 仓库未装配，执行 ${execution.id} 本次派发不参与互斥`,
      );
      return legacyClaim();
    }

    const group = await this.mutexGroupRepo.findOne({
      where: { id: execution.mutexGroupId },
    });
    if (!group) {
      this.logger.warn(
        `MUTEX-01: 执行 ${execution.id} 的互斥组 ${execution.mutexGroupId} 已不存在，` +
          `本次派发不参与互斥（组删除后快照执行按无组语义走完）`,
      );
      return legacyClaim();
    }

    // N-15：组作用域——device=单点互斥（同设备×同组，存量行为）；
    // global=全局互斥（组内跨设备串行，单点登录顶号类场景）。
    const isGlobal = group.scope === "global";

    return this.repo.manager.transaction(async (manager) => {
      // 0) 全局档：组行锁先于执行器行锁（固定锁序 组→执行器 防死锁）。
      //    跨设备派发的竞争者在组行锁上串行化——设备档靠同设备 executors 行
      //    锁关闭竞态，全局档的竞争者派往不同设备、行锁互不相干，必须用组行
      //    锁串行化，占用计数读到的才必含先到者已提交的标记。
      if (isGlobal) {
        await manager.query(
          `SELECT "id" FROM "mutex_groups" WHERE "id" = $1 FOR UPDATE`,
          [execution.mutexGroupId],
        );
      }

      // 1) 行锁串行化：同设备的并发派发在此排队，锁内读到的占用状态必含
      //    先到者已提交的标记（竞态关闭的关键，见方法头注）。
      const lockRows: Array<{
        address: string;
        status: string;
        runningTaskCount: number;
        maxConcurrentTasks: number | null;
      }> = await manager.query(
        `SELECT "address", "status"::text AS "status", "runningTaskCount", "maxConcurrentTasks"
         FROM "executors" WHERE "id" = $1 FOR UPDATE`,
        [candidate.id],
      );
      const row = lockRows[0];
      if (!row || row.status !== ExecutorStatus.ONLINE) return "unavailable";
      const maxConcurrent = row.maxConcurrentTasks ?? Infinity;
      if (row.runningTaskCount >= maxConcurrent) return "unavailable";

      // 2) 组占用闸：device 档=同设备 × 同组（部分索引
      //    idx_task_executions_group_occupancy 服务）；global 档=同组跨设备
      //    （组维度部分索引 idx_task_executions_group_occupancy_global 服务）。
      //    global 档 maxConcurrentPerDevice 语义升级为组内全平台并发数。
      //    global 档必须排除执行自身行：本执行在 dispatch 前已被 claim 为
      //    RUNNING（executorAddress 未落），不带设备条件的计数会把自己数进
      //    去 → maxConcurrentPerDevice=1 时自己等自己（2026-10-02 双执行器
      //    e2e 实证；设备档靠地址谓词天然自排除）。
      const occRows: Array<{ count: number }> = isGlobal
        ? await manager.query(
            `SELECT COUNT(*)::int AS count FROM "task_executions"
             WHERE "mutexGroupId" = $1 AND "status" = 'running' AND "id" <> $2`,
            [execution.mutexGroupId, execution.id],
          )
        : await manager.query(
            `SELECT COUNT(*)::int AS count FROM "task_executions"
             WHERE "executorAddress" = $1 AND "mutexGroupId" = $2 AND "status" = 'running'`,
            [row.address, execution.mutexGroupId],
          );
      if ((occRows[0]?.count ?? 0) >= group.maxConcurrentPerDevice) {
        return "mutex_full";
      }

      // 3) 占用标记 + 槽位增量同事务落库：与容量增量原子共生，回滚同生共死。
      //    条件 status='running' 与 processor 的 claim 一致（本执行在 dispatch
      //    前必已被 claim 为 RUNNING；条件兜底防异常装配下的幽灵标记）。
      await manager.query(
        `UPDATE "task_executions" SET "executorAddress" = $1
         WHERE "id" = $2 AND "status" = 'running'`,
        [row.address, execution.id],
      );
      await manager.query(
        `UPDATE "executors" SET "runningTaskCount" = "runningTaskCount" + 1 WHERE "id" = $1`,
        [candidate.id],
      );
      this.logger.debug(
        `MUTEX-01: 执行 ${execution.id}（组 ${group.name}${isGlobal ? "，全局互斥" : ""}）占坑 ${row.address} ` +
          `（组占用 ${occRows[0]?.count ?? 0}+1/${group.maxConcurrentPerDevice}${isGlobal ? "，全平台" : "/设备"}）`,
      );
      return "claimed";
    });
  }

  /**
   * A-4（执行器域审计 P2）：非 strict 派发的候选池查询——把任务的过滤条件
   * 下推进 SQL，使 Top-K 截断发生在**过滤之后**。
   *
   * 背景：fleet 查询原先无条件按 runningTaskCount 升序取前 candidatePoolSize
   * （默认 500）行，group/tags/affinity/runtime 过滤发生在 SQL 之后的内存里。
   * 在线机队 > candidatePoolSize 时，组内/标签命中的执行器可能整体排在 K 名
   * 之外，请求会误报 "No online executors match ..."（strict 部署约束早已为
   * 同一原因绕开 Top-K，见 findOnlineExecutorsInDeploymentSet——本方法把同样
   * 的正确性带给非 strict 的 fleet 查询）。
   *
   * 下推维度与 dispatch 内存过滤链的对应（内存链原样保留，SQL 只做池收窄）：
   *   - executorAppName / executorGroup 等值 → FindOptionsWhere；
   *   - executorTags（AND 子集）/ affinity（OR 命中）/ anti-affinity（排除）/
   *     runtime（capabilities 包含，空 = 万能）→ QueryBuilder 谓词。tags /
   *     capabilities 是 simple-array 列（逗号连接字符串），','||col||',' 后按
   *     ',v,' 匹配保证整词命中；tag 里的 LIKE 通配符（%/_）只会让谓词更宽
   *     （超集），由保留的内存过滤链兜住，不会放行不满足条件的执行器。
   *   - 解释器缓存池匹配（interpreterSatisfies 的版本比较语义）无法下推，
   *     保持内存过滤——大机队 + 声明 runtimeVersion 时仍存在截断盲区（已知
   *     局限，如需覆盖须按解释器维度物化可下推的判据列）。
   */
  private async findFleetCandidates(task: Task): Promise<Executor[]> {
    const needsPushdown = Boolean(
      (task.executorTags && task.executorTags.length > 0) ||
      (task.executorAffinityTags && task.executorAffinityTags.length > 0) ||
      (task.executorAntiAffinityTags &&
        task.executorAntiAffinityTags.length > 0) ||
      task.runtime,
    );
    if (!needsPushdown) {
      // 无可下推的子集/包含维度：保持原 repo.find 形态（等值条件并入 where
      // ——appName/group 点名此前也依赖 Top-K 后的内存过滤，同样有截断盲区）。
      return this.repo.find({
        where: {
          status: ExecutorStatus.ONLINE,
          ...(task.executorAppName ? { appName: task.executorAppName } : {}),
          ...(task.executorGroup ? { groupName: task.executorGroup } : {}),
        },
        order: { runningTaskCount: "ASC" },
        take: this.candidatePoolSize,
      });
    }
    const qb = this.repo
      .createQueryBuilder("executor")
      .where("executor.status = :status", { status: ExecutorStatus.ONLINE })
      .orderBy("executor.runningTaskCount", "ASC")
      .take(this.candidatePoolSize);
    if (task.executorAppName) {
      qb.andWhere("executor.appName = :fleetAppName", {
        fleetAppName: task.executorAppName,
      });
    }
    if (task.executorGroup) {
      qb.andWhere("executor.groupName = :fleetGroupName", {
        fleetGroupName: task.executorGroup,
      });
    }
    // executorTags：AND 子集（内存链 2.2 同语义；NULL/缺 tags 不命中）。
    (task.executorTags ?? []).forEach((tag, i) => {
      qb.andWhere(`(',' || executor.tags || ',') LIKE :fleetReqTag${i}`, {
        [`fleetReqTag${i}`]: `%,${tag},%`,
      });
    });
    // affinity：OR 命中（内存链 2.2b 同语义；NULL tags 在 LIKE 之下自然不命中）。
    if (task.executorAffinityTags && task.executorAffinityTags.length > 0) {
      qb.andWhere(
        new Brackets((b) => {
          task.executorAffinityTags!.forEach((tag, i) => {
            b.orWhere(`(',' || executor.tags || ',') LIKE :fleetAffTag${i}`, {
              [`fleetAffTag${i}`]: `%,${tag},%`,
            });
          });
        }),
      );
    }
    // anti-affinity：排除语义（内存链 2.2b 同语义；NULL tags 无可排除，放行
    // ——注意 OR 分支必须包住整组 NOT LIKE：NULL AND  anything = NULL 会把
    // 无标签执行器误剔除）。
    if (
      task.executorAntiAffinityTags &&
      task.executorAntiAffinityTags.length > 0
    ) {
      qb.andWhere(
        new Brackets((b) => {
          b.where("executor.tags IS NULL").orWhere(
            new Brackets((b2) => {
              task.executorAntiAffinityTags!.forEach((tag, i) => {
                b2.andWhere(
                  `(',' || executor.tags || ',') NOT LIKE :fleetAntiTag${i}`,
                  { [`fleetAntiTag${i}`]: `%,${tag},%` },
                );
              });
            }),
          );
        }),
      );
    }
    // runtime：capabilities 包含（内存链 2.3 同语义——空/NULL = 万能）。
    if (task.runtime) {
      qb.andWhere(
        "(executor.capabilities IS NULL OR executor.capabilities = '' " +
          "OR (',' || executor.capabilities || ',') LIKE :fleetRuntime)",
        { fleetRuntime: `%,${task.runtime},%` },
      );
    }
    return qb.getMany();
  }

  async dispatch(task: Task, execution: TaskExecution) {
    let candidates: Executor[];
    // E-2: 决策日志的候选池基数（pinned=1；fleet 查询=SQL Top-K 后的行数；
    // FEAT-22 strict=部署集合 ∩ ONLINE 的行数）。
    let dispatchPoolSize = 0;
    // FEAT-22 方案 A v1：部署约束上下文——null=不适用（master 开关关 / 无
    // applicationId / strict 下集合为空）；mode=strict 时候选池已在下方收窄为
    // 部署集合。声明在 dispatch 作用域：占坑全落空的失败分支与决策日志都要读。
    // v2：source 记录模式来源（任务级覆盖 / 全局配置），决策日志可回溯
    // 「这次为什么按 strict 派」。
    let deploymentCtx: {
      mode: "prefer" | "strict";
      source: "task" | "global";
      rows: AppDeployment[];
    } | null = null;
    // strict 下解释器过滤的拒绝详情——中链不再立刻终态失败（见下方过滤链），
    // 推迟到占坑全落空的统一 WAITING 出口时，用它保留诊断信息。
    let strictFilterNote: string | null = null;

    if (task.executorId) {
      // R6: executor pinning — dispatch targets ONLY the pinned executor,
      // bypassing the fleet query and appName/group/tags/runtime filters.
      // The optimistic-lock slot increment below is still applied, so the
      // executor's maxConcurrentTasks cap and runningTaskCount bookkeeping
      // are respected; a pinned executor at capacity fails the dispatch
      // (no fallback to another executor — that is the point of pinning).
      const pinned = await this.repo.findOne({
        where: { id: task.executorId },
      });
      if (!pinned) {
        // No matching failureReason enum for "pinned target deleted/missing"
        // (EXECUTOR_OFFLINE would be a lie — it never registered here), so
        // the worker's message classifier leaves it UNKNOWN by design.
        throw new AppError("PINNED_EXECUTOR_NOT_FOUND", {
          executorId: task.executorId,
        });
      }
      if (pinned.status !== ExecutorStatus.ONLINE) {
        // ⚠️ 本文案与中台失败分类链是**跨文件耦合**（LANG-ERR-01 复查教训）：
        // 旧注释写「Message shape matches the worker's EXECUTOR_OFFLINE classifier
        // (task.processor.ts: /executor.*(offline|unavailable)/)」——那是**英文**
        // 形态的判据。文案经 LANG-ZH-01 中文化后，该断言不再成立，而分类链的
        // 中文支容差（原 20 字符）又短于本文案（执行器→离线 实测 63 字符），
        // 于是 pinned 离线被执行详情页错报成「脚本错误」（script_error）。
        // 现分类链中文支容差已放宽到单行 120（见 task.service.ts 该规则注释），
        // 并由 python-multiversion-write-path.spec.ts 的
        // 「executor_offline 中文化回归」用例**用码表渲染真实文案**钉住——
        // 改这里的码或改那边的正则，任一侧漂移都会立刻红。
        throw new AppError("PINNED_EXECUTOR_OFFLINE", {
          appName: pinned.appName,
          executorId: pinned.id,
        });
      }
      candidates = [pinned];
      dispatchPoolSize = 1;
      // python_task_multiversion（WS2 · CONTRACT §3.1 pinning 分支 / AC-08b /
      // D2③）：pinning **绕过** group/tags/runtime 过滤（pinning 的语义就是
      // "我指定这一台"），因此必须在此**单独补一道**解释器检查，且必须发生在
      // 下方原子占坑（runningTaskCount + 1）**之前**——占坑后才失败会把坑位
      // 白白占用到 TTL/回调超时，而 pinned 执行器永远不会回调。
      //
      // 消息含**声明版本**与 **pinned 执行器已缓存清单**（AC-08b 要求的
      // "至少一处明确报错"，此处即运行前报错）。
      if (
        hasRequestedVersion(task.runtimeVersion) &&
        !interpreterSatisfies(pinned.interpreters, task.runtimeVersion) &&
        // 在线可下载版本（3.8+）：pinned 执行器可自行 uv python install，不硬拦。
        // 仅离线层（3.7）才预检拦截——uv 无法在线下载，必须预填缓存卷。
        !isOnlineDownloadable((task.runtimeVersion as string).trim())
      ) {
        this.failInterpreterUnavailable(
          `[pinned] ${buildInterpreterMismatchMessage(
            (task.runtimeVersion as string).trim(),
            [{ appName: pinned.appName, interpreters: pinned.interpreters }],
          )}`,
        );
      }
    } else {
      // FEAT-22 方案 A v1：先解析部署约束（prefer→running 行做软偏好判据；
      // strict→「用户显式指定过」的部署集合做硬约束）。必须先于候选池查询：
      // strict 要按集合直查设备。appName 点名不叠加约束——显式指定单台是更强
      // 的用户意图（优先级 pin > appName > 部署约束 > 全机队，语义见
      // configuration.ts deploymentPolicy 注）。
      if (!task.executorAppName) {
        deploymentCtx = await this.resolveDeploymentConstraintContext(task);
      }
      const all =
        deploymentCtx?.mode === "strict"
          ? // strict：绕开下方 fleet SQL Top-K——Top-K 按 runningTaskCount 升序
            // 截断，负载高的部署设备可能根本不在候选池里，软偏好只是「池内
            // 前置」（池外无从谈起），硬约束则不能容忍这个截断盲区。
            await this.findOnlineExecutorsInDeploymentSet(deploymentCtx.rows)
          : // A-4: 非 strict 候选池——过滤条件下推进 SQL（见 findFleetCandidates），
            // Top-K 截断发生在过滤维度之后，不再误报 "No online executors match"。
            await this.findFleetCandidates(task);
      dispatchPoolSize = all.length;

      candidates = all;

      // 1. Exact match by appName (manually specified by user)
      if (task.executorAppName) {
        candidates = all.filter((e) => e.appName === task.executorAppName);
        if (candidates.length === 0) {
          throw new AppError("EXECUTOR_APP_NAME_NOT_FOUND", {
            appName: task.executorAppName,
          });
        }
        // python_task_multiversion（WS2 · CONTRACT §3.1）：appName 精确匹配是
        // **用户显式点名**（语义接近 pinning，与 executorId 的差别只是按名字
        // 而非 id 定位），故不静默换机器——不满足即失败，且**保留上方
        // appName 未命中时的既有消息形态**（该分支语义是"这台不存在"，
        // 与本分支的"这台存在但跑不了该版本"必须可区分）。
        const byName = this.applyInterpreterFilter(
          candidates,
          task.runtimeVersion,
        );
        if (byName.message) {
          this.failInterpreterUnavailable(byName.message);
        }
        candidates = byName.kept;
      } else {
        // 2. Filter by group/tag/runtime
        let filtered = all;

        // 2.1 Filter by group
        if (task.executorGroup) {
          filtered = filtered.filter((e) => e.groupName === task.executorGroup);
        }

        // 2.2 Filter by tag (task required tags must be a subset of executor tags)
        if (task.executorTags && task.executorTags.length > 0) {
          filtered = filtered.filter((e) => {
            if (!e.tags) return false;
            return task.executorTags!.every((tag) => e.tags!.includes(tag));
          });
        }

        // 2.2b NF-04: affinity / anti-affinity tag constraints — applied
        // BEFORE loadScore ordering (filter first, then pick by load; see the
        // scoring step below). Both are nullable: null/[] = unconstrained, so
        // legacy tasks take none of these branches and behavior is unchanged.
        //   affinity = OR semantics: an executor holding ANY of the tags
        //   qualifies (soft routing intent — loadScore still optimizes inside
        //   the matched set); orthogonal to executorTags (2.2, hard AND
        //   subset), both may be set on the same task.
        if (task.executorAffinityTags && task.executorAffinityTags.length > 0) {
          filtered = filtered.filter((e) => {
            if (!e.tags) return false;
            return task.executorAffinityTags!.some((tag) =>
              e.tags!.includes(tag),
            );
          });
        }
        //   anti-affinity = exclusion semantics: an executor holding ANY of
        //   the tags is dropped. Combined with affinity this yields the
        //   intersection (affinity matches minus anti-affinity matches); with
        //   no affinity it simply prunes the fleet.
        if (
          task.executorAntiAffinityTags &&
          task.executorAntiAffinityTags.length > 0
        ) {
          filtered = filtered.filter((e) => {
            if (!e.tags) return true;
            return !task.executorAntiAffinityTags!.some((tag) =>
              e.tags!.includes(tag),
            );
          });
        }

        // 2.3 Filter by runtime/capabilities
        if (task.runtime) {
          filtered = filtered.filter((e) =>
            !e.capabilities || e.capabilities.length === 0
              ? true
              : e.capabilities.includes(task.runtime),
          );
        }

        // 2.4 python_task_multiversion（WS2 · CONTRACT §3.1）：解释器缓存池
        // 过滤——追加在既有 runtime/capabilities 过滤**之后**（过滤顺序：
        // group → tags → affinity/anti-affinity → runtime → interpreter →
        // loadScore）。失败消息含每个候选的已缓存解释器快照（AC-09b）。
        const interpreterFiltered = this.applyInterpreterFilter(
          filtered,
          task.runtimeVersion,
        );
        if (interpreterFiltered.message) {
          if (deploymentCtx?.mode === "strict") {
            // strict：集合内设备缺解释器不立刻终态失败（设备装上解释器后同一
            // 执行可自愈，与「集合暂不可用 → WAITING 排队」同向）——推迟到占坑
            // 全落空的统一 WAITING 出口，note 保留逐台 mismatch 诊断。
            strictFilterNote = interpreterFiltered.message;
          } else {
            this.failInterpreterUnavailable(interpreterFiltered.message);
          }
        }
        filtered = interpreterFiltered.kept;

        // strict：集合内全部被过滤也不在这里抛——空候选安全流过评分/占坑链
        // （estimatedDurationsByExecutor 对空数组零查询返回空 Map，占坑循环
        // 空转），由 !matched 的统一出口抛 DeploymentConstraintWaitError，
        // 失败消息带上「集合 N 台/在线 M 台/过滤后 0 台」的完整口径。
        if (filtered.length === 0 && deploymentCtx?.mode !== "strict") {
          throw new AppError("NO_EXECUTOR_MATCHING_FILTERS");
        }
        candidates = filtered;
      }
    }

    // 3. Weighted scoring via the shared CORE-05 formula (load 50% + CPU 25% +
    // mem 25% + long-task penalty 10%, see executor-score.util.ts), try
    // optimistic lock in order.
    const estimatedDurations =
      await this.estimatedDurationsByExecutor(candidates);
    const withScores = candidates.map((c) => ({
      executor: c,
      score: computeExecutorLoadScore(c, {
        estimatedDurations: estimatedDurations.forExecutor(c),
      }),
    }));
    // E-2（中台↔执行器深度审查）：占坑前的**评分快照**（occupation 会原地
    // 改 runningTaskCount/version，必须在 mutate 之前截取，供决策日志回溯）。
    const scoredSnapshot = withScores
      .slice()
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map((s) => ({
        address: s.executor.address,
        score: Number(s.score.toFixed(3)),
        runningTaskCount: s.executor.runningTaskCount,
        maxConcurrentTasks: s.executor.maxConcurrentTasks,
      }));
    const sorted = withScores
      .sort((a, b) => a.score - b.score)
      .map((s) => s.executor);

    // 3b. ARCH-35 P1（生产事故 2026-09-23）：**部署归属偏好**。
    //
    // 位置刻意选在「评分排序之后、原子占坑之前」：
    //   - 必须在排序**之后**：分区只调整分组、组内保序，故组内首选仍是评分
    //     最优者。若在排序前分区，紧接着的全量 sort 会把分组彻底打散（本文件
    //     上方 `withScores.sort` 是稳定排序但键是 score，分组信息不参与比较）。
    //   - 必须在占坑**之前**：占坑循环按 `sorted` 顺序逐个尝试，前置的部署
    //     执行器因此被优先占用；它满了/离线了，循环继续往下走 → **自动降级
    //     回全机队**，零新增失败面（`ordered` 与入参同元素集）。
    //
    // 语义是「偏好」而非「过滤」：执行器侧的任务执行**不依赖**本地是否部署过
    // 该应用（部署产物树 `<workDir>/apps/<appId>/` 与执行树
    // `<workDir>/<executionId>/` 互不相交；executor-python 甚至没有 deploy
    // 路由）。硬过滤会把全部未部署任务与 python 执行器踢出候选集 → 派发失败。
    // 完整论证见 executor-deployment-affinity.util.ts 头注。
    //
    // `scoredSnapshot`（上方）保持为**纯评分**前三名不变——决策日志里的 score
    // 必须始终是真实负载分，否则「为什么选这台」无法回溯。偏好命中面另记
    // `deploymentAffinity` 字段。
    // 3b-ARCH-35 P1：部署归属**软偏好**（deploymentPolicy=prefer，现状不变）
    // ——上下文已在候选池查询前解析（deploymentCtx），此处不再二次查库。
    // 3b-FEAT-22：strict 模式**跳过**分区——候选集已经是部署集合本身（约束
    // 收窄发生在池查询之前），分区只会把全部候选前置（无信息量），决策日志
    // 改记 deploymentConstraint。
    const preferRows =
      deploymentCtx && deploymentCtx.mode === "prefer"
        ? deploymentCtx.rows
        : null;
    let deploymentAffinity: {
      preferred: number;
      matchedByExecutorId: number;
      matchedByAddressOnly: number;
      runningDeployments: number;
    } | null = null;
    // FEAT-22：strict 约束的决策日志面（null=非 strict，与 deploymentAffinity
    // 同款「显式 null 而非缺字段」纪律）。onlineInSet 取自 dispatchPoolSize
    // （= 集合 ∩ ONLINE 直查行数，过滤前）；过滤后剩余即下方 afterFilters。
    // v2：source = 模式来源（task=任务级覆盖 / global=全局配置）。
    let deploymentConstraint: {
      mode: "strict";
      source: "task" | "global";
      setSize: number;
      onlineInSet: number;
    } | null = null;
    if (deploymentCtx?.mode === "strict") {
      deploymentConstraint = {
        mode: "strict",
        source: deploymentCtx.source,
        setSize: deploymentCtx.rows.length,
        onlineInSet: dispatchPoolSize,
      };
    }
    let orderedCandidates = sorted;
    if (preferRows) {
      const affinity = partitionByDeploymentAffinity(sorted, preferRows);
      orderedCandidates = affinity.ordered;
      deploymentAffinity = {
        preferred: affinity.preferredCount,
        matchedByExecutorId: affinity.matchedByExecutorId,
        matchedByAddressOnly: affinity.matchedByAddressOnly,
        runningDeployments: affinity.runningDeployments,
      };
      if (affinity.preferredCount > 0) {
        this.logger.log(
          `ARCH-35: 任务 "${task.name}" 关联应用 ${task.applicationId} 的部署归属命中 ` +
            `${affinity.preferredCount} 台候选执行器（id 命中 ${affinity.matchedByExecutorId} / ` +
            `address 兜底 ${affinity.matchedByAddressOnly}），已前置优先占坑`,
        );
      }
    }
    if (deploymentConstraint) {
      this.logger.log(
        `FEAT-22: 任务 "${task.name}" 关联应用 ${task.applicationId} 启用部署约束` +
          `（strict）：候选集收窄为已部署设备（集合 ${deploymentConstraint.setSize} 台，` +
          `在线 ${deploymentConstraint.onlineInSet} 台），集合全部不可派发时排队等待、不换机`,
      );
    }

    // QA-05/BUG-22：这里原先是「版本 CAS 占坑」——`.andWhere("version = :version")`
    // 用读取时的 version 做乐观锁。它把**良性并发**误判成失败：worker 并发 5 +
    // 单执行器时，第一个占坑成功就把 version +1，其余并发请求的 CAS 全部 affected=0；
    // 候选人只有一个 → 直接抛 "No available executor (all at capacity or
    // concurrency conflict)" → 执行 FAILED（maxRetry=0 时没有任何重试兜底）。
    // QA-05 本机实测：100 并发下成功率被此冲突主导（调大 MAX_CONCURRENT 只能
    // 40%→65%，因为失败根因不是容量而是 CAS）。
    //
    // 关键事实：占坑的两个不变量**本来就由同一条 UPDATE 的 WHERE 原子保证**——
    // ① 容量不超卖：`runningTaskCount < max` 与 `runningTaskCount + 1` 在同一条
    //    SQL 里求值（行锁串行化）；
    // ② 目标仍在线：`status = ONLINE` 同样在同一条 UPDATE 内复查（读取与写入之间
    //    被置 OFFLINE 的行会被这条 UPDATE 挡掉）。
    // 因此 version 谓词是**冗余**的，代价却是把并发占坑变成硬失败 —— 移除它，
    // 不变量不变，失败面收敛为「真的没容量/真的离线」。
    //
    // MUTEX-01（应用互斥组）：占坑升级为 `claimExecutorSlotForExecution`——
    // 无组执行走原有单条 UPDATE（逐字节不变）；挂组执行在事务内加「同设备×
    // 同组占用 < 组内并发数」闸。全部候选都因互斥满载而落空时抛 MutexWaitError
    // （processor 置 WAITING 排队，不烧重试预算）；至少一个候选是纯容量/离线
    // 落空时保持原有失败语义（BullMQ 重试）——容量满载的排队语义不在本特性
    // 范围内，不因互斥存在而改变。
    let matched: Executor | null = null;
    let anyMutexBlocked = false;
    for (const candidate of orderedCandidates) {
      const outcome = await this.claimExecutorSlotForExecution(
        candidate,
        execution,
      );
      if (outcome === "claimed") {
        candidate.runningTaskCount += 1;
        candidate.version += 1;
        matched = candidate;
        break;
      }
      if (outcome === "mutex_full") anyMutexBlocked = true;
      // "unavailable"（已满/已离线，并发占坑不再是失败来源）：试下一个候选
    }

    if (!matched) {
      if (anyMutexBlocked) {
        throw new MutexWaitError(
          `任务 "${task.name}" 的所有候选设备上互斥组占用已满，执行进入排队等待`,
        );
      }
      // FEAT-22 方案 A v1：strict 部署约束下集合全部不可派发 → DeploymentConstraintWaitError
      // （processor 与 MutexWaitError 同位识别，置 WAITING 不烧重试预算，10s
      // sweep 唤醒重试）。互斥分支优先：互斥排队有同组探针短路，唤醒更省。
      if (deploymentCtx?.mode === "strict") {
        throw new DeploymentConstraintWaitError(
          `任务 "${task.name}" 的部署约束设备集合当前全部不可派发` +
            `（集合 ${deploymentCtx.rows.length} 台，在线 ${dispatchPoolSize} 台，` +
            `过滤后可用 ${candidates.length} 台` +
            `${strictFilterNote ? `；解释器过滤：${strictFilterNote}` : ""}），` +
            `执行进入排队等待、不换机。解除约束：删除该应用的部署记录` +
            `（running 行先停止），或将 EXECUTOR_DEPLOYMENT_POLICY 切回 prefer`,
        );
      }
      throw new AppError("NO_DISPATCHABLE_EXECUTOR");
    }

    // E-2（中台↔执行器深度审查）：调度决策**结构化日志**——之前只有一行
    // `Dispatching task ... to executor ...`，运维无法回溯「为什么选这台、过滤
    // 掉多少、评分多少、落选者差在哪」。现输出 JSON 面：候选池数（SQL Top-K 后）、
    // 过滤后数、评分/容量后的计分面、选中者评分、前三名落选者（地址+评分+负载）
    // ——「为何没派到某台」凭此可查（group/tags/interpreters 过滤的逐项原因仍由
    // applyInterpreterFilter 的失败快照日志兜底）。
    this.logExecutionDispatchDecision({
      taskName: task.name,
      executionId: execution.id,
      poolSize: dispatchPoolSize,
      afterFilters: candidates.length,
      scoredCount: withScores.length,
      selected: matched,
      scoredSnapshot,
      // ARCH-35 P1：部署归属偏好命中面（null = 偏好未适用：开关关/无
      // applicationId/仓库未装配/读失败）。运维据此区分「没部署」与
      // 「部署了但没命中候选」——前者 preferred=0 且 runningDeployments=0，
      // 后者 runningDeployments>0 而 preferred=0（部署那台不在候选池里，
      // 例如被 group/tags/runtime 过滤掉或已离线）。
      deploymentAffinity,
      // FEAT-22：strict 部署约束面（null=非 strict，见方法注释的判读口径）。
      deploymentConstraint,
    });

    this.logger.log(
      `Dispatching task "${task.name}" to executor ${matched.address} (runningTasks=${matched.runningTaskCount})`,
    );
    execution.executorAddress = matched.address;
    // ADR-017 阶段 3：同时落**行身份**。`executorAddress` 在 pull 同址多行并存
    // 时不再唯一（ADR-017 §5），重启恢复/产物归属/互斥占用等按地址匹配的面会
    // 命中别人的行。executorId 是稳定且唯一的行键（存量行可空 → 那些面回落
    // 地址匹配，与引入前逐字节一致）。
    execution.executorId = matched.id;

    try {
      // SEC-02: params + decrypted secrets（secrets 覆盖同名 params，仅进派发载荷不落库）
      const dispatchParams = this.buildDispatchParams(task, execution);
      // SEC-02 续：secrets 另发一份，供执行器按**原名**注入（第三方 SDK 认规范名）。
      const dispatchSecrets = this.buildDispatchSecrets(task);
      // python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：zip 渠道任务的
      // `packageUrl` 由 admin 解析后附加到**下发 task 对象**上（push/pull 两条
      // 传输分支共用同一份；解析失败在此抛出 → 走下方同一 catch 回滚占坑）。
      // 注意 `task` 本体是托管实体，故附加发生在**副本**上，绝不改持久化实体。
      // FEAT-22 配套观测：解析到的版本落执行行留痕（null=非 zip 渠道）。
      // 载荷契约只增 packageUrl（Task 类型不声明该字段，与既有注入方式一致），
      // 类型面经窄化读取；非 zip 渠道 resolveDispatchTask 原样返回，值为 null。
      const { task: dispatchTask, packageVersion } =
        await this.resolveDispatchTask(task);
      // FEAT-22 方案 B（版本跟随部署）：命中部署设备时改跑该设备部署行记录
      // 的当版包——「指定机器 + 指定版本」闭环的后半段。仅 zip 渠道参与
      // （git/glue 任务的代码来自仓库/脚本，部署版本无关；判据 = 解析副本
      // 已带 packageUrl）且 deploymentCtx 存在（pin/appName/broadcast 版本
      // 语义保持当前版，方法注释）。兜底见 resolveVersionFollowPackage：
      // 任何解析不成立都回退当前版 + warn。
      let effectiveTask = dispatchTask;
      let effectiveVersion = packageVersion;
      const currentPackageUrl = (dispatchTask as { packageUrl?: string })
        .packageUrl;
      if (
        deploymentCtx &&
        typeof currentPackageUrl === "string" &&
        currentPackageUrl.length > 0
      ) {
        const follow = await this.resolveVersionFollowPackage(
          task,
          matched,
          deploymentCtx.rows,
        );
        if (follow) {
          // 载荷契约只增 packageUrl（Task 类型不声明，同 resolveDispatchTask
          // 的注入方式）；版本跟随在解析副本上覆盖，绝不改持久化实体。
          effectiveTask = {
            ...dispatchTask,
            packageUrl: follow.packageUrl,
          } as typeof dispatchTask;
          effectiveVersion = follow.version;
          this.logger.log(
            JSON.stringify({
              event: "dispatch.versionFollow",
              task: task.name,
              executionId: execution.id,
              executor: matched.address,
              version: follow.version,
              // 方案 B 生效的版本来源快照包（区别于应用当前版 packageUrl）。
              packageUrl: follow.packageUrl,
            }),
          );
        }
      }
      execution.resolvedPackageUrl =
        (effectiveTask as { packageUrl?: string }).packageUrl ?? null;
      execution.resolvedPackageVersion = effectiveVersion;
      // OBS-01: W3C traceparent（disabled 时零注入，语义为无 trace）。
      const traceHeaders: Record<string, string> = {};
      this.tracing?.injectContext(
        traceHeaders,
        this.buildExecutionTraceparent(execution),
      );

      // ARCH-32（ADR-015）: pull 模式传输分支——占坑/选择语义与 push 完全
      // 一致（上方同一条 UPDATE），仅把「入站 POST」换成「Redis 队列入队 +
      // 执行器长轮询取件」。入队失败走下方同一 catch（回滚占坑 + 重试语义）。
      if (matched.dispatchMode === "pull") {
        if (!this.pullService) {
          throw new AppError("EXECUTOR_PULL_UNAVAILABLE");
        }
        const endPullSpan = this.tracing?.startSpan(
          execution.traceId,
          "dispatch.pull",
          { executor: matched.id, executionId: execution.id },
        );
        await this.pullService.enqueue(matched.id, {
          executionId: execution.id,
          task: effectiveTask,
          params: dispatchParams,
          // SEC-02 续：secrets 单独下发一份供执行器按原名注入（纯增量字段，
          // 旧执行器忽略它，见 buildDispatchSecrets 的注释）。
          secrets: dispatchSecrets,
          // push 经 HTTP 头携带 traceparent；pull 只能并入载荷本体，
          // 执行器侧 pull 循环以同语义注入 AUTOFLOW_TRACE_ID。
          traceparent: traceHeaders["traceparent"],
        });
        endPullSpan?.();
        this.logger.log(
          `Dispatching task "${task.name}" to pull executor ${matched.id} (${matched.address}) via pull queue`,
        );
        return {
          status: "queued",
          executionId: execution.id,
          dispatchMode: "pull",
        };
      }

      // F-3: SSRF guard — the address is executor-controlled (register/heartbeat),
      // so block metadata/loopback/link-local targets before sending the
      // authenticated request. A blocked address rolls back the slot below.
      // F-3 (SEC-NEW): pin the connection to the validated IP (Host/SNI kept).
      const url = this.getExecutorUrl(matched.address, "api/execute");
      const pinned = await assertAndPinExecutorUrl(url);
      const sharedToken = await this.getSharedToken();
      const pinCfg = pinnedAxiosConfig(pinned);
      const headers: Record<string, string> = {};
      if (sharedToken) headers["Authorization"] = `Bearer ${sharedToken}`;
      if (traceHeaders["traceparent"]) {
        headers["traceparent"] = traceHeaders["traceparent"];
      }
      const endSpan = this.tracing?.startSpan(
        execution.traceId,
        "dispatch.http",
        { executor: matched.address, executionId: execution.id },
      );
      const resp = await axios.post(
        url,
        {
          executionId: execution.id,
          task: effectiveTask,
          params: dispatchParams,
          // SEC-02 续：secrets 单独下发一份供执行器按原名注入（纯增量字段）。
          secrets: dispatchSecrets,
        },
        {
          timeout: ((task.timeout || 300) + 10) * 1000,
          headers,
          maxRedirects: 0, // R3 parity: 首跳是唯一经 SSRF 校验的地址
          ...pinCfg,
        },
      );
      endSpan?.();
      return resp.data;
    } catch (err: unknown) {
      // Rollback counter on dispatch failure to avoid leaks
      await this.repo
        .createQueryBuilder()
        .update(Executor)
        .set({ runningTaskCount: () => 'GREATEST("runningTaskCount" - 1, 0)' })
        .where("id = :id", { id: matched.id })
        .execute();
      // MUTEX-01：挂组执行在占坑事务内已把地址落库为占用标记（status 仍为
      // running）。占坑回滚时必须同步清除标记——占用从执行行推导，不清除
      // 则该执行以「running + 地址」继续占着组位，同组后续派发被幽灵占用
      // 挡住（这是「无第二账本」设计的代价：释放也是对执行行的写）。条件
      // 带地址防误清（重试路径已换候选时不动新标记）。
      if (execution.mutexGroupId) {
        await this.execRepo
          .createQueryBuilder()
          .update(TaskExecution)
          .set({ executorAddress: null })
          .where("id = :id", { id: execution.id })
          .andWhere("executorAddress = :addr", { addr: matched.address })
          .execute();
      }
      this.tracing
        ?.startSpan(execution.traceId, "dispatch.http", {
          executor: matched.address,
          executionId: execution.id,
        })
        ?.call(this, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * OBS-01: 由执行行上的 traceId 构造回传/透传 traceparent 头值。
   * traceId 为 null（追踪未开启）或非法时返回 null——injectContext 不注入。
   */
  private buildExecutionTraceparent(
    execution: Pick<TaskExecution, "traceId">,
  ): string | null {
    return this.tracing?.buildTraceparentFromTraceId(execution.traceId) ?? null;
  }

  /**
   * python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：解析 zip 渠道任务的
   * `packageUrl` 并**附加到下发 task 对象**上。
   *
   * 为什么必须由 admin 解析：任务实体只持 `applicationId` **弱引用**（无关系
   * 属性），执行器拿到 `task` 后无法自行查库；`packageUrl` 又只在
   * `applications` 表上。
   *
   * 触发条件（契约字面）：`task.codeSource === 'application_zip'` **或**
   * `applicationId` 非空（**并集**——存量 zip 任务在 WS1 回填 codeSource 之前
   * 就已存在，只认 codeSource 会让它们静默下发无 packageUrl 的任务）。
   *
   * A4（第三轮审计·高）：返回的 task 恒为**白名单挑选副本**（不再整实体
   * 直传）——此前非 zip 渠道返回原实体引用、zip 渠道返回 `{...task}` 整实体
   * 展开，任务行的全部列（调度面/内部面字段）都被序列化进 HTTP 载荷与 Redis
   * pull 队列。白名单 = 协议 TaskConfig 声明字段 ∪ 三端执行器实际读取字段
   * （推导过程与逐字段论证见 dispatch-task-payload.util.ts 头注），webhookSecret
   * 即便被 addSelect 带出也进不了载荷。
   *
   * 返回值语义：
   * - 恒返回新对象（绝不改持久化实体：`task` 是 TypeORM 托管行，写入非列
   *   字段会污染实体并可能被 save() 误判）；
   * - zip 渠道副本额外带解析出的 `packageUrl`；
   * - 解析不到（repo 未装配 / 应用不存在 / `packageUrl` 为空）→ 抛错，派发失败，
   *   消息明确。**不静默降级**：下发无 packageUrl 的 zip 任务会让执行器在运行时
   *   才炸，且分因落在执行器侧（PACKAGE_FETCH_FAILED），与真实原因不符。
   */
  /**
   * zip 渠道任务的 packageUrl 解析（python_task_multiversion · CONTRACT §2.4）。
   *
   * FEAT-22 配套观测：返回值从「任务副本」扩展为「任务副本 + 解析到的应用版
   * 本」——调用方把两者落执行行（resolvedPackageUrl/resolvedPackageVersion），
   * 「这次执行跑的是哪版」从此可回溯（任务恒跑应用当前上传版本，此前执行行
   * 不留痕，应用连续上传多版后版本不可追溯）。版本**不进派发载荷**（载荷契约
   * 只增 packageUrl），仅落库。
   */
  private async resolveDispatchTask(task: Task): Promise<{
    task: DispatchTaskPayload;
    packageVersion: string | null;
  }> {
    // 并集语义（NFR-05）：codeSource 明确为 application_zip → zip 渠道；
    // codeSource 为 NULL（存量未回填）且 applicationId 非空 → zip 渠道兜底；
    // codeSource 明确为 git/glue → 非 zip 渠道，**即使 applicationId 残留也不进 zip**
    // （存量 git/glue 行的 applicationId 弱引用可能未清，若 application 已删除，
    //  误进 zip 路径会让 git 任务派发失败且消息指向 application，误导排查）。
    // F-02（本轮审计）: 并集判定用 `== null` 同时覆盖 null 与 undefined——任务
    // 对象经 BullMQ 队列载荷序列化/反序列化或部分 select 投影后 codeSource 可能
    // 为 undefined，`undefined === null` 为 false 会让存量 zip 任务误出 zip 渠道，
    // packageUrl 不被解析，执行器运行时才炸。
    const isZipChannel =
      task.codeSource === TaskCodeSource.APPLICATION_ZIP ||
      (task.codeSource == null && Boolean(task.applicationId));
    if (!isZipChannel)
      return { task: buildDispatchTaskPayload(task), packageVersion: null };
    if (!task.applicationId) {
      // codeSource=application_zip 但无 applicationId：WS1 写面已互斥校验
      // （CONTRACT §2.1「codeSource=application_zip 时 applicationId 必填」），
      // 走到这里说明是迁移前的存量脏行或外部直写——派发失败，消息明确。
      throw new AppError("PACKAGE_URL_APPLICATION_ID_MISSING", {
        taskName: task.name,
        taskId: task.id,
      });
    }
    if (!this.applicationRepo) {
      throw new AppError("PACKAGE_URL_REPO_UNAVAILABLE", {
        taskName: task.name,
        taskId: task.id,
      });
    }
    // F-08（本轮审计）: 命中未过期的正缓存 → 直接附加，跳过 DB 往返。
    const cached = this.packageUrlCache.get(task.applicationId);
    if (cached) {
      if (
        Date.now() - cached.cachedAt <
        ExecutorService.PACKAGE_URL_CACHE_TTL_MS
      ) {
        return {
          task: buildDispatchTaskPayload(task, cached.packageUrl),
          packageVersion: cached.packageVersion,
        };
      }
      // 惰性淘汰过期条目（positive-only：失败态从不入缓存，无需清理）。
      this.packageUrlCache.delete(task.applicationId);
    }
    const app = await this.applicationRepo.findOne({
      where: { id: task.applicationId },
      select: { id: true, name: true, packageUrl: true, version: true },
    });
    if (!app) {
      throw new AppError("PACKAGE_URL_APPLICATION_NOT_FOUND", {
        taskName: task.name,
        taskId: task.id,
        applicationId: task.applicationId,
      });
    }
    if (typeof app.packageUrl !== "string" || app.packageUrl.length === 0) {
      throw new AppError("PACKAGE_URL_NOT_CONFIGURED", {
        taskName: task.name,
        taskId: task.id,
        appName: app.name,
        applicationId: app.id,
      });
    }
    const packageVersion =
      typeof app.version === "string" && app.version.length > 0
        ? app.version
        : null;
    this.packageUrlCache.set(task.applicationId, {
      packageUrl: app.packageUrl,
      packageVersion,
      cachedAt: Date.now(),
    });
    return {
      task: buildDispatchTaskPayload(task, app.packageUrl),
      packageVersion,
    };
  }

  /**
   * ARCH-35 P1（生产事故 2026-09-23）+ FEAT-22 方案 A v1/v2（生产反馈 2026-09-30）：
   * 读取「该应用部署在哪些执行器上」，并给出本次派发的约束模式。
   *
   * 事故主因：`app_deployments` 行记了 `executorId`/`executorAddress`，但
   * manifest 驱动的任务自动注册不写 `task.executorId` → 任务恒走全机队分支 →
   * 纯按负载挑一台 → 部署在执行器 A 的应用，任务跑到了 B。选执行器时**全仓库
   * 没有一处**查过部署归属，用户的部署意图在调度面被静默丢弃。
   *
   * 模式解析（v2 优先级：任务级 deploymentPolicy > 全局 executor.deploymentPolicy）：
   * - 任务 `deploymentPolicy='strict'` → strict（全局 prefer 下个别任务显式钉死）；
   * - 任务 `deploymentPolicy='prefer'` → prefer（全局 strict 下个别任务显式退出）；
   * - 任务为 null/undefined → 跟随全局（灰度期存量行的默认形态）。
   * master 开关 `preferDeployedExecutor=false` 仍最先短路：部署感知整体下线，
   * 任务级选择不越过运维级 kill-switch。
   *
   * - `prefer`：只查 `status=RUNNING` 行——软偏好的判据（现状，零行为变化）。
   *   返回空数组仍是有效结果（「偏好适用但无运行中部署」，决策日志借此区分
   *   「没部署」与「部署了但没命中候选」）。
   * - `strict`：查「用户显式指定过设备」的行（running/stopped/upgrading，
   *   口径见 util 的 DEPLOYMENT_CONSTRAINT_STATUSES；once 跑完即 stopped 正是
   *   必须计入的场景）。**集合为空返回 null** = 约束不适用（应用从未部署，或
   *   部署行已被删除——这正是 strict 的解除出口：删行即回全机队）。
   *
   * 返回 `null` 表示「部署感知不适用」（master 开关关 / 仓库未装配 / 任务无
   * applicationId / strict 下集合为空）——调用方据此完全跳过偏好与约束。
   *
   * 查询失败**不抛**：prefer 模式下偏好是 best-effort 的调度优化，绝不能因为
   * 一次读失败而让任务派发失败；strict 模式下读失败同样降级为「无约束、全机队」
   * ——宁可不约束，不可派不出去（与 resolveTaskMutexGroupId 的降级口径一致），
   * 但必须 warn 留痕（静默解除约束正是审计确认过的问题形态）。
   *
   * 为什么不缓存：事故场景正是「刚部署完 A → 立刻下发任务」，任何 TTL 缓存都会
   * 让用户在最该生效的时刻看到旧结论（仍然派给 B），修复感为零。查询命中
   * `["applicationId","status"]` 复合索引（IN 多值走多次索引探查），相对
   * dispatch 既有的多轮 DB 往返可忽略。
   */
  private async resolveDeploymentConstraintContext(task: Task): Promise<{
    mode: "prefer" | "strict";
    source: "task" | "global";
    rows: AppDeployment[];
  } | null> {
    // master 开关：默认开。显式 `=== false` 判定：configService 在测试装配里
    // 可能返回 "http" 等任意值，只有明确 false 才关，避免误关掉修复。
    if (this.configService.get("executor.preferDeployedExecutor") === false) {
      return null;
    }
    if (!this.appDeploymentRepo) return null;
    if (!task.applicationId) return null;
    // v2：任务级覆盖——只有字面量才命中（与全局解析同款宽容判定：约束模式
    // 必须显式选择，其余一切值都回落，永不误入）。
    const taskPolicy = task.deploymentPolicy;
    const strict =
      taskPolicy === "strict"
        ? true
        : taskPolicy === "prefer"
          ? false
          : // 同款宽容判定：只有字面 "strict" 才进约束模式，其余一切值（含
            // 测试装配的任意字符串）都按 prefer 走——永不误入硬约束。
            this.configService.get("executor.deploymentPolicy") === "strict";
    const source: "task" | "global" =
      taskPolicy === "strict" || taskPolicy === "prefer" ? "task" : "global";
    try {
      const rows = await this.appDeploymentRepo.find({
        where: strict
          ? {
              applicationId: task.applicationId,
              status: In([...DEPLOYMENT_CONSTRAINT_STATUSES]),
            }
          : {
              applicationId: task.applicationId,
              status: DeploymentStatus.RUNNING,
            },
        // 投影最小列：分区/集合键/版本跟随只需 id/address/status/
        // deployedVersion/deployedAt 五个判据，避免拉回 env/rolloutMeta 等
        // jsonb 大列（一次派发一次查询，热路径）。
        select: {
          executorId: true,
          executorAddress: true,
          status: true,
          deployedVersion: true,
          deployedAt: true,
        },
      });
      if (strict && rows.length === 0) return null;
      return { mode: strict ? "strict" : "prefer", source, rows };
    } catch (err) {
      // best-effort：读失败不阻断派发（约束缺失 ≠ 无法调度）。
      this.logger.warn(
        `ARCH-35/FEAT-22: 读取应用 ${task.applicationId} 的部署行失败，` +
          `本次派发按纯负载择优（strict 约束本次不生效）：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * FEAT-22 方案 A v1：strict 约束的候选池——「部署集合 ∩ ONLINE」直查。
   *
   * 为什么绕开 fleet SQL Top-K（上方 else 分支的既有查询）：Top-K 按
   * runningTaskCount 升序截断（take: candidatePoolSize），负载高的部署设备
   * 可能被挤出候选池——软偏好只做「池内前置」，池外设备无从谈起（现状即存在
   * 的静默失效面，机队越大越容易触发）；strict 的硬约束不能容忍这个盲区：
   * 集合内设备必须全部可见，否则「只在部署设备上跑」会静默退化为「集合里恰好
   * 进了池子的那几台」。
   *
   * 匹配键：id IN (...) OR address IN (...)（id 精确、address 兜底，语义与
   * partitionByDeploymentAffinity 一致——覆盖存量行 executorId 为空、以及
   * 设备删除重注册后 id 变了但地址没变的场景）。键集合由纯函数
   * collectDeploymentExecutorKeys 提取（去重/去空白）。
   */
  private async findOnlineExecutorsInDeploymentSet(
    rows: AppDeployment[],
  ): Promise<Executor[]> {
    const keys = collectDeploymentExecutorKeys(rows);
    if (keys.ids.length === 0 && keys.addresses.length === 0) return [];
    const list = await this.repo
      .createQueryBuilder("executor")
      .where("executor.status = :status", { status: ExecutorStatus.ONLINE })
      .andWhere(
        new Brackets((qb) => {
          if (keys.ids.length > 0) {
            qb.orWhere("executor.id IN (:...ids)", { ids: keys.ids });
          }
          if (keys.addresses.length > 0) {
            qb.orWhere("executor.address IN (:...addrs)", {
              addrs: keys.addresses,
            });
          }
        }),
      )
      // 集合天然有界（部署行数 ≤ 设备数），take 只是防御上限——与 fleet
      // Top-K 用同一个可配值，超界只可能出现在病态数据下。
      .take(this.candidatePoolSize)
      .getMany();
    // 同一设备可能同时以 id 与 address 双命中（存量行无 id + 新行有 id 的
    // 混合口径下，两行各提供一个键指向同一台）——按 id 去重，否则占坑循环
    // 会对同一台白试一次。
    const uniq = new Map<string, Executor>();
    for (const e of list) uniq.set(e.id, e);
    return [...uniq.values()];
  }

  /**
   * FEAT-22 方案 B（版本跟随部署）+ R3-A（§九 9.3-1 硬要求）：解析「命中
   * 部署设备应跑的版本包」。
   *
   * 版本来源的优先级（R3-A 起）：
   *  1. **设备上报事实**：executor_app_versions 中 (applicationId, 执行器行)
   *     的 currentVersion——设备 current 软链真正指向哪版就跑哪版。中台从此
   *     持有事实而不是从部署行推断；且设备侧的本地版本切换（切 current/
   *     prune 后仍保留的旧版）能被派发面如实跟随。只按 executorId 匹配
   *     （事实行由心跳按行身份落库，恒有 id；不存在部署行那样的 legacy
   *     无-id 行需要 address 兜底）。
   *  2. **部署行推断**（pickDeploymentVersionForExecutor，引入前唯一来源）：
   *     无上报行（旧执行器——executor-node 未升级，混合窗口期）或上报
   *     currentVersion 为 null（设备自报「无 current」）时回退。切到「无
   *     current 仍回退推断」是刻意的：null 是设备自身状态，不是「请中台
   *     自行猜测」的信号，但该应用确实有部署行时按推断跑好过跑应用当前版
   *     （部署行至少记录过该设备跑过哪版）。
   *
   * ⚠️ 为什么必须切（评审 9.3-1）：两套「设备当前版本」并存会打架——升级/
   * 回滚后部署行与设备事实短暂不一致时，读部署行 = 派发面在窗口期跑错版本。
   * 事实源（心跳整替）永远比部署行（写入路径多、更新滞后）新鲜。
   *
   * 兜底（回退当前版 + warn，绝不因版本跟随阻断派发）：两层来源都无版本痕迹
   * （legacy 行）/ 版本行已被删 / snapshot 无 packageUrl（远程 URL 或脏数据）
   * / 查询抛错 / 版本仓库未装配。数据基础已核实：旧版本 zip 仅随**应用删除**
   * 清理（application.service.ts remove），版本升级不删包，且回滚链
   * （upgradeWithSnapshot）本就依赖 snapshot.packageUrl 存活——方案 B 与回滚
   * 共享同一保留语义。
   *
   * 为什么不加缓存：`application_versions` 有 (applicationId, version) 唯一
   * 索引，单次索引查找（ARCH-35 对部署行查询的同款论证——TTL 缓存会让
   * 「刚回滚完立刻派发」看到旧结论）。executor_app_versions 同理是
   * (executorId, applicationId) 唯一索引查找。快照对给定版本不可变。
   *
   * 仅在 dispatch 单发路径调用；pin / appName / broadcast 路径不参与（显式
   * 单台或扇出语义独立，版本语义保持当前版）。
   */
  private async resolveVersionFollowPackage(
    task: Task,
    matched: Executor,
    rows: AppDeployment[],
  ): Promise<{ version: string; packageUrl: string } | null> {
    if (!task.applicationId) return null;
    if (!this.applicationVersionRepo) return null;
    // R3-A：优先读设备上报事实（来源 1）；读失败回退来源 2（同「绝不因版本
    // 跟随阻断派发」的既有兜底姿态）。
    let version: string | null = null;
    if (this.executorAppVersionRepo) {
      try {
        const fact = await this.executorAppVersionRepo.findOne({
          where: {
            applicationId: task.applicationId,
            executorId: matched.id,
          },
          select: { currentVersion: true } as never,
        });
        if (fact && typeof fact.currentVersion === "string") {
          const trimmed = fact.currentVersion.trim();
          if (trimmed) version = trimmed;
        }
      } catch (err) {
        this.logger.warn(
          `R3-A: 读取设备版本事实失败（应用 ${task.applicationId} / 执行器 ` +
            `${matched.id}），回退部署行推断：` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // 来源 2：部署行推断（旧执行器混合窗口期的回退，语义见方法注释）。
    if (!version) {
      version = pickDeploymentVersionForExecutor(rows, {
        id: matched.id,
        address: matched.address,
      });
    }
    if (!version) return null;
    try {
      const versionRow = await this.applicationVersionRepo.findOne({
        where: { applicationId: task.applicationId, version },
        select: { id: true, snapshot: true },
      });
      const packageUrl = versionRow?.snapshot?.packageUrl;
      if (typeof packageUrl === "string" && packageUrl.length > 0) {
        return { version, packageUrl };
      }
      this.logger.warn(
        `FEAT-22 方案 B: 应用 ${task.applicationId} 版本 ${version} 的快照无 packageUrl` +
          `（legacy 行或脏数据），执行 ${task.name} 回退当前版本派发`,
      );
      return null;
    } catch (err) {
      this.logger.warn(
        `FEAT-22 方案 B: 读取应用 ${task.applicationId} 版本 ${version} 快照失败，` +
          `执行 ${task.name} 回退当前版本派发：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Broadcast dispatch: send the task to ALL online executors simultaneously.
   * Used when task.executeMode === ExecuteMode.BROADCAST.
   * Returns a list of results for each executor.
   *
   * NOTE: Broadcast must reach every eligible online executor. The
   * `{status: ONLINE}` where clause keeps this scoped to the active fleet;
   * offline/stale rows are excluded. A take:5000 safety cap (O-3) bounds a
   * pathological/fleet-blowup row count without affecting normal deployments.
   */
  async dispatchBroadcast(
    task: Task,
    execution: TaskExecution,
  ): Promise<any[]> {
    // A-1（执行器域审计 P1）：广播不经过互斥占坑闸（claimExecutorSlotForExecution）
    // ——挂互斥组的执行会静默绕过组内并发约束。写面已在任务 create/update 拒绝
    // 「broadcast + 应用挂互斥组」组合（task.service.assertBroadcastMutexCompatible）；
    // 此处对**存量**此类任务（写面门上线前创建，或应用后挂组）记 warn 保持现状：
    // 广播语义是同刻扇出全部目标，而单执行行的占用标记 executorAddress 只能落
    // 一个地址，强行逐目标占坑会互相覆盖标记、破坏互斥的唤醒/释放链路——
    // 运行时补救不可靠，可观测（warn）+ 写面拒绝才是正确切面。
    if (execution.mutexGroupId) {
      this.logger.warn(
        `A-1: broadcast task "${task.name}" (execution ${execution.id}) carries mutexGroupId=${execution.mutexGroupId} but broadcast dispatch does not claim mutex slots — mutual exclusion is NOT enforced on this fan-out; recreate the task with executeMode=single or unbind the mutex group`,
      );
    }
    const all = await this.repo.find({
      where: { status: ExecutorStatus.ONLINE },
      // O-1（中台↔执行器深度审查）：广播同样按 runningTaskCount 升序取 Top-K。
      // 正常机队（< 5000）下排序不影响扇出面（全部在线都入池）；只有病态
      // 机队（> 5000）触发截断时，**保留最空闲的一批**是最不坏的取舍——
      // 旧实现随机截断可能把最空闲的执行器漏在池外。
      order: { runningTaskCount: "ASC" },
      // O-3: safety cap (compare dispatch's take:500).
      take: 5000,
    });
    let candidates = all;

    // Apply same filters as dispatch
    if (task.executorAppName) {
      candidates = all.filter((e) => e.appName === task.executorAppName);
      // python_task_multiversion（WS2 · CONTRACT §3.1）：广播的 appName 分支
      // 同样按"用户显式点名"处理——不满足声明版本即失败（与单播 dispatch
      // 的 appName 分支同语义），不静默缩小扇出面。
      const byName = this.applyInterpreterFilter(
        candidates,
        task.runtimeVersion,
      );
      if (byName.message) {
        this.failInterpreterUnavailable(byName.message);
      }
      candidates = byName.kept;
    } else {
      let filtered = all;
      if (task.executorGroup) {
        filtered = filtered.filter((e) => e.groupName === task.executorGroup);
      }
      if (task.executorTags && task.executorTags.length > 0) {
        filtered = filtered.filter((e) => {
          if (!e.tags) return false;
          return task.executorTags!.every((tag) => e.tags!.includes(tag));
        });
      }
      // NF-04: affinity / anti-affinity constraints on the broadcast path.
      // Ruling (documented in docs/api-reference.md): broadcast + affinity
      // NARROWS the fan-out to the executors holding any affinity tag — that
      // is the whole point of the third dispatch state (pinning = exactly one,
      // plain broadcast = everyone, broadcast+affinity = the matching subset,
      // loadScore not consulted on this path). Broadcast + anti-affinity
      // excludes matching executors as usual. Both no-ops when the columns are
      // null/empty (default unchanged). An empty final candidate set throws
      // the same "No online executors match..." error as the other filters.
      if (task.executorAffinityTags && task.executorAffinityTags.length > 0) {
        filtered = filtered.filter((e) => {
          if (!e.tags) return false;
          return task.executorAffinityTags!.some((tag) =>
            e.tags!.includes(tag),
          );
        });
      }
      if (
        task.executorAntiAffinityTags &&
        task.executorAntiAffinityTags.length > 0
      ) {
        filtered = filtered.filter((e) => {
          if (!e.tags) return true;
          return !task.executorAntiAffinityTags!.some((tag) =>
            e.tags!.includes(tag),
          );
        });
      }
      if (task.runtime) {
        filtered = filtered.filter((e) =>
          !e.capabilities || e.capabilities.length === 0
            ? true
            : e.capabilities.includes(task.runtime),
        );
      }
      // python_task_multiversion（WS2 · CONTRACT §3.1）：解释器缓存池过滤——
      // 与单播 dispatch 同一位置（runtime 之后）与同一共享实现。
      const interpreterFiltered = this.applyInterpreterFilter(
        filtered,
        task.runtimeVersion,
      );
      if (interpreterFiltered.message) {
        this.failInterpreterUnavailable(interpreterFiltered.message);
      }
      filtered = interpreterFiltered.kept;
      if (filtered.length === 0) {
        throw new AppError("NO_EXECUTOR_MATCHING_FILTERS");
      }
      candidates = filtered;
    }

    if (candidates.length === 0) {
      throw new AppError("NO_BROADCAST_EXECUTOR");
    }

    this.logger.log(
      `Broadcasting task "${task.name}" to ${candidates.length} executors`,
    );

    // Fire all dispatches in parallel and collect results
    const sharedToken = await this.getSharedToken();
    const broadcastHeaders: Record<string, string> = {};
    if (sharedToken)
      broadcastHeaders["Authorization"] = `Bearer ${sharedToken}`;
    // OBS-01: 广播路径同样透传 traceparent（disabled 时零头注入）。
    this.tracing?.injectContext(
      broadcastHeaders,
      this.buildExecutionTraceparent(execution),
    );
    // SEC-02: params + decrypted secrets（secrets 覆盖同名 params，仅进派发载荷不落库）
    const dispatchParams = this.buildDispatchParams(task, execution);
    // SEC-02 续：secrets 另发一份，供执行器按**原名**注入（第三方 SDK 认规范名）。
    const dispatchSecrets = this.buildDispatchSecrets(task);
    // python_task_multiversion（WS2 · CONTRACT §2.4/§3.1）：广播路径同样解析
    // `packageUrl`。**在扇出之前**解析（一次查询服务全部目标，且解析失败时
    // 整个广播直接失败——`packageUrl` 是任务级属性，解析不到就没有任何一个
    // 目标能跑，部分成功只会留下"半数执行器白跑"的脏结果）。
    // 广播不落执行行版本留痕（每台结果各异，语义归执行器侧上报）。
    const { task: dispatchTask } = await this.resolveDispatchTask(task);

    const results = await Promise.allSettled(
      candidates.map(async (executor) => {
        // ARCH-32（ADR-015）: pull 执行器入队（不拨入站连接），其余走 push。
        if (executor.dispatchMode === "pull") {
          if (!this.pullService) {
            throw new AppError("EXECUTOR_PULL_UNAVAILABLE");
          }
          await this.pullService.enqueue(executor.id, {
            executionId: execution.id,
            task: dispatchTask,
            params: dispatchParams,
            // SEC-02 续：secrets 单独下发一份供执行器按原名注入（纯增量字段）。
            secrets: dispatchSecrets,
            traceparent: broadcastHeaders["traceparent"],
          });
          return {
            executor: executor.address,
            result: { status: "queued", dispatchMode: "pull" },
          };
        }
        const dispatchUrl = this.getExecutorUrl(
          executor.address,
          "api/execute",
        );
        // F-3: SSRF guard per target — a poisoned address (metadata/loopback)
        // fails its own dispatch without affecting the rest of the broadcast.
        // F-3 (SEC-NEW): pin the connection to the validated IP.
        const pinned = await assertAndPinExecutorUrl(dispatchUrl);
        const pinCfg = pinnedAxiosConfig(pinned);
        const resp = await axios.post(
          dispatchUrl,
          {
            executionId: execution.id,
            task: dispatchTask,
            params: dispatchParams,
            // SEC-02 续：secrets 单独下发一份供执行器按原名注入（纯增量字段）。
            secrets: dispatchSecrets,
          },
          {
            timeout: ((task.timeout || 300) + 10) * 1000,
            headers: broadcastHeaders,
            maxRedirects: 0,
            ...pinCfg,
          },
        );
        return { executor: executor.address, result: resp.data };
      }),
    );

    const successes: { executor: string; result: unknown }[] = [];
    const failures: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        successes.push(r.value);
      } else {
        const errMsg =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        failures.push(`${candidates[i].address}: ${errMsg}`);
      }
    });

    // R-06（DEEP_REVIEW 0ef3bbe）: 广播占坑——此前广播派发对每个目标执行器
    // 的 runningTaskCount 从不 +1，广播负载对单播容量闸门/负载打分不可见（欠计）。
    // 此处对每个成功接单（Promise.allSettled fulfilled）的目标执行器原子 +1，
    // UPDATE 形态与单播 dispatch 占坑同构。广播按定义必须扇出到全部在线执行器，
    // 因此不复用「runningTaskCount < max」容量闸（不主动拒绝目标），仅把负载计入。
    // 释放侧：handleCallback 按回调上报地址逐执行器 -1（每个被接受执行器回调
    // 恰好一次），并有执行器心跳 30s 覆写兜底。
    //
    // O-2（中台↔执行器深度审查）：占坑改走**容量闸门的原子 UPDATE**——
    // `WHERE runningTaskCount < maxConcurrentTasks`，超限目标**跳过占坑并 warn**
    // （按审查报告给出的方案落地）。旧实现无条件 +1 会让广播把单执行器
    // runningTaskCount 顶过 maxConcurrentTasks：与单播混跑时，单播按
    // count >= max 拒派 → 广播挤占单播的容量保证。跳过占坑的副作用（计数少计）
    // 由 releaseExecutorSlot 的 GREATEST(...,0) 下限保护 + 执行器心跳 30s 覆写
    // 兜底，不产生负计数；广播扇出面不受影响（仍全部收到任务）。
    const acceptedExecutors = results
      .map((r, i) => ({ settled: r, executor: candidates[i] }))
      .filter(({ settled }) => settled.status === "fulfilled");
    await Promise.all(
      acceptedExecutors.map(async ({ executor }) => {
        const qb = this.repo
          .createQueryBuilder()
          .update(Executor)
          .set({ runningTaskCount: () => '"runningTaskCount" + 1' })
          .where("id = :id", { id: executor.id });
        // maxConcurrentTasks 为 NULL（未配置/无上限）→ 不加容量条件；
        // 数值（含 0）视为真实上限（与单播 dispatch 的 `?? Infinity` 语义一致）。
        if (executor.maxConcurrentTasks != null) {
          qb.andWhere('"runningTaskCount" < :max', {
            max: executor.maxConcurrentTasks,
          });
        }
        const res = await qb.execute();
        if (res.affected === 0) {
          this.logger.warn(
            `Broadcast occupy skipped for ${executor.address} ` +
              `(runningTaskCount >= ${executor.maxConcurrentTasks ?? "unbounded"}): ` +
              `task "${task.name}" was dispatched but its load is not counted against capacity`,
          );
        }
        return res.affected === 1;
      }),
    );

    if (failures.length > 0) {
      this.logger.warn(
        `Broadcast partially failed for task "${task.name}": ${failures.join("; ")}`,
      );
    }

    if (successes.length === 0) {
      throw new AppError("BROADCAST_DISPATCH_ALL_FAILED", {
        count: candidates.length,
        failures: failures.join("; "),
      });
    }

    return successes;
  }

  /** Scan every 5 min for RUNNING executions that timed out with offline executor to prevent zombie tasks */
  @Cron("0 */5 * * * *")
  async detectLostExecutions() {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行（下同，详见 LeaderGateService）
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    // N12: use a 5-min broad threshold so any task older than the minimum buffer
    // is considered for per-execution checks (real timeout logic is applied per-row below).
    // A 24-hour threshold was too large — tasks with short timeouts were left as zombie
    // for up to 24h even when their executor went offline.
    const broadThreshold = new Date(Date.now() - 5 * 60 * 1000);
    // NETOPT-1⑧: 补 take 上限（对齐 scheduler O-2 的 1000）——无界 getMany
    // 在执行器长时间离线/回调通道故障时会一次物化全部僵尸行，随后逐行终态
    // 写放大为长事务风暴；截断后下一轮 5 分钟 tick 自收敛（余量行仍满足
    // RUNNING + 阈值谓词）。逐行写保留：终态必须走 transitionToTerminal
    //（A1 收口）并按 RETURNING 地址逐台释放槽位，不能改批量 UPDATE。
    // NETOPT-E P3-3: 与主 stale sweep 同档——take 1000 无 order 无循环，在
    // 单执行器 10000 并发（E9 采纳域）下每 5 分钟只处理前 1000 行，第 1001+
    // 行滞留到下一轮（恢复吞吐 < 故障规模时永不自收敛）。分页循环 +
    // startTime/id 双键排序对齐 scheduler.service 的 STALE_SWEEP 同款约定。
    const lostExecs: TaskExecution[] = [];
    const LOST_SWEEP_PAGE = 1000;
    const LOST_SWEEP_MAX = 20_000;
    let pageOffset = 0;
    while (lostExecs.length < LOST_SWEEP_MAX) {
      const page = await this.execRepo
        .createQueryBuilder("exec")
        .where("exec.status = :status", { status: ExecutionStatus.RUNNING })
        .andWhere("exec.startTime < :threshold", { threshold: broadThreshold })
        .orderBy("exec.startTime", "ASC")
        .addOrderBy("exec.id", "ASC")
        .take(LOST_SWEEP_PAGE)
        .skip(pageOffset)
        .getMany();
      lostExecs.push(...page);
      if (page.length < LOST_SWEEP_PAGE) break;
      pageOffset += page.length;
    }
    if (lostExecs.length === 0) return;

    // Batch-fetch tasks and executors to avoid N+1 queries
    const taskIds = [
      ...new Set(lostExecs.map((e) => e.taskId).filter(Boolean)),
    ] as string[];
    const taskMap = new Map(
      taskIds.length > 0
        ? (await this.taskRepo.findBy({ id: In(taskIds) })).map((t) => [
            t.id,
            t,
          ])
        : [],
    );
    const addresses = [
      ...new Set(lostExecs.map((e) => e.executorAddress).filter(Boolean)),
    ] as string[];
    const executorMap = new Map(
      addresses.length > 0
        ? (await this.repo.findBy({ address: In(addresses) })).map((ex) => [
            ex.address,
            ex,
          ])
        : [],
    );

    for (const exec of lostExecs) {
      const task = exec.taskId ? (taskMap.get(exec.taskId) ?? null) : null;
      const taskTimeoutMs = task?.timeout ? task.timeout * 1000 : 5 * 60 * 1000;
      const perExecThreshold = new Date(
        Date.now() - (taskTimeoutMs + 5 * 60 * 1000),
      );
      if (exec.startTime && exec.startTime > perExecThreshold) {
        // Not yet past this task's timeout+buffer — skip
        continue;
      }
      if (exec.executorAddress) {
        const executor = executorMap.get(exec.executorAddress);
        if (executor && executor.status === ExecutorStatus.ONLINE) continue;
      }
      // DR-03: only the terminal-transition winner may release the slot;
      // a callback or another scanner may have finished this stale candidate.
      //
      // A1: 走统一入口。顺带修掉一个此前存在的隐患——旧实现没有 RETURNING，
      // 释放用的是请求前快照 exec.executorAddress；而该地址在 dispatch HTTP
      // 返回后才落库，秒级完成的执行其快照仍为 null，用它释放会 no-op 使
      // runningTaskCount 永久虚高（task.service 回调路径的注释早已自证这个坑，
      // 但扫描路径一直在踩）。现在取 RETURNING 的库中实际值，快照仅作兜底。
      const { rows } = await transitionToTerminal(this.execRepo, {
        ids: [exec.id],
        patch: {
          status: ExecutionStatus.FAILED,
          endTime: new Date(),
          errorMessage:
            "[System] Executor offline or task timed out, marked as failed by scheduler",
          logs:
            (exec.logs || "") +
            "\n[System] Execution timed out without callback, forcefully marked as FAILED",
        },
        // 扫描入口只处理 RUNNING 行（与旧实现的 `status = :status` 同门槛）。
        from: [ExecutionStatus.RUNNING],
        addressSnapshot: { [exec.id]: exec.executorAddress ?? null },
      });
      for (const row of rows) {
        await this.releaseExecutorSlot(row.executorAddress);
        this.logger.warn(
          `Lost execution marked FAILED: execId=${row.id}, taskId=${exec.taskId}`,
        );
      }
    }
  }

  /**
   * Q7: Daily at 2am, clean up old execution records and audit logs (180d) to
   * prevent DB bloat.
   *
   * 保留期可配置（`TASK_EXECUTION_RETENTION_DAYS`，缺省 90 —— 与硬编码时期
   * 逐字节等价）。**这是硬删除且不可逆**：删行同时回收该行的执行日志与 S3
   * 日志对象，**没有归档表**。需要留存的历史必须在到期前自行导出；口径见
   * configuration.ts 的 `taskExecutionRetention` 注释与 docs/deployment.md
   * 「执行记录保留」段。
   *
   * 非法/非正数已被 configuration.ts 归一为 90，故这里拿到的 days 恒 > 0
   * ——cutoff 永远不会被推到未来（那会删掉全部记录）。
   */
  @Cron("0 0 2 * * *")
  async cleanupOldRecords(): Promise<void> {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    // 取用点**再归一一次**（configuration.ts 已归一，但这里是不可逆删除的最后
    // 一道闸）：非数值/NaN/≤0 一律回落 90。`?? 90` 抓不到"类型不对"的值——
    // 实测本文件的既有单测把 ConfigService mock 成 `get: () => "http"`，
    // 那种值乘上毫秒数会得到 Invalid Date，进而把 cutoff 变成无效比较。
    const configured = this.configService?.get<unknown>(
      "taskExecutionRetention.days",
    );
    const retentionDays =
      typeof configured === "number" &&
      Number.isFinite(configured) &&
      configured > 0
        ? configured
        : 90;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    // NETOPT-1②: 单条无界 DELETE 在峰值行数下是长事务（锁表 + WAL 风暴），
    // 改分批 DELETE（对齐下方 cleanupExpiredMetricsHistory 的 R-09 模式）。
    const deleted = await this.cleanupOldTaskExecutions(cutoff);
    if (deleted > 0) {
      this.logger.log(
        `Q7 Cleanup: removed ${deleted} old task executions (>${retentionDays} days)`,
      );
    }
  }

  /** NETOPT-1②: task_executions retention 分批大小（对齐 R-09 metrics 模式） */
  private static readonly EXECUTION_RETENTION_BATCH_SIZE = 5000;

  /**
   * NETOPT-1②: task_executions 90 天 retention，返回清理总行数。cutoff 可
   * 注入以便测试。分批 DELETE（id IN (SELECT ... LIMIT 批大小)）循环直至
   * 单批不足批大小，避免长事务锁表；多实例下仅 cron Leader 执行（入口已门禁）。
   *
   * NETOPT-8④: 循环收口改走公共 cappedBatchedDelete——补 LOG-RETENTION-01
   * 轮数/墙钟双闸（affected 恒返满批时旧 `do..while` 永不终止，已实测 OOM）。
   * NETOPT-8①: S3 驱动下每批先回收行上的日志对象再删行（防 S3 永久孤儿），
   * 见 deleteExpiredExecutionRowsBatch。
   */
  async cleanupOldTaskExecutions(cutoff: Date): Promise<number> {
    const s3 = this.resolveS3LogStorage();
    return cappedBatchedDelete({
      batchSize: ExecutorService.EXECUTION_RETENTION_BATCH_SIZE,
      logLabel: "Q7",
      logger: this.logger,
      executeBatch: () => this.deleteExpiredExecutionRowsBatch(cutoff, s3),
    });
  }

  /**
   * NETOPT-8①: 单批 task_executions 清理，返回本批实际删除行数（0 = 收口）。
   *
   * s3 为 null（非 S3 部署：driver=db，或 s3 但 endpoint 未配）→ 单条分批
   * 子查询 DELETE，行为=既往（直删行）。
   * s3 非空 → 先 SELECT victims（id + logObjectKey 两列，createdAt<cutoff，
   * ORDER BY id，take 批大小），对带指针的行先 remove S3 日志对象再删行：
   * S3 GC（s3-log-object-retention.service 的 selectExpiredBatch）候选只能
   * 来自存活行（logStorage='s3' AND logObjectKey IS NOT NULL），行一删指针
   * 消失，execution-logs/<execId>.log.gz 就永无人回收成永久孤儿。remove
   * 失败的行从本批 DELETE 集合剔除（指针留待下轮 cron 重试），只 warn 不
   * 中断；全部失败时本批返回 0（循环收口，等下一 cron 周期）。
   */
  private async deleteExpiredExecutionRowsBatch(
    cutoff: Date,
    s3: S3LogStorage | null,
  ): Promise<number> {
    if (!s3) {
      const result = await this.execRepo
        .createQueryBuilder()
        .delete()
        .where(
          `"id" IN (
            SELECT "victim"."id" FROM "task_executions" "victim"
            WHERE "victim"."createdAt" < :cutoff
            ORDER BY "victim"."id"
            LIMIT :batchSize
          )`,
          { cutoff, batchSize: ExecutorService.EXECUTION_RETENTION_BATCH_SIZE },
        )
        .execute();
      return result.affected ?? 0;
    }
    const victims = await this.execRepo.find({
      select: { id: true, logObjectKey: true },
      where: { createdAt: LessThan(cutoff) },
      order: { id: "ASC" },
      take: ExecutorService.EXECUTION_RETENTION_BATCH_SIZE,
    });
    if (victims.length === 0) return 0;
    const deletableIds: string[] = [];
    for (const victim of victims) {
      const key = victim.logObjectKey;
      if (!key) {
        // 无外置日志对象（db 驱动行 / 指针已被 S3 GC 清空）：直接删行
        deletableIds.push(victim.id);
        continue;
      }
      try {
        await s3.remove(key);
      } catch (err: unknown) {
        // fail-open：对象删不掉就跳过——行保留 = 指针保留 = 下轮 cron 仍能
        // 定位该对象（S3 GC / 本清理重试），绝不因单对象失败中断整批。
        this.logger.warn(
          `NETOPT-8①: S3 日志对象删除失败，跳过 execution ${victim.id}（${key}）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      deletableIds.push(victim.id);
    }
    if (deletableIds.length === 0) return 0;
    const result = await this.execRepo.delete({ id: In(deletableIds) });
    return result.affected ?? 0;
  }

  /**
   * NETOPT-8①: 惰性解析可选 S3 日志后端（S3LogObjectRetentionService /
   * TaskService.resolveS3Storage 同款：fromConfig 是进程内单例语义，缓存于
   * 本实例）。非 s3 驱动返回 null，retention 走既有直删路径。
   */
  private s3LogStorage: S3LogStorage | null = null;
  private s3LogStorageResolved = false;
  private resolveS3LogStorage(): S3LogStorage | null {
    if (!this.s3LogStorageResolved) {
      this.s3LogStorage = S3LogStorage.fromConfig(this.configService);
      this.s3LogStorageResolved = true;
    }
    return this.s3LogStorage;
  }

  // R-09（DEEP_REVIEW 0ef3bbe）: executor_metrics_history 无 retention——每执行器
  // 每 30s 心跳写一行（2,880 行/天/执行器），全仓此前无任何清理机制，同类表
  // （audit_logs / execution_log_lines / artifacts）均有 retention。对齐既有
  // 模式（log-retention-cleanup / artifacts-retention）：每日 cron + LeaderGate，
  // 保留期复用 logRetention.days（默认 30 天，可经 LOG_RETENTION_DAYS 配置）。
  // 分批 DELETE（id IN (SELECT ... LIMIT 批大小)）循环直至单批不足批大小，
  // 避免长事务锁表；多实例并发删除幂等。
  private static readonly METRICS_RETENTION_BATCH_SIZE = 5000;

  /** R-09: 每日 03:15 清理超期 executor_metrics_history 行（保留期同日志） */
  @Cron("0 15 3 * * *")
  async cleanupMetricsHistory(): Promise<void> {
    // ARCH-31 §5: 多实例下仅 cron Leader 执行
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    try {
      const deleted = await this.cleanupExpiredMetricsHistory();
      if (deleted > 0) {
        this.logger.log(`R-09: 清理 ${deleted} 行过期执行器指标历史`);
      }
    } catch (err) {
      this.logger.error(
        `R-09: 执行器指标历史 retention 清理失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * R-09: 删除 createdAt 早于保留期截止的指标历史行，返回清理总行数。
   * now 可注入以便测试。分批 DELETE 对齐 log-retention-cleanup 的
   * cleanupExpiredLinesByDelete 模式。
   * NETOPT-8④: 循环收口改走公共 cappedBatchedDelete（LOG-RETENTION-01
   * 轮数/墙钟双闸，防 affected 恒满批时无界循环 OOM）。
   */
  async cleanupExpiredMetricsHistory(now: Date = new Date()): Promise<number> {
    const retentionDays = this.resolveMetricsRetentionDays();
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    return cappedBatchedDelete({
      batchSize: ExecutorService.METRICS_RETENTION_BATCH_SIZE,
      logLabel: "R-09",
      logger: this.logger,
      executeBatch: async () => {
        const result = await this.metricsHistoryRepo
          .createQueryBuilder()
          .delete()
          .where(
            `"id" IN (
              SELECT "victim"."id" FROM "executor_metrics_history" "victim"
              WHERE "victim"."createdAt" < :cutoff
              ORDER BY "victim"."id"
              LIMIT :batchSize
            )`,
            { cutoff, batchSize: ExecutorService.METRICS_RETENTION_BATCH_SIZE },
          )
          .execute();
        return result.affected ?? 0;
      },
    });
  }

  /** R-09: 解析保留期（复用 logRetention.days，对齐 artifacts-retention 口径） */
  /** 离线执行器台账保留天数（默认 7；运行期配置优先，见 cleanupOfflineExecutors）。 */
  private static readonly DEFAULT_EXECUTOR_RETENTION_DAYS = 7;
  /** 运行期配置键（中台「系统设置 → 系统配置」可改）。 */
  private static readonly EXECUTOR_RETENTION_CONFIG_KEY =
    "executor.retentionDays";

  /**
   * 2026-10-23：离线执行器台账保留天数。
   *
   * 读取顺序：`system_configs.executor.retentionDays`（运行期可改、即时生效）
   * → 常量 7。非法值（非数字 / ≤0 / NaN）一律回落常量——这是**不可逆删除**
   * 的判定参数，宁可保守也不要因为一个脏配置把台账清空。
   * 读配置失败（键不存在 / 服务暂不可用）静默回落，不让清理 cron 挂掉。
   */
  private async resolveExecutorRetentionDays(): Promise<number> {
    try {
      const row = await this.systemConfigService?.findOne(
        ExecutorService.EXECUTOR_RETENTION_CONFIG_KEY,
      );
      const parsed = Number.parseInt(row?.value ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // 未配置 / 读取失败：回落默认值
    }
    return ExecutorService.DEFAULT_EXECUTOR_RETENTION_DAYS;
  }

  private resolveMetricsRetentionDays(): number {
    const parsed = this.configService.get<number>("logRetention.days");
    if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return 30;
  }

  /**
   * NETOPT-G P1-7：判死所需的**连续超时轮数**。
   *
   * 默认 2：一次 90s 超时只记为"错过一轮"，连续两轮（≈2×90s + 一个扫描周期）
   * 才判死。取值依据（生产实测）：
   *  - 单次心跳失败率约 4.5%，两次独立失败同时发生 ≈ 0.2%——已压到噪声级；
   *  - 长尾 RTT 最大 153s，单轮 90s 阈值本就会被长尾踩线，两轮确认给了链路
   *    一次恢复机会；
   *  - 代价：真实故障检出从 90s 延到 ~210s（多一个确认窗口）。这是**有意
   *    取舍**——误判的代价（离线通知风暴 + 执行器被移出派发候选 + 运行中
   *    任务被误标）高于多等 2 分钟；且派发本身有 TTL/sweep 兜底，不会因
   *    执行器判死晚 2 分钟而丢任务。
   *
   * 配置 `executor.staleOfflineConfirmations` 可调；非法值（<1 / 非数）回退
   * 默认，绝不因配置写错导致"永不判死"或"立即判死"。
   */
  private resolveStaleConfirmations(): number {
    const raw = this.configService.get<number>(
      "executor.staleOfflineConfirmations",
    );
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) {
      return Math.floor(raw);
    }
    return 2;
  }

  /** Auto-scan every 30s, mark executors with expired heartbeat as OFFLINE */
  @Cron("*/30 * * * * *")
  async markStaleOffline() {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    // Calculate timeout using configured heartbeat interval and timeout multiplier
    const heartbeatInterval =
      this.configService.get<number>("executor.heartbeatInterval") || 30000;
    const timeoutMultiplier =
      this.configService.get<number>("executor.heartbeatTimeoutMultiplier") ||
      3;
    const timeoutMs = heartbeatInterval * timeoutMultiplier;
    const cutoff = new Date(Date.now() - timeoutMs);
    // NETOPT-G P1-7（判死迟滞）：需要**连续**多少轮扫描命中超时才真正判死。
    const requiredMisses = this.resolveStaleConfirmations();

    // ── 第一步：对"本轮超时但仍标 ONLINE"的行递增计数 ──────────────────
    //
    // 这一步把"刚错过一次心跳"与"持续失联"区分开：单次墙钟命中只 +1，
    // 不改变 status——这正是修复跨境抖动误判的关键。计数在命中时累加、
    // 在 heartbeat() 到达时清零，因此"偶发失败 + 恢复"不会再判死。
    //
    // 用 SQL 表达式自增（而非先查后写）避免并发心跳与 sweep 的读改写竞态。
    // 同时可顺带记录"疑似失联"观测面（计数 >= 1 即说明已错过至少一轮）。
    await this.repo
      .createQueryBuilder()
      .update(Executor)
      .set({
        consecutiveHeartbeatMisses: () => '"consecutiveHeartbeatMisses" + 1',
      })
      .where('status = :status AND "lastHeartbeat" < :cutoff', {
        status: ExecutorStatus.ONLINE,
        cutoff,
      })
      .execute();

    // ── 第二步：只对"计数已达阈值"的行做 ONLINE→OFFLINE 跃迁 ────────────
    //
    // R-30（DEEP_REVIEW 0ef3bbe）: 消除查询/更新间隙的误发。旧实现先 find 快照
    // staleExecutors，再 repo.update（同条件重查，行级正确），最后事件/通知循环
    // 遍历的是**先查的快照**——间隙内补了心跳（lastHeartbeat 新于 cutoff）的
    // 执行器虽不被 UPDATE 命中，仍会收到 executor.offline 事件与通知。改为
    // 条件 UPDATE ... RETURNING：原子地拿到真正发生 ONLINE→OFFLINE 跃迁的行，
    // 事件/通知只对这部分扇出（与 scheduler COVER_EARLY 的条件 UPDATE+RETURNING
    // 同型），间隙误发从结构上消失。
    //
    // `consecutiveHeartbeatMisses >= :requiredMisses` 保证：即使两轮扫描之间
    // 执行器恢复过一次心跳（heartbeat() 已把计数清零、lastHeartbeat 刷新），
    // 它也不会被本条命中。
    const result = await this.repo
      .createQueryBuilder()
      .update(Executor)
      // 遗留 P1-24：心跳超时判死与优雅下线区分落值。
      .set({
        status: ExecutorStatus.OFFLINE,
        offlineReason: ExecutorOfflineReason.STALE_TIMEOUT,
      })
      .where(
        'status = :status AND "lastHeartbeat" < :cutoff AND "consecutiveHeartbeatMisses" >= :requiredMisses',
        {
          status: ExecutorStatus.ONLINE,
          cutoff,
          requiredMisses,
        },
      )
      .returning(["id", "appName", "address"])
      .execute();

    const transitioned = (result.raw ?? []) as Array<{
      id: string;
      appName: string;
      address: string;
    }>;
    if (transitioned.length === 0) return;

    this.logger.warn(
      `Marked ${transitioned.length} executor(s) as OFFLINE after ${requiredMisses} consecutive heartbeat misses (>${timeoutMs}ms each)`,
    );
    // FEAT-07: 状态落库后发布 executor.offline（每台恰一次，与下方通知同扇出位）。
    for (const exec of transitioned) {
      this.emitExecutorOffline(exec);
    }
    // Fire offline notifications — fire-and-forget, errors must not break the cron job
    for (const exec of transitioned) {
      this.notificationService
        .notifyExecutorOffline(exec.appName, exec.address)
        .catch((e: Error) =>
          this.logger.error(
            `Failed to send offline notification for ${exec.address}: ${e.message}`,
          ),
        );
    }
  }

  /** Run hourly, clean up executor records offline for more than 7 days.
   *
   * DEEP-AUDIT B·1.1：自动清理从「盲删」改为「有钉定任务则跳过」。旧行为对
   * `task.executorId` 引用零感知——一台离线超 7 天但仍有钉定任务的执行器被
   * 静默删除后，钉定任务派发即抛 "Pinned executor not found" 且无重试（UNKNOWN
   * 分类），等于自动制造必失败任务。现在：仍被钉定的行跳过并 warn+审计，
   * 让运维显式处理（解钉或换机）；无引用的行照旧清理并顺手清 pull 队列。
   *
   * A-2（执行器域审计 P2）：跳过判定补 `task.executorAppName` 名字绑定维度，
   * 与删除影响面预览（countTasksBoundByAppName）同口径——appName 精确匹配
   * 的绑定任务同样会因删除而必失败。
   */
  @Cron("0 0 * * * *")
  async cleanupOfflineExecutors() {
    if (this.leaderGate && !this.leaderGate.isLeader) return;
    // 2026-10-23：保留天数从硬编码 7 天提为**运行期可配**
    // （system_configs 的 `executor.retentionDays`，回落常量 7）。
    // 理由：7 天对演示/测试环境太长（实测积了 21 台离线残留，界面上要清理
    // 也只能逐台点进详情），而对"半年后才复查"的合规部署又太短。
    const retentionDays = await this.resolveExecutorRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const stale = await this.repo.find({
      where: {
        status: ExecutorStatus.OFFLINE,
        lastHeartbeat: LessThan(cutoff),
      },
      // 阶段 3 复查补口：多取 deviceFingerprint —— 删除后要按指纹把这条安装
      // 从冲突跟踪器里**同步**忘掉（否则删除只让它变成"幽灵历史指纹"，告警
      // 还要再响一个 liveness 窗口）。
      select: {
        id: true,
        address: true,
        appName: true,
        deviceFingerprint: true,
      },
    });
    if (stale.length === 0) return;

    // 一次分组查询拿全部"仍被钉定"的 executorId（避免逐行 count 的 N+1）。
    const staleIds = stale.map((e) => e.id);
    const pinnedRows = (await this.taskRepo
      .createQueryBuilder("task")
      .select("task.executorId", "executorId")
      .addSelect("COUNT(*)", "count")
      .where("task.executorId IN (:...ids)", { ids: staleIds })
      .andWhere("task.status != :deleted", { deleted: TaskStatus.DELETED })
      .groupBy("task.executorId")
      .getRawMany()) as Array<{ executorId: string; count: string }>;
    const pinnedCounts = new Map(
      pinnedRows.map((r) => [r.executorId, Number(r.count)]),
    );

    // A-2（执行器域审计 P2）：跳过判定补 executorAppName 维度——dispatch 的
    // appName 精确匹配（不静默换机）与删除影响面预览（countTasksBoundByAppName）
    // 都把 task.executorAppName 绑定计为破坏面，而此处此前只查 executorId 钉定：
    // 一台离线超 7 天、被 appName 绑定但无钉定任务的执行器会被自动删除，绑定
    // 任务派发即抛 "No available executor with appName ..."。分组查询与钉定
    // 同型（避免 N+1）；口径与 countTasksBoundByAppName 一致（排除软删除行）。
    const staleAppNames = [
      ...new Set(stale.map((e) => e.appName).filter(Boolean)),
    ];
    const appNameBoundRows =
      staleAppNames.length > 0
        ? ((await this.taskRepo
            .createQueryBuilder("task")
            .select("task.executorAppName", "executorAppName")
            .addSelect("COUNT(*)", "count")
            .where("task.executorAppName IN (:...names)", {
              names: staleAppNames,
            })
            .andWhere("task.status != :deleted", {
              deleted: TaskStatus.DELETED,
            })
            .groupBy("task.executorAppName")
            .getRawMany()) as Array<{ executorAppName: string; count: string }>)
        : [];
    const appNameBoundCounts = new Map(
      appNameBoundRows.map((r) => [r.executorAppName, Number(r.count)]),
    );

    const boundRefCounts = (e: (typeof stale)[number]) =>
      (pinnedCounts.get(e.id) ?? 0) + (appNameBoundCounts.get(e.appName) ?? 0);
    const deletable = stale.filter((e) => boundRefCounts(e) === 0);
    const skipped = stale.filter((e) => boundRefCounts(e) > 0);

    // 跳过面必须可见：warn 日志 + 审计（fail-open，绝不影响主链）。
    for (const exec of skipped) {
      const pinnedCount = pinnedCounts.get(exec.id) ?? 0;
      const appNameBound = appNameBoundCounts.get(exec.appName) ?? 0;
      this.logger.warn(
        `Skipped auto-cleanup of executor ${exec.id} (${exec.address}): ` +
          `${pinnedCount} task(s) still pin it via task.executorId and ` +
          `${appNameBound} task(s) bind it via task.executorAppName — unpin/retarget ` +
          `them first, otherwise they would fail dispatch after deletion`,
      );
      try {
        await this.audit?.log({
          action: "executor.cleanup_skipped",
          resource: "executor",
          resourceId: exec.id,
          detail: {
            address: exec.address,
            appName: exec.appName,
            pinnedTasks: pinnedCount,
            appNameBoundTasks: appNameBound,
          },
        });
      } catch (err) {
        this.logger.warn(
          `audit write failed for executor.cleanup_skipped on ${exec.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (deletable.length === 0) return;
    const result = await this.repo.delete({
      id: In(deletable.map((e) => e.id)),
    });
    if (result.affected && result.affected > 0) {
      this.logger.log(
        `Cleaned up ${result.affected} offline executor(s) (idle > ${retentionDays} days)`,
      );
      // 与手动删除同款卫生：清 pull 队列与派生缓存（best-effort）。
      for (const exec of deletable) {
        await this.pullService?.clear(exec.id).catch(() => undefined);
        // ADR-017 阶段 3：不再裸 delete(address) —— issuedTokenCache 的键是
        // 定位身份（指纹优先），按 address 删不到指纹键条目。evictLocalTokenCaches
        // 已按值里的 address 回扫两张派生缓存，此处单行删除反而是漏删的来源。
        this.evictLocalTokenCaches(exec.address);
        // G1（R32-A3）：自动清理与手动删除（removeById）是同一强度的撤销，必须
        // 同样跨实例广播。此前这里只做本地逐出：别的实例上被删执行器的
        // per-executor 令牌/回调密钥仍命中正缓存，还能再活一个
        // TOKEN_CACHE_TTL_MS（60s）——「删除即撤销」在集群范围变成「删除后 60s
        // 撤销」。广播失败仍走 TTL 兜底（见 broadcastTokenEviction 头注）。
        this.broadcastTokenEviction(exec.address);
        // 阶段 3 复查补口：行没了 ⇒ 这份安装立刻不再"在场"。只忘自己的指纹
        // （不是整个地址）——pull 同址多行时别的安装可能还活得好好的。
        this.deviceFingerprintTracker.forget(
          exec.address,
          exec.deviceFingerprint,
        );
      }
    }
  }

  /**
   * SEC-03: Issue a fresh per-executor token.
   * Returns the raw token once (caller must store it); only the bcrypt hash is persisted.
   * AUTH-05: accepts an optional admin-supplied `reason` (≤200 chars, capped)
   * that lands in the audit detail — the rotation itself is unchanged.
   */
  async rotateToken(id: string, reason?: string): Promise<{ token: string }> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new AppError("EXECUTOR_NOT_FOUND");
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = await bcrypt.hash(rawToken, 12);
    executor.tokenHash = tokenHash;
    // R51-A1（ADR-026 规则 4）：这里此前是 `save(executor)` **整行回写**——executor 是
    // 上面 findOne 的快照，而 `bcrypt.hash(…, 12)` 的 await 是一段**数百毫秒**的可交错
    // 窗口。窗口内任何并发写者落库后，整行 save 的 diff 都会把快照里过期的列判成"改动"
    // 写回：stale sweep/管理台刚置的 `status=OFFLINE` 被改回 ONLINE（扇出到派发闸门 =
    // 把任务派给一台死机）、派发原子 `+1`/sweep 原子 `-1` 的 `runningTaskCount`、
    // `lastHeartbeat`、`cpuUsage` 等整批回滚。轮换真正要写的**只有一列**。
    // 注：`tokenHash` 是 select:false（entity:234），快照里本来就是 undefined —— 所以本
    // 改动**不是**为了"回滚 tokenHash"（R32-C2 已证伪），而是为了不再顺带写别的列。
    // adr-026-exempt: 只写 tokenHash 一列且**末次写入即正确语义**（两次并发轮换的语义就是
    // "后一次生效、前一次明文作废"，不存在需要前置断言的状态迁移）；不触碰 status /
    // 生命周期 / 计数 / 指标列。反过来加 version/哈希 CAS 会让轮换在窗口内恰好有心跳时
    // 凭空失败（心跳 30s 一次，命中率不低），把一个"少写列"的修复变成可用性回归。
    await this.repo.update({ id: executor.id }, { tokenHash });
    // N26: a rotation invalidates the per-address callback-secret cache so
    // the new hash is visible immediately (and the stale one stops being
    // offered as an HMAC candidate). R9 (round-8 P1 closure): the executor
    // now picks the new hash up on its next /token fetch or heartbeat (both
    // responses carry tokenHash — see issueToken() and the heartbeat
    // controller), not only at register; until that pickup per-execution
    // callback tokens signed with the old hash fail verification —
    // documented constraint in docs/sdk-guide.md. R10 (round-10 gap #3):
    // executor-node self-heals a stale bearer within one request round-trip
    // (401 → forceTokenRefresh → POST /token → adopt token+hash → retry),
    // so a manual rotation converges in ≤ one heartbeat interval.
    // ARCH-31 §3.7：本地逐出 + 跨实例广播（其他实例毫秒级逐出，广播失败走
    // 60s TTL 兜底）。否则「撤销」在其他实例上仍有一段失效窗口。
    this.evictLocalTokenCaches(executor.address);
    this.broadcastTokenEviction(executor.address);
    // R10: seed the idempotent-issuance cache with the fresh plaintext under
    // the executor's CURRENT startupId. Without this, the self-healing
    // POST /token (same startupId) would find the cache still holding the
    // pre-rotation plaintext, fail its bcrypt re-verification and rotate a
    // SECOND time — killing the very token this response just showed the
    // admin UI within seconds. With it, the same-startupId re-fetch returns
    // exactly this token (issueToken's possession re-verification still
    // guards against resurrecting a later rotated-away plaintext), making
    // "rotate in the UI" mean "the online executor adopts THIS token".
    //
    // ADR-017 阶段 3：种入的键必须与 issueToken 读取的键**同口径**（定位身份，
    // 指纹优先）——否则「UI 轮换 → 执行器自愈 POST /token」会读到另一条键，
    // 找不到刚种入的明文 → bcrypt 复核失败 → 又轮换一次（本注释开头描述的
    // 那个双轮换缺陷会在同址多行的场景重新出现）。行内指纹是 NOT NULL 列
    // （真实指纹或 legacy 兜底键），legacy 键经 normalize 回落 address，与
    // issueToken 的缺省分支同形。
    this.rememberIssuedToken(
      this.tokenCacheIdentityKey(executor.address, executor.deviceFingerprint),
      {
        token: rawToken,
        startupId: executor.executorStartupId ?? null,
        issuedAt: Date.now(),
        address: executor.address,
      },
    );
    this.logger.log(`Rotated token for executor ${id} (${executor.address})`);
    // AUTH-05: rotate-token is a high-risk operation — audit it (with the
    // admin-supplied reason when present). Best-effort, after the mutation.
    await this.auditHighRisk("executor.rotate_token", executor, reason);
    return { token: rawToken };
  }

  /**
   * R9 (round-8 P1 closure, W2): idempotent token issuance for
   * POST /executors/token — the same (address, startupId) re-fetch returns
   * the CURRENT token instead of rotating. Rotation still happens when:
   * - the address has no issued token in this process yet (first issuance,
   *   or the admin-api restarted and lost the in-memory plaintext cache),
   * - the request carries a DIFFERENT startupId (a restarted executor —
   *   N4 register semantics), or
   * - a legacy request without startupId arrives outside the short reuse
   *   window (can't prove same process life; the window bounds any
   *   poll-on-loop client to at most one rotation per window), or
   * - the cached plaintext no longer verifies against the stored tokenHash
   *   (an admin-UI rotate-token invalidated it).
   *
   * Returns the raw token (shown once per rotation — reuse hands it back
   * only to the authenticated executor that already holds it) plus the
   * CURRENT stored tokenHash, so the executor can keep its N26 callback
   * HMAC secret in sync with whatever this response authorized.
   */
  async issueToken(data: {
    address: string;
    appName: string;
    startupId?: string | null;
    // ADR-017 阶段 3（复查补口）：稳定设备指纹——**定位键**。两端
    // `/executors/token` 均已随载荷上报（node middleware/auth.ts::fetchToken、
    // python auth.py::_fetch_token），控制器经 F-7 白名单转发。
    //
    // 缺了它会发生什么（本补口要修的缺陷）：`register({address, appName})` 的
    // 指纹入口拿到 null → 回落 `findOne({where:{address}})` → pull 同址多行时
    // **任取一行** → `rotateToken(该行.id)`。即合法执行器的换发请求会去**轮换
    // 另一台执行器的令牌**（那台随即 401，其执行卡在 RUNNING 直到 stale sweep）。
    // 这是 30min 轮换 + 401 自愈的实际通路，故不是理论问题。
    deviceFingerprint?: string | null;
  }): Promise<{ token: string; tokenHash: string | null }> {
    // Keep the existing register-on-token semantics (creates the row for
    // unknown addresses, refreshes ONLINE/lastHeartbeat). Deliberately NOT
    // forwarding startupId/restartedAt here: restart detection via /token
    // would let a stale residual process fail live executions — that stays
    // the register/heartbeat endpoints' job.
    const executor = await this.register({
      address: data.address,
      appName: data.appName,
      // 指纹是定位键（非重启信号），与 startupId/restartedAt 的取舍不同：
      // 转发它只影响「定位到哪一行」，不引入重启检测路径。
      deviceFingerprint: data.deviceFingerprint,
    });
    const incomingStartupId = data.startupId?.trim() || null;
    const now = Date.now();
    // ADR-017 阶段 3：缓存键取**定位身份**（指纹优先）——同址两行各自成键，
    // 不会把第一台的明文令牌幂等回给第二台（见 issuedTokenCache 字段注释）。
    const identityKey = this.tokenCacheIdentityKey(
      data.address,
      data.deviceFingerprint,
    );
    const cached = this.issuedTokenCache.get(identityKey);
    // N34: an entry past the TTL is treated as stale (rotate fresh) even if
    // the startupId still matches — same fail-safe as a cold cache.
    if (
      cached &&
      now - cached.issuedAt < ExecutorService.TOKEN_ISSUE_CACHE_TTL_MS
    ) {
      const sameProcess =
        incomingStartupId !== null && cached.startupId === incomingStartupId;
      const legacyInWindow =
        incomingStartupId === null &&
        cached.startupId === null &&
        now - cached.issuedAt < ExecutorService.TOKEN_ISSUE_REUSE_WINDOW_MS;
      if (sameProcess || legacyInWindow) {
        // Verify the cached plaintext is STILL the token behind the stored
        // hash before handing it out again (an admin-UI rotation must not
        // be resurrected by this endpoint).
        //
        // ADR-017 阶段 3：复核也必须走**同一行身份**——`register` 已把行解析
        // 收敛到 `executor`，用它取哈希（此前的裸 address 查询在同址多行时
        // 会读到别人的哈希，导致「缓存的明文与自己那行不匹配」→ 误判为需要
        // 轮换 → 无谓轮换风暴）。
        const stored = await this.getCallbackSecretById(executor.id);
        if (stored && (await bcrypt.compare(cached.token, stored))) {
          this.logger.debug(
            `Idempotent token reuse for executor ${executor.id} (${data.address}) (${
              incomingStartupId !== null
                ? "same startupId"
                : "legacy fetch in reuse window"
            }); no rotation`,
          );
          return { token: cached.token, tokenHash: stored };
        }
      }
    }
    const { token } = await this.rotateToken(executor.id);
    // ADR-017 阶段 3：按**行身份**取回显哈希（pull 同址多行时 address 有歧义；
    // rotateToken 刚清过缓存，故这是新哈希）。
    const tokenHash = await this.getCallbackSecretById(executor.id);
    this.rememberIssuedToken(identityKey, {
      token,
      startupId: incomingStartupId,
      issuedAt: now,
      address: data.address,
    });
    return { token, tokenHash };
  }

  /**
   * SEC-03: Validate a per-executor token.
   * Falls back to the legacy shared token for backward compatibility.
   */
  /** Admin: manually remove an executor record by ID */
  async removeById(id: string, reason?: string): Promise<void> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new AppError("EXECUTOR_NOT_FOUND");
    await this.repo.remove(executor);
    // R9: drop the idempotent-issuance plaintext cache entry with the row —
    // a re-registered address must get a fresh token, never the removed one.
    //
    // ADR-017 阶段 3：不再裸 delete(address) —— issuedTokenCache 的键是定位
    // 身份（指纹优先），按 address 删不到指纹键条目。下面的
    // evictLocalTokenCaches 已按值里的 address 回扫两张派生缓存。
    // 同理清掉该地址的 callback 密钥候选与 F-5 正缓存：行都没了，旧 token
    // 更不能继续被接受（否则删除执行器后旧凭据还有 60s 可用窗口）。
    // ARCH-31 §3.7：跨实例广播同 rotate——删除是更强的撤销，别的实例也必须
    // 立刻忘记该地址的全部派生缓存。
    this.evictLocalTokenCaches(executor.address);
    this.broadcastTokenEviction(executor.address);
    // DEEP-AUDIT B·1.1：删除行的同时清掉该执行器的 pull 任务/命令队列。
    // 队列键是 executorId，行删除后同 id 重注册会拿到新 id——残留队列既
    // 无人取件、也无人可见，只能等 TTL 静默过期；显式清掉让语义即时收敛。
    // best-effort：Redis 抖动不阻断删除主链（TTL 丢弃语义兜底）。
    await this.pullService?.clear(executor.id).catch(() => undefined);
    // 阶段 3 复查补口：删除即视该安装离场 —— 冲突跟踪器同步忘记它，让
    // 「运维删掉多余行」这个动作**当场**止住告警（旧实现要再等一个 liveness
    // 窗口，现场观感就是"删了也没用"）。
    this.deviceFingerprintTracker.forget(
      executor.address,
      executor.deviceFingerprint,
    );
    this.logger.log(`Executor ${id} (${executor.address}) removed by admin`);
    // AUTH-05: executor deletion is destructive — audit it (with the
    // admin-supplied reason when present). Best-effort, after the mutation.
    await this.auditHighRisk("executor.delete", executor, reason);
  }

  /**
   * DEEP-AUDIT B·1.1：执行器删除影响面预览（对齐应用域 GET /:id/removal-impact
   * 的先例）。旧实现删除（手动 removeById / 自动 cleanupOfflineExecutors）对
   * `task.executorId / task.executorAppName` 的引用零感知——钉定任务在删除后
   * 派发即抛 "Pinned executor not found" 且分类 UNKNOWN 无重试，等于**静默
   * 制造必失败任务**。本端点让确认框能如实列出影响面；自动清理的跳过判定
   * 也复用这里的口径（countPinnedTaskCount）。
   */
  async describeRemovalImpact(id: string): Promise<{
    appName: string;
    address: string;
    status: string;
    /** task.executorId 显式钉定（pin）到本执行器的任务数。 */
    pinnedTasks: number;
    /** task.executorAppName 按名字绑定到本执行器的任务数（dispatch 按
     *  appName 精确匹配、不静默换机——绑定行同样会因删除而必失败）。 */
    appNameBoundTasks: number;
    /** pull 模式待拉取队列深度（acf:pull:{id} 的 LLEN；仅 pull 执行器非零）。 */
    pendingPullItems: number;
  }> {
    const executor = await this.repo.findOne({ where: { id } });
    if (!executor) throw new AppError("EXECUTOR_NOT_FOUND");
    return {
      appName: executor.appName,
      address: executor.address,
      status: executor.status,
      pinnedTasks: await this.countTasksBoundToExecutor(executor),
      appNameBoundTasks: await this.countTasksBoundByAppName(executor.appName),
      // best-effort：Redis 不可用时按 0（未知）呈现，不阻断预览。注意 `?.`
      // 会短路整条链（pullService 缺席时 catch/then 都不执行、表达式整体为
      // undefined）——外层再 `?? 0` 归一，否则返回值违反本签名的 number。
      pendingPullItems:
        (await this.pullService?.depth(executor.id).catch(() => 0)) ?? 0,
    };
  }

  /**
   * DEEP-AUDIT B·1.1：钉定（task.executorId = 本执行器）的任务数。
   * 排除软删除行；纯 count 查询，供删除预览与自动清理跳过判定共用同一口径。
   */
  private async countTasksBoundToExecutor(
    executor: Pick<Executor, "id">,
  ): Promise<number> {
    try {
      return await this.taskRepo.count({
        where: {
          executorId: executor.id,
          status: Not(TaskStatus.DELETED),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Removal impact: pinned-task count unavailable for executor ${executor.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /** DEEP-AUDIT B·1.1：task.executorAppName 按名字绑定到本执行器的任务数。 */
  /**
   * R32-C6：该地址上是否**还存在别的行**（bounded take:2，只回答「不止一行」）。
   *
   * 用途见 register() 的「升级接管」分支：legacy 行接管只在地址无歧义时成立，
   * 一旦同址还有别的行，就无法区分「自己那行老行」与「别人的墓碑行」。
   * select 收窄到 id —— register/heartbeat 都是高频面，不拉 appName/
   * runningExecutionIds 这类重列。
   */
  private async hasOtherAddressRow(
    address: string,
    rowId: string,
  ): Promise<boolean> {
    const rows = await this.repo.find({
      where: { address },
      take: 2,
      select: { id: true },
    });
    return rows.some((r) => r.id !== rowId);
  }

  /**
   * P1-A（2026-10-25 真机审计）：占位行是否已「死透」到可以把 push 地址让出来
   * （register 的 foreignInstall 接管判定，见方法内注释）。
   *
   * 三个前置缺一不可（宁可 409 也不误接管）：
   *  ① status=OFFLINE —— stale sweep（连续两轮心跳超时）已判死；ONLINE 行
   *     哪怕心跳很旧也不接管（判死是 sweep 的职责，这里不重复判）；
   *  ② dispatchMode=push —— 地址唯一性由 push 行承载（partial 唯一索引）；
   *     接管 pull 行会把 dispatchMode 翻成 push，可能与同址另一 push 行撞
   *     唯一索引，且 pull 行本就不占路由位——那种组合保持 409 fail-closed；
   *  ③ 静默超窗 —— 以 lastHeartbeat 为准（register/心跳都刷新它；执行器
   *     一 dead sweep 就不再动它），缺列时依次回退 updatedAt/createdAt
   *     （行存在即必有其一；三者皆缺 → 判不了静默 → 不接管）。
   *
   * 时间窗可经 `executor.addressTakeoverSilenceMs` 覆盖（缺省
   * EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS）；单机注册路径逐行调用，无热路径
   * 顾虑。测试无需真等：把行的参考时间戳回拨即立即命中。
   */
  private canTakeOverAbandonedAddressRow(row: Executor): boolean {
    if (row.status !== ExecutorStatus.OFFLINE) return false;
    if (row.dispatchMode !== "push") return false;
    const reference = row.lastHeartbeat ?? row.updatedAt ?? row.createdAt;
    const referenceMs = reference
      ? new Date(reference as unknown as string | Date).getTime()
      : Number.NaN;
    if (!Number.isFinite(referenceMs)) return false;
    return Date.now() - referenceMs >= this.resolveAddressTakeoverSilenceMs();
  }

  /** 接管静默窗解析（`executor.addressTakeoverSilenceMs`，非法值回退缺省）。 */
  private resolveAddressTakeoverSilenceMs(): number {
    const raw = this.configService.get<number>(
      "executor.addressTakeoverSilenceMs",
    );
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return raw;
    }
    return EXECUTOR_ADDRESS_TAKEOVER_SILENCE_MS;
  }

  private async countTasksBoundByAppName(appName: string): Promise<number> {
    try {
      return await this.taskRepo.count({
        where: {
          executorAppName: appName,
          status: Not(TaskStatus.DELETED),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Removal impact: appName-bound task count unavailable for "${appName}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  async validateExecutorToken(id: string, presented: string): Promise<boolean> {
    const executor = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.id = :id", { id })
      .getOne();
    if (!executor) return false;
    if (executor.tokenHash) {
      return bcrypt.compare(presented, executor.tokenHash);
    }
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    // SEC-FIX: use timingSafeEqual to prevent timing attacks on shared token comparison
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    if (sharedBuf.length !== presentedBuf.length) return false;
    return timingSafeEqual(sharedBuf, presentedBuf);
  }

  /**
   * ADR-017 阶段 3：**机器面身份解析的单一入口**——指纹优先，address 兜底。
   *
   * 为什么必须收敛到一个方法：阶段 3 把 `uq_executors_address` 收窄为 partial
   * （仅 push 行），pull 模式**允许同地址多行并存**（ADR-017 §5）。此时任何
   * 「按 address 取一行」的调用都可能是**别人的行**——鉴权会校验错 tokenHash、
   * pull 会去拉错队列、回调会取错 HMAC 密钥。此前只有 heartbeat 传了指纹，
   * 其余 9 个机器面调用点仍在裸按地址查（审查确认的 P0 缺口）。
   *
   * 语义：
   * - 传入合法指纹 → 按指纹定位（跨重启稳定，且 pull 同址多行时**唯一定位**）；
   * - 指纹缺省/非法（legacy 执行器、采集失败）→ 回落 address；
   * - **地址命中多行且无指纹可判** → 返回 null（调用方 fail-closed）。
   *   不能任取一行：取错行会让 A 的凭据被用来操作 B 的行。legacy 执行器在
   *   「同址多行」这个状态下本就无法自证是哪一台——拒绝比猜错安全。
   *   单行部署（引入本改动前的全部现实形态）行为与原来逐字节一致。
   *
   * @param opts.withTokenHash 为 true 时一并取出 `tokenHash`（select:false 列）。
   */
  private async resolveExecutorRow(
    address: string,
    deviceFingerprint?: string | null,
    opts: { withTokenHash?: boolean; reportedExecutorId?: string | null } = {},
  ): Promise<Executor | null> {
    const fp = normalizeDeviceFingerprint(deviceFingerprint);
    const build = () => {
      const qb = this.repo.createQueryBuilder("e");
      if (opts.withTokenHash) qb.addSelect("e.tokenHash");
      return qb;
    };
    if (fp) {
      const byFingerprint = await build()
        .where("e.deviceFingerprint = :fp", { fp })
        .getOne();
      if (byFingerprint) return byFingerprint;
    }
    const byAddress = await build()
      .where("e.address = :address", { address })
      .getMany();
    if (byAddress.length === 1) return byAddress[0];
    if (byAddress.length > 1) {
      // ADR-017 决策 §3 补全（工单 11）：请求自报的**行 id** 若正好是候选之一，
      // 说明调用方已经知道自己是哪一行（执行器侧持久化了注册响应里的 id）。
      // 解析层**不采纳**它——行解析不验凭据，直接采信等于把「声明别人的行 id」
      // 变成越权入口。真正的采纳在 authenticateMachineRequest：只有该行的
      // per-executor 令牌校验通过才认（共享令牌一律不认）。
      const reported = ExecutorService.normalizeReportedExecutorId(
        opts.reportedExecutorId,
      );
      const hint = reported
        ? byAddress.find((row) => row.id === reported)
        : undefined;
      if (hint) {
        this.logger.debug(
          `Identity for address "${address}" is ambiguous (${byAddress.length} rows); the ` +
            `request reported row id ${reported}, which is one of them — deferring to the ` +
            `per-executor token check instead of failing closed`,
        );
        return null;
      }
      // 同地址多行并存且本次未带指纹：无法判定归属。
      this.logger.warn(
        `Identity resolution for address "${address}" is ambiguous: ` +
          `${byAddress.length} executor rows share it and this request carried ` +
          `no deviceFingerprint, so the row cannot be identified. Refusing ` +
          `(fail-closed) — upgrade the executor to protocol v3 so it reports ` +
          `deviceFingerprint, or give it a unique EXECUTOR_ADDRESS_PUBLIC.`,
      );
      return null;
    }
    return null;
  }

  /**
   * ADR-017 阶段 3：**同地址任一行**匹配即通过（用于执行回调等「只带地址、
   * 无法携带指纹」的机器面）。
   *
   * 与 {@link validateTokenByAddress} 的分工：
   * - `validateTokenByAddress` 用于**能带指纹**的面（心跳/注册/pull/config），
   *   指纹优先、同址多行无指纹时 fail-closed——因为那些面要**定位到具体一行**
   *   去做副作用（更新计数、拉队列），猜错行比拒绝更糟。
   * - 本方法用于**只做凭据校验、不需要定位行**的面（回调上报）。此时「同址
   *   另一行的哈希匹配」仍证明调用方持有该地址上某台执行器的合法凭据——不是
   *   越权。逐个试全部候选既不会误拒合法执行器，也不放宽任何判定（每个候选都
   *   走完整 bcrypt/共享 token 比对）。
   *
   * 单行地址（引入本改动前的全部现实形态）行为与原来逐字节一致。
   */
  async validateTokenByAddressAnyRow(
    address: string,
    presented: string,
  ): Promise<boolean> {
    if (!presented) return false;
    if (!address) return false;
    const rows = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      .limit(ExecutorService.MAX_CALLBACK_SECRET_CANDIDATES)
      .getMany();
    for (const row of rows) {
      if (!row.tokenHash) continue;
      // 每个候选都走完整比对；任一命中即持有该地址上某台的凭据。
      if (await bcrypt.compare(presented, row.tokenHash)) {
        return true;
      }
    }
    // 回退共享 token（与原实现同序：per-executor 优先，共享兜底）。
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    if (sharedBuf.length !== presentedBuf.length) return false;
    return timingSafeEqual(sharedBuf, presentedBuf);
  }

  /**
   * ADR-017 阶段 3（协议 v6，方案 C 补口）：按**回调自报的指纹**解析行 id。
   *
   * 用途见 `ExecutionCallbackController` 的「行身份三级阶梯」注释：指纹是回调
   * 面的第一级归属依据，补上「共享令牌不绑定任何行」的缺口。
   *
   * 语义（**刻意极简**）：
   * - 规范化（64 位小写十六进制，与 register/heartbeat 同一入口）；缺省/非法
   *   → 直接返回 null（= 未上报），**不抛错**——回调主链绝不能因一个可选字段
   *   的形态问题而失败（兼容性红线：旧执行器/采集失败/SDK 调用方都可能不带它）。
   * - 查库按 `deviceFingerprint` 命中行 → 返回其 id；查不到（行已被
   *   cleanupOfflineExecutors 删除，或指纹从未落库）→ null，由下一级承接。
   * - **不做鉴权判定**：指纹是自报值，本方法只回答「这个自报值对应哪一行」，
   *   是否接受该回调仍由 task.service 的行身份判据与鉴权链决定。
   */
  async resolveExecutorIdByFingerprint(
    deviceFingerprint?: string | null,
  ): Promise<string | null> {
    const fp = normalizeDeviceFingerprint(deviceFingerprint);
    if (!fp) return null;
    const row = await this.repo.findOne({
      where: { deviceFingerprint: fp },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /**
   * ADR-017 阶段 3（复查补口）：解析**所持凭据属于哪一行**。
   *
   * 与 {@link validateTokenByAddressAnyRow} 的分工：后者只回答「这个令牌能不
   * 能通过」，本方法回答「它属于哪一行」——回调面需要后者来做行身份判定
   * （同址多行并存时地址字符串不再能证明是同一台机器，见 task.service 的
   * 回调闸与迁移 1790000000055 的类注释）。
   *
   * 语义：
   * - 逐行 bcrypt 比对，**返回第一个匹配行的 id**；
   * - 无任何行使 per-executor 令牌匹配（共享令牌、或已轮换/无效）→ 返回
   *   `null`。**null 是"没有行身份可判"而非"校验失败"**：调用方据此回落
   *   原有判据（共享令牌路径本就不绑定任何行）。校验通过与否仍由调用方
   *   既有的 verifyExecutorToken / validateTokenByAddressAnyRow 决定，
   *   本方法**不**作为唯一鉴权闸。
   * - 上限 `MAX_CALLBACK_SECRET_CANDIDATES`（防病态数据把该面退化成 O(全表)
   *   的 bcrypt 循环；真实碰撞场景是 2~3 台）。
   */
  async resolveCredentialExecutorId(
    address: string,
    presented: string,
  ): Promise<string | null> {
    if (!address || !presented) return null;
    const rows = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      .limit(ExecutorService.MAX_CALLBACK_SECRET_CANDIDATES)
      .getMany();
    for (const row of rows) {
      if (!row.tokenHash) continue;
      if (await bcrypt.compare(presented, row.tokenHash)) return row.id;
    }
    return null;
  }

  /**
   * SEC-03: Validate executor token by address (used for heartbeat/register validation).
   * Supports both per-executor dynamic tokens and the legacy shared token.
   *
   * ADR-017 阶段 3：可选 `deviceFingerprint` 参数——提供时**先按指纹定位行**
   * （命中即校验该行 token），再回落到 address 定位。必要性：pull 模式允许
   * 同地址多行并存（ADR-017 §5），纯按 address 定位会把第二台的心跳/回调校验
   * 到第一台的行上；且换 IP 后注册未到（竞态）时，指纹路径让心跳仍能命中自己
   * 的行。legacy 执行器（不传指纹）行为与引入前逐字节一致；**唯一致命例外**是
   * 「同址多行 + 无指纹」——那时 fail-closed 拒绝（见 resolveExecutorRow）。
   */
  /**
   * 工单 11（ADR-017 决策 §3 补全）：机器面**认证 + 行定位**的统一入口。
   *
   * 与 validateTokenByAddress 的关系：后者退化为本方法的布尔投影（行为逐字节
   * 不变）；需要**定位行**的面（pull / config / terminal-states）改调本方法，
   * 避免「先按地址解析一次、再按同一个地址解析第二次」的重复查询与口径漂移。
   *
   * ## 为什么需要 `reportedExecutorId`（执行器自报的行 id）
   *
   * 现场（2026-10-22 §4.6）：36 次 `Identity resolution … is ambiguous` —— 同址
   * 两行窗口里，**没有可解析指纹的那台**每次 pull/config 都被 fail-closed 拒掉
   * （拿不到任务与命令），而它其实持有**自己那行**的 per-executor 令牌。
   * 注册响应本来就把 `id` 返回给了执行器（控制器 `...executor`），只是执行器侧
   * 从不持久化、也不回传——这是身份体系的最后一段空档。
   *
   * ## 采纳规则（安全边界，改动前先读这段）
   *
   * 自报的 id **只在同时满足以下三条**时才被采纳为行身份：
   *   ① 按指纹/地址的常规解析**解析不出来**（resolution 返回 null，即歧义态）；
   *   ② 该 id 指向的行**确实存在于该地址下**（`row.address === address`）；
   *   ③ 呈现的令牌与该行的 `tokenHash` **bcrypt 校验通过**（**不看**正缓存，
   *      必须现场比对——否则共享令牌路径的缓存命中会变成越权入口）。
   *
   * 也就是说：**共享令牌永远不能借自报 id 定位行**（共享令牌是机队级凭据，
   * 若能借它声明别人的行 id，就能拉走别人那行的 `acf:pull:` 队列 = 跨行窃取
   * 任务）。自报 id 只是「候选行的**提示**」，授权仍由该行自己的令牌给出。
   */
  async authenticateMachineRequest(
    address: string,
    presented: string,
    opts: {
      deviceFingerprint?: string | null;
      reportedExecutorId?: string | null;
    } = {},
  ): Promise<MachineAuthResult> {
    // 真机冒烟（round-16）：无 Authorization 头的心跳（presented=undefined）
    // 曾在 Buffer.from 处抛 500——未携带凭据就是未通过，直接 fail-closed。
    if (!presented || !address) {
      return { ok: false, executor: null, via: "none", resolvedBy: "none" };
    }
    const fp = normalizeDeviceFingerprint(opts.deviceFingerprint);
    // F-5: positive-result cache — 同一 (定位身份, token) 在 TTL 内跳过 bcrypt。
    // 它只回答「这份凭据是否有效」，**不**参与行定位（见下方 hint 规则③）。
    const identityKey = this.tokenCacheIdentityKey(address, fp);
    const cacheKey = createHash("sha256")
      .update(`${identityKey}|${presented}`)
      .digest("hex");
    const entry = this.tokenValidationCache.get(cacheKey);
    const now = Date.now();
    const cachedOk =
      entry !== undefined &&
      now - entry.cachedAt < ExecutorService.TOKEN_CACHE_TTL_MS;

    const executor = await this.resolveExecutorRow(address, fp, {
      withTokenHash: true,
      reportedExecutorId: opts.reportedExecutorId,
    });
    const resolvedBy: MachineAuthResult["resolvedBy"] = executor
      ? fp
        ? "fingerprint"
        : "address"
      : "none";

    // ① 按行令牌（指纹/地址定位成功时）
    if (executor && executor.tokenHash) {
      const ok =
        cachedOk || (await bcrypt.compare(presented, executor.tokenHash));
      if (ok) {
        this.rememberTokenValidation(cacheKey, address, now);
        return { ok: true, executor, via: "per-executor", resolvedBy };
      }
    }

    // ② 共享令牌（与引入本方法前逐字节一致：timing-safe 比对，空配置即不可用）
    const sharedOk = await this.compareSharedToken(presented);
    if (sharedOk) {
      this.rememberTokenValidation(cacheKey, address, now);
      // 共享令牌**不**采纳自报 id（见头注安全边界）：歧义态仍是 null。
      return { ok: true, executor, via: "shared", resolvedBy };
    }

    // ③ 自报行 id 提示（解析歧义 + 该 id 属于本地址 + **该行令牌**校验通过）
    const reported = ExecutorService.normalizeReportedExecutorId(
      opts.reportedExecutorId,
    );
    if (!executor && reported) {
      const hint = await this.repo
        .createQueryBuilder("e")
        .addSelect("e.tokenHash")
        .where("e.id = :id", { id: reported })
        .getOne();
      if (hint && hint.address === address && hint.tokenHash) {
        // 现场比对（不查正缓存）：缓存只证明「这份 token 曾对某行有效」，
        // 不能证明「它对**这一行**有效」。
        if (await bcrypt.compare(presented, hint.tokenHash)) {
          this.logger.log(
            `Machine request from "${address}" resolved to executor ${hint.id} by its ` +
              `reported row id after per-executor token verification (address-ambiguous, ` +
              `no fingerprint)`,
          );
          this.rememberTokenValidation(cacheKey, address, now);
          return {
            ok: true,
            executor: hint,
            via: "per-executor",
            resolvedBy: "reported-id",
          };
        }
      }
    }

    return { ok: false, executor: null, via: "none", resolvedBy: "none" };
  }

  /**
   * 自报行 id 的合法形态（uuid 文本；长度上限防病态输入）。
   * 非法/缺省 → null（等同于未上报，行为与引入工单 11 前一致）。
   */
  private static normalizeReportedExecutorId(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64) return null;
    return /^[0-9a-fA-F-]+$/.test(trimmed) ? trimmed : null;
  }

  /** 共享令牌比对（timing-safe；未配置即不可用，与既有语义一致）。 */
  private async compareSharedToken(presented: string): Promise<boolean> {
    const shared = await this.getSharedToken();
    if (shared.length === 0) return false;
    const sharedBuf = Buffer.from(shared, "utf8");
    const presentedBuf = Buffer.from(presented, "utf8");
    // timingSafeEqual 对长度不等会抛错，故先比长度（长度本身不是秘密）。
    if (sharedBuf.length !== presentedBuf.length) return false;
    return timingSafeEqual(sharedBuf, presentedBuf);
  }

  async validateTokenByAddress(
    address: string,
    presented: string,
    deviceFingerprint?: string | null,
  ): Promise<boolean> {
    // ADR-017 决策 §3 补全（工单 11）：认证与行定位已合并到
    // authenticateMachineRequest；本方法保留为它的**布尔投影**，
    // 所有既有调用点（heartbeat / register / offline / command-result）
    // 行为逐字节不变：按行令牌 OR 共享令牌，其余一律 false。
    //
    // 注意：本方法**不**接受 `reportedExecutorId`——它的语义是「这份凭据有效吗」，
    // 不涉及「它属于哪一行」。需要按行定位的调用方请直接用 authenticateMachineRequest。
    const result = await this.authenticateMachineRequest(address, presented, {
      deviceFingerprint,
    });
    return result.ok;
  }

  /**
   * ADR-017 阶段 3：**同地址全部行的**回调密钥候选（去重、非空）。
   *
   * 为什么需要「全部」而不是「第一行」：pull 模式允许同地址多行并存（ADR-017
   * §5），而 `task_executions.executorAddress` 只记地址、不记行身份——回调面
   * 无法从执行行反推出究竟是哪一台。按地址取第一行会拿到**别人的** tokenHash：
   * 合法执行器的 v1 HMAC 验签失败 → 401 → 执行卡在 RUNNING 直到 stale sweep。
   *
   * HMAC 验签是「拿候选密钥逐个试」，试全部候选**不降低安全性**（每个候选都
   * 仍须通过完整签名校验，且候选来自同一地址、数量受同址行数约束），但消除了
   * 错行导致的误拒。签名匹配即证明持有该行凭据，归属由此唯一确定。
   *
   * 单行地址（引入本改动前的全部现实形态）返回长度 1 的数组，行为与原来一致。
   */
  async getCallbackSecretCandidatesByAddress(
    address: string,
  ): Promise<string[]> {
    if (!address) return [];
    const rows = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.address = :address", { address })
      // 同址并存的合法行数很小（真实碰撞场景是 2~3 台）；设上限防病态数据
      // 让回调验签退化成 O(全表)。
      .limit(ExecutorService.MAX_CALLBACK_SECRET_CANDIDATES)
      .getMany();
    if (rows.length > 1) {
      this.logger.debug(
        `Callback secret resolution for "${address}" returned ${rows.length} ` +
          `candidate rows (pull-mode duplicate address); all candidates are ` +
          `tried, ownership is proven by the HMAC match.`,
      );
    }
    const hashes = rows
      .map((r) => r.tokenHash)
      .filter((h): h is string => typeof h === "string" && h.length > 0);
    return [...new Set(hashes)];
  }

  /**
   * N26 (round-8): the per-executor callback secret candidate.
   *
   * Returns the executor row's bcrypt `tokenHash` string for `address`
   * (or null when the executor is unknown / has no token). The hash is
   * used as an HMAC *key material* by the per-execution callback token
   * verification fallback (execution-callback.controller) — the raw
   * per-executor token never leaves the executor side and the hash itself
   * is not a preimage leak (bcrypt is one-way; the registrant already
   * holds the raw token, so returning the hash grants nothing new).
   *
   * Positive results are cached for TOKEN_CACHE_TTL_MS (same pattern as
   * validateTokenByAddress); rotateToken() evicts the entry.
   *
   * ADR-017 阶段 3：可选 `deviceFingerprint`——pull 同地址多行并存时按地址取行
   * 会拿到**别人的** `tokenHash`，导致合法执行器的 v1 HMAC 回调 401（执行卡在
   * RUNNING 直到 stale sweep）或跨执行器误验通过。传入指纹即唯一定位；
   * 不传指纹且地址命中多行 → 返回 null（fail-closed，调用方继续试共享密钥）。
   * 缓存也按指纹分键，避免两台在同址上互相串用缓存结果。
   */
  async getCallbackSecretByAddress(
    address: string,
    deviceFingerprint?: string | null,
  ): Promise<string | null> {
    const now = Date.now();
    // 缓存键 = 定位身份（指纹优先），与 validateTokenByAddress /
    // issuedTokenCache 同口径（共用 tokenCacheIdentityKey）。
    const cacheKey = this.tokenCacheIdentityKey(address, deviceFingerprint);
    const cached = this.callbackSecretCache.get(cacheKey);
    if (cached && now - cached.cachedAt < ExecutorService.TOKEN_CACHE_TTL_MS) {
      return cached.hash;
    }
    const executor = await this.resolveExecutorRow(address, deviceFingerprint, {
      withTokenHash: true,
    });
    const hash = executor?.tokenHash ?? null;
    if (hash) {
      this.callbackSecretCache.set(cacheKey, {
        hash,
        cachedAt: now,
        address,
      });
    } else {
      this.callbackSecretCache.delete(cacheKey);
    }
    return hash;
  }

  /**
   * ADR-017 阶段 3：按 `executors.id` 取回调密钥候选——注册响应回显用。
   *
   * 为什么需要它：pull 模式允许同地址多行并存（ADR-017 §5），
   * `getCallbackSecretByAddress` 按地址取行会有歧义（返回先匹配行的哈希）；
   * 注册控制器手里有刚解析出的 `executor.id`，按 id 取是**无歧义**的。
   *
   * 不缓存：register 是启动/低频路径，单次 DB 查询可忽略（也免去 rotateToken
   * 对 id 键的额外驱逐逻辑）。
   */
  async getCallbackSecretById(id: string): Promise<string | null> {
    const executor = await this.repo
      .createQueryBuilder("e")
      .addSelect("e.tokenHash")
      .where("e.id = :id", { id })
      .getOne();
    return executor?.tokenHash ?? null;
  }

  /** F-5: store a successful validation, evicting expired/oldest entries. */
  private rememberTokenValidation(
    cacheKey: string,
    address: string,
    now: number,
  ): void {
    if (this.tokenValidationCache.size >= ExecutorService.TOKEN_CACHE_MAX) {
      for (const [k, entry] of this.tokenValidationCache) {
        if (now - entry.cachedAt >= ExecutorService.TOKEN_CACHE_TTL_MS) {
          this.tokenValidationCache.delete(k);
        }
      }
      while (
        this.tokenValidationCache.size >= ExecutorService.TOKEN_CACHE_MAX
      ) {
        const oldest = this.tokenValidationCache.keys().next().value;
        if (oldest === undefined) break;
        this.tokenValidationCache.delete(oldest);
      }
    }
    this.tokenValidationCache.set(cacheKey, { address, cachedAt: now });
  }

  /**
   * 逐出某 address 在 F-5 正缓存里的全部条目。
   *
   * 为什么必须存在：正缓存的键是 sha256(address|token)，同一地址可能同时挂着
   * 多条（历史 token 各自的成功结果），且键是单向哈希——无法按地址做前缀删除，
   * 只能按值里的 address 扫描。上限 TOKEN_CACHE_MAX=1000，轮换/删除又都是低频
   * 管理动作，O(n) 扫描没有成本。
   *
   * 不驱逐会怎样：rotateToken() 之后旧 token 仍命中正缓存，校验直接 return true，
   * 「撤销凭据」出现最长 TOKEN_CACHE_TTL_MS（60s）的失效窗口——e2e 用例 46 断言
   * 旧 token 必须立即 401，正是这条语义。
   */
  private evictTokenValidationsFor(address: string): void {
    for (const [k, entry] of this.tokenValidationCache) {
      if (entry.address === address) this.tokenValidationCache.delete(k);
    }
  }

  /**
   * N34 (round-9): store an issued plaintext token, evicting expired/oldest
   * entries past the cap — same bounded-growth defense as
   * rememberTokenValidation (F-5). An OVERWRITE of an existing key skips
   * eviction entirely (the map does not grow): R10's rotateToken seeding and
   * issueToken's startupId refinement both write the same key, and the
   * second write must not evict an unrelated executor's entry.
   *
   * ADR-017 阶段 3：`identityKey` 是**定位身份**（指纹优先），`address` 随值
   * 保存供 `evictLocalTokenCaches` 按 address 回扫（键单向派生，无法前缀删除）。
   */
  private rememberIssuedToken(
    identityKey: string,
    entry: {
      token: string;
      startupId: string | null;
      issuedAt: number;
      address: string;
    },
  ): void {
    if (
      !this.issuedTokenCache.has(identityKey) &&
      this.issuedTokenCache.size >= ExecutorService.TOKEN_ISSUE_CACHE_MAX
    ) {
      for (const [k, v] of this.issuedTokenCache) {
        if (
          entry.issuedAt - v.issuedAt >=
          ExecutorService.TOKEN_ISSUE_CACHE_TTL_MS
        ) {
          this.issuedTokenCache.delete(k);
        }
      }
      while (
        this.issuedTokenCache.size >= ExecutorService.TOKEN_ISSUE_CACHE_MAX
      ) {
        const oldest = this.issuedTokenCache.keys().next().value;
        if (oldest === undefined) break;
        this.issuedTokenCache.delete(oldest);
      }
    }
    this.issuedTokenCache.set(identityKey, entry);
  }

  /**
   * Generate install command for executor-node.
   * Returns a shell command the user can run on the target machine to install and start the executor.
   * URL comes from ConfigService; the shared token uses DB-first resolution.
   *
   * Note: this is the single handler for GET /executors/install-cmd. The former
   * install-cmd.controller.ts duplicated this route (unreachable — ExecutorController
   * registers first) and was removed; its shell-quoting protection was merged here.
   */
  async getInstallCmd(): Promise<{
    cmd: string;
    token: string;
    adminApiUrl: string;
  }> {
    // R-12（DEEP_REVIEW 0ef3bbe）: 改读映射节 app.adminApiUrl（此前裸读
    // configService.get("ADMIN_API_URL") 绕过配置中心）。
    const adminApiUrl = this.configService.get<string>("app.adminApiUrl") || "";
    // R7 真机遗留观察①：ADMIN_API_URL 缺失时旧实现会生成
    // `curl -fsSL '/api/executors/install.sh' | bash -s -- --api-url ''`
    // ——相对路径 + 空 api-url 的裸机不可用命令。宁可 503 也不返回废命令。
    if (!adminApiUrl) {
      throw new AppError("EXECUTOR_INSTALL_CMD_NOT_CONFIGURED");
    }
    // DR-01: honor DB rotations rather than handing out a stale env credential.
    const sharedToken = await this.getSharedToken();
    // Shell-quote values to prevent word-splitting / injection when the user
    // copies the generated command into a shell (merged from install-cmd.controller).
    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    // R4-D P1-3 闭环：后端现已承载 GET /api/executors/install.sh
    // （install-script.content.ts，@Public 纯文本），安装命令从旧的
    // `npx autoflow-executor` 形式切回 curl|bash 形式。--api-url 传
    // ADMIN_API_URL 原值（不含 /api 前缀，与 executor .env 语义一致），
    // --secret 传共享 token；两者继续经 q() 转义防注入。
    const scriptUrl = `${adminApiUrl.replace(/\/+$/, "")}/api/executors/install.sh`;
    const cmd = `curl -fsSL ${q(scriptUrl)} | bash -s -- --api-url ${q(adminApiUrl)} --secret ${q(sharedToken)}`;
    // E-7（2026-10-26 执行器域审计）：安装命令内含**共享机器凭据**（--secret
    // 明文，DR-01 既有取舍），「谁在何时取过」必须留痕——rotate_token/delete
    // 同为高危已审计（AUTH-05），本读取面是凭据分发点，补齐同一纪律。
    // best-effort：audit 失败不影响命令生成（auditHighRisk 内部自兜）。
    // 面向对象不是单个执行器行（视图面），按既有 Pick 形态传占位三元组：
    // id 用稳定伪 id 让 audit 列表的 resourceId 可聚合（"install-cmd"），
    // detail 只记 adminApiUrl（token/命令明文绝不入审计）。
    await this.auditHighRisk("executor.install_cmd_viewed", {
      id: "install-cmd",
      address: adminApiUrl,
      appName: "shared-token-view",
    });
    return { cmd, token: sharedToken, adminApiUrl };
  }

  /**
   * Mark an executor as offline (graceful shutdown).
   */
  /**
   * 优雅下线（执行器停机时自报）。
   *
   * ADR-017 阶段 3：`address` 不再是唯一键。此前实现是
   * `repo.update({ address }, …)`（无界 WHERE）+ `findOne({address})` 发事件——
   * pull 同地址多行并存时（ADR-017 §5）会把**另一台仍在线的**执行器一起置
   * OFFLINE（并从调度候选集里摘掉，直到它下一次心跳 ≤30s 才自愈），且
   * `executor.offline` 事件可能挂着别人的 appName。
   *
   * 现在：先按「定位身份」（指纹优先）解析出**恰好一行**再按 id 更新；解析不到
   * 唯一行时保守不动（不知道是谁下线，就不能替任何一行改状态）。
   * 单行部署（引入本改动前的全部现实形态）行为与原来逐字节一致。
   */
  async markOffline(
    address: string,
    deviceFingerprint?: string | null,
  ): Promise<void> {
    const target = await this.resolveExecutorRow(address, deviceFingerprint);
    if (!target) {
      this.logger.warn(
        `markOffline("${address}") could not resolve a unique executor row ` +
          `(unknown address, or ${deviceFingerprint ? "no fingerprint match" : "multiple rows share it without a deviceFingerprint"}); ` +
          `refusing to flip any row offline.`,
      );
      return;
    }
    // R40（ADR-026 最后一项，语义已拍板）：置 OFFLINE 的条件是「**我们观察到的活跃证据
    // 还没变**」——用读取到的 lastHeartbeat 做 CAS。
    //
    // 为什么不是简单加个 status 谓词：真正的竞争是「管理员点下线」与「执行器重新注册/
    // 心跳」撞在一起。若注册/心跳先落库，说明此刻有**更新的活跃证据**，把它翻成 OFFLINE
    // 会让派发闸门在最多一个心跳周期（30s）内拒绝一个其实活着的执行器。按 lastHeartbeat
    // 做 CAS 能把这种「拿旧观察覆盖新事实」挡住；命中 0 就让位并 warn（并发收敛，不是错误）。
    // lastHeartbeat 为 NULL（从未心跳的迁移前/新行）用 IS NULL 表达同一语义。
    const marked = await this.repo.update(
      { id: target.id, lastHeartbeat: target.lastHeartbeat ?? IsNull() },
      // 遗留 P1-24：优雅下线。
      {
        status: ExecutorStatus.OFFLINE,
        offlineReason: ExecutorOfflineReason.MANUAL,
        lastHeartbeat: new Date(),
      },
    );
    if (!marked.affected) {
      this.logger.warn(
        `markOffline(${address}) lost the race: executor ${target.id} showed newer ` +
          `activity (a register/heartbeat landed after we resolved it) — not flipping it OFFLINE.`,
      );
      return;
    }
    this.logger.log(`Executor ${address} (id=${target.id}) marked as offline`);
    // FEAT-07: 状态落库后发布 executor.offline（优雅停机路径）。
    this.emitExecutorOffline({
      id: target.id,
      appName: target.appName,
      address: target.address,
    });
  }

  /**
   * Admin marks a specific executor offline by ID (stale record cleanup).
   */
  async setOfflineById(id: string): Promise<Executor> {
    const executor = await this.findOne(id);
    // R45（ADR-026 规则 4）：这里此前是「findOne → 改三个字段 → **整行 save**」，
    // 与 markOffline 是**同族缺陷**——R40 只修了按地址那条，这条漏了（也正是静态守卫
    // 的盲区①：它只看 update，看不到 save）。两个后果：
    //   ① 整行回写把并发心跳/注册刚落库的 status / lastHeartbeat / runningTaskCount
    //      按旧快照覆盖（select:false 的列不在快照里，侥幸不被写，其余列照写不误）；
    //   ② 没有「活跃证据是否已变」的前置断言 —— 管理员点下线与执行器重新上线撞在一起时
    //      谁后写谁赢，而不是按语义让位。
    // 与 markOffline 同口径：按读取到的 lastHeartbeat 做 CAS；命中 0 只重新读一次真实行
    // 返回，且**不**发布 executor.offline（否则下游会按「已离线」处置活着的执行器）。
    const marked = await this.repo.update(
      { id: executor.id, lastHeartbeat: executor.lastHeartbeat ?? IsNull() },
      // 遗留 P1-24：管理员手动下线。
      {
        status: ExecutorStatus.OFFLINE,
        offlineReason: ExecutorOfflineReason.MANUAL,
        lastHeartbeat: new Date(),
      },
    );
    if (!marked.affected) {
      this.logger.warn(
        "setOfflineById(" +
          id +
          ") lost the race: the row showed newer activity (a register/heartbeat landed " +
          "after we read it) — not flipping it OFFLINE.",
      );
      return this.findOne(id);
    }
    executor.status = ExecutorStatus.OFFLINE;
    executor.offlineReason = ExecutorOfflineReason.MANUAL;
    executor.lastHeartbeat = new Date();
    this.logger.log(
      `Executor ${executor.address} set offline by admin (id=${id})`,
    );
    // FEAT-07: 状态落库后发布 executor.offline（管理台置离线路径）。
    this.emitExecutorOffline(executor);
    return executor;
  }

  /**
   * Get task executions for a specific executor.
   *
   * ADR-017 阶段 3（决策 §7 读面富化）：本方法**接收的是 executor id**，此前却
   * 按 `executorAddress` 过滤——阶段 3 起 pull 模式允许同址多行并存（ADR-017 §5），
   * 于是「查 A 台的执行历史」会把**同址 B 台**的执行一并列出（并且 total 也偏大）。
   * 这是纯粹的读面错配：调用方本来就持有行身份，没有理由降级成地址。
   *
   * 修法：**优先按行身份**（`executorId`）匹配；存量行（迁移 0055 前派发）没有
   * 该值，故用 `executorId = id OR (executorId IS NULL AND executorAddress = addr)`
   * 的并集把历史也带回来——刻意**不回填**存量行（地址→行映射在同址多行下有歧义，
   * 猜错比留 NULL 更糟，见迁移 0055 类注释），因此这里的并集是唯一正确的口径。
   *
   * 为什么并集的地址支必须带 `executorId IS NULL`：否则同址并存时 B 台的新派发行
   * （有 executorId 且指向 B）会被 A 的地址支卷进来，回到修复前的错配。
   */
  async getExecutorExecutions(
    id: string,
    pagination: PaginationDto,
  ): Promise<{ total: number; items: TaskExecution[] }> {
    const executor = await this.findOne(id);
    const [items, total] = await this.execRepo.findAndCount({
      where: [
        // 新派发：按行身份（无歧义）。
        { executorId: executor.id },
        // 存量行：仅当它没有行身份时才按地址回落。
        { executorId: IsNull(), executorAddress: executor.address },
      ],
      order: { createdAt: "DESC" },
      take: pagination.pageSize,
      skip: (pagination.page - 1) * pagination.pageSize,
    });
    return { total, items };
  }

  /**
   * A6（DEEP_REVIEW §七）：回调可靠性分层——死信对账的**只读**视图。
   *
   * 为什么需要它：执行器本地死信目录里躺着两类文件，在磁盘上长得一模一样，
   * 但处置方式完全相反——
   *
   *   ① 重发预算耗尽（E-05：约 24h 时长预算 / 150 轮）。典型成因是 admin
   *      长时间不可达（滚动升级、网络分区）。admin 恢复后这类**很可能仍值得
   *      重发**：如果 admin 还没把该执行终态化（它的 stale sweep 只在执行器
   *      心跳超时后才跑），回调是 admin 唯一能得知结果、释放执行器槽位的通道。
   *   ② 载荷本身是毒丸（> 64MB / 坏 JSON）。重发永远失败，只等人来看。
   *
   * 区分二者必须问 admin：这条执行到底终态了没有。执行器据此分三层处置——
   *   命中本清单 → 回调已无意义（admin 早有终态），删死信；
   *   未命中 且 死信原因是① → 重新入队重发；
   *   未命中 且 死信原因是② → 保留待人工（重发是纯浪费）。
   *
   * 端点形态刻意只读：它不改任何执行行、不释放槽位、不写审计。真正的状态
   * 变更仍然只经由既有的回调/终态路径发生——对账只是让执行器**不再做无用功**，
   * 不是新增一条写状态的路（多一条写路径就多一处分叉的状态机，A1 收口白做）。
   *
   * @param address 执行器地址（路由参数，已过令牌校验）
   * @param since   水印：只回终态时间 >= since 的行
   * @param limit   单页条数（钳到 [1, TERMINAL_STATES_MAX_LIMIT]）
   * @param executorId ADR-017 阶段 3（决策 §7）：调用方**已解析出的行身份**
   *   （控制器在令牌校验时经 `findByAddress(address, deviceFingerprint)` 得到）。
   *   提供时按行身份过滤；缺省（控制器未传/解析不到唯一行）→ 回落地址，
   *   行为与引入前逐字节一致。
   *
   *   为什么本方法**不能**自己从 address 推：阶段 3 起同址多行并存（ADR-017 §5），
   *   地址在本方法内无法指代一行。调用方（控制器）手里恰有更硬的判据——它刚用
   *   指纹/凭据认证过调用方，知道是哪一行；把结论传进来比在这里重推更准，也避免
   *   本方法长出第二套身份解析逻辑。
   */
  async getTerminalStates(
    address: string,
    opts: { since: Date; limit?: number; executorId?: string | null },
  ): Promise<TerminalStatesResponseDto> {
    const limit = Math.min(
      Math.max(1, Math.floor(opts.limit ?? TERMINAL_STATES_DEFAULT_LIMIT)),
      TERMINAL_STATES_MAX_LIMIT,
    );
    // 多取一条用于判定 hasMore，不返回给调用方。
    const rows = await this.execRepo
      .createQueryBuilder("e")
      .select(["e.id", "e.status", "e.endTime", "e.createdAt"])
      // ADR-017 阶段 3（决策 §7 读面富化）：行身份优先，地址兜底且只覆盖存量行。
      // 并集口径与 getExecutorExecutions / getExecutorMetrics 同源：
      // `executorId = :id OR (executorId IS NULL AND executorAddress = :addr)`。
      // 地址支带 IS NULL 守卫是必需的——否则同址另一台的新派发行会被卷进来，
      // 死信对账会把「别人还没有终态的 executionId」也当成本机已终态（反之亦然）。
      // 未传 executorId（旧调用方/解析不到行）→ 纯地址，行为与引入前一致。
      .where(
        opts.executorId
          ? `(e.executorId = :executorId OR (e.executorId IS NULL AND e.executorAddress = :address))`
          : `e.executorAddress = :address`,
        { address, executorId: opts.executorId ?? undefined },
      )
      .andWhere("e.status IN (:...statuses)", {
        statuses: TERMINAL_EXECUTION_STATUSES as readonly ExecutionStatus[],
      })
      // 水印列用 COALESCE(endTime, createdAt)：endTime 是终态落库时间，但部分
      // 终态路径下可能为 NULL（如未启动即被取消），此时行仍应被对账看见——
      // 否则执行器会永远等一条不会到来的终态记录。判据与
      // s3-log-object-retention 的保留扫描一致。
      .andWhere("COALESCE(e.endTime, e.createdAt) >= :since", {
        since: opts.since,
      })
      .orderBy("COALESCE(e.endTime, e.createdAt)", "ASC")
      .take(limit + 1)
      .getMany();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((r) => ({
        executionId: r.id,
        status: r.status,
        endedAt: (r.endTime ?? r.createdAt)?.toISOString(),
      })),
      hasMore,
      serverTime: new Date().toISOString(),
    };
  }

  /**
   * Get performance metrics for a specific executor.
   *
   * FEAT-04: the response now carries `history` — sampled resource-trend
   * points for the last 24h, read from executor_metrics_history (populated by
   * the executor-node heartbeat pipeline; see getExecutorMetricsHistory for
   * the sampling/downsampling contract). Empty array when the executor has no
   * history rows — the frontend renders an explicit empty state.
   */
  async getExecutorMetrics(id: string): Promise<{
    executor: { id: string; address: string; status: string };
    sevenDayStats: {
      totalExecutions: number;
      successful: number;
      failed: number;
      successRate: number;
      averageDurationMs: number;
    };
    current: {
      runningTaskCount: number;
      /**
       * E-01-RPT: pull 长轮询「已预留但尚未认领」的槽位数。
       * `null` = 该执行器未上报该字段（旧版执行器）→ 前端回落旧口径，
       * 不做「实际运行 = runningTaskCount − reservedSlots」换算。
       */
      reservedSlots: number | null;
      cpuUsage: number | null;
      memUsage: number | null;
      /**
       * DEEP-AUDIT B·1.5: pull 模式待拉取队列深度（acf:pull:{id} 的 LLEN）。
       * push 执行器恒为 0;Redis 不可用时按 0(未知)呈现,不阻断详情读取。
       */
      pendingPullItems: number;
    };
    history: Array<{
      timestamp: string;
      cpuUsage: number | null;
      memUsage: number | null;
      runningTaskCount: number;
    }>;
  }> {
    const executor = await this.findOne(id);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Merge 4 serial queries into 1 for performance
    const statsQuery = await this.execRepo
      .createQueryBuilder("e")
      .select("COUNT(*)", "total")
      .addSelect(
        `SUM(CASE WHEN e.status = '${ExecutionStatus.SUCCESS}' THEN 1 ELSE 0 END)`,
        "successful",
      )
      .addSelect(
        `SUM(CASE WHEN e.status = '${ExecutionStatus.FAILED}' THEN 1 ELSE 0 END)`,
        "failed",
      )
      .addSelect(
        "AVG(CASE WHEN e.duration IS NOT NULL THEN e.duration END)",
        "avgDuration",
      )
      // ADR-017 阶段 3（决策 §7 读面富化）：本方法接收 executor **id**，聚合口径
      // 必须与 getExecutorExecutions 同源——阶段 3 起同址多行并存（ADR-017 §5），
      // 纯按地址会把**同址另一台**的 7 日统计并进来（成功率/均值都被污染）。
      // 并集口径同上：新派发按行身份，存量行（executorId IS NULL）才按地址回落。
      .where(
        "(e.executorId = :executorId OR (e.executorId IS NULL AND e.executorAddress = :address))",
        { executorId: executor.id, address: executor.address },
      )
      .andWhere("e.createdAt >= :date", { date: sevenDaysAgo })
      .getRawOne();

    const totalExecutions = parseInt(statsQuery?.total ?? "0", 10);
    const successful = parseInt(statsQuery?.successful ?? "0", 10);
    const failed = parseInt(statsQuery?.failed ?? "0", 10);
    const avgDurationQuery = { avg: statsQuery?.avgDuration };

    return {
      executor: {
        id: executor.id,
        address: executor.address,
        status: executor.status,
      },
      sevenDayStats: {
        totalExecutions,
        successful,
        failed,
        successRate:
          totalExecutions > 0
            ? Math.round((successful / totalExecutions) * 10000) / 100
            : 0,
        averageDurationMs: avgDurationQuery?.avg
          ? Math.round(parseFloat(avgDurationQuery.avg))
          : 0,
      },
      current: {
        runningTaskCount: executor.runningTaskCount,
        // E-01-RPT: 随详情一并下发，供前端把「已占槽位」换算成「实际运行数」
        // 并抑制 E-01 预留窗口造成的假「不一致」告警。
        reservedSlots: executor.reservedSlots ?? null,
        cpuUsage: executor.cpuUsage,
        memUsage: executor.memUsage,
        // DEEP-AUDIT B·1.5：pull 模式待拉取队列深度（acf:pull:{id} 的 LLEN）。
        // 此前"派了却没人取"只有服务端日志，管理台看不到——push 执行器恒为 0。
        pendingPullItems: await this.pullService
          ?.depth(executor.id)
          .catch(() => 0)
          .then((n) => n ?? 0),
      },
      // ADR-017 阶段 3 复查补口：带上行身份——同址多行时趋势图按行拆分
      // （历史行 executorId 为 NULL，方法内按地址回落，曲线不断档）。
      history: await this.getExecutorMetricsHistory(
        executor.address,
        executor.id,
      ),
    };
  }

  // ── FEAT-04: executor metrics history (24h trend) ────────────────────────
  // Sampling window: the most recent 24h of executor_metrics_history rows.
  public static readonly METRICS_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
  // Downsampling strategy: fixed 15-minute time buckets aggregated with AVG —
  // 24h / 900s = 96 buckets, structurally ≤ the 100-point cap, with full
  // 24h window coverage regardless of heartbeat cadence (whereas even-stride
  // point picking over a row-capped fetch would bias toward one window end).
  public static readonly METRICS_HISTORY_BUCKET_SECONDS = 900;
  // Hard LIMIT guard on the aggregate query as defense-in-depth; the bucket
  // design already caps output at 96 rows.
  public static readonly METRICS_HISTORY_QUERY_LIMIT = 500;

  /**
   * FEAT-04: read the last-24h resource trend samples (CPU / memory /
   * running-task count) for one executor, aggregated into fixed 15-minute AVG
   * buckets (≤96 points), ascending by timestamp.
   *
   * Data source: executor_metrics_history (best-effort snapshots appended by
   * heartbeat after the current executor row is saved; compound indexes
   * (executorId, createdAt) and (executorAddress, createdAt) — the predicate
   * prefers the row identity and falls back to the address for pre-1790000000061
   * rows whose executorId is NULL). AVG
   * ignores NULLs: a bucket whose heartbeats never reported cpuUsage/memUsage
   * yields null — the frontend draws a gap for those points (connectNulls).
   * Returns an EMPTY array when the executor has no history rows (fresh
   * executor or history pipeline not yet active) — the admin UI renders an
   * explicit "no samples" empty state for that case.
   *
   * SQL note: bucket expressions use TypeORM property references
   * (h.createdAt/h.cpuUsage → quoted physical columns, same pattern as the
   * AVG(CASE WHEN e.duration ...) aggregate in getExecutorMetrics); the
   * bucket divisor is a server-computed constant, never user input.
   */
  private async getExecutorMetricsHistory(
    address: string,
    executorId?: string | null,
  ): Promise<
    Array<{
      timestamp: string;
      cpuUsage: number | null;
      memUsage: number | null;
      runningTaskCount: number;
    }>
  > {
    // ADR-017 阶段 3（决策 §7 读面富化）：本面**已收口**（迁移 1790000000061）。
    //
    // 历史缺口（2026-10-22 复查前）：本表当时**只有** `executorAddress`，同址多行
    // 并存时 24h 曲线在物理上无法拆分到行——不是本方法少写一个谓词，而是数据面
    // 缺一列（生产实证：6 台全 pull 机队里有 2 个地址发生过指纹变更 / DHCP 复用，
    // 趋势图把两台的数据混画）。
    //
    // 现状：表已加 `executorId`（uuid, nullable），心跳写面逐行落该列；查询谓词为
    // 「行身份优先 + 历史行按地址回落」（见下方 where）。存量行**不回填**——
    // 同址多行下「地址→行」本就有歧义，猜一个 id 是数据污染（与迁移 0055 对
    // task_executions 的结论同源）；OR 谓词让历史曲线不断档。
    // 影响面不变：本表只服务趋势图，不参与任何判定（派发闸门/恢复/槽位均不读它）。
    const bucketSeconds = ExecutorService.METRICS_HISTORY_BUCKET_SECONDS;
    const since = new Date(
      Date.now() - ExecutorService.METRICS_HISTORY_WINDOW_MS,
    );
    // Bucket start as epoch-seconds aligned to bucketSeconds; kept numeric
    // (no to_timestamp) so the raw driver value parses identically everywhere.
    const bucketExpr = `FLOOR(EXTRACT(EPOCH FROM h.createdAt) / ${bucketSeconds}) * ${bucketSeconds}`;
    const rows: Array<Record<string, unknown>> = await this.metricsHistoryRepo
      .createQueryBuilder("h")
      .select(bucketExpr, "bucket")
      .addSelect("AVG(h.cpuUsage)", "cpu")
      .addSelect("AVG(h.memUsage)", "mem")
      .addSelect("AVG(h.runningTaskCount)", "running")
      // ADR-017 阶段 3 复查补口：**行身份优先，历史行按地址回落**。
      //
      // 迁移 1790000000061 给本表加了 executorId，但**不回填**存量行（同址多行
      // 下「地址→行」本就有歧义，猜一个 id 就是数据污染——与迁移 0055 对
      // task_executions 的结论同源）。故谓词用 OR 形态：新行按行身份拆，
      // executorId IS NULL 的历史行仍按地址归集，24h 曲线不会因为升级而断档。
      // 不带行身份（旧调用方）时退化为纯地址谓词，行为逐字节不变。
      .where(
        executorId
          ? "(h.executorId = :executorId OR (h.executorId IS NULL AND h.executorAddress = :address))"
          : "h.executorAddress = :address",
        executorId ? { executorId, address } : { address },
      )
      .andWhere("h.createdAt > :since", { since })
      .groupBy("bucket")
      .orderBy("bucket", "ASC")
      .limit(ExecutorService.METRICS_HISTORY_QUERY_LIMIT)
      .getRawMany();

    const toNumber = (v: unknown): number | null =>
      v === null || v === undefined ? null : parseFloat(String(v));
    const points: Array<{
      timestamp: string;
      cpuUsage: number | null;
      memUsage: number | null;
      runningTaskCount: number;
    }> = [];
    for (const row of rows) {
      const bucketEpoch = parseFloat(String(row.bucket));
      if (!Number.isFinite(bucketEpoch)) continue; // defensive: skip bad rows
      const cpu = toNumber(row.cpu);
      const mem = toNumber(row.mem);
      const running = toNumber(row.running);
      points.push({
        timestamp: new Date(bucketEpoch * 1000).toISOString(),
        cpuUsage: cpu === null ? null : Math.round(cpu * 10) / 10,
        memUsage: mem === null ? null : Math.round(mem * 10) / 10,
        runningTaskCount: running === null ? 0 : Math.round(running),
      });
    }
    return points;
  }
}
