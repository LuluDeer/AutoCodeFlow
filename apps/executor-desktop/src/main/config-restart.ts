/**
 * 「保存配置后是否必须重启执行器」的**唯一字段清单**。
 *
 * 主进程（ipc-handlers.finalizeConfigSave）与渲染层（ConfigPage.requestSave）
 * 必须用同一份清单：
 *  · 主进程据此决定是否真的 stop+start 子进程；
 *  · 渲染层据此决定要不要弹「重启会中断任务」的确认。
 * 如果两处各维护一份，用户就会遇到两类错觉——改语言也被告知"会重启"，
 * 或者改了端口却没被提醒。故清单与纯比较函数收敛到本模块（无 electron
 * 依赖，渲染层可直接 import）。
 *
 * 注意：本模块只做**值比较**。主进程另有 token 解密后比较的包装（safeStorage
 * 每次加密产生不同密文，直接比值会把"重输同一个 token"误判为变化），见
 * ipc-handlers.restartRequiredFieldsChanged。
 */
import type { AppConfig } from './config-store';

export const EXECUTOR_RESTART_REQUIRED_FIELDS: ReadonlyArray<keyof AppConfig> = [
  'adminApiUrl',
  'executorName',
  'executorHost',
  'executorPort',
  'executorAddressPublic',
  'executorToken',
  'workDir',
  'maxConcurrentTasks',
  // python_task_multiversion：uv / 解释器池 / 私有源（buildUvChildEnv 下发）。
  'uvPath',
  'uvPythonInstallDir',
  'uvPythonInstallMirror',
  'interpreterDownloadTimeoutMs',
  'pypiRegistryUrl',
  // ARCH-33：pull 回连模式（EXECUTOR_PULL_MODE 只在 true 时下发）。
  'pullMode',
];

/**
 * 两份配置之间是否有"必须重启执行器才生效"的字段发生变化。
 *
 * 渲染层的 before/after 都是 config:get 的掩码视图（token 未改动时两边都是
 * '******'），所以这里直接比值即可；主进程走 token 解密后的专用版本。
 */
export function restartRequiredFieldsDiffer(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  return EXECUTOR_RESTART_REQUIRED_FIELDS.some((key) => before[key] !== after[key]);
}
