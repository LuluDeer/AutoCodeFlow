// F-37（DEEP_REVIEW 0ef3bbe）：fs/path/os/net/https 等模块统一在模块顶层 import，
// 不再在各 handler 函数体内 require（main 进程无打包懒加载收益，纯历史遗留噪音）。
import { app, ipcMain, shell, BrowserWindow } from 'electron';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as childProcess from 'child_process';
import { configStore, executorProcess, heartbeat, syncNotifierWithConfig, trayManager, windowManager } from './index';
import { setAutoLaunchEnabled, getAutoLaunchEnabled } from './autolaunch';
import { checkForUpdates, downloadUpdate, quitAndInstall } from './updater';
import {
  checkPathWithinDomains,
  hasAllowedLogExtension,
  isValidExecutionId,
} from './path-domain';
// python_task_multiversion：设置页的「Python 运行环境」诊断面需要与
// executor-process 完全同源地解析 uv / 解释器池路径（否则诊断结果会与实际
// 下发给子进程的值不一致，比没有诊断更误导）。这里刻意复用 executor-process
// 已注入 Electron 上下文的包装函数，而不是直接调 uv-paths 的纯函数。
import { resolveBundledUvPath, resolveInterpretersDir } from './executor-process';
import { classifyUvResolution } from './uv-paths';
import { listLocalIPv4s } from './network-util';
import { sanitizeConfigInput } from './config-sanitize';
import log, { applyLogLevel } from './logger';

/**
 * R13: the only directories renderer-supplied log paths may live under.
 * Roots mirror where files are actually written:
 *  - workDir/logs  — executor-node task logs (file-logger.ts)
 *  - workDir/apps  — deployed app logs (routes/deploy.ts → <deployDir>/app.log)
 *  - userData/logs — electron-log daily files executor-YYYY-MM-DD.log (logger.ts)
 */
function getAllowedLogDomains(): string[] {
  const domains: string[] = [];
  const workDir = configStore.get('workDir') as string | undefined;
  if (workDir) {
    domains.push(path.join(workDir, 'logs'), path.join(workDir, 'apps'));
  }
  domains.push(path.join(app.getPath('userData'), 'logs'));
  return domains;
}

/**
 * EXP-03（本轮体验审查）：**唯一的**心跳启动入口。
 *
 * 缺陷：F-3 给 `HeartbeatMonitor.start()` 加了第二个参数 `adminApiUrl`，用于
 * 「本地 /health/live + 中台 /api/health 直达探针」的 **AND** 逻辑——后者的
 * 存在意义正是"executor-node 子进程活着、但它与中台的链路断了"这种情形
 * （VPN 断裂等）。而全仓 5 处调用点里**只有 1 处**（index.ts 的托盘启动路径）
 * 传了这个参数，另外 4 处都写成 `heartbeat.start(configStore.get('executorPort'))`：
 *   · ipc-handlers 的配置保存后 reload
 *   · ipc-handlers 的向导保存并关闭
 *   · ipc-handlers 的 executor:start IPC
 *   · index.ts 的开机自启（autoStartExecutor）路径
 *
 * 后果：**用户实际最常走的路径恰好是漏传的那些**——开机自启、点「启动执行器」、
 * 改完配置保存。于是中台直达探针形同虚设，断连时托盘仍显示"在线"，用户对
 * 中台断连无感知（这正是 F-3 要修的问题，只在托盘路径上被修好了）。
 * 这类"加了参数但大部分调用点没跟上"的缺陷不会报错、不会让测试变红，
 * 只会让功能静默退化成它修复前的样子。
 *
 * 修法：收敛为单一入口，端口与 adminApiUrl 一律从**同一份已消毒落盘配置**读，
 * 从根上消除"某个调用点少传一个参数"的可能。
 */
export function startHeartbeat(): void {
  heartbeat.start(
    configStore.get('executorPort'),
    // 与 index.ts 托盘路径同源：adminApiUrl 可能为空（尚未配置中台），
    // HeartbeatMonitor 内部 normalizeAdminProbeUrl 会收敛为 null 并跳过该探针。
    configStore.get('adminApiUrl') || undefined,
  );
}

