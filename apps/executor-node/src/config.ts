import path from 'path';
import pkg from '../package.json';
import { logger } from './logger';

/**
 * WS5（python_task_upload_and_multiversion）：凭据自由 URL 校验。
 *
 * 与 `apps/executor-python/config.py::_validate_credential_free_http_url`
 * 逐条对齐（CONTRACT.md §3.2 / §3.3）：这两类 URL 会被拼进 uv argv
 * （`--index-url` / `--mirror`）并写进子进程环境，因此**不得**内嵌凭据——
 * argv 会出现在进程列表与日志里，没有安全的凭据传输通道。将来若要支持带
 * 认证的私服，应另加受控的凭据机制，而不是放宽这里的规则。
 *
 * 返回 `''` 表示未配置（合法）。抛 `Error` 表示配置非法——调用方决定是
 * 启动期硬失败还是降级（node 侧选择降级 + warn，见 config 的 getter）。
 */
export function validateCredentialFreeHttpUrl(value: string, settingName: string): string {
  const url = (value ?? '').trim();
  if (!url) return '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${settingName} must be a valid http(s) URL`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error(`${settingName} must be a valid http(s) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `${settingName} must not contain userinfo; provide registry credentials through a controlled credentials mechanism`,
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${settingName} must not contain a query or fragment`);
  }
  return url;
}

/**
 * 配置项级的校验包装：非法值**不抛出**，warn 一次后按「未配置」返回 `''`。
 *
 * 为什么不学 python 侧直接启动失败：executor-node 也内嵌在 executor-desktop
 * 里，一次环境变量手滑（例如镜像地址多打了个 query）不应该让桌面客户端的
 * 执行器起不来——任务本身还有「无版本无依赖走 python3」的兼容路径可走。
 * 非法值绝不透传给 uv：降级为官方源比把畸形 URL 拼进 argv 安全。
 */
function validateOptionalUrlSetting(value: string, settingName: string): string {
  try {
    return validateCredentialFreeHttpUrl(value, settingName);
  } catch (err) {
    logger.warn(
      `${settingName} is invalid (${err instanceof Error ? err.message : String(err)}); ` +
        'falling back to the default index',
    );
    return '';
  }
}

const adminApiUrl = process.env.ADMIN_API_URL || 'http://admin-api:3105';
const adminApiUrlInternal = process.env.ADMIN_API_URL_INTERNAL || adminApiUrl;
const configuredAdminApiUrls = (process.env.ADMIN_API_URLS || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

export const config = {
  appName: process.env.APP_NAME || 'executor-node-1',
  groupName: process.env.GROUP_NAME || process.env.EXECUTOR_GROUP || '',
  port: parseInt(process.env.PORT || '8002', 10),
  // E-25（DEEP_REVIEW 0ef3bbe）：默认绑定 127.0.0.1——裸机部署不再暴露
  // 0.0.0.0。容器场景由 docker-compose 显式设 BIND_ADDRESS=0.0.0.0。
  bindAddress: process.env.BIND_ADDRESS || '127.0.0.1',
  executorAddress: process.env.EXECUTOR_ADDRESS || 'executor-node:8002',
  executorAddressPublic: process.env.EXECUTOR_ADDRESS_PUBLIC || process.env.EXECUTOR_ADDRESS || 'executor-node:8002',
  executorId: process.env.EXECUTOR_ID || '',
  adminApiUrl,
  adminApiUrlInternal,
  adminApiUrlExternal: process.env.ADMIN_API_URL_EXTERNAL || '',
  adminApiUrls: configuredAdminApiUrls.length > 0 ? configuredAdminApiUrls : [adminApiUrlInternal],
  // WORK_DIR 优先；Windows 部署误配 Work_Dir/work_dir 时也能读到（大小写
  // 不敏感回退，键名精确匹配不取）。getter 惰性读取 process.env，与 routes/
  // config.ts 热重载其它字段（直接改 process.env / config 即生效）行为一致。
  get workDir(): string {
    if (process.env.WORK_DIR) return process.env.WORK_DIR;
    const key = Object.keys(process.env).find(k => k.toLowerCase() === 'work_dir');
    return (key && process.env[key]) || '/tmp/autocodeflow/tasks';
  },
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS || '10', 10),
  taskTimeoutSeconds: parseInt(process.env.TASK_TIMEOUT_SECONDS || '300', 10),
  heartbeatIntervalSeconds: parseInt(process.env.HEARTBEAT_INTERVAL_SECONDS || '30', 10),
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '7', 10),
  npmRegistryUrl: process.env.NPM_REGISTRY_URL || '',  // Private npm registry for task dependencies
  // Auth token for the private npm registry (registry-npm/verdaccio grants
  // '**' access only to $authenticated, so anonymous task installs 401).
  // Executor-side ONLY: written into the per-task .npmrc by execute.ts and
  // deliberately NOT in the env whitelist — it must never reach task
  // children. Never logged.
  npmRegistryToken: process.env.NPM_REGISTRY_TOKEN || '',
  pythonRegistryUrl: process.env.PYTHON_REGISTRY_URL || '',  // Private PyPI registry for task dependencies
  // ---------------------------------------------------------------------
  // WS5（python_task_upload_and_multiversion）新增配置。
  // ---------------------------------------------------------------------
  // 解释器缓存池根目录（uv 的 UV_PYTHON_INSTALL_DIR）。**必须独立于
  // WORK_DIR**（CONTRACT.md §3.2 硬约束 / NFR-15）：workDir 下的任何顶层目录
  // 都会被执行器的 TTL 清扫（file-logger.cleanupWorkDir）按 mtime 删除，
  // 把解释器池放进去等于让一次清理把 250MB/版本的运行时全删掉——下次任务
  // 又要重新下载。默认取 workDir 的**兄弟目录** `interpreters`，物理隔离。
  //
  // getter 而非常量：与 workDir 一样惰性读 process.env（热重载一致），且
  // workDir 本身是 getter，派生值必须跟着它动。
  get uvPythonInstallDir(): string {
    const explicit = process.env.UV_PYTHON_INSTALL_DIR;
    if (explicit && explicit.trim()) return path.resolve(explicit.trim());
    // path.resolve 而非 join：后续 interpreters.ts 用「resolve 后仍在池根之下」
    // 做白名单断言，未规范化的 `..` 会让断言形同虚设。
    return path.resolve(config.workDir, '..', 'interpreters');
  },
  // uv 二进制路径显式覆盖（CONTRACT.md §3.3 定位顺序第 1 位）。留空则由
  // interpreters.ts 依次尝试 PATH 查找与 desktop 内置路径。
  uvBin: process.env.UV_BIN || '',
  // 解释器下载镜像（可选，D9/NFR-14）。校验规则与 PYTHON_REGISTRY_URL 一致
  // （http(s)、无凭据、无 query/fragment）。非法值不静默透传给 uv：warn 一次
  // 后按「未配置」处理（走官方源），既不启动失败也不把畸形 URL 送进 argv。
  get uvPythonInstallMirror(): string {
    return validateOptionalUrlSetting(
      process.env.UV_PYTHON_INSTALL_MIRROR ?? '',
      'UV_PYTHON_INSTALL_MIRROR',
    );
  },
  // 私有 PyPI 源（对齐 python 侧 PYPI_REGISTRY_URL）：非空时作为
  // `uv pip install --index-url` 传给 uv。同样过凭据自由校验。
  get pypiRegistryUrl(): string {
    return validateOptionalUrlSetting(
      process.env.PYPI_REGISTRY_URL || process.env.PYTHON_REGISTRY_URL || '',
      'PYPI_REGISTRY_URL',
    );
  },
  // 单次解释器下载的独立时间预算（D11/NFR-13），默认 300s。与任务剩余超时
  // 取较小者由调用方（interpreters.ensureVersion）负责。越界不抛：钳到
  // [1, 86400]，避免一个手滑的 0 让每次下载立即超时。
  get interpreterDownloadTimeoutMs(): number {
    const raw = parseInt(process.env.INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS || '300', 10);
    if (!Number.isFinite(raw)) return 300_000;
    const clamped = Math.min(Math.max(raw, 1), 86_400);
    return clamped * 1000;
  },
  // zip 整包下载体积上限（字节）。与 SSRF/下载链既有 200MB 语义对齐
  // （CONTRACT.md §3.2 zip 渠道 size cap 200MB）。
  packageDownloadMaxBytes: parseInt(process.env.PACKAGE_DOWNLOAD_MAX_BYTES || String(200 * 1024 * 1024), 10),
  token: process.env.EXECUTOR_SHARED_TOKEN || process.env.EXECUTOR_SECRET || (() => { const i = process.argv.indexOf('--token'); return i !== -1 ? process.argv[i + 1] || '' : ''; })(),
  // N23: dedicated HMAC secret for per-execution callback tokens; when unset
  // the shared token above is used as the HMAC source secret (admin-api
  // resolves the same fallback). Never forwarded to child env via the
  // whitelist — only the derived per-execution token is injected (execute.ts).
  executionCallbackSecret: process.env.EXECUTION_CALLBACK_SECRET || '',
  // N26 (round-8): the per-executor tokenHash admin-api returned at register
  // time (see main.ts registerExecutor). Mutable runtime state, not env —
  // used as the HMAC source secret when EXECUTION_CALLBACK_SECRET is unset,
  // so per-node `--secret` deployments can verify task-side callbacks.
  executorTokenHash: '',
  // ARCH-32（ADR-015）: pull 派发模式——true 时执行器不依赖入站可达（NAT 内
  // 部署），改经 POST /executors/pull 长轮询取件；register 自报 dispatchMode
  // 'pull'，admin 侧据此走队列传输分支。默认 false = push 行为逐字节不变。
  pullMode: process.env.EXECUTOR_PULL_MODE === 'true',
  // E-04（DEEP_REVIEW 0ef3bbe）：SSRF 逃生阀——默认 false（fail-closed）。
  // 设为 true 时 deploy/update-package/download 三条链允许访问 loopback/私网/
  // link-local 地址。仅在容器内联调用 admin-api 本机等合法内网场景使用。
  // 兼容 `1`：旧注释与 SSRF 报错文案都写的是 `=1`，若只认 'true' 会形成
  // 「照报错提示设置却不生效」的陷阱，故两种写法都放行。
  allowPrivateNetwork: ['true', '1'].includes(
    process.env.EXECUTOR_ALLOW_PRIVATE_NETWORK ?? '',
  ),
};

// EXE-VER-1: 执行器版本上报源（register 与心跳共用，单一定义处）。
// 升级执行器 = 重新安装 artifact / 重跑 install-cmd，版本随之跟进；
// 中心端 EXECUTOR_MIN_VERSION 门禁按此值判定（低于下限 register 403）。
//
// E-37（DEEP_REVIEW 0ef3bbe）：单一来源收敛——旧实现把 '1.0.0' 硬编码在这里，
// 与 package.json 的 "version" 各自维护，属双事实源：改一处即静默漂移，而
// 中心端 EXECUTOR_MIN_VERSION 门禁正是按这个上报值判机队合规性，漂移会让门禁
// 判错。现改为运行时从本包清单读取：
//   - tsc 交付（dist/config.js）：`../package.json` 即 apps/executor-node/package.json；
//   - ncc 单文件交付（apps/executor-desktop/scripts/bundle-executor.sh 产出
//     resources/executor-node/index.js，目录内没有 package.json 伴生文件）：
//     构建期由 ncc 把该 JSON 内联进 bundle，运行时不依赖文件系统。
// 因此两种交付形态同源，升级只需改 package.json 一处。
function readPackageVersion(): string {
  // 静态 import 在编译/ncc 打包期即把 package.json 内联进来（resolveJsonModule 已开），
  // 不运行时 fs 读盘；保留对值形态的防御性校验。
  const version = (pkg as { version?: unknown }).version;
  if (typeof version === 'string' && version) return version;
  // Deliberately lower than any real release: with EXECUTOR_MIN_VERSION set the
  // register gate rejects this loudly instead of reporting a plausible version.
  return '0.0.0';
}

export const EXECUTOR_VERSION = readPackageVersion();
