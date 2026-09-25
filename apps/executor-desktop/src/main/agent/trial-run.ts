import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { CodeExecutionMode } from './permission-profile';
import { resolveWithinWorkspace } from './workspace';

/**
 * P7a 续批（agent-and-deployment）：试跑的真实执行体——process 沙箱。
 *
 * ## 它是 ADR-022 里「唯一新增的执行能力」的落地
 * loop.ts（骨架）通过 `handlers.trialRun` 依赖注入调用本模块。所有「在本机
 * 执行生成代码」的路径都必须经过这里，且这里强制四道纪律：
 *
 * 1. **档位闸**：`codeExecution=off` 直接拒绝（高合规档等于「Agent 只产出
 *    文本」）；`host` 在 P7a **如实拒绝**（未实现，绝不能静默按 sandbox 跑）。
 * 2. **解释器封闭枚举**：`python` / `python3` / `node` 三个名字。LLM 要求跑
 *    `bash -c ...` / `cmd /c ...` 之类，一律拒绝——这与 executor-node
 *    commands.ts 的「封闭枚举、绝不接受自由命令」同款纪律。
 * 3. **env 白名单**（SEC-01 精神）：子进程 env 只给最小集合（PATH/系统路径/
     编码变量），执行器 token、ADMIN_API_URL、任何凭据类变量**出不去**。
 *    并强制 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`——I18N-01 的教训
 *    （Windows 上 Python stderr 默认 GBK，中文输出必然乱码）在本模块
 *    源头掐断，不重演。
 * 4. **入口文件路径域**：entry 必须经 `resolveWithinWorkspace` 解析——
 *    绝对路径/盘符/`~`/穿越载荷在解析层就被拒。
 *
 * ## node 的特殊处理
 * desktop 主进程里 `process.execPath` 是 Electron 可执行文件。以
 * `ELECTRON_RUN_AS_NODE=1` 复用它当 node 跑（Electron 官方开关；在纯
 * node selftest 环境下该变量无效果，两条环境同一路径）。
 */

/** 单次试跑的输出上限（stdout/stderr 各自计）。超出截断并打标记。 */
export const TRIAL_OUTPUT_CAP = 64 * 1024;
/** 试跑超时钳位区间。 */
export const TRIAL_TIMEOUT_MIN_MS = 1_000;
export const TRIAL_TIMEOUT_MAX_MS = 300_000;
export const TRIAL_TIMEOUT_DEFAULT_MS = 60_000;

/** 解释器封闭枚举——LLM 的选择只能落在这三个名字里。 */
export const TRIAL_INTERPRETERS = ['python', 'python3', 'node'] as const;
export type TrialInterpreter = (typeof TRIAL_INTERPRETERS)[number];

export interface TrialRunInput {
  workspaceRoot: string;
  /** LLM 给的解释器名——**不可信**，封闭枚举校验。 */
  interpreter: unknown;
  /** LLM 给的入口文件——**不可信**，workspace 相对路径。 */
  entryPath: unknown;
  /** 额外参数（不可信：逐条字符串、条数/长度封顶）。 */
  args?: unknown;
  timeoutMs?: unknown;
  /** 生效档位（来自 permission-profile，不是 LLM 可说的）。 */
  codeExecution: CodeExecutionMode;
  /** node 解释器实际可执行文件（Electron 下为 electron.exe）。 */
  nodeExecutable?: string;
}

export interface TrialRunResult {
  ok: boolean;
  /** 拒绝原因（档位/枚举/路径被拒时非空；此时 ok=false 且未执行任何东西）。 */
  refusal?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

function asStringArgs(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return null;
  if (v.length > 16) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || item.length > 256) return null;
    out.push(item);
  }
  return out;
}

/**
 * 子进程 env 白名单。**不透传父进程 env**——执行器 token / 中台地址 /
 * 凭据类变量一律不出现在子进程里。list 之外按平台补最小系统变量
 * （Windows 的 SYSTEMROOT/COMSPEC 缺失会让 node/python 启动失败）。
 */
export function buildTrialEnv(interpreter: TrialInterpreter): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // 编码纪律（I18N-01）：Python 子进程强制 UTF-8，中文输出不再变乱码
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    // 不在源码目录留 .pyc（工作区产物只有 LLM 写的文件，可审计）
    PYTHONDONTWRITEBYTECODE: '1',
    LANG: 'C.UTF-8',
  };
  if (interpreter === 'node') {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  if (process.platform === 'win32') {
    // Windows 最小可运行集；取自父进程的**系统**变量（非凭据）
    for (const k of ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'SYSTEMDRIVE']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    // PATH 必须给（按名字找 python）；这是搜索路径不是数据通道
    if (process.env.PATH) env.PATH = process.env.PATH;
  } else {
    env.PATH = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
    env.HOME = process.env.HOME ?? '/tmp';
  }
  return env;
}

