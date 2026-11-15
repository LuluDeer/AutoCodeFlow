import type { TaskTemplate } from '../api/task-templates';

/**
 * P1-5：模板清单导入的**客户端前置**校验与冲突预览纯逻辑。
 *
 * 判据与后端 `task-template.manifest.ts` 对齐（轻量镜像，不重复实现全量校验）：
 * 清单是扁平结构 `{ name, version, description, capabilities, params,
 * entrypoints, config? }`，不是 `{ template: {...} }` 包裹体。未知键、能力域枚举、
 * params/entrypoints 细项合法性仍由后端 400 把关；这里只挡明显坏的载荷。
 *
 * 冲突预览基于当前列表快照：`name` 即 DB 的 `key`（唯一），已存在即 409，
 * 后端**不覆盖**既有行。
 */

/** 与后端 TEMPLATE_MANIFEST_NAME_RE 对齐（key 列 varchar(64) 唯一）。 */
export const TEMPLATE_MANIFEST_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** 与后端 TEMPLATE_MANIFEST_VERSION_RE 对齐（语义化版本）。 */
export const TEMPLATE_MANIFEST_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const TEMPLATE_DESCRIPTION_MAX = 500;

export type TemplateImportErrorCode =
  | 'notJson'
  | 'notObject'
  | 'nameMissing'
  | 'nameBlank'
  | 'nameInvalid'
  | 'versionMissing'
  | 'versionInvalid'
  | 'descriptionMissing'
  | 'descriptionBlank'
  | 'descriptionTooLong'
  | 'configNotObject';

export interface TemplateImportIssue {
  code: TemplateImportErrorCode;
  params?: Record<string, string>;
}

export interface TemplateImportConflict {
  type: 'key';
  key: string;
  existingName?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 解析并校验一段清单文本（JSON 文件内容或粘贴文本）。
 * 成功返回规范化后的清单对象；失败返回逐条问题码（不抛异常）。
 */
export function parseTemplateImportText(
  text: string,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; issues: TemplateImportIssue[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ code: 'notJson' }] };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ code: 'notObject' }] };
  }

  const issues: TemplateImportIssue[] = [];

  const name = raw.name;
  if (name === undefined || name === null) {
    issues.push({ code: 'nameMissing' });
  } else if (typeof name !== 'string' || name.trim() === '') {
    issues.push({ code: 'nameBlank' });
  } else if (!TEMPLATE_MANIFEST_NAME_RE.test(name)) {
    issues.push({ code: 'nameInvalid', params: { value: name } });
  }

  const version = raw.version;
  if (version === undefined || version === null) {
    issues.push({ code: 'versionMissing' });
  } else if (typeof version !== 'string' || !TEMPLATE_MANIFEST_VERSION_RE.test(version)) {
    issues.push({ code: 'versionInvalid', params: { value: String(version) } });
  }

  const description = raw.description;
  if (description === undefined || description === null) {
    issues.push({ code: 'descriptionMissing' });
  } else if (typeof description !== 'string' || description.trim() === '') {
    issues.push({ code: 'descriptionBlank' });
  } else if (description.length > TEMPLATE_DESCRIPTION_MAX) {
    issues.push({ code: 'descriptionTooLong', params: { max: String(TEMPLATE_DESCRIPTION_MAX) } });
  }

  const config = raw.config;
  if (config !== undefined && !isPlainObject(config)) {
    issues.push({ code: 'configNotObject' });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, payload: raw };
}

/** 基于列表快照预览 key 冲突（后端唯一索引兜底，不覆盖）。 */
export function previewTemplateConflicts(
  payload: Record<string, unknown>,
  existing: Pick<TaskTemplate, 'id' | 'key' | 'name'>[],
): TemplateImportConflict[] {
  const key = typeof payload.name === 'string' ? payload.name : '';
  if (!key) return [];
  const hit = existing.find((row) => row.key === key);
  return hit ? [{ type: 'key', key, existingName: hit.name }] : [];
}
