import { client } from './client';

export interface NotificationChannel {
  key: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  description: string;
}

export const notificationsApi = {
  getChannels: () => client.get<any, NotificationChannel[]>('/notification/channels'),
  updateChannel: (key: string, data: Partial<NotificationChannel>) =>
    client.patch<any, NotificationChannel>(`/notification/channels/${key}`, data),
  testChannel: (key: string, data: Record<string, string>) =>
    client.post<any, { success: boolean; message: string }>(`/notification/channels/${key}/test`, data),
  send: (data: { channels: string[]; title: string; content: string }) =>
    client.post<any, { success: boolean; message: string }>('/notification/test', data),
};