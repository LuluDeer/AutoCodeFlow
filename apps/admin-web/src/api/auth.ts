import { client } from './client';
import type { AuthUser } from '../store/auth';

export interface LoginResult {
  accessToken?: string;
  refreshToken?: string;
  user?: AuthUser;
  /** SEC-03: TOTP 启用用户的登录第一段返回——需再调 verifyLogin 完成登录。 */
  totpRequired?: boolean;
}

export interface AuthSession {
  id: number;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

export interface TotpSetupResult {
  secret: string;
  otpauthUrl: string;
}

export const authApi = {
  login: (data: { username: string; password: string }) =>
    client.post('/auth/login', data) as Promise<LoginResult>,
  refresh: (refreshToken: string) =>
    client.post('/auth/refresh', { refreshToken }) as Promise<{ accessToken: string }>,
  me: () => client.get('/auth/profile') as Promise<AuthUser>,
  // ─── SEC-03: TOTP 第二步登录（复验账号密码 + 6 位动态码后签发 token） ───
  verifyLogin: (data: { username: string; password: string; code: string }) =>
    client.post('/auth/totp/verify', data) as Promise<{ accessToken: string; refreshToken: string; user?: AuthUser }>,
  // ─── SEC-03: TOTP 管理（JWT 鉴权） ───
  totpSetup: () => client.post('/auth/totp/setup') as Promise<TotpSetupResult>,
  totpEnable: (code: string) =>
    client.post('/auth/totp/enable', { code }) as Promise<{ enabled: boolean }>,
  totpDisable: (data: { password?: string; code?: string }) =>
    client.post('/auth/totp/disable', data) as Promise<{ disabled: boolean }>,
  // ─── SEC-03: 会话管理（DR-04 撤销语义的 UI 面） ───
  listSessions: () => client.get('/auth/sessions') as Promise<AuthSession[]>,
  revokeSession: (id: number) =>
    client.delete(`/auth/sessions/${id}`) as Promise<{ success: boolean }>,
  revokeOtherSessions: () =>
    client.post('/auth/sessions/revoke-others') as Promise<{ revoked: number }>,
};
