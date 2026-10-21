import { client } from './client';

/**
 * 审计日志行——后端 `GET /audit` 的 data 元素。
 *
 * ⚠️ `id` 是 `integer`（`audit_logs.id` 走序列），**不是** uuid：这决定了该表的
 * keyset 游标用数字 id 解码器（见 `nextCursor`）。前端只把它当不透明令牌，
 * 不解析、不拼接——这条备注只是为了让"造测试夹具/排障时别按 uuid 形状猜"。
 */
export interface AuditLog {
  id: number;
  action: string;
  resource: string;
  resourceId?: string;
  userId: number;
  username: string;
  ip?: string;
  result: 'success' | 'failure';
  detail?: Record<string, unknown>;
  createdAt: string;
}

/**
 * 列表筛选条件（与 CSV 导出**同一套参数名**，见 buildAuditExportQuery）。
 */
export interface AuditListFilters {
  action?: string;
  resource?: string;
  resourceId?: string;
  username?: string;
  result?: '' | 'success' | 'failure';
  startTime?: string;
  endTime?: string;
}

/**
 * `GET /audit` 列表响应。
 *
 * `nextCursor` 用的是 `?:` 而不是 `| null`，与 `api/tasks.ts` 的 `PageResult`
 * 同款口径：**这个键可能根本不存在**。后端契约（`paginate()`，见
 * apps/admin-api/src/common/dto/pagination.dto.ts）规定——
 *   · 请求不带 `cursor` → 走既有 OFFSET 分支，响应**逐字节不变**，
 *     `nextCursor` 这个键**根本不出现**（`undefined`）；
 *   · 请求带 `cursor` → 走 keyset 分支，响应**追加**该键，`null` = 已到末页。
 *
 * `undefined`（走的 OFFSET 路径）与 `null`（keyset 且已翻完）是**两种不同语义**，
 * 读侧必须分开，不能用 `?? null` 糊成一团。游标不透明，禁止前端解析。
 */
export interface AuditListResult {
  data: AuditLog[];
  total: number;
  nextCursor?: string | null;
}

/** 列表请求的可选游标（三态语义见 `listAuditLogs` 的实现注释）。 */
export interface AuditListParams extends AuditListFilters {
  page?: number;
  pageSize?: number;
  /** `undefined` = 不带该参数（OFFSET 路径）；`''` = keyset 起点；非空 = 中途页。 */
  cursor?: string;
}

/**
 * 由列表参数拼查询串（游标三态的唯一落点）。
 *
 * ## 为什么要一个专门的函数，而不是页面里 `new URLSearchParams({...})`
 *
 * 游标是**三态**的，而"键存不存在"在后端是有语义的：
 *   · `undefined` → 键**根本不出现** → 后端走既有 OFFSET 分支，响应逐字节不变
 *     （连 `nextCursor` 这个键都没有）；
 *   · `''`（空串） → `cursor=` → 后端走 keyset 分支的**起点**；
 *   · 非空串 → `cursor=<令牌>` → keyset 的中途页。
 *
 * 若让 `undefined` 流进 `URLSearchParams`/axios 的参数表，正确性就押在了
 * "那个库怎么序列化 undefined"上；更常见的事故是把判据写成 `if (cursor)`，
 * 那会把空串一并当"没传"，keyset 起点永远进不去（页面表现为"开了开关但
 * 一直在第一页"）。故这里用显式的 `=== undefined` 分支把三态分开，
 * **不在渲染期用 `??` / `||` 归一**。
 *
 * 游标不透明：本函数只搬运，绝不解析、截断或重新编码。
 */
export function buildAuditListQuery(params: AuditListParams): string {
  const { page = 1, pageSize = 20, cursor, ...filters } = params;
  const query: Record<string, string> = {
    page: String(page),
    pageSize: String(pageSize),
  };
  // 与 CSV 导出同一套"空值不携带"口径（见 buildAuditExportQuery）
  if (filters.action) query.action = filters.action;
  if (filters.resource) query.resource = filters.resource;
  if (filters.resourceId) query.resourceId = filters.resourceId;
  if (filters.username) query.username = filters.username;
  if (filters.result) query.result = filters.result;
  if (filters.startTime) query.startTime = filters.startTime;
  if (filters.endTime) query.endTime = filters.endTime;
  // 游标三态：只有 `undefined` 才是"不带这个参数"（键存在性是契约的一部分）。
  if (cursor !== undefined) query.cursor = cursor;
  return new URLSearchParams(query).toString();
}

/**
 * `GET /audit/actions` 的响应：**去重后的动作清单**（后端 DB 侧 DISTINCT + 字母序）。
 *
 * 形状刻意最素：一份用于渲染下拉的小集合，没有分页信封、没有 total。
 */
export interface AuditActionListResult {
  actions: string[];
}

/**
 * R67-A1：拉取审计动作清单，供 action 过滤器渲染**可发现**的下拉。
 *
 * 这是「能筛 → 筛得到」缺的那一半：动作已有 61 个（19 个域），只给自由文本输入框，
 * 等于要求用户先把动作名背下来。
 *
 * **本函数不做兜底**：失败就抛。页面侧的契约是「失败不阻断页面、回落成自由输入」，
 * 那是渲染决策，写在页面里（见 pages/audit 的 actionsQuery）。在这里把错误吞成
 * 空数组，会让「后端确实没有动作」与「请求挂了」变成同一件事，排障时无从分辨。
 */
export function listAuditActions(
  signal?: AbortSignal,
): Promise<AuditActionListResult> {
  return client.get<AuditActionListResult>('/audit/actions', { signal });
}

/**
 * 拉取审计日志列表（`GET /audit`，ADMIN-only）。
 *
 * 默认（`cursor` 缺省）= 既有 OFFSET 分页：查询串与加 keyset 之前**逐字节相同**，
 * 请求里没有 `cursor` 键，后端因此走原路径、响应也逐字节不变——这是「稳定翻页」
 * 开关关闭时的零风险路径。
 */
export function listAuditLogs(
  params: AuditListParams = {},
  signal?: AbortSignal,
): Promise<AuditListResult> {
  const qs = buildAuditListQuery(params);
  return client.get<AuditListResult>(`/audit?${qs}`, { signal });
}

/**
 * A-12: 审计 CSV 导出（GET /audit/export，ADMIN-only + JWT）。
 *
 * 后端从 Authorization 头取 JWT，`<a href>` 直链无法携带鉴权头（会 401），
 * 因此与 api/artifacts.ts 的 downloadArtifact 同一写法：axios blob 请求 +
 * objectURL 触发浏览器保存。响应拦截器对 Blob（无 code/data 字段）原样放行。
 *
 * 筛选形状与列表接口**逐字段相同**（这是后端两个端点的既有契约），故直接复用
 * `AuditListFilters`：两份平行的形状声明迟早会漂移，而漂移的后果是「列表筛出来
 * 的结果」与「导出的 CSV」不一致，恰恰是审计场景最不能有的。
 */
export type AuditExportFilters = AuditListFilters;

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
