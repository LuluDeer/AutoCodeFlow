/**
 * 运行时工具链解析 —— **单一真值源**（桌面执行器自包含改造的架构核心）。
 *
 * ## 为什么需要这个模块
 *
 * 桌面执行器（Electron 内嵌 spawn executor-node）暴露过一个**架构级**缺陷：
 * **能力上报与任务执行是两套代码、两个真值源**。
 *
 *   - 能力上报（`runtime-detection.ts`）把 `node` 当"自证"（本进程跑在 Node 里）、
 *     把 python 判为"系统 python **或**自带 uv"，再据此推导 `type` / `capabilities`；
 *   - 任务执行（`routes/execute.ts` / `routes/deploy.ts`）却各自硬编码裸命令名
 *     （`node.exe` / `python` / `python3`），各自按宿主 PATH 解析。
 *
 * 于是"上报的"与"实际能兑现的"可以互不一致，而且**双方都不会报错**。三个已被
 * 生产/源码实证的具体形态：
 *
 *   1. **node 虚报**：桌面端 executor-node 由 `process.execPath` +
 *      `ELECTRON_RUN_AS_NODE=1` 启动（`executor-process.ts`），那个 exe 是
 *      **Electron、不是系统 node**；打包内也没有 node.exe，且无人把 Electron
 *      目录塞进子进程 PATH。于是一台**没装 Node.js** 的机器仍然上报 `node`
 *      能力（自证），任务却在 `spawn node.exe` 时 ENOENT —— 中台会持续往这台
 *      机器派 node 任务，因为派发只信 `capabilities`。
 *   2. **python 无版本路径落宿主 stub**：无版本任务的兜底是宿主 `python.exe`。
 *      Windows 上该名字很可能是 Microsoft Store 的 **App Execution Alias
 *      占位 stub** —— 文件真实存在、spawn 能命中，实跑必失败（exit 9009）并
 *      打印一句与平台毫无关系的英文提示，排障者只能猜是谁在调 python。
 *   3. **应用部署链根本没接解释器池**：`routes/deploy.ts` 里 `uv` 出现 **0** 次，
 *      python 应用一律 `python -m venv`（宿主），全新机器上必然失败。
 *
 * 修法**不是**在每个调用点各打一个补丁——那只会留下第 4、5 个同型洞（本仓库
 * 已经历过一次：`which python3` 的 Windows 缺陷被修在 `runtime-detection.ts`，
 * 却没有同步到 `deploy.ts`）。正确做法是把"本机有什么、能不能真的跑"收敛到
 * **本模块一处**，让**能力上报与任务执行都调它**，使口径漂移在物理上不可能发生。
 *
 * ## 纪律
 *
 * - **实跑验真，不信文件名**：判定一律用"实跑 `--version` 且退出码为 0"，绝不
 *   `fs.existsSync` / `which` 判存在。Store stub 与"Windows 没有 `which`"是两个
 *   已被生产实证的坑（见 `deploy.sh` 的 `have python3` 陷阱、`windows-findings`
 *   的 W-02）。存在性判定会把假解释器当成真解释器，而假解释器的失败发生在
 *   更下游、更难归因的地方。
 * - **探测绝不抛**：任何 spawn 失败/超时/异常一律收敛为 `verified:false`，由调用
 *   方决定"降级还是明确失败"。探测阶段抛错会阻断注册，代价远大于少报一项能力
 *   （同 `runtime-detection.ts` 的既有纪律）。
 * - **TTL 缓存**：注册、30s 心跳、以及每次任务 prepare 都会问一次，绝不能每次都
 *   spawn 一族探测进程（与 NFR-10 同款纪律：心跳路径零进程开销）。
 * - **可测**：平台 / execPath / electron 版本 / 探测器等全部经 `deps` 注入，使
 *   "Electron 宿主""Store stub"这类关键分支能在 Linux CI 上被真实覆盖——这正是
 *   原实现无法覆盖 Windows 分支、以致缺陷长期潜伏的原因。
 */

import { runCommand } from './run-command';
import { buildChildEnv } from './env-whitelist';

export type ToolName = 'python' | 'node' | 'npm' | 'git';

