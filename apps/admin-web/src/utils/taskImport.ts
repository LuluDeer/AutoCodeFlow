import type { components } from '../types/generated/api-types';
import type { Task } from '../api/tasks';

/**
 * P1-5：任务定义导入的**客户端前置**校验与冲突预览纯逻辑。
 *
 * 边界分工（不伪造后端能力）：
 *  - 这里只做形状 / 必填 / 枚举 / 名称长度等**轻量 schema 校验**，把明显坏的载荷
 *    挡在请求之前；语义级校验（cron 合法性、params 体积、secrets 键名、项目写权限
 *    等）仍由后端 `POST /tasks/import` 走完整创建链路把关，前端不重复实现第二份。
 *  - 冲突预览基于当前列表快照（名称 / id / 项目）做 best-effort 提示；后端契约是
 *    **单条创建、重名自动加后缀、绝不覆盖**，没有 dry-run，也没有批量跳过/覆盖选项。
 *    预览只帮助用户判断，最终落库结果以后端响应为准。
 */

export const TASK_IMPORT_SCHEMA_VERSION = '1';

const TRIGGER_TYPES = ['cron', 'fixed_rate', 'api', 'manual'] as const;
const RUNTIMES = ['python', 'node', 'shell'] as const;
const TASK_NAME_MAX_LENGTH = 255;

/** 校验问题码：组件层按 `taskImport.error.<code>` 取文案，params 供插值。 */
export type ImportErrorCode =
  | 'notJson'
  | 'arrayNotSupported'
  | 'notObject'
  | 'schemaVersionMissing'
  | 'schemaVersionMismatch'
  | 'taskMissing'
  | 'taskNotObject'
  | 'nameMissing'
  | 'nameNotString'
  | 'nameBlank'
  | 'nameTooLong'
  | 'triggerTypeMissing'
  | 'triggerTypeInvalid'
  | 'runtimeInvalid'
  | 'idInvalid';

export interface ImportValidationIssue {
  code: ImportErrorCode;
  params?: Record<string, string>;
}

export type ImportConflictType = 'name' | 'id' | 'project';

export interface ImportConflict {
  type: ImportConflictType;
  /** 重名时已有任务的展示名（文案插值用）。 */
  existingName?: string;
  /** id 冲突时已有任务的 id。 */
  existingId?: string;
  /** 项目不一致时载荷声明的 projectId。 */
  projectId?: string;
}

export interface ValidatedImport {
  payload: components['schemas']['ImportTaskDto'];
  conflicts: ImportConflict[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 解析并校验一段导入文本（JSON 文件内容或粘贴文本）。
 *
 * 成功返回规范化后的 `ImportTaskDto`；失败返回逐条问题码（不抛异常，便于弹窗
 * 内联罗列）。数组载荷明确拒绝：后端导入端点只收单条定义，批量导入不在本轮契约内。
 */
export function parseTaskImportText(
  text: string,
): { ok: true; payload: components['schemas']['ImportTaskDto'] } | { ok: false; issues: ImportValidationIssue[] } {
  const issues: ImportValidationIssue[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ code: 'notJson' }] };
  }

  if (Array.isArray(raw)) {
    return { ok: false, issues: [{ code: 'arrayNotSupported' }] };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ code: 'notObject' }] };
  }

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion === undefined || schemaVersion === null) {
    issues.push({ code: 'schemaVersionMissing' });
  } else if (schemaVersion !== TASK_IMPORT_SCHEMA_VERSION) {
    issues.push({
      code: 'schemaVersionMismatch',
      params: { version: String(schemaVersion) },
    });
  }

  const task = raw.task;
  if (task === undefined) {
    issues.push({ code: 'taskMissing' });
  } else if (!isPlainObject(task)) {
    issues.push({ code: 'taskNotObject' });
  } else {
    // ── name ──
    const name = task.name;
    if (name === undefined || name === null) {
      issues.push({ code: 'nameMissing' });
    } else if (typeof name !== 'string') {
      issues.push({ code: 'nameNotString' });
    } else if (name.trim() === '') {
      issues.push({ code: 'nameBlank' });
    } else if (name.length > TASK_NAME_MAX_LENGTH) {
      issues.push({ code: 'nameTooLong', params: { max: String(TASK_NAME_MAX_LENGTH) } });
    }

    // ── triggerType（CreateTaskDto 必填枚举） ──
    const triggerType = task.triggerType;
    if (triggerType === undefined || triggerType === null || triggerType === '') {
      issues.push({ code: 'triggerTypeMissing' });
    } else if (
      typeof triggerType !== 'string' ||
      !(TRIGGER_TYPES as readonly string[]).includes(triggerType)
    ) {
      issues.push({ code: 'triggerTypeInvalid', params: { value: String(triggerType) } });
    }

    // ── runtime（可选；给了就必须在值域内） ──
    const runtime = task.runtime;
    if (
      runtime !== undefined &&
      runtime !== null &&
      (typeof runtime !== 'string' || !(RUNTIMES as readonly string[]).includes(runtime))
    ) {
      issues.push({ code: 'runtimeInvalid', params: { value: String(runtime) } });
    }

    // ── id（可选；给了就必须是 UUID 形态，避免后端 22P02/23505 裸 500） ──
    const id = task.id;
    if (
      id !== undefined &&
      id !== null &&
      (typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    ) {
      issues.push({ code: 'idInvalid', params: { value: String(id) } });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    payload: raw as unknown as components['schemas']['ImportTaskDto'],
  };
}

/**
 * 基于当前列表快照做冲突预览：
 *  - `name`：名称（忽略首尾空白与大小写）与既有任务相同；
 *  - `id`：载荷自带 id 与既有任务 id 相同；
 *  - `project`：载荷声明了 projectId，且与当前列表筛选项目不一致（跨项目导入提示）。
 *
 * 注意：重名冲突后端会自动追加 ` (imported)` 后缀继续创建，**不会覆盖**；id 冲突
 * 后端会以唯一索引拒绝（409）。这里只标出来，不提供「覆盖」动作——后端无此能力。
 */
export function previewTaskConflicts(
  payload: components['schemas']['ImportTaskDto'],
  existing: Pick<Task, 'id' | 'name' | 'projectId'>[],
  currentProjectId?: string | null,
): ImportConflict[] {
  const conflicts: ImportConflict[] = [];
  const task = payload.task as Record<string, unknown>;
  const name = typeof task.name === 'string' ? task.name : '';
  const payloadId = typeof task.id === 'string' ? task.id : undefined;
  const payloadProjectId =
    typeof task.projectId === 'string' ? task.projectId : undefined;

  for (const row of existing ?? []) {
    if (name && row.name && normalizeName(row.name) === normalizeName(name)) {
      conflicts.push({ type: 'name', existingName: row.name, existingId: row.id });
    }
    if (payloadId && row.id === payloadId) {
      conflicts.push({ type: 'id', existingId: row.id });
    }
  }

  if (payloadProjectId && currentProjectId && payloadProjectId !== currentProjectId) {
    conflicts.push({ type: 'project', projectId: payloadProjectId });
  }

  return conflicts;
}
