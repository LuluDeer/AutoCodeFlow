/**
 * 渲染层 number input 的统一解析（纯函数，无 React / DOM 依赖）。
 *
 * 为什么抽出来：`<input type="number">` 的 `e.target.value` 在用户清空输入框
 * 时是 `''`，`parseInt('')` 得到 `NaN`。原实现直接把 NaN 塞进表单状态——
 * 显示层用 `Number(v || 默认)` 仍然渲染默认值，于是"界面显示 10、实际保存
 * NaN"，NaN 再经 IPC 序列化成 null 撞上主进程的 schema 校验。
 * 这里是那类缺陷的**单一修复点**：留空 → 回落默认；越界 → 钳制。
 *
 * 无 DOM 依赖，因此 `test:renderer` 可以在裸 node 下直接 import 断言
 * （Node ≥22.6 原生解析 .ts）。
 */
export function parseBoundedInt(
  raw: string,
  fallback: number,
  min: number,
  max: number,
): number {
  // 空白/空串 = 用户清空了输入框 = "未指定" → 回落默认（不当 0，否则会被
  // 钳到下界，于是"清空"变成 1，与界面显示的默认值再次不一致）。
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 设置页「最大并发任务数」的区间与默认值（与 config-store schema 对齐）。 */
export const MAX_CONCURRENT_TASKS = { fallback: 10, min: 1, max: 100 } as const;
/** 设置页「监听端口」的区间与默认值。 */
export const EXECUTOR_PORT = { fallback: 8002, min: 1, max: 65535 } as const;
/** 设置页「解释器下载超时（毫秒）」：0 = 用执行器默认。 */
export const DOWNLOAD_TIMEOUT_MS = { fallback: 0, min: 0, max: 86_400_000 } as const;

/** 显示用的安全取值：把状态里的脏值（NaN/null）也映射成默认，所见即所存。 */
export function displayNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
