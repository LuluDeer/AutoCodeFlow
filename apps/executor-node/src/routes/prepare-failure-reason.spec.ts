/**
 * BUG-10: prepare 失败分类细化——git 拉取 / 依赖安装 / 运行时缺失独立分类。
 */
import { prepareFailureReason } from './execute';

describe('prepareFailureReason (BUG-10 refinement)', () => {
  it('classifies git clone/fetch/checkout failures as git_fetch_failed', () => {
    expect(prepareFailureReason('git clone failed: exit 128')).toBe('git_fetch_failed');
    expect(prepareFailureReason('git fetch failed after 60s')).toBe('git_fetch_failed');
    expect(prepareFailureReason("git checkout failed for ref 'main'")).toBe('git_fetch_failed');
    expect(prepareFailureReason("Command '['git', 'clone', '--bare']' returned non-zero exit status 128")).toBe(
      'git_fetch_failed',
    );
  });

  it('classifies dependency installation failures as dependency_install_failed', () => {
    expect(prepareFailureReason('npm install failed: ERESOLVE')).toBe('dependency_install_failed');
    expect(prepareFailureReason('uv pip install failed: no matching distribution')).toBe(
      'dependency_install_failed',
    );
    expect(prepareFailureReason('Dependency installation failed (timeout)')).toBe(
      'dependency_install_failed',
    );
  });

  it('classifies missing runtimes/executables as runtime_missing', () => {
    expect(prepareFailureReason('spawn python3 ENOENT')).toBe('runtime_missing');
    expect(prepareFailureReason("spawn uv ENOENT: No such file or directory")).toBe('runtime_missing');
    expect(prepareFailureReason('runtime not supported on this executor')).toBe('runtime_missing');
  });

  it('keeps package-name validation in package_fetch_failed and unknown as the fallback', () => {
    expect(prepareFailureReason('Invalid npm package name')).toBe('package_fetch_failed');
    expect(prepareFailureReason('manifest merge blew up')).toBe('unknown');
  });

  it('orders rules: git-specific wins over the generic package bucket', () => {
    expect(prepareFailureReason('git clone failed then npm install failed too')).toBe('git_fetch_failed');
  });
});

/**
 * LANG-ZH-01 缺口（本轮审计）：**任务超时**的结构化分类。
 *
 * 此前 node 侧没有任何 timeout 规则——`runProcess` 的超时拒绝抛
 * `任务执行超时（${n}s）`，经 `withClassifiedFailureReason` 落到 unknown →
 * **不设** failureReason → admin 按 /timeout|超时/ 文本兜底。执行器是唯一知道
 * 自己有无挂超时定时器的一方（timeout=0 = 不限时），结构化上报更诚实，且不
 * 依赖用户文案里恰好还留着"超时"二字（文案一改，分类静默失效，timeout 的
 * 可重试语义随之后移）。
 */
describe('prepareFailureReason — timeout（本轮审计新增）', () => {
  it('classifies the executor\'s own task-timeout message (zh + en)', () => {
    expect(prepareFailureReason('任务执行超时（600s）')).toBe('timeout');
    expect(prepareFailureReason('execution timed out after 600s')).toBe('timeout');
  });

  it('does NOT steal stage-budget timeouts (they have more precise reasons)', () => {
    // `uv venv timed out` = 依赖装不上（环境/私有源/网络），不是"任务跑太久"。
    // 用户若按 timeout 处置（调大任务超时）会完全跑偏。
    expect(prepareFailureReason('uv venv timed out after 600s (uv process killed)')).toBe(
      'dependency_install_failed',
    );
    expect(prepareFailureReason('Dependency installation failed (timeout)')).toBe(
      'dependency_install_failed',
    );
    expect(prepareFailureReason('git fetch timed out after 60s')).toBe('git_fetch_failed');
  });
});

