import { app, BrowserWindow } from 'electron';
// F-37（UIUX 审计）：下载取消——electron-updater 6.x 原生支持在途下载中断：
// `downloadUpdate(cancellationToken)` + `CancellationToken.cancel()`（安装包
// 下载被 abort，downloadUpdate 的 Promise 以取消错误 reject）。调研结论：
// 原生取消可行，无需降级到「关闭弹窗 + 不自动安装」方案。
import { autoUpdater, CancellationToken } from 'electron-updater';
import log from './logger';
import { createRunCheck, createPeriodicCheck } from './updater-runcheck';
// B-3②：已下载版本的持久化标记（纯 Node 模块，见该文件头注）。
import {
  isSameDownloadedVersion,
  readDownloadedUpdateMarker,
  writeDownloadedUpdateMarker,
} from './update-marker';

/**
 * DSK-03: 桌面自动更新（双源）。
 *
 * 源选择（优先级从高到低）：
 *  1) env AUTOUPDATE_URL —— 通用 HTTP 源（generic provider）。走
 *     executor-packages 通道/私有化部署的自定义更新服务器，目录布局与
 *     electron-builder 产物一致（latest-linux.yml + *.AppImage / *.deb）。
 *  2) electron-builder.yml 的 publish 段（provider: github，
 *     LuluDeer/AutoCodeFlow）—— 默认源，读取 GitHub Releases 上的
 *     latest-linux.yml 与对应安装包（打包时 electron-builder 会把
 *     app-update.yml 写进 resources/，electron-updater 自动加载）。
 *
 * 行为约束：
 *  - 仅生产环境启用（app.isPackaged 守卫在 initUpdater 调用方）；
 *  - 启动后延迟 30s 再检查，避开启动窗口的网络/IO 高峰；
 *  - autoDownload=false：检测到新版本只通知渲染层，用户确认后才下载安装；
 *  - 离线/私服无网/4xx/5xx 一律静默（log.warn 落盘），绝不打扰用户；
 *  - 版本回退（远端 <= 本地）不通知，isAvailable 保持 false。
 */

/** 启动后延迟检查的毫秒数。 */
export const UPDATE_CHECK_DELAY_MS = 30_000;

/** 审计二轮 B-7①：自动检查周期（6 小时）。旧实现只在启动 30s 后检查一次，
 *  之后永不自检——长时间驻留的桌面端会一直停在旧版本，直到用户手动点检查。 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** updater IPC 事件通道名（preload 侧同名暴露）。 */
export const UPDATE_EVENTS = {
  available: 'updater:available',
  /** 下载进度（0-100）——独立通道，避免与 available 的 version 字段互相污染 */
  progress: 'updater:progress',
  downloaded: 'updater:downloaded',
  error: 'updater:error',
} as const;

/**
 * 纯函数：semver 比较语义的「a 是否严格新于 b」。
 *  - 支持数值段与预发布段（-alpha.1 < 正式版；alpha.2 > alpha.1）；
 *  - 相等返回 false；回退（a 更旧）返回 false；
 *  - 解析失败的输入视为「不新于」，绝不触发升级弹窗。
 * 放在 selftest 里逐条断言（dist-selftest/updater.selftest.js）。
 */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  if (pa.cmp(pb) !== 0) return pa.cmp(pb) > 0;
  return false;
}

/** 预发布标识排序权重：数字段按数值比，字符串段按字典序比（semver 规则）。 */
function comparePrerelease(l: string[], r: string[]): number {
  if (l.length === 0 && r.length === 0) return 0;
  // 无预发布段 > 有预发布段（1.0.0 > 1.0.0-alpha）
  if (l.length === 0) return 1;
  if (r.length === 0) return -1;
  const len = Math.max(l.length, r.length);
  for (let i = 0; i < len; i++) {
    const li = l[i];
    const ri = r[i];
    if (li === undefined) return -1; // 更短的一方更小
    if (ri === undefined) return 1;
    const ln = /^\d+$/.test(li);
    const rn = /^\d+$/.test(ri);
    if (ln && rn) {
      const d = Number(li) - Number(ri);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (ln !== rn) {
      return ln ? -1 : 1; // 数字段 < 字符串段（semver 规则）
    } else {
      if (li !== ri) return li < ri ? -1 : 1;
    }
  }
  return 0;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
  cmp(other: ParsedVersion): number;
}

function parseVersion(v: string): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const pre = m[4] ? m[4].split('.') : [];
  return {
    major,
    minor,
    patch,
    pre,
    cmp(o: ParsedVersion): number {
      if (major !== o.major) return major > o.major ? 1 : -1;
      if (minor !== o.minor) return minor > o.minor ? 1 : -1;
      if (patch !== o.patch) return patch > o.patch ? 1 : -1;
      return comparePrerelease(pre, o.pre);
    },
  };
}

