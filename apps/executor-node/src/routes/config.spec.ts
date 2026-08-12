import request from 'supertest';
import express from 'express';

const mockConfig = {
  maxConcurrentTasks: 10,
  taskTimeoutSeconds: 300,
  heartbeatIntervalSeconds: 30,
  adminApiUrl: 'http://old-admin:3105',
  adminApiUrlInternal: 'http://old-admin:3105',
  adminApiUrls: ['http://old-admin:3105'],
  token: 'test-token',
};

jest.mock('../config', () => ({ config: mockConfig }));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../admin-client', () => ({ initAdminClients: jest.fn() }));
jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ status: 404 }) }));

import { configRouter } from './config';
import { initAdminClients } from '../admin-client';

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
    mockConfig.adminApiUrls = ['http://old-admin:3105'];
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