/**
 * 双端一致性补口（本轮审计）：`uv venv timed out` 与 `不支持的 runtime`。
 *
 * 两者此前在 node 侧落 unknown，而 python `_refine_failure_reason` 对同一份
 * 文本给出 dependency_install_failed / runtime_missing——同一失败在两个执行器
 * 上分因不同，admin 的统计与重试白名单随之漂移。
 */
describe('prepareFailureReason — 与 python 分类器的双端对齐（本轮审计）', () => {
  it('classifies uv venv stage timeouts as dependency_install_failed (python parity)', () => {
    expect(prepareFailureReason('uv venv timed out after 600s (uv process killed)')).toBe(
      'dependency_install_failed',
    );
    expect(prepareFailureReason('uv venv 超时（120s）')).toBe('dependency_install_failed');
  });

  it('classifies an unsupported runtime as runtime_missing (python parity)', () => {
    // run_task/prepareExecution 的 runtime 分派兜底，两侧文案逐字同形。
    expect(prepareFailureReason('不支持的 runtime：ruby')).toBe('runtime_missing');
    expect(prepareFailureReason('unsupported runtime: ruby')).toBe('runtime_missing');
  });

  it('classifies the executor-shutdown message as executor_restart', () => {
    // 复用既有 executorReportable 取值（protocol.json：adminInternalOnly 仅
    // stale_recovered / application_missing / never_dispatched），**不新增枚举**。
    // admin 标签「执行器重启」+ runbook「瞬时中断，调度 sweep 已自动重新入队」
    // 精确匹配本场景；此前落 unknown，用户只能看到「未知原因」。
    expect(prepareFailureReason('执行器正在停机，该执行尚未开始')).toBe('executor_restart');
    expect(
      prepareFailureReason('Executor is shutting down before this execution started'),
    ).toBe('executor_restart');
  });
});

/**
 * WS5（python_task_upload_and_multiversion, CONTRACT.md §2.5 / §3.3-5）：
 * 解释器无法获取的独立分因。
 *
 * 这个分类的**排序**是本次改造最容易写错的地方：既有三条规则（git /
 * dependency / runtime_missing）的正则都很宽，而 uv 的真实报错文本会同时命中
 * 其中两条。下面的正向用例钉住"必须归到 interpreter_unavailable"，反向用例
 * 钉住"不许抢走既有分类"。
 */
describe('prepareFailureReason — interpreter_unavailable (WS5)', () => {
  it('classifies uv\'s exact "No interpreter found" text', () => {
    expect(
      prepareFailureReason(
        'uv venv failed: error: No interpreter found for Python 3.7 in managed installations, search path, or registry',
      ),
    ).toBe('interpreter_unavailable');
  });

  it('classifies uv\'s exact "No download found" text (3.7 is not downloadable)', () => {
    expect(
      prepareFailureReason('No download found for request: cpython-3.7-windows-x86_64-none'),
    ).toBe('interpreter_unavailable');
  });

  it('classifies uv\'s UV_PYTHON_DOWNLOADS=manual hint text', () => {
    // 我们刻意给 uv 子进程设了 UV_PYTHON_DOWNLOADS=manual（D8 加固），
    // 因此这句提示会真实出现在失败里，是极强的正向信号。
    expect(
      prepareFailureReason(
        "error: Python downloads are set to 'manual'. Use `uv python install` to install a Python version.",
      ),
    ).toBe('interpreter_unavailable');
  });

  it('classifies our own InterpreterUnavailableError message shape', () => {
    expect(
      prepareFailureReason(
        'interpreter 3.7 unavailable (not_downloadable): uv cannot download Python 3.7 online',
      ),
    ).toBe('interpreter_unavailable');
  });

  it('classifies the Chinese留痕 message emitted by execute.ts', () => {
    expect(
      prepareFailureReason('解释器 3.7 无法获取（not_downloadable：uv cannot download）；已缓存: 3.12.13'),
    ).toBe('interpreter_unavailable');
  });

  it('does NOT steal existing classifications (the ordering trap)', () => {
    // 关键反向用例：这些必须保持原分类，否则运维会被指向错误的补救动作。
    expect(prepareFailureReason('npm install failed: 404 Not Found')).toBe(
      'dependency_install_failed',
    );
    expect(prepareFailureReason('uv pip install failed: no matching distribution')).toBe(
      'dependency_install_failed',
    );
    expect(prepareFailureReason('spawn node ENOENT')).toBe('runtime_missing');
    expect(prepareFailureReason('spawn uv ENOENT: No such file or directory')).toBe(
      'runtime_missing',
    );
    expect(prepareFailureReason('git clone failed: exit 128')).toBe('git_fetch_failed');
    expect(prepareFailureReason('Invalid npm package name: -e')).toBe('package_fetch_failed');
  });

  it('wins over a dependency-looking suffix in the same message', () => {
    // uv venv 失败时我们拼的是 `uv venv failed: <uv 原文>`，而 uv 原文可能
    // 顺带提到 install —— 解释器规则在前才能正确归类。
    expect(
      prepareFailureReason(
        'uv venv failed: error: No interpreter found for Python 3.9; use `uv python install 3.9`',
      ),
    ).toBe('interpreter_unavailable');
  });

  it('does not fire on unrelated messages that merely mention Python', () => {
    expect(prepareFailureReason('Python script exited with code 1')).toBe('unknown');
    expect(prepareFailureReason('Traceback: ModuleNotFoundError: No module named requests')).toBe(
      'unknown',
    );
  });
});

