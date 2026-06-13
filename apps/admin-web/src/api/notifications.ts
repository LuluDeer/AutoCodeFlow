import { client } from './client';

export interface NotificationChannel {
  key: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  description: string;
}

export const notificationsApi = {
  getChannels: () =>
    client.get('/notification/channels') as Promise<NotificationChannel[]>,
  updateChannel: (key: string, data: Partial<NotificationChannel>) =>
    client.patch(`/notification/channels/${key}`, data) as Promise<NotificationChannel>,
  testChannel: (key: string, data: Record<string, string>) =>
    client.post(`/notification/channels/${key}/test`, data) as Promise<{ success: boolean; message: string }>,
  send: (data: { channels: string[]; title: string; content: string }) =>
    client.post('/notification/test', data) as Promise<{ success: boolean; message: string }>,
};
