/**
 * 私有仓库安装命令基址（2026-10-23）。
 *
 * 关键事实（改动前先查过两份 nginx 配置）：`/pypi/` 与 `/npm/` 反代挂在
 * **admin-web 的 nginx** 上（`apps/admin-web/nginx.conf` 的
 * `location ^~ /pypi/` / `^~ /npm/`），与 SPA 同源；**admin-api 不提供这两个
 * 路由**。所以默认基址必须是 `window.location.origin`，
 * 只有「仓库另挂主机」或「前端由 CDN 托管」时，才需要 VITE_REGISTRY_BASE_URL。
 */
import { describe, it, expect } from 'vitest';
import { resolveRegistryBase } from '../registry-base';

describe('resolveRegistryBase', () => {
  it('无显式配置 → origin（标准部署：/pypi 与 /npm 就在这台 nginx 上）', () => {
    expect(resolveRegistryBase('http://localhost:8088', '')).toBe('http://localhost:8088');
    expect(resolveRegistryBase('https://acf.example.com', '')).toBe(
      'https://acf.example.com',
    );
  });

  it('去掉 origin 的尾斜杠（避免拼出 //pypi/simple/）', () => {
    expect(resolveRegistryBase('http://localhost:8088/', '')).toBe(
      'http://localhost:8088',
    );
  });

  it('显式 VITE_REGISTRY_BASE_URL 覆盖 origin（仓库另挂主机 / CDN 托管前端）', () => {
    expect(
      resolveRegistryBase('https://acf.example.com', 'https://registry.example.com/'),
    ).toBe('https://registry.example.com');
  });

  it('显式值里的空白被裁掉（构建期环境变量常见尾随空格）', () => {
    expect(
      resolveRegistryBase('https://acf.example.com', '  https://registry.example.com  '),
    ).toBe('https://registry.example.com');
  });

  it('显式值为空串/纯空白 → 视为未设置，回落 origin', () => {
    expect(resolveRegistryBase('https://acf.example.com', '   ')).toBe(
      'https://acf.example.com',
    );
  });

  it('拼出来的命令形态自证', () => {
    const base = resolveRegistryBase('http://localhost:8088', '');
    expect(`${base}/pypi/simple/`).toBe('http://localhost:8088/pypi/simple/');
    expect(`${base}/npm/`).toBe('http://localhost:8088/npm/');
  });
});
