/**
 * 运行能力探测（runtime-detection）回归测试。
 *
 * 覆盖的每一条都对应一个**真实爆过的缺陷**或关键契约：
 *   1. Windows 上 `which` 不存在导致 python 能力永远探测不到（desktop-v1.5.x
 *      实爆：客户端只上报 `shell,node`，而任务 runtime 缺省是 python，
 *      结果是"注册成功但任务永远派不过来"）；
 *   2. 自带 uv 必须算作 Python 能力（客户端"通用执行器"的核心能力正是靠
 *      uv 按 runtimeVersion 获取解释器）——**且本次修复后这条才真正成立**：
 *      无版本任务也会经 uv 取默认版本 3.12（见 execute.ts 的默认版本兜底），
 *      故 uv 通道不再是"上报但兑现不了"的谎话；
 *   3. `type` 必须与 capabilities **同源**——不能出现"后台显示通用、却因
 *      capabilities 缺 python 而派不到任务"的错配；
 *   4. 探测失败必须降级而**绝不抛**（能力少报只影响派发，抛异常会让整台
 *      执行器注册不上，严重得多）。
 */
import {
  detectRuntimes,
  detectRuntimesOnHost,
  reportedExecutorType,
  probePythonExecutable,
  hasSystemPython,
  type ReportedRuntime,
} from './runtime-detection';
import { runCommand } from './run-command';
import {
  buildToolchainForTest,
  seedToolchainForTest,
  invalidateToolchain,
} from './toolchain';

jest.mock('./run-command');

const mockRunCommand = runCommand as jest.MockedFunction<typeof runCommand>;

beforeEach(() => {
  jest.clearAllMocks();
  // 工具链缓存是模块级 TTL 缓存：不重置会让"这台机器有没有 python"取决于
  // 前一个用例（缓存串扰型假绿，toolchain.seedToolchainForTest 注释同义）。
  invalidateToolchain();
});

describe('detectRuntimes: python 判定（双通道）', () => {
  it('shell 与 node 恒定存在，且顺序稳定', () => {
    const r = detectRuntimes({ hasUv: false, isPythonExecutable: () => false });
    expect(r).toEqual(['shell', 'node']);
  });

  it('系统 python 可用 → 追加 python', () => {
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: (c) => c === 'python3',
    });
    expect(r).toContain('python');
  });

  it('只有 python（无 python3，Windows 常见）也算可用', () => {
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: (c) => c === 'python',
    });
    expect(r).toContain('python');
  });

  // 核心回归：自带 uv 即可获取解释器 → 具备 Python 能力。
  //
  // ⚠ 这条断言在本次修复后才**名副其实**（勿"顺手清理"这个捷径）：
  // 修复前 uv 通道只覆盖声明了 `runtimeVersion` 的任务，而无版本任务（runtime
  // 缺省 python、runtimeVersion 可空）在执行侧要求**宿主解释器**，且 admin 对
  // 无声明版本的任务不做过器过滤（`interpreterSatisfies` 恒 true）——于是
  // "上报 python"与"能跑无版本 python 任务"是两回事，干净桌面机必然失败
  // （生产事故：Microsoft Store "Python was not found"）。
  // 修复后 `routes/execute.ts` 在"无版本 + 无宿主解释器"时会经 uv 取
  // `DEFAULT_PYTHON_VERSION`（3.12），uv 通道对无版本任务也兑现得起。
  it('无系统 python 但有自带 uv → 仍然具备 python 能力（默认版本兜底使其可兑现）', () => {
    const r = detectRuntimes({ hasUv: true, isPythonExecutable: () => false });
    expect(r).toContain('python');
  });

  // 诚实边界（决策留痕）：uv 在、但当下（无网 + 池空 + 无宿主解释器）什么都取不到
  // 时**仍然上报 python**。理由见 detectRuntimes 注释：
  //   1) 能力 ≠ 瞬时可达性——注册瞬间取不到不代表随后取不到（恢复网络/离线预填），
  //      按"此刻取不到"剔除会让本可自愈的机器永远收不到任务，且**没有失败反馈**；
  //   2) admin 调度契约里没有"能否获取"这一维度（AC-06c：只有执行器说得清），
  //      "无声明版本"分支干脆不拦截；
  //   3) 失败形态已质变——不再是静默 stub/ENOENT，而是一条带池快照的
  //      `interpreter_unavailable`，可被改派/预填修复。
  // 反证：把 detectRuntimes 的 `|| input.hasUv` 去掉，本用例立即转红。
  it('uv 在但当下什么都取不到 → 仍上报 python（"会尝试且失败必精确归因"，非静默假成功）', () => {
    const r = detectRuntimes({ hasUv: true, isPythonExecutable: () => false });
    expect(r).toEqual(['shell', 'node', 'python']);
    // 不作为量纲：真正的兑现能力由 execute.ts 的默认版本兜底在运行时回答。
    expect(reportedExecutorType(r)).toBe('universal');
  });

  it('既无系统 python 也无 uv → 不含 python', () => {
    const r = detectRuntimes({ hasUv: false, isPythonExecutable: () => false });
    expect(r).not.toContain('python');
  });

  it('判定函数抛异常时视为不可用（绝不冒泡）', () => {
    expect(() =>
      detectRuntimes({
        hasUv: false,
        isPythonExecutable: () => {
          throw new Error('EACCES');
        },
      }),
    ).not.toThrow();
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: () => {
        throw new Error('EACCES');
      },
    });
    expect(r).toEqual(['shell', 'node']);
  });
});

