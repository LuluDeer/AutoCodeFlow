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
  list: (signal?: AbortSignal) =>
    signal
      ? client.get('/api-keys', { signal }) as Promise<ApiKeyView[]>
      : client.get('/api-keys') as Promise<ApiKeyView[]>,
  create: (data: {
    name: string;
    scope: ApiKeyScope;
    expiresInDays?: number;
    /** A-14: NF-01 扩展域词表（空格分隔）——当前仅 task:trigger，随 scope=trigger 显式勾选透传。 */
    scopes?: string;
  }) =>
    client.post('/api-keys', data) as Promise<ApiKeyCreateResult>,
  revoke: (id: number) =>
    client.delete(`/api-keys/${id}`) as Promise<{ success: boolean; apiKey: ApiKeyView }>,
  /**
   * 永久删除（硬删）。只对**已失效**的行开放（已吊销 / 已过期）——活跃 key
   * 后端会 409（`API_KEY_DELETE_ACTIVE_FORBIDDEN`），必须先吊销。
   * 路径与软删 `DELETE /api-keys/:id` 显式区分，不破坏既有客户端语义。
   */
  remove: (id: number) =>
    client.delete(`/api-keys/${id}/permanent`) as Promise<{ success: boolean; apiKey: ApiKeyView }>,
};
