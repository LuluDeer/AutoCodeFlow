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
// ⚠️ **刻意不 import `config-store` 的类型**（R7 第五轮更正）。
//
// 原本这里写 `ReadonlyArray<keyof AppConfig>` + `import type { AppConfig } from './config-store'`。
// 虽然是 `import type`（运行时零依赖），但**类型层的边照样把整个 `config-store.ts`
// 拖进了引用方的 tsconfig program** —— 实测：renderer 的 `tsconfig.renderer.json`
// 因此把 `main/config-store.ts` 纳入检查面，而后者在 `moduleResolution: bundler` 下
// 报 TS2578（它的 `@ts-expect-error` 是为 CJS/node16 写的，在 bundler 下变"多余"）
// ⇒ **renderer 的类型检查被一条与它无关的 main 侧错误永久卡住**，`exclude` 也无效
// （被 import 的文件照样进 program，实测 16 条不降）。
//
// ⇒ 改为 `ReadonlyArray<string>` + **下方编译期断言**：清单仍是 `keyof AppConfig`
// 的子集（键名漂移会在**主进程侧**编译时报错，而不是在渲染层悄悄放行）。
// 这样 `config-restart.ts` 只依赖纯值（无 electron、无 config-store），
// **renderer → main 的反向类型依赖被切断**。
export const EXECUTOR_RESTART_REQUIRED_FIELDS = [
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
] as const;

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

/**
 * 编译期断言：上面的清单必须是 `keyof AppConfig` 的**子集**。
 *
 * 放在这里而不是 `config-restart.ts` 顶部，是因为本断言**必须**引用 `AppConfig`
 * ⇒ 只能放在**主进程侧**（`ipc-handlers.ts` 已合法依赖 `config-store`）。
 * 见本文件顶部注释：类型边同样会污染 renderer 的 program。
 */
