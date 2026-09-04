import request from 'supertest';
import express from 'express';
import * as http from 'http';

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
