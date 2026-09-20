import AutoLaunch from 'auto-launch';
import { app } from 'electron';
import log from './logger';

/**
 * DSK-02 (Linux): auto-launch 5.0.6 按平台分发实现（已核对 node_modules 源码
 * dist/AutoLaunchLinux.js）——Linux 走 fileBasedUtilities，把
 * ~/.config/autostart/<name>.desktop 写入/删除（enable→写、disable→删、
 * isEnabled→stat 判存在），无额外平台分支需要补。已覆盖的语义：
 *  - 目录不存在会 mkdirp，无需预创建；
 *  - Exec=app.getPath('exe')：
 *      · deb 安装 → /opt/AutoCodeFlow Executor/autocodeflow-executor（固定路径，
 *        与 electron-builder FpmTarget installPrefix=/opt + sanitizedProductName
 *        一致），升级后路径不变，自启动项持续有效；
 *      · AppImage → 指向 AppImage 文件本身，首次可用；但用户挪动/重命名文件或
 *        通过新版 AppImage 替换旧文件（同一路径则仍有效）后条目随路径失效——
 *        AppImage 用户建议固定放置路径（如 ~/Applications/）。
 *  - 生成的 .desktop 缺 Terminal/图形环境字段，标准桌面环境（GNOME/KDE/XFCE，
 *    XDG Autostart 规范）均可解析；无桌面环境的纯 WM 用户需自行确认其会话
 *    管理器实现了 XDG autostart。
 *
 * Windows/macOS 行为（既有，勿动）：win→注册表 Run 键（winreg）、mac→
 * AppleScript 登录项。enable/disable 失败已统一静默降级为 log.warn。
 *
 * DEV-AUTOLAUNCH (2026-09-20, Windows 开机自启弹 Electron 帮助页故障)：
 * 开发模式（npm run dev / electron .）下 `app.getPath('exe')` 解析为
 * node_modules/electron/dist/electron.exe（裸 electron 二进制）。
 * auto-launch 的 Windows 实现（AutoLaunchWindows.js）在**没有 Squirrel
 * update.exe** 时，会把该路径原样写进注册表 HKCU\...\Run ——键名经 fixOpts
 * （index.js:80-84）改写为 basename 去 `.exe`（即 `electron`），且**不带任何
 * app 路径参数**。于是开机时 Windows 拉起的是裸 electron.exe，它没有
 * `path-to-app`，只会弹出 "To run a local app, execute the following..."
 * 的帮助页，而不是桌面应用本体。
 *
 * 结论：**开发模式一律拒绝写入系统自启项**（历史上误写的 `electron` Run 键
 * 正是根因，见 enable 请求里的清理）；仅打包安装态（app.isPackaged）允许写入，
 * 此时 exe 是安装目录中的应用本体，自带 app 包，开机能正常启动。
 */
const autoLauncher = new AutoLaunch({
  name: 'AutoCodeFlow Executor',
  path: app.getPath('exe'),
});

export async function getAutoLaunchEnabled(): Promise<boolean> {
  // DEV-AUTOLAUNCH：开发模式的系统自启状态无意义（后台本就不能这样自启），
  // 残留的 `electron` 键不应让 UI 误报「已开启」。
  if (!app.isPackaged) return false;
  try {
    return await autoLauncher.isEnabled();
  } catch (err: any) {
    log.warn(`autolaunch.isEnabled failed: ${err.message}`);
    return false;
  }
}

export async function setAutoLaunchEnabled(enable: boolean): Promise<boolean> {
  // DEV-AUTOLAUNCH：开发模式拒绝写入（裸 electron.exe 自启只会弹帮助页），
  // 同时顺手清理桌面端历史上误写的 `electron` Run 键（fixOpts 后 appName 恰为
  // `electron`，disable 即删除目标键）；disable 请求同样落到清理兜底。
  if (!app.isPackaged) {
    try {
      await autoLauncher.disable();
      log.info('Auto-launch residue cleaned (dev mode)');
    } catch (err: any) {
      log.warn(`autolaunch.cleanup failed: ${err.message}`);
    }
    if (enable) {
      log.warn('Auto-launch refused in dev mode: bare electron.exe cannot self-start an app');
    }
    return false;
  }
  try {
    if (enable) {
      await autoLauncher.enable();
      log.info('Auto-launch enabled');
    } else {
      await autoLauncher.disable();
      log.info('Auto-launch disabled');
    }
    return true;
  } catch (err: any) {
    log.warn(`autolaunch.set(${enable}) failed: ${err.message}`);
    return false;
  }
}
