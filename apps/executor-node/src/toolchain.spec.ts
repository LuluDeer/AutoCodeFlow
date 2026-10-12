/**
 * 运行时工具链解析（toolchain）回归测试。
 *
 * 本模块是"能力上报与任务执行口径分裂"缺陷的**收敛点**——把"本机有什么、
 * 能不能真的跑"从散落各处的硬编码收敛到一处。因此这里的每条断言都对应一个
 * 已被生产实证的静默失败形态，而非风格偏好。
 *
 * 刻意**全部注入**平台/宿主/探测器，使两类关键分支能在任意宿主（含 Linux CI）
 * 上被真实断言：
 *   1. **Electron 宿主形态**（桌面客户端）——原实现无法覆盖，是"node 虚报"
 *      长期潜伏的直接原因；
 *   2. **Windows Store 占位 stub**——文件存在但实跑必败，是本次生产事故的
 *      触发点。
 *
 * 注释写明"去掉这条断言会发生什么"，使后来者能判断它是否仍在守着一个真实
 * 风险，而不是可以顺手删掉的过时用例。
 */
import {
  buildToolchainForTest,
  cachedToolchain,
  describeToolchain,
  invalidateToolchain,
  isDesktopHost,
  nodeCandidates,
  npmCandidates,
  probeToolchain,
  pythonCandidates,
  usableHostPython,
  type ProbeResult,
} from './toolchain';

/** 构造"按候选名表回答"的探测桩；同时记录调用序列供优先级/短路断言使用。 */
function makeProbe(table: Record<string, string>): {
  probe: (cmd: string, args: string[], timeoutMs: number) => Promise<ProbeResult>;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const probe = async (
    cmd: string,
    args: string[],
    _timeoutMs: number,
  ): Promise<ProbeResult> => {
    calls.push({ cmd, args });
    const version = table[cmd];
    return version === undefined
      ? { ok: false, version: null }
      : { ok: true, version };
  };
  return { probe, calls };
}

/** 探测"退出 0 但没有版本串"——用来钉死"只判退出码"的宽松实现。 */
function probeOkWithoutVersion(
  table: Record<string, string>,
): (cmd: string, args: string[], timeoutMs: number) => Promise<ProbeResult> {
  return async (cmd: string): Promise<ProbeResult> => {
    if (table[cmd] === undefined) return { ok: false, version: null };
    return { ok: true, version: null };
  };
}

/** 一台"什么都有"的裸机（对照基线）。 */
const FULL_HOST: Record<string, string> = {
  python3: 'Python 3.12.4',
  node: 'v24.19.0',
  npm: '11.17.0',
  git: 'git version 2.43.0',
};

describe('isDesktopHost: Electron 判据', () => {
  // `null` 与 `undefined` 语义**相反**：null = 明确不在 Electron 里（自检断言
  // 裸机形态），undefined = 没指定、走真实探测。若实现用 `??` 折叠，两者会塌成
  // 同一分支，于是"裸机不得复用 Electron"这条断言在注入 null 时**假绿**。
  it('electronVersion=null → 非桌面（显式裸机）', () => {
    expect(isDesktopHost({ electronVersion: null })).toBe(false);
  });

  it('electronVersion 有值 → 桌面宿主', () => {
    expect(isDesktopHost({ electronVersion: '44.4.5' })).toBe(true);
  });

  it('electronVersion 为空串 → 非桌面（空串不是有效版本）', () => {
    expect(isDesktopHost({ electronVersion: '' })).toBe(false);
  });
});

describe('平台候选表：Windows 的真实差异', () => {
  // `py` 是 Windows 官方 launcher、**不是** Store 占位 alias。当 PATH 上的
  // python3/python 恰是 stub 而机器装了真 Python 时，它是唯一能落到真解释器的
  // 候选；去掉它，"装了 Python 却仍报无 python"这一半故障面会复发。
  it('win32 python 候选含 py（官方 launcher，非 Store alias）', () => {
    expect(pythonCandidates('win32')).toContain('py');
  });

  it('POSIX python 候选中不含 py（Windows 专有）', () => {
    expect(pythonCandidates('linux')).not.toContain('py');
  });

  // npm 在 Windows 是 .cmd 批处理包装，名字写错会直接 ENOENT。
  it('win32 npm 首选 npm.cmd；POSIX 首选 npm', () => {
    expect(npmCandidates('win32')[0]).toBe('npm.cmd');
    expect(npmCandidates('linux')[0]).toBe('npm');
  });

  it('win32 node 首选 node.exe（避免 PATHEXT 解析歧义）', () => {
    expect(nodeCandidates('win32')[0]).toBe('node.exe');
  });
});