/** 解析 AUTOUPDATE_URL；空/非法/非 https 返回 null（回落 GitHub 源）。 */
function resolveGenericFeedUrl(): string | null {
  const raw = process.env.AUTOUPDATE_URL;
  if (!raw || raw.trim() === '') return null;
  try {
    const u = new URL(raw.trim());
    // D2-P2-4: generic feed 只允许 https:。Linux 无签名兜底，http: 源可被中间人
    // 替换安装包；一律拒绝（回落默认源），不静默放行。
    if (u.protocol === 'http:') {
      log.warn(
        `updater: refusing insecure http: generic feed (${u.toString()}); require https: and falling back to default source`,
      );
      return null;
    }
    if (u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * PLAN-EXECUTOR-DESKTOP-UX 4.2：`updater:available` 载荷里 releaseNotes 的
 * **展示上限**（字符数）。
 *
 * 为什么必须封顶：releaseNotes 来自 GitHub Releases（或私有化 feed 的
 * latest-*.yml），内容完全由发布者决定。一个把整个 CHANGELOG 贴进 release
 * 的版本会产出几十万字符，经 IPC 序列化一次到渲染层，再被塞进横幅——主进程
 * 序列化卡顿 + 渲染层布局被撑爆，用户看到的是一条滚不动的巨墙。
 *
 * 4000 字符 ≈ 60 行中文正文：足够展示一个版本的要点，又不至于压垮横幅。
 */
export const RELEASE_NOTES_MAX_CHARS = 4_000;

/**
 * 纯函数：把 electron-updater 的 `updateInfo.releaseNotes` 归一化成**单段
 * 纯文本**（渲染层只做文本渲染，绝不走 HTML/Markdown）。
 *
 * 三种输入形态（见 builder-util-runtime 的 UpdateInfo）：
 *  · `string`            —— 常见（`updater.fullChangelog` 关闭）；
 *  · `Array<{version,note}>` —— `fullChangelog=true` 时的跨版本变更列表；
 *  · `null` / `undefined` / 其它脏值 —— 返回 ''（无更新日志，不是错误）。
 *
 * 归一化纪律：
 *  1. 数组按**版本从新到旧**拼接（electron-updater 给的顺序），每段前置
 *     `v<version>` 小标题；`note` 为 null 的版本跳过（有版本号没内容没意义）。
 *  2. 只做文本层面的规整（去 HTML 标签、压空行），**不做** Markdown → HTML
 *     转换——渲染层只用 {text}，任何标签进来都只会原样显示，没有 XSS 面。
 *  3. 超长截断到 RELEASE_NOTES_MAX_CHARS，末尾留省略标记（用户要知道"还有
 *     更多"而不是以为日志就这么短）。
 *  4. 绝不抛错——release notes 是锦上添花，任何异常都只能降级为空串，不得
 *     让 update-available 分支整体失败（那会让更新提示彻底消失）。
 *
 * 放在 selftest 里逐条断言（dist-selftest/updater.selftest.js）。
 */
export function normalizeReleaseNotes(raw: unknown): string {
  try {
    const blocks: string[] = [];
    if (typeof raw === 'string') {
      blocks.push(raw);
    } else if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue;
        const entry = item as { version?: unknown; note?: unknown };
        const note = typeof entry.note === 'string' ? entry.note : '';
        if (note.trim() === '') continue;
        const version = typeof entry.version === 'string' ? entry.version.trim() : '';
        blocks.push(version ? `v${version}\n${note}` : note);
      }
    } else {
      return '';
    }

    const cleaned = blocks
      .map((block) => sanitizeReleaseNoteText(block))
      .filter((block) => block !== '');
    if (cleaned.length === 0) return '';

    const joined = cleaned.join('\n\n');
    if (joined.length <= RELEASE_NOTES_MAX_CHARS) return joined;
    // 截断标记占 1 字符（与 clip 同口径），保证结果长度 <= 上限。
    return `${joined.slice(0, RELEASE_NOTES_MAX_CHARS - 1)}…`;
  } catch {
    // 见上方纪律 4：任何异常都降级为空串。
    return '';
  }
}

/**
 * release note 正文的文本规整（normalizeReleaseNotes 的内部实现）：
 *  · HTML 标签整段删除——GitHub release body 是 Markdown，但私有化 feed 里
 *    出现过手写 HTML；渲染层不做 HTML 解析，留着标签只是噪音。
 *  · `<br>` / `</p>` / `</li>` 先换成换行，否则删标签会把相邻段落黏成一行。
 *  · 逐行去首尾空白、连续空行压成一个、整体去首尾空白。
 *  · 制表符换成两个空格（横幅是等宽排版，制表符会被浏览器渲染成巨大缩进）。
 */
function sanitizeReleaseNoteText(text: string): string {
  return text
    // <script>/<style> 整块（含内容）删除——只删标签会把 `alert(1)` 或整段 CSS
    // 当成正文留在横幅里。这里不做 HTML 解析，但这两个标签的内容永远不是
    // 人类可读的更新说明，整块丢弃比留下更接近"纯文本"的目标。
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // 块级/换行标签 → 换行（在删标签之前处理，否则段落边界丢失）
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|div|h[1-6]|tr)>/gi, '\n')
    // 其余标签整段删除（含属性里的引号内容）
    .replace(/<[^>]*>/g, '')
    // HTML 实体：只处理最常见的四个，其余保持原样（不赌完整实体表）
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // 控制字符（含 \r、\t 之外）一律清掉，防止不可见字符撑乱布局
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// NETOPT-C P3: updater:error 的显性化开关——用户主动检查 / 用户确认的下载
// 才广播；后台定时检查保持静默（离线/私服 404 不打扰用户）。
// NETOPT-D P3-1 / NETOPT-E P3-1 / NETOPT-E P2-4: runCheck 互斥 + 归因局部化
// 状态机（后台在飞→用户串行等待、用户在飞→后台跳过、error 只认最近发起方）
// 已抽到 updater-runcheck.ts（无 electron 依赖，selftest 直接驱动真实实现）。
// 这里只保留 downloading（下载显性流程标记，不属于检查状态机）。
// NETOPT-E P2-4: electron-updater 的 checkForUpdates 返回 Promise<UpdateCheckResult | null>，
// 状态机只认 Promise<void>——包一层丢弃返回值（检查周期语义只关心完成/失败）。
const runCheckState = createRunCheck(() =>
  autoUpdater.checkForUpdates().then(() => undefined),
);
let downloading = false;
/**
 * A-1：本轮进程内 update-downloaded 已到达的版本号；null = 没有可安装的更新。
 * 这是 quitAndInstall 的**唯一**判据（见 canInstall 头注）——不能拿
 * autoUpdater.isUpdaterActive() 顶替：electron-updater 6 的该函数只判
 * app.isPackaged（node_modules/electron-updater/out/AppUpdater.js:277-283），
 * AppImage 形态下恒为 true，闸门形同不存在。
 */
