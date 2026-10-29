/**
 * EN-01（P1）：升级失败只回滚软链、不回滚进程 → 旧版本应用永久停摆。
 *
 * 升级路径的既有顺序是「先停旧进程（SIGTERM/SIGKILL + unregisterDaemon），再
 * 下载/解压/装依赖」。任何一步失败都进 catch，而旧 catch 只做
 * `restoreCurrentRelease` + 删 extractDir + `reportStatus(failed)`——**不重启
 * 旧进程**。结果：旧 release 文件完好、current 也指回了旧 release，但进程已死、
 * daemon 登记已摘，客户应用从这一刻起停服，直到有人重新部署。
 *
 * 本用例把「回滚必须连进程一起回滚」钉死：删掉 catch 里的回滚重启调用即转红。
 */
import express from 'express';
import * as http from 'http';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import request from 'supertest';

jest.mock('fs');
jest.mock('child_process');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    npmRegistryUrl: '',
    pythonRegistryUrl: '',
    uvPythonInstallDir: '/tmp/test-interpreters',
    uvBin: '',
    pypiRegistryUrl: '',
    pypiExtraIndexUrl: '',
    token: 'test-shared-token',
    allowPrivateNetwork: true,
  },
}));
jest.mock('../interpreters', () => ({
  discoverInstalled: jest.fn(async () => []),
  ensureVersion: jest.fn(async () => {
    throw new Error('no interpreter in pool');
  }),
  resolveUvBin: jest.fn(async () => ({ path: null, source: 'missing' })),
  interpreterSnapshot: jest.fn(() => []),
}));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockPost = jest.fn().mockResolvedValue({ data: {} });
jest.mock('../admin-client', () => ({ post: (...a: unknown[]) => mockPost(...a) }));
jest.mock('../shutdown-state', () => ({
  isExecutorShuttingDown: jest.fn(() => false),
  setExecutorShuttingDown: jest.fn(),
  resetShutdownStateForTest: jest.fn(),
}));
// 升级的失败点：包 URL 下载直接 reject（生产里对应 5xx / 断连 / sha 不符前的
// 传输失败），此时 extractDir 刚建好、current 还没切换。
jest.mock('../lib/download', () => ({ downloadFile: jest.fn() }));

import { buildDeploymentPaths, deployRouter, runningApps, resetDaemonRestartState } from './deploy';
import * as downloadLib from '../lib/download';
import * as runCommandLib from '../run-command';
import { buildToolchainForTest, seedToolchainForTest, invalidateToolchain } from '../toolchain';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockCp = childProcess as jest.Mocked<typeof childProcess>;

const app = express();
app.use(express.json());
app.use('/api', deployRouter);

/**
 * 假子进程：既要满足 startApp（stdout/stderr 管道 + exit/error 事件），
 * 也要满足 runCommand 的 git clone（spawn 后等 'close' 事件）——后者若不回
 * close，部署的异步段会永远卡在 clone 上，根本走不到 startApp。
 */
function fakeChild(pid: number) {
  const events = new EventEmitter();
  const child = {
    pid,
    stdout: Object.assign(new EventEmitter(), { pipe: jest.fn() }),
    stderr: Object.assign(new EventEmitter(), { pipe: jest.fn() }),
    kill: jest.fn(),
    on: jest.fn((event: string, cb: Function) => {
      if (event === 'close') setImmediate(() => cb(0));
      else events.once(event, (...args: unknown[]) => cb(...args));
    }),
    once: jest.fn((event: string, cb: Function) =>
      events.once(event, (...args: unknown[]) => cb(...args)),
    ),
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
  };
  return child;
}

async function waitFor(predicate: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(predicate()).toBe(true);
}

