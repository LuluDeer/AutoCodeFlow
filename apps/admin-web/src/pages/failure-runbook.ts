/**
 * UI-05: 失败定位建议动作映射（纯逻辑层，与 retry-chain.ts / retry-policy.ts
 * 同层次——独立成文件以满足 react-refresh 只导出组件的限制并便于单测）。
 *
 * 语义镜像自 packages/mcp-server/src/tools.ts 的 FAILURE_RUNBOOK
 * （ECO-03 三端对齐先例）：跨包 import 违反 workspace 边界（admin-web 不依赖
 * mcp-server），按纪律复制语义到 admin-web 侧并保持键逐一对应；mcp 侧后续
 * 扩键时本表需人工同步（双端无共享包，属有意取舍）。
 *
 * 计数口径（改键集时勿照抄任务书，以代码为准）：本文件原名「BUG-10 十二类」，
 * 历史上四处（本表/admin 枚举/protocol.json/mcp）曾同为 11 项、"十二类"是
 * 注释笔误；其后 EXP-01（sandbox_unavailable）、P0-4（application_missing）、
 * P0-8（never_dispatched）、python_task_multiversion（interpreter_unavailable）
 * 相继扩键，现以 RUNBOOK_ACTION_T_KEY 的实际键数为准（当前 16，含 unknown 兜底）。
 *
 * 与页面既有 FAILURE_REASON_MAP（label/hint）职责区分：
 *  - FAILURE_REASON_MAP：分类的展示（Tag 颜色/中文名/一句话提示）；
 *  - failureRunbookAction：定位到修复动作（怎么做），供失败定位卡片。
 */

/** 单条建议动作：排障步骤，runbook 键为任务可配置知识库指向 */
export interface FailureRunbookEntry {
  /** 建议动作（文案本体在 locales 的 runbook.*，zh/en 双侧成对） */
  action: string;
}

/**
 * 失败分类 → 建议动作（BUG-10 分类 + python_task_multiversion 新增
 * interpreter_unavailable，共 16 项，含 unknown 兜底）。
 * 键集与 mcp-server FAILURE_RUNBOOK 完全一致（16 键，含 unknown 兜底）。
 *
 * N-04 收尾：文案不再在本文件内联中文（此前 16 条中文 action 与 locales 的
 * runbook.* 双份维护，且直调路径在英文界面会漏中文）——action 统一查
 * RUNBOOK_ACTION_T_KEY → i18n（传 t 走调用方的 t，缺省回落 i18n 单例，
 * 非组件文件直引单例与 api/tasks.ts 同模式；测试环境默认 zh）。
 * 中文文案的唯一来源是 locales/{zh,en}.ts 的 runbook.* 键。
 */

import i18n from '../i18n';

/** 失败分类注册表（键集与 mcp-server FAILURE_RUNBOOK 对齐，文案查 runbook.*）。
 *  导出供测试锚定全量键集（execution-detail-ui05.test.tsx）。 */
export const RUNBOOK_ACTION_T_KEY: Record<string, string> = {
  package_fetch_failed: 'runbook.packageFetch',
  dependency_install_failed: 'runbook.dependencyInstall',
  git_fetch_failed: 'runbook.gitFetch',
  runtime_missing: 'runbook.runtimeMissing',
  // EXP-01（体验审查）：沙箱已配置但不可用——执行器 fail-closed 拒绝在无沙箱下
  // 运行任务，动作是「让沙箱可用或取消配置」而非重试（重试无效）。
  sandbox_unavailable: 'runbook.sandboxUnavailable',
  script_error: 'runbook.scriptError',
  timeout: 'runbook.timeout',
  executor_offline: 'runbook.executorOffline',
  executor_restart: 'runbook.executorRestart',
  stale_recovered: 'runbook.staleRecovered',
  killed: 'runbook.killed',
  // P1-27：cancelled = 调度器 COVER_EARLY 自动覆盖（非人工终止），文案要让用户
  // 认出这是预期行为；killed 才是人工终止（task.service.ts 同步写 failureReason）。
  cancelled: 'runbook.cancelled',
  // python_task_multiversion：解释器不可用 = 环境/配置类失败，重试无益
  // （不在默认重试集内）——动作是「让运维改环境」而非「再跑一次」。
  interpreter_unavailable: 'runbook.interpreterUnavailable',
  unknown: 'runbook.unknown',
  // ENG 审计 E-P2-F4：补两条此前漏掉的映射——传 t() 时这两类此前会 t(undefined)。
  // P0-4：引用的应用已删除——动作指向「重建关联」而非「看日志」（无日志可看）。
  application_missing: 'runbook.applicationMissing',
  // P0-8：从未被派发（队列侧超时丢弃/执行器未取件）——从未在任何机器上运行，
  // **没有任何日志**，不必引导用户去翻日志。
  never_dispatched: 'runbook.neverDispatched',
};

/**
 * 取分类的建议动作；未收录键（后端扩枚举而前端未同步时）回退 unknown 兜底，
 * 保证卡片在任意 failureReason 值下都有可展示内容。
 *
 * t 可选：传参时 action 走调用方的 t（执行详情页传 t）；缺省回落 i18n 单例
 * （execution-detail-ui05.test.tsx 锚定全量键与 unknown 兜底）。
 *
 * status 可选（P1-27）：cancelled 由调度器自动覆盖产生，后端**不落 failureReason**
 * （scheduler.service.ts:1065-1071 把 RUNNING 行 patch 成 CANCELLED，errorMessage
 * = "Task was covered by new trigger"），仅靠 failureReason 会永远落到 unknown 兜底——
 * 故 status==='cancelled' 时按 status 命中 cancelled runbook，与人工 killed
 * （failureReason='killed'，仍走 failureReason 命中）明确区分。
 */
export function failureRunbookAction(
  failureReason: string | null | undefined,
  t?: (k: string) => string,
  status?: string | null,
): FailureRunbookEntry {
  // cancelled 必须按 status 命中（failureReason 恒空，见函数注释）
  if (status === 'cancelled') return resolveRunbook('cancelled', t);
  const category =
    failureReason && RUNBOOK_ACTION_T_KEY[failureReason] ? failureReason : 'unknown';
  return resolveRunbook(category, t);
}

function resolveRunbook(
  category: string,
  t?: (k: string) => string,
): FailureRunbookEntry {
  const T = t ?? ((k: string) => i18n.t(k));
  return { action: T(RUNBOOK_ACTION_T_KEY[category] ?? RUNBOOK_ACTION_T_KEY.unknown) };
}

/**
 * 失败定位卡片可见状态（P1-27 起含 killed/cancelled）。
 * 此前只有 failed/timeout，注释断言"killed 无排障价值，不渲染"——但 killed 的
 * 动作文案（手动终止 / 阻断策略 kill，去审计日志核实来源）已在上方写好却成了死代码；
 * cancelled 则**完全没有** runbook 条目。两类终态用户都需要一句"发生了什么、要不要管"，
 * 故一并纳入。killed 仍按 failureReason='killed' 命中；cancelled 按 status 命中。
 */
export const FAILURE_CARD_STATUSES: readonly string[] = ['failed', 'timeout', 'killed', 'cancelled'];
