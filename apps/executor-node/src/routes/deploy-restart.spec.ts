/**
 * daemon 自动重启（生产反馈：`常驻` 模式名不副实）。
 *
 * 背景：用户反馈「应用部署为什么要管模式？单次/常驻/定时 三个选项里，单次与
 * 常驻行为完全一样」。核对属实——`startApp` 的 runMode 形参此前**零引用**，
 * 调用点只有 `runMode === 'daemon' || runMode === 'once'` 一个分支（两者同路），
 * 且进程退出后只上报 stopped/failed，没有任何重启逻辑。于是"常驻"应用崩一次
 * 就永久躺平。
 *
 * 本组测试钉住 `scheduleDaemonRestart` 的决策矩阵——它是"要不要拉起"的唯一
 * 判定点，且**纯逻辑可单测**（不真的 spawn 进程、不等退避时间）。
 *
 * 注意判定权威是 daemonSpecs 登记而非 runningApps：退出处理器里 runningApps
 * 已经被 delete，若用它判定则重启永不发生（这是实现期真实踩到的坑）。
 */
import { EventEmitter } from 'events';

jest.mock('fs');
jest.mock('child_process');
jest.mock('../config', () => ({
  config: {
    workDir: '/tmp/test-workdir',
    npmRegistryUrl: '',
    pythonRegistryUrl: '',
    token: 'test-shared-token',
    allowPrivateNetwork: true,
  },
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

import * as childProcess from 'child_process';
import * as fs from 'fs';
import {
  daemonSpecs,
  resetDaemonRestartState,
  runningApps,
  scheduleDaemonRestart,
  startApp,
} from './deploy';

const mockCp = childProcess as jest.Mocked<typeof childProcess>;
const mockFs = fs as jest.Mocked<typeof fs>;

/** 造一个能触发 exit 事件的假子进程。 */
function fakeChild(): EventEmitter & { pid: number; killed: boolean } {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    killed: boolean;
  };
  child.pid = 1234;
  child.killed = false;
  return child;
}

describe('daemon 自动重启', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetDaemonRestartState();
    runningApps.clear();
    mockPost.mockClear();
    mockCp.spawn.mockReset();
    mockCp.spawn.mockImplementation(() => fakeChild() as never);
    // fs 是 mock 的：startApp 需要 createWriteStream 返回可 .on() 的假流，
    // existsSync 决定 python/node 分支走哪条路径。
    (mockFs.existsSync as jest.Mock).mockReturnValue(false);
    (mockFs.createWriteStream as jest.Mock).mockReturnValue({
      on: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
    });
    (mockFs.writeFileSync as jest.Mock).mockReturnValue(undefined);
    (mockFs.mkdirSync as jest.Mock).mockReturnValue(undefined);
  });

  afterEach(() => {
    resetDaemonRestartState();
    runningApps.clear();
    jest.useRealTimers();
  });

  /** 以 daemon 模式启动一个 app，返回其假子进程。 */
  function startDaemon(deploymentId: string) {
    const child = fakeChild();
    mockCp.spawn.mockImplementation(() => child as never);
    startApp(deploymentId, '/tmp/root', '/tmp/root/releases/r1', 'node', 'index.js', 'daemon', {});
    return child;
  }

  it('daemon 模式下异常退出 → 安排重启（返回 true）', () => {
    startDaemon('dep-1');
    expect(scheduleDaemonRestart('dep-1', 1)).toBe(true);
  });

  it('once 模式不登记 → 不重启', () => {
    const child = fakeChild();
    mockCp.spawn.mockImplementation(() => child as never);
    startApp('dep-once', '/tmp/root', '/tmp/root/releases/r1', 'node', 'index.js', 'once', {});
    expect(scheduleDaemonRestart('dep-once', 1)).toBe(false);
  });

  it('scheduled 模式不登记 → 不重启', () => {
    const child = fakeChild();
    mockCp.spawn.mockImplementation(() => child as never);
    startApp('dep-sched', '/tmp/root', '/tmp/root/releases/r1', 'node', 'index.js', 'scheduled', {});
    expect(scheduleDaemonRestart('dep-sched', 1)).toBe(false);
  });

  it('干净退出（code 0）→ 不重启（尊重应用主动结束的意图）', () => {
    startDaemon('dep-2');
    expect(scheduleDaemonRestart('dep-2', 0)).toBe(false);
  });

  it('未登记的 deploymentId → 不重启', () => {
    expect(scheduleDaemonRestart('never-started', 1)).toBe(false);
  });

  it('退避时间指数增长且有上限（1s → 2s → 4s …）', () => {
    startDaemon('dep-3');
    const { logger } = jest.requireMock('../logger');

    scheduleDaemonRestart('dep-3', 1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('in 1000ms'),
    );

    // 推进定时器让第 1 次重启真正发生，才能观察到第 2 次退避
    jest.advanceTimersByTime(1_000);
    scheduleDaemonRestart('dep-3', 1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('in 2000ms'),
    );

    jest.advanceTimersByTime(2_000);
    scheduleDaemonRestart('dep-3', 1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('in 4000ms'),
    );
  });

  it('超过最大尝试次数 → 放弃并上报 failed', async () => {
    startDaemon('dep-4');
    // 刻意**不**推进定时器：只累计崩溃次数。若推进时间，startApp 注册的
    // "稳定运行 60s 即清零" 健康定时器会触发并把计数清零（真实场景里进程退出
    // 会先清掉该定时器，本测试的假子进程不会退出，故必须避免时间推进）。
    for (let i = 0; i < 10; i++) {
      expect(scheduleDaemonRestart('dep-4', 1)).toBe(true);
    }
    // 第 11 次：超过上限 → 放弃
    expect(scheduleDaemonRestart('dep-4', 1)).toBe(false);

    await jest.runAllTimersAsync();
    expect(mockPost).toHaveBeenCalledWith(
      '/api/app-deployments/heartbeat',
      expect.objectContaining({
        deploymentId: 'dep-4',
        status: 'failed',
        message: expect.stringContaining('auto-restart attempts'),
      }),
    );
  });

  it('放弃重启后登记被摘除（不会再有后续重启）', () => {
    startDaemon('dep-4b');
    for (let i = 0; i < 10; i++) {
      scheduleDaemonRestart('dep-4b', 1);
    }
    expect(scheduleDaemonRestart('dep-4b', 1)).toBe(false);
    // 摘除后即便再调用也不重启
    expect(daemonSpecs.has('dep-4b')).toBe(false);
    expect(scheduleDaemonRestart('dep-4b', 1)).toBe(false);
  });

  it('稳定运行满 60s → 重启计数清零（慢速崩溃循环不被误判为持续失败）', () => {
    startDaemon('dep-8');
    scheduleDaemonRestart('dep-8', 1); // 第 1 次崩溃
    // 健康定时器在 60s 后触发：此时子进程仍在 runningApps 里 → 视为健康
    jest.advanceTimersByTime(60_000);
    // 计数已清零 → 下次崩溃重新从 #1 开始（退避回到 1s，而不是继续翻倍）
    const { logger } = jest.requireMock('../logger');
    scheduleDaemonRestart('dep-8', 1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining('auto-restart #1 in 1000ms'),
    );
  });

  it('定时器触发时若登记已被摘除（stop/uninstall）→ 不复活', () => {
    startDaemon('dep-5');
    scheduleDaemonRestart('dep-5', 1);
    // 模拟 stop/uninstall：摘除登记
    daemonSpecs.delete('dep-5');
    mockCp.spawn.mockClear();

    jest.advanceTimersByTime(60_000);

    expect(mockCp.spawn).not.toHaveBeenCalled();
  });

  it('定时器触发时真的会重新 spawn（重启生效，不只是记了个定时器）', () => {
    startDaemon('dep-6');
    scheduleDaemonRestart('dep-6', 1);
    mockCp.spawn.mockClear();

    jest.advanceTimersByTime(1_000);

    expect(mockCp.spawn).toHaveBeenCalledTimes(1);
    // 重启用的仍是登记时的启动参数（release 目录、入口、runtime）
    const [cmd, args] = mockCp.spawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe('node');
    expect(args).toEqual(['index.js']);
  });

  it('登记内容包含重启所需的全部启动参数', () => {
    startDaemon('dep-7');
    const spec = daemonSpecs.get('dep-7');
    expect(spec).toMatchObject({
      appRoot: '/tmp/root',
      deployDir: '/tmp/root/releases/r1',
      runtime: 'node',
      entrypoint: 'index.js',
    });
  });
});
