/**
 * WS5（python_task_upload_and_multiversion）—— executor-node 侧解释器池。
 *
 * 语义镜像 `apps/executor-python/interpreters.py`（CONTRACT.md §3.3），是全仓
 * 两个执行器之间"同契约、同行为"的一部分：版本区间、可在线下载下界、失败
 * 分因、并发互斥规则逐条对齐，改一处必须同步另一处。
 *
 * 职责边界：
 *   - 本模块**只**负责"拿到一个可用的、位于池内的解释器绝对路径"；
 *   - venv 创建与依赖安装属于 `routes/execute.ts`（它消费本模块的返回值）。
 *   这条边界是有意的：解释器池是**跨任务共享**的只读缓存，而 venv 是**按任务**
 *   的可变目录，两者生命周期与并发语义完全不同（见 D8：venv 阶段绝不允许
 *   触发下载）。
 */

import fs from 'fs';
import path from 'path';
import { config } from './config';
import { logger } from './logger';
import { runCommand } from './run-command';
import { buildChildEnv } from './env-whitelist';

// ---------------------------------------------------------------------------
// 版本常量（与 apps/executor-python/config.py 逐字对齐）
// ---------------------------------------------------------------------------

/** 任务声明版本格式：`X.Y`（主.次，无补丁号）。 */
export const RUNTIME_VERSION_PATTERN = /^\d+\.\d+$/;

/** 可声明的版本区间（CONTRACT.md §1.1）。 */
export const RUNTIME_VERSION_MIN = '3.7';
export const RUNTIME_VERSION_MAX = '3.14';

/**
 * 在线可下载下界。uv 0.8.17 实测只能下载 CPython 3.8~3.14（CONTRACT.md §0）：
 * `uv python install 3.7` → `error: No download found for request:
 * cpython-3.7-<platform>`（exit 2）。3.7 只能由部署方离线预填缓存池获得。
 */
export const ONLINE_DOWNLOAD_MIN = '3.8';

/** 探测结果缓存 TTL。心跳 30s，绝不能每个心跳都 spawn 一次 uv（NFR-10）。 */
const DISCOVERY_CACHE_TTL_MS = 60_000;

/** `uv python list` 自身的预算——它只读本地状态，超过这个时间说明 uv 卡死。 */
const DISCOVERY_TIMEOUT_MS = 30_000;

/** 解释器不可用的原因分类（供 `prepareFailureReason` 与留痕消费）。 */
export type InterpreterUnavailableReason =
  | 'uv_missing'
  | 'not_downloadable'
  | 'download_failed'
  | 'download_timeout'
  | 'mirror_unreachable'
  | 'corrupt';

export interface InterpreterInfo {
  /** 完整补丁版本，如 `3.7.9`。 */
  version: string;
  /** 绝对路径，**保证**位于解释器池根目录之内（NFR-02 白名单）。 */
  path: string;
  available: boolean;
  /** ISO8601。 */
  discoveredAt: string;
}

/**
 * 解释器无法获取。携带 `.version` / `.reason` / `.detail` 供失败分类与留痕
 * （对应 python 侧 `InterpreterUnavailable`）。
 *
 * `message` 的形态是**契约的一部分**：`prepareFailureReason` 靠它把这类失败
 * 归到 `interpreter_unavailable`，所以任何新增抛出点都必须保留
 * `interpreter <X.Y> unavailable` 这个可识别的骨架。
 */
export class InterpreterUnavailableError extends Error {
  readonly version: string;
  readonly reason: InterpreterUnavailableReason;
  readonly detail: string;

