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
