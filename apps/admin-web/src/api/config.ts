import { client } from './client';

export interface SystemConfig {
  id: number;
  key: string;
  value: string | null;
  description: string | null;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  isSecret: boolean;
  tag: string | null;
  createdAt: string;
  updatedAt: string;
}

// 与后端 ConfigHistory 实体逐字段对齐
// （apps/admin-api/src/modules/config/entities/config-history.entity.ts）。
// 可空性按实体 @Column({ nullable: true }) 标注；createdAt 为 ISO 字符串。
// FEAT-08：action 增加 'rollback'（回滚端点写入的留痕行）。
export interface ConfigHistory {
  id: number;
  configKey: string;
  action: 'create' | 'update' | 'delete' | 'rollback';
  oldValue: string | null;
  newValue: string | null;
  description: string | null;
  userId: string | null;
  username: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface UpsertConfigPayload {
  key: string;
  value: string;
  description?: string;
  valueType?: 'string' | 'number' | 'boolean' | 'json';
  isSecret?: boolean;
  tag?: string;
}

export const configApi = {
  findAll: (params?: { prefix?: string; tag?: string }, signal?: AbortSignal) =>
    signal
      ? client.get<SystemConfig[]>('/config', { params, signal })
      : client.get<SystemConfig[]>('/config', { params }),

  findOne: (key: string) =>
    client.get<SystemConfig>(`/config/${encodeURIComponent(key)}`),

  upsert: (data: UpsertConfigPayload) =>
    client.put<SystemConfig>('/config', data),

  batchUpsert: (items: UpsertConfigPayload[]) =>
    client.post<SystemConfig[]>('/config/batch', items),

  remove: (key: string) =>
    client.delete(`/config/${encodeURIComponent(key)}`),

  getHistory: (params?: { key?: string; page?: number; pageSize?: number }, signal?: AbortSignal) =>
    signal
      ? client.get<{ data: ConfigHistory[]; total: number }>('/config/history', { params, signal })
      : client.get<{ data: ConfigHistory[]; total: number }>('/config/history', { params }),

  // FEAT-08：回滚成功返回写回后的配置项；回滚创建条目（= 删除）时后端返回
  // { deleted: true }。
  rollback: (id: number) =>
    client.post<SystemConfig | { deleted: true }>(`/config/history/${id}/rollback`),

  generateExecutorToken: () =>
    client.post<{ token: string }>('/config/executor-shared-token/generate'),

  getExecutorToken: (signal?: AbortSignal) =>
    signal
      ? client.get<{ token: string | null; hasToken: boolean }>('/config/executor-shared-token', { signal })
      : client.get<{ token: string | null; hasToken: boolean }>('/config/executor-shared-token'),

  // G-1：后端 runtime-version 权威配置（可声明区间 min/max、在线下界 onlineMin、
  // legacy 兜底 legacyDefaultInterpreter、Tier 版本表 tier1/2/3）。
  // 端点上线后在应用启动时拉取，把结果传给
  // pages/executor-mode 的 configureRuntimeVersionConfig()，前端读面
  // （候选列表/区间提示/舰队咨询）即跟随后端，无需人工同步硬编码常量。
  // G-1 已闭环：端点 admin-api GET /config/runtime-version 已上线，调用方为
  // TaskFormPage（打开表单时拉一次并注入 configureRuntimeVersionConfig）。
  // 返回类型为**手写**而非 generated：该端点标了 @ApiExcludeEndpoint（本机无
  // PG/Redis，swagger:export 不可重跑，纳入扫描会让 CI openapi-drift 双闸红），
  // 故不存在于 openapi.json / api-types.ts。
  getRuntimeVersion: () =>
    client.get<{
      min: string;
      max: string;
      onlineMin: string;
      legacyDefaultInterpreter: string;
      tier1: string[];
      tier2: string[];
      tier3: string[];
    }>('/config/runtime-version'),
};
