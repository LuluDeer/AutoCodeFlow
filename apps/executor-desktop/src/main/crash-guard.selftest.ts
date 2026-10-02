/**
 * B-1① self-check：主进程崩溃兜底决策层（node:assert，无测试框架）。
 * crash-guard.ts 是纯模块（无 electron 依赖），这里用注入的假 Electron 原语
 * 逐分支驱动真实实现。Run via: npm run test:main
 *
 * 覆盖（对齐 crash-guard.ts 头注的兜底语义）：
 *  - 首次崩溃：记录（origin + Error/非 Error 形态）+ dialog 一次 + 经
 *    quitApp 退出（退出由既有 before-quit 停机序承接）+ 预挂硬超时兜底；
 *  - 二次崩溃：dialog 不重复、退出流程不重入；
 *  - 退出流程中（isQuitting）再崩：只记录，不叠加 quit；
 *  - quitApp 抛错 / showErrorBox 抛错 / logError 抛错：handle 绝不外抛，
 *    quitApp 失败立即 forceExit；
 *  - 硬超时到点：forceExit(1)。
 */
import * as assert from 'node:assert';
import { createCrashGuard, formatCrashMessage, CRASH_FORCE_EXIT_TIMEOUT_MS, CRASH_DIALOG_TEXTS } from './crash-guard';

interface DepsStub {
  logError: (m: string) => void;
  showErrorBox: (title: string, body: string) => void;
  locale: () => 'zh' | 'en';
  isQuitting: () => boolean;
  quitApp: () => void;
  forceExit: (code: number) => void;
  armForceExit: (fn: () => void, ms: number) => void;
  forceExitTimeoutMs?: number;
}

function makeDeps(overrides: Partial<DepsStub> = {}): DepsStub & {
  logs: string[];
  dialogs: Array<{ title: string; body: string }>;
  quits: number;
  exits: number[];
  fireForceExit: () => void;
} {
  const logs: string[] = [];
  const dialogs: Array<{ title: string; body: string }> = [];
  const exits: number[] = [];
  let quits = 0;
  let armed: (() => void) | null = null;
  return {
    logs,
    dialogs,
    get quits() {
      return quits;
    },
    exits,
    fireForceExit: () => {
      armed?.();
    },
    logError: (m) => {
      logs.push(m);
    },
    showErrorBox: (title, body) => {
      dialogs.push({ title, body });
    },
    locale: () => 'zh',
    isQuitting: () => false,
    quitApp: () => {
      quits++;
    },
    forceExit: (code) => {
      exits.push(code);
    },
    armForceExit: (fn) => {
      armed = fn;
    },
    ...overrides,
  };
}