/** 沙箱试跑一次候选实现。本函数**绝不抛**——所有失败收敛为 result。 */
export async function runTrialInSandbox(input: TrialRunInput): Promise<TrialRunResult> {
  const t0 = Date.now();
  const refused = (refusal: string): TrialRunResult => ({
    ok: false, refusal, exitCode: null, timedOut: false,
    stdout: '', stderr: '', truncated: false, durationMs: Date.now() - t0,
  });

  // ── 档位闸（在一切之前——off 档连路径解析都不该做）─────────────────
  if (input.codeExecution === 'off') {
    return refused(`codeExecution=off：当前档位不允许执行任何生成的代码（Agent 仅产出文本供人工审阅）`);
  }
  if (input.codeExecution === 'host') {
    // 如实拒绝而不是降级跑：host 档在 P7a 未实现，静默按 sandbox 跑会让
    // 部署方以为开的是 host（更强的能力），实际行为却是另一套。
    return refused('codeExecution=host：该档位尚未实现（P7a 仅支持 sandbox + process 后端）');
  }
  if (input.codeExecution !== 'sandbox') {
    return refused(`未知档位 ${String(input.codeExecution)}`);
  }

  // ── 解释器封闭枚举 ──
  if (typeof input.interpreter !== 'string' || !(TRIAL_INTERPRETERS as readonly string[]).includes(input.interpreter)) {
    return refused(`interpreter 必须是 ${TRIAL_INTERPRETERS.join(' | ')}（封闭枚举，不接受其它命令）`);
  }
  const interpreter = input.interpreter as TrialInterpreter;

  // ── 参数形状 ──
  const args = asStringArgs(input.args);
  if (args === null) {
    return refused('args 必须是 ≤16 个、每个 ≤256 字符的字符串数组');
  }
  let timeoutMs = TRIAL_TIMEOUT_DEFAULT_MS;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    const n = typeof input.timeoutMs === 'number' ? input.timeoutMs : NaN;
    if (!Number.isFinite(n)) return refused('timeoutMs 必须是数字');
    timeoutMs = Math.min(Math.max(Math.round(n), TRIAL_TIMEOUT_MIN_MS), TRIAL_TIMEOUT_MAX_MS);
  }

  // ── 入口路径域 ──
  const resolved = resolveWithinWorkspace(input.workspaceRoot, input.entryPath);
  if (!resolved.ok) {
    return refused(`入口文件不可用：${resolved.error}`);
  }
  if (!fs.existsSync(resolved.path) || !fs.statSync(resolved.path).isFile()) {
    return refused(`入口文件不存在：${String(input.entryPath).slice(0, 128)}`);
  }

  const command = interpreter === 'node' ? (input.nodeExecutable ?? process.execPath) : interpreter;
  const childEnv = buildTrialEnv(interpreter);

  return new Promise<TrialRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(command, [resolved.path, ...args], {
        cwd: input.workspaceRoot,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve(refused(`spawn 失败：${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      // Windows 上 kill() 终止单进程；子进程树残留是已知残差（P7b 换
      // tree-kill 方案）。超时本身已让结果不可信，先收敛。
      try { child.kill(); } catch { /* already dead */ }
    }, timeoutMs);

    const collect = (buf: Buffer, isErr: boolean): void => {
      const cap = TRIAL_OUTPUT_CAP;
      const target = isErr ? { get: () => stderr, set: (v: string) => { stderr = v; } } : { get: () => stdout, set: (v: string) => { stdout = v; } };
      if (target.get().length >= cap) {
        truncated = true;
        return;
      }
      const piece = buf.toString('utf8');
      if (target.get().length + piece.length > cap) {
        target.set(target.get() + piece.slice(0, cap - target.get().length));
        truncated = true;
      } else {
        target.set(target.get() + piece);
      }
    };

    child.stdout?.on('data', (b: Buffer) => collect(b, false));
    child.stderr?.on('data', (b: Buffer) => collect(b, true));

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let out = stdout;
      let errOut = stderr;
      if (truncated) {
        out = `${out}\n[输出超过 ${TRIAL_OUTPUT_CAP} 字节，已截断]`;
        errOut = `${errOut}\n[输出超过 ${TRIAL_OUTPUT_CAP} 字节，已截断]`;
      }
      if (timedOut) {
        errOut = `${errOut}\n[试跑超时（${timeoutMs}ms），进程已被终止]`;
      }
      resolve({
        ok: !timedOut && exitCode === 0,
        exitCode,
        timedOut,
        stdout: out,
        stderr: errOut,
        truncated,
        durationMs: Date.now() - t0,
      });
    };

    child.on('error', (err) => {
      // 解释器不存在（python 未装）等 spawn 后错误
      stderr += `\n[进程错误] ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** 快捷：SOP acceptance 的 kind=command 项解析。argv[0] 必须在封闭枚举内。 */
export function parseAcceptanceCommand(
  command: string,
): { ok: true; interpreter: TrialInterpreter; args: string[] } | { ok: false; error: string } {
  if (typeof command !== 'string' || command.trim() === '') {
    return { ok: false, error: 'acceptance command 为空' };
  }
  // 极简分词：空白切分 + 双引号成组。SOP 的 acceptance 来自中台严格校验的
  // front-matter，但这里仍按不可信处理——绝不经 shell。
  const argv: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of command) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (cur !== '') { argv.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur !== '') argv.push(cur);
  if (argv.length === 0) return { ok: false, error: 'acceptance command 解析为空' };
  const head = argv[0];
  if (!(TRIAL_INTERPRETERS as readonly string[]).includes(head)) {
    return { ok: false, error: `acceptance command 的解释器 ${head} 不在封闭枚举内（${TRIAL_INTERPRETERS.join('|')}）` };
  }
  // 只支持 `<interpreter> <工作区脚本> [args...]` 形态：第一个参数必须是
  // 脚本相对路径。`-c` 内联码等标志形态**没有可校验的工作区锚点**——
  // 沙箱的路径域/内容审计对它全部失效，宁可判「本地无法验证」也不放行。
  if (argv.length < 2 || argv[1].startsWith('-')) {
    return { ok: false, error: 'acceptance command 必须是 <interpreter> <工作区脚本> [args...]（-c 内联码等形态不可本地验证）' };
  }
  return { ok: true, interpreter: head as TrialInterpreter, args: argv.slice(1) };
}

/** 工作区相对路径拼装（acceptance 的 run 在 workspace 里跑）。 */
export function trialEntry(workspaceRoot: string, rel: string): string {
  return path.join(workspaceRoot, rel);
}
