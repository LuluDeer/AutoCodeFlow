import { client } from './client';
import type { AuthUser } from '../store/auth';

export const authApi = {
  login: (data: { username: string; password: string }) =>
    client.post('/auth/login', data) as Promise<{ accessToken: string; refreshToken: string; user: AuthUser }>,
  refresh: (refreshToken: string) =>
    client.post('/auth/refresh', { refreshToken }) as Promise<{ accessToken: string }>,
  me: () => client.get('/auth/profile') as Promise<AuthUser>,
};