function main(): void {
  // ── 1. 首次崩溃：完整兜底链 ────────────────────────────────────────
  {
    const deps = makeDeps();
    const guard = createCrashGuard(deps);
    guard.handle('uncaughtException', new Error('boom'));
    assert.strictEqual(deps.logs.length, 1, '崩溃必须落日志');
    assert.ok(deps.logs[0].startsWith('[fatal:uncaughtException]'), '日志必须带 origin 前缀');
    assert.ok(deps.logs[0].includes('boom'), '日志必须含错误信息');
    assert.strictEqual(deps.dialogs.length, 1, 'dialog 只弹一次');
    assert.strictEqual(deps.dialogs[0].title, CRASH_DIALOG_TEXTS.zh.title, '中文 locale 取中文文案');
    assert.strictEqual(deps.quits, 1, '经 quitApp 优雅退出（触发既有 before-quit 停机序）');
    assert.strictEqual(deps.exits.length, 0, 'quitApp 成功时不直接 forceExit');
    assert.strictEqual(guard.hasRequestedQuit(), true);
  }

  // ── 2. 二次崩溃：dialog 去重 + 退出不重入 ──────────────────────────
  {
    const deps = makeDeps();
    const guard = createCrashGuard(deps);
    guard.handle('uncaughtException', new Error('first'));
    guard.handle('unhandledRejection', 'second');
    assert.strictEqual(deps.logs.length, 2, '每次崩溃都记录');
    assert.ok(deps.logs[1].startsWith('[fatal:unhandledRejection]'), 'rejection 的 origin 如实标注');
    assert.ok(deps.logs[1].includes('second'), '字符串 rejection 原样呈现');
    assert.strictEqual(deps.dialogs.length, 1, 'dialog 仅第一次弹（防崩溃风暴弹窗轰炸）');
    assert.strictEqual(deps.quits, 1, '退出流程只发起一次（重入守卫）');
  }

  // ── 3. 退出流程中再崩：交还既有 before-quit 停机链 ─────────────────
  {
    const deps = makeDeps({ isQuitting: () => true });
    const guard = createCrashGuard(deps);
    guard.handle('uncaughtException', new Error('inside before-quit chain'));
    assert.strictEqual(deps.logs.length, 1, '仍要记录');
    assert.strictEqual(deps.dialogs.length, 1, 'dialog 仍提示一次');
    assert.strictEqual(deps.quits, 0, '已在停机链中：不叠加 quit（before-quit 的 finally 兜底）');
    assert.strictEqual(deps.exits.length, 0);
    assert.strictEqual(guard.hasRequestedQuit(), false);
  }

  // ── 4. quitApp 抛错 → 立即 forceExit ──────────────────────────────
  {
    const deps = makeDeps({
      quitApp: () => {
        throw new Error('app.quit exploded');
      },
    });
    const guard = createCrashGuard(deps);
    assert.doesNotThrow(() => guard.handle('uncaughtException', new Error('x')), 'handle 绝不外抛');
    assert.deepStrictEqual(deps.exits, [1], 'quitApp 失败立即 forceExit(1)');
  }

  // ── 5. showErrorBox / logError 抛错：不阻断退出、不外抛 ─────────────
  {
    const deps = makeDeps({
      showErrorBox: () => {
        throw new Error('dialog unavailable (app not ready)');
      },
      logError: () => {
        throw new Error('logger exploded');
      },
    });
    const guard = createCrashGuard(deps);
    assert.doesNotThrow(() => guard.handle('unhandledRejection', 42), '兜底内再抛 = 兜底失效');
    assert.strictEqual(deps.quits, 1, '记录/对话框失败不阻断退出');
    // 非 Error rejection（数字）也要可读
  }

  // ── 6. 硬超时兜底：停机链挂死 → forceExit(1) ───────────────────────
  {
    const deps = makeDeps();
    const guard = createCrashGuard(deps);
    guard.handle('uncaughtException', new Error('hang case'));
    deps.fireForceExit();
    assert.deepStrictEqual(deps.exits, [1], '硬超时到点强制退出');
  }
  {
    // 超时值默认 40s（> before-quit 停机链最长 30s 任务排空，避免误杀排空中）
    const deps = makeDeps();
    let capturedMs = 0;
    const guard = createCrashGuard({ ...deps, armForceExit: (fn, ms) => { capturedMs = ms; void fn; } });
    guard.handle('uncaughtException', new Error('timeout value case'));
    assert.strictEqual(capturedMs, CRASH_FORCE_EXIT_TIMEOUT_MS, '默认硬超时应为导出常量');
    assert.ok(CRASH_FORCE_EXIT_TIMEOUT_MS > 30_000, '硬超时必须大于停机链的 30s 排空上限');
  }

  // ── 7. 自定义超时 + locale 回落 ────────────────────────────────────
  {
    const deps = makeDeps({ locale: () => 'en' });
    const guard = createCrashGuard(deps);
    guard.handle('uncaughtException', new Error('en case'));
    assert.strictEqual(deps.dialogs[0].title, CRASH_DIALOG_TEXTS.en.title, 'en locale 取英文文案');
    assert.strictEqual(deps.quits, 1);
  }

  // ── 8. formatCrashMessage 的输入形态 ───────────────────────────────
  {
    const e = new Error('with stack');
    assert.ok(formatCrashMessage('o', e).includes('with stack'));
    assert.strictEqual(formatCrashMessage('o', 'plain string'), '[fatal:o] plain string');
    assert.ok(formatCrashMessage('o', { code: 'E_X' }).includes('E_X'), '对象 rejection JSON 化');
    assert.ok(formatCrashMessage('o', undefined).includes('undefined'), 'undefined 也不炸');
    // 循环引用对象：JSON.stringify 抛错时回落 String()
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => formatCrashMessage('o', circular));
  }

  console.log('crash-guard selftest: all assertions passed (log+dialog-once+graceful-quit, re-entry guard, force-exit, no-throw guarantee)');
}

main();