/**
 * 工具的来源。语义与 `interpreters.ts` 的 `UvSource` 同风格但更宽：这里描述的是
 * **可执行文件从哪来**，因为"来源"决定了它是否需要特殊启动方式
 * （如 Electron 复用需要 `ELECTRON_RUN_AS_NODE=1`）。
 */
export type ToolSource =
  /** 任务 venv 内（python 专用，由调用方在更下游覆盖）。 */
  | 'venv'
  /** uv 解释器池内（python 专用）。 */
  | 'pool'
  /** 随安装包自带。 */
  | 'bundled'
  /** 复用执行器自身（Electron 当 node 用）。 */
  | 'self'
  /** 宿主 PATH。 */
  | 'host'
  /** 不可用。 */
  | 'none';

export interface ResolvedTool {
  name: ToolName;
  /** 可执行文件绝对路径或命令名；`source === 'none'` 时为 `null`。 */
  path: string | null;
  source: ToolSource;
  /**
   * **实跑验真**是否通过。`false` 时**不得**计入能力上报，也**不得**用于执行。
   * 这是本模块存在的全部意义所在：把"文件名像"与"真的能跑"分开。
   */
  verified: boolean;
  /** 探测所得版本串（原始行，已截断），不可得为 `null`。 */
  version: string | null;
  /** 人可读的补充说明（诊断面与失败消息用）。 */
  detail?: string;
  /**
   * 启动该工具时是否必须置 `ELECTRON_RUN_AS_NODE=1`。
   * 仅 `source === 'self'` 的 node 为 true——漏置会让 Electron 以 GUI 模式启动。
   */
  requiresElectronRunAsNode?: boolean;
}

export interface Toolchain {
  python: ResolvedTool;
  node: ResolvedTool;
  npm: ResolvedTool;
  git: ResolvedTool;
}

/**
 * 探测结果缓存 TTL。心跳间隔 30s，绝不能每个心跳都 spawn 一族探测进程；
 * 而 60s 又短到足以让"用户中途装了 Node"在合理时间内被感知。
 */
export const TOOLCHAIN_CACHE_TTL_MS = 60_000;

/** 单个探测命令的预算。注册路径同步等待，不能拖慢启动（同 runtime-detection 的 5s）。 */
export const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeResult {
  ok: boolean;
  version: string | null;
}

/**
 * 注入点。生产一律走默认实现；自检注入桩，使平台相关分支（Electron 宿主、
 * Windows Store stub）能在任意宿主上被断言。
 */
export interface ToolchainProbeDeps {
  platform?: NodeJS.Platform;
  /**
   * `process.versions.electron` 的替代值。
   * **`null` 显式表示"不在 Electron 宿主内"**（自检用）；`undefined` 表示
   * "用真实探测"，故不能用 `??` 折叠——两者语义相反。
   */
  electronVersion?: string | null;
  /** `process.execPath` 的替代值（Electron 复用时作为 node 可执行文件）。 */
  execPath?: string;
  /** `process.versions.node` 的替代值。 */
  nodeVersion?: string;
  /** 命令探测实现；缺省用真实 spawn。 */
  runProbe?: (cmd: string, args: string[], timeoutMs: number) => Promise<ProbeResult>;
}

/**
 * 是否运行在 **Electron 宿主**内（即桌面客户端形态）。
 *
 * 判据用 `process.versions.electron`：Electron 以 `ELECTRON_RUN_AS_NODE=1`
 * 运行脚本时**仍然**保留该字段，因此这是"我能否把 Electron 可执行文件当 node
 * 复用"的可靠信号（`device-identity.ts` 的 `detectRuntimeKind` 用同一判据区分
 * desktop / 裸机 node，此处刻意对齐）。
 *
 * 注意 `electronVersion: null` 与 `undefined` 语义相反（见 `ToolchainProbeDeps`）。
 */
export function isDesktopHost(deps: ToolchainProbeDeps = {}): boolean {
  if (deps.electronVersion !== undefined) {
    return Boolean(deps.electronVersion);
  }
  return Boolean(process.versions.electron);
}

