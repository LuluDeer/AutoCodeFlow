import { rewritePackageUrlToAdminBase } from './admin-api-url';

/**
 * 2026-10-30 生产故障回归：packageUrl 同源改写。
 *
 * 现场：中台 `API_BASE_URL=https://<公网域名>`，而执行器都在同一局域网
 * （`ADMIN_API_URL=http://10.0.0.5:8088`）。admin 下发的 packageUrl 因此
 * 指向公网域名，执行器每次下包都要绕公网 VPS + frp 隧道回来，偶发
 * `Client network socket disconnected before secure TLS connection was
 * established` 被记成 `package_fetch_failed`。
 *
 * 断言矩阵：**该改的改、不该改的一个字节都不动**。
 */
describe('rewritePackageUrlToAdminBase', () => {
  const lanCfg = { adminApiUrl: 'http://10.0.0.5:8088' };
  const publicPkg =
    'https://acf.example.com/uploads/packages/app-1/abcdef0123/pkg-1.0.0.zip';

  it('局域网执行器：公网域名的 /uploads 包地址改写为内网基址', () => {
    expect(rewritePackageUrlToAdminBase(publicPkg, lanCfg)).toBe(
      'http://10.0.0.5:8088/uploads/packages/app-1/abcdef0123/pkg-1.0.0.zip',
    );
  });

  it('跨网执行器：ADMIN_API_URL 本身就是公网域名 → 恒等（不动）', () => {
    const cfg = { adminApiUrl: 'https://acf.example.com' };
    expect(rewritePackageUrlToAdminBase(publicPkg, cfg)).toBe(publicPkg);
  });

  it('保留查询串（签名 URL 场景）', () => {
    const withQuery = `${publicPkg}?token=abc&expires=123`;
    expect(rewritePackageUrlToAdminBase(withQuery, lanCfg)).toBe(
      `http://10.0.0.5:8088/uploads/packages/app-1/abcdef0123/pkg-1.0.0.zip?token=abc&expires=123`,
    );
  });

  it('非 /uploads 路径不改写（外链 / CDN / git 归档包）', () => {
    const external = 'https://cdn.example.com/releases/pkg.zip';
    expect(rewritePackageUrlToAdminBase(external, lanCfg)).toBe(external);
  });

  it('非 http(s) 协议不改写', () => {
    const fileUrl = 'file:///tmp/pkg.zip';
    expect(rewritePackageUrlToAdminBase(fileUrl, lanCfg)).toBe(fileUrl);
  });

  it('admin 基址为空 → 原样返回（不猜）', () => {
    expect(rewritePackageUrlToAdminBase(publicPkg, {})).toBe(publicPkg);
    expect(
      rewritePackageUrlToAdminBase(publicPkg, { adminApiUrl: '   ' }),
    ).toBe(publicPkg);
  });

  it('基址带 /api 后缀会被规范化掉（与 resolveAdminApiBaseUrl 同源）', () => {
    expect(
      rewritePackageUrlToAdminBase(publicPkg, {
        adminApiUrl: 'http://10.0.0.5:8088/api',
      }),
    ).toBe(
      'http://10.0.0.5:8088/uploads/packages/app-1/abcdef0123/pkg-1.0.0.zip',
    );
  });

  it('ADMIN_API_URL_EXTERNAL 优先于 internal（与回调/心跳同序）', () => {
    expect(
      rewritePackageUrlToAdminBase(publicPkg, {
        adminApiUrlExternal: 'http://10.0.0.9:8088',
        adminApiUrlInternal: 'http://10.0.0.5:8088',
      }),
    ).toBe(
      'http://10.0.0.9:8088/uploads/packages/app-1/abcdef0123/pkg-1.0.0.zip',
    );
  });

  it('非法 packageUrl 原样返回（交给 ssrf-guard 报错）', () => {
    expect(rewritePackageUrlToAdminBase('not a url', lanCfg)).toBe('not a url');
    expect(rewritePackageUrlToAdminBase('', lanCfg)).toBe('');
  });

  it('同源不产生无意义改写（协议+主机+端口一致）', () => {
    const sameOrigin = 'http://10.0.0.5:8088/uploads/packages/a/b/c.zip';
    expect(rewritePackageUrlToAdminBase(sameOrigin, lanCfg)).toBe(sameOrigin);
  });

  it('内容寻址路径逐字节保留（sha256 段不得被改动）', () => {
    const deep =
      'https://acf.example.com/uploads/packages/092aa483-e5df-4310-b487-0ac9db2d3f10/2b7358fa6d6f90e81e779f037a7c46f12ee5e90d46cdf1c491555f0b7473c13e/moxidefa-shouhoudingdan-1.0.0.zip';
    expect(rewritePackageUrlToAdminBase(deep, lanCfg)).toBe(
      'http://10.0.0.5:8088/uploads/packages/092aa483-e5df-4310-b487-0ac9db2d3f10/2b7358fa6d6f90e81e779f037a7c46f12ee5e90d46cdf1c491555f0b7473c13e/moxidefa-shouhoudingdan-1.0.0.zip',
    );
  });
});
