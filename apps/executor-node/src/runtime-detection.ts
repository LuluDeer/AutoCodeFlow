/**
 * 执行器**运行能力探测**（`runtimes` / `capabilities`）与上报类型判定。
 *
 * 为什么独立成模块：原实现内联在 `main.ts` 的 `detectAvailableRuntimes()`，
 * 直接 `spawnSync('which', ...)`，既有两个致命问题又**无法单测**：
 *
 *   1. **Windows 上 `which` 根本不存在**（实测 `spawnSync` 返回 `ENOENT`，
 *      `status === null`）。原代码只判 `r.status === 0`，于是 Windows 客户端
 *      **永远**探测不到 python —— 哪怕机器上装了 Python。
 *   2. `which` 是外部命令，依赖 PATH 与平台工具链；Linux 上也不是 POSIX 保证
 *      存在的（部分精简镜像没有）。
 *
 * 探测结果直接决定能力上报，而 admin 侧派发**只按 `capabilities` 过滤**
 * （`executor.service.ts` 的 `e.capabilities.includes(task.runtime)`）。任务
 * runtime 实体缺省值是 `python`（`task.entity.ts` `TaskRuntime.PYTHON`），
 * 所以一旦 capabilities 缺失 python，**新设备会被所有默认任务过滤掉**，
 * 表现为"注册成功但任务永远不派过来"。
 *
 * 因此这里把判定逻辑抽成纯函数（由调用方注入"候选是否可执行"），既能在
 * `npm run test:main` 里覆盖，也让"缺 python 怎么办"这类关键分支有回归闸。
 */

import { runCommand } from './run-command';
import { buildChildEnv } from './env-whitelist';

/** 执行器可上报的运行能力。与 admin 侧 `TaskRuntime` 取值对齐。 */
export type ReportedRuntime = 'shell' | 'node' | 'python';

/**
 * 上报给 admin 的执行器**类型**。
 *
 * 语义（已核对 admin 侧实现）：`type` 只用于展示，**不参与任务派发**——
 * 派发只看 `capabilities`。桌面客户端同时具备 shell / node / python 执行面
 * （python 由自带 uv 或系统解释器提供），故自报 `universal`；此前硬编码
 * `'node'` 会让后台把一台通用执行器显示成 node-only，与产品预期不符。
 */
export type ExecutorReportedType = 'node' | 'python' | 'universal';

/**
 * 判定 python 能力的候选命令名。
 *
 * 顺序即优先级：`python3` 优先（POSIX 惯例），再回落 `python`。
 * Windows 官方安装器通常只提供 `python.exe`（以及 `py` 启动器）。
 */
export const PYTHON_CANDIDATES = ['python3', 'python'] as const;

/**
 * 探测可上报的运行能力。
 *
 * `shell` 与 `node` **恒定存在**，不探测：
 *   - 本进程就运行在 Node.js 里，node 能力是自证的；
 *   - shell 由执行器自带的执行链路提供（bash/cmd），不依赖宿主额外安装。
 *
 * python 的判定采用**双通道**（任一成立即认为具备 Python 能力）：
 *   1. 系统 PATH 上有可用的 `python3` / `python`；
 *   2. **自带 uv 可用**——uv 能按任务声明的 `runtimeVersion` 获取解释器，
 *      这正是桌面客户端"通用执行器"的核心能力。只认系统 python 会让
 *      "装了自带 uv 的客户端"被误判为无 Python 能力。
 *
 * @param hasUv 自带 uv（或 UV_BIN/uvPath 显式配置）是否可用。
 * @param isExecutable 注入的可执行性判定（生产传实跑/PATH 探测；测试注入桩）。
 */
export function detectRuntimes(input: {
  hasUv: boolean;
  isPythonExecutable: (candidate: string) => boolean;
}): ReportedRuntime[] {
  const runtimes: ReportedRuntime[] = ['shell', 'node'];

  const hasSystemPython = PYTHON_CANDIDATES.some((c) =>
    safeIsExecutable(input.isPythonExecutable, c),
  );
  if (hasSystemPython || input.hasUv) {
    runtimes.push('python');
  }

  return runtimes;
}

/** 判定函数必须容错：权限不足/坏软链都可能抛，此时视为"不可用"。 */
function safeIsExecutable(
  fn: (candidate: string) => boolean,
  candidate: string,
): boolean {
  try {
    return fn(candidate) === true;
  } catch {
    return false;
  }
}

/**
 * 判定候选命令是否**真的可执行**——用"实跑 `--version`"而非 `which`。
 *
 * 为什么不用 `which`（原实现的缺陷）：
 *   - Windows 没有 `which`（实测 `spawnSync` 直接 `ENOENT`、`status === null`），
 *     原代码只判 `status === 0`，于是 Windows 永远探测不到 python；
 *   - 精简 Linux 镜像也常不自带 `which`。
 * 实跑探测不依赖宿主工具链，且能顺带排除"文件在但不可执行"的情形
 * （与 `interpreters.ts` 的 uv 解析采用同一策略）。
 *
 * 超时保持短（5s）：该探测在注册/重注册路径上同步等待，不能拖慢启动；
 * 失败一律收敛为 `false`，绝不抛——能力探测失败只该降级，不该阻断注册。
 */
export async function probePythonExecutable(
  candidate: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const { status } = await runCommand(candidate, ['--version'], {
    timeout: timeoutMs,
    env: buildChildEnv(),
  });
  return status === 0;
}

/** 按优先级探测系统 python 是否可用（`python3` → `python`）。 */
export async function hasSystemPython(timeoutMs = 5_000): Promise<boolean> {
  for (const candidate of PYTHON_CANDIDATES) {
    if (await probePythonExecutable(candidate, timeoutMs)) return true;
  }
  return false;
}

/**
 * 生产入口：探测本机可上报的运行能力。
 *
 * `hasUv` 由调用方传入（复用 `interpreters.ts` 的 `resolveUvBin` 结果）——
 * 该模块自身已带缓存，此处不重复探测。
 */
export async function detectRuntimesOnHost(input: {
  hasUv: boolean;
  timeoutMs?: number;
}): Promise<ReportedRuntime[]> {
  const systemPython = input.hasUv
    ? false // 已有 uv 即具备 python 能力，无需再 spawn 探测
    : await hasSystemPython(input.timeoutMs);
  return detectRuntimes({
    hasUv: input.hasUv,
    isPythonExecutable: () => systemPython,
  });
}

/**
 * 由探测到的能力推导上报给 admin 的 `type`。
 *
 * 具备 python 能力 → `universal`（既能跑 shell/node，也能跑 python）；
 * 否则退化为 `node`（如实反映"只有 node/shell 能力"）。
 *
 * 为什么不用 `python`：本客户端永远自带 node/shell 执行面，`python` 档
 * 描述的是"纯 Python 执行器"，与本产品形态不符。
 *
 * 注意：`type` 仅影响后台展示；**能力是否可用以 `capabilities` 为准**，
 * 两者刻意保持同源推导，避免"显示通用但派不到 python 任务"的错配。
 */
export function reportedExecutorType(runtimes: ReportedRuntime[]): ExecutorReportedType {
  return runtimes.includes('python') ? 'universal' : 'node';
}
