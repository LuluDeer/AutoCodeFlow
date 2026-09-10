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
