import { client } from './client';
import { HEARTBEAT_TIMEOUT_FALLBACK_MS } from '../utils/executorLiveness';

export interface Executor {
  id: string;
  appName: string;
  address: string;
  status: string;
  type?: string;
  executorVersion?: string;
  cpuUsage: number;
  memUsage: number;
  diskUsage?: number;
  networkLatency?: number;
  runningTaskCount: number;
  totalTaskCount?: number;
  failedTaskCount?: number;
  lastHeartbeat: string;
  groupName?: string | null;
  tags?: string[] | null;
  description?: string | null;
  maxConcurrentTasks?: number | null;
  /**
   * N-02③（ADR-013 2026-10-02 温和下放）：执行器所属项目（null=平台级，
   * 非 ADMIN 不可管理）。详情页据此 + 当前用户项目角色判定「编辑/配置热更」
   * 入口可见性（rotate/set-offline/delete 恒 ADMIN）。
   */
  projectId?: string | null;
  /**
   * CONSISTENCY-02: 执行器心跳上报的运行中 executionId 列表（≤10000，
   * MAX_RUNNING_EXECUTION_IDS，三端同值；旧注释误记 ≤200——python 侧曾按 200
   * 截断，已在 NETOPT-C P2-1 对齐为 10000）。
   * null = 旧版执行器未上报该字段（区别于 []：已上报且当前空闲）。
   * stale 扫描据此跳过"回调只是迟到"的正常执行，详情页据此做活性交叉核对。
   */
  runningExecutionIds?: string[] | null;
  /**
   * E-01-RPT（生产实证：RPA5 恒显「当前运行任务 1/10」「活性上报 0 条，与运行
   * 计数 1 不一致」，而设备上无任务在跑）：pull 长轮询「已预留但尚未认领」的
   * 槽位数。null = 旧版执行器未上报该字段（区别于 0：已上报且无预留）。
   *
   * 为什么需要它：runningTaskCount 含 E-01 预留（防超卖机制本身），而
   * runningExecutionIds 来自另一个账本（只有真正领取到的执行才有 id），故空闲
   * pull 执行器稳态上报「1 + []」——两个数字都对，却度量了不同的东西。
   * 详情页据此把「已占槽位」换算成「实际运行 = runningTaskCount − reservedSlots」。
   *
   * **绝不参与派发判定**（那是服务端 selectLeastLoaded 的职责，且必须读
   * runningTaskCount 才能保住 E-01 的防超卖语义）。
   */
  reservedSlots?: number | null;
  /**
   * U16: executor-node/python 心跳上报的回调死信（dead-letter）积压数。
   * null = 旧版执行器未上报该字段（区别于 0：已上报且无积压）。
   * >0 表示回调持续失败、载荷已落盘执行器本地 dead-letter，需人工排查。
   */
  deadLetterCount?: number | null;
  /**
   * S4-C4（协议 v9，沙箱姿态在控制面可见）：执行器的**任务沙箱姿态**——
   * 那台机器上的 `TASK_SANDBOX` 到底开没开。
   *
   * 三态**必须**精确区分（塌成两态就退回「看不出来」的原状，这正是本项
   * 要修的缺陷）：
   *   - `null` / `undefined` = **未上报**（旧执行器 / 本列上线前的存量行）
   *     → 详情页显示「未上报」。**不等于直跑**——「不知道」与「确认没开」
   *     是两件事，前者该去看/该去升级，后者是一个已确认的安全取舍。
   *   - `''`   = 已上报且**直跑**（未沙箱）→ 显示「直跑（未沙箱）」。
   *   - `'bwrap'` = 已上报且**在 fail-closed 沙箱里** → 显示「沙箱」。
   *
   * 后端取值域只有 `''` 与 `'bwrap'`（协议 enum 同值），非法上报按「未上报」
   * 处理（fail-safe），故前端不会收到其它值。**纯展示字段**：不参与派发/准入
   * 判定（本项明确不做「无沙箱即拒绝派发」）。
   */
  taskSandbox?: '' | 'bwrap' | null;
  /**

   * ARCH-32: 派发模式。'pull' = NAT 内执行器（长轮询取件，零入站依赖）；

   * 'push' = 默认（中心端入站 POST）。缺省视为 push（旧快照兼容）。

   */

