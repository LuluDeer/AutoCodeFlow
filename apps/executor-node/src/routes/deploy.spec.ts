import request from 'supertest';
import express from 'express';
import * as fs from 'fs';

jest.mock('fs');
jest.mock('child_process');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    npmRegistryUrl: '',
    pythonRegistryUrl: '',
  },
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../admin-client', () => ({
  post: jest.fn().mockResolvedValue({ data: {} }),
}));

import { deployRouter } from './deploy';

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
