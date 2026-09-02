import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';

jest.mock('fs');
jest.mock('child_process');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    npmRegistryUrl: '',
    pythonRegistryUrl: '',
    token: 'test-shared-token',
  },
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../admin-client', () => ({
  post: jest.fn().mockResolvedValue({ data: {} }),
}));

import {
  buildDeploymentPaths,
  deployRouter,
  downloadPackage,
  shouldReportProcessExit,
  suppressNextRestartExitReport,
} from './deploy';

const app = express();
app.use(express.json());
app.use('/api', deployRouter);

const mockFs = fs as jest.Mocked<typeof fs>;

beforeEach(() => {
  jest.clearAllMocks();
  (mockFs.existsSync as jest.Mock).mockReturnValue(false);
  (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
});

describe('POST /api/deploy validation', () => {
  const basePayload = {
    deploymentId: 'deploy-1',
    applicationId: 'app-1',
    appName: 'Demo App',
    gitRepo: 'https://example.com/repo.git',
    gitBranch: 'main',
    runtime: 'node',
    runMode: 'scheduled',
  };

  it('rejects path traversal in deploymentId before creating work directories', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({ ...basePayload, deploymentId: '../escape' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deploymentId/i);
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it('rejects path traversal in applicationId before creating work directories', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({ ...basePayload, applicationId: '../../escape' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/applicationId/i);
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it('rejects non-http package URLs before async deployment starts', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({
        ...basePayload,
        gitRepo: null,
        packageUrl: 'file:///etc/passwd',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/packageUrl|scheme|http/i);
    expect(mockFs.mkdirSync).not.toHaveBeenCalled();
  });

  it('accepts safe ids with an http package URL', async () => {
    const res = await request(app)
      .post('/api/deploy')
      .send({
        ...basePayload,
        gitRepo: null,
        packageUrl: 'http://127.0.0.1:1/app.zip',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deploymentId: 'deploy-1' });
  });
});

describe('restart exit reporting', () => {
  it('suppresses only the next exit report for an in-place restart', () => {
    suppressNextRestartExitReport('deploy-1');

    expect(shouldReportProcessExit('deploy-1')).toBe(false);
    expect(shouldReportProcessExit('deploy-1')).toBe(true);
    expect(shouldReportProcessExit('deploy-2')).toBe(true);
  });
});

describe('versioned deployment paths', () => {
  it('builds immutable release paths and a current pointer', () => {
    const paths = buildDeploymentPaths('/tmp/work', 'app-1', 'deploy-1', '1.2.0');

    expect(paths.appRoot).toBe('/tmp/work/apps/app-1');
    expect(paths.releaseKey).toBe('1.2.0-deploy-1');
    expect(paths.finalReleaseDir).toBe('/tmp/work/apps/app-1/releases/1.2.0-deploy-1');
    expect(paths.extractDir).toBe('/tmp/work/apps/app-1/tmp/1.2.0-deploy-1-extracting');
    expect(paths.currentLink).toBe('/tmp/work/apps/app-1/current');
  });

  it('keeps same-version redeploys isolated by deployment id', () => {
    const first = buildDeploymentPaths('/tmp/work', 'app-1', 'deploy-1', '1.2.0');
    const second = buildDeploymentPaths('/tmp/work', 'app-1', 'deploy-2', '1.2.0');

    expect(first.finalReleaseDir).not.toBe(second.finalReleaseDir);
  });

  it('sanitizes version text before using it in a path', () => {
    const paths = buildDeploymentPaths('/tmp/work', 'app-1', 'deploy-1', '../v1+build');

    expect(paths.releaseKey).toBe('v1-build-deploy-1');
    expect(paths.finalReleaseDir).toBe('/tmp/work/apps/app-1/releases/v1-build-deploy-1');
  });
});

describe('downloadPackage authentication', () => {
  const actualFs = jest.requireActual('fs') as typeof fs;

  function listen(server: http.Server): Promise<number> {
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port);
      }),
    );
  }

  it('sends the executor shared token as Bearer and strips it on cross-host redirect', async () => {
    const authHeaders: Array<string | undefined> = [];
    const serverB = http.createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      res.writeHead(200);
      res.end('payload');
    });
    const portB = await listen(serverB);
    const serverA = http.createServer((req, res) => {
      authHeaders.push(req.headers.authorization);
      // 127.0.0.1 → localhost 视为跨主机重定向
      res.writeHead(302, { location: `http://localhost:${portB}/pkg.zip` });
      res.end();
    });
    const portA = await listen(serverA);

    (mockFs.createWriteStream as jest.Mock).mockImplementation((p: string) =>
      actualFs.createWriteStream(p),
    );
    const dest = `/tmp/acf-download-test-${Date.now()}.bin`;
    try {
      await downloadPackage(`http://127.0.0.1:${portA}/pkg.zip`, dest);
      expect(authHeaders).toEqual(['Bearer test-shared-token', undefined]);
      expect(actualFs.readFileSync(dest, 'utf8')).toBe('payload');
    } finally {
      serverA.close();
      serverB.close();
      try {
        actualFs.unlinkSync(dest);
      } catch {
        /* already removed */
      }
    }
  });

  it('omits the Authorization header when no token is configured', async () => {
    const { config } = require('../config') as { config: { token?: string } };
    const saved = config.token;
    config.token = '';
    let seenAuth: string | undefined = 'unset';
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200);
      res.end('ok');
    });
    const port = await listen(server);
    (mockFs.createWriteStream as jest.Mock).mockImplementation((p: string) =>
      actualFs.createWriteStream(p),
    );
    const dest = `/tmp/acf-download-test-notoken-${Date.now()}.bin`;
    try {
      await downloadPackage(`http://127.0.0.1:${port}/pkg.zip`, dest);
      expect(seenAuth).toBeUndefined();
    } finally {
      config.token = saved;
      server.close();
      try {
        actualFs.unlinkSync(dest);
      } catch {
        /* already removed */
      }
    }
  });
});
