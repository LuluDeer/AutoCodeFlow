/**
 * 应用部署 / 任务执行**共享**的 python 解释器解析 + venv 创建 + 依赖安装。
 *
 * ## 为什么必须有这个模块（本次生产事故复盘）
 *
 * 一台全新 Windows 机器装上桌面客户端后，中台部署**一个** python 应用即失败：
 *
 *   Python was not found; run without arguments to install from the Microsoft Store,
 *   or disable this shortcut from Settings > Apps > Advanced app settings >
 *   App execution aliases.
 *
 * 根因链（全部在源码中逐条核实过，非推测）：
 *   1. 桌面安装包只自带 **uv**（包管理器），**不含 Python 本体**；
 *   2. `routes/deploy.ts` 里 `uv` 出现 **0** 次——应用部署链从未接上解释器池；
 *      而任务执行链（`routes/execute.ts`）早就接了。这个**不对称**就是缺陷本身；
 *   3. `deploy.ts` 两处硬编码宿主解释器：`installDeps` 的 `python -m venv` 与
 *      `startApp` 的 `fallback = 'python' | 'python3'`；
 *   4. Windows 上 PATH 里的 `python.exe` 很可能是 **Microsoft Store 的
 *      App Execution Alias 占位 stub**：文件真实存在（spawn 能命中、不报
 *      ENOENT），实跑必失败（exit 9009）并打印上面那句与平台毫无关系的英文，
 *      排障者只能猜是谁在调 python；
 *   5. 应用 runtime 在中台侧缺省就是 `python`，于是全新机器第一次部署必然踩中。
 *
 * 修法**不是**再补一个"探测一下 python 存不存在"：本仓库已经有过同型缺陷
 * （`which python3` 的 Windows 缺陷被修在 `runtime-detection.ts`，却没有同步到
 * `deploy.ts`），逐个调用点打补丁只会留下第 4、5 个同型洞。本模块把
 * 「本机到底有什么、能不能真的跑」收敛到**既有**的两个单一真值源上：
 *   - `toolchain.ts`：宿主解释器**实跑验真**（Store stub 天然被拒）；
 *   - `interpreters.ts`：uv 解释器池（自包含、与宿主 PATH 无关）。
 * deploy 只负责编排，不再自己决定"用什么去跑 python"。
 *
 * ## 与 `routes/execute.ts` 的关系（**待统一的已知重复**）
 *
 * `execute.ts` 另有一份私有 `ensurePythonVenv`（含 venv 复用健康校验）。两份
 * venv 实现必然会漂移——那正是本次事故的成因类别。按本轮改造的并行边界
 * （`execute.ts` 正被另一个改造占用），此处先落地一个**自包含**模块供 deploy
 * 使用；**后续必须把 `execute.ts` 迁移到本模块**并删掉它那份私有实现，否则
 * "两套 venv 逻辑"这个隐患仍然存在（见 REPORT 的遗留项）。
 *
 * ## 硬约束（每一条都对应一个已实证的坑）
 * - **绝不回落到裸 `'python'` / `'python3'`**：解析不出真解释器就**明确失败**。
 *   这正是本次事故的教训——静默用 stub 的代价是一句无人能归因的英文提示。
 * - `uv venv` 只接受**池内绝对路径**（D8）：绝不传裸版本号，裸版本号会触发 uv
 *   的隐式下载语义并绕过 D13 的全局单下载队列。
 * - uv 子进程一律带 `UV_PYTHON_DOWNLOADS: 'manual'`：即便某处误传了裸版本号，
 *   uv 也只会**拒绝**而不是偷偷下载（D8 加固）。
 * - 同步 `startApp` 路径不得 spawn 探测进程：它被 `setImmediate` 后台任务与
 *   daemon 重启定时器调用，只能读缓存（`cachedToolchain()` /
 *   `interpreterSnapshot()`）；缓存由部署阶段的异步解析预热。
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { runCommand } from './run-command';
import type { RunCommandOptions, RunCommandResult } from './run-command';
import { buildChildEnv } from './env-whitelist';
import { DEFAULT_PYTHON_VERSION } from './python-defaults';
import { cachedToolchain, probeToolchain, usableHostPython, describeToolchain } from './toolchain';
import type { Toolchain } from './toolchain';
import {
  discoverInstalled,
  ensureVersion,
  interpreterSnapshot,
  resolveUvBin,
} from './interpreters';
import type { InterpreterInfo, UvResolution } from './interpreters';

/** venv 创建与依赖安装的独立预算（与 `execute.ts` 的 UV_VENV/PIP 预算同量级）。 */
export const VENV_CREATE_TIMEOUT_MS = 120_000;
export const VENV_PIP_TIMEOUT_MS = 300_000;

