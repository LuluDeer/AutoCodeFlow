import pkg from '../package.json';

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
