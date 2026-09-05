import request from 'supertest';
import express from 'express';

const mockConfig = {
  maxConcurrentTasks: 10,
  taskTimeoutSeconds: 300,
  heartbeatIntervalSeconds: 30,
  adminApiUrl: 'http://old-admin:3105',
  adminApiUrlInternal: 'http://old-admin:3105',
  adminApiUrlExternal: '',
  adminApiUrls: ['http://old-admin:3105'],
  token: 'test-token',
};

jest.mock('../config', () => ({ config: mockConfig }));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../admin-client', () => ({ initAdminClients: jest.fn() }));
jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ status: 404 }) }));
// config 路由新增了对 execute.ts（运行表/workDir 校验复用）与 fs（workDir
// 存在性/symlink 检查）的依赖——按边界 mock，避免拉起 execute 全链。
jest.mock('./execute', () => ({
  listActiveExecutionIds: jest.fn(() => []),
  validateExecutionWorkDir: jest.fn(() => null),
}));
jest.mock('fs');

import * as fs from 'fs';
import { configRouter } from './config';
import { initAdminClients } from '../admin-client';
import { listActiveExecutionIds, validateExecutionWorkDir } from './execute';

const mockFs = fs as jest.Mocked<typeof fs>;

const app = express();
app.use(express.json());
app.use('/api', configRouter);

function authPost(body: Record<string, unknown>) {
  return request(app)
    .post('/api/config/reload')
    .set('Authorization', 'Bearer test-token')
    .send(body);
}

