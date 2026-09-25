/**
 * NETOPT-4：回调落盘原子化（tmp → rename）回归。
 *
 * 此前 persistFailedCallbacks 直接 writeFileSync 目标文件：kill -9 / ENOSPC /
 * 断电留下半写主文件，重发循环 JSON.parse 抛 SyntaxError → dead letter
 * （poison=true），对账救回有 !item.poison 门——半写即整批（≤100 条）真实终态
 * 永久丢。对齐 python 侧（routers/execute.py 的 .tmp + rename）后：
 *  - 写盘序列必须是「先写 `<目标>.tmp`，再 rename 到位」；
 *  - 写失败（ENOSPC）/rename 失败不得留下半写主文件或孤儿 .tmp。
 *
 * 拦截方式：Node ≥20 的核心 fs 模块属性不可重定义（jest.spyOn 直接报
 * "Cannot redefine property"），因此用 jest.mock('fs') 返回 actual 的 Proxy，
 * 按测试覆写 writeFileSync / renameSync 两个属性（名字须以 mock 开头，
 * babel-plugin-jest-hoist 才允许在工厂里引用）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type CallbackModule = typeof import('./callback');

let mockFsWrite: typeof fs.writeFileSync | null = null;
let mockFsRename: typeof fs.renameSync | null = null;

// 真实 fs（requireActual 拿到的底层单例）——覆写 wrapper 内回调它完成真实
// 落盘；绝不能调本文件顶部的 fs（那会经下方 Proxy 再次命中覆写 → 无限递归）。
const realFs = jest.requireActual('fs') as typeof fs;

jest.mock('fs', () => {

  const actual = jest.requireActual('fs') as typeof fs;
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'writeFileSync' && mockFsWrite) return mockFsWrite;
      if (prop === 'renameSync' && mockFsRename) return mockFsRename;
      return Reflect.get(target, prop);
    },
  });
});

jest.mock('./admin-client');

function loadCallbackModule(mockWorkDir: string): CallbackModule {
  jest.resetModules();
  jest.doMock('./config', () => ({
    config: {
      workDir: mockWorkDir,
      executorAddress: 'internal-executor:8002',
      executorAddressPublic: 'public-executor:8002',
    },
  }));
  jest.doMock('./logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));

  return require('./callback') as CallbackModule;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('callbacks atomic persistence (NETOPT-4)', () => {
  let cb: CallbackModule;
  let dir: string;
  let post: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-atomic-persist-'));
    cb = loadCallbackModule(dir);
    post = (jest.requireMock('./admin-client') as { post: jest.Mock }).post;
    post.mockReset();
  });

  afterEach(async () => {
    const stopping = cb.stopCallbackThread();
    await jest.advanceTimersByTimeAsync(10_000);
    await stopping;
    jest.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
    mockFsWrite = null;
    mockFsRename = null;
  });

  function callbackDir(): string {
    return path.join(dir, 'callbacks');
  }

  function jsonFiles(sub: string = ''): string[] {
    const target = sub ? path.join(callbackDir(), sub) : callbackDir();
    return fs.existsSync(target)
      ? fs.readdirSync(target).filter((f) => f.endsWith('.json')).sort()
      : [];
  }

  function tmpFiles(): string[] {
    return fs.existsSync(callbackDir())
      ? fs.readdirSync(callbackDir()).filter((f) => f.endsWith('.tmp')).sort()
      : [];
  }

  /** 触发 persist 路径：post 挂起（drain 等到硬截止）→ 落盘。 */
  async function triggerPersist(): Promise<void> {
    const flight = deferred<{ status: number }>();
    post.mockReturnValueOnce(flight.promise);
    cb.pushCallback({ executionId: 'exec-1', status: 'success' });
    cb.startCallbackThread();
    const stopping = cb.stopCallbackThread();
    await jest.advanceTimersByTimeAsync(10_000);
    await stopping;
  }

  it('persist 走 tmp→rename 序列：先写 <目标>.tmp 再 rename 到位，完成后不留 .tmp', async () => {
    // 统一事件日志：write/rename 各记一条，用于断言「同目标 tmp 写入先于 rename」
    const events: Array<{ op: 'write' | 'rename'; target: string; tmp: string }> = [];
    mockFsWrite = ((p: fs.PathOrFileDescriptor, data: unknown, opts?: unknown) => {
      const s = String(p);
      if (s.startsWith(callbackDir())) {
        events.push({ op: 'write', target: s.endsWith('.tmp') ? s.slice(0, -'.tmp'.length) : s, tmp: s });
      }
      return (realFs.writeFileSync as unknown as (...a: unknown[]) => void)(p, data, opts);
    }) as unknown as typeof fs.writeFileSync;
    mockFsRename = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).startsWith(callbackDir())) {
        events.push({ op: 'rename', target: String(to), tmp: String(from) });
      }
      return (realFs.renameSync as unknown as (...a: unknown[]) => void)(from, to);
    }) as unknown as typeof fs.renameSync;

    await triggerPersist();

    // 最终文件存在（payload + .meta）；目录里没有 .tmp 残留
    expect(jsonFiles()).toHaveLength(1);
    expect(jsonFiles()[0]).toMatch(/^callback-\d+-\d+\.json$/);
    expect(fs.existsSync(path.join(callbackDir(), `${jsonFiles()[0]}.meta`))).toBe(true);
    expect(tmpFiles()).toEqual([]);

    // payload 与 .meta 各自「先写 <目标>.tmp、后 rename」；rename 源 = 目标 + .tmp
    const payloadPath = path.join(callbackDir(), jsonFiles()[0]);
    for (const target of [payloadPath, `${payloadPath}.meta`]) {
      const writeIdx = events.findIndex((e) => e.op === 'write' && e.target === target);
      const renameIdx = events.findIndex((e) => e.op === 'rename' && e.target === target);
      expect(writeIdx).toBeGreaterThanOrEqual(0);
      expect(renameIdx).toBeGreaterThanOrEqual(0);
      expect(writeIdx).toBeLessThan(renameIdx);
      const rename = events[renameIdx];
      expect(rename.tmp).toBe(`${target}.tmp`);
    }
  });

  it('注入 ENOSPC（写 payload tmp 失败）：不留半写主文件，tmp 被清理，进程不崩', async () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    mockFsWrite = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(p).endsWith('.json.tmp') && String(p).startsWith(callbackDir())) {
        throw enospc;
      }
      return (realFs.writeFileSync as unknown as (...a: unknown[]) => void)(p, ...rest);
    }) as unknown as typeof fs.writeFileSync;

    await expect(triggerPersist()).resolves.toBeUndefined();

    // 主文件不存在（半写文件不会顶替真实备份位）
    expect(jsonFiles()).toEqual([]);
    // tmp 被失败路径清理，无孤儿
    expect(tmpFiles()).toEqual([]);
  });

  it('注入 ENOSPC（写 .meta tmp 失败）：payload 完好，无 tmp 孤儿', async () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    mockFsWrite = ((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(p).endsWith('.json.meta.tmp') && String(p).startsWith(callbackDir())) {
        throw enospc;
      }
      return (realFs.writeFileSync as unknown as (...a: unknown[]) => void)(p, ...rest);
    }) as unknown as typeof fs.writeFileSync;

    await expect(triggerPersist()).resolves.toBeUndefined();

    expect(jsonFiles()).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(callbackDir(), jsonFiles()[0]), 'utf8')) as unknown[],
    ).toHaveLength(1);
    expect(tmpFiles()).toEqual([]);
  });

  it('注入 rename 失败：不留半写主文件，tmp 被清理', async () => {
    mockFsRename = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).endsWith('.json.tmp') && String(from).startsWith(callbackDir())) {
        throw Object.assign(new Error('EXDEV: invalid cross-device link'), { code: 'EXDEV' });
      }
      return (realFs.renameSync as unknown as (...a: unknown[]) => void)(from, to);
    }) as unknown as typeof fs.renameSync;

    await expect(triggerPersist()).resolves.toBeUndefined();

    expect(jsonFiles()).toEqual([]);
    expect(tmpFiles()).toEqual([]);
  });
});
