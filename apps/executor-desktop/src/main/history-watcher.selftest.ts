import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HistoryWatcher,
  HISTORY_WATCH_DEBOUNCE_MS,
  HISTORY_WATCH_RETRY_MS,
  metaDirFor,
} from './history-watcher';

/**
 * history-watcher.selftest：meta 目录变更哨的纯 Node 行为钉（无 electron）。
 * 8 项：debounce 合并 / 变更触发 / re-arm 换目录 / null 停表 / 目录迟建接管 /
 * 目录消失恢复 / stop 清柄 / metaDirFor 拼装。
 */

let passCount = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL - ${msg}`);
    process.exit(1);
  }
  passCount += 1;
  console.log(`  ok - ${msg}`);
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 可编程假时钟：schedule 排队、手动 flush，测 debounce/retry 逻辑不真等。 */
function fakeClock() {
  type Job = { fn: () => void; at: number; id: number };
  let now = 0;
  let nextId = 1;
  const jobs: Job[] = [];
  const api = {
    schedule: (fn: () => void, ms: number) => {
      const job: Job = { fn, at: now + ms, id: nextId++ };
      jobs.push(job);
      return job;
    },
    cancel: (h: unknown) => {
      const i = jobs.findIndex((j) => j === (h as Job));
      if (i >= 0) jobs.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      // 同刻任务按入队序执行；执行中新增的任务看到的是新 now
      for (;;) {
        jobs.sort((a, b) => a.at - b.at || a.id - b.id);
        const due = jobs.find((j) => j.at <= now);
        if (!due) break;
        jobs.splice(jobs.indexOf(due), 1);
        due.fn();
      }
    },
  };
  return api;
}

/** 全假的 watch：手动触发事件、记录 close。 */
function fakeWatchFactory() {
  const handles: Array<{ close: () => void; fire: () => void; dir: string }> = [];
  const factory = (dir: string, listener: () => void) => {
    const h = {
      dir,
      fire: () => listener(),
      close: () => {
        const i = handles.indexOf(h);
        if (i >= 0) handles.splice(i, 1);
      },
    };
    handles.push(h);
    return h;
  };
  return { factory, handles };
}

async function main(): Promise<void> {
  // ── 1. metaDirFor ──
  ok(metaDirFor(null) === null, 'metaDirFor(null) = null（未配置 workDir）');
  ok(metaDirFor('/data') === path.join('/data', 'meta'), 'metaDirFor 拼装 workDir/meta');

  // ── 2. 变更触发 + debounce 合并（假时钟 + 假 watch）──
  {
    const dir = tmpDir('acf-hw-');
    const clock = fakeClock();
    const { factory, handles } = fakeWatchFactory();
    let fired = 0;
    const w = new HistoryWatcher({
      onChange: () => { fired += 1; },
      watchImpl: factory,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
    w.start(path.join(dir, 'meta'));
    clock.advance(0); // flush tryWatch 的活性检查入队
    ok(handles.length === 1 && handles[0].dir.endsWith('meta'), 'start 后挂上 watch（目录已存在）');
    ok(!w.isActive() === false, 'isActive 观测为真');

    handles[0].fire();
    handles[0].fire();
    handles[0].fire();
    ok(fired === 0, 'debounce 窗口内回调未发');
    clock.advance(HISTORY_WATCH_DEBOUNCE_MS - 1);
    ok(fired === 0, '窗口边界前回调未发');
    clock.advance(1);
    ok(fired === 1, '三次突发合并为一次回调');

    handles[0].fire();
    clock.advance(HISTORY_WATCH_DEBOUNCE_MS);
    ok(fired === 2, '窗口结束后新事件再触发');
    w.stop();
    ok(handles.length === 0, 'stop 关闭 watch 句柄');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 3. 目录迟建：start 时不存在 → 重试循环接管 ──
  {
    const dir = tmpDir('acf-hw-late-');
    const clock = fakeClock();
    const { factory, handles } = fakeWatchFactory();
    const w = new HistoryWatcher({
      onChange: () => {},
      watchImpl: factory,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    const metaDir = path.join(dir, 'meta');
    w.start(metaDir);
    ok(handles.length === 0, '目录不存在时 watch 未挂（不抛错）');
    fs.mkdirSync(metaDir, { recursive: true });
    clock.advance(HISTORY_WATCH_RETRY_MS);
    ok(handles.length === 1, '重试循环在目录出现后接管');
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 4. 目录消失：句柄死亡 → 活性检查发现 → 重建后恢复 ──
  {
    const dir = tmpDir('acf-hw-gone-');
    const clock = fakeClock();
    const { factory, handles } = fakeWatchFactory();
    const w = new HistoryWatcher({
      onChange: () => {},
      watchImpl: factory,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    const metaDir = path.join(dir, 'meta');
    fs.mkdirSync(metaDir, { recursive: true });
    w.start(metaDir);
    clock.advance(0);
    ok(handles.length === 1, '前置：watch 已挂');
    fs.rmSync(metaDir, { recursive: true, force: true });
    clock.advance(HISTORY_WATCH_RETRY_MS); // 活性检查：目录消失 → 关旧柄 → tryWatch（目录仍无）→ 重试
    ok(handles.length === 0, '目录消失后旧句柄被活性检查回收');
    fs.mkdirSync(metaDir, { recursive: true });
    clock.advance(HISTORY_WATCH_RETRY_MS);
    ok(handles.length === 1, '目录重建后自动接管');
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 5. re-arm 换目录（workDir 配置热同步语义）──
  {
    const dirA = tmpDir('acf-hw-a-');
    const dirB = tmpDir('acf-hw-b-');
    const clock = fakeClock();
    const { factory, handles } = fakeWatchFactory();
    const w = new HistoryWatcher({
      onChange: () => {},
      watchImpl: factory,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    const metaA = path.join(dirA, 'meta');
    fs.mkdirSync(metaA, { recursive: true });
    w.start(metaA);
    clock.advance(0);
    ok(handles.length === 1, '前置：watch A');
    w.start(path.join(dirB, 'meta'));
    ok(handles.length === 0, 're-arm 关闭旧目录句柄');
    fs.mkdirSync(path.join(dirB, 'meta'), { recursive: true });
    clock.advance(HISTORY_WATCH_RETRY_MS); // re-arm 时新目录尚未建 → 走重试循环接管
    ok(handles.length === 1 && handles[0].dir.endsWith('meta'), 're-arm 后接管新目录');
    w.start(null);
    ok(handles.length === 0, 'start(null) = 未配置，停表');
    w.stop();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }

  // ── 6. onChange 抛错不杀 watcher ──
  {
    const dir = tmpDir('acf-hw-throw-');
    const clock = fakeClock();
    const { factory, handles } = fakeWatchFactory();
    let calls = 0;
    const origLog = console.error;
    console.error = () => {};
    const w = new HistoryWatcher({
      onChange: () => {
        calls += 1;
        throw new Error('boom');
      },
      watchImpl: factory,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });
    w.start(path.join(dir, 'meta'));
    clock.advance(0);
    handles[0].fire();
    clock.advance(HISTORY_WATCH_DEBOUNCE_MS);
    handles[0].fire();
    clock.advance(HISTORY_WATCH_DEBOUNCE_MS);
    console.error = origLog;
    ok(calls === 2, 'onChange 抛错后后续事件照常派发');
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 7. 真实 fs.watch 冒烟（真定时器，端到端 sanity）──
  // 注意必须**异步**等：Atomics.wait 会阻塞事件循环，fs.watch 回调永远没机会跑。
  {
    const dir = tmpDir('acf-hw-real-');
    const metaDir = path.join(dir, 'meta');
    fs.mkdirSync(metaDir, { recursive: true });
    let fired = 0;
    const w = new HistoryWatcher({ onChange: () => { fired += 1; } });
    w.start(metaDir);
    fs.writeFileSync(path.join(metaDir, 'a.json'), JSON.stringify({ startTime: 1 }));
    const deadline = Date.now() + (HISTORY_WATCH_DEBOUNCE_MS + HISTORY_WATCH_RETRY_MS) * 4;
    while (fired === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    ok(fired >= 1, '真实 fs.watch 冒烟：meta 写入触发回调');
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${passCount} assertions passed`);
}

main();
