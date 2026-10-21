import { getLocale, t } from '@/lib/i18n';

export function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatRelative(iso: string | null): string {
  if (!iso) return t('common.never');
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return t('common.justNow');
  if (diff < 60 * 60_000) return t('common.minutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 24 * 60 * 60_000) {
    return t('common.hoursAgo', { count: Math.floor(diff / (60 * 60_000)) });
  }
  return t('common.daysAgo', { count: Math.floor(diff / (24 * 60 * 60_000)) });
}

export function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '—';
  if (seconds < 60) return t('common.uptimeSeconds', { seconds: Math.floor(seconds) });
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return t('common.uptimeHours', { hours, minutes });
  return t('common.uptimeMinutes', { minutes: Math.max(minutes, 1) });
}
