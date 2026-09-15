// F-37（DEEP_REVIEW 0ef3bbe）：fs/path/os/net/https 等模块统一在模块顶层 import，
// 不再在各 handler 函数体内 require（main 进程无打包懒加载收益，纯历史遗留噪音）。
import { app, ipcMain, shell, BrowserWindow } from 'electron';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as net from 'net';
import { configStore, executorProcess, heartbeat, syncNotifierWithConfig, trayManager, windowManager } from './index';
import { setAutoLaunchEnabled, getAutoLaunchEnabled } from './autolaunch';
import { checkForUpdates, downloadUpdate, quitAndInstall } from './updater';
import {
  checkPathWithinDomains,
  hasAllowedLogExtension,
  isValidExecutionId,
} from './path-domain';
import log from './logger';

/**
 * R13: the only directories renderer-supplied log paths may live under.
 * Roots mirror where files are actually written:
 *  - workDir/logs  — executor-node task logs (file-logger.ts)
 *  - workDir/apps  — deployed app logs (routes/deploy.ts → <deployDir>/app.log)
 *  - userData/logs — electron-log main.log (logger.ts)
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
    // 简单的 LRU 式裁剪：超限时清掉最旧的一批
    if (logCursors.size > LOG_CURSOR_LIMIT) {
      const keys = Array.from(logCursors.keys()).slice(0, logCursors.size - LOG_CURSOR_LIMIT);
      for (const k of keys) logCursors.delete(k);
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
    configStore.save(cfg);
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
        heartbeat.start(configStore.get('executorPort'));
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
    configStore.save({ ...cfg, configured: true });
    log.info('Wizard complete, config saved');
    windowManager.closeWizard();
    windowManager.openStatus();
    if (cfg.autoStartExecutor) {
      await executorProcess.start(configStore.getAll());
      heartbeat.start(cfg.executorPort);
    }
    trayManager.rebuildMenu();
    // DSK-04：向导可能首设 workDir / notifyEnabled——同步通知器
    syncNotifierWithConfig();
    return { ok: true };
  });

  ipcMain.handle('config:test-connection', async (_event, url: string) => {
    return testAdminApiConnection(url);
  });

  ipcMain.handle('config:check-port', async (_event, port: number) => {
    return checkPortAvailable(port);
  });

  // ── 执行器控制 ────────────────────────────────────────
  ipcMain.handle('executor:start', async () => {
    await executorProcess.start(configStore.getAll());
    heartbeat.start(configStore.get('executorPort'));
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
  // 列出过往日志文件（按天分组，含 main.log）
  ipcMain.handle('log:list-files', () => {
    const result: Array<{ label: string; path: string; date: string }> = [];

    // main.log
    const mainLog = path.join(app.getPath('userData'), 'logs', 'main.log');
    if (fs.existsSync(mainLog)) {
      result.push({ label: '主进程日志 (main.log)', path: mainLog, date: '' });
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

  ipcMain.handle('network:local-ips', () => {
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];
    for (const iface of Object.values(interfaces) as any[]) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) {
          ips.push(addr.address);
        }
      }
    }
    return ips;
  });
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
