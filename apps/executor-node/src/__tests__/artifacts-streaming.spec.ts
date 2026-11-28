/**
 * Wave 1 Slice 6 (w1-executors-parity) — executor-node artifacts 修复回归。
 *
 * 覆盖 SAFE_EXECUTION_ID_RE、流式 multipart 上传（无 readFileSync/Blob 尖峰）、
 * 401 自愈 + 备用 admin 地址 failover。不导入 src/main.ts。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 本文件位于 src/__tests__/，真实模块在 src/ 下：mock 路径必须与第 25-27 行的
// import 同构（`../`），否则 Jest 把它当作 src/__tests__/admin-client 这个不存在的
// 模块，整份 suite 直接 red（CI run 46136854131）。
jest.mock('../admin-client', () => ({
  getCurrentAdminUrl: jest.fn(() => 'http://primary:3105'),
  getAllAdminUrls: jest.fn(() => ['http://primary:3105', 'http://backup:3105']),
  failover: jest.fn(),
  initAdminClients: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({
  getCurrentToken: jest.fn(async () => 'tok'),
  forceTokenRefresh: jest.fn(async () => null),
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { artifactsDirFor, gatherArtifacts, isSafeExecutionId, SAFE_EXECUTION_ID_RE } from '../artifacts';
import { failover } from '../admin-client';
import { forceTokenRefresh } from '../middleware/auth';

function writeArt(dir: string, name: string, data: Buffer): void {
  const a = artifactsDirFor(dir);
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, name), data);
}

describe('artifacts executionId 白名单', () => {
  it('拒绝路径分隔符 / 查询串 / fragment', () => {
    expect(SAFE_EXECUTION_ID_RE.test('exec-1')).toBe(true);
    expect(isSafeExecutionId('../bad')).toBe(false);
    expect(isSafeExecutionId('x?y')).toBe(false);
    expect(isSafeExecutionId('x#frag')).toBe(false);
    expect(isSafeExecutionId('')).toBe(false);
  });

  it('非法 executionId 不触发任何 fetch', async () => {
    const fetchMock = jest.fn();
    const orig = global.fetch;
    (global as any).fetch = fetchMock;
    try {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-art-id-'));
      writeArt(tmp, 'a.txt', Buffer.from('x'));
      expect(await gatherArtifacts('../bad', tmp, 'http://primary:3105', 'tok')).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
      fs.rmSync(tmp, { recursive: true, force: true });
    } finally {
      (global as any).fetch = orig;
    }
  });
});

describe('artifacts 流式上传', () => {
  let tmp: string;
  let origFetch: typeof global.fetch;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-art-stream-'));
    origFetch = global.fetch;
    jest.clearAllMocks();
  });
  afterEach(() => {
    (global as any).fetch = origFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('body 是 Web ReadableStream（非 Blob/Buffer），带 multipart boundary 与 duplex', async () => {
    writeArt(tmp, 'a.txt', Buffer.from('stream-payload'));
    const calls: any[] = [];
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      calls.push(init);
      return { ok: true, status: 200 };
    });
    const manifest = await gatherArtifacts('exec-1', tmp, 'http://primary:3105', 'tok');
    expect(manifest).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const init = calls[0];
    expect(init.duplex).toBe('half');
    expect(String(init.headers['Content-Type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(typeof (init.body as any).getReader).toBe('function'); // Web ReadableStream
    expect((init.body as any)).not.toBeInstanceOf(Blob);
  });

  it('401 → forceTokenRefresh 后原地址重试一次', async () => {
    writeArt(tmp, 'a.txt', Buffer.from('x'));
    const urls: string[] = [];
    let first = true;
    (global as any).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      if (first) {
        first = false;
        return { ok: false, status: 401 };
      }
      return { ok: true, status: 200 };
    });
    (forceTokenRefresh as jest.Mock).mockResolvedValueOnce('fresh-token');
    const manifest = await gatherArtifacts('exec-1', tmp, 'http://primary:3105', 'tok');
    expect(manifest).toHaveLength(1);
    expect(forceTokenRefresh).toHaveBeenCalledTimes(1);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]); // 原地址重试
  });

  it('主地址失败 → failover 到备用 admin', async () => {
    writeArt(tmp, 'a.txt', Buffer.from('x'));
    const urls: string[] = [];
    (global as any).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      return url.includes('primary') ? { ok: false, status: 500 } : { ok: true, status: 200 };
    });
    (forceTokenRefresh as jest.Mock).mockResolvedValue(null);
    const manifest = await gatherArtifacts('exec-1', tmp, 'http://primary:3105', 'tok');
    expect(manifest).toHaveLength(1);
    expect(urls.some((u) => u.includes('backup'))).toBe(true);
    expect(failover).toHaveBeenCalled();
  });

  it('确定性 4xx 不 failover', async () => {
    writeArt(tmp, 'a.txt', Buffer.from('x'));
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 400 }));
    const manifest = await gatherArtifacts('exec-1', tmp, 'http://primary:3105', 'tok');
    expect(manifest).toEqual([]);
    expect(failover).not.toHaveBeenCalled();
  });
});