/** 启动过的应用进程 spawn 调用（startApp 的 node 分支：cmd + [entrypoint]）。 */
function appStartCalls() {
  return (mockCp.spawn as jest.Mock).mock.calls.filter(
    (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes('index.js'),
  ) as Array<[string, string[], { cwd?: string }]>;
}

function heartbeatCalls() {
  return mockPost.mock.calls.filter(
    (c: unknown[]) => c[0] === '/api/app-deployments/heartbeat',
  ) as Array<[string, { status?: string; message?: string; deploymentId?: string }]>;
}

describe('EN-01 升级失败：软链与进程必须一起回滚', () => {
  const workDir = '/tmp/test-workdir';
  const appId = 'app-en01';
  const deploymentId = 'dep-en01';
  const version = '1.0.0';
  const basePayload = {
    deploymentId,
    applicationId: appId,
    appName: 'Demo',
    gitRepo: 'https://example.com/repo.git',
    gitBranch: 'main',
    runtime: 'node',
    runMode: 'daemon',
    version,
  };

  let server: http.Server;
  let releaseDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetDaemonRestartState();
    mockPost.mockResolvedValue({ data: {} });
    seedToolchainForTest(
      buildToolchainForTest({ node: { path: 'node', source: 'host', verified: true, version: 'v24.0.0' } }),
    );
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
    (mockFs.createWriteStream as jest.Mock).mockReturnValue({
      on: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
    });
    releaseDir = buildDeploymentPaths(workDir, appId, deploymentId, version).finalReleaseDir;
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
  });

  afterEach(async () => {
    runningApps.clear();
    invalidateToolchain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('升级失败（下载 reject）→ 用旧 release 重新 startApp，并在状态里说明已回滚重启', async () => {
    let spawnCount = 0;
    (mockCp.spawn as jest.Mock).mockImplementation(() => fakeChild(9000 + ++spawnCount));

    // ① 先正常部署一次，让旧版本真的跑起来（登记 startedAppSpecs / runningApps）。
    const first = await request(app).post('/api/deploy').send(basePayload);
    expect(first.status).toBe(200);
    await waitFor(() => heartbeatCalls().some((c) => c[1].status === 'running'));
    expect(appStartCalls()).toHaveLength(1);
    const oldDeployDir = appStartCalls()[0][2].cwd;
    expect(oldDeployDir).toBe(releaseDir);
    expect(runningApps.has(deploymentId)).toBe(true);

    // ② 升级：停机走 killProcessTree（POSIX 下是进程组信号）→ 让假进程真的退出。
    jest.spyOn(runCommandLib, 'killProcessTree').mockImplementation(((child: any) => {
      child.emit?.('exit', 0);
      return true;
    }) as never);
    (downloadLib.downloadFile as jest.Mock).mockRejectedValue(
      new Error('package download failed: 503 Service Unavailable'),
    );

    const second = await request(app)
      .post('/api/deploy')
      .send({ ...basePayload, gitRepo: null, packageUrl: 'http://127.0.0.1:1/app.zip', upgrade: true });
    expect(second.status).toBe(200);

    // ③ 断言：旧 release 的进程被重新拉起（这是 P1 的核心——回滚必须连进程）。
    await waitFor(() =>
      heartbeatCalls().some(
        (c) => c[1].status === 'failed' && /已回滚并重启旧版本进程/.test(String(c[1].message ?? '')),
      ),
    );
    const starts = appStartCalls();
    expect(starts).toHaveLength(2);
    // 用的是**旧** deployDir（不是本次失败请求的路径），入口也不变。
    expect(starts[1][2].cwd).toBe(oldDeployDir);
    expect(starts[1][1]).toEqual(['index.js']);
    // runningApps 里仍有该 id（进程真的被重新登记，而不是只发了一条消息）
    expect(runningApps.has(deploymentId)).toBe(true);

    const failed = heartbeatCalls().find(
      (c) => c[1].status === 'failed' && /package download failed/.test(String(c[1].message ?? '')),
    );
    expect(failed).toBeTruthy();
    // 失败原因与回滚结果都必须出现在 statusMessage 里（不静默）
    expect(String(failed![1].message)).toContain('503 Service Unavailable');
    expect(String(failed![1].message)).toContain(oldDeployDir);
  });

  it('没有登记过旧描述时明确报「未自动恢复」，而不是静默', async () => {
    // 旧进程存在但描述缺失（极端情形：描述表被清空 / 进程由更早的实现启动）。
    let spawnCount = 0;
    (mockCp.spawn as jest.Mock).mockImplementation(() => fakeChild(9500 + ++spawnCount));

    const first = await request(app).post('/api/deploy').send(basePayload);
    expect(first.status).toBe(200);
    await waitFor(() => heartbeatCalls().some((c) => c[1].status === 'running'));

    // 模拟「进程还在，但已启动应用描述没记下来」
    resetDaemonRestartState(); // 清空 startedAppSpecs（daemonSpecs 一并清空）

    jest.spyOn(runCommandLib, 'killProcessTree').mockImplementation(((child: any) => {
      child.emit?.('exit', 0);
      return true;
    }) as never);
    (downloadLib.downloadFile as jest.Mock).mockRejectedValue(new Error('boom-download'));

    await request(app)
      .post('/api/deploy')
      .send({ ...basePayload, gitRepo: null, packageUrl: 'http://127.0.0.1:1/app.zip', upgrade: true });

    await waitFor(() =>
      heartbeatCalls().some(
        (c) => c[1].status === 'failed' && /旧版本进程未自动恢复/.test(String(c[1].message ?? '')),
      ),
    );
    // 没有描述就不该猜着启动（否则可能用错路径把失败的新 release 拉起来）
    expect(appStartCalls()).toHaveLength(1);
  });
});
