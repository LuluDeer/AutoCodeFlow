/**
 * 桌面执行器审计修复（B-1/B-2/B-6/B-7/B-12/B-14）的**接线结构守卫**。
 *
 * index.ts / executor-process.ts 顶层 import electron——裸 node 加载即崩，
 * 无法直接行为断言（同 updater.selftest 的处境）。这里的守卫哲学与既有
 * selftest 一致：把"修复必须存在的接线锚点"钉死，任何锚点被静默拆除即红。
 * 行为面由 crash-guard / port-probe / release-retention / update-marker 的
 * 纯模块 selftest 与 notifier-rules 的迟滞用例覆盖。
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  advanceHeartbeatHysteresis,
  initialHeartbeatHysteresisState,
  OFFLINE_CONSECUTIVE_FAILURES,
} from './notifier-rules';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf-8');
}

function main(): void {
  const indexSrc = read('index.ts');
  // 去注释版：结构性顺序断言统一用它——否则解释缺陷的中文注释会自我触发。
  const indexCode = indexSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const execSrc = read('executor-process.ts');
  const ipcSrc = read('ipc-handlers.ts');
  const preloadSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'preload', 'index.ts'),
    'utf-8',
  );

  // ── B-7：单实例锁必须先于 ConfigStore 构造 ─────────────────────────
  {
    const lockIdx = indexCode.indexOf('app.requestSingleInstanceLock()');
    const storeIdx = indexCode.indexOf('new ConfigStore()');
    assert.ok(lockIdx >= 0, 'B-7: index.ts 必须请求单实例锁');
    assert.ok(storeIdx >= 0, 'B-7: index.ts 必须构造 ConfigStore');
    assert.ok(
      lockIdx < storeIdx,
      'B-7: 单实例锁必须先于 ConfigStore 构造——否则第二实例会先跑 token 加密' +
        '迁移等写盘副作用、与第一实例竞争同一配置文件，然后才默默退出',
    );
    // userData 覆盖（e2e 隔离）也必须在锁之前（锁文件按 userData 路径落）
    const setPathIdx = indexCode.indexOf("app.setPath('userData'");
    assert.ok(setPathIdx >= 0 && setPathIdx < lockIdx, 'B-7: userData 覆盖必须先于抢锁');
  }

  // ── B-1①：全局崩溃兜底接线 ────────────────────────────────────────
  {
    assert.ok(
      indexCode.includes("process.on('uncaughtException'") &&
        indexCode.includes("process.on('unhandledRejection'"),
      'B-1①: index.ts 必须注册 uncaughtException / unhandledRejection 兜底',
    );
    const guardIdx = indexCode.indexOf('crashGuard.handle(');
    const storeIdx = indexCode.indexOf('new ConfigStore()');
    assert.ok(
      guardIdx >= 0 && guardIdx < storeIdx,
      'B-1①: 崩溃兜底必须先于业务初始化注册（覆盖 ConfigStore 构造期的崩溃窗口）',
    );
    assert.ok(
      indexCode.includes('createCrashGuard(') && indexCode.includes('isQuitting: () => isQuitting'),
      'B-1①: 兜底必须接 createCrashGuard 且感知既有退出流程（isQuitting）',
    );
  }

  // ── B-2：powerMonitor resume 重置迟滞锚点 ─────────────────────────
  {
    assert.ok(
      indexSrc.includes("powerMonitor.on('resume'"),
      'B-2: index.ts 必须挂 powerMonitor resume（全仓此前无任何唤醒处理）',
    );
    const resumeBlock = indexSrc.slice(indexSrc.indexOf("powerMonitor.on('resume'"));
    assert.ok(
      resumeBlock.includes('heartbeat.resetForResume()'),
      'B-2: resume 必须重置 HeartbeatMonitor 双通道迟滞',
    );
    assert.ok(
      resumeBlock.includes('executorProcess.resetHysteresisForResume()'),
      'B-2: resume 必须同时重置 ExecutorProcess 的 admin/liveness 迟滞',
    );
    // heartbeat.ts 的 resetForResume 必须双通道都重置为「未判定」态并补探
    const hb = read('heartbeat.ts');
    const resetIdx = hb.indexOf('resetForResume()');
    assert.ok(resetIdx >= 0, 'B-2: heartbeat.ts 必须提供 resetForResume()');
    const resetBlock = hb.slice(resetIdx, hb.indexOf('}', hb.indexOf('initialHeartbeatHysteresisState()', resetIdx)));
    assert.ok(
      (resetBlock.match(/initialHeartbeatHysteresisState\(\)/g) ?? []).length >= 2,
      'B-2: resetForResume 必须把 local/admin 两个通道都重置（漏一个通道 = 唤醒误报复活）',
    );
    assert.ok(
      resetBlock.includes('this.check()'),
      'B-2: resetForResume 必须立即补探一轮，尽快重建真实锚点',
    );

    // 行为锚（复用纯函数模拟"休眠唤醒"场景）：
    // 旧锚点跨休眠 → 唤醒首轮失败即判死（旧缺陷）；重置后 → 只计数不判死。
    const T0 = 1_700_000_000_000;
    const afterSuccess = advanceHeartbeatHysteresis(initialHeartbeatHysteresisState(), 'ok', T0).state;
    const sleptLong = T0 + 8 * 60 * 60 * 1000; // 休眠 8 小时
    const staleAnchor = advanceHeartbeatHysteresis(afterSuccess, 'failed', sleptLong);
    assert.strictEqual(
      staleAnchor.offline,
      true,
      'B-2 反证：陈旧 lastSuccessAt 下唤醒首轮失败即判死（这正是要修的误报）',
    );
    const resetAnchor = advanceHeartbeatHysteresis(initialHeartbeatHysteresisState(), 'failed', sleptLong);
    assert.strictEqual(
      resetAnchor.offline,
      false,
      'B-2 修复：重置为未判定态后，唤醒首轮失败只计数不判死',
    );
    assert.strictEqual(
      resetAnchor.state.consecutiveFailures,
      1,
      'B-2 修复：失败计数仍要推进（连续 3 次仍会判死，真实掉线不被掩盖）',
    );
    assert.strictEqual(OFFLINE_CONSECUTIVE_FAILURES, 3, 'B-2: 迟滞阈值常量不得被改动');
  }

  // ── B-6：死 IPC 通道 executor:log-structured 必须删除 ──────────────
  {
    // 去注释后判——executor-process 的 B-6 说明注释里会引用该通道名。
    const execCode = execSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const preloadCode = preloadSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(
      !execCode.includes('executor:log-structured') && !preloadCode.includes('log-structured'),
      'B-6: executor-process.ts 不得再广播 executor:log-structured' +
        '（preload 从未暴露、渲染层零消费，纯耗 CPU/带宽；渲染层日志级别已由' +
        ' normalizeLogLine 从文本行解析——存在等价数据源）',
    );
    assert.ok(
      !preloadCode.includes('onLogStructured'),
      'B-6: preload 不得暴露 log-structured 通道（与主进程删除同步）',
    );
    // 文本通道必须仍在（渲染层唯一实时日志源）
    assert.ok(
      execCode.includes("send('executor:log-line'") && preloadCode.includes("'executor:log-line'"),
      'B-6: executor:log-line 文本通道必须保留（删除的是死的结构化通道）',
    );
  }

  // ── B-12：/health/live 回退必须走迟滞 ─────────────────────────────
  {
    const pollIdx = execSrc.indexOf('private startHealthPoll(');
    assert.ok(pollIdx >= 0, 'B-12: startHealthPoll 必须存在');
    const pollBlock = execSrc.slice(pollIdx, execSrc.indexOf('\n  private stopHealthPoll', pollIdx));
    assert.ok(
      pollBlock.includes("advanceHeartbeatHysteresis(this.livenessHysteresis, 'failed'"),
      'B-12: catch 分支必须推进 liveness 迟滞（不得一次探针失败立刻 offline）',
    );
    assert.ok(
      pollBlock.includes('ev.offline') && pollBlock.includes("advanceHeartbeatHysteresis(this.livenessHysteresis, 'ok'"),
      'B-12: liveness 通道必须成败双向推进（成功清零，失败累计）',
    );
    assert.ok(
      pollBlock.includes('ev.offline &&') &&
        pollBlock.indexOf('ev.offline &&') < pollBlock.indexOf("notifyStatus('offline'", pollBlock.indexOf('catch')),
      'B-12: catch 分支的 offline 翻转必须被 ev.offline 守卫（不得绕过迟滞）',
    );
    assert.ok(
      execSrc.includes('resetHysteresisForResume()') &&
        /resetHysteresisForResume\(\)[\s\S]{0,400}?initialHeartbeatHysteresisState\(\)[\s\S]{0,400}?initialHeartbeatHysteresisState\(\)/.test(
          execSrc.replace(/\/\*[\s\S]*?\*\//g, ''),
        ),
      'B-2: ExecutorProcess.resetHysteresisForResume 必须重置 admin+liveness 两份迟滞',
    );
  }

  // ── E2E-ENTRY：开发态执行器入口必须按 __dirname 解析 ────────────────
  // 2026-10 真机 E2E 抓到：Playwright 直接以 `electron dist/main/index.js`
  // 启动时，app.getAppPath() 是 dist/main 而不是包根，拼出的
  // resources/executor-node/index.js 不存在 → 子进程 MODULE_NOT_FOUND →
  // 向导只报 8 秒健康检查超时。这里把「按 __dirname 回退」钉死。
  {
    const entryIdx = execSrc.indexOf('private getEntryPath(');
    assert.ok(entryIdx >= 0, 'E2E-ENTRY: ExecutorProcess.getEntryPath 必须存在');
    const entryBlock = execSrc.slice(entryIdx, execSrc.indexOf('async start(', entryIdx));
    assert.ok(
      entryBlock.includes("path.resolve(__dirname, '..', '..', 'resources', 'executor-node', 'index.js')"),
      'E2E-ENTRY: 开发态入口必须以 __dirname 为基准解析（app.getAppPath() 在直接传入口文件时是 dist/main）',
    );
    assert.ok(
      entryBlock.includes('const fromDist') && entryBlock.includes('fs.existsSync(fromDist)'),
      'E2E-ENTRY: 必须先用 __dirname 路径并用 existsSync 守卫，再回退 app.getAppPath()',
    );
  }

  // ── CFG-SAVE：渲染层已确认的重启不得再弹原生确认 ─────────────────
  // 2026-10 真机 E2E 抓到：ConfigPage 的 ConfirmBar 点「确认保存并重启」后，
  // 主进程 finalizeConfigSave 又弹 dialog.showMessageBox，同一个问题问两遍，
  // 且原生框阻塞保存、自动化无法继续。
  {
    const saveIdx = ipcSrc.indexOf("ipcMain.handle('config:save'");
    assert.ok(saveIdx >= 0, 'CFG-SAVE: config:save handler 必须存在');
    const saveBlock = ipcSrc.slice(
      saveIdx,
      ipcSrc.indexOf("ipcMain.handle('config:save-and-close-wizard'", saveIdx),
    );
    assert.ok(
      saveBlock.includes('finalizeConfigSave(configBefore, { restartConfirmed: true })'),
      'CFG-SAVE: config:save 必须把渲染层确认传下去（否则重复弹原生重启确认框）',
    );
    const importIdx = ipcSrc.indexOf("ipcMain.handle('config:import'");
    const importBlock = ipcSrc.slice(importIdx, ipcSrc.indexOf("ipcMain.handle('config:test-connection'", importIdx));
    assert.ok(
      importBlock.includes('finalizeConfigSave(configBefore);') && !importBlock.includes('restartConfirmed'),
      'CFG-SAVE: config:import 无渲染层确认面，必须保留原生重启征询',
    );
    assert.ok(
      ipcSrc.includes("from './config-restart'") &&
        !ipcSrc.includes('const EXECUTOR_RESTART_REQUIRED_FIELDS'),
      'CFG-SAVE: 重启必需字段清单必须来自 config-restart.ts（不得在 ipc-handlers 再抄一份）',
    );
  }

  // ── B-14：未配置时托盘配置入口开向导 ───────────────────────────────
  {
    const cfgIdx = indexSrc.indexOf('trayManager.onOpenConfig');
    assert.ok(cfgIdx >= 0, 'B-14: index.ts 必须注入托盘配置入口');
    const cfgBlock = indexSrc.slice(cfgIdx, indexSrc.indexOf('trayManager.onOpenHistory'));
    assert.ok(
      cfgBlock.includes("configStore.get('configured')") && cfgBlock.includes('openWizard()'),
      'B-14: 未 configured 时配置入口必须改开向导（旧实现拉起对用户无意义的主窗口状态页）',
    );
  }

  // ── B-1：托盘/自启路径不得漏 rejection 给全局兜底 ──────────────────
  {
    const trayBlock = indexSrc.slice(indexSrc.indexOf('trayManager.onStart'), indexSrc.indexOf('trayManager.onStop'));
    assert.ok(
      /try\s*\{[\s\S]*?executorProcess\.start\(configStore\.getAll\(\)\)[\s\S]*?\}\s*catch/.test(trayBlock),
      'B-1: 托盘启动路径必须接住 start() 的新抛错（否则端口被占时 rejection 进全局兜底会退出整个应用）',
    );
    const autoIdx = indexSrc.indexOf('cfg.autoStartExecutor');
    const autoBlock = indexSrc.slice(autoIdx, indexSrc.indexOf('// P7b：Agent 托管', autoIdx));
    assert.ok(
      /try\s*\{[\s\S]*?executorProcess\.start\(cfg\)[\s\S]*?\}\s*catch/.test(autoBlock),
      'B-1: 开机自启路径必须接住 start() 的新抛错',
    );
  }

  // ── V4 审计（P2/P3）：更新通知 / 托盘菜单拓展 / 启停互斥接线锚点 ──
  // 与本文件既有守卫同哲学：index.ts/tray.ts/updater.ts 顶层拉 electron，
  // 行为面不可在裸 node 直接驱动，这里钉死"修复必须存在的接线锚点"。
  {
    // V4-P2：updater available → 系统通知（广播只达已开窗口，状态窗关闭时
    // 用户永远看不到「有新版本」——必须补 notifier.notifyUpdate 注入链）。
    const notifierSrc = read('notifier.ts');
    const updaterSrc = read('updater.ts');
    assert.ok(
      notifierSrc.includes('notifyUpdate(') && notifierSrc.includes("this.notify('发现新版本'"),
      'V4-P2: notifier 必须提供 notifyUpdate()（复用 notify()，点击路由 status）',
    );
    assert.ok(
      updaterSrc.includes('setUpdateAvailableNotifier') &&
        updaterSrc.includes('updateAvailableNotifier(remote, previouslyDownloaded)'),
      'V4-P2: updater 的 update-available 分支必须调用注入的更新通知回调',
    );
    assert.ok(
      indexCode.includes('setUpdateAvailableNotifier('),
      'V4-P2: index.ts 必须把 notifier.notifyUpdate 注入 updater',
    );

    // V4-P2：托盘「检查更新 / 打开日志文件夹」——回调注入面 + index.ts 接线
    // （检查走 checkForUpdatesUserInitiated；日志目录与 history:open-log-folder
    // 共用 ipc-handlers.openTaskLogFolder 同一实现）。
    const traySrc = read('tray.ts');
    const trayCode = traySrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(
      trayCode.includes('t.checkUpdate') && trayCode.includes('t.openLogFolder'),
      'V4-P2: 托盘菜单必须包含 检查更新 / 打开日志文件夹 两个新项',
    );
    assert.ok(
      trayCode.includes('onCheckForUpdate') && trayCode.includes('onOpenLogFolder'),
      'V4-P2: TrayManager 必须提供新菜单项的回调注入面（onCheckForUpdate/onOpenLogFolder）',
    );
    assert.ok(
      indexCode.includes('trayManager.onCheckForUpdate') &&
        indexCode.includes('trayManager.onOpenLogFolder') &&
        indexCode.includes('checkForUpdatesUserInitiated') &&
        indexCode.includes('openTaskLogFolder'),
      'V4-P2: index.ts 必须接线托盘 检查更新（用户主动检查）/ 打开日志文件夹（openTaskLogFolder）',
    );

    // V4-P3：托盘启停项在飞互斥（快速双击不得重复触发 start/stop）——
    // 点击必须经 runStartStop 入口，不得直连 onStart/onStop。
    const methodBody = (code: string, marker: string): string => {
      const start = code.indexOf(marker);
      assert.ok(start >= 0, `V4-P3: tray.ts 找不到 ${marker}`);
      const rest = code.slice(start);
      const nextPrivate = rest.indexOf('\n  private ', 10);
      return nextPrivate === -1 ? rest : rest.slice(0, nextPrivate);
    };
    assert.ok(
      trayCode.includes('runStartStop(') && trayCode.includes('startStopInFlight'),
      'V4-P3: 托盘启停点击入口必须有在飞互斥标志（startStopInFlight）',
    );
    assert.ok(
      trayCode.includes("click: () => this.runStartStop('start')") &&
        trayCode.includes("click: () => this.runStartStop('stop')") &&
        !trayCode.includes('click: () => this.onStart?.()') &&
        !trayCode.includes('click: () => this.onStop?.()'),
      'V4-P3: 启停菜单项必须经 runStartStop 入口（不得直连回调）',
    );
    const mutexBody = methodBody(trayCode, 'private runStartStop(');
    assert.ok(
      mutexBody.includes('if (this.startStopInFlight) return;') &&
        mutexBody.includes('this.startStopInFlight = true') &&
        mutexBody.includes('this.startStopInFlight = false'),
      'V4-P3: runStartStop 必须先查在飞标志、发起前置位、同步/异步路径都必然复位',
    );

    // V4-P3：heartbeat 在飞失败守卫（行为面用例在 heartbeat.selftest 第 7 节，
    // 这里钉实现锚点：recordSuccess/recordFailure 入口必须判 stop 标记）。
    const hbCode = read('heartbeat.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const fn of ['private recordSuccess(', 'private recordFailure(']) {
      const body = methodBody(hbCode, fn);
      assert.ok(
        /if\s*\(this\.timer\s*===\s*null\)\s*return;/.test(body),
        `V4-P3: heartbeat ${fn.replace('private ', '').replace('(', '')} 入口必须丢弃 stop() 后到达的在飞探针回调（timer===null 守卫）`,
      );
    }

    // ── UIUX F-23（2026-10-25 审计）：向导保存路径对 autoStart 必须**对称**──
    // 审计实证：config:save-and-close-wizard 只在 autoStart===true 时 enable，
    // true→false 分支不调 disable——OS 自启项残留，托盘勾选态（读 config）
    // 与设置页开关（读 OS 真值）呈现相反状态。钉住两个方向的 await 调用
    // （用 await 前缀做锚点，避免被 log.warn 里的同名字符串误满足）。
    const wizardSaveIdx = ipcSrc.indexOf("ipcMain.handle('config:save-and-close-wizard'");
    assert.ok(wizardSaveIdx >= 0, 'F-23: 找不到 config:save-and-close-wizard handler');
    const wizardSaveBody = ipcSrc.slice(
      wizardSaveIdx,
      Math.max(ipcSrc.indexOf('ipcMain.handle(', wizardSaveIdx + 10), ipcSrc.length),
    );
    assert.ok(
      wizardSaveBody.includes('await setAutoLaunchEnabled(true)') &&
        wizardSaveBody.includes('await setAutoLaunchEnabled(false)'),
      'F-23: 向导保存路径必须对 autoStart 对称——false 分支也必须 await setAutoLaunchEnabled(false)（否则托盘与设置页状态矛盾、OS 自启项残留）',
    );

    // ── UIUX F-25（2026-10-25 审计）：向导保存与 config:save 重启判据同源 ──
    // 审计实证：向导保存只调 executorProcess.start()（对运行中进程是 no-op，
    // executor-process.ts start() 直接 return），与 config:save 的重启收口
    // 不同源——重跑向导改端口/token 后新配置落盘却不生效（启动判定探的还是
    // 旧进程/旧端口，按提示「手动启动」仍是 no-op）。钉住：向导 handler 必须
    // 捕获 configBefore diff 基线并复用共享重启收口；旧式「只 start() 不判据
    // 不征询」立即红。
    assert.ok(
      wizardSaveBody.includes('const configBefore = configStore.getAll()') &&
        wizardSaveBody.includes('reloadExecutorAfterConfigSave(configBefore)'),
      'F-25: 向导保存必须与 config:save 同源复用重启收口（configBefore diff + reloadExecutorAfterConfigSave）',
    );
    const reloadFnIdx = ipcSrc.indexOf('async function reloadExecutorAfterConfigSave');
    assert.ok(reloadFnIdx >= 0, 'F-25: reloadExecutorAfterConfigSave 共享收口必须存在');
    const reloadFnBody = ipcSrc.slice(
      reloadFnIdx,
      ipcSrc.indexOf('async function finalizeConfigSave', reloadFnIdx),
    );
    assert.ok(
      reloadFnBody.includes('restartRequiredFieldsChanged') &&
        reloadFnBody.includes('confirmExecutorRestart') &&
        reloadFnBody.includes('await executorProcess.stop()') &&
        reloadFnBody.includes('await executorProcess.start(configStore.getAll())'),
      'F-25: 共享重启收口必须保留「需重启字段变更 → 征询 → stop+start+心跳重启」全链',
    );

    // ── UIUX F-28（2026-10-25 审计）：向导窗口随工作区钳制 + 可 resize ──
    // window-manager.ts 顶层 import electron，裸 node 加载即崩（同 index.ts
    // 处置）——按本文件惯例钉源码锚点。审计实证：660×780 固定尺寸在
    // ≤768p 矮屏下底部「完成/上一步」被任务栏裁切且 resizable:false。
    const wmCode = read('window-manager.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const wmSlice = (startMarker: string, endMarker: string): string => {
      const s = wmCode.indexOf(startMarker);
      assert.ok(s >= 0, `F-28/F-29: window-manager.ts 找不到 ${startMarker}`);
      const e = wmCode.indexOf(endMarker, s + startMarker.length);
      return e > s ? wmCode.slice(s, e) : wmCode.slice(s);
    };
    const openWizardBody = wmSlice('openWizard(): void', 'focusOrOpenStatus(): void');
    assert.ok(
      openWizardBody.includes('Math.min(660, workArea.width)') &&
        openWizardBody.includes('Math.min(780, workArea.height)') &&
        openWizardBody.includes('workArea'),
      'F-28: 向导窗口尺寸必须随 workArea 钳制（对齐 openStatus 的做法，矮屏不裁底部按钮）',
    );
    assert.ok(
      /resizable:\s*true/.test(openWizardBody),
      'F-28: 向导窗口必须可 resize（此前 false，矮屏既不能缩也不能拖）',
    );

    // ── UIUX F-29（2026-10-25 审计）：向导在开时不得唤回主窗 ─────────────
    // focusOrOpenStatus 的守卫顺序必须「先向导后主窗」：向导在开时改为聚焦
    // 向导——否则托盘「查看状态」把主窗 show 回来，向导与设置页并发编辑后，
    // 向导完成以挂载时的旧快照整包覆盖。
    const focusBody = wmSlice('focusOrOpenStatus(): void', 'openStatus(): void');
    const wizardGuardIdx = focusBody.indexOf('this.wizardWindow && !this.wizardWindow.isDestroyed()');
    const statusShowIdx = focusBody.indexOf('this.statusWindow.show()');
    assert.ok(
      wizardGuardIdx >= 0 && statusShowIdx > wizardGuardIdx,
      'F-29: focusOrOpenStatus 必须在 show 主窗之前判「向导在开」并聚焦向导（双窗并发编辑会被向导旧快照整包覆盖）',
    );
    // F-29 收尾让路（e2e n10 用例1 实证回归）：完成路径 closeWizard()（异步
    // close）→ focusOrOpenStatus() 必须仍能开出状态窗——wizardClosing 标志
    // 是这条让路通道的锚点，缺失则向导「完成」后桌面无窗（守卫吞掉状态窗）。
    const closeWizardBody = wmSlice('closeWizard(): void', '\n}');
    assert.ok(
      focusBody.includes('!this.wizardClosing') && closeWizardBody.includes('this.wizardClosing = true'),
      'F-29: closeWizard 必须置 wizardClosing、focusOrOpenStatus 必须对 closing 向导让路（否则完成路径开不出状态窗）',
    );
  }

  console.log('main-index selftest: all assertions passed (B-1 wiring, B-2 resume+hysteresis behavior, B-6 dead channel, B-7 lock order, B-12 liveness hysteresis, B-14 tray wizard, start-path rejections, V4 update-notify/tray-extension/start-stop-mutex/heartbeat-stop-guard anchors, F-23 autostart symmetry, F-28 wizard window clamp, F-29 focus wizard guard, F-25 wizard-save restart convergence, F-31 tray-agent-poll gating)');
}

main();