/**
 * P2（双端一致性）：sandbox_unavailable 分因。
 *
 * python `_refine_failure_reason`（routers/execute.py，SEC-NEW F-1）对
 * `task_sandbox|sandbox|bwrap` 文本归 sandbox_unavailable；node 的
 * buildTaskSandboxArgv（TASK_SANDBOX=bwrap fail-closed）抛的是同类文本，
 * 但本分类器此前没有这条规则——同一份失败在两个执行器上分因不同。
 * 用例文本取自两侧 fail-closed 报错的**真实原文**。
 */
describe('prepareFailureReason — sandbox_unavailable (P2 parity)', () => {
  it("classifies node's own fail-closed error texts verbatim", () => {
    expect(
      prepareFailureReason(
        'TASK_SANDBOX=bwrap is configured but the bwrap binary is not on PATH; ' +
          'install bubblewrap or unset TASK_SANDBOX (fail-closed, no sandbox downgrade)',
      ),
    ).toBe('sandbox_unavailable');
    expect(
      prepareFailureReason(
        'TASK_SANDBOX=bwrap is not supported on Windows; unset TASK_SANDBOX to run tasks unsandboxed',
      ),
    ).toBe('sandbox_unavailable');
  });

  it("classifies python's SandboxUnavailable message shapes the same way", () => {
    // 同一失败换到 python 执行器会归 sandbox_unavailable（sandbox.py
    // build_sandbox_cmd 原文）——node 分类必须给出同一结论。
    expect(
      prepareFailureReason(
        'TASK_SANDBOX=bwrap is not supported on Windows; unset TASK_SANDBOX ' +
          'or run the executor on Linux with bubblewrap installed',
      ),
    ).toBe('sandbox_unavailable');
    expect(
      prepareFailureReason(
        'TASK_SANDBOX=bwrap is configured but the bwrap binary is not on PATH; ' +
          'install bubblewrap (apt install bubblewrap / apk add bubblewrap) or ' +
          'unset TASK_SANDBOX — refusing to run the task unsandboxed',
      ),
    ).toBe('sandbox_unavailable');
  });

  it('does not steal earlier classifications that merely mention the word', () => {
    expect(prepareFailureReason('git clone failed: sandbox image outdated')).toBe(
      'git_fetch_failed',
    );
    expect(
      prepareFailureReason(
        'uv venv failed: error: No interpreter found for Python 3.7; bwrap also missing',
      ),
    ).toBe('interpreter_unavailable');
  });
});