describe('reportedExecutorType: 与 capabilities 同源', () => {
  it('具备 python → universal（桌面客户端形态）', () => {
    expect(reportedExecutorType(['shell', 'node', 'python'])).toBe('universal');
  });

  it('不具备 python → node（如实降级，不虚报通用）', () => {
    expect(reportedExecutorType(['shell', 'node'])).toBe('node');
  });

  it('永不返回 python 档（本客户端始终带 node/shell 执行面）', () => {
    const all: ReportedRuntime[][] = [
      ['shell', 'node'],
      ['shell', 'node', 'python'],
      ['python'],
    ];
    for (const r of all) {
      expect(reportedExecutorType(r)).not.toBe('python');
    }
  });

  // 关键契约：type 与 capabilities 由同一份 runtimes 推导，不允许错配。
  it('type 与 capabilities 始终一致（无"显示通用却派不到 python"错配）', () => {
    for (const hasUv of [true, false]) {
      for (const hasPy of [true, false]) {
        const runtimes = detectRuntimes({
          hasUv,
          isPythonExecutable: () => hasPy,
        });
        const type = reportedExecutorType(runtimes);
        const claimsPython = runtimes.includes('python');
        expect(type === 'universal').toBe(claimsPython);
      }
    }
  });
});

describe('probePythonExecutable: 实跑探测而非 which', () => {
  it('退出码 0 → 可用', async () => {
    mockRunCommand.mockResolvedValue({ status: 0, stdout: 'Python 3.12.0', stderr: '' });
    await expect(probePythonExecutable('python3')).resolves.toBe(true);
  });

  // 核心回归：原实现用 which，Windows 上 spawnSync 返回 ENOENT（status=null），
  // 只判 status===0 会把它当"不可用"；实跑探测对不存在命令同样返回 false，
  // 但对**存在**的命令能正确识别——两者的差别在 hasSystemPython 的短路行为。
  it('命令不存在（ENOENT → status null）→ 不可用，且不抛', async () => {
    mockRunCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'spawn python3 ENOENT' });
    await expect(probePythonExecutable('python3')).resolves.toBe(false);
  });

  it('非 0 退出码 → 不可用', async () => {
    mockRunCommand.mockResolvedValue({ status: 1, stdout: '', stderr: 'boom' });
    await expect(probePythonExecutable('python')).resolves.toBe(false);
  });

  it('绝不调用 which（回归：Windows 无 which）', async () => {
    mockRunCommand.mockResolvedValue({ status: 0, stdout: '', stderr: '' });
    await probePythonExecutable('python3');
    for (const call of mockRunCommand.mock.calls) {
      expect(call[0]).not.toBe('which');
    }
  });
});

