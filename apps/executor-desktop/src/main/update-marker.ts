/**
 * B-3②：更新「已下载」态的持久化标记（纯 Node、无 electron 依赖）。
 *
 * ## 为什么需要（审计 B-3）
 *
 * autoDownload=false + autoInstallOnAppQuit=false 的显性下载流程里，用户下载
 * 完成后如果直接关窗（而不是点「重启并安装」），electron-updater 的下载状态
 * 只活在**本次进程内存**里。下次启动渲染层只能看到「发现新版本」，再点下载
 * 又要走一遍完整流程——尽管 electron-updater 6.x 的 pending 缓存（sha512 校验
 * 通过时）会复用已下载的安装包，用户却无从知道、界面上也没有任何提示。
 *
 * 本标记把「版本号 + 下载时刻」落盘到 userData；updater 在 update-available
 * 时比对版本号，命中则给渲染层带上 previouslyDownloaded 旗标——界面据此告诉
 * 用户「此前已下载完成，点击下载将校验并复用本地缓存，不会重新下载」。
 * 真正的缓存复用与 sha512 校验由 electron-updater 的
 * DownloadedUpdateHelper.validateDownloadedPath 完成（缓存失效时回落正常
 * 下载，绝不安装校验不过的文件）。
 *
 * 读写全部 best-effort（绝不抛）：标记只是体验优化，磁盘失败不影响更新主链。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface DownloadedUpdateMarker {
  /** 已下载完成的更新版本号。 */
  version: string;
  /** 下载完成时刻（ms epoch）。 */
  at: number;
}

/** 标记文件名（落在 userData 根，与 config.json 同级）。 */
export const UPDATE_MARKER_FILE = 'update-downloaded.json';

export function updateMarkerPath(dir: string): string {
  return path.join(dir, UPDATE_MARKER_FILE);
}

/** 写标记；失败返回 false（调用方按需落日志），绝不抛。 */
export function writeDownloadedUpdateMarker(
  dir: string,
  version: string,
  at: number,
): boolean {
  try {
    const marker: DownloadedUpdateMarker = { version, at };
    fs.writeFileSync(updateMarkerPath(dir), JSON.stringify(marker, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** 读标记；缺失/损坏/形状不符一律返回 null（陈旧或损坏的标记等价于没有）。 */
export function readDownloadedUpdateMarker(dir: string): DownloadedUpdateMarker | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(updateMarkerPath(dir), 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { version, at } = parsed as Record<string, unknown>;
    if (typeof version !== 'string' || version === '') return null;
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    return { version, at };
  } catch {
    return null;
  }
}

/** 远端将要下载的版本是否与本标记记录的已下载版本一致。 */
export function isSameDownloadedVersion(
  marker: DownloadedUpdateMarker | null,
  version: string,
): boolean {
  return marker !== null && version !== '' && marker.version === version;
}