let downloadedUpdateVersion: string | null = null;
/**
 * A-2：install 请求在飞标志。quitAndInstall 的失败是**异步** error 事件
 * （安装器起不来 / 安装包被占用 / 目标目录不可写），此时 downloading 早在
 * update-downloaded 就复位成 false；不记这个标志，install 失败会被当成后台
 * 噪音静默丢弃——用户视角就是「点了『重启并安装』什么都没发生」。
 * 成功安装时进程直接退出，无需复位；失败时由 error 处理器一次性消费。
 */
let installRequested = false;

// V4 审计 P2：update-available 的系统通知出口。broadcast 只覆盖**已打开**的
// 窗口——托盘应用常态是状态窗关着，用户永远看不到「有新版本」。回调由
// index.ts 注入 notifier.notifyUpdate（与 tray.ts 的回调注入同形态，避免
// updater → notifier 的模块依赖；未注入时行为与旧版逐字节一致，只广播）。
let updateAvailableNotifier: ((version: string, previouslyDownloaded: boolean) => void) | null = null;
/** 同版本去重：6h 周期检查会对同一远端版本反复触发 update-available，
 *  系统通知不该每 6h 重复轰炸（渲染层横幅仍每次广播、状态自恢复）。 */
let lastNotifiedUpdateVersion: string | null = null;
// F-37：最近一次 update-available 的完整广播载荷。取消下载后重发它，让
// 渲染层横幅从 downloading 原路回到 available（版本号/releaseNotes 不丢），
// 不必新增事件通道（e2e 的 preload 通道白名单钉子也不动）。
let lastAvailableBroadcast: Record<string, unknown> | null = null;
// F-37：在途下载的取消令牌与「用户已请求取消」标志。标志用于把取消引发的
// error 事件（CancellationError）从「下载失败」中区分出来。
let downloadToken: CancellationToken | null = null;
let cancelRequested = false;

