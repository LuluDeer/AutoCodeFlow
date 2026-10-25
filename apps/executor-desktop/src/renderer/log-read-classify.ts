/**
 * P2-1：增量日志读取响应的**分类判定**（纯函数，无 React / Electron 依赖）。
 *
 * 背景（渲染层全量审计 P2-1）：主进程对 `log:read` / `apps:log:read` 的
 * 「文件不存在 / 读取失败」长期返回成功形态的空结果（`{lines:[],totalLines:0}`），
 * 渲染层把 `totalLines < previousTotal` 一律按「日志轮转」处理 → 清空已有
 * 缓冲 → 用户正在看的日志静默消失成「暂无日志」空态，1.5s/2s 轮询继续空转。
 *
 * 主进程侧已补可判别标记（ipc-handlers.ts：目标不存在 / catch 兜底 / 域校验
 * 拒绝时返回 `missing: true` 或 `error: '...'`，既有成功形态字段不变）。
 * 本模块是渲染层的**单一分类点**：
 *
 *   · `error`   —— 主进程明确报错（域校验拒绝 / I/O 异常）：错误态。
 *   · `missing` —— 主进程明确报文件不存在：分两种语义（见下）。
 *   · `shrink`  —— totalLines 回退且主进程未报 missing：真轮转（新文件截短
 *                  后行数确实可能小于旧行号水位），沿用既有轮转分支。
 *   · `append`  —— 正常增量。
 *
 * `missing` 的两种语义（关键取舍）：
 *   - 首读（previousTotal === 0）：执行尚未产生日志/记录被清，是**合法空态**
 *     ——查看器显示既有空态，不报错（否则「刚创建的执行」打开即红条）。
 *   - 非首读（previousTotal > 0）：上一轮还读得到、这一轮没了 = 文件被保留期
 *     清理/被删/盘故障 —— **错误态**（NETOPT-7⑥ 口径：失败不得冒充空态），
 *     且不清空已有缓冲（用户还能看到消失前的内容）。
 */

/** 增量读响应的渲染层视图（主进程返回 + 渲染层水位）。 */
export interface LogReadResultLike {
  lines?: string[];
  totalLines?: number;
  truncated?: boolean;
  /** P2-1：主进程「文件不存在」标记。 */
  missing?: boolean;
  /** P2-1：主进程「读取失败/被拒」说明（域校验拒绝、I/O 异常）。 */
  error?: string;
}

export type LogReadVerdict =
  | { kind: 'error'; message: string }
  | { kind: 'missing' }
  | { kind: 'shrink'; lines: string[]; totalLines: number; truncated: boolean }
  | { kind: 'append'; lines: string[]; totalLines: number; truncated: boolean };

/**
 * 「读着读着文件没了」的渲染层兜底文案：主进程的 missing 标记不带措辞
 * （missing 就是语义），分类层补一句人话——对齐「日志已被保留期清理」的
 * 主进程既有口径（history:reveal-log 的双分支错误文案）。
 */
export const MISSING_AFTER_START_MESSAGE =
  '日志文件已不存在（可能已被保留期清理），已停止自动刷新';

/**
 * 把一次增量读响应分类。`previousTotal` 是渲染层已有的全局行号水位
 * （首读为 0）。totalLines 缺失/非有限数按 0 处理（畸形返回不炸）。
 */
export function classifyLogRead(
  res: LogReadResultLike | null | undefined,
  previousTotal: number,
): LogReadVerdict {
  // 主进程明确报错：永远是错误态（哪怕带了空 lines）。
  if (res && typeof res.error === 'string' && res.error.length > 0) {
    return { kind: 'error', message: res.error };
  }
  // 明确 missing 标记：首读=合法空态，非首读=文件消失错误态。
  if (res?.missing === true) {
    return previousTotal > 0
      ? { kind: 'error', message: MISSING_AFTER_START_MESSAGE }
      : { kind: 'missing' };
  }
  const totalLines =
    typeof res?.totalLines === 'number' && Number.isFinite(res.totalLines)
      ? res.totalLines
      : 0;
  const lines = Array.isArray(res?.lines) ? res!.lines! : [];
  const truncated = res?.truncated === true;
  if (totalLines < previousTotal) {
    // totalLines 回退且主进程未报 missing：真轮转（新文件行数小于旧水位）。
    return { kind: 'shrink', lines, totalLines, truncated };
  }
  return { kind: 'append', lines, totalLines, truncated };
}
