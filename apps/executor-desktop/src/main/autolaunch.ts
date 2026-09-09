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
 */
const autoLauncher = new AutoLaunch({
  name: 'AutoCodeFlow Executor',
  path: app.getPath('exe'),
});

export async function getAutoLaunchEnabled(): Promise<boolean> {
  try {
    return await autoLauncher.isEnabled();
  } catch (err: any) {
    log.warn(`autolaunch.isEnabled failed: ${err.message}`);
    return false;
  }
}

export async function setAutoLaunchEnabled(enable: boolean): Promise<void> {
  try {
    if (enable) {
      await autoLauncher.enable();
      log.info('Auto-launch enabled');
    } else {
      await autoLauncher.disable();
      log.info('Auto-launch disabled');
    }
  } catch (err: any) {
    log.warn(`autolaunch.set(${enable}) failed: ${err.message}`);
  }
}
