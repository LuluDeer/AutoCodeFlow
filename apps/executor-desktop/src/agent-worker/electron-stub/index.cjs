// Electron stub for the agent-worker bundle（N-06② 打包接线）。
// playwright-core 的 Electron 启动器链（lib/server/electron/loader.js）在模块
// 顶层就访问 electron.app（appendSwitch/whenReady/emit）。worker 只走 chromium
// 路径，永不启动 _electron——stub 让该 require 成功且 electron 二进制资产
// （~223MB）不进 bundle；若未来真有代码误入 _electron 路径，会得到如实失败。
const pending = new Promise(() => {});
const app = {
  commandLine: { appendSwitch() {} },
  whenReady: () => pending,
  emit: () => true,
  listenerCount: () => 0,
  isReady: () => false,
};
module.exports = { app };