/** index.ts 接线：注入「更新可用 → 系统通知」回调（notifier.notifyUpdate）。 */
export function setUpdateAvailableNotifier(
  cb: ((version: string, previouslyDownloaded: boolean) => void) | null,
): void {
  updateAvailableNotifier = cb;
}

// 审计二轮 B-7①：周期调度器——首轮延迟 UPDATE_CHECK_DELAY_MS，之后每轮检查
// 完成后重挂 UPDATE_CHECK_INTERVAL_MS（调度状态机见 updater-runcheck.ts）。
// 与手动检查的并发仍由 runCheckState 串行化：用户检查在飞时，周期 tick 复用
// 其 in-flight promise，不叠加新 timer、不覆盖 error 归因。
// unref：定时器不阻止进程退出（保持旧 checkTimer.unref() 的语义）。
const periodicCheck = createPeriodicCheck({
  run: () => runCheck(false),
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  cancel: (h) => clearTimeout(h as NodeJS.Timeout),
});

/** 周期调度已启动标志（initUpdater 幂等句柄）。 */
let periodicStarted = false;

/**
 * 初始化并启动延迟检查。仅生产环境调用（index.ts 里 app.isPackaged 守卫）。
 * 幂等：重复调用只启动一次周期调度。
 */
export function initUpdater(): void {
  if (periodicStarted) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // electron-updater 的 logger 接口与 electron-log 方法名兼容（info/warn/error…）
  autoUpdater.logger = log;

  const genericUrl = resolveGenericFeedUrl();
  if (genericUrl) {
    // 双源之 B：通用 HTTP 源（env 覆盖），供私有化/executor-packages 通道
    autoUpdater.setFeedURL({ provider: 'generic', url: genericUrl });
    log.info(`updater: generic feed ${genericUrl}`);
  }
  // 无 env 时保持打包生成的 app-update.yml（github provider），无需显式 setFeedURL

  autoUpdater.on('update-available', (info) => {
    const remote = String(info.version ?? '');
    const local = app.getVersion();
    // 兜底比较：generic 源的 latest-linux.yml 若被手写错（<= 本地版本），
    // electron-updater 某些 provider 组合不会自行拦截，这里统一再挡一道。
    if (!isNewerVersion(remote, local)) {
      log.info(`updater: remote ${remote} not newer than local ${local}, ignored`);
      // NETOPT-D P3-3: 检查周期结束（无论结果）复位 surface 标志——
      // 防残留：用户主动检查成功后，后续任意 error（如下载阶段的意外事件）
      // 仍被按用户检查归因而广播。
      runCheckState.resetSurface();
      return;
    }
    // B-3②：与持久化的「已下载」标记比对——同一版本此前下载过（用户上次
    // 下载后直接关窗未装），告诉渲染层走"复用缓存"的展示形态。真正的缓存
    // 复用与 sha512 校验由 electron-updater 的 DownloadedUpdateHelper 完成：
    // 用户点下载时若缓存有效则**不会**重新下载（秒级哈希校验后直接进入
    // update-downloaded），缓存失效时自动回落正常下载。
    const previouslyDownloaded = isSameDownloadedVersion(
      readDownloadedUpdateMarker(updateMarkerDir()),
      remote,
    );
    log.info(
      `updater: update available ${local} -> ${remote}` +
        (previouslyDownloaded ? ' (previously downloaded, pending cache should be reused)' : ''),
    );
    runCheckState.resetSurface();
    // PLAN-EXECUTOR-DESKTOP-UX 4.2：把 releaseNotes 一并带出去（归一化 +
    // 封顶见 normalizeReleaseNotes 头注）。**已经过文本规整的纯字符串**——
    // 渲染层只做 {text} 渲染，绝不 dangerouslySetInnerHTML（release notes 来自
    // GitHub Releases，是外部不可信内容，注入 HTML 就是 XSS 面）。
    // 空串（无日志/全被过滤）照常带上：字段恒存在让渲染层不必猜"是没日志还是
    // 旧版主进程"，展示侧按空串隐藏即可。
    const releaseNotes = normalizeReleaseNotes((info as { releaseNotes?: unknown }).releaseNotes);
    lastAvailableBroadcast = {
      version: remote,
      current: local,
      previouslyDownloaded,
      releaseNotes,
    };
    broadcast(UPDATE_EVENTS.available, lastAvailableBroadcast);
    // V4 审计 P2：广播之外补一条系统通知（状态窗关闭时横幅无人看见）。
    // 同版本只通知一次（6h 周期检查会重复触发 update-available）；新版本号
    // 到达即再通知。remote 已过 isNewerVersion（semver 字符集），进通知安全。
    if (updateAvailableNotifier && remote !== lastNotifiedUpdateVersion) {
      lastNotifiedUpdateVersion = remote;
      updateAvailableNotifier(remote, previouslyDownloaded);
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info(`updater: up to date (${String(info.version ?? 'unknown')})`);
    runCheckState.resetSurface();
  });

  autoUpdater.on('download-progress', (p) => {
    // DSK-05：进度走独立通道。旧形态复用 available 通道并传 version:''，
    // 会把渲染层已记下的「待升级版本号」覆盖成空字符串，提示文案随即丢版本号。
    broadcast(UPDATE_EVENTS.progress, {
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = String(info.version ?? '');
    log.info(`updater: update downloaded (${version})`);
    // A-1：记下「真的下载完成」的版本——install 判据的唯一来源（canInstall）。
    // 只有事件到达才置位：重启后持久化标记（B-3② 的 marker）只表示"上次下载
    // 过、缓存可复用"，本进程并未持有 downloadedUpdateHelper 的安装包，
    // 拿它当可安装判据会退回"点了没反应"的老毛病。
    downloadedUpdateVersion = version;
    // B-3②：持久化「已下载」标记（版本号 + 时刻）。下次启动若同一版本仍在
    // 待装，update-available 会带上 previouslyDownloaded 旗标，渲染层据此
    // 告知用户"复用本地缓存，不再重复下载百 MB 安装包"。写失败只落日志，
    // 绝不影响更新主链。
    if (!writeDownloadedUpdateMarker(updateMarkerDir(), version, Date.now())) {
      log.warn('updater: failed to persist the downloaded-update marker (non-fatal)');
    }
    broadcast(UPDATE_EVENTS.downloaded, { version });
  });

  autoUpdater.on('error', (err) => {
    // F-37：用户取消下载（cancelDownload）也会以 error 事件到达（CancellationError）
    // ——这是用户主动选择的路径，不是失败：不发 error（渲染层不进错误态），
    // 改为重发最近一次 update-available 广播让横幅回到 available 态。
    if (cancelRequested) {
      cancelRequested = false;
      log.info('updater: download cancelled by user');
      if (lastAvailableBroadcast) {
        broadcast(UPDATE_EVENTS.available, lastAvailableBroadcast);
      }
      return;
    }
    // NETOPT-C P3: 后台定时检查（启动 30s）离线/私服 404 是常态噪音，只落
    // 日志不打扰用户；仅用户主动检查（updater:check）或正在下载（DSK-03
    // 用户确认后的显性流程）时才广播 error 让渲染层显性化。
    // NETOPT-D P3-1: 标志在 runCheck 发起时覆盖（latest 语义），error 事件与
    // 检查调用异步到达，按"最近一次发起"归因。
    // NETOPT-D P3-3: 归因完成后立即复位——error 是检查周期的终结事件之一，
    // 复位不会吞掉本次 surface 判断（surface 已取局部值），只防残留污染
    // 后续后台检查的错误归类。
    log.warn(`updater: check/download error: ${err.message}`);
    // A-2：install 期的 error 也要能 surface。旧判据只看
    // surfaceError || downloading，而 install 发生在 update-downloaded 之后
    // （downloading 已复位为 false），安装器失败因此被归成后台噪音直接丢弃。
    const surface = surfaceUpdaterError(runCheckState.surfaceError, downloading, installRequested);
    runCheckState.resetSurface();
    // install 请求是一次性的：error 已到达（安装没起来），后续 error 不得再
    // 按 install 归因——否则用户下一次后台检查的离线/404 噪音会被当成
    // 「安装失败」弹给用户。
    installRequested = false;
    if (surface) {
      broadcast(UPDATE_EVENTS.error, { message: err.message });
    }
  });

  // 首轮：启动 30s 后；之后每轮检查完成再重挂 6h 周期（createPeriodicCheck）。
  periodicStarted = true;
  periodicCheck.start(UPDATE_CHECK_DELAY_MS, UPDATE_CHECK_INTERVAL_MS);
}

/** 后台/静默检查：错误只落日志（NETOPT-C P3）。 */
export async function checkForUpdates(): Promise<void> {
  await runCheck(false);
}

/** 用户主动检查（ipc updater:check）：错误经 updater:error 广播显性化。 */
export async function checkForUpdatesUserInitiated(): Promise<void> {
  await runCheck(true);
}

/**
 * 检查入口（互斥 + 归因局部化，NETOPT-E P3-1 / P2-4）。
 * 状态机本体在 updater-runcheck.ts（createRunCheck），此处只委托：
 *  - 后台发起（initUpdater 定时 tick / 静默入口）：in-flight 已有检查（无论
 *    谁发起）→ 复用同一 promise（跳过），不排队、不覆盖归因——后台检查是
 *    软性的，用户检查进行中不必再排一队，且避免 latest 覆盖把后台噪音 error
 *    张冠李戴给用户。注意：并发调用**复用 in-flight promise**，并非 reject
 *    （electron-updater 只拒绝并发 checkForUpdates 本身）。
 *  - 用户发起（ipc updater:check）：若后台检查在飞，先等它结束（失败不阻
 *    断）再**串行发起自己的检查**；surfaceError 只在本次检查周期内置位、
 *    结束即复位——error 事件只认真正在跑的这次检查的发起方。
 * 这取代了 NETOPT-D P3-1 的"latest 语义"：那版并发时后台先起、用户后点，
 * 用户复用后台 in-flight 检查并把 latest 覆盖为 true，后台噪音 error 被
 * 广播给用户、而用户自己的错误（若有）被静默。
 */
function runCheck(userInitiated: boolean): Promise<void> {
  return userInitiated ? runCheckState.user() : runCheckState.background();
}

/** 用户确认后执行：下载新版本（autoDownload=false 时的显式下载入口）。
 *  F-37：下载挂 CancellationToken——cancelDownload() 可中断在途下载。 */
export async function downloadUpdate(): Promise<void> {
  downloading = true;
  // A-1：新一轮下载开始即作废"已下载版本"。electron-updater 在下载失败/取消时
  // 会 clear() 掉 downloadedUpdateHelper 并删掉临时包（out/AppUpdater.js:610
  // removeFileIfAny），旧的"已下载"事实随之失效；不清掉的话 canInstall 会放行
  // 一次注定 no-op 的 quitAndInstall——又回到"点『重启并安装』没反应"。
  downloadedUpdateVersion = null;
  downloadToken = new CancellationToken();
  try {
    await autoUpdater.downloadUpdate(downloadToken);
  } catch (err: any) {
    // 下载失败经 autoUpdater 'error' 事件广播（downloading 标记在位）；
    // 用户取消（cancelRequested）不按失败归因——error 处理器已改为重发
    // update-available，这里只落日志兜底
    log.warn(`updater: downloadUpdate failed: ${err?.message ?? err}`);
  } finally {
    downloading = false;
    downloadToken = null;
  }
}

/**
 * F-37：取消在途下载（ipc updater:cancel-download）。electron-updater 6.x 原生
 * 支持：`downloadUpdate(cancellationToken)` 的令牌 `cancel()` 后安装包下载被
 * abort、downloadUpdate 以取消错误 reject——autoUpdater 随即发 error 事件，
 * 该事件在 cancelRequested 置位时被归因为「用户取消」而非失败（见 error
 * 处理器：重发 update-available，横幅回到 available 态）。
 *
 * 返回 canceled:false 表示当前没有可取消的在途下载（竞态：下载刚完成/已结束
 * ——此时 'update-downloaded' 事件已在路上，渲染层无需任何处理）。
 */
export function cancelDownload(): { ok: boolean; canceled: boolean } {
  if (!downloading || downloadToken === null || downloadToken.cancelled) {
    return { ok: true, canceled: false };
  }
  cancelRequested = true;
  downloadToken.cancel();
  return { ok: true, canceled: true };
}

/**
 * 用户确认后执行：下载完成的前提下退出并安装。
 * F-37（UIUX 审计）：无可安装更新时 electron-updater 的 quitAndInstall 是
 * no-op，旧实现却让 IPC 仍返回 ok:true——语义不实且渲染层无感。改为把
 * 「没有已下载更新」如实回传（error 为稳定哨兵字符串，渲染层映射双语提示；
 * 未识别的 error 原样展示）。
 */
export function quitAndInstall(): { ok: boolean; error?: string } {
  // A-1：判据换成「本进程下载完成了哪个版本」（canInstall）。旧实现在这里问
  // autoUpdater.isUpdaterActive()，而该函数只判 app.isPackaged——AppImage 形态
  // 恒 true，于是无更新时闸门不生效：quitAndInstall 是 no-op，IPC 却回 ok:true，
  // 渲染层把按钮切到「安装中…」后永远等不到重启。
  if (!canInstall(downloadedUpdateVersion)) {
    log.warn(
      `updater: quitAndInstall refused — no downloaded update (downloaded=${downloadedUpdateVersion ?? 'none'})`,
    );
    return { ok: false, error: 'UPDATER_NO_DOWNLOADED_UPDATE' };
  }
  // A-2：安装器启动（spawn 安装包 / 退出前清理）可能失败，失败以异步 'error'
  // 事件回来；置位后由 error 处理器归因为「用户在等结果」并广播给渲染层。
  installRequested = true;
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall();
    } catch (err) {
      // 同步抛出（AppImage 路径不可写、安装包被删等）若不接住，会在 setImmediate
      // 里变成 uncaughtException → crash-guard 直接退出整个桌面端；用户只看到
      // "应用自己关了"而不知道升级失败。这里按 install 失败如实广播。
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`updater: quitAndInstall threw: ${message}`);
      installRequested = false;
      broadcast(UPDATE_EVENTS.error, { message });
    }
  });
  return { ok: true };
}

