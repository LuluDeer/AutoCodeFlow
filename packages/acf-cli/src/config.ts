#!/usr/bin/env node
/**
 * Persistent config store for the ACF CLI.
 * Stores API URL and tokens in the user's config directory.
 */
import Conf from 'conf';

interface AcfConfig {
  apiUrl: string;
  token: string;
  refreshToken: string;
}

const store = new Conf<AcfConfig>({
  projectName: 'acf-cli',
  defaults: {
    apiUrl: 'http://localhost:3105',
    token: '',
    refreshToken: '',
  },
});

export function getApiUrl(): string {
  return process.env.ACF_API_URL || store.get('apiUrl');
}

export function getToken(): string {
  return process.env.ACF_TOKEN || store.get('token');
}

export function getRefreshToken(): string {
  return process.env.ACF_REFRESH_TOKEN || store.get('refreshToken');
}

export function setApiUrl(url: string): void {
  store.set('apiUrl', url);
}

export function setToken(token: string): void {
  store.set('token', token);
}

export function setRefreshToken(token: string): void {
  store.set('refreshToken', token);
}

/**
 * BUG-13: 刷新彻底失败（refresh token 也已过期/被轮换掉）时清除本地凭据，
 * 后续请求返回到「未登录」状态——避免拿着必死 token 反复打 401。
 * apiUrl 保留（用户环境不丢）。
 */
export function clearAuth(): void {
  store.set('token', '');
  store.set('refreshToken', '');
}

export function showConfig(): void {
  console.log('API URL :', getApiUrl());
  console.log('Token   :', getToken() ? '[set]' : '[not set]');
  console.log('Refresh :', getRefreshToken() ? '[set]' : '[not set]');
  console.log('Config file:', store.path);
}
