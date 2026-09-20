/**
 * NETOPT-E P2-4: updater runCheck 状态机 selftest（node:assert，无测试框架）。
 * 直接驱动 src/main/updater-runcheck.ts 的真实实现（该模块无 electron 依赖，
 * 可被纯 node selftest 加载）——不再采用 updater.selftest.ts 那种"内联副本 +
 * SYNC_GUARD"的弱形态，状态机行为有真回归锁。
 * Run via: npm run test:main
 */
import * as assert from 'node:assert';
import { createRunCheck } from './updater-runcheck';

/** 可手动 resolve 的 fake 检查器（模拟 autoUpdater.checkForUpdates）。 */
function makeFake() {
  let release: (() => void) | null = null;
  const calls: string[] = [];
  return {
    calls,
    checkForUpdates(): Promise<void> {
      calls.push('check');
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    /** 完成当前 in-flight 检查（模拟 electron-updater 返回）。 */
    finish(): void {
      const r = release;
      release = null;
      if (!r) throw new Error('no in-flight check to finish');
      r();
    },
  };
}

/** 排空微任务 + 宏任务队列（async IIFE 续体依赖多轮调度）。 */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function main(): Promise<void> {
  // ── 1) 后台在飞 + 用户进入：用户串行等待后台，再发起自己的检查 ──
  {
    const fake = makeFake();
    const state = createRunCheck(() => fake.checkForUpdates());

    const bg = state.background(); // 后台发起，in-flight
    const user = state.user(); // 用户进入：必须 await prev，不能复用归因
    // 第一次 check 仍在飞——用户检查尚未开始（只有后台那次调用）
    assert.equal(fake.calls.length, 1, 'user must wait for in-flight background check');
    assert.equal(state.surfaceError, false, 'background check must not surface errors');

    fake.finish();
    await tick();
    await tick();
    // 后台完成后，用户检查必须真正发起（第二次 check）
    assert.equal(fake.calls.length, 2, 'user check must run after background finishes');
    fake.finish();
    await user;
    await tick();
    assert.equal(state.surfaceError, false, 'surface flag must reset after user check ends');
  }

  // ── 2) 用户在飞 + 后台 tick：后台跳过（返回同一 promise，不覆盖归因）──
  {
    const fake = makeFake();
    const state = createRunCheck(() => fake.checkForUpdates());

    const user = state.user();
    const bg = state.background(); // 后台 tick 撞上用户 in-flight
    assert.equal(bg, user, 'background must reuse the in-flight promise (skip)');
    assert.equal(fake.calls.length, 1, 'background tick must not start a second check');
    assert.equal(state.surfaceError, true, 'user check in flight must surface errors');

    fake.finish();
    await user;
    await tick();
    assert.equal(fake.calls.length, 1, 'background skip must not add a second check');
    assert.equal(state.surfaceError, false, 'surface flag must reset after user check ends');
  }

  // ── 3) 连续两次用户检查：串行（第二次等待第一次，再发起）──
  {
    const fake = makeFake();
    const state = createRunCheck(() => fake.checkForUpdates());

    const u1 = state.user();
    const u2 = state.user(); // 连续第二次用户检查
    assert.equal(fake.calls.length, 1, 'second user check must wait for the first');
    fake.finish();
    await tick();
    await tick();
    assert.equal(fake.calls.length, 2, 'second user check must run after the first');
    fake.finish();
    await u1;
    await u2;
    await tick();
    assert.equal(state.surfaceError, false, 'surface flag must reset after last user check');
  }

  // ── 4) surfaceError 归因时序：仅用户检查周期内为 true ──
  {
    const fake = makeFake();
    const state = createRunCheck(() => fake.checkForUpdates());

    // 后台周期内：surface 恒 false（后台噪音 error 不广播）
    const bg = state.background();
    assert.equal(state.surfaceError, false, 'background in flight → no surface');
    fake.finish();
    await bg;
    await tick();
    assert.equal(state.surfaceError, false, 'background done → still no surface');

    // 用户周期内：发起后为 true（error 事件此时到达才会广播）
    const user = state.user();
    assert.equal(state.surfaceError, true, 'user check in flight → surface');
    fake.finish();
    await user;
    await tick();
    assert.equal(state.surfaceError, false, 'user check done → surface reset');
  }

  console.log('updater-runcheck selftest: all assertions passed (state machine)');
}

void main();
