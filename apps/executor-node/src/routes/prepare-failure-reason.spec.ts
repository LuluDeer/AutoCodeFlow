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
