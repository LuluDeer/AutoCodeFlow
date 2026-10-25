/**
 * FEAT-05（UI 半场）：字节数 → 人类可读大小（B / KB / MB / GB / TB，各留一位小数）。
 * 独立 util（不与组件同文件），供 ArtifactsList 展示产物体积；纯函数便于单测。
 * F-15（UIAUDIT P3-8）：补 TB 档——此前封顶 GB，1024.0 GB 可读性差
 * （执行器包累计/产物大文件可达 TB 级）。
 */
export function formatArtifactSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}