  constructor(
    version: string,
    reason: InterpreterUnavailableReason,
    detail: string,
  ) {
    super(`interpreter ${version} unavailable (${reason}): ${detail}`);
    this.name = 'InterpreterUnavailableError';
    this.version = version;
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// uv 定位（CONTRACT.md §3.3 的四级顺序）
// ---------------------------------------------------------------------------

export type UvSource = 'env' | 'path' | 'bundled' | 'missing';

export interface UvResolution {
  path: string | null;
  source: UvSource;
}

let uvResolution: UvResolution | null = null;

/**
 * desktop 随包内置的 uv 路径。**必须**先探测 `process.resourcesPath` 是否
 * 存在：本模块同时运行在裸 node 与 Electron 内嵌两种形态下，裸 node 里该
 * 属性是 `undefined`（Electron 专有），直接拼路径会得到 `undefined/uv/uv`。
 */
function bundledUvCandidates(): string[] {
  const resourcesPath = (process as unknown as { resourcesPath?: unknown })
    .resourcesPath;
  if (typeof resourcesPath !== 'string' || !resourcesPath) return [];
  const exe = process.platform === 'win32' ? 'uv.exe' : 'uv';
  return [path.join(resourcesPath, 'uv', exe)];
}

/**
 * 池内条目目录 → 解释器可执行文件的候选路径。
 *
 * uv 的池布局：POSIX 在 `bin/` 下，Windows 在条目根目录。与 python 侧
 * `_bin_candidates` 逐条对齐（两种布局都要覆盖，否则某一平台永远探测不到）。
 */
function pythonBinCandidates(entryDir: string): string[] {
  const names =
    process.platform === 'win32'
      ? ['python.exe', 'python3.exe', 'python']
      : ['python3', 'python'];
  const out: string[] = [];
  for (const n of names) out.push(path.join(entryDir, n));
  for (const n of names) out.push(path.join(entryDir, 'bin', n));
  return out;
}

/** 判定一个候选路径是否真的可执行。 */
function isExecutable(file: string): boolean {  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 uv 二进制（缓存一次；uv 的安装位置在一次进程生命周期内不会变）。
 *
 * 顺序（CONTRACT.md §3.3）：
 *   1. `UV_BIN` 环境变量显式指定；
 *   2. PATH 查找 `uv`；
 *   3. desktop 随包内置路径；
 *   4. 都不可用 → `{ path: null, source: 'missing' }`。
 *
 * 第 2 步用 `uv --version` 实跑探测而非 `which`：`which` 在 Windows 的
 * cmd/PowerShell 下不存在（main.ts 的 `detectAvailableRuntimes` 用它是依赖
 * Git-Bash 的既有妥协），而本模块要在桌面客户端裸 Windows 上可靠工作。
 */
export async function resolveUvBin(): Promise<UvResolution> {
  if (uvResolution) return uvResolution;

  const explicit = (config.uvBin || '').trim();
  if (explicit) {
    if (isExecutable(explicit)) {
      uvResolution = { path: explicit, source: 'env' };
      return uvResolution;
    }
    // 显式配置但不可用：明确告警后继续往下找，而不是直接判定 uv 缺失——
    // 配置写错不该让一个本可工作的部署整体降级。
    logger.warn(
      `UV_BIN is set to ${explicit} but it is not an executable file; ` +
        'falling back to PATH lookup',
    );
  }

  const onPath = await runCommand('uv', ['--version'], {
    timeout: 10_000,
    env: buildChildEnv(),
  });
  if (onPath.status === 0) {
    uvResolution = { path: 'uv', source: 'path' };
    return uvResolution;
  }

  for (const candidate of bundledUvCandidates()) {
    if (isExecutable(candidate)) {
      uvResolution = { path: candidate, source: 'bundled' };
      return uvResolution;
    }
  }

  uvResolution = { path: null, source: 'missing' };
  logger.warn(
    'uv is not available (no UV_BIN, not on PATH, no bundled binary) — ' +
      'python tasks that declare runtimeVersion cannot run on this executor',
  );
  return uvResolution;
}

/** 供测试与健康检查重置解析缓存。 */
export function invalidateUvResolution(): void {
  uvResolution = null;
}

// ---------------------------------------------------------------------------
// 版本工具
// ---------------------------------------------------------------------------

/** `X.Y` → `[X, Y]`；格式非法返回 null（**绝不**抛，调用方多为纯判定）。 */
function parseVersionKey(version: string): [number, number] | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  if (!RUNTIME_VERSION_PATTERN.test(trimmed)) return null;
  const [major, minor] = trimmed.split('.');
  return [parseInt(major, 10), parseInt(minor, 10)];
}

function compareKey(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/**
 * 校验并规范化任务声明的版本。
 *
 * NFR-03 命令注入闸门：版本号会拼进 uv argv 与 `.venvs/<taskId>-<X.Y>` 路径，
 * 一个畸形值（`"3.7.9"`、`"../x"`、`"--index-url"`）必须在这里就终止，
 * **绝不**进 argv。admin 侧已有 FR-06b 校验，这里是执行器侧的最后一道。
 */
export function normalizeRuntimeVersion(version: unknown): string {
  if (typeof version !== 'string' || !RUNTIME_VERSION_PATTERN.test(version.trim())) {
    throw new Error(
      `Invalid runtimeVersion (expected X.Y): ${JSON.stringify(version)}`,
    );
  }
  return version.trim();
}

/** 版本是否落在可声明区间内（`3.7` ~ `3.14`）。 */
export function isSupportedVersion(version: string): boolean {
  const key = parseVersionKey(version);
  if (!key) return false;
  return (
    compareKey(key, parseVersionKey(RUNTIME_VERSION_MIN)!) >= 0 &&
    compareKey(key, parseVersionKey(RUNTIME_VERSION_MAX)!) <= 0
  );
}

/**
 * 该版本能否由 uv 在线下载。
 *
 * `< 3.8` → false（3.7 只能离线预填，见 ONLINE_DOWNLOAD_MIN 注释）。
 * `> 3.14` → false（uv 尚无该版本，装也装不到，提前给出明确原因比让 uv 报
 * 一个含糊的下载失败更有用）。
 */
export function isOnlineDownloadable(version: string): boolean {
  const key = parseVersionKey(version);
  if (!key) return false;
  return (
    compareKey(key, parseVersionKey(ONLINE_DOWNLOAD_MIN)!) >= 0 &&
    compareKey(key, parseVersionKey(RUNTIME_VERSION_MAX)!) <= 0
  );
}

/**
 * 池内前缀匹配。
 *
 * 前缀比较**必须**带上点号：`"3.1"` 绝不能匹配 `"3.13.0"`（否则任务声明 3.1
 * 会静默拿到 3.13 的解释器——这是本特性里最容易写错的一处）。
 */
function versionMatches(availableVersion: string, requested: string): boolean {
  return (
    availableVersion === requested ||
    availableVersion.startsWith(`${requested}.`)
  );
}

// ---------------------------------------------------------------------------
// 探测（带 TTL 缓存）
// ---------------------------------------------------------------------------

interface PoolEntry extends InterpreterInfo {
  /** 归一化后的绝对路径，用于去重。 */
  resolved: string;
}

let poolCache: { at: number; entries: PoolEntry[] } | null = null;

/**
 * 路径是否位于解释器池根目录之内（NFR-02/03 白名单断言）。
 *
 * `path.relative` 在 win32 下按大小写不敏感比较（Node 内部 toLowerCase），
 * 与 Windows 文件系统语义一致；`rel === ''` 排除池根自身（它是目录，不是
 * 解释器）。
 */
function isInsidePool(candidate: string): boolean {
  const rel = path.relative(config.uvPythonInstallDir, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function poolRoot(): string {
  return path.resolve(config.uvPythonInstallDir);
}

/**
 * 2-2（audit-r4）：把 realpathSync 的结果归一化为「可跨表示去重」的规范键。
 *
 * Windows 上 `fs.realpathSync` 对长路径返回 `\\?\` 扩展前缀、对 UNC 返回
 * `\\?\UNC\...`，而路径字符串去重/`isInsidePool` 比较用的是普通 `C:\...` /
 * `\\server\...` 形式——同一物理目录的不同表示会绕过 junction 去重，也让
 * 池归属判断失真。这里把扩展前缀剥回普通形式（`\\?\UNC\` → `\\`，
 * `\\?\C:\` → `C:\`），保证别名与其目标、长路径与短路径都收敛到同一键。
 * 仅影响 Windows；POSIX 路径原样返回。
 */
export function canonicalizeRealpathForPlatform(real: string): string {
  if (process.platform !== 'win32') {
    return real;
  }
  let out = real;
  // path.normalize 不处理 \\?\ 前缀，先按已知形态剥壳。
  if (out.startsWith('\\\\?\\UNC\\')) {
    out = '\\\\' + out.slice(8);
  } else if (out.startsWith('\\\\?\\')) {
    out = out.slice(4);
  }
  try {
    out = path.normalize(out);
  } catch {
    // 极端畸形路径：保持剥壳后的原样，交给后续存在性检查决定去留。
  }
  return out;
}

/**
 * 把探测到的路径规范化到"真实文件路径"，用于去重与上报。
 *
 * 为什么必须做（实测发现）：uv 安装 `3.12` 时会同时留下
 * `cpython-3.12-<platform>-none`（**junction**，指向真实目录）和
 * `cpython-3.12.13-<platform>-none`（真实目录）。`uv python list` 会**两个都
 * 报出来**，路径字符串不同但指向同一个 `python.exe`。只按字符串去重会得到
 * 重复条目，让 admin 看到"两个 3.12.13"。
 *
 * 顺带的安全收益：junction 若指向池外，`realpath` 之后会被 `isInsidePool`
 * 拦下——这正是 NFR-02 想防的符号链接逃逸。
 */
function canonicalize(candidate: string): string {
  try {
    return canonicalizeRealpathForPlatform(fs.realpathSync(candidate));
  } catch {
    // 断链/竞态：退回原路径，由后续的存在性检查决定去留。
    return candidate;
  }
}

/**
 * 探测池内已安装的解释器。
 *
 * 实现要点（均为实测结论，不是猜的）：
 *   - 用 `--output-format json` 而非解析文本表格：文本列的空白对齐随版本变化，
 *     JSON 是稳定契约。JSON 里 `version` 直接给完整补丁版本（`3.9.25`），
 *     文本模式只给 `cpython-3.9.25-<platform>-none` 这样的 key 要再剥一层。
 *   - uv 输出的 `path` **可能是相对路径**（实测：池在 cwd 之下时输出
 *     `.tmp-uvprobe\cpython-3.9.25-...\python.exe`）。因此固定 spawn 的 cwd，
 *     并**用同一个 cwd** 去 resolve，两边不能各用各的基准。
 *   - `uv python list` 会一并列出**非池内**的解释器（系统 Python、PATH 上的
 *     `.local/bin/python3.x.exe` shim）。这些必须按池归属过滤掉：任务声明的
 *     版本只能由池内解释器满足，否则"已缓存 3.12"会是一句谎话，而 admin 的
 *     调度过滤正是按这个快照做决策的。
 *   - 同一解释器可能被 uv 以 junction 别名与真实目录**两种路径**列出，
 *     必须按 realpath 去重（见 `canonicalize`）。
 *   - 单条损坏（缺字段、路径非法、文件已消失）**只剔除该项，不抛异常**
 *     （AC-14b）；整体失败返回 `[]` + warn。
 */
export async function discoverInstalled(
  opts: { timeoutMs?: number; force?: boolean } = {},
): Promise<InterpreterInfo[]> {
  const now = Date.now();
  if (!opts.force && poolCache && now - poolCache.at < DISCOVERY_CACHE_TTL_MS) {
    return poolCache.entries.map((e) => ({ ...e }));
  }

  const root = poolRoot();
  const uv = await resolveUvBin();
  if (!uv.path) {
    return fallbackDiscovery('uv binary is not available', root);
  }

  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    logger.warn(
      `Failed to create interpreter pool dir ${root}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return fallbackDiscovery('pool directory is not creatable', root);
  }

  const result = await runCommand(
    uv.path,
    ['python', 'list', '--only-installed', '--output-format', 'json', '--no-config', '--no-progress'],
    {
      cwd: root,
      timeout: opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
      env: uvChildEnv(),
    },
  );

  if (result.status !== 0) {
    // 整体失败：**先退到本地目录扫描**，而不是直接报空池。
    //
    // 与 python 侧 `_fallback_discovery` 同款（CONTRACT.md §0.3）。为什么必需：
    // 实测池内只要有一个**同平台但不可运行**的条目，`uv python list` 就整体
    // 非零退出，并且**连健康条目也一并吞掉**。若此时报"空池"，执行器会对 admin
    // 宣称零解释器 → 所有声明版本的任务被拒，而池里的健康版本其实仍可用。
    // 一个局部损坏被放大成整个多版本特性不可用，且症状指向的位置与真实原因无关。
    const reason = `uv python list failed (status ${result.status}): ${
      result.stderr.trim() || result.stdout.trim()
    }`;
    logger.warn(reason);
    return fallbackDiscovery(reason, root);
  }

  const entries: PoolEntry[] = [];
  const seen = new Set<string>();
  const discoveredAt = new Date().toISOString();

  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch (err) {
    const reason = `uv python list returned unparseable JSON: ${
      err instanceof Error ? err.message : String(err)
    }`;
    logger.warn(reason);
    return fallbackDiscovery(reason, root);
  }
  if (!Array.isArray(raw)) {
    logger.warn('uv python list returned a non-array JSON payload');
    poolCache = { at: now, entries: [] };
    return [];
  }

  for (const item of raw) {
    try {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const rawPath = rec.path;
      const version = rec.version;
      if (typeof rawPath !== 'string' || !rawPath) continue;
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) continue;

      // 相对路径按 spawn 的 cwd（= 池根）解析，与 uv 的显示基准一致。
      const resolved = path.resolve(root, rawPath);
      if (!isInsidePool(resolved)) continue; // 系统/PATH shim —— 不属于本池
      if (!isExecutable(resolved)) {
        // 单条损坏：剔除该项但保留其余（AC-14b）。**剔除而非标记
        // available:false**——与 python 侧 `usable = [e for e in entries if
        // e.available]` 一致：清单的消费者是 admin 的调度过滤，一个不可执行的
        // 条目留在清单里就是一个"能派单但必然失败"的假阳性。
        logger.warn(`Interpreter pool entry is not executable, dropping it: ${resolved}`);
        continue;
      }
      // junction 别名与真实目录指向同一个解释器 → 按 realpath 去重。
      const canonical = canonicalize(resolved);
      if (!isInsidePool(canonical)) {
        // junction 指向池外：符号链接逃逸，绝不返回（NFR-02）。
        logger.warn(
          `Interpreter pool entry escapes the pool via a link, dropping it: ${resolved} -> ${canonical}`,
        );
        continue;
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);

      entries.push({
        version,
        path: canonical,
        available: true,
        discoveredAt,
        resolved: canonical,
      });
    } catch (err) {
      // 逐条 try/catch：一个畸形条目不能让整次探测归零。
      logger.warn(
        `Skipping malformed uv python list entry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  entries.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  poolCache = { at: now, entries };
  logger.debug(
    `Discovered ${entries.length} interpreter(s) in ${root}: ` +
      entries.map((e) => e.version).join(', '),
  );
  return entries.map((e) => ({ ...e }));
}

/**
 * 池内前缀匹配 → 绝对路径；池内没有可用解释器时返回 `null`。
 *
 * **同步**读取探测缓存：调用方（含心跳）不该为一次查询付出 spawn 的代价。
 * 缓存冷启动时返回 `null`（语义是"尚未知晓"，不是"不可用"）——需要确定性
 * 答案的调用方必须先 `await discoverInstalled()`，`ensureVersion` 正是这么做的。
 *
 * 返回的路径**只可能**来自探测到的池内条目，绝不接受调用方提供的路径
 * （NFR-02/03）。
 */
export function resolvePythonBin(version: string): string | null {
  if (!poolCache) return null;
  const requested = version.trim();
  if (!RUNTIME_VERSION_PATTERN.test(requested)) return null;
  const hit = poolCache.entries.find(
    (e) => e.available && versionMatches(e.version, requested),
  );
  return hit ? hit.resolved : null;
}

/**
 * 池快照，供失败留痕（FR-12）。
 *
 * **只读目录、不 spawn uv**——与 python 侧 `pool_summary()` 逐条对齐。留痕发生
 * 在失败路径上，不能因为"要记录失败原因"再引入一次同样可能失败/耗时的 uv
 * 调用。版本号从目录名 `cpython-<ver>-…` 提取，与 uv 自己的命名约定一致
 * （CONTRACT.md §0），因此**不依赖探测缓存是否已填充**。
 *
 * 注意这里列的是"池内目录"，比 `discoverInstalled` 的"可用解释器"更宽：目录
 * 存在但解释器文件缺失时它仍会出现。这个差异是有意的——留痕要回答"池里有什么
 * 痕迹"，而调度清单要回答"现在能用什么"。
 */
export function poolSummary(): { installDir: string; versions: string[] } {
  const root = poolRoot();
  const versions: string[] = [];
  try {
    for (const name of fs.readdirSync(root)) {
      const m = /^cpython-(\d+\.\d+(?:\.\d+)?)-/.exec(name);
      if (m) versions.push(m[1]);
    }
  } catch {
    /* 池目录不存在/不可读：如实返回空清单 */
  }
  return { installDir: root, versions: versions.sort() };
}

/** 上报给 admin 的 `interpreters` 数组（CONTRACT.md §2.3 结构）。 */
export function interpreterSnapshot(): InterpreterInfo[] {
  return (poolCache?.entries ?? []).map(({ resolved: _resolved, ...rest }) => ({ ...rest }));
}

/**
 * 启动期/心跳的清单 provider：懒探测 + 复用探测缓存。
 *
 * 与 python 侧 `get_interpreters_snapshot()` 同语义：首次调用触发探测，之后
 * 走 WS3 模块自带的 TTL 缓存，**心跳路径零 uv 进程开销**（NFR-10）。
 * 探测失败已在 `discoverInstalled` 内部收敛为 `[]`，绝不抛出——上报是能力快照，
 * 让心跳失败会把执行器判成 OFFLINE，代价远大于少报一次清单。
 */
export async function interpretersForReport(): Promise<InterpreterInfo[]> {
  try {
    await discoverInstalled();
  } catch (err) {
    logger.warn(
      `Interpreter discovery failed (reporting an empty pool): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return interpreterSnapshot();
}

/**
 * 使探测缓存失效。下载成功、回收版本、以及测试里替换池内容后调用
 * （CONTRACT.md §3.2 硬约束）。
 */
export function invalidateCache(): void {
  poolCache = null;
}

// ---------------------------------------------------------------------------
// 池体积红线 + 引用感知 LRU 回收（NFR-15/D12）
// ---------------------------------------------------------------------------
//
// 语义镜像 `apps/executor-python/maintenance.enforce_interpreter_pool_limits`：
// 池只增不删会让长跑执行器被 ~250MB/版本 填满磁盘。两条可配置红线（默认值与
// python 侧一致：单版本 250MB / 总池 4GB），触发后按目录 mtime 升序回收最久
// 未使用的版本，直到落回红线。三条硬约束：
//   1. 引用感知：仍被任务 venv 依赖的版本一律跳过（venv 的 python.exe 只是
//      shim，真身就是池里那个目录——删了 venv 当场报废，依赖记在
//      `pyvenv.cfg` 的 `home = <UV_PYTHON_INSTALL_DIR>/cpython-…`）；
//   2. 全部候选被 pin 住时不删任何东西，只留响亮告警；
//   3. 只碰解释器池（`cpython-*` 目录），绝不碰 venv/workdir（那是
//      file-logger.cleanupWorkDir 的 TTL 清扫职责）。

/** 递归目录字节数（不可读项按 0 计——计量失败不该中断清扫）。 */
function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeBytes(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    } catch {
      /* raced / unreadable — count as 0 */
    }
  }
  return total;
}

/**
 * 跨平台路径规范化键（python `os.path.normcase(os.path.normpath(...))` 对等）。
 * Windows 文件系统大小写不敏感，把两个只差大小写的 home/池目录视为同一引用。
 */
function normalizePathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface PoolVersionEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

/**
 * 池内 `cpython-*` 版本目录 → (name, path, size, mtime)。
 *
 * 只收 `cpython-` 前缀目录（与 `removeCorruptEntries` / `poolSummary` 的过滤
 * 一致）：池根下还可能有 uv 的 `.cache`（下载缓存），那不是"版本"，不在本治理
 * 范围（避免误删下载缓存）。
 */
function poolVersionEntries(root: string): PoolVersionEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: PoolVersionEntry[] = [];
  for (const name of names) {
    if (!/^cpython-/.test(name)) continue;
    const full = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    out.push({ name, path: full, size: dirSizeBytes(full), mtime: st.mtimeMs });
  }
  return out;
}

/** 读 `<venv>/pyvenv.cfg` 的 `home =` 值；缺失/损坏返回 null。 */
function readPyvenvCfgHome(venvDir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(venvDir, 'pyvenv.cfg'), 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      if (line.slice(0, idx).trim().toLowerCase() === 'home') {
        return line.slice(idx + 1).trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `<WORK_DIR>/.venvs/*` 的依赖解释器 home → 依赖它的 venv 目录名列表。
 *
 * 为什么必须有这一步（python 侧实测确认的生产事故类缺陷）：`uv venv` 建出的
 * venv 里 `Scripts/python.exe` 只是约 600KB 的 shim，真正的解释器仍在缓存池里，
 * 依赖记在 `pyvenv.cfg` 的 `home = <UV_PYTHON_INSTALL_DIR>/cpython-…`。池里那个
 * 目录一旦被删，该 venv 当场报废（`No Python at '...'`），且是静默报废。
 */
function venvDependencyHomes(): Map<string, string[]> {
  const homes = new Map<string, string[]>();
  const venvRoot = path.join(config.workDir, '.venvs');
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(venvRoot, { withFileTypes: true });
  } catch {
    return homes; // 从未建过 venv（或不可读）→ 无依赖
  }
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const home = readPyvenvCfgHome(path.join(venvRoot, child.name));
    if (!home) continue;
    const key = normalizePathKey(home);
    const list = homes.get(key);
    if (list) list.push(child.name);
    else homes.set(key, [child.name]);
  }
  return homes;
}

export interface InterpreterPoolReclaimResult {
  reclaimedVersions: number;
  reclaimedBytes: number;
  poolBytes: number;
  overLimit: number;
  pinnedVersions: number;
}

/**
 * 回收池内一个版本目录。**先做硬安全断言，再删。**
 *
 * 断言（任一不满足即拒绝删除）：目标必须严格位于池根之内、不得是池根本身。
 * 删除用 `fs.rmSync`（与 `removeCorruptEntries` 同一路径；python 侧优先
 * `uv python uninstall`，node 侧无对应簿记子命令，直接 rmtree）。
 */
function reclaimInterpreterVersion(poolRootDir: string, target: string): boolean {
  if (!isInsidePool(target)) {
    logger.error(
      `Refusing to reclaim ${target}: it is not inside the interpreter pool ${poolRootDir}`,
    );
    return false;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    // best-effort：一次 EACCES 不该让红线失效（其余候选仍会被尝试）。
    logger.warn(
      `Interpreter reclaim failed for ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return true;
}

/**
 * 尝试回收一个候选版本。返回 [是否已回收, 释放字节数]。
 *
 * 依赖检查是**否决权**：只要还有 venv 的 home 指向该目录（或其子目录），就绝不
 * 回收——宁可让池暂时超红线（响亮告警）也不能把用户的 venv 弄废。
 */
function attemptReclaim(
  entry: PoolVersionEntry,
  dependencyHomes: Map<string, string[]>,
  reason: string,
): [boolean, number] {
  const key = normalizePathKey(entry.path);
  const dependents: string[] = [...(dependencyHomes.get(key) ?? [])];
  for (const [homeKey, names] of dependencyHomes) {
    // home 可能精确指向版本目录，也可能指向它的子目录（同样以该版本为真身）。
    if (homeKey === key || homeKey.startsWith(key + path.sep)) dependents.push(...names);
  }
  if (dependents.length > 0) {
    logger.warn(
      `Skipping reclamation of interpreter ${entry.name} (${reason}): ` +
        `${dependents.length} task venv(s) still depend on it ` +
        `(${dependents.slice(0, 5).join(', ')}). Deleting it would brick those venvs ` +
        '(they are shims over this directory).',
    );
    return [false, 0];
  }
  logger.warn(
    `Reclaiming interpreter ${entry.name} (${entry.size} bytes, last used ` +
      `${new Date(entry.mtime).toISOString()}, ${reason}) — no task venv depends on it`,
  );
  reclaimInterpreterVersion(poolRoot(), entry.path);
  return [true, entry.size];
}

/**
 * NFR-15/D12：解释器池体积红线 + **引用感知的**最久未使用（LRU）回收。
 *
 * 两条可配置红线（默认 250MB / 4GB，与 python 侧一致）。触发即先告警，再按
 * 目录 mtime 升序尝试回收，直到落回红线。回收后调用 `invalidateCache()` 让上报
 * 清单收敛。安全地从定时清扫（file-logger.cleanupWorkDir）调用；本函数自身
 * 不抛（内部已收敛），调用方仍可再包一层 try/catch。
 */
export function enforceInterpreterPoolLimits(): InterpreterPoolReclaimResult {
  const counts: InterpreterPoolReclaimResult = {
    reclaimedVersions: 0,
    reclaimedBytes: 0,
    poolBytes: 0,
    overLimit: 0,
    pinnedVersions: 0,
  };
  const root = poolRoot();
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch {
    return counts; // 池不存在（从未下载）→ 无操作
  }
  if (!st.isDirectory()) return counts;

  const singleLimit = Math.max(1, config.interpreterSingleVersionMb) * 1024 * 1024;
  const totalLimit = Math.max(1, config.interpreterTotalGb) * 1024 * 1024 * 1024;

  let entries = poolVersionEntries(root);
  if (entries.length === 0) return counts;
  let totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  counts.poolBytes = totalBytes;
  // 依赖快照只取一次：回收过程中 venv 集合不会变（本函数不碰 venv）。
  const dependencyHomes = venvDependencyHomes();

  // 1) 单版本超限：每个超限版本单独尝试回收。
  const oversized = entries.filter((e) => e.size > singleLimit);
  if (oversized.length > 0) {
    counts.overLimit += oversized.length;
    for (const entry of oversized) {
      logger.warn(
        `Interpreter version ${entry.name} exceeds the per-version limit ` +
          `(${entry.size} bytes > ${singleLimit} bytes) (D12/NFR-15)`,
      );
      const [reclaimed, freed] = attemptReclaim(entry, dependencyHomes, 'over per-version limit');
      if (reclaimed) {
        counts.reclaimedVersions++;
        counts.reclaimedBytes += freed;
        totalBytes -= freed;
      } else {
        counts.pinnedVersions++;
      }
    }
    entries = entries.filter((e) => {
      try {
        return fs.existsSync(e.path);
      } catch {
        return false;
      }
    });
  }

  // 2) 总池超限：按 mtime 升序（最久未使用优先）逐个回收，直到落回红线。
  if (totalBytes > totalLimit) {
    counts.overLimit++;
    logger.warn(
      `Interpreter pool ${root} is over the total limit (${totalBytes} bytes > ${totalLimit} bytes); ` +
        'reclaiming least-recently-used versions (D12/NFR-15)',
    );
    for (const entry of [...entries].sort((a, b) => a.mtime - b.mtime)) {
      if (totalBytes <= totalLimit) break;
      const [reclaimed, freed] = attemptReclaim(entry, dependencyHomes, 'pool over total limit');
      if (reclaimed) {
        counts.reclaimedVersions++;
        counts.reclaimedBytes += freed;
        totalBytes -= freed;
      } else {
        counts.pinnedVersions++;
      }
    }
    if (totalBytes > totalLimit) {
      // 全部候选都被依赖 pin 住：不删任何东西，但必须让人看见。
      logger.warn(
        `Interpreter pool is still over the total limit (${totalBytes} bytes > ${totalLimit} bytes) — ` +
          'every candidate version is still referenced by a task venv, so nothing was reclaimed. ' +
          `Remove the dependent task venvs under ${path.join(config.workDir, '.venvs')} ` +
          '(or raise INTERPRETER_TOTAL_GB) to allow reclamation.',
      );
    }
  }

  if (counts.reclaimedVersions > 0) {
    counts.poolBytes = Math.max(0, totalBytes);
    try {
      invalidateCache();
    } catch (err) {
      logger.warn(
        `interpreters.invalidateCache failed after reclaim: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 子进程环境
// ---------------------------------------------------------------------------

/**
 * uv 子进程环境：**只**给 uv 它真正需要的变量。
 *
 * 复用 `buildChildEnv` 的白名单纪律——`UV_PYTHON_INSTALL_DIR` 等并不在
 * 白名单里，只能经 `extra` 显式注入，这正好是我们想要的：执行器的密钥
 * （EXECUTOR_SHARED_TOKEN / EXECUTION_CALLBACK_SECRET）无论 process.env
 * 里有什么都不会流到 uv。
 *
 * `UV_PYTHON_DOWNLOADS=manual` 是**关键加固**（实测）：它让「venv 阶段绝不
 * 隐式下载」从"我们记得传绝对路径"升级为 uv 自身强制的不变量——
 * `uv venv --python 3.11` 在池内无 3.11 时报
 * `No interpreter found for Python 3.11 in managed installations, search path,
 * or registry`（exit 2），而**不会**偷偷去下载。同时它**不**影响显式的
 * `uv python install 3.9`（实测仍正常下载），所以下载路径照常可用。
 *
 * `UV_NO_PROGRESS`/`--no-progress`：进度条是给终端看的，在管道里只会污染
 * 我们解析的 stdout。
 */
function uvChildEnv(): NodeJS.ProcessEnv {
  const root = poolRoot();
  const extra: Record<string, string | undefined> = {
    UV_PYTHON_INSTALL_DIR: root,
    UV_CACHE_DIR: path.join(root, '.cache'),
    UV_PYTHON_DOWNLOADS: 'manual',
    UV_NO_PROGRESS: '1',
  };
  // 镜像（可选）：同时经 env 与 `--mirror` 传递。env 覆盖所有 uv 子命令，
  // argv 保证即便某个 uv 版本不认该 env 也仍然生效。值已在 config 层过
  // 凭据自由校验（无 userinfo/query/fragment）。
  if (config.uvPythonInstallMirror) {
    extra.UV_PYTHON_INSTALL_MIRROR = config.uvPythonInstallMirror;
  }
  return buildChildEnv(extra);
}

// ---------------------------------------------------------------------------
// 下载（D13/NFR-16 并发互斥）
// ---------------------------------------------------------------------------

/**
 * 全局**有界并发**下载（D13/NFR-16 并发互斥）。
 *
 * 原实现是全局单下载队列（同一时刻至多一个 in-flight 下载）：批量任务同时
 * 首次声明不同版本时，N 个版本要 N × 下载时间串行排队（每版本实测约
 * 13~17s，弱网更久，见深度评审 P1"批量首次启动"）。这里放宽为有界并发：
 *
 * - **不同版本写池内不同目录**（`cpython-<ver>-…`）——uv 对"同一安装目录
 *   并发写不安全"的约束不跨版本；per-version in-flight 去重保证同一版本
 *   至多一次下载。这是"按版本并行"安全性的根基。
 * - 并发上限（默认 2，`INTERPRETER_DOWNLOAD_CONCURRENCY` 可调，范围 [1,8]）
 *   保留 O-10 的顾虑：弱网/低磁盘执行器上防止争抢带宽与 inode。1 = 旧版
 *   全局单队列行为。
 * - 保持"前一个无论成功失败都放行后一个"的语义：显式 waiters 队列 + 计数
 *   实现，一次下载失败不会毒化队列（Promise 链实现里最容易漏的一处）。
 */
let activeDownloads = 0;
const downloadWaiters: Array<() => void> = [];

function withDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    // 动态读并发（热重载 config 生效）；对 undefined/NaN 回落默认 2，
    // 再钳到 [1, 8]——NaN 会让 `activeDownloads >= NaN` 恒为 false，
    // 静默退化成无界并发，这是本函数唯一必须防住的形态。
    const configured = Number(config.interpreterDownloadConcurrency);
    const concurrency = Math.min(
      Math.max(Number.isFinite(configured) ? configured : 2, 1),
      8,
    );
    if (activeDownloads >= concurrency) {
      await new Promise<void>((resolve) => downloadWaiters.push(resolve));
    }
    activeDownloads++;
    try {
      return await fn();
    } finally {
      activeDownloads--;
      // 单释放单放行：无论成功还是失败，恰好唤醒下一个等待者。
      const next = downloadWaiters.shift();
      if (next) next();
    }
  };
  return run();
}

/** per-version in-flight 去重：同一版本的并发请求共享同一次下载。 */
const inFlight = new Map<string, Promise<string>>();

/**
 * 确保某个 `X.Y` 版本的池内解释器可用，返回其**绝对路径**。
 *
 * 流程：
 *   1. 版本格式校验（NFR-03，先于任何 argv）；
 *   2. 池内命中 → 直接复用（不 spawn uv）；
 *   3. per-version 去重 → 并发调用共享同一次下载（D13）；
 *   4. 全局单下载队列（D13）；
 *   5. `< 3.8` 且池内没有 → `not_downloadable`，消息指引离线预填；
 *   6. `uv python install <X.Y>`，独立超时预算（D11/NFR-13）；
 *   7. 后置校验：路径存在 + 主次版本相符，否则清理损坏目录并报 `corrupt`。
 */
export async function ensureVersion(
  version: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  // NFR-03：畸形版本在这里终止，绝不进 argv / 绝不进路径。
  const requested = normalizeRuntimeVersion(version);

  // 先刷新一次探测缓存，让 resolvePythonBin 的同步快路径有依据。
  await discoverInstalled();
  const cached = resolvePythonBin(requested);
  if (cached) return cached;

  const existing = inFlight.get(requested);
  if (existing) return existing;

  const pending = withDownloadSlot(() =>
    installVersion(requested, opts.timeoutMs ?? config.interpreterDownloadTimeoutMs),
  ).finally(() => {
    // 只清自己这一格：后来者可能已经放进去了一个新的 promise。
    if (inFlight.get(requested) === pending) inFlight.delete(requested);
  });
  inFlight.set(requested, pending);
  return pending;
}

/**
 * 本机在 uv 池目录命名中的平台三元组（`<os>-<arch>-<libc>`）。
 *
 * 只用于**离线预填指引文案**（把运维指向正确的目录名）。实测（CONTRACT.md §0.2）：
 *   - uv 的词汇是 `linux-x86_64-gnu` / `linux-x86_64-musl` / `windows-x86_64-none`
 *     / `macos-x86_64-none` / `macos-aarch64-none`；
 *   - **目录名到此为止，不要再补 `-none`**（Windows/macOS 的 `-none` 是 libc
 *     槽位，Linux 的槽位是 `gnu`/`musl`）；
 *   - 判定不出时返回 `'<uv-platform-triple>'`，宁可让运维去查
 *     `uv python list --all-versions --all-platforms`，也不要给一个错误的名字。
 */
export function uvPlatformTriple(): string {
  const arch =
    process.arch === 'arm64' ? 'aarch64'
    : process.arch === 'x64' ? 'x86_64'
    : process.arch === 'ia32' ? 'i686'
    : null;
  if (!arch) return '<uv-platform-triple>';
  if (process.platform === 'win32') return `windows-${arch}-none`;
  if (process.platform === 'darwin') return `macos-${arch}-none`;
  if (process.platform === 'linux') {
    // musl 与 glibc 的产物不通用；Alpine 执行器（executor-node 镜像）必须用 musl。
    // 依据 musl 的动态加载器或 Alpine 标记判定，判不出按 gnu（多数发行版）。
    let libc = 'gnu';
    try {
      if (fs.existsSync('/etc/alpine-release')) libc = 'musl';
      else if (fs.existsSync('/lib')) {
        if (fs.readdirSync('/lib').some((n) => n.startsWith('ld-musl-'))) libc = 'musl';
      }
    } catch {
      /* 权限/竞态：保守按 gnu */
    }
    return `linux-${arch}-${libc}`;
  }
  return '<uv-platform-triple>';
}

/**
 * uv 探测失败后的兜底：改用**本地目录扫描**，并如实留痕。
 *
 * 与 python 侧 `_fallback_discovery` / `_scan_pool_directory` 逐条对齐
 * （CONTRACT.md §0.3）。不 spawn 任何进程（NFR-10 心跳不 spawn 的约束成立），
 * 只在 uv 已经失败时触发，因此不改变正常路径行为。
 *
 * 三重过滤，缺一不可：
 *   1. **池内**：Windows 上的"可执行"只判存在性，不过滤会把池外 blobs 收进来；
 *   2. **本机平台**：共享卷里 coexists 着 glibc/musl 产物，外来平台的
 *      `bin/python3` 在 POSIX 上带 +x 位、`isExecutable` 会放行，但它在这台机器上
 *      **跑不起来**；报给 admin 就是"宣称可用却必然失败"；
 *   3. **真实可执行**：与 uv 路径同一口径（单条损坏只剔除该项，AC-14b）。
 */
function fallbackDiscovery(reason: string, root: string): InterpreterInfo[] {
  const entries: PoolEntry[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    // 池目录不存在/不可读：如实报空（执行器仍能启动）。
    logger.warn(`uv discovery failed (${reason}); pool dir ${root} is unreadable — empty pool`);
    poolCache = { at: Date.now(), entries: [] };
    return [];
  }

  const token = uvPlatformTriple();
  const canCheckPlatform = !token.startsWith('<');
  for (const name of names.sort()) {
    // 目录名全形：`cpython-<完整版本>-<平台三元组>`（三元组之后没有东西）。
    const m = /^cpython-(\d+\.\d+\.\d+)-([^-]+-[^-]+-[^-]+)$/.exec(name);
    if (!m) continue;
    const [, version, dirPlatform] = m;
    if (canCheckPlatform && dirPlatform !== token) continue; // 外来平台
    const dir = path.join(root, name);
    const candidate = pythonBinCandidates(dir).find((c) => {
      try {
        return fs.statSync(c).isFile() && isExecutable(c);
      } catch {
        return false;
      }
    });
    if (!candidate) {
      logger.warn(`Pool entry ${name} has no runnable interpreter — skipped`);
      continue;
    }
    const canonical = canonicalize(candidate);
    if (!isInsidePool(canonical)) continue; // 符号链接逃逸
    entries.push({
      version,
      path: candidate,
      available: true,
      discoveredAt: new Date().toISOString(),
      resolved: canonical,
    });
  }

  if (entries.length > 0) {
    logger.warn(
      `uv discovery failed (${reason}); recovered ${entries.length} interpreter(s) ` +
        `from a local pool scan: ${entries.map((e) => e.version).join(', ')}`,
    );
  } else {
    logger.warn(
      `uv discovery failed (${reason}) and the local pool scan found nothing usable ` +
        `— reporting an empty pool (executor keeps running)`,
    );
  }
  poolCache = { at: Date.now(), entries };
  return entries.map((e) => ({ ...e }));
}

async function installVersion(
  requested: string,
  timeoutMs: number,
): Promise<string> {
  const uv = await resolveUvBin();
  if (!uv.path) {
    throw new InterpreterUnavailableError(
      requested,
      'uv_missing',
      'uv is not installed on this executor; install uv, set UV_BIN, or use a '
        + 'client build that bundles uv',
    );
  }

  const root = poolRoot();

  // 排队期间别人可能已经装好了（全局单下载队列的等待者走"缓存命中"复用，
  // 不得重复下载——CONTRACT.md §3.2 并发互斥）。
  invalidateCache();
  await discoverInstalled({ force: true });
  const afterQueue = resolvePythonBin(requested);
  if (afterQueue) return afterQueue;

  if (!isSupportedVersion(requested)) {
    throw new InterpreterUnavailableError(
      requested,
      'not_downloadable',
      `version is outside the supported range ${RUNTIME_VERSION_MIN}~${RUNTIME_VERSION_MAX}`,
    );
  }

  if (!isOnlineDownloadable(requested)) {
    // 3.7 及更早：uv 没有对应下载（CONTRACT.md §0 实测），只能离线预填。
    // 明确告诉运维"该怎么做"，而不是抛一句 uv 的 No download found 让人猜。
    //
    // ⚠ 目录名纪律（实测坑，勿改）：
    //   1. 平台段必须用 **uv 自己的三元组**，不能用 python-build-standalone 的
    //      发布名；uv 对不匹配的目录名**静默忽略**（不报错，只是探测不到）。
    //   2. 目录名全形是 `cpython-<完整版本>-<uv三元组>`，**三元组之后不要再补
    //      `-none`**：Windows/macOS 的三元组本身就以 `-none` 结尾（libc 槽位），
    //      Linux 的是 `gnu`/`musl`，再补一个 `-none` 会让 uv 静默忽略该目录
    //      （实测 `...-linux-x86_64-gnu-none` 甚至被判为非法下载请求）。
    //   3. 不要在模板里写死补丁号 `.9`（3.6/3.5 会走到同一分支）。
    const platform = uvPlatformTriple();
    throw new InterpreterUnavailableError(
      requested,
      'not_downloadable',
      `uv cannot download Python ${requested} online (only >= ${ONLINE_DOWNLOAD_MIN} is downloadable); `
        + `pre-provision it offline by placing python-build-standalone `
        + `python/install/* into ${path.join(root, `cpython-${requested}.x-${platform}`)} `
        + `(directory name: cpython-<full-version>-<uv platform triple>, `
        + `e.g. linux-x86_64-gnu / linux-x86_64-musl / windows-x86_64-none; `
        + `do NOT append an extra "-none" after the triple)`,
    );
  }

  const args = ['python', 'install', '--no-config', '--no-progress'];
  if (config.uvPythonInstallMirror) {
    args.push('--mirror', config.uvPythonInstallMirror);
  }
  args.push(requested);

  const started = Date.now();
  logger.info(`Installing Python ${requested} via uv into ${root} ...`);
  const result = await runCommand(uv.path, args, {
    cwd: root,
    timeout: timeoutMs,
    env: uvChildEnv(),
  });
  const elapsed = Date.now() - started;

  if (result.status !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || 'uv python install failed');
    // run-command 超时会 SIGKILL 进程树，close 事件带回非零 status；用耗时
    // 是否触顶区分"超时"与"真的失败"——两者的运维处置完全不同。
    if (elapsed >= timeoutMs - 1_000) {
      throw new InterpreterUnavailableError(
        requested,
        'download_timeout',
        `download did not finish within ${timeoutMs}ms`,
      );
    }
    const reason: InterpreterUnavailableReason = /mirror|Request failed|tcp connect|dns|timed? ?out/i.test(
      detail,
    )
      ? 'mirror_unreachable'
      : 'download_failed';
    throw new InterpreterUnavailableError(requested, reason, detail);
  }

  // 后置校验：uv 返回 0 不等于池里就有可用的解释器（磁盘满、解压半途失败等
  // 都可能留下一个"装了一半"的目录）。必须实测路径存在 + 主次版本相符。
  invalidateCache();
  const discovered = await discoverInstalled({ force: true });
  const hit = resolvePythonBin(requested);
  const matching = discovered.filter(
    (e) => e.available && versionMatches(e.version, requested),
  );

  if (!hit || matching.length === 0) {
    // 损坏不可修复：清掉该版本的残留目录，避免下一次仍然命中一个坏解释器。
    removeCorruptEntries(requested);
    invalidateCache();
    throw new InterpreterUnavailableError(
      requested,
      'corrupt',
      `uv reported success but no usable Python ${requested} appeared in ${root}`,
    );
  }

  logger.info(
    `Python ${requested} ready at ${hit} (resolved ${matching[0].version}, ${elapsed}ms)`,
  );
  return hit;
}

/**
 * 清理某版本在池内的残留目录（损坏恢复）。
 *
 * 只删**目录名以该版本开头**的条目，且必须位于池根之下——一次失败的安装
 * 不该有机会碰到别的版本，更不该有机会删到池外。删除失败只告警：损坏目录
 * 本身不影响本次失败语义，下一次 `uv python install` 会覆盖它。
 */
function removeCorruptEntries(requested: string): void {
  const root = poolRoot();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    // 目录名形如 cpython-3.7.9-<platform>-none 或 cpython-3.7-<platform>-none。
    if (!/^cpython-/.test(name)) continue;
    const m = /^cpython-(\d+\.\d+(?:\.\d+)?)-/.exec(name);
    if (!m) continue;
    if (!versionMatches(m[1], requested)) continue;
    const target = path.join(root, name);
    if (!isInsidePool(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      logger.warn(`Removed corrupt interpreter entry ${target}`);
    } catch (err) {
      logger.warn(
        `Failed to remove corrupt interpreter entry ${target}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** 仅测试使用：清空并发状态，避免用例之间互相污染。 */
export function __resetForTests(): void {
  poolCache = null;
  uvResolution = null;
  inFlight.clear();
  activeDownloads = 0;
  downloadWaiters.length = 0;
}