  dispatchMode?: 'push' | 'pull';

  /**
   * ARCH-33（ADR-016）: 协议版本。pull 执行器的控制面入口（配置热更新等）
   * 只在协议 >= 2 时可用——v2 起中台经 pull 响应的 commands 字段下发控制命令，
   * v1 执行器会静默忽略该字段。
   *
   * null/undefined = 存量旧执行器未上报（按 v1 处理，即不支持控制面）。
   * 与 versionCompliant 的兜底方向**刻意相反**：那个是「不得剔除旧执行器」
   * 的兼容性红线（缺省 true），这个是「新增能力可用性」门槛（缺省 false）。
   */
  protocolVersion?: number | null;

  /**

   * EXE-VER-1/UI-17: EXECUTOR_MIN_VERSION 门禁的读面投影——执行器版本低于

   * 中心端下限时 false；门禁关/未上报版本恒 true（旧快照缺省 true）。

   */

  versionCompliant?: boolean;

  /**
   * python_task_multiversion（CONTRACT §2.2）：执行器上报的解释器池清单。
   *
   * 三态语义**必须**精确区分，任一态混淆都会造成调度错判
   * （admin `interpreter-match.util` 的判定完全依赖它）：
   *   - `null` = 旧版执行器**未上报**该字段 → 按"未知"处理，不参与过滤；
   *   - `[]`   = 已上报且池内**确实没有**可用解释器 → 声明了 runtimeVersion
   *              的任务不应派到这台；
   *   - 非空   = 已上报的可用版本清单。
   *
   * 此前本接口没声明该字段，于是 UI 侧拿不到"这台执行器到底有没有 3.11"，
   * 而 admin 的 `findAll()` 是直接展开实体（executor.service.ts:1143），
   * 该字段**一直在响应体里**——属于类型漏声明，不是后端不返回。
   */
  /** 遗留 P1-24：离线原因——manual=优雅下线（主动 shutdown/管理员置离线）；
   *  stale_timeout=心跳超时被 stale sweep 判死；null=在线或旧版执行器未上报。 */
  offlineReason?: 'manual' | 'stale_timeout' | null;
  /**
   * ADR-017 阶段 2/3：稳定设备指纹（sha256 的 64 位小写十六进制）。
   *
   * 后端 `findAll()` 与 DTO 一直在返回它，但手写模型此前**没有声明**——
   * 结果是列表页把它丢掉了：运维收到「Executor address shared by multiple
   * installs（含指纹短 ID）」的外部告警后，在界面上找不到任何可以对应的
   * 行标识（P1-4）。null = 旧版执行器未上报 / 迁移前存量行。
   */
  deviceFingerprint?: string | null;
  interpreters?: Array<{
    /** 完整补丁版本，如 "3.11.13"（不是任务声明的 X.Y）。 */
    version: string;
    /** 池内绝对路径；旧版/探测失败时可能缺省。 */
    path?: string;
    /** 探测时是否可用（文件存在且可执行）。 */
    available?: boolean;
    discoveredAt?: string;
  }> | null;
}

/**
 * DEEP-AUDIT B·1.1: GET /executors/:id/removal-impact 响应——删除影响面预览。
 * pinnedTasks / appNameBoundTasks 的任务在执行器删除后派发即失败
 * （"Pinned executor not found"，无重试），确认框必须如实展示。
 */
export interface ExecutorRemovalImpact {
  appName: string;
  address: string;
  status: string;
  /** task.executorId 显式钉定到本执行器的任务数 */
  pinnedTasks: number;
  /** task.executorAppName 按名字绑定到本执行器的任务数 */
  appNameBoundTasks: number;
  /** pull 模式待拉取队列深度（acf:pull:{id} 的 LLEN；push 恒为 0） */
  pendingPullItems: number;
}