describe('裸机形态：全 host、无 Electron 复用', () => {
  it('四项齐备且全部标记 host+verified', async () => {
    const { probe } = makeProbe(FULL_HOST);
    const tc = await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: probe },
    });

    for (const name of ['python', 'node', 'npm', 'git'] as const) {
      expect(tc[name].source).toBe('host');
      expect(tc[name].verified).toBe(true);
    }
  });

  it('裸机形态绝不标记 requiresElectronRunAsNode', async () => {
    const { probe } = makeProbe(FULL_HOST);
    const tc = await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: probe },
    });
    // 裸机没有 Electron 可复用；标记它会让调用方加上一个无意义的 env，
    // 掩盖"这台机器其实没有 node"的事实。
    expect(tc.node.requiresElectronRunAsNode).not.toBe(true);
  });
});

describe('桌面 + 无宿主 node → 复用 Electron（核心回归）', () => {
  // 宿主没有 node 但有 python/git（"装了 Python 的开发机没装 Node"）。
  const noNodeHost: Record<string, string> = {
    python3: 'Python 3.12.4',
    git: 'git version 2.43.0',
  };

  it('回落到 self 且 path 为 execPath', async () => {
    const { probe } = makeProbe(noNodeHost);
    const tc = await probeToolchain({
      deps: {
        platform: 'win32',
        electronVersion: '44.4.5',
        execPath: 'C:\\App\\AutoCodeFlow\\AutoCodeFlow Executor.exe',
        nodeVersion: '24.19.0',
        runProbe: probe,
      },
    });

    expect(tc.node.source).toBe('self');
    expect(tc.node.path).toBe('C:\\App\\AutoCodeFlow\\AutoCodeFlow Executor.exe');
    expect(tc.node.verified).toBe(true);
  });

  // 这是整条链上唯一能让"以 GUI 模式误启 Electron"被拦住的信息。若丢掉该标记，
  // 调用方会 spawn(execPath) 而**不**置 ELECTRON_RUN_AS_NODE，于是 Electron 试图
  // 开窗口而非跑脚本——任务挂死且没有任何错误输出（本次缺陷的下游表现）。
  it('必须标记 requiresElectronRunAsNode（否则 Electron 以 GUI 模式启动、任务无声挂死）', async () => {
    const { probe } = makeProbe(noNodeHost);
    const tc = await probeToolchain({
      deps: {
        platform: 'win32',
        electronVersion: '44.4.5',
        execPath: 'C:\\App\\AutoCodeFlow\\AutoCodeFlow Executor.exe',
        runProbe: probe,
      },
    });

    expect(tc.node.requiresElectronRunAsNode).toBe(true);
  });

  it('复用 Electron 不得影响 python 解析', async () => {
    const { probe } = makeProbe(noNodeHost);
    const tc = await probeToolchain({
      deps: {
        platform: 'win32',
        electronVersion: '44.4.5',
        execPath: 'C:\\App\\exec.exe',
        runProbe: probe,
      },
    });

    expect(usableHostPython(tc)?.path).toBe('python3');
  });
});

describe('宿主 node 可用时绝不切到 Electron（存量行为零变化）', () => {
  // 若实现改成"桌面一律用 Electron"，所有已装 Node 的现存执行器会在无任何通知
  // 的情况下换掉 node 版本语义（Electron 内置版本与用户安装的未必相同）——
  // 属于静默的行为回归。
  it('桌面宿主但宿主 node 可用 → 采用宿主与宿主版本', async () => {
    const { probe } = makeProbe({ ...FULL_HOST, node: 'v20.11.0' });
    const tc = await probeToolchain({
      deps: {
        platform: 'linux',
        electronVersion: '44.4.5',
        execPath: '/opt/app/electron',
        runProbe: probe,
      },
    });

    expect(tc.node.source).toBe('host');
    expect(tc.node.version).toBe('v20.11.0');
    expect(tc.node.requiresElectronRunAsNode).not.toBe(true);
  });
});

