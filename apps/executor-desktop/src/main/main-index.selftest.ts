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

  console.log('main-index selftest: all assertions passed (B-1 wiring, B-2 resume+hysteresis behavior, B-6 dead channel, B-7 lock order, B-12 liveness hysteresis, B-14 tray wizard, start-path rejections)');
}

main();
