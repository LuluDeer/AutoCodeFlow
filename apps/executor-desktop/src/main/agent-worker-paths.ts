/**
 * N-06①/②：agent-worker 子进程的路径与环境解析（纯函数，可自检）。
 *
 * worker 是纯 Node 子进程（主进程以 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`
 * spawn，见 agent-worker-process.ts），零 electron import——本模块与其余路径
 * 决策一样把决策逻辑与 Electron 运行时注入分离（同 uv-paths.ts 的纪律）。
 *
 * 落点契约（与 scripts/bundle-agent-worker.cjs / electron-builder.yml extraResources
 * 三方对齐，改一处必须同步另两处）：
 *   打包态  <process.resourcesPath>/agent-worker/dist/index.js
 *   dev 态  <app.getAppPath()>/resources/agent-worker/dist/index.js
 * 浏览器目录（N-06②，ACF_BUNDLE_PLAYWRIGHT=1 时发布包非空）：
 *   打包态  <process.resourcesPath>/playwright/
 * dev 态不注入 PLAYWRIGHT_BROWSERS_PATH（沿用 playwright 默认缓存，
 * ~/.cache/ms-playwright 等），与开发期 `npx playwright install` 行为一致。
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AgentWorkerPathInput {
  isPackaged: boolean;
  /** Electron 运行时注入：process.resourcesPath（dev 态为 node_modules/electron/dist）。 */
  resourcesPath: string;
  /** Electron 运行时注入：app.getAppPath()（dev 态指向 apps/executor-desktop）。 */
  appPath: string;
}

/** agent-worker bundle 入口绝对路径。 */
export function resolveAgentWorkerEntry(input: AgentWorkerPathInput): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath, 'agent-worker', 'dist', 'index.js');
  }
  return path.join(input.appPath, 'resources', 'agent-worker', 'dist', 'index.js');
}

/**
 * 打包态随包分发的 Playwright 浏览器目录；目录不存在（ACF_BUNDLE_PLAYWRIGHT=0
 * 的本地打包 / dev 态）返回 null——调用方不注入 env，playwright 沿用默认缓存。
 * 「存在性判定」可注入以便自检，生产用 fs.existsSync。
 */
export function resolveAgentBrowsersPath(
  input: AgentWorkerPathInput,
  existsFn: (p: string) => boolean = (p) => fs.existsSync(p),
): string | null {
  if (!input.isPackaged) return null;
  const dir = path.join(input.resourcesPath, 'playwright');
  return existsFn(dir) ? dir : null;
}

/**
 * worker spawn 环境。ELECTRON_RUN_AS_NODE 恒设（process.execPath 是 Electron
 * 二进制，该开关让它以纯 Node 运行我们的 worker 脚本）；PLAYWRIGHT_BROWSERS_PATH
 * 仅在打包态且随包浏览器目录存在时注入——**必须在任何 playwright require 之前**
 * 由 worker 应用（worker 在 init 消息处理时设置，首个 tick 才可能触达 playwright）。
 */
export function buildAgentWorkerSpawnEnv(
  input: AgentWorkerPathInput,
  baseEnv: NodeJS.ProcessEnv = process.env,
  existsFn: (p: string) => boolean = (p) => fs.existsSync(p),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' };
  const browsersPath = resolveAgentBrowsersPath(input, existsFn);
  if (browsersPath !== null) env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  return env;
}