describe('Store 占位 stub：实跑验真而非存在性（核心回归）', () => {
  // 本缺陷的触发点：stub 的**文件名真实存在**、spawn 能命中，但实跑非零退出
  // （exit 9009）。任何基于存在性的实现都会把它当可用，失败被推迟到下游且
  // 归因困难。本组用"python3/python 不在表中（= 实跑失败）、py 在"来模拟。
  it('前两个候选实跑失败 → 跳过并回落到 py', async () => {
    const { probe } = makeProbe({
      py: 'Python 3.12.4',
      node: 'v24.19.0',
      'npm.cmd': '10.0.0',
      git: 'git version 2.43.0',
    });
    const tc = await probeToolchain({
      deps: { platform: 'win32', electronVersion: null, runProbe: probe },
    });

    expect(usableHostPython(tc)?.path).toBe('py');
    expect(tc.python.verified).toBe(true);
  });

  it('全部候选都是 stub → 如实报 none，绝不虚报', async () => {
    const { probe } = makeProbe({ node: 'v24.19.0', git: 'git version 2.43.0' });
    const tc = await probeToolchain({
      deps: { platform: 'win32', electronVersion: null, runProbe: probe },
    });

    expect(tc.python.source).toBe('none');
    expect(tc.python.verified).toBe(false);
    expect(usableHostPython(tc)).toBeNull();
  });

  // detail 不是装饰：它是用户唯一能看到的"为什么这台机器跑不了 python"。
  // 本缺陷最初的用户可见信息是一句与平台无关的 Store 英文提示，排障者无法判断
  // 是谁在调 python。要求 detail 含可检索关键词，使失败消息直接指向根因。
  it('缺失时 detail 必须可诊断（含 stub/python）', async () => {
    const { probe } = makeProbe({ node: 'v24.19.0' });
    const tc = await probeToolchain({
      deps: { platform: 'win32', electronVersion: null, runProbe: probe },
    });

    expect(tc.python.detail ?? '').toMatch(/stub|python/i);
  });
});

describe('候选优先级与短路', () => {
  // 多余探测不只是浪费：每次都是真实 spawn，串起来会拖慢注册路径
  // （5s 预算逐个累加）。
  it('python3 命中后立即短路，不再试 python/py', async () => {
    const { probe, calls } = makeProbe(FULL_HOST);
    await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: probe },
    });

    const pyCalls = calls.filter((c) => c.cmd === 'python3' || c.cmd === 'python');
    expect(pyCalls).toHaveLength(1);
    expect(pyCalls[0].cmd).toBe('python3');
  });

  it('探测参数必须是 --version（否则"实跑验真"名不副实）', async () => {
    const { probe, calls } = makeProbe(FULL_HOST);
    await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: probe },
    });

    const pyCall = calls.find((c) => c.cmd === 'python3');
    expect(pyCall?.args).toEqual(['--version']);
  });
});

describe('判据收紧与容错', () => {
  // 只判退出码的实现会把"退出 0 但不是解释器"的东西（包装脚本、rc 文件打印、
  // launcher 的用法提示）收下。要求同时解析出版本，代价为零而能挡住这一类。
  it('退出 0 但无版本串 → 判为不可用', async () => {
    const tc = await probeToolchain({
      deps: {
        platform: 'linux',
        electronVersion: null,
        runProbe: probeOkWithoutVersion(FULL_HOST),
      },
    });

    expect(tc.python.source).toBe('none');
  });

  it('探测全失败时仍返回结构完整的 Toolchain（不抛）', async () => {
    const { probe } = makeProbe({});
    const tc = await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: probe },
    });

    for (const name of ['python', 'node', 'npm', 'git'] as const) {
      expect(tc[name]).toMatchObject({ name, verified: false });
      expect(tc[name].source).toBe('none');
    }
  });
});