/**
 * A-1：是否真的存在「已下载完成的更新」。
 *
 * 唯一判据是版本号非空字符串——它只在 update-downloaded 事件里被赋值，
 * 代表 electron-updater 的 downloadedUpdateHelper 已持有可安装的安装包。
 * 空串/null/纯空白都算"没有"（恶意或畸形事件送 '' 时不能放行）。
 * 逐条断言见 dist-selftest/updater.selftest.js。
 */
export function canInstall(downloadedVersion: string | null): boolean {
  return typeof downloadedVersion === 'string' && downloadedVersion.trim() !== '';
}

/**
 * A-3：当前安装形态是否支持**应用内**自更新。
 *
 * 判据刻意与 electron-updater 自己的分派同源，不另立一套：
 *  - Windows（NSIS）/ macOS：恒支持（AppUpdater.isUpdaterActive 只判 isPackaged）；
 *  - Linux：只有 AppImage 支持——AppImageUpdater.isUpdaterActive 仅看
 *    process.env.APPIMAGE，缺失（deb/rpm/pacman/tar 安装）时直接
 *    `Promise.resolve(null)`，一个事件都不发。这时对用户谎称"已发起检查"
 *    等于永久静默：渲染层等不到 available/error，界面永远停在上一个状态。
 */
export function isSelfUpdateSupported(platform: string, appImageEnv: string | undefined): boolean {
  if (platform === 'win32' || platform === 'darwin') return true;
  return typeof appImageEnv === 'string' && appImageEnv !== '';
}

/**
 * A-2：'error' 事件是否该显性化给用户（归因判定，纯函数）。
 *
 * 三种「用户在等结果」的场景：
 *  - userCheck：用户主动点「检查更新」，失败必须有回音；
 *  - downloading：用户确认过的下载流程（DSK-03 的显性面）；
 *  - installRequested：install 已经发出——安装器失败必须让用户知道，
 *    而不是把界面留在「安装中…」。
 * 其余（后台定时检查的离线/私服 404）落日志即可，不打扰用户。
 */
export function surfaceUpdaterError(
  userCheck: boolean,
  downloading: boolean,
  installRequested: boolean,
): boolean {
  return userCheck || downloading || installRequested;
}

/** 给所有存活窗口广播事件（无边框窗口可能一个都没开）。 */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/** B-3②：已下载标记的落盘目录（userData 根，与 config.json 同级）。 */
function updateMarkerDir(): string {
  return app.getPath('userData');
}