export interface ExecutorMetrics {
  executor: { id: string; address: string; status: string };
  sevenDayStats: {
    totalExecutions: number;
    successful: number;
    failed: number;
    // U13: 后端 executor.service.ts getExecutorMetrics 返回 number（非字符串），
    // 声明对齐，调用点无需 `+` 强转。
    successRate: number;
    averageDurationMs: number;
  };
  current: {
    runningTaskCount: number;
    /**
     * E-01-RPT: pull 长轮询「已预留但尚未认领」的槽位数。
     * null = 该执行器未上报该字段（旧版执行器）→ 详情页回落旧口径
     * （直接显示 runningTaskCount，不做换算、不比对活性条数）。
     */
    reservedSlots?: number | null;
    cpuUsage?: number;
    memUsage?: number;
    /**
     * DEEP-AUDIT B·1.5: pull 模式待拉取队列深度（acf:pull:{id} 的 LLEN）。
     * push 执行器恒为 0；读不到（Redis 抖动）时后端也回 0。
     */
    pendingPullItems?: number;
  };
  /** FEAT-04: 最近 24h 资源趋势采样（15 分钟 AVG 桶，升序）；无数据为空数组 */
  history: ExecutorMetricsHistoryPoint[];
}

/**
 * FEAT-04: GET /executors/:id/metrics `history` 采样点。
 * 后端把最近 24h 的 executor_metrics_history 心跳按固定 15 分钟时间桶 AVG
 * 聚合（24h/900s = ≤96 桶，时间升序）；整桶无 CPU/内存上报时为 null，
 * 前端折线以断点呈现（connectNulls）。
 */
export interface ExecutorMetricsHistoryPoint {
  /** 桶起点时间（ISO 8601 字符串，服务端 toISOString 序列化） */
  timestamp: string;
  /** 桶内 CPU 均值（%）；整桶无上报为 null */
  cpuUsage: number | null;
  /** 桶内内存均值（%）；整桶无上报为 null */
  memUsage: number | null;
  /** 桶内运行任务数均值（四舍五入取整） */
  runningTaskCount: number;
}

export interface ExecutorExecution {
  id: string;
  taskId: string;
  taskName?: string;
  status: string;
  startTime?: string;
  endTime?: string;
  duration?: number;
  errorMessage?: string;
  /** 后端返回完整 TaskExecution 实体：终态退出码（null=旧数据未采集） */
  exitCode?: number | null;
  createdAt: string;
}

export interface SharedTokenResult {
  token: string | null;
  hasToken: boolean;
}

/** GET /executors/install-cmd 返回的执行器一键安装命令信息 */
export interface InstallCmdResult {
  cmd: string;
  token: string;
  adminApiUrl: string;
}

/**
 * GET /executors/runtime-config 返回的执行器面有效运行时参数
 * （executor lifecycle audit P2-5 / P3-9；NETOPT-G P1-7 补齐判死迟滞）。
 * 前端的心跳判死着色与列表截断提示必须以这里的值为准，不得再硬编码。
 *
 * 字段名与后端 DTO 逐字一致（`misc-2xx-response.dto.ts::ExecutorRuntimeConfigDto`），
 * 不改名、不做前端侧聚合——R279 的缺陷根源正是前端「自己推断」判死窗口。
 */
export interface ExecutorRuntimeConfig {
  /** 心跳间隔（毫秒，默认 30000）。 */
  heartbeatIntervalMs: number;
  /** 判死倍数（默认 3）。 */
  heartbeatTimeoutMultiplier: number;
  /**
   * **单次墙钟**阈值 = interval × multiplier（默认 90000）。
   *
   * 它**不是**「多久判离线」：迟滞上线后，单次超时只算「第一次未确认」，
   * 真正被判死还要连续 `staleOfflineConfirmations` 轮未确认。旧注释把它写成
   * 「有效判死阈值」正是 R279 修掉的前后端漂移（UI 90s vs 后端 180s）。
   * 渲染「多久判离线」只能用 `effectiveOfflineAfterMs`。
   */
  heartbeatTimeoutMs: number;
  /** 判死迟滞的确认轮数（≥1，后端默认 2）：连续 N 次扫描未确认才 ONLINE→OFFLINE。 */
  staleOfflineConfirmations: number;
  /**
   * 后端**真实**判死窗口 = heartbeatTimeoutMs × staleOfflineConfirmations
   * （默认 90000 × 2 = 180000；实际落地还可多一个扫描周期）。
   * UI 说「多久判离线」只能用它，见 `resolveEffectiveOfflineAfterMs`。
   */
  effectiveOfflineAfterMs: number;
  /** GET /executors 列表的硬上限。 */
  listLimit: number;
  /** 执行器全量行数；executorTotal > listLimit 即列表被静默截断。 */
  executorTotal: number;
}

