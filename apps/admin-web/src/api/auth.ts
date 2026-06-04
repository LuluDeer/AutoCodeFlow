import { client } from './client';

export const authApi = {
  login: (data: { username: string; password: string }) =>
    client.post<any, { accessToken: string; refreshToken: string }>('/auth/login', data),
  refresh: (refreshToken: string) =>
    client.post<any, { accessToken: string }>('/auth/refresh', { refreshToken }),
  me: () => client.get<any, any>('/auth/me'),
};