describe('hasSystemPython: 候选优先级与短路', () => {
  it('python3 命中即不再试 python', async () => {
    mockRunCommand.mockResolvedValue({ status: 0, stdout: '', stderr: '' });
    await expect(hasSystemPython()).resolves.toBe(true);
    expect(mockRunCommand).toHaveBeenCalledTimes(1);
    expect(mockRunCommand.mock.calls[0][0]).toBe('python3');
  });

  it('python3 失败则回落 python', async () => {
    mockRunCommand
      .mockResolvedValueOnce({ status: null, stdout: '', stderr: 'ENOENT' })
      .mockResolvedValueOnce({ status: 0, stdout: '', stderr: '' });
    await expect(hasSystemPython()).resolves.toBe(true);
    expect(mockRunCommand).toHaveBeenCalledTimes(2);
    expect(mockRunCommand.mock.calls[1][0]).toBe('python');
  });

  it('两者都失败 → false', async () => {
    mockRunCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'ENOENT' });
    await expect(hasSystemPython()).resolves.toBe(false);
  });
});

// ===========================================================================
// node 能力：从"自证"改为"实跑真值"（本次架构改造的核心回归）
// ===========================================================================
//
// 背景（生产实证的静默失败）：本模块过去把 node 当**恒定自证**——"本进程就运行
// 在 Node.js 里"。该推理在桌面端**不成立**：那里 executor-node 由 Electron 以
// ELECTRON_RUN_AS_NODE=1 启动，process.execPath 是 Electron 而非系统 node，且
// 任务侧当时硬编码裸 `node.exe`。于是一台没装 Node.js 的机器照样上报 node 能力，
// 中台据此持续派发 node 任务，任务在 spawn 时 ENOENT。
//
// 现在 node 是否上报由 `toolchain.ts` 的**实跑结论**决定（它已把"Electron 自身可
// 复用"也算作可用，故桌面形态仍如实上报——任务确实能跑）。
describe('detectRuntimes: node 能力由实跑真值决定（不再自证）', () => {
  it('nodeAvailable=false → 不上报 node（修掉虚报）', () => {
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: () => false,
      nodeAvailable: false,
    });
    // 这是本次修复的**核心断言**：去掉 detectRuntimes 里的 nodeAvailable 分支
    // 后本用例立即转红。
    expect(r).not.toContain('node');
    // shell 仍恒在（cmd.exe/bash 由系统提供，无需探测）。
    expect(r).toContain('shell');
  });

  it('nodeAvailable=true → 上报 node（桌面端 Electron 可复用形态）', () => {
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: () => false,
      nodeAvailable: true,
    });
    expect(r).toContain('node');
  });

  it('未传 nodeAvailable → 保持旧语义（兼容既有调用方，不破坏存量）', () => {
    const r = detectRuntimes({ hasUv: false, isPythonExecutable: () => false });
    expect(r).toContain('node');
  });

  it('node 不可用不影响 python/shell 判定（能力面互相独立）', () => {
    const r = detectRuntimes({
      hasUv: false,
      isPythonExecutable: (c) => c === 'python3',
      nodeAvailable: false,
    });
    expect(r).toEqual(['shell', 'python']);
  });
});

