export function parseStatusFilter(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((status) => status.trim())
    .filter((status) => status.length > 0);
}

export function formatStatusFilter(statuses: string[]): string | undefined {
  return statuses.length > 0 ? statuses.join(',') : undefined;
}

/** Select 的显示值：多选模式始终用数组（单态也需数组以显示标签）。 */
export function selectValueFor(statuses: string[]): string[] | undefined {
  return statuses.length > 0 ? statuses : undefined;
}
