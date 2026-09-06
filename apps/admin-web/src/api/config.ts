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
export interface ConfigHistory {
  id: number;
  configKey: string;
  action: 'create' | 'update' | 'delete';
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

  rollback: (id: number) =>
    client.post(`/config/history/${id}/rollback`),

  generateExecutorToken: () =>
    client.post<{ token: string }>('/config/executor-shared-token/generate'),

  getExecutorToken: () =>
    client.get<{ token: string | null; hasToken: boolean }>('/config/executor-shared-token'),
};
