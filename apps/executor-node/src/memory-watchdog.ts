/**
 * 4-2（audit-r4）：任务进程内存看门狗——RSS 周期采样 + 超限回调。
 *
 * Node 的 child_process 没有 POSIX rlimit 等价物（executor-python 侧用
 * RLIMIT_AS 的 preexec_fn），这里用「周期性采样进程树 RSS、超限即杀」达到
 * 同一防护目标：失控/恶意任务不能把执行器宿主 OOM。
 *
 * 两个采样器：
 *   - `linuxProcTreeSampler`：读 /proc/<pid>/status 的 VmRSS，并经
 *     /proc/<pid>/task/<pid>/children 递归求和——覆盖整棵进程树（任务可能
 *     fork 孙进程，孙进程共享同一内存账本）；
 *   - `winTasklistSampler`：tasklist CSV 取直系子进程 Working Set。Windows
 *     无 /proc children 等价物，文档化为 best-effort（孙进程不在采样内）。
 *
 * 采样器可注入（`MemorySampler` 接口），单测无需真进程；进程已退出/采样
 * 异常时返回 0 / 静默跳过——看门狗不决定任务终态，只有超限才干预。
 */
import { execFile } from 'child_process';
import * as fs from 'fs';

export interface MemorySampler {
  /** 返回 pid 进程树当前 RSS 总量（字节）。进程不存在返回 0。 */
  sampleRssBytes(pid: number): Promise<number>;
}

function readProcFile(procPath: string): string | null {
  try {
    return fs.readFileSync(procPath, 'utf8');
  } catch {
    return null;
  }
}

function readVmRssKb(pid: number): number {
  const status = readProcFile(`/proc/${pid}/status`);
  if (!status) return 0;
  const m = status.match(/^VmRSS:\s*(\d+)\s*kB/im);
  return m ? parseInt(m[1], 10) : 0;
}

function readChildren(pid: number): number[] {
  const children = readProcFile(`/proc/${pid}/task/${pid}/children`);
  if (!children) return [];
  return children
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => parseInt(p, 10))
    .filter((p) => Number.isFinite(p) && p > 0);
}

/** Linux /proc 进程树 RSS 采样（含孙进程，见模块注释）。 */
export const linuxProcTreeSampler: MemorySampler = {
  async sampleRssBytes(pid: number): Promise<number> {
    let totalKb = 0;
    const stack = [pid];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      if (seen.has(cur)) continue;
      seen.add(cur);
      totalKb += readVmRssKb(cur);
      stack.push(...readChildren(cur));
    }
    return totalKb * 1024;
  },
};

/** Windows tasklist CSV 采样（直系子进程 Working Set，best-effort）。 */
export const winTasklistSampler: MemorySampler = {
  async sampleRssBytes(pid: number): Promise<number> {
    const stdout = await new Promise<string>((resolve) => {
      execFile(
        'tasklist',
        ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`],
        { timeout: 5000, windowsHide: true },
        (err, out) => {
          // 进程已退出 / 非英文 locale 等一律视为 0——看门狗静默。
          if (err) {
            resolve('');
            return;
          }
          resolve(out);
        },
      );
    });
    // tasklist /FO CSV 行形如："image.exe","1234","Console","1","123,456 K"
    // 字段顺序稳定（Image Name, PID, Session Name, Session#, Mem Usage）。
    const fields = stdout.match(/"([^"]*)"/g);
    if (!fields || fields.length < 5) return 0;
    const memField = fields[4].replace(/"/g, '');
    const kb = parseInt(memField.replace(/[^\d]/g, ''), 10);
    return (Number.isFinite(kb) ? kb : 0) * 1024;
  },
};

export interface MemoryWatchdogOptions {
  pid: number;
  limitMb: number;
  sampler: MemorySampler;
  /** 采样间隔（毫秒），默认 2000。 */
  intervalMs?: number;
  /** RSS 超过 limitMb 时回调（调用方负责杀进程树 + 终态化，须幂等）。 */
  onExceed: () => void;
}

/**
 * 启动看门狗：每 intervalMs 采样一次，RSS > limitMb 触发 onExceed。返回
 * stop 函数。采样异常（进程已退出等）静默跳过。定时器 unref：不阻止进程
 * 退出；onExceed 的幂等由调用方保证（settled 守卫），超限后应立即 stop。
 */
export function startMemoryWatchdog(opts: MemoryWatchdogOptions): () => void {
  const intervalMs = opts.intervalMs ?? 2000;
  const limitBytes = opts.limitMb * 1024 * 1024;
  const timer = setInterval(() => {
    void opts.sampler
      .sampleRssBytes(opts.pid)
      .then((rss) => {
        if (rss > limitBytes) opts.onExceed();
      })
      .catch(() => {
        // 采样失败（进程已退出/竞态）：静默，交给其它路径终态化。
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
