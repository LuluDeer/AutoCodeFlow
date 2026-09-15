import request from 'supertest';
import express from 'express';
import * as http from 'http';
import * as os from 'os';

const mockConfig = {
  adminApiUrl: 'http://admin-public:3105',
  adminApiUrlInternal: 'http://admin-internal:3105',
  appName: 'test-executor',
  executorAddress: 'localhost:3002',
  maxConcurrentTasks: 10,
  token: 'test-token',
};

jest.mock('../config', () => ({ config: mockConfig }));
// A3: 就绪用例要把内存水位钉死（`os.freemem` 与 `os.cpus` 一样不可重定义，
// jest.spyOn 会抛 "Cannot redefine property"），否则 ready/503 会随 CI 机器
// 内存水位随机翻转。固定为「已用 10%」，远低于就绪阈值 90%。
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, freemem: () => actual.totalmem() * 0.9 };
});
jest.mock('../scheduler', () => ({ runningCount: jest.fn(() => 0) }));
jest.mock('../task-worker', () => ({
  taskWorkerManager: {
    getStats: jest.fn(() => ({ idle: true })),
  },
}));

import {
  buildAdminHealthPath,
  buildAdminHealthRequestOptions,
  checkAdminApi,
  healthRouter,
  resetCpuSampleForTest,
  sampleCpuPercent,
} from './health';
// A3-C：就绪出参契约用生成的 schema 现校验
import { HealthReadyResponseSchema } from '../generated/protocol.schemas';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('health route admin API probing', () => {
  let server: http.Server | undefined;
  let requestedPaths: string[];

  beforeEach(() => {
    requestedPaths = [];
    mockConfig.adminApiUrl = 'http://admin-public:3105';
    mockConfig.adminApiUrlInternal = 'http://admin-internal:3105';
    mockConfig.token = 'test-token';
    delete process.env.EXECUTOR_SHARED_TOKEN;
    delete process.env.EXECUTOR_SECRET;
  });

  afterEach(async () => {
    delete process.env.EXECUTOR_SHARED_TOKEN;
    delete process.env.EXECUTOR_SECRET;
    if (server) {
      await close(server);
      server = undefined;
    }
  });

  it('builds a single /api/health path for service-root and /api base URLs', () => {
    expect(buildAdminHealthPath(new URL('http://admin:3105'))).toBe('/api/health');
    expect(buildAdminHealthPath(new URL('http://admin:3105/'))).toBe('/api/health');
    expect(buildAdminHealthPath(new URL('http://admin:3105/api/'))).toBe('/api/health');
    expect(buildAdminHealthPath(new URL('http://admin:3105/base'))).toBe('/base/api/health');
  });

  it('builds HTTPS request options with the default 443 port', () => {
    expect(buildAdminHealthRequestOptions(new URL('https://admin-internal.example.com'))).toEqual(
      expect.objectContaining({
        hostname: 'admin-internal.example.com',
        port: 443,
        path: '/api/health',
        method: 'GET',
      }),
    );
  });

  it('checks the internal admin API URL before the public URL', async () => {
    server = http.createServer((req, res) => {
      requestedPaths.push(req.url || '');
      res.statusCode = 200;
      res.end('ok');
    });
    const port = await listen(server);
    mockConfig.adminApiUrl = 'http://admin-public.invalid:3105';
    mockConfig.adminApiUrlInternal = `http://127.0.0.1:${port}/api/`;

    await expect(checkAdminApi()).resolves.toBe(true);

    expect(requestedPaths).toEqual(['/api/health']);
  });

  it('reports tokenValid from runtime executor token env', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    const port = await listen(server);
    mockConfig.adminApiUrlInternal = `http://127.0.0.1:${port}`;
    mockConfig.token = '';
    process.env.EXECUTOR_SECRET = 'legacy-token';

    const app = express();
    app.use('/', healthRouter);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.tokenValid).toBe(true);
  });

  it('reports adminApiReachable on GET /health', async () => {
    server = http.createServer((req, res) => {
      requestedPaths.push(req.url || '');
      res.statusCode = 200;
      res.end('ok');
    });
    const port = await listen(server);
    mockConfig.adminApiUrlInternal = `http://127.0.0.1:${port}`;

    const app = express();
    app.use('/', healthRouter);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.adminApiReachable).toBe(true);
    expect(res.body.appName).toBe('test-executor');
    expect(requestedPaths).toEqual(['/api/health']);
  });
});

