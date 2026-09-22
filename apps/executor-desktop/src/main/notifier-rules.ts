/**
 * DSK-04：系统通知的纯规则层（无 Electron / electron-log 依赖，可被
 * notifier-rules.selftest.ts 在裸 Node 下直接断言）。
 *
 * 三类通知事件：
 *  1) 任务终态（success / failed）——事件源是 executor-node 写入
 *     workDir/meta/<executionId>.json 的执行元数据（见 executor-node
 *     routes/execute.ts 的 writeExecMeta）。不解析日志文本：成功终态日志
 *     是 debug 级别（winston level=info 不输出），日志匹配不可靠，meta
 *     文件是结构化且可靠的终态信号。
 *  2) 执行器离线（offline）——事件源是 executor-process / heartbeat 的
 *     状态回调（既有主进程内部通道，不经 IPC）。
 *  3) （通知开关 notifyEnabled 的判断在 notifier.ts Electron 面完成。）
 *
 * 安全约束（BUG-12 复审先例对齐）：通知 body 只携带「任务名」这一项用户
 * 可见数据——errorMessage / token / 绝对路径一律不进通知（errorMessage
 * 来自任务进程输出，可能含敏感路径；token 从不出主进程）。任务名经过
 * sanitizeNotifyText 清洗（去控制字符、压单行、限长）。
 */
import { isValidExecutionId } from './path-domain';

/** 任务终态事件（notifyTaskTerminal 的输入）。 */
export interface TaskTerminalEvent {
  executionId: string;
  taskName: string;
  status: 'success' | 'failed';
}

/** 执行器状态字面量（与 executor-process.ExecutorStatus 同形；此处自定义
 *  避免拉入 Electron 依赖）。 */
export type ExecutorStatusLike = 'stopped' | 'pending' | 'online' | 'offline';

/** 通知正文中任务名的最大长度（超长截断加省略号）。 */
export const TASK_NAME_MAX_LEN = 40;

/**
 * 清洗通知文本：去掉控制字符（含换行——系统通知必须是单行，换行在
 * Windows toasts 上会被吞或显示为方框）、压缩空白、限长截断。
 * 非字符串 / 清洗后为空返回 null（调用方回落到默认文案）。
 */