describe('describeToolchain：一行摘要且不泄露路径', () => {
  // 该摘要会进日志与诊断面。PATH 含用户名/目录结构（属环境指纹），且行长会
  // 污染日志；故只输出"来源 + 版本"。
  it('含四个工具名且不含路径分隔符', async () => {
    const { probe } = makeProbe(FULL_HOST);
    const tc = await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: probe },
    });

    const line = describeToolchain(tc);
    for (const name of ['python', 'node', 'npm', 'git']) {
      expect(line).toContain(name);
    }
    expect(line).not.toMatch(/[/\\]/);
  });
});

describe('缓存隔离：注入 deps 必须绕过全局缓存', () => {
  // "测试之间经由全局缓存串扰"会产生最难查的假绿：前一个用例写进缓存的值被
  // 后一个用例读到，于是断言在测缓存而不是测行为。故注入桩必须完全绕开缓存
  // （读与写都不做），否则真实注册路径还可能读到测试桩的结果。
  beforeEach(() => {
    invalidateToolchain();
  });

  it('第二次注入不同桩时得到第二次的结果（证明未读缓存）', async () => {
    const a = makeProbe({ python3: 'Python 3.12.4' });
    const first = await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: a.probe },
    });
    expect(first.python.source).toBe('host');

    const b = makeProbe({});
    const second = await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: b.probe },
    });
    expect(second.python.source).toBe('none');
  });

  it('注入路径绝不写入全局缓存（否则污染真实注册路径）', async () => {
    const { probe } = makeProbe(FULL_HOST);
    await probeToolchain({
      deps: { platform: 'linux', electronVersion: null, runProbe: probe },
    });

    expect(cachedToolchain()).toBeNull();
  });

  it('invalidateToolchain 后 cachedToolchain 返回 null', () => {
    invalidateToolchain();
    expect(cachedToolchain()).toBeNull();
  });
});

// ===========================================================================
// buildToolchainForTest：夹具不得说谎
// ===========================================================================
//
// 这个夹具是下游 spec（execute / deploy）声明"这台机器上有什么"的唯一入口。
// 它一旦能产出"不可用却自称已验真"的对象，下游断言的可信度就被污染——而且
// 是**假绿**方向（测试通过但语义错）。该缺陷由 execute.ts 工作流实测发现：
// 最初写法 `verified: given.verified ?? given.path !== undefined` 在
// `{source:'none', path:null}` 上会给出 `verified:true`。生产代码靠
// `!verified || !path` 双条件侥幸挡住，夹具仍必须自洽。
describe('buildToolchainForTest: verified 缺省必须与"真的可用"同构', () => {
  it('source=none + path=null → verified 必须为 false', () => {
    const tc = buildToolchainForTest({ node: { source: 'none', path: null } });
    expect(tc.node.source).toBe('none');
    expect(tc.node.verified).toBe(false);
  });

  it('source=none + 只给 detail → verified 必须为 false', () => {
    const tc = buildToolchainForTest({ python: { source: 'none', detail: '缺失' } });
    expect(tc.python.verified).toBe(false);
  });

  it('source=host + path → verified 缺省为 true', () => {
    const tc = buildToolchainForTest({ node: { source: 'host', path: 'node' } });
    expect(tc.node.verified).toBe(true);
  });

  it('未声明的工具一律 none 且未验真（不假设机器上有什么）', () => {
    const tc = buildToolchainForTest({ node: { source: 'host', path: 'node' } });
    for (const name of ['python', 'npm', 'git'] as const) {
      expect(tc[name]).toMatchObject({ source: 'none', verified: false, path: null });
    }
  });

  it('显式 verified 优先于缺省推导（允许刻意构造异常夹具）', () => {
    const tc = buildToolchainForTest({
      node: { source: 'host', path: 'node', verified: false },
    });
    expect(tc.node.verified).toBe(false);
  });

  it('usableHostPython 对 none 夹具必须返回 null', () => {
    const tc = buildToolchainForTest({ python: { source: 'none', path: null } });
    // 下游 execute.ts 的 Store stub 防线依赖这一条：none 必须推不出"可用宿主
    // python"，否则无版本任务会拿到一个假解释器。
    expect(usableHostPython(tc)).toBeNull();
  });
});
