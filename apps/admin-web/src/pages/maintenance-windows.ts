/**
 * FEAT-06: 任务级维护窗口的表单序列化纯逻辑层（与 executor-mode.ts 同层次，
 * 独立成文件以满足 react-refresh 只导出组件的限制并便于单测）。
 */
import type { MaintenanceWindow } from '../api/tasks';

/** 维护窗口上限（与后端 DTO ArrayMaxSize(10) 对齐） */
export const MAINTENANCE_WINDOWS_MAX = 10;

/**
 * 表单值 → 提交 payload 序列化：
 *  - 逐条 trim cron 与说明、丢弃 start/end 均为空的"幽灵行"（用户点了
 *    添加行又没填就提交的场景）；
 *  - 半填行（只填了一端）原样保留，交给后端 DTO 结构校验 400——前端不
 *    静默吞掉用户的半截输入；
 *  - 空集必须**显式 null** 而非缺省/delete——后端 PATCH 是 Object.assign
 *    语义（N28 教训：缺省字段 = 保留旧值），删除全部窗口不发 null 会
 *    "界面已清空、调度仍在窗口内跳过"。
 * 字段未挂载（undefined）→ 归一为 null，与 requirements 序列化同语义。
 */
export function applyMaintenanceWindowsPayload(
  values: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...values };
  const raw = payload.maintenanceWindows;
  if (Array.isArray(raw)) {
    const cleaned = raw
      .map((w) => ({
        start: typeof w?.start === 'string' ? w.start.trim() : '',
        end: typeof w?.end === 'string' ? w.end.trim() : '',
        description:
          typeof w?.description === 'string' && w.description.trim()
            ? w.description.trim()
            : undefined,
      }))
      .filter((w) => w.start.length > 0 || w.end.length > 0);
    payload.maintenanceWindows = cleaned.length > 0 ? cleaned : null;
  } else {
    payload.maintenanceWindows = null;
  }
  return payload;
}

/** 表单内动态行的本地类型（description 可为空串，提交前归一为 undefined） */
export interface MaintenanceWindowRow extends MaintenanceWindow {
  description?: string;
}