/** 从命令输出里取版本行（stdout/stderr 都可能出——老版本 python 走 stderr）。 */
function extractVersion(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => /\d+\.\d+/.test(l));
  return line ? line.trim().slice(0, 80) : null;
}

/**
 * 真实探测：实跑 `cmd args`，退出码 0 **且**能解析出版本才算可用。
 *
 * 为什么连版本一起要求：`ok` 只证明进程正常退出。用户 rc 文件、launcher 的
 * 用法提示、以及某些包装脚本都可能"退出 0 但根本不是解释器"。要求同时解析出
 * 版本串，能把这类"退化成什么都接受"的情况挡在门外——四个工具
 * （python/node/npm/git）都会打印版本，代价为零。
 *
 * `shell` 仅对 `.cmd`/`.bat` 打开：Windows 上 spawn 不能直接执行批处理
 * （`npm.cmd` 是批处理包装），这是 `deploy.ts` 既有 `shell: isWin` 的同款处理。
 */
async function probeExecutableReal(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<ProbeResult> {
  try {
    const useShell = /\.(cmd|bat)$/i.test(cmd);
    const r = await runCommand(cmd, args, {
      timeout: timeoutMs,
      env: buildChildEnv(),
      ...(useShell ? { shell: true } : {}),
    });
    if (r.status !== 0) return { ok: false, version: null };
    const version = extractVersion(`${r.stdout}\n${r.stderr}`);
    if (version === null) return { ok: false, version: null };
    return { ok: true, version };
  } catch {
    // runCommand 正常不 reject，但探测"绝不抛"是硬纪律——不依赖被调方的实现细节。
    return { ok: false, version: null };
  }
}

/**
 * 宿主 python 候选。顺序即优先级。
 *
 * - `python3` 优先（POSIX 惯例 / 官方安装器的 python3 别名）；
 * - 再 `python`；
 * - **Windows 追加 `py`**：`py.exe` 是 Python 官方的 launcher，**不是** Store
 *   占位 alias。当 PATH 上的 `python3`/`python` 恰好都是 Store stub 而机器上
 *   其实装了真 Python（python.org 安装器）时，`py` 是唯一能落到真解释器的
 *   候选——这正好补上 Windows 上最常见的那半个故障面。
 *   安全性由"实跑验真"保证：没有真 Python 时 `py` 自己会非零退出。
 */
export function pythonCandidates(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['python3', 'python', 'py'] : ['python3', 'python'];
}

/**
 * 宿主 node 候选。Windows 用显式 `node.exe`（避免 PATHEXT 解析歧义），
 * POSIX 用 `node`。
 */
export function nodeCandidates(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['node.exe', 'node'] : ['node'];
}

/**
 * 宿主 npm 候选。Windows 必须用 `npm.cmd`（npm 在 Windows 是批处理包装，
 * 且 spawn 直接执行 `.cmd` 需要 shell —— 见 `probeExecutableReal`）。
 */
export function npmCandidates(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
}

/** 按优先级实跑探测一组候选命令，返回第一个真正可用的。 */
async function probeFirstAvailable(
  name: ToolName,
  candidates: string[],
  probe: (cmd: string, args: string[], timeoutMs: number) => Promise<ProbeResult>,
  timeoutMs: number,
): Promise<ResolvedTool | null> {
  for (const candidate of candidates) {
    const r = await probe(candidate, ['--version'], timeoutMs);
    if (r.ok && r.version !== null) {
      return {
        name,
        path: candidate,
        source: 'host',
        verified: true,
        version: r.version,
      };
    }
  }
  return null;
}

function unavailable(name: ToolName, detail: string): ResolvedTool {
  return { name, path: null, source: 'none', verified: false, version: null, detail };
}

/**
 * node 解析：**宿主优先，Electron 兜底**。
 *
 * 为什么宿主优先而不是一律用 Electron：
 *   - 存量机器（已装 Node.js）继续跑在真实 node 上，行为**零变化**——这是
 *     "不破坏既有部署"的红线；若反过来一律用 Electron，所有现存桌面执行器的
 *     node 版本语义都会静默改变。
 *   - 只有在宿主 node **实跑不可用**时才复用 Electron，于是"全新未装 Node 的
 *     机器"从"任务必失败"变成"能跑"，而"本来能跑的机器"毫无感知。
 *
 * 已知取舍：这会让装了 node 与没装 node 的机器使用不同的 node 版本。能力层面
 * 两者都上报 `node`（一致），版本差异属既有异构问题（CONTRACT NG-02 明确本期
 * 不做 node 多版本），不在本模块职责内；诊断面如实显示来源与版本即可。
 */
async function resolveNode(
  platform: NodeJS.Platform,
  probe: (cmd: string, args: string[], timeoutMs: number) => Promise<ProbeResult>,
  timeoutMs: number,
  deps: ToolchainProbeDeps,
): Promise<ResolvedTool> {
  const host = await probeFirstAvailable('node', nodeCandidates(platform), probe, timeoutMs);
  if (host) return host;

  if (isDesktopHost(deps)) {
    const execPath = deps.execPath ?? process.execPath;
    return {
      name: 'node',
      path: execPath,
      source: 'self',
      // 复用自身不需要探测：正在运行本进程的就是它，能跑到这里即为可用证明。
      verified: true,
      version: deps.nodeVersion ?? process.versions.node ?? null,
      requiresElectronRunAsNode: true,
      detail:
        'host node is unavailable; reusing the Electron binary as node ' +
        '(spawn with ELECTRON_RUN_AS_NODE=1)',
    };
  }

  return unavailable(
    'node',
    'no usable node on PATH and this process is not an Electron host ' +
      '(no self-reuse available) — install Node.js or run the desktop client',
  );
}

/** 真实探测调度：在"注入桩"与"真实 spawn"之间选择。 */
function pickProbe(
  deps: ToolchainProbeDeps,
): (cmd: string, args: string[], timeoutMs: number) => Promise<ProbeResult> {
  return deps.runProbe ?? probeExecutableReal;
}

async function probeAll(
  timeoutMs: number,
  deps: ToolchainProbeDeps,
): Promise<Toolchain> {
  const platform = deps.platform ?? process.platform;
  const probe = pickProbe(deps);

  // 并行探测：串行会让注册路径的等待时间线性累加（4 个工具 × 最多 timeout）。
  const [python, node, npm, git] = await Promise.all([
    probeFirstAvailable('python', pythonCandidates(platform), probe, timeoutMs),
    resolveNode(platform, probe, timeoutMs, deps),
    probeFirstAvailable('npm', npmCandidates(platform), probe, timeoutMs),
    probeFirstAvailable('git', ['git'], probe, timeoutMs),
  ]);

  return {
    python:
      python ??
      unavailable(
        'python',
        'no usable python on PATH — if this is Windows, a Microsoft Store ' +
          'App Execution Alias stub may be shadowing the real interpreter ' +
          '(the stub exists as a file but fails on execution)',
      ),
    node,
    npm: npm ?? unavailable('npm', 'no usable npm on PATH'),
    git: git ?? unavailable('git', 'no usable git on PATH'),
  };
}

let cache: { at: number; value: Toolchain } | null = null;
let inflight: Promise<Toolchain> | null = null;

/**
 * 解析本机工具链（带 TTL 缓存 + 并发去重）。
 *
 * 传入 `deps` 时**绕过缓存**（读与写都不做）：注入桩的调用语义是"我现在要一个
 * 确定的答案"，与缓存混用会让自检受前序全局状态污染——这类"测试之间经由全局
 * 缓存串扰"是最难查的一类假绿。
 */
export async function probeToolchain(
  opts: { timeoutMs?: number; force?: boolean; deps?: ToolchainProbeDeps } = {},
): Promise<Toolchain> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const injected = opts.deps !== undefined;

  if (!injected && !opts.force) {
    if (cache && Date.now() - cache.at < TOOLCHAIN_CACHE_TTL_MS) return cache.value;
    // 并发去重：注册与首个任务几乎同时到来时，只探测一次。
    if (inflight) return inflight;
  }

  const run = probeAll(timeoutMs, opts.deps ?? {});
  if (injected) return run;

  inflight = run;
  try {
    const value = await run;
    cache = { at: Date.now(), value };
    return value;
  } finally {
    inflight = null;
  }
}