// E-20（DEEP_REVIEW 0ef3bbe）：探针端点与 Windows 指标口径。
describe('health probes (E-20)', () => {
  // A3: 就绪用例需要起本地 admin 存根来钉死「可达 / 不可达」两个方向。
  let server: http.Server | undefined;

  function buildApp(): express.Express {
    const app = express();
    app.use('/', healthRouter);
    return app;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    resetCpuSampleForTest();
    if (server) {
      await close(server);
      server = undefined;
    }
  });

  it('serves the canonical liveness/readiness paths (/health/live, /health/ready)', async () => {
    const app = buildApp();

    const live = await request(app).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.text).toBe('OK');

    const ready = await request(app).get('/health/ready');
    // 200 ready / 503 not_ready 都合法（取决于跑测试的机器负载），但路径必须存在
    // 且载荷是二者之一——旧实现的漂移路径（python 用 /health/readiness）在这里 404。
    // A3: status 值由契约统一为 ready/not_ready（旧值 'unready' 已废弃）。
    expect([200, 503]).toContain(ready.status);
    expect(['ready', 'not_ready']).toContain(ready.body.status);
  });

  // A3（executor-protocol）：就绪判定的三方 parity——node 原先只看资源、python
  // 只看 admin 连通性，各缺一块。现在两侧都是「资源 + admin 连通性」，形状与
  // 状态码统一（ready→200 / not_ready→503，reason 非空）。见 protocol.json。
  it('reports 503 not_ready with a reason when admin-api is unreachable (A3)', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end('down');
    });
    const port = await listen(server);
    mockConfig.adminApiUrlInternal = `http://127.0.0.1:${port}/api/`;

    const app = buildApp();
    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.reason).toContain('admin-api unreachable');
    // 运维要能直接从探针响应看出探的是哪个地址
    expect(res.body.reason).toContain('/api/health');
  });

  it('reports 200 ready when admin-api is reachable and resources are ample (A3)', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    const port = await listen(server);
    mockConfig.adminApiUrlInternal = `http://127.0.0.1:${port}/api/`;

    const app = buildApp();
    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  // A3-C 反证有牙：ready / not_ready 两个分支的真实出参都必须被**生成的**
  // HealthReadyResponse 接受——status 值域或形状漂移（如退回旧值 'unready'）立即红。
  it('ready (200) body conforms to the generated HealthReadyResponse schema', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    const port = await listen(server);
    mockConfig.adminApiUrlInternal = `http://127.0.0.1:${port}/api/`;

    const res = await request(buildApp()).get('/health/ready');
    expect(res.status).toBe(200);
    expect(HealthReadyResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('not_ready (503) body conforms to the generated HealthReadyResponse schema', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end('down');
    });
    const port = await listen(server);
    mockConfig.adminApiUrlInternal = `http://127.0.0.1:${port}/api/`;

    const res = await request(buildApp()).get('/health/ready');
    expect(res.status).toBe(503);
    expect(HealthReadyResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it('derives CPU% from os.cpus() time deltas — cross-platform, unlike loadavg (Windows≡0)', () => {
    // loadavg() 在 Windows 恒为 [0,0,0]（旧实现因此把 CPU 恒报 0）。本测试用
    // 合成 cpus() 时间片证明取值走的是「相邻采样差分」而不是 loadavg。
    // os.cpus 在现代 Node 上是不可重定义属性（jest.spyOn 会抛），因此采样器
    // 接受一个注入的 reader。
    const cpu = (busy: number, idle: number) => [{
      model: 'x', speed: 1,
      times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
    }] as unknown as os.CpuInfo[];

    let current = cpu(100, 100);
    const readCpus = () => current;

    resetCpuSampleForTest();
    expect(sampleCpuPercent(readCpus)).toBe(0); // 首个采样只建立基线

    current = cpu(150, 150); // Δbusy=50, Δtotal=100
    expect(sampleCpuPercent(readCpus)).toBeCloseTo(50, 5);

    current = cpu(200, 200); // Δbusy=50, Δtotal=100
    expect(sampleCpuPercent(readCpus)).toBeCloseTo(50, 5);
  });

  it('clamps the CPU sample to 100 and never goes negative on a clock reset', () => {
    const cpu = (busy: number, idle: number) => [{
      model: 'x', speed: 1,
      times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
    }] as unknown as os.CpuInfo[];

    let current = cpu(1000, 1000);
    const readCpus = () => current;

    resetCpuSampleForTest();
    sampleCpuPercent(readCpus);
    // 时间片回绕（Δtotal <= 0）不得产出 NaN/负值
    current = cpu(0, 0);
    const value = sampleCpuPercent(readCpus);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });

  it('reports diskUsage as a percentage or null — never the old -1 sentinel', async () => {
    const res = await request(buildApp()).get('/health');

    expect(res.status).toBe(200);
    if (res.body.diskUsage !== null) {
      expect(typeof res.body.diskUsage).toBe('number');
      expect(res.body.diskUsage).toBeGreaterThanOrEqual(0);
    }
    expect(res.body.diskUsage).not.toBe(-1);
    expect(typeof res.body.cpuUsage).toBe('number');
    expect(res.body.cpuUsage).toBeGreaterThanOrEqual(0);
    expect(res.body.cpuUsage).toBeLessThanOrEqual(100);
  });

  it('keeps the degraded verdict consistent with the reported metrics (null disk must not degrade)', async () => {
    const res = await request(buildApp()).get('/health');
    const { cpuUsage, memUsage, diskUsage } = res.body;

    const expectedHealthy =
      cpuUsage < 80 && memUsage < 80 && (diskUsage === null || diskUsage < 90);
    expect(res.body.status).toBe(expectedHealthy ? 'healthy' : 'degraded');
  });
});
