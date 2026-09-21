/**
 * Task.runtime 枚举 → i18n 展示标签的读面唯一事实源。
 *
 * D-P2-02a（设计审计 2026-09-22）：任务列表「运行时」列此前直出
 * `python / node / shell` 裸值，而**同一行**里状态列、优先级列都走 t() 显示
 * 中文/标签——非英语用户看到的是后端 token，与筛选下拉（Node.js/Python/Shell）
 * 对不上号。此处收敛为一份映射，沿用 trigger-label.ts / failure-reason-label.ts
 * 的既有形态。
 *
 * 未知值回退**原始 token**（不显示"未知"）：宁可露出 `some_new_runtime` 让
 * 排障者能搜到，也不要把可诊断信息抹掉——与 triggerLabel 同策。
 */

/** Task.runtime 的已知取值（与 TaskFormPage / ApplicationListPage 筛选下拉同源）。 */
export const RUNTIME_T_KEYS: Record<string, string> = {
  python: 'taskList.runtime.python',
  node: 'taskList.runtime.node',
  shell: 'taskList.runtime.shell',
};

/** 单条运行时的展示文本：有标签用标签，未知值回退原始 token。 */
export function runtimeLabel(
  runtime: string | null | undefined,
  t: (key: string) => string,
): string {
  if (runtime === null || runtime === undefined || runtime === '') return '';
  const key = RUNTIME_T_KEYS[runtime];
  return key ? t(key) : runtime;
}
