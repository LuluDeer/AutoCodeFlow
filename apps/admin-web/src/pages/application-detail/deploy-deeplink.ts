/**
 * 部署定位深链（中台侧）：桌面复制的 `?tab=releases&deploymentId=<uuid>&version=<v>`
 * 解析与版本行命中判定。纯函数、零 IO：非法/缺失参数中性降级——不高亮不滚动，
 * `?tab=` 的归一化仍由页面既有逻辑负责。
 */
import type { AppReleaseRow } from '../../api/applications';

export interface DeployLocatorTarget {
  deploymentId: string | null;
  version: string | null;
  /** 至少一个合法定位键；false 时页面不得高亮/滚动。 */
  matched: boolean;
}

/** 与 SOP `ASSIGNMENT_UUID_SHAPE` 同款保守形状校验（后端 id 为 UUID）。 */
const DEPLOYMENT_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeDeploymentId(raw: string | null): string | null {
  return raw && DEPLOYMENT_UUID_SHAPE.test(raw) ? raw : null;
}

function normalizeVersion(raw: string | null): string | null {
  const v = raw?.trim();
  return v && v !== '—' ? v : null;
}

/** 解析深链查询参数；解码由 URLSearchParams 完成，这里只做形状校验。 */
export function resolveDeployLocator(searchParams: URLSearchParams): DeployLocatorTarget {
  const deploymentId = normalizeDeploymentId(searchParams.get('deploymentId')?.trim() || null);
  const version = normalizeVersion(searchParams.get('version'));
  return { deploymentId, version, matched: Boolean(deploymentId || version) };
}

export type DeployKeyRow = {
  id?: string | null;
  deploymentId?: string | null;
  latestDeploymentId?: string | null;
  sourceDeploymentId?: string | null;
  version?: string | null;
  commit?: string | null;
  createdAt?: string | null;
  deployedAt?: string | null;
};

/** 与页面既有 getVersionKey 同一口径，兼容发布行的 latestDeploymentId / sourceDeploymentId。 */
export function getVersionKey(record: DeployKeyRow): string {
  return record.id ?? record.deploymentId ?? record.latestDeploymentId ?? record.sourceDeploymentId ?? `${record.version ?? 'unknown'}-${record.commit ?? 'none'}-${record.createdAt ?? record.deployedAt ?? 'unknown'}`;
}

export const DEPLOY_HIT_CLASS = 'app-release-deploy-hit';

/** 命中行的 DOM 锚点，供 `scrollToSectionWhenReady` 精准滚动。 */
export function deploymentRowDomId(value: string): string {
  return `app-release-deploy-${value}`;
}

function rowDeploymentIds(row: DeployKeyRow): (string | null | undefined)[] {
  return [row.deploymentId, row.latestDeploymentId, row.sourceDeploymentId, row.id];
}

/**
 * 命中键 = 目标行的稳定 rowKey。deploymentId 优先、version 其次：
 * id 给了但本页没匹配行时仍允许按 version 命中（桌面复制的是当时部署行，
 * 版本行聚合后 latestDeploymentId 可能已前移）。
 */
export function findDeployLocatorMatch(
  rows: readonly AppReleaseRow[],
  target: DeployLocatorTarget,
): string | null {
  if (!target.matched) return null;
  const byId = target.deploymentId
    ? rows.find((r) => rowDeploymentIds(r).includes(target.deploymentId))
    : undefined;
  const row = byId ?? (target.version ? rows.find((r) => r.version === target.version) : undefined);
  return row ? getVersionKey(row) : null;
}

/** 表格行属性：仅命中行带锚点 id + 高亮 class + 行背景，其余行原样返回空对象。 */
export function deployRowProps(row: AppReleaseRow, hitKey: string | null, highlightBg?: string) {
  if (!hitKey || getVersionKey(row) !== hitKey) return {};
  return {
    id: deploymentRowDomId(hitKey),
    className: DEPLOY_HIT_CLASS,
    style: highlightBg ? { background: highlightBg } : undefined,
  };
}
