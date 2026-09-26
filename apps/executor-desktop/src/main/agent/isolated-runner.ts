/**
 * P7e 前半（agent-and-deployment）：isolated-runner——Agent 直接执行任务的
 * 独立执行端点（设计文档 08 §2.4 方案 A / 09 §2.4）。
 *
 * ## 它是什么
 * `deploy-only` 档（默认）下，候选只能打包交付、执行走既有 deploy 通道；
 * `isolated-runner` 档下，host 在交付时**直接在本机执行一次候选**（作为
 * 任务运行而非验证性试跑），并把执行证据随回报交给中台——复核会话拿到的
 * 不再只是「包已上传」，还有第一方的运行结果（证据按不可信自述对待，
 * 11 §5.3 的标注纪律在中台侧落实）。
 *
 * ## 为什么是独立端点而不是复用 /execute（08 §2 的冲突）
 * manifest 劫持防护的前提是「包的 manifest 不可信」；Agent 生成的候选
 * 作者 = 执行者，信任前提正好相反。复用 /execute 就要在已加固路径上开
 * 来源分支（shared-runner 档，**故意不提供**）。本模块是**独立的执行路径**：
 *   · 入口由平台代码从循环的 entry spec 取——LLM 不可在执行时刻覆盖；
 *   · 执行纪律与试跑完全同一套（process 沙箱/解释器封闭枚举/env 白名单/
 *     路径域/树杀超时——全部复用 runTrialInSandbox，不另造执行器）；
 *   · 来源标记由平台代码打（`agent:sop`），不由 Agent 自称（ADR-022 决策 5）；
 *   · `taskExecution` 档位闸在本模块**再判一次**：deploy-only 如实拒绝，
 *     绝不静默执行——调用方漏判也有兜底（闸门在动作之前判，纪律 1）。
 *
 * ## 证据语义（如实）
 * 直接执行发生在验收通过、包已交付**之后**：它不改变交付判定——执行失败
 * 的证据如实随回报上交，由中台复核判定，不在本地悄悄重试或掩盖。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CodeExecutionMode, TaskExecutionMode } from './permission-profile';
import { runTrialInSandbox } from './trial-run';

/** 证据日志目录（工作区相对）——打包器的 EXCLUDED_PREFIXES 同步排除它。 */
export const ISOLATED_RUNS_DIR = 'isolated-runs';

/** 输出摘要上限（进回报 resultJson；完整输出在日志文件里）。 */
const OUTPUT_SUMMARY_MAX = 4 * 1024;

export interface IsolatedRunRecord {
  /** 本次指派内的运行序号（1 起）。 */
  seq: number;
  /** 来源标记——**平台代码打的**，ADR-022 决策 5。 */
  source: string;
  interpreter: string;
  entryPath: string;
  ok: boolean;
  /** 档位/形状被拒时非空——此时**未执行任何东西**。 */
  refusal: string | null;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** 输出摘要（截断）。 */
  outputSummary: string;
  /** 工作区相对的完整日志路径（stdout/stderr 全文）。 */
  logPath: string | null;
}

/** 档位闸（快捷判定在 permission-profile；此处兜底同语义）。 */
export function directTaskExecutionAllowed(p: {
  taskExecution: TaskExecutionMode;
}): boolean {
  return p.taskExecution === 'isolated-runner';
}

/**
 * 直接执行一次候选（独立执行端点）。本函数**绝不抛**——所有失败收敛为
 * 记录里的 refusal / ok=false。
 */
export async function runIsolatedTask(input: {
  workspaceRoot: string;
  /** 平台持有的入口 spec（来自循环的 entry，不是执行时刻的 LLM 输出）。 */
  entry: { interpreter: unknown; path: unknown };
  runSeq: number;
  source: string;
  codeExecution: CodeExecutionMode;
  taskExecution: TaskExecutionMode;
  timeoutMs?: number;
}): Promise<IsolatedRunRecord> {
  const t0 = Date.now();
  const record: IsolatedRunRecord = {
    seq: input.runSeq,
    source: String(input.source ?? '').slice(0, 128),
    interpreter: typeof input.entry.interpreter === 'string' ? input.entry.interpreter : String(input.entry.interpreter ?? ''),
    entryPath: typeof input.entry.path === 'string' ? input.entry.path.slice(0, 256) : String(input.entry.path ?? ''),
    ok: false,
    refusal: null,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    outputSummary: '',
    logPath: null,
  };

  // ── 档位闸（动作之前判）────────────────────────────────────────────
  if (!directTaskExecutionAllowed(input)) {
    record.refusal = `taskExecution=${input.taskExecution}：当前档位不允许直接执行任务（deploy-only 只交付包，执行走既有 deploy 通道）`;
    record.durationMs = Date.now() - t0;
    return record;
  }

  // ── 执行（与试跑同一套沙箱纪律）────────────────────────────────────
  const run = await runTrialInSandbox({
    workspaceRoot: input.workspaceRoot,
    interpreter: input.entry.interpreter,
    entryPath: input.entry.path,
    codeExecution: input.codeExecution,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  });
  record.exitCode = run.exitCode;
  record.timedOut = run.timedOut;
  record.durationMs = Date.now() - t0;
  record.ok = run.ok;

  // 完整输出落证据日志（best-effort：磁盘失败不影响记录本身）
  const logRel = `${ISOLATED_RUNS_DIR}/run-${input.runSeq}.log`;
  try {
    const logAbs = path.join(input.workspaceRoot, ISOLATED_RUNS_DIR);
    fs.mkdirSync(logAbs, { recursive: true });
    fs.writeFileSync(
      path.join(logAbs, `run-${input.runSeq}.log`),
      [
        `# isolated run seq=${input.runSeq} source=${record.source}`,
        `# interpreter=${record.interpreter} entry=${record.entryPath}`,
        `--- stdout ---`, run.stdout,
        `--- stderr ---`, run.stderr,
        `--- exit=${run.exitCode} timedOut=${run.timedOut} durationMs=${record.durationMs} ---`,
        '',
      ].join('\r\n'),
      'utf8',
    );
    record.logPath = logRel;
  } catch {
    /* 日志写失败如实留空——摘要仍在 */
  }
  const summary = [run.stdout, run.stderr].filter(Boolean).join('\n--- stderr ---\n');
  record.outputSummary = summary.length > OUTPUT_SUMMARY_MAX
    ? `${summary.slice(0, OUTPUT_SUMMARY_MAX)}\n[输出超过 ${OUTPUT_SUMMARY_MAX} 字节，已截断；全文见 ${logRel}]`
    : summary;
  if (run.refusal) {
    // 沙箱拒绝（枚举/路径/档位）——如实在证据里说明，绝不伪装成运行失败
    record.refusal = run.refusal;
    record.ok = false;
  }
  return record;
}