export function sanitizeNotifyText(raw: unknown, maxLen: number): string | null {
  if (typeof raw !== 'string') return null;
  // 先压缩空白（\t/\n 在 \s 内，先折叠成单空格），再剥掉 \s 覆盖不到的
  // 其余控制字符（\u0000-\u0008 等）与零宽/方向控制符——顺序反了会把
  // \t 直接剥掉而不是折叠为空格（selftest 'tab collapses to space' 守卫）。
  const cleaned = raw
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(maxLen - 1, 0))}…`;
}

/**
 * 从 meta JSON（executor-node writeExecMeta 的 merge 产物）提取任务终态事件。
 * 只认终态 status（success / failed）；running 或缺失返回 null（开始不通知）。
 * executionId 必须通过白名单字符集校验（^[A-Za-z0-9_-]+$，与 path-domain /
 * admin-api 心跳同一规则）——它将被用于通知展示与日志，绝不能携带任意文本。
 * taskName 缺失或非法时回落 executionId（终态通知永不因缺名而丢失）。
 */
export function summarizeExecMeta(raw: unknown): TaskTerminalEvent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const meta = raw as Record<string, unknown>;
  const status = meta.status;
  if (status !== 'success' && status !== 'failed') return null;
  if (!isValidExecutionId(meta.executionId)) return null;
  const executionId = meta.executionId as string;
  const taskName = sanitizeNotifyText(meta.taskName, TASK_NAME_MAX_LEN) ?? executionId;
  return { executionId, taskName, status };
}

/**
 * 任务状态转移是否应发出通知。prev 是本进程内上次见到的该 executionId
 * 状态（undefined = 首次见到）。
 *  - 任何来源 → success / failed：通知（含 undefined 首见——桌面端启动后
 *    第一次观察到的终态也值得提醒）；
 *  - 同状态重复（success→success / failed→failed）：去重不通知；
 *  - 其余（理论上不会出现的翻转）按「终态即报」处理，宁可多报不漏报。
 */
export function shouldNotifyTaskTransition(
  prev: string | undefined,
  next: 'success' | 'failed',
): boolean {
  return prev !== next;
}

/** knownFiles 增量水位线的防膨胀上限（超过后裁到 META_KNOWN_RETAIN）。 */
export const META_KNOWN_LIMIT = 1000;
/** knownFiles 裁剪后的保留量。 */
export const META_KNOWN_RETAIN = 500;

/** 一轮扫描中解析出的 meta 文件项（raw 已是 JSON.parse 产物）。 */
export interface MetaScanItem {
  file: string;
  raw: unknown;
}

/** 应弹出通知的终态事件。 */
export interface NotifyCandidate {
  file: string;
  event: TaskTerminalEvent;
}

/** decideScan 的决策输出。 */
export interface ScanDecision {
  toNotify: NotifyCandidate[];
  newSeen: Map<string, string>;
  newKnown: Map<string, number>;
}

/**
 * NETOPT-G P1-1: 水位线决策纯函数——P2-F3 通知风暴的回归锁。notifier.ts
 * 只负责 readdir/readFile/new Notification，全部决策在此，裸 Node selftest
 * 可逐语义断言（把决策与 Electron 解耦是"接线对、断言空"主线的收尾）。
 *
 * 语义锁（selftest 钉死）：
 *  - silentFirstScan：只推进水位线、零通知（桌面重启/切 workDir 后首扫静默
 *    追平，旧任务不轰炸）；
 *  - normal：首见 success/failed 通知；同 id 同状态去重（shouldNotifyTaskTransition）；
 *  - knownFiles 防膨胀**只裁 known、绝不裁 seen**（P2-F3：两表同节奏裁剪会让
 *    被裁 executionId 下轮被当 fresh 重读、prev=undefined → 一次轮询突发约
 *    500 条重复系统通知，且每新增任务周期性复发）；
 *  - seenStatus 的回收走 pruneSeenByLiveFiles（按磁盘存在性懒清），与本决策
 *    分离——被清 id 的 meta 文件已不存在、下轮不会重读，无风暴面。
 */
export function decideScan(
  items: MetaScanItem[],
  seen: ReadonlyMap<string, string>,
  known: ReadonlyMap<string, number>,
  silentFirstScan: boolean,
): ScanDecision {
  const newSeen = new Map(seen);
  let newKnown = new Map(known);
  const toNotify: NotifyCandidate[] = [];
  for (const item of items) {
    const event = summarizeExecMeta(item.raw);
    if (!event) continue; // running / 非法 / 缺字段——不入集合，下轮重看
    if (silentFirstScan) {
      newSeen.set(event.executionId, event.status);
      newKnown.set(item.file, Date.now());
      continue;
    }
    const prev = newSeen.get(event.executionId);
    if (!shouldNotifyTaskTransition(prev, event.status)) {
      // 该 executionId 已通知过（同状态）——文件已定稿，记住后不再重扫
      newKnown.set(item.file, Date.now());
      continue;
    }
    newSeen.set(event.executionId, event.status);
    newKnown.set(item.file, Date.now());
    toNotify.push({ file: item.file, event });
  }
  if (newKnown.size > META_KNOWN_LIMIT) {
    newKnown = new Map(Array.from(newKnown.entries()).slice(-META_KNOWN_RETAIN));
  }
  return { toNotify, newSeen, newKnown };
}

/**
 * seenStatus 按本轮磁盘存在性懒清：executionId 对应的 meta 文件
 * （`<id>.json`，executor-node writeExecMeta 命名）不在 liveFileNames 中 →
 * 删除死条目（history:clear / meta TTL 清扫后回收；executionId 为平台 UUID
 * 唯一、文件不重写同名，故懒清无漏报面）。与 knownFiles 裁剪不同步——绝不
 * 因"表太大"裁 seen（P2-F3 语义）。
 */
export function pruneSeenByLiveFiles(
  seen: ReadonlyMap<string, string>,
  liveFileNames: ReadonlySet<string>,
): Map<string, string> {
  const pruned = new Map<string, string>();
  for (const [id, status] of seen) {
    if (liveFileNames.has(`${id}.json`)) pruned.set(id, status);
  }
  return pruned;
}

/**
 * 执行器状态转移是否应发出离线通知。规则：仅 next==='offline' 且
 * prev 非 offline、非 stopped 时通知。
 *  - online→offline：运行中掉线，必报；
 *  - pending→offline：启动失败，必报；
 *  - stopped→offline：执行器本来就没在跑（用户手动停止后 health 残留），
 *    不打扰；
 *  - undefined→offline：本进程从未记录过状态（正常启动流程先经过
 *    pending；直接收到 offline 说明来源异常），保守不报避免误扰；
 *  - 其余任何转换（online/pending/stopped 之间、进入 online 等）一律
 *    不通知——托盘图标已表达这些状态。
 */
export function shouldNotifyExecutorStatus(
  prev: ExecutorStatusLike | undefined,
  next: ExecutorStatusLike,
): boolean {
  if (next !== 'offline') return false;
  return prev !== undefined && prev !== 'offline' && prev !== 'stopped';
}

/**
 * NETOPT-G P1-5（离线误报迟滞）：把「执行器是否真的掉线」从单点快照升级为
 * 带迟滞的判定。
 *
 * ## 为什么需要（生产实证）
 *
 * 桌面端原本用 `/health/admin-status` 的单点 `heartbeatStatus === 'failed'`
 * 直接判离线（executor-process.ts applyAdminStatus → notifyStatus('offline')
 * → notifier 弹系统通知）。而 `heartbeatStatus` 是**最近一次**心跳的结果
 * （heartbeat-state.ts 的 recordHeartbeat），一次瞬时抖动立刻把它置 failed。
 *
 * 生产日志（executor-2026-09-22.log）实测：全天 86 次"执行器离线"通知中，
 * **72 次发生在某次心跳失败后的 0.0 秒内**。而中台的真实判死阈值是
 * `heartbeatInterval × 3 = 90s`（admin-api executor.service.ts
 * markStaleOffline）——也就是说这些"离线"绝大多数在中台侧根本没发生，
 * 执行器一直是在线的。用户被一天 86 次无意义的弹窗打扰，且掩盖了真实故障。
 *
 * ## 判定口径（与中台阈值对齐）
 *
 * 只有**同时**满足下列之一才判离线：
 *  - 连续 `OFFLINE_CONSECUTIVE_FAILURES` 次心跳失败（吸收单次抖动）；或
 *  - 距上次成功心跳超过 `OFFLINE_SILENCE_MS`（90s，与中台
 *    heartbeatInterval×3 同源）——覆盖"一次失败后长时间没有结果"的场景。
 *
 * 心跳成功即立刻清零计数并判在线（恢复不做迟滞：宁可早报恢复，也不要让
 * 托盘长期显示离线）。
 *
 * 纯函数 + 显式传入 state，便于单测穷举；调用方（notifier）持有 state。
 */
export const OFFLINE_CONSECUTIVE_FAILURES = 3;
export const OFFLINE_SILENCE_MS = 90_000;

export interface HeartbeatHysteresisState {
  /** 连续失败次数（成功即清零）。 */
  consecutiveFailures: number;
  /** 上次**成功**心跳的时刻（ms epoch）；从未成功过为 null。 */
  lastSuccessAt: number | null;
}

export function initialHeartbeatHysteresisState(): HeartbeatHysteresisState {
  return { consecutiveFailures: 0, lastSuccessAt: null };
}

/**
 * 用一次心跳结果推进状态，并返回是否应判离线。
 *
 * `nowMs` 显式传入以便测试注入时间（生产传 Date.now()）。
 */
export function advanceHeartbeatHysteresis(
  state: HeartbeatHysteresisState,
  outcome: 'ok' | 'failed' | 'unknown',
  nowMs: number,
): { offline: boolean; state: HeartbeatHysteresisState } {
  if (outcome === 'ok') {
    // 恢复：立刻清零并判在线（不做恢复迟滞）。
    return {
      offline: false,
      state: { consecutiveFailures: 0, lastSuccessAt: nowMs },
    };
  }

  if (outcome === 'unknown') {
    // 启动早期 / 端点不可用：不得据此判离线（与既有"维持现状"语义一致），
    // 但也不推进失败计数。
    return { offline: false, state };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  const silentTooLong =
    state.lastSuccessAt !== null && nowMs - state.lastSuccessAt > OFFLINE_SILENCE_MS;
  const offline =
    consecutiveFailures >= OFFLINE_CONSECUTIVE_FAILURES || silentTooLong;

  return { offline, state: { consecutiveFailures, lastSuccessAt: state.lastSuccessAt } };
}