// ===========================================================================
// detectRuntimesOnHost：生产入口（消费 toolchain 的实跑结论 + uv 通道）
//
// 与本次修复的耦合：桌面客户端形态是「宿主没有 Python、但自带 uv」。这正是
// 事故发生的那台机器。修复前它上报 python 却跑不了无版本任务；修复后 execute.ts
// 会用 uv 取默认版本 3.12，于是这条上报成为真话——本组用例把该推理钉在
// **生产入口**这一层（detectRuntimes 纯函数层的用例只覆盖了 hasUv 入参）。
// ===========================================================================
describe('detectRuntimesOnHost: 干净桌面机（无宿主 python + 自带 uv）仍上报 python', () => {
  it('toolchain 判 python 不可用 + hasUv → python 照常上报（默认版本兜底使其可兑现）', async () => {
    seedToolchainForTest(
      buildToolchainForTest({
        python: { source: 'none', path: null, verified: false },
        node: { source: 'self', path: '/opt/electron', verified: true },
      }),
    );
    const r = await detectRuntimesOnHost({ hasUv: true });
    expect(r).toContain('python');
    // 与 capabilities 同源推导：后台显示 universal，而非"显示通用却派不到"。
    expect(reportedExecutorType(r)).toBe('universal');
  });

  it('toolchain 判 python 不可用 + 无 uv → 如实剔除 python（不虚报）', async () => {
    seedToolchainForTest(
      buildToolchainForTest({
        python: { source: 'none', path: null, verified: false },
        node: { source: 'self', path: '/opt/electron', verified: true },
      }),
    );
    // hasSystemPython 走真实探测：mock 的 runCommand 默认应答不出版本 → false。
    mockRunCommand.mockResolvedValue({ status: null, stdout: '', stderr: 'ENOENT' });
    const r = await detectRuntimesOnHost({ hasUv: false });
    expect(r).not.toContain('python');
    expect(reportedExecutorType(r)).toBe('node');
  });
});

// ===========================================================================
// 源码守卫：候选表必须**派生**自 toolchain（防跨平台漂移）
// ===========================================================================
//
// 为什么必须是源码守卫而不是行为断言：实测踩过的坑是本模块硬编码
// `['python3','python']`，而 toolchain 的 win32 表是 `['python3','python','py']`。
// 两份表**已经漂移**——后果是同一台 Windows 机器上"能力上报"与"任务执行"可能给
// 出相反结论（PATH 里的 python3/python 恰好都是 Store 占位 stub、而机器其实装了
// 真 Python 时，只有走 toolchain 的那条路能回落到 `py` 得救）。
//
// ⚠️ 行为断言在 Linux CI 上**抓不到**这个漂移：本机 `process.platform !== 'win32'`，
// 硬编码值与派生值恰好相同，于是"把字面量写回去"这个回退动作会**静默通过**。
// 这正是本次实测发现的假绿（写了同义反复的用例 → 变异存活）。故改为直接在源码层
// 面钉死：候选表**不得**出现硬编码字面量数组。
//
// 必须先剥掉注释行：本文件的注释刻意引用了"漂移前长什么样"（把事故现场留在代码里
// 便于追溯），不剥注释会让守卫被自己的说明文字绊倒（同类教训见 `zip-safety.spec.ts`
// 与 `python-venv.spec.ts` 的源码守卫）。
describe('源码守卫：runtime-detection 的候选表必须派生自 toolchain', () => {
  async function sourceWithoutComments(): Promise<string> {
    const fsMod = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const src = await fsMod.readFile(
      pathMod.resolve(process.cwd(), 'src/runtime-detection.ts'),
      'utf-8',
    );
    return src
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
  }

  it('不得硬编码 python 候选字面量数组', async () => {
    const code = await sourceWithoutComments();
    // 反向断言：出现 `['python3', 'python']`（或含 py 的变体）即视为回退。
    expect(code).not.toMatch(/\[\s*'python3'\s*,\s*'python'/);
  });

  it('必须通过 pythonCandidates(process.platform) 派生', async () => {
    const code = await sourceWithoutComments();
    expect(code).toContain('pythonCandidates(process.platform)');
  });
});