/**
 * PERF-DSK-01：日志增量读取。
 *
 * 原实现每次轮询都 readFileSync 整个文件 + split('\n') 全量重建行数组，
 * 再 slice(fromLine) 丢掉已发过的前缀——渲染层在任务运行期每 1.5s 轮询一次，
 * 于是一个持续输出的大日志会呈平方级 I/O 增长（主进程同时承载 UI，直接卡界面）。
 *
 * 改为按字节偏移增量读：缓存「文件 → 已读字节数 + 已发总行数」，只读新增
 * 区间，未读完的半行留到下次（避免把被截断的一行当成完整行发出去）。
 * 缓存以 path 为键并做容量上限，防止长跑进程无限增长。
 */
interface LogCursor {
  /** 已消费到的字节偏移（永远停在一行结尾之后） */
  offset: number;
  /** 已产出的总行数（= 下次请求的 fromLine 基准） */
  totalLines: number;
}
const logCursors = new Map<string, LogCursor>();
const LOG_CURSOR_LIMIT = 64;

function readLogIncremental(
  filePath: string,
  fromLine: number,
): { lines: string[]; totalLines: number; error?: string } {
  try {
    const { size } = fs.statSync(filePath);
    let cursor = logCursors.get(filePath);

    // 文件被截断/轮转（大小回退），或调用方要求的起点落后于缓存 → 重建游标
    if (!cursor || size < cursor.offset) {
      cursor = { offset: 0, totalLines: 0 };
      logCursors.set(filePath, cursor);
    }

    // 调用方要求从头读（刷新按钮），或游标超前于请求 → 从头重建
    if (fromLine === 0 && cursor.totalLines !== 0) {
      cursor = { offset: 0, totalLines: 0 };
      logCursors.set(filePath, cursor);
    }

    // 请求起点超前于缓存已知行数（如 UI 状态被重置）→ 保守地从该行号重建：
    // 此时无法用偏移定位，退回一次全量读（罕见路径，不常发生）。
    if (fromLine > cursor.totalLines) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const allLines = content.split('\n').filter((l) => l.length > 0);
      return { lines: allLines.slice(fromLine), totalLines: allLines.length };
    }

    // 只需读 offset..size 区间
    const length = size - cursor.offset;
    if (length <= 0) {
      return { lines: [], totalLines: cursor.totalLines };
    }
    const fd = fs.openSync(filePath, 'r');
    let chunk: string;
    try {
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, cursor.offset);
      chunk = buf.subarray(0, read).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    // 只消费到最后一个换行符：尾部半行留待下次（避免发半行 + 重复计数）
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) {
      return { lines: [], totalLines: cursor.totalLines };
    }
    const consumable = chunk.slice(0, lastNl);
    const newLines = consumable.split('\n').filter((l) => l.length > 0);

    cursor.offset += Buffer.byteLength(chunk.slice(0, lastNl + 1), 'utf-8');
    cursor.totalLines += newLines.length;

    // 返回给调用方的行 = 本次新增中，调用方尚未见过的那部分
    const skip = Math.max(0, fromLine - (cursor.totalLines - newLines.length));
    return { lines: newLines.slice(skip), totalLines: cursor.totalLines };
  } catch {
    return { lines: [], totalLines: 0 };
  } finally {
    // 8-2（audit-r4）：LRU 裁剪由 O(n) 的 Array.from+slice 改为 Map 插入序
    // O(1) 淘汰。Map 按插入顺序迭代：超限时从最旧（队首）删到只剩最近
    // LOG_CURSOR_LIMIT 条；被删条目下次访问会重建游标（见 readLogIncremental
    // 顶部），语义不变。
    while (logCursors.size > LOG_CURSOR_LIMIT) {
      const oldest = logCursors.keys().next();
      if (oldest.done) break;
      logCursors.delete(oldest.value);
    }
  }
}

