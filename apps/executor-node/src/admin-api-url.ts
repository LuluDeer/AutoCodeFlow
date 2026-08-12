export function normalizeAdminApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('/api') ? trimmed.slice(0, -'/api'.length) : trimmed;
}

export function buildAdminApiUrl(baseUrl: string, path: string): string {
  const normalizedBase = normalizeAdminApiBaseUrl(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}
