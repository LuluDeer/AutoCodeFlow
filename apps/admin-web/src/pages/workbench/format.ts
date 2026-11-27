/** Display-only helpers for the workbench UI. No network access, no side effects. */

/** Human-readable byte size (base 1024). */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '-';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Server timestamps may be ISO strings, Date objects or absent. */
export function formatTime(value: unknown): string {
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value !== 'string' || !value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** Short relative-ish label for the session rail (date + time when available). */
export function formatSessionTime(value: unknown): string {
  if (value instanceof Date) return value.toLocaleString();
  if (typeof value !== 'string' || !value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Status → semantic dot color; unknown states stay neutral (never invented). */
export function statusTone(status: string): 'success' | 'processing' | 'error' | 'warning' | 'default' {
  switch (status) {
    case 'succeeded':
    case 'completed':
    case 'granted':
    case 'approved':
      return 'success';
    case 'running':
    case 'pending':
    case 'streaming':
      return 'processing';
    case 'failed':
    case 'denied':
    case 'cancelled':
    case 'expired':
      return 'error';
    case 'waiting_input':
    case 'waiting_approval':
      return 'warning';
    default:
      return 'default';
  }
}

/** Derive a readable title from a session row that has no explicit title. */
export function sessionFallbackTitle(item: {
  title?: string | null;
  kind?: string | null;
  sessionId: string;
}): string {
  if (item.title && item.title.trim()) return item.title.trim();
  const kind = item.kind?.trim();
  return kind ? `${kind} · ${item.sessionId.slice(0, 8)}` : item.sessionId.slice(0, 8);
}

/** Compact ellipsis for previews that can be very long. */
export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Resolve (execId, name) from a backend artifact preview/download URL. */
export function parseArtifactUrl(
  artifact: { previewUrl?: string | null; downloadUrl?: string | null },
): { execId: string; name: string } | null {
  const url = artifact.previewUrl || artifact.downloadUrl;
  if (!url) return null;
  const match = url.match(/\/tasks\/executions\/([^/]+)\/artifacts\/([^/?#]+)/);
  if (!match) return null;
  return { execId: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) };
}
