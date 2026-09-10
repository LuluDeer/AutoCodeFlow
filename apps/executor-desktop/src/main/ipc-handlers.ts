import { app, ipcMain } from 'electron';
import * as http from 'http';
import * as path from 'path';
import { configStore, executorProcess, heartbeat, syncNotifierWithConfig, trayManager, windowManager } from './index';
import { setAutoLaunchEnabled, getAutoLaunchEnabled } from './autolaunch';
import { checkForUpdates, quitAndInstall } from './updater';
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
    if (executorProcess.isRunning()) {
      try {
        heartbeat.stop();
        await executorProcess.stop();
        await executorProcess.start(configStore.getAll());
        heartbeat.start(configStore.get('executorPort'));
        log.info('Executor reloaded with new config');
      } catch (err: any) {
        log.error('Failed to reload executor after config save:', err.message);
      }
    }
    return { ok: true };
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
    const metaDir = require('path').join(workDir, 'meta');
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(metaDir)) return [];
    try {
      const files = fs.readdirSync(metaDir).filter((f: string) => f.endsWith('.json'));
      const records = files.map((f: string) => {
        try {
          return JSON.parse(fs.readFileSync(require('path').join(metaDir, f), 'utf-8'));
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
    const metaDir = require('path').join(workDir, 'meta');
    const fs = require('fs') as typeof import('fs');
    if (!fs.existsSync(metaDir)) return { ok: true };
    try {
      const files = fs.readdirSync(metaDir).filter((f: string) => f.endsWith('.json'));
      files.forEach((f: string) => fs.unlinkSync(require('path').join(metaDir, f)));
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
    const fs = require('fs') as typeof import('fs');
    const pathMod = require('path');
    // look in today's dir and yesterday's dir
    const tryDates = [new Date(), new Date(Date.now() - 86400000)];
    for (const d of tryDates) {
      const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const logFile = pathMod.join(workDir, 'logs', dateStr, `${executionId}.log`);
      const check = checkPathWithinDomains(logFile, getAllowedLogDomains());
      if (!check.ok) {
        return { lines: [], totalLines: 0, error: check.error };
      }
      const target = check.resolvedPath!;
      if (fs.existsSync(target)) {
        try {
          const content = fs.readFileSync(target, 'utf-8');
          const allLines = content.split('\n').filter((l: string) => l.length > 0);
          const totalLines = allLines.length;
          const lines = allLines.slice(fromLine);
          return { lines, totalLines };
        } catch { return { lines: [], totalLines: 0 }; }
      }
    }
    return { lines: [], totalLines: 0 };
  });

  // ── 日志文件管理 ───────────────────────────────────────
  // 列出过往日志文件（按天分组，含 main.log）
  ipcMain.handle('log:list-files', () => {
    const fs = require('fs') as typeof import('fs');
    const pathMod = require('path');
    const { app: electronApp } = require('electron');
    const result: Array<{ label: string; path: string; date: string }> = [];

    // main.log
    const mainLog = pathMod.join(electronApp.getPath('userData'), 'logs', 'main.log');
    if (fs.existsSync(mainLog)) {
      result.push({ label: '主进程日志 (main.log)', path: mainLog, date: '' });
    }

    // 任务日志：workDir/logs/YYYY-MM-DD/
    const workDir = configStore.get('workDir') as string | undefined;
    if (workDir) {
      const logsDir = pathMod.join(workDir, 'logs');
      if (fs.existsSync(logsDir)) {
        const days = fs.readdirSync(logsDir)
          .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
          .sort()
          .reverse()
          .slice(0, 30); // 最近 30 天
        for (const day of days) {
          const dayDir = pathMod.join(logsDir, day);
          const files = fs.readdirSync(dayDir).filter((f: string) => f.endsWith('.log'));
          for (const f of files) {
            result.push({ label: `${day} / ${f}`, path: pathMod.join(dayDir, f), date: day });
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
    const { shell } = require('electron');
    const err = await shell.openPath(target);
    return { ok: !err, error: err || undefined };
  });

  // ── 已部署应用 ─────────────────────────────────────────
  // 列出本地所有已部署的应用（workDir/apps/<appId>/<deploymentId>/）
  ipcMain.handle('apps:list', () => {
    const fs = require('fs') as typeof import('fs');
    const pathMod = require('path');
    const workDir = configStore.get('workDir') as string | undefined;
    if (!workDir) return [];
    const appsDir = pathMod.join(workDir, 'apps');
    if (!fs.existsSync(appsDir)) return [];
    const result: Array<{
      appId: string;
      deploymentId: string;
      hasLog: boolean;
      logPath: string;
      deployDir: string;
    }> = [];
    try {
      const appIds = fs.readdirSync(appsDir).filter((d: string) =>
        fs.statSync(pathMod.join(appsDir, d)).isDirectory()
      );
      for (const appId of appIds) {
        const appDir = pathMod.join(appsDir, appId);
        const deploymentIds = fs.readdirSync(appDir).filter((d: string) =>
          fs.statSync(pathMod.join(appDir, d)).isDirectory()
        );
        for (const deploymentId of deploymentIds) {
          const deployDir = pathMod.join(appDir, deploymentId);
          const logPath = pathMod.join(deployDir, 'app.log');
          result.push({
            appId,
            deploymentId,
            hasLog: fs.existsSync(logPath),
            logPath,
            deployDir,
          });
        }
      }
    } catch { /* ignore */ }
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
    const fs = require('fs') as typeof import('fs');
    const target = check.resolvedPath!;
    if (!fs.existsSync(target)) return { lines: [], totalLines: 0 };
    try {
      const content = fs.readFileSync(target, 'utf-8');
      const allLines = content.split('\n').filter((l: string) => l.length > 0);
      return { lines: allLines.slice(fromLine), totalLines: allLines.length };
    } catch { return { lines: [], totalLines: 0 }; }
  });

  // 网络工具 ──────────────────────────────────────────
  // 无边框窗口控制
  ipcMain.handle('window:minimize', (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });
  ipcMain.handle('window:close', (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  ipcMain.handle('network:local-ips', () => {
    const os = require('os');
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
    const net = require('net');
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
      const transport = (isHttps ? require('https') : http) as typeof http;
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
