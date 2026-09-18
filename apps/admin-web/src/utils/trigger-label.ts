/**
 * Task.triggerType 枚举 → i18n 展示标签的**读面唯一事实源**。
 *
 * UX-06（本轮体验审查）：多个页面直接渲染裸枚举。用户看到的是 `cron` /
 * `fixed_rate` / `manual` 这样的后端 token，而**同一个页面**里状态列却走
 * `t()` 显示中文——中英混排且对非英语用户不可读。具体漏点：
 *  - ApplicationDetailPage 任务列表「触发方式」列：`<Tag>{r.triggerType}</Tag>`
 *  - ApplicationDetailPage 版本历史「状态」列：`<Tag>{v}</Tag>`（released/
 *    deploying/failed 全裸）
 *  - TaskDetailPage 任务列表「触发方式」列：`{v || '-'}`
 *  - TaskDetailPage 基本信息「触发方式」项：`<Tag>{task.triggerType}</Tag>`
 *
 * 各页原本各写一份内联映射（TaskListPage 的 TRIGGER_LABEL、ExecutionsPage 的
 * triggerLabels…），新增取值时必然漏改其中几处。此处收敛为一份，沿用
 * failure-reason-label.ts 的既有形态。
 *
 * 未知值回退**原始 token**（不显示"未知"）：宁可露出 `some_new_trigger` 让
 * 排障者能搜到，也不要把可诊断信息抹掉——与 failure-reason-label 同策。
 */

/** Task.triggerType 的已知取值（admin-api Task 实体 / 前端 DTO 同源）。 */
export const TRIGGER_T_KEYS: Record<string, string> = {
  manual: 'taskList.trigger.manual',
  cron: 'taskList.trigger.cron',
  fixed_rate: 'taskList.trigger.fixed_rate',
  dependency: 'taskList.trigger.dependency',
};

/** Tag 配色：与 TaskListPage 既有观感一致（提取时原样保留，不改视觉）。 */
export const TRIGGER_COLOR: Record<string, string> = {
  manual: 'default',
  cron: 'blue',
  fixed_rate: 'geekblue',
  dependency: 'purple',
};

/** 单条触发方式的展示文本：有标签用标签，未知值回退原始 token。 */
export function triggerLabel(
  triggerType: string | null | undefined,
  t: (key: string) => string,
): string {
  if (triggerType === null || triggerType === undefined || triggerType === '') return '';
  const key = TRIGGER_T_KEYS[triggerType];
  return key ? t(key) : triggerType;
}

/**
 * AppRelease.deploymentStatus 枚举 → i18n 展示标签。
 *
 * 与触发方式同批修（同一页同一张表里，状态列裸枚举而旁边的列已翻译）。
 * 取值来源：admin-api 版本历史的 deploymentStatus（见
 * ApplicationDetailPage 的 colorMap 与 api/applications.ts 的类型）。
 */
export const RELEASE_STATUS_T_KEYS: Record<string, string> = {
  released: 'appDetail.history.status.released',
  running: 'appDetail.history.status.running',
  deploying: 'appDetail.history.status.deploying',
  stopped: 'appDetail.history.status.stopped',
  failed: 'appDetail.history.status.failed',
  pending: 'appDetail.history.status.pending',
  rolled_back: 'appDetail.history.status.rolledBack',
};

export function releaseStatusLabel(
  status: string | null | undefined,
  t: (key: string) => string,
): string {
  if (status === null || status === undefined || status === '') return '';
  const key = RELEASE_STATUS_T_KEYS[status];
  return key ? t(key) : status;
}
