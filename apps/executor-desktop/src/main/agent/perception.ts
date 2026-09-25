import * as os from 'os';
import { execFile } from 'child_process';

/**
 * P7a（agent-and-deployment）：环境感知层（设计文档 07 §4 感知层）。
 *
 * 产出 `EnvironmentReport`：执行器 Agent 据此决定实现路径（有 Python 吗？
 * 有 Node 吗？内存多少？），中台 Agent 据此做 SOP 可行性预检（10 §建议2——
 * 「SOP 需要 browser → 该机器没有」应在指派前发现，而不是派过去卡住）。
 *
 * ## 探测纪律
 * 探测本身也是「在本机执行命令」——全部走 `execFile`（不经 shell）+
 * 超时 + 失败即记 "unavailable"（探测绝不抛错：探测失败本身就是环境事实）。
 * 只读探测，**绝不安装、绝不修改**——那是试跑阶段的受控动作。
 */

export interface RuntimeProbe {
  name: string;
  available: boolean;
  version: string | null;
}

export interface EnvironmentReport {
  probedAt: string;
  platform: string;
  platformRelease: string;
  arch: string;
  hostname: string;
  cpuCount: number;
  totalMemoryMB: number;
  freeMemoryMB: number;
  runtimes: RuntimeProbe[];
  /** 能力域自述（07 §7 感知层；P7a 只有 filesystem/http —— browser/gui 留 P7b/c）。 */
  capabilities: string[];
}

function probeCommand(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => {
          if (err) {
            // 非零/超时/不存在 → 不可用。版本从 stdout 或 stderr 都可能出
            // （python -V 走 stderr 的老版本行为），统一拿合并流的一行。
            const msg = (err as { stdout?: string; message?: string }).stdout || err.message || '';
            const line = msg.split(/\r?\n/).find((l) => /\d+\.\d+/.test(l));
            resolve(line ? line.trim().slice(0, 80) : null);
            return;
          }
          const line = String(stdout).split(/\r?\n/).find((l) => /\d+\.\d+/.test(l));
          resolve(line ? line.trim().slice(0, 80) : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/** 探测一个运行时（command 存在且能报版本才算 available）。 */
async function probeRuntime(name: string, command: string, args: string[]): Promise<RuntimeProbe> {
  const version = await probeCommand(command, args, 5000);
  return { name, available: version !== null, version };
}

/** 采集环境报告（P7a：OS/资源/运行时；无网络探测——避免探测阶段就碰外联）。 */
export async function collectEnvironmentReport(): Promise<EnvironmentReport> {
  const [python, python3, node] = await Promise.all([
    probeRuntime('python', 'python', ['--version']),
    probeRuntime('python3', 'python3', ['--version']),
    probeRuntime('node', process.execPath, ['--version']),
  ]);

  return {
    probedAt: new Date().toISOString(),
    platform: os.platform(),
    platformRelease: os.release(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpuCount: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
    runtimes: [python, python3, node],
    capabilities: ['filesystem', 'http'],
  };
}