/** 同步取缓存（心跳等热路径零进程开销）；从未探测过时返回 `null`。 */
export function cachedToolchain(): Toolchain | null {
  return cache?.value ?? null;
}

/** 清空缓存。配置变更（uvPath / 池目录）或安装类操作后调用，使其即时生效。 */
export function invalidateToolchain(): void {
  cache = null;
  inflight = null;
}

/**
 * 测试专用：直接写入缓存。
 *
 * 为什么需要这个口子：消费本模块的 `routes/execute.ts` / `routes/deploy.ts`
 * 的既有测试**整体 mock 了 `run-command`**（那是它们隔离子进程的方式）。在这
 * 种测试里真实探测拿不到真结果——只会拿到 mock 的默认返回，于是"工具链解析"
 * 这一环会变成不可控的隐式依赖，让原本针对某项行为的断言变得随机。
 *
 * 与"注入 `deps`"的区别：`deps` 用于**测本模块自身**（每个用例要一份独立
 * 结果）；本函数用于**测下游**——下游读的是缓存（`cachedToolchain()`），
 * 故必须能把确定的值放进那个缓存里。
 *
 * 命名带 `ForTest` 前缀是刻意的：让它在生产代码里一眼可见、便于审计；它只
 * 写内存，不产生任何外部副作用，且 `invalidateToolchain()` 可立即清空。
 */
