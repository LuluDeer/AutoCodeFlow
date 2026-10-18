/**
 * PLAN-EXECUTOR-DESKTOP-UX 5.1：健康检查面板的纯函数行为闸。
 *
 * 断言风格照抄 export-flows.selftest.ts 的 5.2 段：**打在序列化结果上**
 * （`JSON.stringify(panel)`），而不是逐字段挑着断言——逐字段会漏掉未来新增
 * 的字段，只有整串检查才能兜住"新加了一个 values 把路径/凭据带出去"。
 */
import * as assert from 'assert';
import {
  HEALTH_DISK_CRITICAL_BYTES,
  HEALTH_DISK_WARN_BYTES,
  adminRegistrationState,
  buildHealthPanel,
  diagnosticWorkDirDisplay,
  diskStateFromFreeBytes,
  diskUsedPercent,
  executorState,
  heartbeatState,
  projectHealthInputs,
  pythonState,
  summarizeHealthRows,
  workDirState,
  type HealthPanelReport,
} from './health-panel';

type Sections = HealthPanelReport['sections'];

function report(
  overrides: {
    runtime?: Partial<Sections['runtime']>;
    health?: Partial<Sections['health']>;
    workDir?: Partial<Sections['workDir']>;
  } = {},
): HealthPanelReport {
  return {
    sections: {
      runtime: {
        appVersion: '1.9.0',
        electronVersion: '44.4.5',
        nodeVersion: '24.21.0',
        platform: 'win32',
        arch: 'x64',
        ...overrides.runtime,
      },
      health: {
        executorStatus: 'online',
        executorRunning: true,
        localHealthLive: true,
        adminRegistration: 'registered',
        heartbeatStatus: 'ok',
        executorPort: 8002,
        ...overrides.health,
      },
      workDir: {
        path: 'C:\\Users\\real-name\\AppData\\Roaming\\acf\\tasks',
        exists: true,
        writable: true,
        probeError: null,
        freeBytes: 50 * 1024 * 1024 * 1024,
        totalBytes: 500 * 1024 * 1024 * 1024,
        freeHuman: '50.00 GB',
        ...overrides.workDir,
      },
    },
  };
}

