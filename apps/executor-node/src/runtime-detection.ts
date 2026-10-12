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
 *
 * 桌面自包含改造（后续一轮）：本模块上报的 python 能力必须与执行侧**同源可兑现**。
 * 历史上 uv 通道只对"声明了 runtimeVersion"的任务成立，而无版本任务（runtime 缺省
 * python、runtimeVersion 可空）在执行侧要求宿主解释器——上报与兑现再次分裂。现在
 * 执行侧补齐了"无版本 + 无宿主解释器 → 经 uv 取默认版本"的兜底，本模块的
 * `hasUv → python` 才成为一句真话（见 `detectRuntimes` 注释）。
 */

import { runCommand } from './run-command';
import { buildChildEnv } from './env-whitelist';
import { logger } from './logger';
import { describeToolchain, probeToolchain, pythonCandidates } from './toolchain';

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
 * 顺序即优先级：`python3` 优先（POSIX 惯例），再回落 `python`；Windows 追加
 * `py`（官方 launcher，**不是** Microsoft Store 占位 alias）。
 *
 * **本常量由 `toolchain.ts` 的 `pythonCandidates()` 派生**，不再各自维护一份字面量。
 *
 * 为什么必须派生（本模块实测踩过的坑）：此前这里硬编码 `['python3','python']`，
 * 而 `toolchain.ts` 的候选表是 `win32 → ['python3','python','py']`。两份表**已经
 * 漂移**——Windows 上"PATH 里的 python3/python 恰好都是 Store 占位 stub、而机器
 * 其实装了真 Python（python.org 安装器）"这一最常见形态，只有走 toolchain 的路径
 * 能回落到 `py` 得救；走本常量的旧探测会得出"没有 python"的**相反结论**。同一台
 * 机器上"能力上报"与"任务执行"因此可能给出两个答案——正是本模块要根除的那类
 * 口径分裂。派生之后，两处**物理上不可能**再漂移。
 *
 * 保留导出是为了兼容既有调用方与单测（`hasSystemPython` 等仍消费它，语义不变）。
 * 注意：这是**平台相关**的求值——旧的 `as const` 元组形态无法表达 win32 分支，
 * 故类型放宽为 `readonly string[]`。
 */
export function pythonCandidatesForCurrentPlatform(): readonly string[] {
  return pythonCandidates(process.platform);
}

/**
 * @deprecated 仅为兼容既有调用方保留。**新代码请用 `pythonCandidatesForCurrentPlatform()`**
 * 或直接消费 `toolchain.ts`。保留该常量的风险是它仍是"当前平台候选表的一份快照"，
 * 故这里在模块加载期求值（`process.platform` 在进程生命周期内恒定，无副作用）。
 */
export const PYTHON_CANDIDATES: readonly string[] = pythonCandidatesForCurrentPlatform();

