/**
 * python_task_multiversion：客户端执行器的 uv / 解释器池路径解析（**纯函数**）。
 *
 * 为什么要独立成模块：`executor-process.ts` 在模块级 `import { app } from 'electron'`，
 * 在 Electron 运行时之外无法加载，于是里面的路径逻辑没法做自检。把决策逻辑
 * 抽成不依赖 Electron 的纯函数（由调用方注入 `resourcesPath` / `appPath` /
 * `userDataDir`），既能在 `npm run test:main` 里跑，也让"缺 uv 怎么办"这类
 * 关键分支有回归闸。这与既有 `path-domain.ts` 的组织方式一致。
 */

export interface UvPathInputs {
  /** `app.isPackaged`——打包态走 resourcesPath，开发态走 appPath。 */
  isPackaged: boolean;
  /** Electron `process.resourcesPath`（打包态安装目录下的 resources/）。 */
  resourcesPath: string;
  /** Electron `app.getAppPath()`（开发态仓库内 app 根）。 */
  appPath: string;
  /** Electron `app.getPath('userData')`。 */
  userDataDir: string;
  /** `process.platform`。 */
  platform: NodeJS.Platform;
  /** 文件存在性判定（注入以便自检；生产传 fs.existsSync + isFile）。 */
  existsFile: (candidate: string) => boolean;
}

/** uv 可执行文件名随平台变化。 */
export function uvExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'uv.exe' : 'uv';
}

/**
 * 定位随客户端分发的 uv 可执行文件；不存在则返回 `null`（**不抛**）。
 *
 * 为什么需要（功能对等）：客户端执行器要支持"按任务声明的 Python 版本执行"，
 * 这依赖 uv 管理解释器池。桌面端**不保证**用户机器 PATH 上有 uv，所以走
 * "自带优先、PATH 兜底"。
 *
 * 覆盖两种布局：
 *   - 打包态：`<resourcesPath>/uv/<bin>`（electron-builder extraResources 落点）；
 *   - 开发态：`<appPath>/resources/uv/<bin>`，以及仓库布局下再上一层。
 *
 * 返回 `null` **不是错误**：调用方据此不设 `UV_BIN`，交由 executor-node 自己
 * 的解析链（UV_BIN → PATH → bundled）兜底。绝不能因为"没自带 uv"就让客户端
 * 执行器起不来——存量任务（不声明版本）根本不碰 uv。
 */
export function resolveBundledUvPath(inputs: UvPathInputs): string | null {
  const exe = uvExecutableName(inputs.platform);
  const candidates = inputs.isPackaged
    ? [joinPath(inputs.resourcesPath, 'uv', exe)]
    : [
        joinPath(inputs.appPath, 'resources', 'uv', exe),
        joinPath(inputs.appPath, '..', 'resources', 'uv', exe),
      ];
  for (const candidate of candidates) {
    // 存在性判定必须容错：坏符号链接/权限不足都可能抛，此时继续找下一个。
    try {
      if (inputs.existsFile(candidate)) return candidate;
    } catch {
      /* 继续 */
    }
  }
  return null;
}

/**
 * 解释器缓存池目录（`UV_PYTHON_INSTALL_DIR`）。
 *
 * 优先级：显式配置（非空白）> `<userData>/interpreters`。
 *
 * 为什么默认落在 userData 而不是安装目录：安装目录在 Windows 上通常是
 * `Program Files`，标准用户**无写权限**，uv 下载解释器会直接失败；而且卸载/
 * 升级不该连带删掉已下载的解释器（每个版本几十 MB）。userData 既可写，
 * 又在升级后保留。
 */
export function resolveInterpretersDir(
  configured: string | undefined | null,
  userDataDir: string,
): string {
  const trimmed = (configured ?? '').trim();
  if (trimmed) return trimmed;
  return joinPath(userDataDir, 'interpreters');
}

/**
 * 组装给 executor-node 子进程的 uv 相关环境变量。
 *
 * 只设置"有值"的项：空值**不写**环境变量（让 executor-node 用自身默认），
 * 避免用空串覆盖掉用户已在系统环境里配置的值。
 */
export function buildUvChildEnv(input: {
  uvBin: string | null;
  interpretersDir: string;
  mirror?: string;
  pypiRegistryUrl?: string;
  downloadTimeoutMs?: number;
}): Record<string, string> {
  const env: Record<string, string> = {
    UV_PYTHON_INSTALL_DIR: input.interpretersDir,
    // D8 加固：宁可让 uv 明确拒绝，也不要在 venv 阶段偷偷下载解释器。
    // 这样"venv 绝不隐式下载"从约定变成 uv 自身强制的不变量。
    UV_PYTHON_DOWNLOADS: 'manual',
  };
  if (input.uvBin) env.UV_BIN = input.uvBin;
  const mirror = (input.mirror ?? '').trim();
  if (mirror) env.UV_PYTHON_INSTALL_MIRROR = mirror;
  const registry = (input.pypiRegistryUrl ?? '').trim();
  if (registry) env.PYPI_REGISTRY_URL = registry;
  if (input.downloadTimeoutMs && input.downloadTimeoutMs > 0) {
    env.INTERPRETER_DOWNLOAD_TIMEOUT_MS = String(input.downloadTimeoutMs);
  }
  return env;
}

/** 极小的路径拼接（避免在纯模块里 import path，保持零依赖）。 */
function joinPath(...parts: string[]): string {
  const sep = parts[0] && /^[A-Za-z]:[\\/]/.test(parts[0]) ? '\\' : '/';
  const cleaned = parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')));
  return cleaned.join(sep);
}

