export interface NotificationPayload {
  title: string;
  content: string;
  level?: 'info' | 'warning' | 'error';
}
export abstract class BaseChannel {
  abstract name: string;
  abstract send(payload: NotificationPayload): Promise<void>;
}
