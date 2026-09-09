/**
 * FEAT-05（UI 半场）：字节数 → 人类可读大小（B / KB / MB / GB，各留一位小数）。
 * 独立 util（不与组件同文件），供 ArtifactsList 展示产物体积；纯函数便于单测。
 */
export function formatArtifactSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}
