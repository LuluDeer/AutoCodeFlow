/**
 * 诊断探针：uv PATH 探测（异步 + 缓存）与工作目录可写性判定（**不落盘**）。
 *
 * 为什么单独成模块、而不是留在 ipc-handlers.ts 里：
 * ipc-handlers.ts 顶层 import electron，裸 node 加载即崩，selftest 对它只能做
 * 「源码钉」而无法驱动真行为。而这两条探针恰好是**最容易悄悄退回旧坏形态**的
 * 两处（见下），必须能被行为断言直接覆盖，所以抽成零 electron 依赖的纯 Node
 * 模块，由 selftest 直接 import。
 *
 * 两条探针各自对应的故障形态：
 *  1. uv PATH 探测曾经是同步 spawn（超时上限 5s）：设置页/健康面板挂载时调用，
 *     主线程被冻住期间心跳、托盘、全部 IPC、executor 子进程 stdout 解析全停。
 *  2. 工作目录可写性曾经靠「往用户 workDir 里写一个临时文件再删」判定：面板是
 *     纯展示界面，每次刷新都在用户工作目录产生一次写事件（同步盘/网盘被触发
 *     上传、审计目录留痕），unlink 失败还会留垃圾——与「纯展示、不新增采集」
 *     的设计声明相反。
 */
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

/** uv PATH 探测结果的缓存时长：设置页与健康面板都会触发，窗口内复用同一次实跑。 */
export const UV_PATH_PROBE_TTL_MS = 60_000;

/** 单次 `uv --version` 的超时（沿用旧同步实现的 5s 上限，不放松也不收紧）。 */
export const UV_PATH_PROBE_TIMEOUT_MS = 5_000;

export interface UvPathProbeDeps {
  /**
   * 实跑 `uv --version` 的注入面：返回 true 表示解析到 uv。
   * 缺省走 execFile；**任何失败（超时/ENOENT/非 0 退出）一律 resolve(false)，
   * 不抛**——"没探测到"是正常结论，不是异常（与 classifyUvResolution 的语义一致）。
   */
  runUvVersion?: (timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  ttlMs?: number;
}

export interface UvPathProbe {
  /** 取探测结果（可能命中缓存/合流到进行中的探测）。永不 reject。 */
  available(): Promise<boolean>;
  /** 真实探测次数（缓存命中与并发合流都不增加）——供自检断言不重复 spawn。 */
  probeCount(): number;
  /** 丢弃缓存（配置里改了 uv 相关项后立刻重新探测时用）。 */
  invalidate(): void;
}

/**
 * 单次 `uv --version` 探测。
 *
 * 用 execFile 而非 spawn/shell：参数是常量数组、不走 shell（无引号/注入面），
 * 语义与旧的同步 spawnSync 调用（`uv --version`）一致；差别只在于它是**异步**
 * 的——事件循环在等待子进程期间继续转，心跳/托盘/IPC 不受影响。
 * windowsHide：常驻托盘进程后台探测不应弹控制台黑框。
 */
function probeUvVersionOnce(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(
        'uv',
        ['--version'],
        { timeout: timeoutMs, windowsHide: true },
        (err) => resolve(!err),
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * 建一个带 TTL 缓存的 uv PATH 探针。
 *
 * 为什么要缓存：这条探测只在「配置/自带/环境变量都无法静态确认」的分支被调用，
 * 但设置页与健康面板都会在挂载时各打一次；同一秒内 spawn 两次 uv 纯属浪费。
 * 缓存的是**结论**（有没有 uv），不是 Promise：失败也会被缓存 60s，避免
 * "uv 不存在"的机器每次刷新面板都再 execFile 一次 ENOENT。
 */
export function createUvPathProbe(deps: UvPathProbeDeps = {}): UvPathProbe {
  const run = deps.runUvVersion ?? probeUvVersionOnce;
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? UV_PATH_PROBE_TTL_MS;
  let cached: { value: boolean; at: number } | null = null;
  let inFlight: Promise<boolean> | null = null;
  let count = 0;
  const store = (value: boolean): boolean => {
    cached = { value, at: now() };
    inFlight = null;
    return value;
  };
  return {
    async available() {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      // 并发合流：设置页与健康面板可能同时挂载，共享同一次探测。
      if (inFlight) return inFlight;
      count += 1;
      inFlight = run(UV_PATH_PROBE_TIMEOUT_MS).then(store, () => store(false));
      return inFlight;
    },
    probeCount: () => count,
    invalidate: () => {
      cached = null;
    },
  };
}

export interface WorkDirWritableResult {
  writable: boolean;
  /** 不可写的原因（Node 的 err.message，如 EACCES / ENOENT）——不可写必须给出为什么。 */
  probeError?: string;
}

export interface WorkDirProbeDeps {
  stat?: (dir: string) => Promise<{ isDirectory(): boolean }>;
  access?: (dir: string, mode: number) => Promise<void>;
}

/**
 * 工作目录可写性判定：**不写任何文件**。
 *
 * 取舍（相对旧实现的试写临时文件）：
 *  · 旧实现写 `.acf-diag-<pid>-<ts>.tmp` 再 unlink。它确实能覆盖 Windows ACL
 *    拒绝这类 access 查不出的形态，但代价是每次 panel 刷新都往用户 workDir
 *    落一次写事件（同步盘触发上传、审计目录留痕、unlink 失败留垃圾）。面板是
 *    纯展示面，"为了看一眼能不能写而真的去写一次"本身就是它不该有的副作用。
 *  · 因此改为 access(W_OK)：只查权限不落盘。已知代价是 Windows 上只查只读
 *    属性、查不出 ACL 级别的拒绝——这种机器面板会显示"可写"而执行器真写时
 *    失败。这个方向的误报是**安全侧**的：执行器写失败有结构化报错兜底，而
 *    面板既不参与准入判断也不影响任务执行，误报"可写"远轻于在用户目录留痕。
 *  · 另外必须显式判 isDirectory：旧实现写 `dir/.acf-diag-*.tmp` 在 dir 是普通
 *    文件时必然 ENOTDIR（→不可写），而 access(W_OK) 对一个可写的普通文件会
 *    成功——不拦下就会把"配错成文件路径"粉饰成"可写"。
 */
export async function probeWorkDirWritable(
  dir: string,
  deps: WorkDirProbeDeps = {},
): Promise<WorkDirWritableResult> {
  const stat = deps.stat ?? ((p: string) => fs.promises.stat(p));
  const access = deps.access ?? ((p: string, mode: number) => fs.promises.access(p, mode));
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(dir)).isDirectory();
  } catch (err: any) {
    return { writable: false, probeError: err?.message ?? String(err) };
  }
  if (!isDirectory) {
    return { writable: false, probeError: 'workDir 不是目录（执行器无法在其中创建任务目录）' };
  }
  try {
    await access(dir, fs.constants.W_OK);
    return { writable: true };
  } catch (err: any) {
    return { writable: false, probeError: err?.message ?? String(err) };
  }
}
