/**
 * SEC-02 续（生产故障）：任务级 secrets 的**按原名注入**规则。
 *
 * ## 为什么需要这个模块
 *
 * 此前 secrets 与 params 走**同一条通道**：两者合并后逐项加 `AUTOFLOW_` 前缀。
 * 于是平台文档/报错里说的「配置 `FEISHU_APP_ID`」，实际注入的名字是
 * `AUTOFLOW_FEISHU_APP_ID` —— 任务脚本按提示写 `os.environ["FEISHU_APP_ID"]`
 * 永远取不到值（生产实证：用户脚本读裸名，报「缺少飞书凭证」）。更麻烦的是
 * **第三方 SDK**：boto3 认 `AWS_ACCESS_KEY_ID`、openai 认 `OPENAI_API_KEY`，
 * 这些名字由 SDK 决定，脚本无法改写成 `AUTOFLOW_` 形态——凭据等于不可用。
 *
 * 现在 secrets 额外按**原名**注入（params 仍保持 `AUTOFLOW_` 前缀不变，存量
 * 任务零回归；两种形态并存，读旧名的脚本照常工作）。
 *
 * ## 为什么必须有名字闸门
 *
 * 「按原名注入」意味着用户提供的键名会**直接成为子进程的环境变量名**，这与
 * 加前缀的形态有本质区别：前缀形态下用户无法触及任何平台变量，而原名形态下
 * 一个名为 `PATH` / `NODE_PATH` / `PYTHONIOENCODING` 的 secret 会覆盖执行器
 * 赖以工作的环境。这不是理论风险——`PATH` 被覆盖后子进程连 `python.exe` 都
 * 找不到，任务以"命令不存在"这种与凭据毫无关系的形态失败，极难定位。
 *
 * 因此：**白名单式校验**（只允许 `[A-Za-z_][A-Za-z0-9_]*`）+ **保留名拒绝**
 * （平台自用与白名单透传的变量名一律不许占用）。校验在 admin-api 的 DTO 侧
 * 也做一遍（给用户可读的 400），这里是执行器侧的兜底——执行器不能假设上游
 * 一定校验过（pull 载荷、直连 /api/execute 都是入口）。
 */

import { ENV_WHITELIST } from './env-whitelist';

/**
 * 合法环境变量名：字母或下划线开头，其余为字母/数字/下划线。
 *
 * 刻意不接受 `=`、空串、含空格/点/短横线的名字——它们要么让子进程 env 构造
 * 失败（Node 的 spawn 对含 `=` 的键直接抛错），要么在某些 shell 里被当成别的
 * 语义。非法名**静默跳过**而非抛错：一个手滑的键名不该让整个任务跑不起来，
 * 而凭据缺失会在脚本里以明确的业务报错暴露（比"任务起不来"好定位）。
 */
const SAFE_SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 保留名：**不得**由 secret 占用。
 *
 * 三个来源：
 *   1. 执行器自己注入的任务作用域变量（EXECUTION_ID / TASK_ID / TASK_NAME /
 *      AUTOFLOW_*）——被覆盖会让回调、产物收集、追踪静默失效；
 *   2. 环境白名单透传的宿主变量（PATH/HOME/TMPDIR…，见 env-whitelist.ts）——
 *      被覆盖会让子进程连解释器都找不到；
 *   3. 执行器密钥（EXECUTOR_SHARED_TOKEN / EXECUTOR_SECRET /
 *      EXECUTION_CALLBACK_SECRET）——本就不该进子进程，更不该由用户"设置"。
 *
 * ⚠️ 全部按**大写**归一：判定时用的是 `name.toUpperCase()`（Windows 环境变量名
 * 大小写不敏感，而用户可能写 `Path`/`path`），但 `ENV_WHITELIST` 里有
 * `npm_config_cache` 这类**小写**条目——直接展开会让 `NPM_CONFIG_CACHE` 绕过
 * 闸门（测试 `环境白名单里的宿主变量一律拒绝` 实测抓出）。故此处显式大写化。
 *
 * 另有两条**前缀**规则（无法用集合表达）：`AUTOFLOW_` 与 `PYTHON`。
 * 前者是 params 的命名空间（secret 占用会与 params 互相覆盖，语义不明），
 * 后者是解释器自身的行为开关（PYTHONIOENCODING / PYTHONUTF8 / PYTHONPATH /
 * PYTHONSTARTUP…，执行器为保证日志编码正确**必须**独占，见 execute.ts 的
 * I18N-01 段）。
 */
const RESERVED_SECRET_NAMES = new Set<string>(
  [
    // 1. 执行器注入的任务作用域变量
    'EXECUTION_ID',
    'TASK_ID',
    'TASK_NAME',
    'NODE_PATH',
    // 2. 环境白名单透传的宿主变量
    ...ENV_WHITELIST,
    // 3. 执行器密钥
    'EXECUTOR_SHARED_TOKEN',
    'EXECUTOR_SECRET',
    'EXECUTION_CALLBACK_SECRET',
  ].map((n) => n.toUpperCase()),
);

/** 该 secret 名是否可用于「按原名注入」。 */
export function isInjectableSecretName(name: string): boolean {
  if (!SAFE_SECRET_NAME_RE.test(name)) return false;
  const upper = name.toUpperCase();
  if (RESERVED_SECRET_NAMES.has(upper)) return false;
  if (upper.startsWith('AUTOFLOW_')) return false;
  if (upper.startsWith('PYTHON')) return false;
  return true;
}

/**
 * 把 secrets 按原名写进子进程 env。
 *
 * 与 params 的注入**刻意分离**：params 走 `AUTOFLOW_<KEY>`（`execute.ts` 里的
 * 既有循环，不动），secrets 走原名。返回值是**被跳过的键名**，供调用方记一条
 * warn —— 静默丢弃凭据是最难排查的失败形态（脚本报"缺少凭据"，用户去平台看
 * 配置明明存在），所以这里必须留下痕迹。
 */
export function injectSecretEnv(
  env: NodeJS.ProcessEnv,
  secrets: Record<string, unknown> | null | undefined,
): string[] {
  if (!secrets || typeof secrets !== 'object') return [];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(secrets)) {
    if (!isInjectableSecretName(k)) {
      skipped.push(k);
      continue;
    }
    // null/undefined 值跳过而非写成 "null"：secrets 的叶子按契约是字符串，
    // 但 `{"KEY": null}` 是"这个键没有值"的合理表达，写成字面量 "null" 会让
    // 脚本拿到一个看起来合法、实则错误的凭据（比缺失更难查）。
    if (v === null || v === undefined) continue;
    env[k] = String(v);
  }
  return skipped;
}
