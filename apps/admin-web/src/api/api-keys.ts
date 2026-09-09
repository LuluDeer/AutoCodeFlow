import { client } from './client';

/**
 * AUTH-03: 限权 API Key（CI/CD 机器认证）。
 * 明文 key（acf_ 前缀）仅 create 响应回显一次，服务端只存 sha256。
 */

export type ApiKeyScope = 'readonly' | 'trigger' | 'manage';

export interface ApiKeyView {
  id: number;
  name: string;
  keyPrefix: string;
  scope: ApiKeyScope;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ApiKeyCreateResult extends ApiKeyView {
  /** 一次性明文——仅本次响应存在，之后不可再取。 */
  plaintext: string;
}

export const apiKeysApi = {
  list: () => client.get('/api-keys') as Promise<ApiKeyView[]>,
  create: (data: { name: string; scope: ApiKeyScope; expiresInDays?: number }) =>
    client.post('/api-keys', data) as Promise<ApiKeyCreateResult>,
  revoke: (id: number) =>
    client.delete(`/api-keys/${id}`) as Promise<{ success: boolean; apiKey: ApiKeyView }>,
};
