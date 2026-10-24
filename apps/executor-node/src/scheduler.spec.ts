jest.mock('./config', () => ({
  EXECUTOR_VERSION: '1.0.0',
  config: {
    heartbeatIntervalSeconds: 12,
    maxConcurrentTasks: 10,
    executorAddress: 'localhost:8002',
    executorAddressPublic: '',
    // R3-B：默认指向不存在的目录 → deployedApps 稳定为 []（apps/ ENOENT =
    // 「本机无部署应用」的真事实），既有用例互不干扰。
    workDir: '/nonexistent-deployed-apps-r3b',
    deployedAppsScanTtlSeconds: 60,
  },
}));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const post = jest.fn().mockResolvedValue({ data: {} });
jest.mock('./admin-client', () => ({ post }));

describe('scheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('NETOPT-9-7: waitForRunningCountZero resolves once the ledger drains, bounded by maxWaitMs', async () => {
    jest.useFakeTimers();
    const { incrementRunning, decrementRunning, waitForRunningCountZero } = require('./scheduler');
    incrementRunning();
    incrementRunning();
    let settled = 'pending';
    const promise = waitForRunningCountZero(5_000, 100).then((v: boolean) => {
      settled = v ? 'zero' : 'timeout';
      return v;
    });

    // 账本未清 → 持续等待（不提前返回）
    await jest.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe('pending');

    decrementRunning();
    decrementRunning();
    await jest.advanceTimersByTimeAsync(100);
    expect(settled).toBe('zero');
    await expect(promise).resolves.toBe(true);
  });

  it('NETOPT-9-7: waitForRunningCountZero times out (returns false) when the ledger never drains', async () => {
    jest.useFakeTimers();
    const { incrementRunning, waitForRunningCountZero } = require('./scheduler');
    incrementRunning();
    const promise = waitForRunningCountZero(500, 100);
    await jest.advanceTimersByTimeAsync(600);
    await expect(promise).resolves.toBe(false);
  });

  it('uses the hot-reloaded interval on the next tick', async () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    const { config } = require('./config');
    const { startHeartbeat } = require('./scheduler');
    const timer = startHeartbeat();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);

    config.heartbeatIntervalSeconds = 5;
    await jest.advanceTimersByTimeAsync(4_000);
    expect(post).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(12_000);
    expect(post).toHaveBeenCalled();
    // STALE-01: 无 provider 注册（execute.ts 未加载）时心跳体携带默认空值
    expect(post.mock.calls[0][1].runningExecutionIds).toEqual([]);
    expect(post.mock.calls[0][1].deadLetterCount).toBe(0);
    // E9: 心跳体上报当前并发上限（与 admin 侧心跳白名单字段名配套）
    expect(post.mock.calls[0][1].maxConcurrentTasks).toBe(10);
    const callsBeforeReload = post.mock.calls.length;

    config.heartbeatIntervalSeconds = 6;
    config.maxConcurrentTasks = 4;
    await jest.advanceTimersByTimeAsync(6_000);
    expect(post.mock.calls.length).toBeGreaterThan(callsBeforeReload);
    // E9: /config/reload 热更后下个心跳即回传新值
    expect(post.mock.calls.at(-1)![1].maxConcurrentTasks).toBe(4);

    clearInterval(timer);
  });

  it('A7: reports diskUsage in the heartbeat body; statfs failure omits the field', async () => {
    jest.useFakeTimers();
    const os = require('os');
    const path = require('path');
    const { startHeartbeat } = require('./scheduler');
    const { config } = require('./config');

    const timer = startHeartbeat();
    const originalWorkDir = config.workDir;
    try {
      // 正常计量：workDir 指向真实存在的目录（statfs 可用）
      config.workDir = os.tmpdir();
      await jest.advanceTimersByTimeAsync(12_000);
      expect(post.mock.calls.length).toBeGreaterThan(0);
      const body = post.mock.calls.at(-1)![1];
      expect(typeof body.diskUsage).toBe('number');
      expect(body.diskUsage).toBeGreaterThanOrEqual(0);
      expect(body.diskUsage).toBeLessThanOrEqual(100);

      // 计量失败：workDir 不存在 → statfs ENOENT → null → `?? undefined`
      // → JSON 序列化丢键 =「未上报」（admin 保留 DB 旧值，不会伪装成 0%）
      config.workDir = path.join(os.tmpdir(), 'acf-no-such-workdir-a7');
      await jest.advanceTimersByTimeAsync(12_000);
      const failingBody = post.mock.calls.at(-1)![1];
      expect(failingBody.diskUsage).toBeUndefined();
    } finally {
      config.workDir = originalWorkDir;
      clearInterval(timer);
    }
  });

  it('reports registered running execution ids (E9-aligned cap) and dead-letter count in the heartbeat body', async () => {
    jest.useFakeTimers();
    const {
      startHeartbeat,
      registerRunningExecutionIdsProvider,
      registerDeadLetterCountProvider,
    } = require('./scheduler');
    registerRunningExecutionIdsProvider(() => [
      'exec-1',
      'exec-2',
      ...Array.from({ length: 250 }, (_, i) => `exec-${i}`),
    ]);
    registerDeadLetterCountProvider(() => 7);
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    expect(post.mock.calls.length).toBeGreaterThan(0);
    const body = post.mock.calls.at(-1)![1];
    // NETOPT-C P2-1: 上限与 E9（maxConcurrentTasks ≤10000）对齐——252 个在跑
    // 执行必须全量上报（旧 200 封顶会让第 201+ 个失去 stale-sweep 存活宽限）。
    expect(body.runningExecutionIds).toHaveLength(252);
    expect(body.deadLetterCount).toBe(7);

    // Providers may be re-registered (module reload) — latest wins.
    registerRunningExecutionIdsProvider(() => []);
    await jest.advanceTimersByTimeAsync(12_000);
    expect(post.mock.calls.at(-1)![1].runningExecutionIds).toEqual([]);

    clearInterval(timer);
  });

  it('NETOPT-D P3: truncates at the 10000 heartbeat cap and warns', async () => {    // 批次 C 把 cap 从 200 提到 10000 后，只证"上限>252"不足以防回退——
    // 钉死 10000 边界 + warn 分支（稳态不可达，属防御网，显式造 10001 条）。
    jest.useFakeTimers();
    const {
      startHeartbeat,
      registerRunningExecutionIdsProvider,
      registerDeadLetterCountProvider,
    } = require('./scheduler');
    registerRunningExecutionIdsProvider(() =>
      Array.from({ length: 10_001 }, (_, i) => `exec-${i}`),
    );
    registerDeadLetterCountProvider(() => 0);
    const warnSpy = jest
      .spyOn(require('./logger').logger, 'warn')
      .mockImplementation(() => undefined);
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    const body = post.mock.calls.at(-1)![1];
    expect(body.runningExecutionIds).toHaveLength(10_000);
    expect(body.runningExecutionIds[0]).toBe('exec-0');
    expect(body.runningExecutionIds[9_999]).toBe('exec-9999');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('runningExecutionIds exceeds heartbeat cap 10000'),
    );
    warnSpy.mockRestore();

    clearInterval(timer);
  });

  // E-01-RPT（生产实证：RPA5 在中台恒显「当前运行任务 1/10」「活性上报 0 条，
  // 与运行计数 1 不一致」，而设备上无任务在跑）：心跳必须上报 pull 预留槽位数。
  it('E-01-RPT: reports reservedSlots in the heartbeat body (always sent, incl. 0)', async () => {
    jest.useFakeTimers();
    const {
      startHeartbeat,
      registerPullReservedSlotsProvider,
      registerRunningExecutionIdsProvider,
    } = require('./scheduler');
    // 稳态：空闲 pull 执行器几乎始终在长轮询窗口内 → 1 个预留、0 条活性。
    // （provider 是粘性模块状态，上一用例注册的 10001 条 id 会残留，显式重置。）
    registerRunningExecutionIdsProvider(() => []);
    registerPullReservedSlotsProvider(() => 1);
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    const body = post.mock.calls.at(-1)![1];
    expect(body.reservedSlots).toBe(1);
    // 反证（生产现场的另一半）：同一份心跳里计数为 1、活性为空——这正是中台
    // 详情页判定「不一致」的输入。两个字段都必须存在，缺一不可。
    expect(body.runningTaskCount).toBe(1);
    expect(body.runningExecutionIds).toEqual([]);

    // 预留归还后必须回落 0（否则中台会把空闲执行器永久显示成占用）。
    registerPullReservedSlotsProvider(() => 0);
    await jest.advanceTimersByTimeAsync(12_000);
    expect(post.mock.calls.at(-1)![1].reservedSlots).toBe(0);

    clearInterval(timer);
  });

  it('E-01-RPT: 非法 provider 值收敛为 0，绝不因上报口径问题让心跳失败', async () => {
    // 反证用例：provider 抛错/返回非法值时若让心跳整体失败，admin 会判该执行器
    // OFFLINE——代价远大于少报一次预留数（与 collectInterpreters 同一取舍）。
    jest.useFakeTimers();
    const {
      startHeartbeat,
      registerPullReservedSlotsProvider,
      registerRunningExecutionIdsProvider,
    } = require('./scheduler');
    registerRunningExecutionIdsProvider(() => []);
    registerPullReservedSlotsProvider(() => {
      throw new Error('provider exploded');
    });
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    const body = post.mock.calls.at(-1)![1];
    expect(body.reservedSlots).toBe(0);
    // 心跳仍然发出（其余字段完好）。
    expect(body.runningExecutionIds).toEqual([]);

    // 非整数（脏上报）同样收敛为 0，而不是把 NaN 发给中台。
    registerPullReservedSlotsProvider(() => Number.NaN);
    await jest.advanceTimersByTimeAsync(12_000);
    expect(post.mock.calls.at(-1)![1].reservedSlots).toBe(0);

    clearInterval(timer);
  });

  // EXE-VER-1: 心跳体携带版本 + 版本漂移提醒（versionCompliant=false 时
  // 节流 warn，10 分钟一条；合规后自然静默）。
  it('reports EXECUTOR_VERSION in the heartbeat body', async () => {
    jest.useFakeTimers();
    const { startHeartbeat } = require('./scheduler');
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    expect(post.mock.calls.at(-1)![1].version).toBe('1.0.0');

    clearInterval(timer);
  });

  // 注：本用例需推进 >10 分钟假时钟（心跳间隔 1s → 600+ 拍异步 tick），
  // 单机空闲时 <1s，但在 CI 2 核/并发跑测时实测会突破 jest 默认 5s 上限
  // （表现：Exceeded timeout，而非断言失败）。故显式给足预算，避免假红。
  it('warns on versionCompliant=false (throttled to one per 10 min) and stays silent once compliant', async () => {
    jest.useFakeTimers();
    const { startHeartbeat, resetVersionDriftWarnStateForTest } = require('./scheduler');
    const { logger } = require('./logger');
    resetVersionDriftWarnStateForTest();
    post.mockResolvedValue({ data: { versionCompliant: false, minVersion: '1.3.0' } });
    const driftWarns = () =>
      logger.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('Version drift')).length;
    const timer = startHeartbeat();

    await jest.advanceTimersByTimeAsync(12_000);
    expect(driftWarns()).toBe(1);
    const firstWarn = logger.warn.mock.calls.find(
      (c: unknown[]) => String(c[0]).includes('Version drift'),
    )![0];
    expect(firstWarn).toContain('1.3.0');

    // 仍在节流窗内的心跳不重复告警
    await jest.advanceTimersByTimeAsync(60_000);
    expect(driftWarns()).toBe(1);

    // 超过 10 分钟节流窗 → 允许下一条
    await jest.advanceTimersByTimeAsync(10 * 60_000 + 15_000);
    expect(driftWarns()).toBe(2);

    // 响应恢复合规（versionCompliant 缺省/true）→ 不再告警
    post.mockResolvedValue({ data: {} });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(driftWarns()).toBe(2);

    clearInterval(timer);
  }, 30_000);

  // FR-13/FR-14（CONTRACT.md §2.3）：心跳体**始终**携带 interpreters 字段，
  // `[]` = 已上报且池为空，字段缺席 = 旧执行器（admin 按 ["3.12"] 兜底）。
  // 这个区分是调度的正确性前提：一个声明 3.12 的任务不得被派到池里没有 3.12
  // 的执行器上——若上报方"池空时干脆不报"，admin 的兜底值会把它伪装成有 3.12。
  it('always sends interpreters (empty array, never absent) — admin fallback semantics', async () => {
    jest.useFakeTimers();
    const { startHeartbeat } = require('./scheduler');

    // 无 provider 注册（池未探测/探测失败）→ 仍必须是空数组，而非 undefined。
    const timer = startHeartbeat();
    await jest.advanceTimersByTimeAsync(12_000);
    const body = post.mock.calls.at(-1)![1];
    expect(body).toHaveProperty('interpreters');
    expect(body.interpreters).toEqual([]);
    clearInterval(timer);
  });

  it('drops malformed interpreter entries instead of poisoning the whole inventory', async () => {
    jest.useFakeTimers();
    const { startHeartbeat, registerInterpretersProvider } = require('./scheduler');
    registerInterpretersProvider(async () => [
      {
        version: '3.12.1',
        path: '/pool/cpython-3.12.1/bin/python',
        available: true,
        discoveredAt: 't',
      },
      // 脏项：缺 version —— 若不过滤，admin 侧会因一项坏数据废掉整份清单
      { path: '/pool/whatever', available: true, discoveredAt: 't' },
      // 脏项：version 不是 X.Y[.Z]
      { version: 'v3.11', path: '/pool/x', available: true, discoveredAt: 't' },
    ]);
    const timer = startHeartbeat();
    await jest.advanceTimersByTimeAsync(12_000);
    const body = post.mock.calls.at(-1)![1];
    expect(body.interpreters).toHaveLength(1);
    expect(body.interpreters[0].version).toBe('3.12.1');
    clearInterval(timer);
    registerInterpretersProvider(async () => []);
  });

  // R3-B（部署模型评审 2026-10-23 §4.3/§P5）：心跳携带设备级应用版本事实。
  // 纯附加可选键——旧字段必须原样在场（不因新增键改既有字段与失败语义）。
  it('R3-B: reports deployedApps in the heartbeat body alongside intact legacy fields', async () => {
    jest.useFakeTimers();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { startHeartbeat } = require('./scheduler');
    const { config } = require('./config');
    const { resetDeployedAppsCacheForTest } = require('./deployed-apps');

    // deploy.ts 落盘形态的最小事实：apps/<appId>/current → releases/<releaseKey>
    // + app.json（见 deployed-apps.spec 的完整解析矩阵，此处只证心跳接线）。
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-r3b-hb-'));
    const appId = '11111111-1111-4111-8111-111111111111';
    const releaseKey = '1.2.3-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    fs.mkdirSync(path.join(workDir, 'apps', appId, 'releases', releaseKey), { recursive: true });
    fs.symlinkSync(
      path.join(workDir, 'apps', appId, 'releases', releaseKey),
      path.join(workDir, 'apps', appId, 'current'),
      'dir',
    );
    fs.writeFileSync(
      path.join(workDir, 'apps', appId, 'app.json'),
      JSON.stringify({
        runMode: 'daemon',
        lastVersion: '1.2.3',
        lastDeployedAt: '2026-10-23T10:00:00.000Z',
      }),
    );

    const originalWorkDir = config.workDir;
    resetDeployedAppsCacheForTest();
    try {
      config.workDir = workDir;
      const timer = startHeartbeat();
      await jest.advanceTimersByTimeAsync(12_000);
      const body = post.mock.calls.at(-1)![1];
      expect(body.deployedApps).toEqual([
        {
          appId,
          currentVersion: '1.2.3',
          currentReleaseKey: releaseKey,
          retainedVersions: ['1.2.3'],
          runMode: 'daemon',
          lastDeployedAt: '2026-10-23T10:00:00.000Z',
        },
      ]);
      // 旧字段不因新增键而缺席（粘性 provider/热更过的 config 值只断类型——
      // 它们由各自的既有用例钉死，这里只守「附加键不破坏既有 body」红线）。
      expect(body.address).toBe('localhost:8002');
      expect(body.version).toBe('1.0.0');
      expect(typeof body.cpuUsage).toBe('number');
      expect(typeof body.memUsage).toBe('number');
      expect(typeof body.runningTaskCount).toBe('number');
      expect(typeof body.reservedSlots).toBe('number');
      expect(typeof body.deadLetterCount).toBe('number');
      expect(typeof body.maxConcurrentTasks).toBe('number');
      expect(Array.isArray(body.runningExecutionIds)).toBe(true);
      expect(Array.isArray(body.interpreters)).toBe(true);
      expect(typeof body.restartedAt).toBe('string');
      expect(typeof body.startupId).toBe('string');
      clearInterval(timer);
    } finally {
      config.workDir = originalWorkDir;
      resetDeployedAppsCacheForTest();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  // fail-honest 红线（§4.3）：扫描失败 → 省略整键（JSON 序列化丢键 =「未上报」，
  // admin 保留旧值），绝不阻塞或弄挂心跳本体（对齐 A7 diskUsage 的失败语义）。
  it('R3-B: scan failure omits deployedApps but the heartbeat still goes out', async () => {
    jest.useFakeTimers();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { startHeartbeat } = require('./scheduler');
    const { config } = require('./config');
    const { resetDeployedAppsCacheForTest } = require('./deployed-apps');

    // apps/ 目录级不可读（普通文件占位 → ENOTDIR ≠ ENOENT → 扫描抛错）
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-r3b-hb-fail-'));
    fs.writeFileSync(path.join(workDir, 'apps'), 'not a directory');

    const originalWorkDir = config.workDir;
    resetDeployedAppsCacheForTest();
    try {
      config.workDir = workDir;
      const timer = startHeartbeat();
      await jest.advanceTimersByTimeAsync(12_000);
      const body = post.mock.calls.at(-1)![1];
      // 心跳本体照发，其余字段完好
      expect(body.address).toBe('localhost:8002');
      expect(typeof body.runningTaskCount).toBe('number');
      // deployedApps 为 undefined → JSON.stringify 丢键（A7 diskUsage 同款断言）
      expect(body.deployedApps).toBeUndefined();
      clearInterval(timer);
    } finally {
      config.workDir = originalWorkDir;
      resetDeployedAppsCacheForTest();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  // P10（executor 包版本收敛）：心跳携带已安装执行器包清单。键语义与
  // deployedApps 一致——[] 是「已上报且无安装包」的真事实；扫描失败省略整键。
  // 收集器扫 <cwd>/.pkg-updates/manifests，须重定向 cwd（真实 fs，非 mock）。
  it('P10: reports installedPackages in the heartbeat body (manifest fact source)', async () => {
    jest.useFakeTimers();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { startHeartbeat } = require('./scheduler');
    const { resetInstalledPackagesCacheForTest } = require('./installed-packages');

    // update-package.ts 落盘形态的最小事实：一个校验通过的 manifest
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-p10-hb-'));
    fs.mkdirSync(path.join(root, '.pkg-updates', 'manifests'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.pkg-updates', 'manifests', '11111111-1111-4111-8111-111111111111.json'),
      JSON.stringify({
        packageId: '11111111-1111-4111-8111-111111111111',
        name: 'node-runtime',
        type: 'node',
        version: '22.0.0',
        checksum: 'a'.repeat(64),
        downloadedAt: '2026-10-24T10:00:00.000Z',
      }),
    );

    const realCwd = process.cwd();
    resetInstalledPackagesCacheForTest();
    try {
      process.chdir(root);
      const timer = startHeartbeat();
      await jest.advanceTimersByTimeAsync(12_000);
      const body = post.mock.calls.at(-1)![1];
      expect(body.installedPackages).toEqual([
        { name: 'node-runtime', type: 'node', version: '22.0.0' },
      ]);
      // 附加键不破坏既有 body（R3-B 用例同款红线）
      expect(body.address).toBe('localhost:8002');
      expect(typeof body.runningTaskCount).toBe('number');
      expect(Array.isArray(body.deployedApps)).toBe(true);
      clearInterval(timer);
    } finally {
      process.chdir(realCwd);
      resetInstalledPackagesCacheForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // 空目录（无 manifests/）→ [] 是真事实：设备从未成功下载过执行器包。
  // 这个三态区分是 admin 侧「缺省 = 保留旧值」语义的前提，绝不能静默丢键。
  it('P10: empty manifests dir reports [] (reported-and-empty, not omitted)', async () => {
    jest.useFakeTimers();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { startHeartbeat } = require('./scheduler');
    const { resetInstalledPackagesCacheForTest } = require('./installed-packages');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-p10-hb-empty-'));
    const realCwd = process.cwd();
    resetInstalledPackagesCacheForTest();
    try {
      process.chdir(root);
      const timer = startHeartbeat();
      await jest.advanceTimersByTimeAsync(12_000);
      const body = post.mock.calls.at(-1)![1];
      expect(body).toHaveProperty('installedPackages');
      expect(body.installedPackages).toEqual([]);
      clearInterval(timer);
    } finally {
      process.chdir(realCwd);
      resetInstalledPackagesCacheForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // fail-honest 红线（§4.3，与 deployedApps 同款）：目录级扫描失败 → 省略整键
  // （manifests 父路径被普通文件占位 → ENOTDIR ≠ ENOENT → 扫描抛错），心跳照发。
  it('P10: scan failure omits installedPackages but the heartbeat still goes out', async () => {
    jest.useFakeTimers();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { startHeartbeat } = require('./scheduler');
    const { resetInstalledPackagesCacheForTest } = require('./installed-packages');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-p10-hb-fail-'));
    fs.writeFileSync(path.join(root, '.pkg-updates'), 'not a directory');
    const realCwd = process.cwd();
    resetInstalledPackagesCacheForTest();
    try {
      process.chdir(root);
      const timer = startHeartbeat();
      await jest.advanceTimersByTimeAsync(12_000);
      const body = post.mock.calls.at(-1)![1];
      // 心跳本体照发，其余字段完好
      expect(body.address).toBe('localhost:8002');
      expect(typeof body.runningTaskCount).toBe('number');
      // installedPackages 为 undefined → JSON.stringify 丢键（admin 保留旧值）
      expect(body.installedPackages).toBeUndefined();
      clearInterval(timer);
    } finally {
      process.chdir(realCwd);
      resetInstalledPackagesCacheForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