/**
 * 后端 `executor.staleOfflineConfirmations` 的**缺省值**（configuration.ts）。
 * 只在整个 runtime-config **端点不可达**（拿不到任何字段）时用于折算——那种
 * 情况下没有比「后端缺省」更接近事实的答案，且绝不能退回单次墙钟 90s（R279）。
 * 端点可用时一律以后端下发的字段为准，本常量不参与计算。
 */
const BACKEND_DEFAULT_STALE_CONFIRMATIONS = 2;

/**
 * R279：「这台执行器多久被判离线」的唯一前端口径（毫秒）。
 *
 * ## 为什么是这个算式
 *
 * 后端判死是**两段式**（`executor.service.ts` 的 markStaleOffline + sweep）：
 * ① 单次墙钟 `heartbeatTimeoutMs` = interval × multiplier（默认 90s）只决定
 *    「这一轮扫描判定为未确认」；② 真正把 ONLINE→OFFLINE 要**连续**
 *    `staleOfflineConfirmations` 轮（默认 2）都未确认——这是 NETOPT-G P1-7 为跨境
 *    链路抖动加上的迟滞，故真实窗口 = 墙钟 × 确认轮数（默认 180s）。
 *
 * ## 为什么缺字段时按这个算式折算，而不是直接回落到 90s
 *
 * 旧 UI 直接拿 `heartbeatTimeoutMs` 当判死窗口渲染，把 180s 报成 90s：值班看到
 * 「90 秒了还显示在线」会当后端 bug 报障，按 90s 估 SLA 窗口也偏小一半。所以
 * `effectiveOfflineAfterMs` 缺失（旧后端 / 缓存里的旧响应）时**必须**用同一算式
 * 自己折算；退回单次墙钟正好复现本项要修的缺陷。
 *
 * `staleOfflineConfirmations` 也缺时按 `1` 折算：后端该值为 1 就是「单轮判死」的
 * 回滚开关（等价于迟滞上线前的行为），此时窗口确实等于单次墙钟。
 *
 * 整份配置都不可达（端点失败/首次未加载）时按**后端缺省**折算
 * （90000 × 2 = 180000），而不是 90s：宁可沿用后端默认，也不把窗口报小一半。
 *
 * @param cfg runtime-config 响应（可缺字段：旧后端/缓存）
 * @returns 判死窗口（毫秒），恒为正数
 */
export function resolveEffectiveOfflineAfterMs(
  cfg?: Partial<ExecutorRuntimeConfig> | null,
): number {
  // ① 端点不可达（整份缺失）：按后端缺省折算，绝不退回单次墙钟 90s。
  if (!cfg) return HEARTBEAT_TIMEOUT_FALLBACK_MS * BACKEND_DEFAULT_STALE_CONFIRMATIONS;
  // ② 字段在：以后端下发值为准（后端才是判死行为的事实源）。
  const explicit = cfg.effectiveOfflineAfterMs;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  // ③ 旧后端/旧缓存：用同一算式自己折算（墙钟 × 确认轮数）。
  const rounds = cfg.staleOfflineConfirmations;
  const confirmedRounds = typeof rounds === 'number' && Number.isFinite(rounds) && rounds >= 1
    ? Math.floor(rounds)
    : 1;
  const wallClock = cfg.heartbeatTimeoutMs;
  const wallClockMs = typeof wallClock === 'number' && Number.isFinite(wallClock) && wallClock > 0
    ? wallClock
    : HEARTBEAT_TIMEOUT_FALLBACK_MS;
  return wallClockMs * confirmedRounds;
}

