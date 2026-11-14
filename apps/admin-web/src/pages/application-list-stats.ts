import type { Application, AppDeploymentStats } from '../api/applications';

/**
 * 应用列表行（主列表 + 聚合统计合并后的形状）。
 *
 * P1-8（2026-11-15 评审）：主列表与辅助统计解耦后，stats 端点可能单独失败。
 * `statsAvailable` 标记该行统计是否来自真实聚合数据；false 时统计列必须显示
 * 「暂不可用」，**不得**把未取到的统计静默渲染成「暂无部署 / 0 台」这种假成功。
 */
export interface AppWithStats extends Application {
  /** 聚合统计是否成功取到；false = 统计暂不可用（失败/未加载完） */
  statsAvailable: boolean;
  runningCount: number;
  failedCount: number;
  totalDeployments: number;
  lastDeployedAt: string | null;
}

/**
 * 把主列表与聚合统计按 applicationId 合并。
 *
 * @param apps 主列表行（applicationsApi.list）
 * @param stats 聚合统计行；`null` = 统计未取到（失败或首屏尚未返回）。
 *   传空数组 `[]` 表示统计已取到、只是没有任何部署行（与旧口径一致回落 0/null）。
 *
 * 未取到时行内数字字段给中性 0/null 占位，但 `statsAvailable=false` 把「不可信」
 * 显式传给渲染层——占位值只存在于内存，绝不能被渲染成成功口径。
 */
export function mergeAppsWithStats(
  apps: Application[],
  stats: AppDeploymentStats[] | null,
): AppWithStats[] {
  const statsByApp = new Map((stats ?? []).map((s) => [s.applicationId, s]));
  return apps.map((app) => {
    const s = statsByApp.get(app.id);
    return {
      ...app,
      statsAvailable: stats !== null,
      runningCount: s?.running ?? 0,
      failedCount: s?.failed ?? 0,
      totalDeployments: s?.total ?? 0,
      lastDeployedAt: s?.lastDeployedAt ?? null,
    };
  });
}

/**
 * 从 stats 接口的 reject 值里提取**可折叠的技术详情**（HTTP 状态 / 请求路径 /
 * 原始消息）。纯函数，便于单测钉住「原始 URL、技术串只进技术详情，不进主文案」。
 *
 * reject 形态（见 api/client.ts 响应拦截器）：
 *  · 有响应：`err.response?.data`（envelope 对象，挂 `__status`）；
 *  · 网络层失败：原始 axios Error（带 `config.url` / `message`）。
 */
export function describeStatsError(err: unknown): string {
  const parts: string[] = [];

  const status =
    (err as { __status?: unknown } | null)?.__status ??
    (err as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status === 'number' && Number.isFinite(status)) {
    parts.push(`HTTP ${status}`);
  }

  const url =
    (err as { config?: { url?: unknown } } | null)?.config?.url ??
    (err as { response?: { config?: { url?: unknown } } } | null)?.response?.config?.url;
  if (typeof url === 'string' && url.trim()) parts.push(url.trim());

  const rawMessage =
    (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message ??
    (err as { message?: unknown } | null)?.message;
  if (typeof rawMessage === 'string' && rawMessage.trim()) parts.push(rawMessage.trim());

  return parts.join(' · ');
}
