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
  function buildApp(): express.Express {
    const app = express();
    app.use('/', healthRouter);
    return app;
  }

  afterEach(() => {
    jest.restoreAllMocks();
    resetCpuSampleForTest();
  });

  it('serves the canonical liveness/readiness paths (/health/live, /health/ready)', async () => {
    const app = buildApp();

    const live = await request(app).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.text).toBe('OK');

    const ready = await request(app).get('/health/ready');
    // 200 ready / 503 unready 都合法（取决于跑测试的机器负载），但路径必须存在
    // 且载荷是二者之一——旧实现的漂移路径（python 用 /health/readiness）在这里 404。
    expect([200, 503]).toContain(ready.status);
    expect(['ready', 'unready']).toContain(ready.body.status);
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
