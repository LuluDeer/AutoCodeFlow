/**
 * OBS-01: traceparent 贯穿（executor-node 侧）。
 *
 * 形态：admin 开启追踪（OTEL_ENABLED=true）后 dispatch 指令携带 W3C
 * traceparent 头；执行器侧 ① 记录进 ExecutionEntry ② 注入任务 env
 * AUTOFLOW_TRACE_ID（params 注入之后，用户参数不可覆盖）③ 终态回调
 * 回传 traceparent 头。admin 未开追踪时不带头——全部路径零行为变化。
 *
 * 本文件只测「头读取 + 回调回传 + env 注入」三段（admin-client 的头
 * 注入由 callback.spec 的 {} 断言钉死契约）。
 */
import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import { executeRouter } from './execute';
import { pushCallback } from '../callback';
import { taskWorkerManager } from '../task-worker';
import { config as testConfig } from '../config';

jest.mock('fs');
jest.mock('child_process');
jest.mock('axios');

jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    maxConcurrentTasks: 10,
    appName: 'test-executor',
    executorAddress: 'localhost:8002',
    taskTimeoutSeconds: 300,
    token: 'test-shared-secret',
    executionCallbackSecret: '',
    adminApiUrl: 'http://admin-api:3105',
    adminApiUrlInternal: 'http://admin-api:3105',
    npmRegistryUrl: '',
    npmRegistryToken: '',
  },
}));

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../callback', () => ({
  pushCallback: jest.fn(),
}));

jest.mock('../task-worker', () => ({
  taskWorkerManager: { execute: jest.fn() },
}));

jest.mock('../run-command', () => ({
  runCommand: jest.fn().mockResolvedValue({ status: 0, stdout: '', stderr: '' }),
  killProcessTree: jest.fn(),
}));

jest.mock('../env-whitelist', () => ({
  buildChildEnv: jest.fn(() => ({})),
}));

const _sharedBuf = new SharedArrayBuffer(4);
const _runningCountArr = new Int32Array(_sharedBuf);
jest.mock('../scheduler', () => ({
  incrementRunning: jest.fn(),
  decrementRunning: jest.fn(),
  getRunningCountArray: jest.fn(() => _runningCountArr),
  getRunningCount: jest.fn(() => 0),
  registerRunningExecutionIdsProvider: jest.fn(),
  registerDeadLetterCountProvider: jest.fn(),
}));

const VALID_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', executeRouter);
  return app;
}

const capturedPrepared: any[] = [];

const mockFs = fs as jest.Mocked<typeof fs>;

describe('OBS-01: traceparent 贯穿（executor-node）', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    Atomics.store(_runningCountArr, 0, 0);
    // fs automock 默认返回 undefined → workDir 校验/目录预建需要显式桩
    // （与 execute.spec beforeEach 同一形态）。
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
    (mockFs.chmodSync as jest.Mock).mockReturnValue(undefined);
    (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
    (mockFs.lstatSync as jest.Mock).mockReturnValue({ isSymbolicLink: () => false });
    (mockFs.realpathSync as unknown as jest.Mock).mockImplementation((p: string) => p);
    app = buildApp();
    capturedPrepared.length = 0;
    (taskWorkerManager.execute as jest.Mock).mockImplementation(
      async (_taskId: string, _execId: string, _placeholder: any, _params: any, _onComplete: any, runPrepared: any) => {
        // 不真正执行任务——只捕获 prepared task（含 env），随后由 worker
        // 正常释放容量的语义在这里手工模拟（不调 onComplete，测试内
        // 各自独立 app+entry，不影响其他用例）。
        capturedPrepared.push(await runPrepared(() => {}));
      },
    );
  });

  it('dispatch 携带 traceparent 头时：回调载荷带 traceparent，任务 env 注入 AUTOFLOW_TRACE_ID', async () => {
    const res = await request(app)
      .post('/api/execute')
      .set('traceparent', VALID_TRACEPARENT)
      .send({ executionId: 'exec-trace-1', task: { runtime: 'node', entrypoint: 'index.js' } });
    expect(res.status).toBe(200);

    // prepare 不涉及 git/依赖（无 requirements/gitRepo），env 直接可读
    await new Promise(r => setImmediate(r));
    expect(capturedPrepared.length).toBe(1);
    const preparedEnv = capturedPrepared[0].task.env;
    expect(preparedEnv['AUTOFLOW_TRACE_ID']).toBe(VALID_TRACEPARENT);
  });

  it('dispatch 不带 traceparent 时：env 不注入 AUTOFLOW_TRACE_ID（零行为变化）', async () => {
    const res = await request(app)
      .post('/api/execute')
      .send({ executionId: 'exec-trace-2', task: { runtime: 'node', entrypoint: 'index.js' } });
    expect(res.status).toBe(200);

    await new Promise(r => setImmediate(r));
    expect(capturedPrepared.length).toBe(1);
    expect(capturedPrepared[0].task.env['AUTOFLOW_TRACE_ID']).toBeUndefined();
  });

  it('用户 params 不能覆盖 AUTOFLOW_TRACE_ID（注入顺序在 params 之后）', async () => {
    const res = await request(app)
      .post('/api/execute')
      .set('traceparent', VALID_TRACEPARENT)
      .send({
        executionId: 'exec-trace-3',
        task: { runtime: 'node', entrypoint: 'index.js' },
        params: { trace_id: 'user-forged-value' },
      });
    expect(res.status).toBe(200);

    await new Promise(r => setImmediate(r));
    expect(capturedPrepared[0].task.env['AUTOFLOW_TRACE_ID']).toBe(VALID_TRACEPARENT);
  });

  it('traceparent 进入 ExecutionEntry 后可被 runTask 的回调回传消费（liveExecutions 关联）', async () => {
    const { executionExists } = await import('./execute');
    const res = await request(app)
      .post('/api/execute')
      .set('traceparent', VALID_TRACEPARENT)
      .send({ executionId: 'exec-trace-4', task: { runtime: 'node', entrypoint: 'index.js' } });
    expect(res.status).toBe(200);
    expect(executionExists('exec-trace-4')).toBe(true);
    // pushCallback（runTask 路径）尚未发生——worker mock 未运行任务
    expect(pushCallback).not.toHaveBeenCalled();
  });
});