export function registerIpcHandlers(): void {
  // ── 配置 ──────────────────────────────────────────────
  // SEC-NEW-1: the token is never returned over IPC — the renderer gets a
  // `******` mask (or '') and sends the mask back on save, which config-store
  // maps to "keep the stored token".
  ipcMain.handle('config:get', () => configStore.getAllMasked());

  // BUG-12: the save face only accepts plain-object string|number|boolean
  // values. An array (or nested object carrying getters) would otherwise
  // reach electron-store's dot-notation setter and throw deep inside the
  // store — reject the shape up front.
  const isPlainConfig = (cfg: unknown): boolean =>
    cfg !== null && typeof cfg === 'object' && !Array.isArray(cfg);

  ipcMain.handle('config:save', async (_event, cfg) => {
    if (!isPlainConfig(cfg)) {
      return { ok: false, error: 'invalid config payload' };
    }
    // UX-DSK-NUM：写入前消毒。渲染层的 number input 清空后会送来 NaN（IPC
    // 序列化成 null），直接进 electron-store 会撞 ajv 的 `must be number`
    // 校验并**整次抛出**——此时同批次的其它修改已部分写入，UI 却只显示一句
    // "保存失败"，用户无从判断哪些存了。消毒后再写：非法值回落默认，
    // 越界值钳制，保存必定完整成功。
    configStore.save(sanitizeConfigInput(cfg));
    // P3-1：logLevel 不再是死字段——保存后立即作用于桌面端自身的文件日志。
    applyLogLevel(configStore.get('logLevel'));
    log.info('Config saved via IPC');
    trayManager.rebuildMenu();
    // DSK-04：通知开关 / workDir 可能被改——热同步通知器（开关 + meta 轮询目录）
    syncNotifierWithConfig();
    // 如果执行器正在运行，热重载配置（停止后用新配置重启）
    // 注意：配置本身已落盘成功，但"热重载"是用户可感知的副作用——若重启
    // 失败（端口被占 / token 失效等），执行器会停留在停止态。原实现只写日志
    // 却仍返回 ok:true，渲染层于是显示"已保存，配置已生效"，而执行器其实已经
    // 死了且无任何提示。现改为把 reload 结果一并回传，让 UI 如实呈现。
    let reloadError: string | null = null;
    if (executorProcess.isRunning()) {
      try {
        heartbeat.stop();
        await executorProcess.stop();
        await executorProcess.start(configStore.getAll());
        // EXP-03（本轮体验审查）：改走 startHeartbeat()，把 adminApiUrl 一并传入。
        startHeartbeat();
        log.info('Executor reloaded with new config');
      } catch (err: any) {
        reloadError = err?.message ?? String(err);
        log.error('Failed to reload executor after config save:', reloadError);
        // 重启失败时心跳必须保持停止，避免对一个未运行的执行器报 online
        heartbeat.stop();
      }
    }
    return reloadError ? { ok: true, reloadError } : { ok: true };
  });

  ipcMain.handle('config:save-and-close-wizard', async (_event, cfg) => {
    if (!isPlainConfig(cfg)) {
      return { ok: false, error: 'invalid config payload' };
    }
    // 与 config:save 同一个消毒通道（向导的端口输入框同样可能被清空）。
    const safeCfg = sanitizeConfigInput(cfg);
    configStore.save({ ...safeCfg, configured: true });
    applyLogLevel(configStore.get('logLevel'));
    log.info('Wizard complete, config saved');
    // UX-DSK-AUTOLAUNCH：向导的「开机自动启动」此前只**落盘**了
    // `autoStart`，却从未真正写系统自启动项。而托盘菜单的勾选态读的正是
    // config.autoStart（tray.getAutoLaunch）——于是用户看到"已勾选"、
    // 重启后却没起来，且设置页的自启动开关走的是另一条 IPC（即时生效），
    // 两处行为不一致。首设走向导的用户 100% 踩到。
    if (safeCfg.autoStart === true) {
      await setAutoLaunchEnabled(true);
    }
    windowManager.closeWizard();
    windowManager.openStatus();
    if (safeCfg.autoStartExecutor === true) {
      await executorProcess.start(configStore.getAll());
      // 用**已消毒落盘**的端口，而不是渲染层原始值（NaN 端口会让心跳抛
      // ERR_INVALID_URL，见 heartbeat.normalizeHeartbeatPort 注释）。
      // EXP-03：改走 startHeartbeat()——它读的是同一处已消毒配置，并额外带上
      // adminApiUrl 以启用中台直达探针。
      startHeartbeat();
    }
    trayManager.rebuildMenu();
    // DSK-04：向导可能首设 workDir / notifyEnabled——同步通知器
    syncNotifierWithConfig();
    return { ok: true };
  });

  ipcMain.handle('config:test-connection', async (_event, url: string) => {
    return testAdminApiConnection(url);
  });

  /**
   * python_task_multiversion：回报**实际生效**的 uv 与解释器池路径。
   *
   * 为什么需要：Python 环境的失败模式几乎全是"配置看起来对、实际没生效"
   * （uvPath 写了但指到不存在的文件、自带 uv 没打进包、池目录被配到
   * WORK_DIR 里被 TTL 清掉）。让运维在设置页直接看到"当前用的是哪个 uv、
   * 池在哪、池里有哪些版本"，比让他去翻日志或猜要快得多。
   *
   * 纯读操作、不 spawn 进程（否则每次打开设置页都会拉长响应）。
   */
  ipcMain.handle('config:python-env-status', () => {
    const cfg = configStore.getAll();
    const bundled = resolveBundledUvPath();
    const configured = (cfg.uvPath || '').trim();
    const interpretersDir = resolveInterpretersDir(cfg);

    // UX-DSK-UV：诊断必须与 executor-node 的 uv 解析链**同真值**。
    // 旧实现把"没显式配置 + 没自带"直接判成"未找到 uv"，而 executor-node
    // 在这之后还有 UV_BIN 与 PATH 两级兜底（interpreters.ts resolveUvBin），
    // 于是"uv 装在 PATH 上、任务完全能跑"的机器也会显示假的致命告警。
    // 反方向同理：uvPath 指到不存在的文件时旧实现仍显示"（来自 uvPath 配置）"，
    // 把"配错路径"粉饰成"已生效"。
    // 存在性判定用 stat 而非 spawn（诊断须保持纯读、低成本）。
    const configuredUsable = configured
      ? (() => {
          try {
            return fs.existsSync(configured) && fs.statSync(configured).isFile();
          } catch {
            return false;
          }
        })()
      : false;
    // 6-2（audit-r4）：系统 UV_BIN 是否真的可执行——此前一律视为"已确认可用"，
    // 与运行时 resolveUvBin 的 isExecutable 判定脱节（指向坏路径时诊断误报可用）。
    const systemEnvUvBin = (process.env.UV_BIN || '').trim();
    const systemEnvUvBinUsable = systemEnvUvBin
      ? (() => {
          try {
            return fs.existsSync(systemEnvUvBin) && fs.statSync(systemEnvUvBin).isFile();
          } catch {
            return false;
          }
        })()
      : false;
    // 6-2：PATH 兜底探测仅在**静态无法确认**的分支注入（`uv --version` 实跑，
    // 与 resolveUvBin 同款判据）——这是唯一可能误报"未找到 uv"的分支，spawn
    // 成本（数十 ms）只发生在此处。
    let pathProbe: (() => boolean) | undefined;
    if (!configuredUsable && !bundled && !systemEnvUvBinUsable) {
      pathProbe = () => {
        try {
          const r = childProcess.spawnSync('uv', ['--version'], { timeout: 5000, stdio: 'ignore' });
          return r.status === 0;
        } catch {
          return false;
        }
      };
    }
    const uv = classifyUvResolution({
      configured,
      bundled,
      systemEnvUvBin,
      configuredUsable,
      systemEnvUvBinUsable,
      pathProbe,
    });

    // 池内已就绪的版本目录名（仅目录名，不解析内容——保持纯读且低成本）。
    let poolEntries: string[] = [];
    let poolReadable = true;
    try {
      poolEntries = fs.existsSync(interpretersDir)
        ? fs.readdirSync(interpretersDir).filter((n) => n.startsWith('cpython-'))
        : [];
    } catch {
      poolReadable = false;
    }

    return {
      uvPath: uv.uvPath,
      uvSource: uv.uvSource,
      uvFromSystemEnv: uv.uvFromSystemEnv,
      // 新增：让渲染层能如实区分「已确认可用 / 配错路径 / 只能运行时兜底」。
      uvConfiguredButMissing: uv.uvConfiguredButMissing,
      uvStaticallyConfirmed: uv.uvStaticallyConfirmed,
      interpretersDir,
      poolEntries,
      poolReadable,
      mirrorConfigured: Boolean((cfg.uvPythonInstallMirror || '').trim()),
      pypiConfigured: Boolean((cfg.pypiRegistryUrl || '').trim()),
    };
  });

  ipcMain.handle('config:check-port', async (_event, port: number) => {
    return checkPortAvailable(port);
  });

  // ── 执行器控制 ────────────────────────────────────────
  ipcMain.handle('executor:start', async () => {
    await executorProcess.start(configStore.getAll());
    // EXP-03：改走 startHeartbeat()（带上 adminApiUrl 启用中台直达探针）。
    startHeartbeat();
    return { ok: true };
  });

  ipcMain.handle('executor:stop', async () => {
    heartbeat.stop();
    await executorProcess.stop();
    return { ok: true };
  });

  // SEC-NEW-1: status payload returns the masked config for the same reason
  // as config:get — the renderer must not receive the stored token.
  ipcMain.handle('executor:status', () => ({
    running: executorProcess.isRunning(),
    status: executorProcess.getStatus(),
    config: configStore.getAllMasked(),
  }));

  // ── 开机自启 ──────────────────────────────────────────
  ipcMain.handle('autolaunch:get', async () => getAutoLaunchEnabled());

  ipcMain.handle('autolaunch:set', async (_event, enable: boolean) => {
    await setAutoLaunchEnabled(enable);
    configStore.save({ autoStart: enable });
    trayManager.rebuildMenu();
    return { ok: true };
  });

  // ── 自动更新（DSK-03）─────────────────────────────────
  // renderer 主动触发一次检查（设置页「检查更新」按钮）；dev 未打包时
  // updater 未初始化，checkForUpdates 静默失败返回 ok:false。
  ipcMain.handle('updater:check', async () => {
    await checkForUpdates();
    return { ok: true };
  });

  // 用户确认升级第一步：下载新版本。autoDownload=false 时 electron-updater
  // 不会自行下载，必须由渲染层显式触发；进度经 updater:progress 通道回推。
  ipcMain.handle('updater:download', async () => {
    await downloadUpdate();
    return { ok: true };
  });

  // 用户确认升级：下载完成后退出并安装（AppImage/deb 均由 electron-updater
  // 按 resources/package-type 分派对应安装器）
  ipcMain.handle('updater:install', () => {
    quitAndInstall();
    return { ok: true };
  });

  // ── 历史记录 & 日志 ────────────────────────────────────
  ipcMain.handle('history:get', () => {
    const workDir = configStore.get('workDir') as string | undefined;
    if (!workDir) return [];
    const metaDir = path.join(workDir, 'meta');
    if (!fs.existsSync(metaDir)) return [];
    try {
      const files = fs.readdirSync(metaDir).filter((f: string) => f.endsWith('.json'));
      const records = files.map((f: string) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(metaDir, f), 'utf-8'));
        } catch { return null; }
      }).filter(Boolean);
      // sort by startTime desc
      records.sort((a: any, b: any) => (b.startTime || 0) - (a.startTime || 0));
      return records;
    } catch { return []; }
  });

  // 读取主进程当天的历史日志（用于主窗口启动时加载历史）
  ipcMain.handle('logs:getToday', () => {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) return { lines: [], date: '' };

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const fileName = `executor-${y}-${m}-${d}.log`;
    const filePath = path.join(logDir, fileName);

    if (!fs.existsSync(filePath)) return { lines: [], date: fileName };

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      // 只取最后 500 行，避免一次性加载太多
      const lastLines = lines.slice(-500);
      return { lines: lastLines, date: fileName };
    } catch {
      return { lines: [], date: fileName };
    }
  });

  // P3-2：此处曾注册 logs:listAll / logs:readFile 两个 handler，但 preload
  // 从未暴露、渲染层零调用，是不可达的死端点（历史日志查看 UI 从未落地）。
  // 已删除；需要该功能时连同 preload 通道与 UI 一起加回（git 历史可找回实现，
  // readFile 的路径遍历守卫需一并恢复）。

  ipcMain.handle('history:clear', () => {
    const workDir = configStore.get('workDir') as string | undefined;
    if (!workDir) return { ok: false };
    const metaDir = path.join(workDir, 'meta');
    if (!fs.existsSync(metaDir)) return { ok: true };
    try {
      const files = fs.readdirSync(metaDir).filter((f: string) => f.endsWith('.json'));
      files.forEach((f: string) => fs.unlinkSync(path.join(metaDir, f)));
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('log:read', (_event, executionId: string, fromLine: number = 0) => {
    // R13: executionId is renderer-supplied — whitelist its charset first
    // (same ^[A-Za-z0-9_-]+$ rule as admin-api heartbeat sanitization) so it
    // can never carry ../ traversal, then domain-check the final path.
    if (!isValidExecutionId(executionId)) {
      log.warn(`log:read rejected invalid executionId: ${JSON.stringify(executionId)}`);
      return { lines: [], totalLines: 0, error: 'invalid executionId' };
    }
    const workDir = configStore.get('workDir') as string | undefined;
    if (!workDir) return { lines: [], totalLines: 0 };
    // look in today's dir and yesterday's dir
    const tryDates = [new Date(), new Date(Date.now() - 86400000)];
    for (const d of tryDates) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const logFile = path.join(workDir, 'logs', dateStr, `${executionId}.log`);
      const check = checkPathWithinDomains(logFile, getAllowedLogDomains());
      if (!check.ok) {
        return { lines: [], totalLines: 0, error: check.error };
      }
      const target = check.resolvedPath!;
      if (fs.existsSync(target)) {
        return readLogIncremental(target, fromLine);
      }
    }
    return { lines: [], totalLines: 0 };
  });

  // ── 日志文件管理 ───────────────────────────────────────
  // 列出过往日志文件（桌面端自身日志 + 任务日志）
  ipcMain.handle('log:list-files', () => {
    const result: Array<{ label: string; path: string; date: string }> = [];

    // EXP-05（本轮体验审查）：此前这里读的是 `logs/main.log`，而 logger.ts:15
    // 实际落盘名是 `executor-YYYY-MM-DD.log`——因 existsSync 守卫，该条目
    // **永不出现**，且整个 userData/logs 域在面板里再无其他条目。后果是
    // `logs:getToday` 只读**今天**、只喂主日志区，于是**昨天的桌面端日志从 UI
    // 完全不可达**：排查「昨天执行器为什么没起来」时用户拿不到任何材料。
    // 改为按 logger.ts 的命名遍历（与 logger.ts:57 的 startsWith('executor-')
    // 判据同源），日期倒序。
    const desktopLogDir = path.join(app.getPath('userData'), 'logs');
    if (fs.existsSync(desktopLogDir)) {
      const desktopLogs = fs
        .readdirSync(desktopLogDir)
        .filter((f: string) => /^executor-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort()
        .reverse()
        .slice(0, 30); // 最近 30 天（与任务日志同口径）
      for (const f of desktopLogs) {
        const date = f.replace(/^executor-/, '').replace(/\.log$/, '');
        result.push({
          label: `桌面端日志 (${date})`,
          path: path.join(desktopLogDir, f),
          date,
        });
      }
    }

    // 任务日志：workDir/logs/YYYY-MM-DD/
    const workDir = configStore.get('workDir') as string | undefined;
    if (workDir) {
      const logsDir = path.join(workDir, 'logs');
      if (fs.existsSync(logsDir)) {
        const days = fs.readdirSync(logsDir)
          .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
          .sort()
          .reverse()
          .slice(0, 30); // 最近 30 天
        for (const day of days) {
          const dayDir = path.join(logsDir, day);
          const files = fs.readdirSync(dayDir).filter((f: string) => f.endsWith('.log'));
          for (const f of files) {
            result.push({ label: `${day} / ${f}`, path: path.join(dayDir, f), date: day });
          }
        }
      }
    }
    return result;
  });

  // 用系统默认程序打开指定日志文件
  ipcMain.handle('log:open-file', async (_event, filePath: string) => {
    // R13: shell.openPath on Windows *executes* .bat/.lnk/.exe — the path
    // must be inside an allowed log domain AND be a plain-text log file.
    const check = checkPathWithinDomains(filePath, getAllowedLogDomains());
    if (!check.ok) {
      log.warn(`log:open-file rejected: ${filePath} (${check.error})`);
      return { ok: false, error: check.error };
    }
    const target = check.resolvedPath!;
    if (!hasAllowedLogExtension(target)) {
      return { ok: false, error: '仅允许打开 .log/.txt 文件' };
    }
    const err = await shell.openPath(target);
    return { ok: !err, error: err || undefined };
  });

  // ── 已部署应用 ─────────────────────────────────────────
  // 列出本地所有已部署的应用（workDir/apps/<appId>/<deploymentId>/）
  ipcMain.handle('apps:list', () => {
    const workDir = configStore.get('workDir') as string | undefined;
    if (!workDir) return [];
    const appsDir = path.join(workDir, 'apps');
    if (!fs.existsSync(appsDir)) return [];
    const result: Array<{
      appId: string;
      deploymentId: string;
      hasLog: boolean;
      logPath: string;
      deployDir: string;
    }> = [];
    // D 修正：原为 `catch { /* ignore */ }`——权限/IO 异常会让渲染层看到
    // 空列表，与"确实没有部署"完全无法区分。改为向上抛出，由 apps:list 的
    // IPC reject 传入渲染层（AppsPage 已展示错误条）。
    // 单个条目 stat 失败（并发删除等）仍跳过——那是正常的目录竞争，
    // 不代表整体列举失败。
    const appIds = fs.readdirSync(appsDir).filter((d: string) => {
      try {
        return fs.statSync(path.join(appsDir, d)).isDirectory();
      } catch {
        return false;
      }
    });
    for (const appId of appIds) {
      const appDir = path.join(appsDir, appId);
      let deploymentIds: string[];
      try {
        deploymentIds = fs.readdirSync(appDir).filter((d: string) => {
          try {
            return fs.statSync(path.join(appDir, d)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        continue; // 单应用目录读失败：跳过该应用，不影响其余
      }
      for (const deploymentId of deploymentIds) {
        const deployDir = path.join(appDir, deploymentId);
        const logPath = path.join(deployDir, 'app.log');
        result.push({
          appId,
          deploymentId,
          hasLog: fs.existsSync(logPath),
          logPath,
          deployDir,
        });
      }
    }
    return result;
  });

  // 读取应用日志（支持分页，从 fromLine 开始）
  ipcMain.handle('apps:log:read', (_event, logPath: string, fromLine: number = 0) => {
    // R13: logPath is renderer-supplied — constrain it to the allowed
    // domains (legitimate values come from apps:list: workDir/apps/...).
    const check = checkPathWithinDomains(logPath, getAllowedLogDomains());
    if (!check.ok) {
      log.warn(`apps:log:read rejected: ${logPath} (${check.error})`);
      return { lines: [], totalLines: 0, error: check.error };
    }
    const target = check.resolvedPath!;
    if (!fs.existsSync(target)) return { lines: [], totalLines: 0 };
    // PERF-DSK-01：与 log:read 同因——AppsPage 每 2s 轮询，全量重读同样是
    // 平方级 I/O。复用同一套增量游标实现。
    return readLogIncremental(target, fromLine);
  });

  // 网络工具 ──────────────────────────────────────────
  // 无边框窗口控制
  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });
  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  // 与 executor-process 构造子进程 env 时的对外地址兜底同源（network-util），
  // 避免一处改了网卡筛选规则、另一处漂移。
  ipcMain.handle('network:local-ips', () => listLocalIPv4s());
}

function checkPortAvailable(port: number): Promise<{ available: boolean; message: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ available: false, message: `端口 ${port} 已被占用，请换一个端口` });
      } else {
        resolve({ available: false, message: `端口检测失败: ${err.message}` });
      }
    });
    server.once('listening', () => {
      server.close();
      resolve({ available: true, message: `端口 ${port} 可用` });
    });
    server.listen(port, '0.0.0.0');
  });
}

function testAdminApiConnection(url: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(`${url}/api/health`);
      // R24: pick the transport module and default port from the protocol —
      // https used to be dialed over plain http:80 and always failed.
      const isHttps = parsed.protocol === 'https:';
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        resolve({ ok: false, message: `不支持的协议: ${parsed.protocol}（仅支持 http/https）` });
        return;
      }
      const transport = (isHttps ? https : http) as typeof http;
      const req = transport.get(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          timeout: 5_000,
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) {
            resolve({ ok: true, message: `连接成功 (HTTP ${res.statusCode})` });
          } else {
            resolve({ ok: false, message: `服务器返回 HTTP ${res.statusCode}，请检查地址是否正确` });
          }
        },
      );
      req.on('error', (err) => resolve({ ok: false, message: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, message: '连接超时 (5s)' });
      });
    } catch (err: any) {
      resolve({ ok: false, message: `无效的 URL: ${err.message}` });
    }
  });
}