/** 解释器来源。`pool` = uv 解释器池（自包含）；`host` = 宿主 PATH 上实跑验真过的。 */
export type DeployInterpreterSource = 'pool' | 'host';

export interface DeployInterpreter {
  source: DeployInterpreterSource;
  /** `pool` 是绝对路径；`host` 是经实跑验真的命令名（`python3` / `python` / `py`）。 */
  path: string;
  /** 探测/解析到的版本串；不可得为 `null`。 */
  version: string | null;
}

/**
 * 注入点。生产一律走默认实现（`interpreters.ts` / `toolchain.ts` / `fs` /
 * `runCommand`）；自检注入桩，使"池内有 3.12""宿主是 Store stub""uv 缺失"
 * 这些分支能在任意宿主上被确定性地断言——与 `toolchain.ts` 的 `deps` 同风格。
 */
export interface PythonVenvDeps {
  platform?: NodeJS.Platform;
  exists?: (target: string) => boolean;
  /**
   * 同步读文本文件；读不到（不存在/不可读/mock 未实现）返回 `null`。
   * 仅用于 `resolveStartPython()` 的 venv **静态**健康检查（见 `venvStartProblem`）。
   */
  readText?: (target: string) => string | null;
  run?: (
    cmd: string,
    args: string[],
    opts?: RunCommandOptions,
  ) => Promise<RunCommandResult>;
  /** 已缓存的工具链（热路径首选）；默认 `toolchain.cachedToolchain`。 */
  cachedToolchain?: () => Toolchain | null;
  /** 缓存冷时的一次实跑探测；默认 `toolchain.probeToolchain`。 */
  probeToolchain?: () => Promise<Toolchain>;
  /** 池探测（spawn `uv python list`）；默认 `interpreters.discoverInstalled`。 */
  discoverInstalled?: (opts?: {
    force?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<InterpreterInfo[]>;
  /** 声明版本 → 池内绝对路径（池命中或走全局单下载队列）；默认 `interpreters.ensureVersion`。 */
  ensureVersion?: (version: string, opts?: { signal?: AbortSignal }) => Promise<string>;
  /** 同步读池缓存；默认 `interpreters.interpreterSnapshot`。 */
  interpreterSnapshot?: () => InterpreterInfo[];
  /** uv 定位；默认 `interpreters.resolveUvBin`。 */
  resolveUvBin?: () => Promise<UvResolution>;
  /** uv 子进程环境（池目录/缓存/禁隐式下载）；默认按 `config` 构造。 */
  uvEnv?: () => NodeJS.ProcessEnv;
}

/** venv 内解释器/可执行文件路径（win32 是 `Scripts\\*.exe`，POSIX 是 `bin/*`）。 */
export function venvBinaries(
  venvDir: string,
  platform: NodeJS.Platform = process.platform,
): { python: string; pip: string } {
  const isWin = platform === 'win32';
  return {
    python: isWin
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python3'),
    pip: isWin ? path.join(venvDir, 'Scripts', 'pip.exe') : path.join(venvDir, 'bin', 'pip'),
  };
}

/**
 * 无可用解释器时的失败消息。
 *
 * 刻意把 **Store stub** 这个具体形态写进消息：本次事故里用户看到的是一句
 * 与平台毫无关系的英文（"Python was not found..."），而真正的原因（PATH 上的
 * `python.exe` 是占位 stub、安装包又没带 Python）没有任何入口可以看出来。
 * 宁可消息长一点，也不要让排障者再猜一次。
 */
export function noPythonInterpreterMessage(toolchainSummary?: string): string {
  const summary = toolchainSummary ? ` (toolchain: ${toolchainSummary})` : '';
  return (
    'No usable Python interpreter for this deployment: no interpreter is available ' +
    `in the uv interpreter pool and no local Python on PATH actually executes${summary}. ` +
    'On Windows, `python.exe` / `python3.exe` on PATH is very often a Microsoft Store ' +
    'App Execution Alias stub — the file exists (so spawn resolves it) but every ' +
    'execution fails with exit code 9009 and the message "Python was not found; run ' +
    'without arguments to install from the Microsoft Store...". ' +
    'Fix: install CPython 3.8+ (python.org) or seed the uv interpreter pool ' +
    '(UV_PYTHON_INSTALL_DIR), then redeploy.'
  );
}

function readConfigString(key: string): string {
  // 防御部分 config 替身（单测把 config 整体 mock 成字面量）与未来字段改名：
  // 缺字段绝不能变成 `path.join(undefined, ...)` 抛异常，那会让一次本该
  // "明确失败"的部署变成一个与根因无关的 TypeError。
  const value = (config as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function defaultUvEnv(): NodeJS.ProcessEnv {
  const installDir = readConfigString('uvPythonInstallDir');
  const extra: Record<string, string | undefined> = {
    // D8 加固：把"venv 阶段绝不隐式下载"交给 uv 自己强制。即便将来某处误传了
    // 裸版本号，uv 也只会拒绝，而不是在部署中途偷偷拉一个 ~60MB 的解释器。
    UV_PYTHON_DOWNLOADS: 'manual',
    UV_NO_PROGRESS: '1',
  };
  if (installDir) {
    extra.UV_PYTHON_INSTALL_DIR = installDir;
    extra.UV_CACHE_DIR = path.join(installDir, '.cache');
  }
  return buildChildEnv(extra);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resultDetail(r: RunCommandResult): string {
  return (r.stderr || r.stdout || '').trim();
}

/** 池内条目是否满足声明版本（`3.12.13` 属于 `3.12`；**必须**带点号比较）。 */
function versionSatisfies(available: string, requested: string): boolean {
  return available === requested || available.startsWith(`${requested}.`);
}

/** 声明版本与已建 venv 记录的版本是否相符（`3.12.11` 属于 `3.12`）。 */
function recordedVersionSatisfies(recorded: string, requested: string): boolean {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(recorded);
  if (!m) return false; // 解析不出 → 保守判为不匹配（同 execute.ts venvReuseProblem）
  return m[1] === requested || m[1].startsWith(`${requested}.`);
}

/** 默认的同步读文本实现；读不到（缺失/不可读/mock 未实现）一律返回 `null`。 */
function defaultReadText(target: string): string | null {
  try {
    const text = fs.readFileSync(target, 'utf-8');
    // 单测把整个 `fs` automock 掉时 readFileSync 会返回 undefined——必须显式
    // 判类型，否则 `undefined.split` 会变成一次与根因无关的 TypeError。
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** `pyvenv.cfg` 文本 → 小写键 map；畸形行跳过（不抛）。 */
function parsePyvenvCfgText(text: string): Record<string, string> {
  const cfg: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    cfg[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return cfg;
}

/**
 * venv **静态**健康判定：不可用时返回原因，健康返回 `null`。
 *
 * ## 为什么必须有（本轮评审缺陷 3 的修复点）
 *
 * `uv venv` 建出的环境里 `<venv>/Scripts/python.exe`（POSIX `bin/python3`）只是
 * 约 600KB 的 **shim**，真身仍在解释器池里，依赖记在 `pyvenv.cfg` 的
 * `home = <池>/cpython-…`。池里那个目录一旦被回收（缺陷 2：回收扫描看不见部署
 * venv），shim 文件**依然存在**——旧逻辑 `if (exists(bins.python)) 直接采信`，
 * 于是 spawn 一个指向已消失真身的死 shim：应用当场退出 → daemon 自动重启 →
 * 同一个死解释器 → 无限崩溃循环，且上报的只有退出码，没有任何信息指向池。
 *
 * 本函数与 `execute.ts` 的 `venvReuseProblem` **语义逐条对齐**（那里是另一份
 * 私有实现，见模块头注的 R8 残差）：shim 存在 + `pyvenv.cfg` 可读 + `home`
 * 存在 + 声明版本相符。**刻意不 import `execute.ts`**——那会造成循环依赖，而
 * 且该文件的迁移已单列为遗留动作。
 *
 * ## 为什么是"静态检查"而不是"spawn `--version` 实跑验真"
 *
 * 因为 `resolveStartPython()` 是**同步**函数：它被 `startApp` 在 `setImmediate`
 * 后台任务与 daemon 重启定时器里调用，没法 `await` 一次探测。同步 API 里
 * `spawnSync` 又要付 5s 级阻塞 + 无法可靠超时的代价，且会让 `startApp` 的调用
 * 方（定时器回调）被拖住。
 *
 * **残留陈旧窗口（如实登记）**：本检查只能证明"路径存在"，不能证明那个解释器
 * **真能跑**。若池目录存在但内容损坏/被换卷/被杀软隔离（即 execute.ts 注释里
 * 的 "No Python at '...'" 之外的另一半故障面），同步路径仍会 spawn 到一个必败
 * 的解释器。窗口 = 部署阶段预热/建 venv 之后、到 startApp/重启 spawn 之前。
 * 缺陷 2 的修法（回收扫描纳入部署 venv）从**源头**关掉了这条链最常见的成因
 * ——我们自己的回收器不再删掉活应用依赖的池版本；剩下的窗口属于外部破坏，
 * 只能靠"重启次数上限 + app.log 尾部上报"暴露，不可能在同步路径里彻底消除。
 */
function venvStartProblem(
  venvDir: string,
  pythonBin: string,
  runtimeVersion: string | null,
  deps: PythonVenvDeps,
): string | null {
  const exists = deps.exists ?? fs.existsSync;
  if (!exists(pythonBin)) return `venv python is missing (${pythonBin})`;
  const readText = deps.readText ?? defaultReadText;
  const cfgText = readText(path.join(venvDir, 'pyvenv.cfg'));
  if (cfgText === null) return 'pyvenv.cfg is missing or unreadable';
  const cfg = parsePyvenvCfgText(cfgText);
  const home = cfg['home'];
  if (!home) {
    return 'pyvenv.cfg has no "home" entry (cannot tell which interpreter backs it)';
  }
  if (!exists(home)) {
    return `the interpreter it was built from no longer exists (${home})`;
  }
  if (runtimeVersion && !recordedVersionSatisfies(cfg['version_info'] || path.basename(home), runtimeVersion)) {
    return `it was built for ${cfg['version_info'] || path.basename(home)} but the deployment declares ${runtimeVersion}`;
  }
  return null;
}

/** 版本降序比较（数字分段，避免字符串序把 3.9 排在 3.14 之后）。 */
function compareVersionDesc(a: string, b: string): number {
  const key = (v: string): number[] =>
    (/(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v) ?? [])
      .slice(1)
      .map((part) => (part === undefined ? 0 : parseInt(part, 10)));
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
    const diff = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 从池条目里挑一个解释器：声明了版本就必须匹配该版本（`X.Y` 前缀），
 * 未声明则取池内**最高**版本。取不到返回 `null`（调用方决定"再找宿主还是失败"）。
 *
 * 为什么未声明时取最高：应用部署目前**没有** `runtimeVersion` 概念（中台
 * `Application` 实体只有 `runtime: string`，本轮刻意不加字段/迁移）。宿主
 * 解释器在全新 Windows 上极可能是 stub，而池内解释器是本机唯一自包含的真解释器；
 * 与其回落到 stub，不如用池里现成的最高版本。取舍：这可能与开发时使用的版本
 * 不同——但"能跑 + 诊断可见"远好于"一句 Store 英文提示"。
 */
export function pickPoolInterpreter(
  entries: InterpreterInfo[] | null | undefined,
  declaredVersion?: string | null,
): DeployInterpreter | null {
  const usable = (entries ?? []).filter(
    (e) => e && typeof e.path === 'string' && e.path.length > 0 && e.available !== false,
  );
  const wanted =
    typeof declaredVersion === 'string' && declaredVersion.trim()
      ? declaredVersion.trim()
      : null;
  const candidates = wanted
    ? usable.filter((e) => versionSatisfies(e.version, wanted))
    : usable;
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => compareVersionDesc(a.version, b.version));
  const best = sorted[0];
  return { source: 'pool', path: best.path, version: best.version };
}

/**
 * 同步从**已预热**的缓存里解析宿主解释器。
 *
 * 只读缓存、绝不 spawn：`startApp` 是同步函数（由 `setImmediate` 后台任务与
 * daemon 重启定时器调用），在里面等一次 5s 探测会拖住部署回调与重启决策。
 * 部署阶段的 `resolveDeployInterpreter()` 已经把缓存预热，故生产路径必然命中。
 */
function verifiedHostPythonFromCache(deps: PythonVenvDeps): DeployInterpreter | null {
  const tc = (deps.cachedToolchain ?? cachedToolchain)();
  const host = tc ? usableHostPython(tc) : null;
  if (!host || !host.path) return null;
  return { source: 'host', path: host.path, version: host.version };
}

/** 异步解析宿主解释器：先读缓存（心跳/部署热路径零进程开销），冷则实跑探测一次。 */
async function resolveVerifiedHostPython(
  deps: PythonVenvDeps,
): Promise<DeployInterpreter | null> {
  const cached = verifiedHostPythonFromCache(deps);
  if (cached) return cached;
  try {
    const tc = await (deps.probeToolchain ?? probeToolchain)();
    const host = usableHostPython(tc);
    if (!host || !host.path) return null;
    return { source: 'host', path: host.path, version: host.version };
  } catch (err) {
    // probeToolchain 契约上不抛；此处是防御性兜底（同 toolchain/runtime-detection
    // 的既有纪律：探测异常降级为"没有"，绝不阻断部署主链的诊断信息）。
    logger.warn(`[python-venv] toolchain probe failed: ${errText(err)}`);
    return null;
  }
}

function cachedToolchainSummary(deps: PythonVenvDeps): string | undefined {
  const tc = (deps.cachedToolchain ?? cachedToolchain)();
  return tc ? describeToolchain(tc) : undefined;
}

/**
 * 解析"这次部署该用哪个解释器"，顺序即语义：
 *
 *   1. **声明了 `runtimeVersion`** → `ensureVersion()` 拿池内绝对路径（池命中
 *      或经全局单下载队列下载），与 `execute.ts` 的声明版本语义**逐条对齐**。
 *      此时**不**回落到宿主：声明了却拿不到就必须明确失败——静默跑别的版本
 *      属于"看着成功其实违约"，正是本轮要消灭的缺陷类别。
 *   2. **未声明版本** → 池内**已经装好**的解释器（最高版本）。不替用户凭空
 *      选一个版本来下载（部署是用户动作，不该在部署中途拉运行时）。
 *   3. 池内没有 → 工具链里**实跑验真过**的宿主解释器。
 *   4. 都没有 → 抛 `noPythonInterpreterMessage()`，**绝不**回落到裸命令名。
 *
 * `uv` 缺失不影响第 2/3 步：池内解释器本身就是真解释器，可以直接 `-m venv`。
 */
export async function resolveDeployInterpreter(
  runtimeVersion?: string | null,
  deps: PythonVenvDeps = {},
  signal?: AbortSignal,
): Promise<DeployInterpreter> {
  const declared =
    typeof runtimeVersion === 'string' && runtimeVersion.trim()
      ? runtimeVersion.trim()
      : null;

  if (declared) {
    try {
      // NETOPT-E P3-1 同型（defect 4）：把 `opts.signal` 透传下去。pool 下载或
      // `uv python list`（默认 30s 预算）若不受停机信号约束，会拖着
      // `abortDeployInFlight()` 之后的停机 drain 走过 main.ts 的硬杀窗口，
      // 终态回调随之丢失。该分支当前在生产**不可达**（admin 侧
      // `grep runtimeVersion apps/admin-api/src/modules/application/` = 0，应用
      // 部署尚不支持声明版本），但语义必须与 execute.ts 对齐，一旦中台开始发送
      // 就已正确。
      const poolPython = await (deps.ensureVersion ?? ensureVersion)(declared, {
        signal,
      });
      if (typeof poolPython === 'string' && poolPython) {
        return { source: 'pool', path: poolPython, version: declared };
      }
      throw new Error('ensureVersion() returned an empty interpreter path');
    } catch (err) {
      throw new Error(
        `Cannot obtain Python ${declared} for this deployment: ${errText(err)}. ` +
          'The declared version must be honoured, so the deployment is refused ' +
          'instead of silently falling back to another interpreter.',
      );
    }
  }

  try {
    // 同上传入 signal：`discoverInstalled` 内部 spawn 的 `uv python list` 有 30s
    // 预算，停机时必须以同一个 abort 掐断，否则 drain 会卡在这一次探测上。
    const entries = await (deps.discoverInstalled ?? discoverInstalled)({
      signal,
    });
    const picked = pickPoolInterpreter(entries, null);
    if (picked) return picked;
  } catch (err) {
    // discoverInstalled 契约上不抛（整体失败退化为本地目录扫描），此处同样是
    // 防御性兜底：探测失败只该让"池"这条路消失，不该让整个部署死在一个与
    // 根因无关的异常上。
    logger.warn(`[python-venv] interpreter pool discovery failed: ${errText(err)}`);
  }

  const host = await resolveVerifiedHostPython(deps);
  if (host) return host;

  // -------------------------------------------------------------------------
  // 无版本声明的**默认版本兜底**（生产事故修复点，与 `routes/execute.ts` 同源）
  //
  // 事故形态：全新 Windows 机器装了桌面客户端（**包内只有 uv、没有 Python**），
  // 管理员在「应用管理」部署一个默认（无版本）python 应用 → 应用起不来，报
  // Microsoft Store 的 "Python was not found"。当时本函数解析到"池空 + 宿主只有
  // Store 占位 stub"就**直接抛错**——注意：`python-venv.ts` 上一轮修复只把
  // "令人困惑的失败"换成了"可读的失败"，**能力仍未兑现**。
  //
  // owner 明确口径：*带了 uv，任务或应用没有指定版本，就默认按 3.12 装好并用
  // 它执行。* 任务链路（execute.ts）已实现；应用链路此前**漏了**，本处补齐——
  // 否则"中台部署 1 个应用"这个原始场景仍然失败。
  //
  // 顺序为什么放在**宿主之后**：池(任意) → 验真宿主 是既有顺序，保持不动；
  // 本兜底只在**前两者都拿不到**（= 原本必然抛错的路径）时生效。因此：
  //   · 有池内解释器 → 不变；· 有可用宿主 Python → 不变；
  //   · 只有 uv 的干净机器 → 由"必失败"变为"经 uv 取 3.12 后能跑"。
  // 这是**纯增量**：唯一被改变的是原本 100% 失败的那条分支。
  //
  // 版本取 `DEFAULT_PYTHON_VERSION`（定义在 `python-defaults.ts`，与任务链路**共用
  // 同一个常量**）——若两处各写一个字面量，就会出现"任务用 3.12、应用用 3.11"
  // 的新漂移，与本次事故同一类病。
  //
  // 慢是预期的（首次约 13~17s 下载）；`signal` 必须透传，否则停机时下载子进程
  // 会拖过 main.ts 的硬杀窗口，终态回调随之丢失（NETOPT-E P3-1 同型）。
  // 失败语义：`ensureVersion` 抛 InterpreterUnavailableError（uv 缺失 / 不可下载 /
  // 超时 / 网络失败 / 池损坏），由调用方包装成可读的部署失败——绝不静默降级到
  // 别的解释器（那会让"跑起来了"变成"跑在错误版本上"）。
  // -------------------------------------------------------------------------
  try {
    logger.info(
      `[python-venv] no pooled interpreter and no verified host Python; ` +
        `obtaining the default Python ${DEFAULT_PYTHON_VERSION} via uv for this deployment`,
    );
    const poolPython = await (deps.ensureVersion ?? ensureVersion)(
      DEFAULT_PYTHON_VERSION,
      { signal },
    );
    if (typeof poolPython === 'string' && poolPython) {
      return { source: 'pool', path: poolPython, version: DEFAULT_PYTHON_VERSION };
    }
    throw new Error('ensureVersion() returned an empty interpreter path');
  } catch (err) {
    // 把默认版本这条路的失败**追加**到原有诊断之后：两者都是真实归因，
    // 且 `noPythonInterpreterMessage` 里的 Store stub 指引是上一轮事故修复的
    // 产物，不能因为加了兜底就丢掉。
    throw new Error(
      `${noPythonInterpreterMessage(cachedToolchainSummary(deps))} ` +
        `Additionally, obtaining the default Python ${DEFAULT_PYTHON_VERSION} via uv failed: ` +
        `${errText(err)}. On an offline machine, configure an interpreter mirror or ` +
        'pre-fill the interpreter pool (see OFFLINE-PROVISIONING.md).',
    );
  }
}

/**
 * 应用**启动**时（`startApp`）的**同步**解释器解析。
 *
 * 顺序与 `resolveDeployInterpreter()` 一致（venv → 池 → 验真宿主 → 明确失败），
 * 区别只有两点，都是"同步"这个硬约束逼出来的：
 *   - 池只能读**同步缓存**（`interpreterSnapshot()`），不 spawn `uv python list`；
 *   - 宿主只能读**已缓存的**工具链结论，不实跑探测。
 * 部署阶段已经预热这两处缓存，故正常路径下与异步解析得到同一个真解释器。
 *
 * venv 优先是刻意保留的既有正确行为：venv 里的解释器是上一阶段用验真过的
 * 解释器建出来的真解释器（uv 建的 venv 里 `python.exe` 只是指向池内真身的
 * shim，同样能跑）。
 */
export function resolveStartPython(opts: {
  venvDir: string;
  runtimeVersion?: string | null;
  deps?: PythonVenvDeps;
}): { source: 'venv' | 'pool' | 'host'; cmd: string; version: string | null } {
  const deps = opts.deps ?? {};
  const exists = deps.exists ?? fs.existsSync;
  const bins = venvBinaries(opts.venvDir, deps.platform ?? process.platform);

  const declared =
    typeof opts.runtimeVersion === 'string' && opts.runtimeVersion.trim()
      ? opts.runtimeVersion.trim()
      : null;

  // 缺陷 3 修复点：不再"文件存在即采信"。`uv venv` 的 python 只是指向池内真身的
  // shim，池版本被回收后 shim 仍在但必死（应用崩溃 → daemon 重启 → 同一个死
  // 解释器 → 崩溃循环）。静态判定不健康时**落到下面的池/宿主链**，而不是 spawn
  // 一个已知会死的命令。判定开销是两次 existsSync + 一次 pyvenv.cfg 读取，
  // 对同步 startApp 路径可以接受（无 spawn、无阻塞等待）。
  const venvProblem = exists(bins.python)
    ? venvStartProblem(opts.venvDir, bins.python, declared, deps)
    : `venv python is missing (${bins.python})`;
  if (venvProblem === null) {
    return { source: 'venv', cmd: bins.python, version: null };
  }
  if (exists(bins.python)) {
    // 只对"shim 存在却不可用"告警：完全没建过 venv 是正常路径（无 requirements
    // 的应用本来就没有 venv），不该刷日志。
    logger.warn(
      `[python-venv] ignoring unusable venv at ${opts.venvDir}: ${venvProblem}; ` +
        'falling back to the interpreter pool / verified host python',
    );
  }

  const pooled = pickPoolInterpreter(
    (deps.interpreterSnapshot ?? interpreterSnapshot)(),
    declared,
  );
  if (pooled) return { source: 'pool', cmd: pooled.path, version: pooled.version };

  const host = verifiedHostPythonFromCache(deps);
  if (host) return { source: 'host', cmd: host.path, version: host.version };

  throw new Error(noPythonInterpreterMessage(cachedToolchainSummary(deps)));
}

/**
 * 预热 `resolveStartPython()` 所依赖的两处**同步**缓存（池清单 + 工具链）。
 *
 * 为什么需要显式预热：`startApp` 是同步函数，只能读缓存。若某次 python 部署
 * **没有** `requirements.txt`（不建 venv），池清单可能从未被探测过，于是
 * `startApp` 只能看到"池为空"并落到宿主；一台只有 uv 自带解释器、没有系统
 * Python 的全新机器就会因此明确失败——而它明明能跑。预热把"能不能跑"在这一步
 * 就确定下来（也让失败发生在部署阶段、可归因，而不是在启动阶段）。
 *
 * 两件事都走各自模块的 TTL 缓存；best-effort，绝不抛（预热失败只该让候选变少，
 * 不该让部署死在一个与根因无关的异常上——同 `discoverInstalled` / `probeToolchain`
 * 的既有纪律）。
 */
export async function prewarmPythonInterpreterCache(
  deps: PythonVenvDeps = {},
): Promise<void> {
  await Promise.all([
    (async () => {
      try {
        await (deps.discoverInstalled ?? discoverInstalled)();
      } catch (err) {
        logger.warn(`[python-venv] interpreter pool prewarm failed: ${errText(err)}`);
      }
    })(),
    (async () => {
      try {
        await (deps.probeToolchain ?? probeToolchain)();
      } catch (err) {
        logger.warn(`[python-venv] toolchain prewarm failed: ${errText(err)}`);
      }
    })(),
  ]);
}

export interface EnsurePythonVenvOptions {
  /** venv 目标目录（deploy 侧固定为 `<releaseDir>/.venv`）。 */
  venvDir: string;
  /** `requirements.txt` 绝对路径；不存在时只建 venv、不装依赖。 */
  requirementsFile?: string | null;
  /** pip 索引（`--index-url` / `-i`）；空值走默认 PyPI。 */
  registryUrl?: string;
  /** 可选的声明版本（纯附加，中台暂不发送）。 */
  runtimeVersion?: string | null;
  /** 传给子进程的部署载荷 env（经 `buildChildEnv` 白名单化）。 */
  envVars?: Record<string, string>;
  /** `runCommand` 的工作目录（deploy 侧为 release 目录）。 */
  cwd?: string;
  signal?: AbortSignal;
  deps?: PythonVenvDeps;
}

export interface PythonVenvResult {
  venvDir: string;
  pythonBin: string;
  pipBin: string;
  interpreter: DeployInterpreter;
  /** 是否由 uv 建的环境——决定依赖安装走 `uv pip` 还是 venv 自带 pip。 */
  createdByUv: boolean;
}

/**
 * 建 venv（必要时装依赖），返回 venv 内的解释器路径。
 *
 * 关键取舍（都对应已实证的坑）：
 *   - **池内解释器 + uv 可用** → `uv venv --python <池内绝对路径> --no-project <dir>`：
 *     与 `execute.ts` 的 argv 逐条对齐（含 `--no-project`）。绝不放裸版本号（D8）。
 *   - 池内解释器但 **uv 不可用** → 直接用该解释器 `-m venv`。池内解释器是真解释器，
 *     不该因为"找不到 uv"就放弃一个本可成功的部署。
 *   - 宿主解释器 → `<验真路径> -m venv`：把验真过的**命令名**直接交给 spawn，
 *     不再经过任何 PATH 二次解析（Store stub 已在这一步之前被拒）。
 *   - **uv 建的 venv 里没有 pip**（uv 默认不 seed），所以依赖安装必须走
 *     `uv pip install --python <venvPython>`；反过来宿主建的 venv 用自带 pip。
 *     若把这两者接错，症状是"venv 建好了却报 pip 不存在"——与本次事故同类的
 *     下游归因困难。
 *   - 建 venv / 装依赖失败一律**清掉半成品 venv**：否则下次会复用一个坏环境。
 */
export async function ensurePythonVenv(
  opts: EnsurePythonVenvOptions,
): Promise<PythonVenvResult> {
  const deps = opts.deps ?? {};
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? fs.existsSync;
  const run: NonNullable<PythonVenvDeps['run']> =
    deps.run ?? ((cmd, args, o) => runCommand(cmd, args, o));
  const env = buildChildEnv(opts.envVars ?? {});
  const bins = venvBinaries(opts.venvDir, platform);

  const interpreter = await resolveDeployInterpreter(
    opts.runtimeVersion,
    deps,
    opts.signal,
  );

  let uvPath: string | null = null;
  if (interpreter.source === 'pool') {
    try {
      const uv = await (deps.resolveUvBin ?? resolveUvBin)();
      uvPath = uv.path;
    } catch (err) {
      logger.warn(`[python-venv] uv resolution failed: ${errText(err)}`);
    }
  }

  let createdByUv = false;
  try {
    if (interpreter.source === 'pool' && uvPath) {
      const args = ['venv', '--python', interpreter.path, '--no-project', opts.venvDir];
      const r = await run(uvPath, args, {
        cwd: opts.cwd,
        env: (deps.uvEnv ?? defaultUvEnv)(),
        timeout: VENV_CREATE_TIMEOUT_MS,
        signal: opts.signal,
      });
      if (r.status !== 0) {
        throw new Error(`uv venv failed: ${resultDetail(r) || 'unknown error'}`);
      }
      createdByUv = true;
    } else {
      const r = await run(interpreter.path, ['-m', 'venv', opts.venvDir], {
        cwd: opts.cwd,
        env,
        timeout: VENV_CREATE_TIMEOUT_MS,
        signal: opts.signal,
      });
      if (r.status !== 0) {
        throw new Error(
          `${interpreter.path} -m venv failed: ${resultDetail(r) || 'unknown error'}`,
        );
      }
    }

    const reqFile = opts.requirementsFile ?? null;
    if (reqFile && exists(reqFile)) {
      if (createdByUv && uvPath) {
        const args = ['pip', 'install', '--python', bins.python, '-r', reqFile];
        if (opts.registryUrl) args.push('--index-url', opts.registryUrl);
        const r = await run(uvPath, args, {
          cwd: opts.cwd,
          env: (deps.uvEnv ?? defaultUvEnv)(),
          timeout: VENV_PIP_TIMEOUT_MS,
          signal: opts.signal,
        });
        if (r.status !== 0) {
          throw new Error(`uv pip install failed: ${resultDetail(r) || 'unknown error'}`);
        }
      } else {
        const args = ['install', '-r', reqFile];
        if (opts.registryUrl) args.push('-i', opts.registryUrl);
        const r = await run(bins.pip, args, {
          cwd: opts.cwd,
          env,
          timeout: VENV_PIP_TIMEOUT_MS,
          signal: opts.signal,
        });
        if (r.status !== 0) {
          throw new Error(`pip install failed: ${resultDetail(r) || 'unknown error'}`);
        }
      }
    }
  } catch (err) {
    removeVenvQuietly(opts.venvDir);
    throw err;
  }

  return {
    venvDir: opts.venvDir,
    pythonBin: bins.python,
    pipBin: bins.pip,
    interpreter,
    createdByUv,
  };
}

/** best-effort 清理半成品 venv：清理失败绝不能掩盖原始失败。 */
function removeVenvQuietly(venvDir: string): void {
  try {
    fs.rmSync(venvDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
