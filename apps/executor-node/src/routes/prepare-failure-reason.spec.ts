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
