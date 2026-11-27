/**
 * impl-apprelease-contract：前端发布行契约定向测试。
 *
 * 验收级别：单测（类型守卫 + 纯函数）。钉住：
 *   · AppReleaseRow 从生成 AppReleaseRowDto 派生（不是手写字段副本）；
 *   · sourceDeploymentId/status/createdAt/synthetic 仍以非空形状可消费；
 *   · 深链 hit-key 仍能靠 sourceDeploymentId 命中发布行。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AppReleaseRow } from '../api/applications';
import {
  findDeployLocatorMatch,
  getVersionKey,
} from '../pages/application-detail/deploy-deeplink';

const contractRow: AppReleaseRow = {
  id: 'ver-contract-1',
  version: '1.2.0',
  packageUrl: 'https://pkg.example/1.2.0.zip',
  gitCommit: 'abc123',
  deployedAt: '2026-11-27T02:03:04.000Z',
  latestDeploymentId: 'dep-latest-1',
  deploymentStatus: 'running',
  deploymentCount: 2,
  executorAddress: '10.0.0.9:3002',
  runMode: 'daemon',
  triggerType: 'manual',
  operator: 'bob',
  operatorSource: 'deployments.operator',
  operatorMissingReason: '',
  sourceDeploymentId: 'dep-source-1',
  status: 'deploying',
  createdAt: '2026-11-27T01:02:03.000Z',
  synthetic: false,
};

describe('AppReleaseRow 生成契约派生（impl-apprelease-contract）', () => {
  it('四字段保持 UI 可消费的精确类型', () => {
    expectTypeOf<AppReleaseRow['sourceDeploymentId']>().toEqualTypeOf<string | null>();
    expectTypeOf<AppReleaseRow['status']>().toEqualTypeOf<string>();
    expectTypeOf<AppReleaseRow['createdAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<AppReleaseRow['synthetic']>().toEqualTypeOf<boolean>();

    expect(contractRow).toMatchObject({
      sourceDeploymentId: 'dep-source-1',
      status: 'deploying',
      createdAt: '2026-11-27T01:02:03.000Z',
      synthetic: false,
    });
  });

  it('声明体引用生成 schema，不再手抄后端字段', () => {
    const src = readFileSync('src/api/applications.ts', 'utf8');
    const start = src.indexOf('export interface AppReleaseRow');
    const end = src.indexOf('export interface AppReleasesPage', start);
    const decl = src.slice(start, end);
    const aliasStart = src.indexOf('type AppReleaseRowGenerated');

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(aliasStart).toBeGreaterThan(-1);
    expect(src.slice(aliasStart, src.indexOf(';', aliasStart))).toContain(
      "components['schemas']['AppReleaseRowDto']",
    );
    expect(decl).toContain('extends AppReleaseRowGenerated');
    // 旧手写字面量（triggerType 收紧 / operatorSource 单值）已随接口一起移除。
    expect(decl).not.toContain("triggerType: 'upgrade' | 'manual' | 'unknown' | null");
    expect(decl).not.toContain("operatorSource: 'application_versions.createdBy'");
  });

  it('sourceDeploymentId 仍在深链命中白名单中，字段不丢', () => {
    const hit = findDeployLocatorMatch([contractRow], {
      deploymentId: 'dep-source-1',
      version: null,
      matched: true,
    });
    expect(hit).toBe(getVersionKey(contractRow));
    expect(hit).toBe(contractRow.id);
  });
});