function main(): void {
  // ── 1. 三个纯映射函数的状态判定 ──────────────────────────────────────
  {
    assert.strictEqual(adminRegistrationState('registered'), 'ok');
    assert.strictEqual(adminRegistrationState('failed'), 'bad');
    // 'unknown' 是旧 bundle 无该端点的正常态 → warn（不谎报失败）
    assert.strictEqual(adminRegistrationState('unknown'), 'warn');
    assert.strictEqual(adminRegistrationState(null), 'unknown');
    assert.strictEqual(adminRegistrationState('  REGISTERED  '), 'ok', '大小写/空白不敏感');

    assert.strictEqual(heartbeatState('ok'), 'ok');
    assert.strictEqual(heartbeatState('online'), 'ok');
    assert.strictEqual(heartbeatState('failed'), 'bad');
    assert.strictEqual(heartbeatState(undefined), 'unknown');

    // 本地 /health/live 是最硬的证据，压过 status 字段
    assert.strictEqual(executorState(true, 'offline', true), 'ok', '/health/live=true 压过 status');
    assert.strictEqual(executorState(true, 'online', false), 'bad', '/health/live=false 压过 status');
    assert.strictEqual(executorState(false, 'stopped', null), 'unknown', '未运行不是"失败"');
    assert.strictEqual(executorState(true, 'pending', null), 'warn');
  }

  // ── 2. 工作目录可写性：不存在 = bad（不是 unknown）─────────────────────
  {
    assert.strictEqual(workDirState(true, true), 'ok');
    assert.strictEqual(workDirState(false, true), 'bad');
    assert.strictEqual(workDirState(false, false), 'bad');
    // writable 未探测但目录明确不存在，仍旧是 bad
    assert.strictEqual(workDirState(null, false), 'bad');
    assert.strictEqual(workDirState(null, null), 'unknown');
  }

  // ── 3. Python：与设置页诊断块同一套判据 ──────────────────────────────
  {
    const base = { uvPath: null, uvSource: 'path' as const, uvFromSystemEnv: false, poolEntries: [], poolReadable: true };
    assert.strictEqual(pythonState(null), 'unknown', '旧 preload 无通道 → unknown，不谎报缺失');
    assert.strictEqual(pythonState({ ...base, uvPath: 'C:\\uv\\uv.exe', uvSource: 'config' }), 'ok');
    // 配了路径但文件用不了 → bad（"配了却没生效"必须可见）
    assert.strictEqual(
      pythonState({ ...base, uvPath: 'C:\\nope\\uv.exe', uvSource: 'config', uvConfiguredButMissing: true }),
      'bad',
    );
    assert.strictEqual(pythonState({ ...base, uvFromSystemEnv: true }), 'ok');
    // 只能运行时从 PATH 兜底 → warn（**不是** bad，见 UX-DSK-UV 注释）
    assert.strictEqual(pythonState({ ...base, uvStaticallyConfirmed: false }), 'warn');
    assert.strictEqual(pythonState({ ...base }), 'bad');
  }

  // ── 4. 磁盘：不可用值必须归 unknown，绝不假报 0 字节 ──────────────────
  {
    assert.strictEqual(diskStateFromFreeBytes(50 * 1024 ** 3), 'ok');
    assert.strictEqual(diskStateFromFreeBytes(HEALTH_DISK_WARN_BYTES - 1), 'warn');
    assert.strictEqual(diskStateFromFreeBytes(HEALTH_DISK_CRITICAL_BYTES - 1), 'bad');
    for (const bad of [null, undefined, NaN, -1, Infinity] as const) {
      assert.strictEqual(
        diskStateFromFreeBytes(bad as number | null),
        'unknown',
        `5.1: ${String(bad)} 必须归 unknown（"读不到"≠"空间是 0"）`,
      );
    }
    assert.strictEqual(diskUsedPercent(50, 100), 50);
    assert.strictEqual(diskUsedPercent(0, 100), 100);
    for (const [f, t] of [[null, 100], [50, null], [NaN, 100], [50, 0], [200, 100]] as const) {
      assert.strictEqual(diskUsedPercent(f, t), null, `5.1: 脏数据 ${String(f)}/${String(t)} → null`);
    }
  }

  // ── 5. 路径脱敏：只保留末两段（这是本面板唯一可能带出绝对路径的地方）──
  {
    assert.strictEqual(
      diagnosticWorkDirDisplay('C:\\Users\\real-name\\AppData\\Roaming\\acf\\tasks'),
      '…/acf/tasks',
      '5.1: 工作目录展示值必须去掉用户名等上层路径',
    );
    assert.strictEqual(diagnosticWorkDirDisplay('/home/alice/work/dir'), '…/work/dir');
    assert.strictEqual(diagnosticWorkDirDisplay('E:\\tasks'), 'E:\\tasks', '单段目录带盘符一起显示（盘符是卷根不是路径段）');
    assert.strictEqual(diagnosticWorkDirDisplay('E:\\tasks\\'), 'E:\\tasks', '尾部分隔符不得影响切分');
    assert.strictEqual(diagnosticWorkDirDisplay('E:\\apps\\tasks'), '…/apps/tasks');
    assert.strictEqual(diagnosticWorkDirDisplay('C:\\'), null, '裸卷根没有可辨识目录 → null');
    assert.strictEqual(diagnosticWorkDirDisplay('tasks'), 'tasks');
    assert.strictEqual(diagnosticWorkDirDisplay(''), null);
    assert.strictEqual(diagnosticWorkDirDisplay(null), null);
  }

  // ── 6. buildHealthPanel：行齐全 + 汇总正确 ────────────────────────────
  {
    const panel = buildHealthPanel(
      report(),
      { uvPath: 'C:\\uv\\uv.exe', uvSource: 'config', uvFromSystemEnv: false, poolEntries: ['cpython-3.11'], poolReadable: true },
      { ok: true, message: '连接成功（HTTP 200）' },
    );
    assert.strictEqual(panel.rows.length, 8, '5.1: 面板必须是 8 行固定表');
    assert.deepStrictEqual(
      panel.rows.map((r) => r.id),
      ['adminApi', 'executor', 'adminReg', 'heartbeat', 'python', 'node', 'workDir', 'disk'],
      '5.1: 行顺序必须稳定（渲染层按序出）',
    );
    assert.strictEqual(panel.summary.overall, 'ok');
    assert.strictEqual(panel.summary.ok, 8);
    assert.strictEqual(panel.summary.bad, 0);
    // Node 版本来自诊断报告（主进程注入），不是渲染层自报
    const node = panel.rows.find((r) => r.id === 'node')!;
    assert.strictEqual(node.state, 'ok');
    assert.deepStrictEqual(node.args, ['24.21.0'], '5.1: Node 行必须带报告里的真实版本');
    // 执行器行带端口
    const exec = panel.rows.find((r) => r.id === 'executor')!;
    assert.deepStrictEqual(exec.detailArgs, [8002], '5.1: 执行器行必须带端口');
  }

  // ── 7. 整体判定优先级：bad > warn > unknown > ok ──────────────────────
  {
    const panel = buildHealthPanel(
      report({
        workDir: { freeBytes: HEALTH_DISK_CRITICAL_BYTES - 1 },
        health: { adminRegistration: 'failed' },
      }),
      null,
      { ok: false, message: 'connect ECONNREFUSED' },
    );
    assert.strictEqual(panel.summary.overall, 'bad');
    assert.ok(panel.summary.bad >= 3, '5.1: 三处失败必须各计一行（不得合并掩盖）');

    const warnOnly = buildHealthPanel(
      report({ health: { adminRegistration: 'unknown', localHealthLive: null, executorStatus: 'pending' } }),
      { uvPath: null, uvSource: 'path', uvFromSystemEnv: false, poolEntries: [], poolReadable: true, uvStaticallyConfirmed: false },
      { ok: true, message: '' },
    );
    assert.strictEqual(warnOnly.summary.overall, 'warn', '5.1: 只有 warn 时整体为 warn');
    assert.strictEqual(warnOnly.summary.bad, 0);

    // 全 unknown → overall unknown（而不是谎报 ok）
    const allUnknown = buildHealthPanel(null, null, null);
    assert.strictEqual(allUnknown.summary.overall, 'unknown');
    assert.strictEqual(allUnknown.summary.ok, 0);
    assert.strictEqual(allUnknown.rows.length, 8, '5.1: 无数据时仍出 8 行（unknown 行，不是空面板）');
  }

  // ── 8. 绝不抛错：畸形载荷一律降级 ────────────────────────────────────
  {
    for (const bad of [null, undefined, {} as any, { sections: null } as any]) {
      const panel = buildHealthPanel(bad, null, null);
      assert.strictEqual(panel.rows.length, 8, '5.1: 畸形报告不得让面板崩');
    }
    // projectHealthInputs 同样不得抛
    for (const bad of [null, undefined, {} as any, { sections: null } as any]) {
      const projected = projectHealthInputs(bad);
      assert.strictEqual(projected.runtime, null);
      assert.strictEqual(projected.health, null);
      assert.strictEqual(projected.workDir, null);
    }
  }

  // ── 9. 脱敏：序列化结果里不得出现绝对路径 / 用户名字段 ────────────────
  // 断言打在整份序列化结果上（照抄 5.2 的断言风格）：逐字段会漏掉未来新增字段。
  {
    const panel = buildHealthPanel(
      report(),
      { uvPath: 'C:\\uv\\uv.exe', uvSource: 'config', uvFromSystemEnv: false, poolEntries: [], poolReadable: true },
      { ok: true, message: 'ok' },
    );
    const serialized = JSON.stringify(panel);
    for (const leak of ['C:\\Users\\real-name', 'C:\\\\Users', 'real-name', 'C:\\uv']) {
      assert.ok(
        !serialized.includes(leak),
        `5.1 路径泄漏：「${leak}」出现在了面板数据里 —— 面板是常驻界面，绝对路径会进截图/工单`,
      );
    }
    // 末两段仍在（脱敏不得把可辨识性也一起砍掉）
    assert.ok(serialized.includes('acf/tasks'), '5.1: 末两段路径必须保留（否则用户认不出是哪个目录）');
    // uvPath 同理：只留末两段（uv.exe 是文件名，保留它才认得出是哪个可执行文件）
    const python = panel.rows.find((r) => r.id === 'python')!;
    assert.strictEqual(python.state, 'ok', '5.1: uvPath 可用时 Python 行仍是 ok（脱敏不改判定）');
    assert.deepStrictEqual(python.args, ['…/uv/uv.exe'], '5.1: uvPath 必须只显示末两段');
  }

  // ── 10. 运行期报告的形状投影：只放行三段，config/recentLogs 不过桥 ────
  {
    const projected = projectHealthInputs(report());
    const serialized = JSON.stringify(projected);
    assert.ok(serialized.includes('24.21.0'), 'projectHealthInputs 必须保留 runtime 段');
    assert.ok(serialized.includes('8002'), 'projectHealthInputs 必须保留 health 段');
    assert.ok(
      !serialized.includes('recentLogs') && !serialized.includes('sections.config'),
      '5.1: 面板投影不得携带 config / recentLogs 段（额外暴露面）',
    );
  }

  console.log('[selftest] health-panel: OK (8 行映射 / 状态判定优先级 / 路径脱敏 / 畸形载荷降级)');
}

main();
