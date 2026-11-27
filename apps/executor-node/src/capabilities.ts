/**
 * 执行器能力声明的单一事实源（node 侧）。
 *
 * 与 executor-python/capabilities.py 键名逐字对齐。`detectAvailableRuntimes()`
 * 探测到的运行时代名词（shell/node/python）必须保留：admin-api
 * `findFleetCandidates` 按 `task.runtime` 在 capabilities 列里做精确匹配，
 * 丢掉它们会让对应 runtime 的任务永远派不到这台执行器。结构化键
 * （control 前缀 / telemetry 前缀）供控制面识别本执行器真实支持的运维面，admin
 * 的运行时过滤对它们不敏感。
 */

export const BASE_EXECUTOR_CAPABILITIES: readonly string[] = [
  'execute',
  'pull',
  'control:config-reload',
  'control:kill',
  'control:deploy',
  'control:app-stop',
  'control:app-uninstall',
  'control:update-package',
  'telemetry:deployed-apps',
  'telemetry:conflict-v8',
];

export const SANDBOX_CAPABILITY = 'sandbox:bwrap';

/** 注册期探测到的运行时代名词由 main.ts 注入（scheduler 心跳同源读取）。 */
let runtimeProvider: () => readonly string[] = () => [];

export function registerRuntimeProvider(provider: () => readonly string[]): void {
  runtimeProvider = provider;
}

/** 注册/心跳共用的能力清单（运行时代名词 + 结构化键 + 条件沙箱键）。 */
export function executorCapabilities(sandbox: string): string[] {
  const caps = [...new Set([...runtimeProvider(), ...BASE_EXECUTOR_CAPABILITIES])];
  if (sandbox === 'bwrap') caps.push(SANDBOX_CAPABILITY);
  return caps;
}