/**
 * 桌面执行器**必须**下发给 executor-node 子进程的环境变量（纯函数，可自检）。
 *
 * 为什么抽出来：`executor-process.ts` 依赖 Electron、无法在自检里加载，于是这个
 * env 块**长期没有任何回归闸**——而它恰好承载两类"漏一个键就整机不可用"的配置：
 *
 *   1. `BIND_ADDRESS` —— executor-node 默认绑 127.0.0.1（为裸机安全）。容器由
 *      compose 显式设 0.0.0.0，桌面端当时**漏了**：注册的是对外 LAN 地址，进程却
 *      只监听 loopback，admin 每次派发都 ECONNREFUSED。表现是"注册成功、托盘绿灯、
 *      永远收不到任务"，且 push 模式下没有兜底通道。
 *   2. `EXECUTOR_ALLOW_PRIVATE_NETWORK` —— ssrf-guard 默认 fail-closed，而桌面
 *      执行器要下载的 packageUrl 按构造就是私网的（admin 用 API_BASE_URL 拼）。
 *      不打开则 zip 渠道任务被**自己的**闸门拒掉，而 git/纯依赖任务正常。
 *
 * 两者都是"漏了也不报错、只是永远不工作"的形态，正是必须有闸的那类。
 */
export function buildExecutorChildEnv(input: {
  appName: string;
  port: number;
  /** 监听地址：桌面端必须是对外可被 admin 推到的地址（0.0.0.0）。 */
  bindAddress: string;
  executorHost: string;
  executorAddressPublic?: string;
  /**
   * 主进程探到的第一块非内部网卡 IPv4，用于「对外地址」留空 + 通配监听时的
   * 兜底。由调用方（executor-process）经 os.networkInterfaces() 解析后注入，
   * 保持本函数纯 Node 可自检。
   */
  fallbackLanIp?: string;
  /** 桌面设置页的日志级别，透传给 executor-node 的 winston logger。 */
  logLevel?: string;
  adminApiUrl: string;
  workDir: string;
  maxConcurrentTasks: number;
  sharedToken: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    APP_NAME: input.appName,
    PORT: String(input.port),
    // 见函数头注 1：缺这个键 = 永远收不到任务。
    BIND_ADDRESS: input.bindAddress,
    EXECUTOR_ADDRESS: `${input.executorHost}:${input.port}`,
    // 对外地址：显式配置优先；留空且监听在通配地址（桌面默认 0.0.0.0）时，
    // 用主进程探到的真实网卡兜底——**不能**把 0.0.0.0 发出去：
    // `0.0.0.0` 是**监听**地址，不是可路由的对外地址，而 admin-api 把
    // 0.0.0.0/8 归为 reserved 并**无条件拒绝**注册/派发（safe-http.util 的
    // assertSafeExecutorUrl，连私网开关也不放行）。此前留空时只返回空串，
    // executor-node 又回落到同样是 0.0.0.0 的 EXECUTOR_ADDRESS——兜底形同虚设。
    EXECUTOR_ADDRESS_PUBLIC: pickPublicAddress(
      input.executorAddressPublic,
      input.executorHost,
      input.port,
      input.fallbackLanIp,
    ),
    ADMIN_API_URL: input.adminApiUrl,
    WORK_DIR: input.workDir,
    MAX_CONCURRENT_TASKS: String(input.maxConcurrentTasks),
    // 见函数头注 2：缺这个键 = zip 渠道任务的下载被自己拒掉。
    EXECUTOR_ALLOW_PRIVATE_NETWORK: 'true',
    EXECUTOR_SHARED_TOKEN: input.sharedToken,
  };
  // 日志级别仅在显式配置时下发；空值保持 executor-node 自身的 info 默认。
  if (input.logLevel) env.LOG_LEVEL = input.logLevel;
  return env;
}

/**
 * 选出一个**可路由**的对外地址。
 *
 * 选择顺序：
 *   1. 显式配置且不是通配监听地址 → 原样下发（显式填 loopback 在 admin 开启
 *      私网开关的同机部署里是合法的，不替用户改写）；
 *   2. 监听 host 本身就是真实网卡地址 → `${host}:${port}`；
 *   3. 监听在通配地址（桌面默认 0.0.0.0）且调用方探到了局域网 IP →
 *      用该 IP 兜底；
 *   4. 一块对外网卡都没有（离线）→ 返回空串，调用方不下发该键
 *      （此时本就不存在可路由地址，注册失败比谎报一个必然被拒的地址诚实）。
 * 绝不把一个必然被 admin 判为 reserved 的通配地址当成"对外地址"发出去。
 */
export function pickPublicAddress(
  configured: string | undefined,
  host: string,
  port: number,
  fallbackLanIp?: string,
): string {
  const explicit = (configured ?? '').trim();
  if (explicit && !isWildcardHost(explicit)) return explicit;
  if (!isWildcardHost(host)) return `${host}:${port}`;
  const lan = (fallbackLanIp ?? '').trim();
  return lan ? `${lan}:${port}` : '';
}

/** `0.0.0.0:8002` / `[::]:8002` / `0.0.0.0` / `::` 都是通配监听地址，不是对外地址。 */
function isWildcardHost(address: string): boolean {
  const host = address.replace(/^\[/, '').split(/[\]:]/)[0].trim();
  return host === '0.0.0.0' || host === '::' || host === '';
}
