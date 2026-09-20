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
/** NETOPT-E P3-5: env 整数解析——空串/NaN 回退默认值，0 与负值保留原值
 * 交给后续钳制（`x || fallback` 会把 0 吞成默认值，env MAX_CONCURRENT_TASKS=0
 * 将落到 10 而非钳到下界 1——语义未钉）。 */
function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

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
  // NETOPT-D P3-5: env 钳 1..10000，与 MAX_RUNNING_EXECUTION_IDS / admin
  // isAdoptableMaxConcurrentTasks 采纳域同源——否则设到 50000 时 accept 放行
  // 50000 而心跳体截到 10000，容量账本与心跳申报永久脱节。
  maxConcurrentTasks: Math.min(Math.max(envInt('MAX_CONCURRENT_TASKS', 10), 1), 10_000),
  taskTimeoutSeconds: parseInt(process.env.TASK_TIMEOUT_SECONDS || '300', 10),
  // NETOPT-9-5: cap at 60s (same bound as /config/reload). A misconfigured
  // HEARTBEAT_INTERVAL_SECONDS (e.g. 300) would otherwise sit outside admin's
  // own 30s*3 stale-detection window and get the executor marked OFFLINE
  // between heartbeats — dispatch stops silently until the next beat.
  // NETOPT-C P3: 上下界都钳——热更闸门是 5..60，env 解析漏下界会让
  // HEARTBEAT_INTERVAL_SECONDS=1 变成每秒一次心跳（违背同一契约）。
  // NETOPT-F P3-2: 改用 envInt（`|| 30` 会把 env=0 吞成默认 30——语义应为
  // 钳到下界 5；与 maxConcurrentTasks 已改 envInt 的语义对齐）。
  heartbeatIntervalSeconds: Math.min(Math.max(envInt('HEARTBEAT_INTERVAL_SECONDS', 30), 5), 60),
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '7', 10),
  // ---------------------------------------------------------------------
  // P2/L-2：磁盘水位红线（对齐 executor-python config.disk_warn_percent /
  // disk_critical_percent）。TTL 清扫基于 mtime，磁盘在 TTL 窗口内被撑满时无
  // 主动应对：告警水位触发减半 TTL 的紧急清理；临界水位由 accept 阶段拒新任务。
  // getter 惰性读 env（热重载一致）；非法值钳到 [1,100]，warn 必须 < critical
  // （否则两条防线语义重叠）。
  get diskWarnPercent(): number {
    const raw = parseInt(process.env.DISK_WARN_PERCENT || '90', 10);
    if (!Number.isFinite(raw) || raw < 1) return 90;
    return Math.min(raw, 100);
  },
  get diskCriticalPercent(): number {
    const raw = parseInt(process.env.DISK_CRITICAL_PERCENT || '95', 10);
    if (!Number.isFinite(raw) || raw < 1) return 95;
    return Math.min(raw, 100);
  },
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
  // ---------------------------------------------------------------------
  // NFR-15/D12：解释器池体积红线（对齐 executor-python maintenance.
  // enforce_interpreter_pool_limits）。
  //
  // 此前池只增不删：每次任务下载一个新补丁版本就永久占 ~250MB，长跑执行器
  // 最终把磁盘填满，所有 git/uv 操作随之失败。python 侧已有完整治理（单版本
  // 250MB / 总池 4GB、按目录 mtime 升序 LRU、引用感知跳过被 venv 依赖的版本、
  // 全部候选被 pin 住只告警不删）。这里给出同默认值的可配置入口，实际回收
  // 逻辑在 interpreters.enforceInterpreterPoolLimits。
  //
  // getter 而非常量：与 workDir / uvPythonInstallDir 一样惰性读 process.env
  // （热重载一致）。非法值钳到下限，避免一个手滑的 0 让红线彻底失效。
  get interpreterSingleVersionMb(): number {
    const raw = parseInt(process.env.INTERPRETER_SINGLE_VERSION_MB || '', 10);
    if (!Number.isFinite(raw)) return 250;
    return Math.max(1, raw);
  },
  get interpreterTotalGb(): number {
    const raw = parseInt(process.env.INTERPRETER_TOTAL_GB || '', 10);
    if (!Number.isFinite(raw)) return 4;
    return Math.max(1, raw);
  },
  // 解释器下载全局有界并发（D13/NFR-16）：默认 2——不同版本并行下载、同一
  // 版本共享一次（per-version in-flight 去重）；1 = 旧版全局单队列。部署方
  // 可按网络/磁盘调 [1, 8]，越界钳制（0/负数按 1，>8 按 8）。
  get interpreterDownloadConcurrency(): number {
    const raw = parseInt(process.env.INTERPRETER_DOWNLOAD_CONCURRENCY || '', 10);
    if (!Number.isFinite(raw)) return 2;
    return Math.min(Math.max(raw, 1), 8);
  },
  // 单次解释器下载的独立时间预算（D11/NFR-13），默认 300s。与任务剩余超时
  // 取较小者由调用方（interpreters.ensureVersion）负责。越界不抛：钳到
  // [1, 86400]，避免一个手滑的 0 让每次下载立即超时。
  //
  // 两个键名都接受（**毫秒优先**）：`_MS` 是桌面端设置页下发的键
  // （executor-desktop/src/main/uv-paths.ts 的 buildUvChildEnv），`_SECONDS`
  // 是 compose / .env.example 的既有键。此前只读 `_SECONDS`，于是桌面端用户在
  // 「解释器下载超时（毫秒）」里填的值**完全不生效**——设置页承诺了、执行器不读，
  // 而且若真按秒解析 300000 会被钳到 86400 秒（24 小时）。这里让两者都生效。
  get interpreterDownloadTimeoutMs(): number {
    const rawMs = parseInt(
      process.env.INTERPRETER_DOWNLOAD_TIMEOUT_MS || '',
      10,
    );
    if (Number.isFinite(rawMs)) {
      // 毫秒键的边界与秒键同量级语义：下限 1s，上限 24h。
      return Math.min(Math.max(rawMs, 1_000), 86_400_000);
    }
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
  // ---------------------------------------------------------------------
  // 4-2/4-3（audit-r4）：任务进程资源治理——node 侧缺 python 的 RLIMIT_AS/
  // bwrap 等价物，P1「失控任务 OOM 宿主」在 node 端是真实缺口。
  // ---------------------------------------------------------------------
  // 任务进程内存上限（MB）。默认 2048 与 executor-python 的 RLIMIT_AS=2048MB
  // 同量级；0 = 不限（兼容旧部署）。度量口径差异：python 侧是虚拟地址空间
  // （RLIMIT_AS），node 侧是**常驻内存 RSS 采样**（Linux /proc 进程树求和、
  // Windows tasklist 直系子进程）——RSS 才是真正压宿主内存的指标，且不会误伤
  // V8 等预留大块虚拟地址空间的运行时。非法值钳到 [0, 1048576]（0 仅来自
  // 显式 TASK_MEMORY_LIMIT_MB=0）。
  get taskMemoryLimitMb(): number {
    const raw = parseInt(process.env.TASK_MEMORY_LIMIT_MB ?? '', 10);
    if (!Number.isFinite(raw)) return 2048;
    if (raw <= 0) return 0;
    return Math.min(raw, 1_048_576);
  },
  // 任务沙箱模式，与 executor-python sandbox.py 的 TASK_SANDBOX 对齐（F-1
  // parity）。'' = 不沙箱（默认，任务直跑）；'bwrap' = Linux 下用 bubblewrap
  // 套只读 rootfs + user ns + tmpfs 隔离，`--share-net` 保持外网可用——任务
  // 本质是自动化脚本，断网即废，网络隔离语义与 python 侧逐字一致。配置了
  // bwrap 但 bwrap 不可用 / 非 Linux 平台时任务 **fail-closed**
  // （SandboxUnavailable），绝不静默降级为直跑。
  taskSandbox: (process.env.TASK_SANDBOX || '').trim().toLowerCase(),
  // 内存看门狗采样间隔（毫秒，默认 2000）。测试/调试可调小。
  taskMemoryWatchdogIntervalMs: parseInt(
    process.env.TASK_MEMORY_WATCHDOG_INTERVAL_MS || '2000',
    10,
  ),
  // ---------------------------------------------------------------------
  // L-3：任务子进程 POSIX 硬资源上限（对齐 executor-python sandbox.py 的
  // RLIMIT_NOFILE / RLIMIT_CPU；node 无 preexec_fn，生产路径用
  // process-rlimits.applyTaskRlimits 包一层 `/bin/sh -c 'ulimit …; exec "$0" "$@"'`
  // 在 fork 后、exec 前施加）。Windows 无等价原语，跳过并记一行日志。
  //
  // 打开文件描述符软/硬上限（ulimit -n，默认 1024，与 python task_nofile_limit
  // 同值）。0 = 不设。防 fd 泄漏（chatty 任务开大量连接耗尽执行器 fd）。
  get taskNofileLimit(): number {
    const raw = parseInt(process.env.TASK_NOFILE_LIMIT || '1024', 10);
    if (!Number.isFinite(raw) || raw < 0) return 1024;
    return raw;
  },
  // CPU 秒数上限（ulimit -t，RLIMIT_CPU）。0 = 回落为「任务超时 + 60s 宽限」
  // （任务超时本身会 kill，这里是防 timeout 未生效的第二道保险）。
  get taskCpuLimitSeconds(): number {
    const raw = parseInt(process.env.TASK_CPU_LIMIT_SECONDS || '0', 10);
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return raw;
  },
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
//
// R5（python_task_multiversion）：1.0.0 → 2.0.0 —— 与 executor-python 对齐：
// node 侧同批实现 interpreters 上报、版本化 venv（--python）与 zip 整包渠道
// （interpreters.ts / pull.ts / routes/deploy.ts），属执行器能力变更，必须版本
// 可见。此前 node 停留在 1.0.0，admin 配置 EXECUTOR_MIN_VERSION=2.0.0 时
// node/desktop 全机队会被 register 门禁 403 锁死（executor.service.ts register
// gate）。desktop 内嵌 bundle 的期望哈希（executor-node-bundle.sha256）须在
// 重打 ncc bundle 后同步回填（ADR-005）。
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

/**
 * PROTOCOL-VER（B-3/U-2）：协议版本与实现版本（EXECUTOR_VERSION）**解耦**。
 *
 * - `protocolVersion` 标识执行器与中台之间的**线缆协议**（register/heartbeat/
 *   callback/pull 载荷形状与语义），随 register 载荷上报；
 * - 中台侧按此值做兼容性分支（admin-api executor.service.ts 的
 *   PROTOCOL_SUPPORTED_MIN）：旧协议执行器不发送某新字段时中台兜底，而不是
 *   硬拒——与 EXECUTOR_MIN_VERSION 门禁（实现版本，低于下限 403）是两套闸。
 * - 演进规则：新增**可选**字段且旧端可忽略时仍需 bump 此值（让中台知道该
 *   执行器不认识新字段）；任何**不向后兼容**的改动必须同时 bump
 *   `$schemaVersion`（protocol.json）与 PROTOCOL_VERSION。
 *
 * 两侧（executor-node / executor-python main._register_payload）与 admin 的
 * PROTOCOL_SUPPORTED_MIN 必须保持同值；protocol.json 的 `versioning` 段是
 * 该矩阵的单一事实源（B-3 审查项）。
 *
 * ARCH-33（ADR-016）：1 → 2。新增 pull 响应的可选 `commands` 数组与
 * `/api/executors/command-result` 结果上报端点。按 protocol.json 的
 * evolutionRules 第 1 条（「新增**可选**字段且旧端可忽略时：仍需 bump
 * protocolVersion」）——中台必须能区分「该执行器认识 commands」与「不认识」，
 * 否则会把控制命令发进一个被静默忽略的字段里。
 *
 * 中台侧门禁：PROTOCOL_CONTROL_PLANE_MIN = 2（protocol-compat.util.ts）。
 * `supportedMinProtocolVersion` 保持 1——旧执行器照常注册，只是收不到命令
 * （兼容性红线：不得因缺新字段被剔除）。
 */
export const PROTOCOL_VERSION = 2;