describe('config reload route', () => {
  beforeEach(() => {
    mockConfig.maxConcurrentTasks = 10;
    mockConfig.taskTimeoutSeconds = 300;
    mockConfig.heartbeatIntervalSeconds = 30;
    mockConfig.adminApiUrl = 'http://old-admin:3105';
    mockConfig.adminApiUrlInternal = 'http://old-admin:3105';
    mockConfig.adminApiUrlExternal = '';
    mockConfig.adminApiUrls = ['http://old-admin:3105'];
    jest.clearAllMocks();
  });

  it('applies hot-reloaded runtime configuration values', async () => {
    const res = await authPost({
      maxConcurrentTasks: 4,
      taskTimeoutSeconds: 120,
      heartbeatIntervalSeconds: 15,
      adminApiUrl: 'http://new-admin:3105/api',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Updated 4 field(s)',
      updatedFields: [
        'maxConcurrentTasks',
        'taskTimeoutSeconds',
        'heartbeatIntervalSeconds',
        'adminApiUrl',
      ],
    });
    expect(mockConfig.maxConcurrentTasks).toBe(4);
    expect(mockConfig.taskTimeoutSeconds).toBe(120);
    expect(mockConfig.heartbeatIntervalSeconds).toBe(15);
    expect(mockConfig.adminApiUrl).toBe('http://new-admin:3105/api');
    expect(mockConfig.adminApiUrlInternal).toBe('http://new-admin:3105/api');
    expect(mockConfig.adminApiUrls).toEqual(['http://new-admin:3105/api']);
    expect(initAdminClients).toHaveBeenCalledWith(['http://new-admin:3105/api']);
  });

  it('applies admin API internal and external URL hot-reload fields', async () => {
    const res = await authPost({
      adminApiUrl: 'http://public-admin:3105/api',
      adminApiUrlInternal: 'http://internal-admin:3105/api',
      adminApiUrlExternal: 'https://admin.example.com/api',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Updated 3 field(s)',
      updatedFields: ['adminApiUrl', 'adminApiUrlInternal', 'adminApiUrlExternal'],
    });
    expect(mockConfig.adminApiUrl).toBe('http://public-admin:3105/api');
    expect(mockConfig.adminApiUrlInternal).toBe('http://internal-admin:3105/api');
    expect(mockConfig.adminApiUrlExternal).toBe('https://admin.example.com/api');
    expect(mockConfig.adminApiUrls).toEqual(['http://internal-admin:3105/api']);
    expect(initAdminClients).toHaveBeenCalledWith(['http://internal-admin:3105/api']);
  });

  it('uses explicit admin API URL list when provided', async () => {
    const res = await authPost({
      adminApiUrlInternal: 'http://internal-admin:3105/api',
      adminApiUrls: ['http://first-admin:3105/api', '  ', 'http://second-admin:3105/api'],
    });

    expect(res.status).toBe(200);
    expect(res.body.updatedFields).toEqual(['adminApiUrlInternal', 'adminApiUrls']);
    expect(mockConfig.adminApiUrlInternal).toBe('http://internal-admin:3105/api');
    expect(mockConfig.adminApiUrls).toEqual(['http://first-admin:3105/api', 'http://second-admin:3105/api']);
    expect(initAdminClients).toHaveBeenCalledWith(['http://first-admin:3105/api', 'http://second-admin:3105/api']);
  });

  it('falls back to internal admin API URL when no explicit URL list remains', async () => {
    const res = await authPost({
      adminApiUrlInternal: 'http://internal-admin:3105/api',
      adminApiUrls: [],
    });

    expect(res.status).toBe(200);
    expect(mockConfig.adminApiUrls).toEqual(['http://internal-admin:3105/api']);
    expect(initAdminClients).toHaveBeenCalledWith(['http://internal-admin:3105/api']);
  });

  it('rejects invalid hot-reload values without mutating config', async () => {
    const res = await authPost({ maxConcurrentTasks: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'maxConcurrentTasks must be >= 1' });
    expect(mockConfig.maxConcurrentTasks).toBe(10);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/config/reload').send({ maxConcurrentTasks: 4 });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// workDir / WORK_DIR 热切换
// ---------------------------------------------------------------------------

describe('config reload — workDir (WORK_DIR)', () => {
  const savedWorkEnv = process.env.WORK_DIR;
  const newBase = '/tmp/af-new-workdir';

  beforeEach(() => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(true);
    (mockFs.lstatSync as jest.Mock).mockReturnValue({ isSymbolicLink: () => false });
    (listActiveExecutionIds as jest.Mock).mockReturnValue([]);
    (validateExecutionWorkDir as jest.Mock).mockReturnValue(null);
  });

  afterEach(() => {
    if (savedWorkEnv === undefined) delete process.env.WORK_DIR;
    else process.env.WORK_DIR = savedWorkEnv;
  });

  it('accepts workDir field: absolute existing non-symlink base with no active executions', async () => {
    const res = await authPost({ workDir: newBase });
    expect(res.status).toBe(200);
    expect(res.body.updatedFields).toContain('workDir');
    // config.workDir 是读 process.env.WORK_DIR 的 getter——热更新写 env 即生效
    expect(process.env.WORK_DIR).toBe(require('path').resolve(newBase));
  });

  it('accepts WORK_DIR field name alias', async () => {
    const res = await request(app)
      .post('/api/config/reload')
      .set('Authorization', 'Bearer test-token')
      .send({ WORK_DIR: newBase });
    expect(res.status).toBe(200);
    expect(res.body.updatedFields).toContain('workDir');
  });

  it('rejects relative paths', async () => {
    const res = await authPost({ workDir: 'relative/dir' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/absolute path/);
  });

  it('rejects paths containing .. segments', async () => {
    const res = await authPost({ workDir: '/tmp/good/../evil' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/absolute path/);
  });

  it('rejects a base that does not exist', async () => {
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    const res = await authPost({ workDir: newBase });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not exist/);
  });

  it('rejects a symbolic-link base', async () => {
    (mockFs.lstatSync as jest.Mock).mockReturnValue({ isSymbolicLink: () => true });
    const res = await authPost({ workDir: newBase });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/symbolic link/);
  });

  it('rejects while executions are still running on the old directory', async () => {
    (listActiveExecutionIds as jest.Mock).mockReturnValue(['exec-live-1']);
    const res = await authPost({ workDir: newBase });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/running on the old directory/);
    expect(process.env.WORK_DIR).not.toBe(require('path').resolve(newBase));
  });

  it('rejects when an active execution workDir would escape the new base (reuses S6/Q11 guard)', async () => {
    (listActiveExecutionIds as jest.Mock).mockReturnValue(['bad-exec']);
    (validateExecutionWorkDir as jest.Mock).mockReturnValue('Invalid executionId: path traversal detected');
    const res = await authPost({ workDir: newBase });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path traversal/);
    expect(validateExecutionWorkDir).toHaveBeenCalled();
  });
});