/**
 * R279：把「多久判离线」折算成 UI 可直接渲染的一组数字。
 *
 * 返回形状刻意**内联**、不新开顶层类型：`api/*.ts` 的顶层手写声明受
 * WEB-TYPE-FIELD-DRIFT 增长闸约束（新增一个配不上生成 schema 的名字即红），
 * 而这里只是一组派生标量，不是契约视图模型。
 *
 * - `windowMs` / `windowSeconds`：判死窗口（`resolveEffectiveOfflineAfterMs`，秒四舍五入）——
 *   UI 说「多久判离线」只能显示它；
 * - `confirmations`：迟滞确认轮数（≥1），由「窗口 ÷ 单次墙钟」反推，
 *   保证「{{seconds}} 秒」与「连续 {{n}} 次未确认」永远自洽；
 * - `singleTimeoutSeconds`：单次墙钟（秒），**仅供对照说明**「为什么不是这个数」，
 *   不参与判死窗口计算。
 *
 * 为什么放在契约层（`api/executors.ts`）而不是页面里：这组数字的算式就是后端
 * 判死行为的镜像（`executor-runtime-config.util.ts::deriveExecutorRuntimeConfigNumbers`），
 * 与 runtime-config 的类型定义放在一起，才能让「下一个人改字段」时一眼看到
 * 消费面；页面只负责把它塞进文案。也避免在 ExecutorDetailPage（受 size-caps
 * 棘轮约束）里再堆派生逻辑。
 *
 * `confirmations` 刻意用「窗口 ÷ 单次墙钟」反推而不是直接取
 * `staleOfflineConfirmations`：旧后端把后者丢了的时候，页面上「{{seconds}} 秒」
 * 与「连续 {{n}} 次未确认」仍必须互相自洽，不能一个按 180s、一个按 1 轮。
 *
 * @param cfg runtime-config 响应（可缺字段：旧后端 / 缓存 / 端点失败）
 */
export function describeOfflineWindow(
  cfg?: Partial<ExecutorRuntimeConfig> | null,
): {
  windowMs: number;
  windowSeconds: number;
  confirmations: number;
  singleTimeoutSeconds: number;
} {
  const windowMs = resolveEffectiveOfflineAfterMs(cfg);
  const wallClock = cfg?.heartbeatTimeoutMs;
  const wallClockMs = typeof wallClock === 'number' && Number.isFinite(wallClock) && wallClock > 0
    ? wallClock
    : HEARTBEAT_TIMEOUT_FALLBACK_MS;
  return {
    windowMs,
    windowSeconds: Math.round(windowMs / 1000),
    confirmations: Math.max(1, Math.round(windowMs / wallClockMs)),
    singleTimeoutSeconds: Math.round(wallClockMs / 1000),
  };
}

/**
 * GET /executors/picker 单行读面——执行器选择器下拉（AppDeploymentPage 部署
 * 模态 / ApplicationListPage 快速部署）实际消费的最小字段集，与后端
 * findPickerOptions 的 select 列一一对应：
 *   - id/appName/address/status：选项文案 + 在线态禁用（disabled）；
 *   - runningTaskCount/maxConcurrentTasks：部署模态选项的负载进度条。
 * 列表页的分组/标签/心跳/解释器等重字段**有意不在读面**——picker 存在的意义
 * 就是绕开 GET /executors 的全列投影 + listLimit(500) 静默截断。
 */
export interface ExecutorPickerItem {
  id: string;
  appName: string;
  address: string;
  status: string;
  runningTaskCount: number;
  maxConcurrentTasks?: number | null;
}

/**
 * GET /executors/picker 响应。truncated=true 表示执行器全量数超过后端
 * picker 上限、items 只含最近 limit 台——UI **必须**把该状态渲染成显式告警
 * （复用 execList.truncated 文案），绝不静默截断。
 */
export interface ExecutorPickerResult {
  items: ExecutorPickerItem[];
  /** 执行器全量行数；truncated 时 > items.length。 */
  total: number;
  /** true = items 被上限截断（显式告警，不许静默）。 */
  truncated: boolean;
  /** 后端 picker 上限（EXECUTOR_PICKER_LIMIT）。 */
  limit: number;
}

