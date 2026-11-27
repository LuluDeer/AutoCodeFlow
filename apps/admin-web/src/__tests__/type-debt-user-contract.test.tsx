/**
 * TYPE-DEBT：用户真实消费的契约字段必须从生成 schema 派生，而不是靠本地扩展/
 * as 断言绕过；基线只允许因「派生成功」或「有证据证明未消费」而收缩。
 *
 * 这里用源码级不变量 + 类型化字面量读取钉住三域（User / ExecutorPackage /
 * Application）的派生口径，防止后续再把字段抄回本地 interface 或重新加断言。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { User } from '../api/users';
import type { ExecutorPackage } from '../api/executor-packages';
import type { Application } from '../api/applications';
import type { AuthUser } from '../store/auth';

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

const usersSource = read('../api/users.ts');
const userPageSource = read('../pages/UserManagementPage.tsx');
const authStoreSource = read('../store/auth.ts');
const settingsSource = read('../pages/settings/SecuritySettings.tsx');
const packagesSource = read('../api/executor-packages.ts');
const packagesPageSource = read('../pages/ExecutorPackagesPage.tsx');
const applicationsSource = read('../api/applications.ts');
const baseline = JSON.parse(
  read('../../../../scripts/web-type-field-drift-baseline.json'),
) as {
  drift: Array<{ key: string; reason: string }>;
  notPairs: Array<{ key: string; reason: string }>;
};

const derived = (source: string, field: string, schema: string, dto: string) =>
  source.includes(
    `${field}?: components['schemas']['${schema}']['${field}']`,
  ) && source.includes(schema) && source.includes(dto);

describe('type-debt：契约字段派生回生成 schema', () => {
  it('User.isActive / totpEnabled 从 UserResponseDto 派生，页面无本地重复声明', () => {
    expect(derived(usersSource, 'isActive', 'UserResponseDto', 'isActive')).toBe(true);
    expect(derived(usersSource, 'totpEnabled', 'UserResponseDto', 'totpEnabled')).toBe(true);
    expect(userPageSource).not.toContain('interface UserWithActive');
    expect(userPageSource).toContain("dataIndex: 'isActive'");
    expect(userPageSource).toContain('user.isActive !== false');
  });

  it('AuthUser.totpEnabled 从生成 schema 派生，安全设置页不再用 as 断言', () => {
    expect(authStoreSource).toContain(
      "totpEnabled?: components['schemas']['UserResponseDto']['totpEnabled'];",
    );
    expect(authStoreSource).not.toContain('(user as { totpEnabled?: boolean })');
    expect(settingsSource).not.toContain('as { totpEnabled?: boolean }');
    expect(settingsSource).toContain('user?.totpEnabled === true');
  });

  it('ExecutorPackage 的上传者/原始文件名等列派生，包表删除 PkgRow 重复声明', () => {
    for (const field of [
      'description', 'filename', 'mimeType', 'originalFilename',
      'projectId', 'pushHistory', 'uploadedBy',
    ]) {
      expect(packagesSource).toContain(
        `${field}?: components['schemas']['ExecutorPackageResponseDto']['${field}'];`,
      );
    }
    expect(packagesPageSource).not.toContain('interface PkgRow');
    expect(packagesPageSource).toContain("import type { ExecutorPackage } from '../api/executor-packages';");
    expect(packagesPageSource).toContain("dataIndex: 'uploadedBy'");
    expect(packagesPageSource).toContain('pkg.originalFilename');
  });

  it('Application 归属字段按 tasks.ts 先例派生', () => {
    for (const field of ['ownerUserId', 'packageUrl', 'projectId', 'webhookSecret']) {
      expect(applicationsSource).toContain(
        `${field}?: components['schemas']['ApplicationResponseDto']['${field}'];`,
      );
    }
  });

  it('类型化读取无需本地扩展或断言', () => {
    const user: User = {
      id: 1, username: 'admin', email: 'a@b.c', role: 'admin',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      isActive: false, totpEnabled: true,
    };
    const auth: AuthUser = { id: 1, username: 'admin', totpEnabled: true };
    const pkg: ExecutorPackage = {
      id: 'p', name: 'pkg', version: '1.0.0', type: 'node', platform: 'linux',
      fileSize: 12, checksum: 'abc', changelog: '', status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      uploadedBy: 'alice', originalFilename: 'pkg.zip',
    };
    const app: Application = {
      id: 'a', name: 'app', version: '1', runtime: 'node', status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      ownerUserId: 7, projectId: null, webhookSecret: 'secret', packageUrl: 'https://example.test/a.zip',
    };
    expect([user.isActive, user.totpEnabled, auth.totpEnabled]).toEqual([false, true, true]);
    expect([pkg.uploadedBy, pkg.originalFilename]).toEqual(['alice', 'pkg.zip']);
    expect([app.ownerUserId, app.projectId, app.webhookSecret]).toEqual([7, null, 'secret']);
  });

  it('22 条已处置 key 全部从基线移除（drift / notPairs 均不得复活）', () => {
    const keys = new Set(
      [...baseline.drift, ...baseline.notPairs].map((e) => e.key),
    );
    const disposed = [
      'apps/admin-web/src/api/users.ts\tUser\tmissing:isActive',
      'apps/admin-web/src/api/users.ts\tUser\tmissing:totpEnabled',
      'apps/admin-web/src/api/users.ts\tUser\tmissing:lastTotpCounter',
      'apps/admin-web/src/api/users.ts\tUser\tmissing:lockedUntil',
      'apps/admin-web/src/api/users.ts\tUser\tmissing:loginFailCount',
      'apps/admin-web/src/api/users.ts\tUser\tmissing:sessionVersion',
      'apps/admin-web/src/api/executor-packages.ts\tExecutorPackage\tmissing:description',
      'apps/admin-web/src/api/executor-packages.ts\tExecutorPackage\tmissing:filename',
      'apps/admin-web/src/api/executor-packages.ts\tExecutorPackage\tmissing:mimeType',
      'apps/admin-web/src/api/executor-packages.ts\tExecutorPackage\tmissing:originalFilename',
      'apps/admin-web/src/api/executor-packages.ts\tExecutorPackage\tmissing:projectId',
      'apps/admin-web/src/api/executor-packages.ts\tExecutorPackage\tmissing:pushHistory',
      'apps/admin-web/src/api/executor-packages.ts\tExecutorPackage\tmissing:uploadedBy',
      'apps/admin-web/src/api/applications.ts\tApplication\tmissing:ownerUserId',
      'apps/admin-web/src/api/applications.ts\tApplication\tmissing:packageUrl',
      'apps/admin-web/src/api/applications.ts\tApplication\tmissing:projectId',
      'apps/admin-web/src/api/applications.ts\tApplication\tmissing:webhookSecret',
      'apps/admin-web/src/api/executor-packages.ts\tExecutorPackage\textra:changelog',
      'apps/admin-web/src/api/applications.ts\tAppReleaseRow\textra:createdAt',
      'apps/admin-web/src/api/applications.ts\tAppReleaseRow\textra:sourceDeploymentId',
      'apps/admin-web/src/api/applications.ts\tAppReleaseRow\textra:status',
      'apps/admin-web/src/api/applications.ts\tAppReleaseRow\textra:synthetic',
    ];
    expect(disposed).toHaveLength(22);
    const stillPresent = disposed.filter((k) => keys.has(k));
    expect(
      stillPresent,
      `以下已处置 key 仍留在基线里（禁止把已处置条目加回 drift）：\n${stillPresent.join('\n')}`,
    ).toEqual([]);
  });
});
