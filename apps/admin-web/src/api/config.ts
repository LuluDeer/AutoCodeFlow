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
  findAll: (params?: { prefix?: string; tag?: string }) =>
    client.get<SystemConfig[]>('/config', { params }),

  findOne: (key: string) =>
    client.get<SystemConfig>(`/config/${encodeURIComponent(key)}`),

  upsert: (data: UpsertConfigPayload) =>
    client.put<SystemConfig>('/config', data),

  batchUpsert: (items: UpsertConfigPayload[]) =>
    client.post<SystemConfig[]>('/config/batch', items),

  remove: (key: string) =>
    client.delete(`/config/${encodeURIComponent(key)}`),

  getHistory: (params?: { key?: string; page?: number; pageSize?: number }) =>
    client.get<{ data: ConfigHistory[]; total: number }>('/config/history', { params }),

  // FEAT-08：回滚成功返回写回后的配置项；回滚创建条目（= 删除）时后端返回
  // { deleted: true }。
  rollback: (id: number) =>
    client.post<SystemConfig | { deleted: true }>(`/config/history/${id}/rollback`),

  generateExecutorToken: () =>
    client.post<{ token: string }>('/config/executor-shared-token/generate'),

  getExecutorToken: () =>
    client.get<{ token: string | null; hasToken: boolean }>('/config/executor-shared-token'),
};