export const executorsApi = {
  getSharedToken: () =>
    client.get('/config/executor-shared-token') as Promise<SharedTokenResult>,
  generateSharedToken: () =>
    client.post('/config/executor-shared-token/generate') as Promise<{ token: string }>,
  list: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors', { signal }) as Promise<Executor[]>
      : client.get('/executors') as Promise<Executor[]>,
  /**
   * GET /executors/picker：执行器选择器的轻量数据源（6 列读面 + 显式截断旗标）。
   * 供 AppDeploymentPage 部署模态 / ApplicationListPage 快速部署两个下拉使用
   * ——它们此前吃 list() 的 500 上限静默截断，执行器超限后搜索对真实存在的
   * 执行器假阴性。固定段路由（服务端声明在 :id 参数路由之前）。
   */
  picker: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors/picker', { signal }) as Promise<ExecutorPickerResult>
      : client.get('/executors/picker') as Promise<ExecutorPickerResult>,
  get: (id: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/executors/${id}`, { signal }) as Promise<Executor>
      : client.get(`/executors/${id}`) as Promise<Executor>,
  update: (id: string, data: Partial<Executor>) =>
    client.patch(`/executors/${id}`, data) as Promise<Executor>,
  getGroups: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors/groups', { signal }) as Promise<string[]>
      : client.get('/executors/groups') as Promise<string[]>,
  getTags: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors/tags', { signal }) as Promise<string[]>
      : client.get('/executors/tags') as Promise<string[]>,
  /**
   * GET /executors/runtime-config：后端有效判死阈值 + 列表截断上限/全量数。
   * 固定段路由（服务端声明在 :id 参数路由之前）。
   */
  getRuntimeConfig: (signal?: AbortSignal) =>
    signal
      ? client.get('/executors/runtime-config', { signal }) as Promise<ExecutorRuntimeConfig>
      : client.get('/executors/runtime-config') as Promise<ExecutorRuntimeConfig>,
  rotateToken: (id: string, reason?: string) =>
    client.post(`/executors/${id}/rotate-token`, reason ? { reason } : undefined) as Promise<{ token: string; expiresAt: string }>,
  /**
   * AUTH-05 交接：删除执行器（ADMIN-only）。可选 reason（≤200 字符）随
   * body 发送，写审计 executor.delete（detail={address,appName,reason?}）。
   */
  remove: (id: string, reason?: string) =>
    client.delete(`/executors/${id}`, reason ? { data: { reason } } : undefined) as Promise<void>,
  /**
   * DEEP-AUDIT B·1.1：删除影响面预览（ADMIN-only）。钉定/appName 绑定的
   * 任务数在删除后会派发必失败，确认框如实展示；pull 队列深度一并回显。
   */
  removalImpact: (id: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/executors/${id}/removal-impact`, { signal }) as Promise<ExecutorRemovalImpact>
      : client.get(`/executors/${id}/removal-impact`) as Promise<ExecutorRemovalImpact>,
  /**
   * B-5：pull 执行器（ADR-016 控制面走 pull 通道）的后端返回
   * `{ queued: true, commandId }`（executor.controller.ts reload-config）——
   * 配置只是**入队**，下次拉取/心跳才生效，不能与 push 的「已应用」混为一谈。
   * push 路径返回执行器响应体（无 queued 字段）。
   */
  reloadConfig: (id: string, data: {
    maxConcurrentTasks?: number;
    taskTimeoutSeconds?: number;
    heartbeatIntervalSeconds?: number;
    adminApiUrl?: string;
    adminApiUrlInternal?: string;
    adminApiUrlExternal?: string;
  }) =>
    client.post(`/executors/${id}/reload-config`, data) as Promise<{ queued?: boolean; commandId?: string } | null | undefined>,
  setOffline: (id: string) =>
    client.post(`/executors/${id}/set-offline`) as Promise<Executor>,
  getExecutions: (id: string, params?: { page?: number; pageSize?: number }, signal?: AbortSignal) =>
    signal
      ? client.get(`/executors/${id}/executions`, { params, signal }) as Promise<{ total: number; items: ExecutorExecution[] }>
      : client.get(`/executors/${id}/executions`, { params }) as Promise<{ total: number; items: ExecutorExecution[] }>,
  getMetrics: (id: string, signal?: AbortSignal) =>
    signal
      ? client.get(`/executors/${id}/metrics`, { signal }) as Promise<ExecutorMetrics>
      : client.get(`/executors/${id}/metrics`) as Promise<ExecutorMetrics>,
  /** 获取执行器一键安装命令（含共享 Token，安装向导与执行器列表共用） */
  getInstallCmd: () =>
    client.get('/executors/install-cmd') as Promise<InstallCmdResult>,
};
