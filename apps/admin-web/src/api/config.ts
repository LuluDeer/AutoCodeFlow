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

export interface ConfigHistory {
  id: number;
  configKey: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string | null;
  changedAt: string;
  ipAddress: string | null;
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
