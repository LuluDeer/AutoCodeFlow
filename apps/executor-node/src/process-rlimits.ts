/**
 * L-3：任务子进程 POSIX 硬资源上限（对齐 executor-python sandbox.py 的
 * RLIMIT_NOFILE / RLIMIT_CPU）。
 *
 * Node 的 `child_process.spawn` **没有** preexec_fn / onPrepare / script 选项
 * （已核对 @types/node 24 的 SpawnOptions：只有 detached/shell/env/...），因此
 * fork 后、exec 前这一步无法从 V8 直接施加 rlimit。零原生依赖的等效做法是把
 * 任务命令包一层 `/bin/sh -c 'ulimit …; exec "$0" "$@"'`：
 *
 *   - `ulimit -n NOFILE` → RLIMIT_NOFILE（软/硬同值）；
 *   - `ulimit -t CPU`    → RLIMIT_CPU（CPU 秒，任务超时的第二道保险）；
 *   - `exec "$0" "$@"`  在 sh 内 exec 成任务本体——**pid 不变**（仍是 detached
 *     建立的进程组组长），killProcessTree 的 `-pid` 组杀语义不受影响；
 *   - 所有任务参数经位置参数 `$@` 透传，**没有任何任务字符串被拼进 shell
 *     脚本本身**——与 runProcess 的 argv 数组纪律一致，不引入命令注入面。
 *
 * 平台守卫：Windows 无 ulimit 原语，直接原样返回 argv 并在首个任务记一行日志
 * （开发机不崩；生产跑在 Linux 容器）。bwrap 沙箱 argv 也在本函数之外包装，
 * 本函数拿到的已是最终 argv——ulimit 沿 sh → bwrap → 任务树继承，逐层生效。
 */
import { config } from './config';
import { logger } from './logger';

export interface RlimitWrappedArgv {
  cmd: string;
  args: string[];
}

// win32 无 ulimit：每个任务都打一行会刷屏，只在首个任务子进程记一次。
let win32Noted = false;

/**
 * 在 POSIX 上把 `cmd/args` 包一层施加 ulimit 的 sh 包装；不设任何上限或在
 * win32 上原样返回。
 *
 * @param cmd        最终任务命令（bwrap 包装后）
 * @param args       最终任务参数（bwrap 包装后）
 * @param timeoutSec 任务超时秒——CPU 上限未显式配置时回落为 timeout+60s
 */
export function applyTaskRlimits(
  cmd: string,
  args: string[],
  timeoutSec: number,
): RlimitWrappedArgv {
  if (process.platform === 'win32') {
    if (!win32Noted) {
      logger.info(
        'POSIX ulimit task caps (NOFILE/CPU) are not available on win32; ' +
          'skipping them for task children (POSIX containers are the ' +
          'production path, where the caps apply)',
      );
      win32Noted = true;
    }
    return { cmd, args };
  }

  const statements: string[] = [];
  const nofile = config.taskNofileLimit;
  if (nofile > 0) {
    // 软/硬同值：超过即拒——与 python RLIMIT_NOFILE=(n,n) 同语义。
    statements.push(`ulimit -n ${nofile} >/dev/null 2>&1`);
  }

  const configuredCpu = config.taskCpuLimitSeconds;
  const cpu =
    configuredCpu > 0
      ? configuredCpu
      : timeoutSec && Number.isFinite(timeoutSec)
        ? Math.ceil(timeoutSec) + 60
        : 0;
  if (cpu > 0) {
    // ulimit -t 同时设软/硬；任务超时 kill 先到场，这里是防它失效的第二道保险。
    statements.push(`ulimit -t ${cpu} >/dev/null 2>&1`);
  }

  if (statements.length === 0) {
    return { cmd, args };
  }

  // "$0" = 'task'（占位名），任务本体经位置参数透传，绝不插值任务字符串。
  const script = `${statements.join(' && ')}; exec "$0" "$@"`;
  return { cmd: '/bin/sh', args: ['-c', script, 'task', cmd, ...args] };
}
