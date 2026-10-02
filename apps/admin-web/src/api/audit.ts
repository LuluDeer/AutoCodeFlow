import { client } from './client';

/**
 * A-12: 审计 CSV 导出（GET /audit/export，ADMIN-only + JWT）。
 *
 * 后端从 Authorization 头取 JWT，`<a href>` 直链无法携带鉴权头（会 401），
 * 因此与 api/artifacts.ts 的 downloadArtifact 同一写法：axios blob 请求 +
 * objectURL 触发浏览器保存。响应拦截器对 Blob（无 code/data 字段）原样放行。
 */
export interface AuditExportFilters {
  action?: string;
  resource?: string;
  resourceId?: string;
  username?: string;
  result?: '' | 'success' | 'failure';
  startTime?: string;
  endTime?: string;
}

/** 由筛选对象拼查询串（与列表页 /audit 同一套参数名，空值不携带） */
export function buildAuditExportQuery(filters: AuditExportFilters): string {
  const params: Record<string, string> = {};
  if (filters.action) params.action = filters.action;
  if (filters.resource) params.resource = filters.resource;
  if (filters.resourceId) params.resourceId = filters.resourceId;
  if (filters.username) params.username = filters.username;
  if (filters.result) params.result = filters.result;
  if (filters.startTime) params.startTime = filters.startTime;
  if (filters.endTime) params.endTime = filters.endTime;
  return new URLSearchParams(params).toString();
}

/** 导出审计 CSV 并触发浏览器保存（携带当前筛选条件，后端上限 10 000 行） */
export async function exportAuditCsv(filters: AuditExportFilters): Promise<void> {
  const qs = buildAuditExportQuery(filters);
  const blob = await client.get<Blob>(`/audit/export${qs ? `?${qs}` : ''}`, {
    responseType: 'blob',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'audit-logs.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
