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

// ─── FEAT-01: 通知静默规则（notification_silences 持久化 CRUD，后端 ADMIN-only）───
// 端点形状对齐 admin-api notification-config.controller.ts：
//   GET    /notification/silences       → NotificationSilence[]（listAll，含已过期行，后端每分钟清扫）
//   POST   /notification/silences       → NotificationSilence（durationMinutes>0 时后端折算 endTime）
//   DELETE /notification/silences/:id   → boolean（是否删除到行）

export type SilenceScope = 'global' | 'task' | 'application';

export interface NotificationSilence {
  id: string;
  scope: SilenceScope;
  /** 空 = 全渠道；否则 email/slack/dingtalk/wecom/webhook */
  channelType: string | null;
  taskId: string | null;
  applicationId: string | null;
  /** 空 = 所有级别 */
  level: string | null;
  reason: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  createdBy: string | null;
  createdAt: string;
}

export interface CreateSilencePayload {
  scope: SilenceScope;
  channelType?: string;
  taskId?: string;
  applicationId?: string;
  level?: string;
  reason?: string;
  durationMinutes?: number;
}

export const silencesApi = {
  list: () =>
    client.get('/notification/silences') as Promise<NotificationSilence[]>,
  create: (data: CreateSilencePayload) =>
    client.post('/notification/silences', data) as Promise<NotificationSilence>,
  remove: (id: string) =>
    client.delete(`/notification/silences/${id}`) as Promise<boolean>,
};
