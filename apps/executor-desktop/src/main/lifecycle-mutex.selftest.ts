/**
 * P2-1 self-check：start/stop 生命周期在飞互斥原语（node:assert，无测试框架）。
 * lifecycle-mutex.ts 是纯模块（零依赖），这里用受控的 deferred body 逐分支
 * 驱动真实实现。Run via: npm run test:main
 *
 * 覆盖（对齐 lifecycle-mutex.ts 头注的语义）：
 *  - 同向并发：并发 start×2 → body 只跑一次（executor-process 场景 = 只
 *    spawn 一次），两个调用方共享同一个 Promise 实例；
 *  - 反向并发：启动探测窗口期（start 在飞、proc 尚为 null）来的 stop 不被
 *    吞——等 start 落定后 stop 必须真的执行；
 *  - stop 在飞时来的 start 排队（不撞上正在退出的进程）；
 *  - body 抛错：错误透传给所有共享调用方、在飞标志当次释放（不 wedge）；
 *  - 落定后可以再次运行（互斥是"在飞"语义，不是一次性闸）。
 */
import * as assert from 'node:assert';
import { createLifecycleMutex } from './lifecycle-mutex';

/** 手动放行的 deferred（模拟 start() 探测窗口的长 await）。 */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 排空全部微任务与已到期的宏任务（跨实现的确定性时序）。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function main(): Promise<void> {
  // ── 1. 并发 start×2：body 只跑一次，共享同一 Promise ─────────────────
  {
    const mutex = createLifecycleMutex();
    let spawnCount = 0;
    const gate = deferred();
    const body = async (): Promise<void> => {
      spawnCount++;
      await gate.promise;
    };
    const p1 = mutex.run('start', body);
    const p2 = mutex.run('start', body);
    assert.strictEqual(p1, p2, '同向并发必须共享同一个在飞 Promise');
    assert.strictEqual(spawnCount, 1, '快速双击 start 绝不能双 spawn（body 同步启动一次）');
    assert.strictEqual(mutex.inFlight('start'), true);
    gate.resolve();
    await Promise.all([p1, p2]);
    assert.strictEqual(spawnCount, 1);
    assert.strictEqual(mutex.inFlight('start'), false, '落定后在飞标志必须释放');
  }

  // ── 2. 探测窗口期 stop 不被吞：等 start 落定后必须真的执行 ───────────
  {
    const mutex = createLifecycleMutex();
    const events: string[] = [];
    const startGate = deferred();
    const stopGate = deferred();
    const startPromise = mutex.run('start', async () => {
      events.push('start:probe-window'); // 相当于 start() 在等端口探测
      await startGate.promise;
      events.push('start:spawned');
    });
    // start 还在探测窗口（body 未返回）时用户点停止。
    const stopPromise = mutex.run('stop', async () => {
      events.push('stop:begins'); // 旧缺陷：!this.proc 早退分支会吞掉这次 stop
      await stopGate.promise;
      events.push('stop:done');
    });
    await tick(); // 排空微任务：stop 此刻必须仍被挡在排队位
    assert.deepStrictEqual(
      events,
      ['start:probe-window'],
      'stop 必须等 start 落定后才执行（不能与探测窗口并发、更不能被吞）',
    );
    startGate.resolve();
    await startPromise;
    await tick();
    assert.ok(events.includes('stop:begins'), 'P2-1 核心：探测窗口期的 stop 不被吞');
    assert.deepStrictEqual(
      events.slice(0, 3),
      ['start:probe-window', 'start:spawned', 'stop:begins'],
      'stop 必须紧随 start 落定（排队而非并发）',
    );
    stopGate.resolve();
    await stopPromise;
    assert.deepStrictEqual(events, ['start:probe-window', 'start:spawned', 'stop:begins', 'stop:done']);
    assert.strictEqual(mutex.inFlight('stop'), false);
  }

  // ── 3. stop 在飞时 start 排队（不撞上正在退出的进程） ────────────────
  {
    const mutex = createLifecycleMutex();
    const events: string[] = [];
    const stopGate = deferred();
    const stopPromise = mutex.run('stop', async () => {
      events.push('stop:draining');
      await stopGate.promise;
      events.push('stop:done');
    });
    const startPromise = mutex.run('start', async () => {
      events.push('start:begins');
    });
    await tick();
    assert.deepStrictEqual(events, ['stop:draining'], 'start 必须等 stop 落定');
    stopGate.resolve();
    await stopPromise;
    await startPromise;
    assert.deepStrictEqual(events, ['stop:draining', 'stop:done', 'start:begins']);
  }

  // ── 4. body 抛错：透传给所有共享调用方，标志当次释放（不 wedge） ──────
  {
    const mutex = createLifecycleMutex();
    let attempts = 0;
    const p1 = mutex.run('start', async () => {
      attempts++;
      throw new Error('port occupied');
    });
    const p2 = mutex.run('start', async () => {
      attempts++;
      throw new Error('port occupied');
    });
    await assert.rejects(p1, /port occupied/, '错误必须透传给首个调用方');
    await assert.rejects(p2, /port occupied/, '错误必须透传给共享调用方');
    assert.strictEqual(attempts, 1, '共享调用方绝不能再触发第二次 body');
    assert.strictEqual(mutex.inFlight('start'), false, '失败的在飞标志必须释放');
    // 失败后互斥可用（不是一次性闸）。
    const p3 = mutex.run('start', async () => undefined);
    await p3;
    assert.strictEqual(mutex.inFlight('start'), false);
  }

  // ── 5. 反向排队不吞对向失败：start 失败后 stop 照常执行 ──────────────
  {
    const mutex = createLifecycleMutex();
    const events: string[] = [];
    const startPromise = mutex.run('start', async () => {
      events.push('start:throws');
      throw new Error('start failed');
    });
    const stopPromise = mutex.run('stop', async () => {
      events.push('stop:runs'); // start 失败（如端口占用）不该把排队的 stop 吞掉
    });
    await assert.rejects(startPromise, /start failed/);
    await stopPromise;
    assert.deepStrictEqual(events, ['start:throws', 'stop:runs'], '对向操作失败后排队方必须照常执行');
  }

  // ── 6. 接线守卫：ExecutorProcess 的 start/stop 必须收敛到互斥层 ──────
  {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'executor-process.ts'),
      'utf-8',
    );
    assert.ok(src.includes('createLifecycleMutex()'), 'P2-1: ExecutorProcess 必须挂生命周期互斥');
    assert.ok(
      src.includes("this.lifecycleMutex.run('start'") && src.includes("this.lifecycleMutex.run('stop'"),
      'P2-1: start/stop 对外入口必须收敛到互斥层',
    );
    assert.ok(
      src.includes('private async doStart(') && src.includes('private async doStop('),
      'P2-1: 原实现体必须移入 doStart/doStop（入口只做互斥）',
    );
  }

  console.log('lifecycle-mutex selftest: all assertions passed (shared in-flight promise, cross-direction queueing, error passthrough, no-wedge, wiring anchors)');
}

main();