/**
 * 探测可上报的运行能力。
 *
 * ## 关于 `node` 的一个历史陷阱（务必先读）
 *
 * 本函数曾把 `node` 当**恒定存在且自证**——理由是"本进程就运行在 Node.js 里"。
 * 这个推理在容器/裸机形态成立（executor-node 本身就是 node 程序），但在**桌面
 * 客户端**形态**不成立**：那里的 executor-node 由 Electron 以
 * `ELECTRON_RUN_AS_NODE=1` 启动（`executor-process.ts`），`process.execPath`
 * 是 **Electron 可执行文件**，而任务执行侧当时硬编码的是裸 `node.exe`。
 * 于是一台**根本没装 Node.js** 的机器照样上报 `node` 能力，任务却在
 * `spawn node.exe` 时 ENOENT —— 中台只信 `capabilities`，会持续把 node 任务
 * 派到这台机器上。**"能上报"与"能兑现"必须同源**，这正是本仓库那条
 * "能力上报与任务执行口径分裂"根因的具体表现。
 *
 * 现改为：`node` 是否上报**由调用方传入的实跑结论决定**（`nodeAvailable`）。
 * 生产由 `detectRuntimesOnHost()` 从 `toolchain.ts` 取——那里已经把"Electron
 * 自身可复用"也算作可用，因此桌面形态仍然如实上报 `node`（任务确实能跑），
 * 而"既无宿主 node、又不在 Electron 里"这一真正的死路会被如实剔除。
 *
 * 向后兼容：不传 `nodeAvailable` 时保持旧行为（恒定含 `node`），使既有调用方
 * 与单测不受影响；**但这属于兼容兜底，不是推荐用法**——新调用方必须显式传入。
 *
 * python 的判定采用**双通道**（任一成立即认为具备 Python 能力）：
 *   1. 系统 PATH 上有**实跑可用**的 `python3` / `python` / `py`；
 *   2. **自带 uv 可用**——uv 能获取解释器。**这条口径在本次修复后才真正成立，
 *      不要"清理"它**：
 *        · 修复前：uv 通道只覆盖**声明了 `runtimeVersion`** 的任务，而任务
 *          runtime 缺省是 `python`、`runtimeVersion` 可空，admin 对无声明版本
 *          的任务**不做过器过滤**（`interpreterSatisfies` 的
 *          `hasRequestedVersion` 短路恒 true）。于是"uv 可用"被当成 python
 *          能力上报，无版本任务却被派过来并在执行侧抛错——上报的是我们
 *          **兑现不了**的能力，正是本模块要根除的那类缺陷。
 *        · 修复后：`routes/execute.ts` 在"无声明版本 + 无可用宿主解释器"时会
 *          经 uv 解释器池获取 `DEFAULT_PYTHON_VERSION`（3.12）并直接执行。
 *          于是 uv 通道对**无版本**任务也兑现得起了，`hasUv → python` 才成为
 *          一句真话。删掉这条捷径会让"只有自带 uv 的桌面客户端"重新被判成
 *          无 Python 能力 → 被所有默认（python）任务过滤掉，回到
 *          desktop-v1.5.x 那个"注册成功但任务永远派不过来"的事故。
 *
 * ## 诚实边界：uv 在、但当下什么都取不到（无网 + 池空 + 无宿主解释器）
 *
 * **决定：仍然上报 `python`。** 这不是"掩耳盗铃"，而是三件事实的取舍：
 *   1. **能力 ≠ 此刻的瞬时可达性**。注册探测发生在启动瞬间；网络可能随后恢复、
 *      池可能被离线预填、uv 镜像可能切好。按"当下取不到"剔除能力，会让一台
 *      本可自愈的机器被永久排除在所有 python 任务之外（且**没有任何失败反馈**
 *      ——任务根本派不过来，运维只会看到"没有任务"，比明确失败更难排查）。
 *      这正是"少报能力"的代价：它与事故里的"多报能力"是对称的坑。
 *   2. **admin 侧的调度契约没有"能否获取"这个维度**。过滤只看执行器**已缓存**
 *      的版本清单（CONTRACT §1.2；AC-06c 明确"先下载后有"只有执行器说得清），
 *      而"无声明版本"的分支干脆不拦截。所以"上报 = 我会尝试并按契约给出精确
 *      失败"是与调度面唯一自洽的语义。
 *   3. **失败形态已质变**：修复前是"silent stub / ENOENT"，一句 ENOENT 或
 *      Microsoft Store 英文，无人知道是谁在调 python；修复后是不可能被静默
 *      吞掉的一条 `interpreter_unavailable`（带 requested/reason/detail/池快照，
 *      FR-12/AC-12a），admin 可据此改派到已缓存该版本的执行器、运维可据此预填
 *      或修网。**"会尝试、失败必精确归因" 与 "静默假成功" 是两回事**。
 *
 * 若未来要把这条收紧（例如只对"池内已有版本"上报 python），必须先解决
 * admin 侧"无法感知可获取性"的问题，否则只是把故障从"必然失败"换成
 * "永远派不过来"——本模块历史上已经踩过后者。
 *
 * @param hasUv 自带 uv（或 UV_BIN/uvPath 显式配置）是否可用。
 * @param isPythonExecutable 注入的可执行性判定（生产传实跑/PATH 探测；测试注入桩）。
 * @param nodeAvailable node 是否**实跑可用**（含 Electron 自身复用）。缺省保持
 *        旧行为（视为可用），仅为兼容既有调用方。
 */
