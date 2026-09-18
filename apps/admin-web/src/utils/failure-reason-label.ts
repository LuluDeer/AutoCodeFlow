/**
 * ExecutionFailureReason 枚举 → i18n 展示标签的**读面唯一事实源**。
 *
 * 历史上三处各写一份映射：
 *  - ExecutionDetailPage 的 FAILURE_REASON_MAP（含 color/hint，最富）；
 *  - DashboardPage「最近失败」Tag（原先直接渲染裸枚举并截断 12 字符，
 *    `interpreter_unavailable` 显示成 `interpreter_…`）；
 *  - ExecutionCompare 对比表（原先走通用格式化器，同样露裸枚举）。
 *
 * Dashboard / Compare 只需要纯文本标签，统一收敛到本文件；扩枚举时改这一处
 * 即可（ExecutionDetailPage 的富映射仍独立，因为它还承载颜色与处置提示）。
 *
 * 未知值回退**原始 token**（不显示"未知原因"）：宁可露出 `some_new_reason`
 * 让排障者能搜到，也不要把可诊断信息抹掉——与 ExecutionDetailPage 同策。
 * 仅在 Tag 很窄的调用方需要截断时，对回退 token 做长度截断（已知分类永远
 * 走完整标签，不再出现 `interpreter_…` 这种两个失败无法区分的情况）。
 */

/** admin-api 的 ExecutionFailureReason 全集（task-execution.entity.ts）。
 *  `stale_recovered` 是 admin 内部值（执行器不上报），但执行记录里会出现，
 *  读面必须能展示；`unknown` 是兜底分类。 */
export const FAILURE_REASON_T_KEYS: Record<string, string> = {
  package_fetch_failed: 'execDetail.failure.packageFetchFailed',
  git_fetch_failed: 'execDetail.failure.gitFetchFailed',
  dependency_install_failed: 'execDetail.failure.dependencyInstallFailed',
  runtime_missing: 'execDetail.failure.runtimeMissing',
  // EXP-01（本轮体验审查）：沙箱配置不可用（bwrap 缺失 / 用户命名空间被禁）。
  // 与 runtime_missing 同属「环境/配置」族，但处置动作不同（装 bubblewrap
  // 或取消 TASK_SANDBOX），故独立标签而非并入前者。
  sandbox_unavailable: 'execDetail.failure.sandboxUnavailable',
  interpreter_unavailable: 'execDetail.failure.interpreterUnavailable',
  script_error: 'execDetail.failure.scriptError',
  timeout: 'execDetail.failure.timeout',
  executor_offline: 'execDetail.failure.executorOffline',
  executor_restart: 'execDetail.failure.executorRestart',
  stale_recovered: 'execDetail.failure.staleRecovered',
  killed: 'execDetail.failure.killed',
  unknown: 'execDetail.failure.unknown',
};

/** 未知 token 的截断宽度（与历史 Dashboard Tag 宽度一致；仅作用于回退分支）。 */
export const UNKNOWN_REASON_TRUNCATE = 12;

/** 单条失败分类的展示文本：有标签用标签，未知值回退（过长则截断）原始 token。
 *  空值（null/undefined/''）交由调用方按自己的占位规则处理（通常显示 '-'）。 */
export function failureReasonLabel(
  reason: string | null | undefined,
  t: (key: string) => string,
): string {
  if (reason === null || reason === undefined || reason === '') return '';
  const key = FAILURE_REASON_T_KEYS[reason];
  if (key) return t(key);
  return reason.length > UNKNOWN_REASON_TRUNCATE
    ? `${reason.slice(0, UNKNOWN_REASON_TRUNCATE)}…`
    : reason;
}
