/**
 * UI-05: 失败定位建议动作映射（纯逻辑层，与 retry-chain.ts / retry-policy.ts
 * 同层次——独立成文件以满足 react-refresh 只导出组件的限制并便于单测）。
 *
 * 语义镜像自 packages/mcp-server/src/tools.ts 的 FAILURE_RUNBOOK
 * （BUG-10 十二类失败分类 → 建议首动作，ECO-03 三端对齐先例）：
 * 跨包 import 违反 workspace 边界（admin-web 不依赖 mcp-server），
 * 按纪律复制语义到 admin-web 侧并保持 12 键逐一对应；mcp 侧后续
 * 扩键时本表需人工同步（双端无共享包，属有意取舍）。
 *
 * 与页面既有 FAILURE_REASON_MAP（label/hint）职责区分：
 *  - FAILURE_REASON_MAP：分类的展示（Tag 颜色/中文名/一句话提示）；
 *  - FAILURE_RUNBOOK_ACTIONS：定位到修复动作（怎么做），供失败定位卡片。
 */

/** 单条建议动作：排障步骤（中文），runbook 键为任务可配置知识库指向 */
export interface FailureRunbookEntry {
  /** 建议动作（中文，镜像 mcp FAILURE_RUNBOOK 同键英文语义） */
  action: string;
}

/**
 * BUG-10 十二类失败分类 → 中文建议动作。
 * 键集与 mcp-server FAILURE_RUNBOOK 完全一致（12 键，含 unknown 兜底）。
 */
export const FAILURE_RUNBOOK_ACTIONS: Record<string, FailureRunbookEntry> = {
  package_fetch_failed: {
    action: '检查包地址/仓库可用性；requirements 指向私服时核对私服凭据与可达性。',
  },
  dependency_install_failed: {
    action: '查看安装日志（pip/uv/npm）定位失败依赖，固定版本后重跑；离线执行器需可达的索引源。',
  },
  git_fetch_failed: {
    action: '检查 gitRepo 地址、分支与凭据；私网 Git 需在执行器侧开启 EXECUTOR_ALLOW_PRIVATE_NETWORK。',
  },
  runtime_missing: {
    action: '执行器缺少运行时（node/python/shell）——安装运行时或改派到支持该 runtime 的执行器。',
  },
  script_error: {
    action: '阅读日志末尾首个堆栈帧附近的输出；可点击「AI 分析」生成根因报告。',
  },
  timeout: {
    action: '调大 timeoutSeconds、拆分工作负载或排查阻塞 I/O；反复超时提示依赖挂起。',
  },
  executor_offline: {
    action: '检查执行器连接与注册状态；离线期间的回调积压可查看死信队列（dead letters）。',
  },
  executor_restart: {
    action: '瞬时中断——调度 sweep 已自动重新入队；观察重试链，重试成功则无需处理。',
  },
  stale_recovered: {
    action: '执行器崩溃或失联——中台已终止并重新入队；检查执行器主机日志定位失联原因。',
  },
  killed: {
    action: '执行被手动终止（或阻断策略 kill）。与操作者/审计日志核实操作来源。',
  },
  unknown: {
    action: '无失败原因上报——阅读完整日志，并可用「AI 分析」生成根因报告。',
  },
};

/**
 * 取分类的建议动作；未收录键（后端扩枚举而前端未同步时）回退 unknown 兜底，
 * 保证卡片在任意 failureReason 值下都有可展示内容。
 * t 可选：传参时 action 走 i18n key（执行详情页传 t）；缺省保持中文基线
 * （execution-detail-ui05.test.tsx 锚定 FAILURE_RUNBOOK_ACTIONS 逐键动作）。
 */
export function failureRunbookAction(
  failureReason: string | null | undefined,
  t?: (k: string) => string,
): FailureRunbookEntry {
  const category =
    failureReason && FAILURE_RUNBOOK_ACTIONS[failureReason] ? failureReason : 'unknown';
  if (!t) return FAILURE_RUNBOOK_ACTIONS[category];
  return { action: t(RUNBOOK_ACTION_T_KEY[category]) };
}

const RUNBOOK_ACTION_T_KEY: Record<string, string> = {
  package_fetch_failed: 'runbook.packageFetch',
  dependency_install_failed: 'runbook.dependencyInstall',
  git_fetch_failed: 'runbook.gitFetch',
  runtime_missing: 'runbook.runtimeMissing',
  script_error: 'runbook.scriptError',
  timeout: 'runbook.timeout',
  executor_offline: 'runbook.executorOffline',
  executor_restart: 'runbook.executorRestart',
  stale_recovered: 'runbook.staleRecovered',
  killed: 'runbook.killed',
  unknown: 'runbook.unknown',
};

/** 失败定位卡片可见状态：failed / timeout（killed 无排障价值，不渲染） */
export const FAILURE_CARD_STATUSES: readonly string[] = ['failed', 'timeout'];