export function detectRuntimes(input: {
  hasUv: boolean;
  isPythonExecutable: (candidate: string) => boolean;
  nodeAvailable?: boolean;
}): ReportedRuntime[] {
  const runtimes: ReportedRuntime[] = ['shell'];
  // 兼容兜底：未显式传入时沿用"自证"旧语义（见上方注释对代价的说明）。
  if (input.nodeAvailable !== false) {
    runtimes.push('node');
  }

  const hasSystemPython = PYTHON_CANDIDATES.some((c) =>
    safeIsExecutable(input.isPythonExecutable, c),
  );
  if (hasSystemPython || input.hasUv) {
    // ⚠ 此捷径的成立前提是 `routes/execute.ts` 的**默认版本兜底**：无声明版本
    // 的任务会经 uv 获取 `DEFAULT_PYTHON_VERSION`（3.12）。删掉那条兜底，这里
    // 就重新变回"上报我们兑现不了的能力"（详见本函数上方注释的诚实边界一节）。
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
 * ## 与 `toolchain.ts` 的关系（为什么必须走它）
 *
 * 本函数过去自行探测（`hasSystemPython()`），而任务执行侧各自解析命令名——两套
 * 代码、两个真值源，于是"上报的"与"能兑现的"可以互不一致且**双方都不报错**。
 * 现在统一改为消费 `toolchain.ts` 的**实跑结论**，使口径漂移在结构上不可能发生：
 *
 *   - `node`：由 `toolchain` 判定（宿主 node 实跑可用 **或** Electron 自身可复用）。
 *     这修掉了"桌面端没装 Node 仍上报 node"的虚报——那种机器会一直收到 node
 *     任务却永远 spawn ENOENT。
 *   - `python`：由 `toolchain` 判定宿主解释器实跑是否通过（含跳过 Windows
 *     Microsoft Store 占位 stub）。
 *
 * `hasUv` 仍由调用方传入（复用 `interpreters.ts` 的 `resolveUvBin` 结果）——
 * 该模块自身已带缓存，此处不重复探测。uv 可用即为 python 能力，这条语义保持不变，
 * 但其**成立前提已变**：修复后 uv 不只服务"声明版本"的任务，无版本任务也会经 uv
 * 取 `DEFAULT_PYTHON_VERSION`（见 `routes/execute.ts` 的默认版本兜底）。
 *
 * 探测失败一律降级（绝不抛）：能力少报只会让任务不派过来，抛异常会让整台执行器
 * 注册不上，后者严重得多（同 `detectAvailableRuntimes` 既有纪律）。
 */
export async function detectRuntimesOnHost(input: {
  hasUv: boolean;
  timeoutMs?: number;
}): Promise<ReportedRuntime[]> {
  let nodeAvailable: boolean | undefined;
  let pythonVerified: boolean | undefined;
  try {
    const tc = await probeToolchain({ timeoutMs: input.timeoutMs });
    nodeAvailable = tc.node.verified;
    pythonVerified = tc.python.verified;
    if (!pythonVerified) {
      logger.warn(
        `no usable python on this host (${describeToolchain(tc)}) — python tasks ` +
          'will be runnable only if uv can obtain an interpreter (declared ' +
          'runtimeVersion, or the default version for no-version tasks)',
      );
    }
  } catch (err) {
    // probeToolchain 契约上不抛；此处是防御性兜底（例如未来重构引入抛出）。
    // 探测异常时**不**改判定语义：nodeAvailable 保持 undefined（走兼容兜底），
    // python 回落到既有的独立探测，避免一次异常把能力面误缩成"什么都没有"。
    logger.warn(
      `toolchain probe failed during runtime detection: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (pythonVerified === undefined) {
    pythonVerified = input.hasUv
      ? false // 已有 uv 即具备 python 能力，无需再 spawn 探测（见 detectRuntimes 注释）
      : await hasSystemPython(input.timeoutMs);
  }

  return detectRuntimes({
    hasUv: input.hasUv,
    isPythonExecutable: () => pythonVerified === true,
    ...(nodeAvailable !== undefined ? { nodeAvailable } : {}),
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