export function seedToolchainForTest(value: Toolchain): void {
  cache = { at: Date.now(), value };
}

/**
 * 无版本 python 任务/部署可用的**宿主解释器**；不可用时返回 `null`。
 *
 * 单独成函数是为了让调用点的意图显式化："我要的是能立刻跑起来的宿主解释器，
 * 而不是 uv 的下载能力"——这两者在声明/未声明版本的路径上语义完全不同，
 * 混用正是本次缺陷的根源。
 */
export function usableHostPython(tc: Toolchain): ResolvedTool | null {
  return tc.python.source === 'host' && tc.python.verified && tc.python.path
    ? tc.python
    : null;
}

/** 供诊断面/日志的一行摘要（绝不打印完整 PATH 或任何敏感值）。 */
export function describeToolchain(tc: Toolchain): string {
  const one = (t: ResolvedTool): string =>
    t.source === 'none' ? `${t.name}=none` : `${t.name}=${t.source}(${t.version ?? '?'})`;
  return [tc.python, tc.node, tc.npm, tc.git].map(one).join(' ');
}

/**
 * 测试专用：构造一份确定的 Toolchain。
 *
 * 下游 spec 只需声明"这台机器上哪个工具是什么形态"，不必手写四个完整
 * `ResolvedTool` 字面量（那样每个用例会重复 30 行样板，且新增字段时到处漏改）。
 * 未指定的工具一律为 `none`（= 不可用），符合"默认不假设机器上有什么"的
 * 保守立场。
 */
export function buildToolchainForTest(
  partial: Partial<Record<ToolName, Partial<ResolvedTool>>>,
): Toolchain {
  const make = (name: ToolName): ResolvedTool => {
    const given = partial[name];
    if (!given) {
      return { name, path: null, source: 'none', verified: false, version: null };
    }
    const source = given.source ?? 'host';
    const path = given.path ?? null;
    return {
      name,
      path,
      source,
      // `verified` 的缺省必须与"真的可用"同构：`none` 或没有 path 一律不可验真。
      // 反例（本函数最初的写法）：`{source:'none', path:null}` 因"未显式给
      // verified 且给了 path 字段"被判成 `verified:true` —— 一个"不可用却自称
      // 已验真"的 fixture。生产代码靠 `!verified || !path` 双条件侥幸挡住，但
      // 这类"测试夹具说谎"会污染后续断言的可信度，必须在源头修掉。
      verified: given.verified ?? (source !== 'none' && path !== null),
      version: given.version ?? null,
      ...(given.detail !== undefined ? { detail: given.detail } : {}),
      ...(given.requiresElectronRunAsNode !== undefined
        ? { requiresElectronRunAsNode: given.requiresElectronRunAsNode }
        : {}),
    };
  };
  return {
    python: make('python'),
    node: make('node'),
    npm: make('npm'),
    git: make('git'),
  };
}
