"""FR-15/FR-16 版本化 venv（python_task_multiversion, WS4）。

覆盖：
  * `_derive_task_key` 无版本逐字节不变 / 有版本追加 `-X.Y`（D6）
  * `ensure_venv` 无版本 argv 与改造前**逐字节一致**（兼容红线 §4.1 / AC-10a）
  * 有版本走 `--python <池内绝对路径>`（绝不传裸版本号 → D8 不触发隐式下载）
  * uv 环境带 `UV_PYTHON_DOWNLOADS=manual`（lead 实测的硬保证）
  * 畸形版本在任何 subprocess 之前被拒（NFR-03）
  * venv 复用（健康 venv 不产生 uv 调用）/ 陈旧 venv 重建 / 超时回滚
"""
import asyncio
import sys

import pytest

from routers import execute as execute_module
from routers.execute import ExecuteRequest


# ---------------------------------------------------------------------------
# _derive_task_key：目录键 / 锁键 / TTL live 快照的单一来源
# ---------------------------------------------------------------------------

def _req(task):
    return ExecuteRequest(executionId='exec-42', task=task)


def test_derive_task_key_without_version_is_byte_identical():
    """兼容红线 §4.1 / AC-10a：无声明版本 → 逐字节等于旧实现。"""
    assert execute_module._derive_task_key(_req({'id': 'task-a'})) == 'task-a'
    # 旧实现：str(task.get('id') or executionId)
    assert execute_module._derive_task_key(_req({'id': ''})) == 'exec-42'
    assert execute_module._derive_task_key(_req({'id': None})) == 'exec-42'
    assert execute_module._derive_task_key(_req({})) == 'exec-42'
    assert execute_module._derive_task_key(_req({'id': 7})) == '7'


def test_derive_task_key_with_version_appends_minor_signature():
    """D6：`<task_id>` → `<task_id>-3.7`。"""
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtimeVersion': '3.7'})) == 'task-a-3.7'
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtimeVersion': '3.13'})) == 'task-a-3.13'
    # 空串 / None / 纯空白 = 未声明 → 不加后缀
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtimeVersion': ''})) == 'task-a'
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtimeVersion': None})) == 'task-a'
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtimeVersion': '   '})) == 'task-a'


@pytest.mark.parametrize('malformed', [
    '3',            # 缺次版本号
    '3.7.9',        # 带补丁号（D1 明确不允许）
    'v3.7',
    '../etc',
    '3.7/../../x',
    '--index-url',
    '3.7; rm -rf /',
])
def test_derive_task_key_never_puts_malformed_version_into_the_path(malformed):
    """NFR-03：畸形版本**绝不**以任何形式进入目录名。

    校验在 run_task 里显式拒绝；这里断言键派生本身也不会被注入。"""
    key = execute_module._derive_task_key(_req({'id': 'task-a', 'runtimeVersion': malformed}))
    assert key == 'task-a'
    assert '/' not in key and '\\' not in key and '..' not in key


def test_derive_task_key_empty_id_with_version_falls_back_to_execution_id():
    assert execute_module._derive_task_key(
        _req({'id': '', 'runtimeVersion': '3.9'})) == 'exec-42-3.9'


def test_derive_task_key_honours_the_snake_case_version_alias():
    """两个别名必须同读（executor-node 的 venvDirName 同款）。

    判据来源：run_task 读 `runtimeVersion ?? runtime_version`（两侧一致），
    于是 `{"runtime_version":"3.11"}` **确实**按 3.11 建 venv。若键派生只读
    驼峰，venv 会落在 `.venvs/<id>` —— 一个随后**不声明版本**的同任务会命中
    并复用它（`_venv_reuse_problem` 只在声明版本时校验版本），于是静默跑在
    3.11 上（D14 明令禁止），且同一载荷两侧目录名不同。

    反证：把 `_derive_task_key` 改回只读 `runtimeVersion`，本例立即转红。
    """
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtime_version': '3.11'})) == 'task-a-3.11'
    # 驼峰优先于 snake_case（与 run_task 的读取次序一致）。
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtimeVersion': '3.10',
              'runtime_version': '3.11'})) == 'task-a-3.10'
    # 别名是**畸形**值时同样不加后缀（NFR-03，与驼峰同判）。
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtime_version': '3.7.9'})) == 'task-a'
    # 驼峰显式 None 时回落到别名（run_task 同款 `is None` 判空）。
    assert execute_module._derive_task_key(
        _req({'id': 'task-a', 'runtimeVersion': None,
              'runtime_version': '3.9'})) == 'task-a-3.9'


def test_task_key_is_the_single_source_for_lock_venv_and_protection(monkeypatch, tmp_path):
    """三方同源（DESIGN §1.2.2）：锁键 == live 快照 task_id == .venvs 目录名。"""
    from unittest.mock import AsyncMock

    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', _ok_client())
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')

    lock_keys = []
    real_get_lock = execute_module._get_task_lock

    def spy_get_lock(task_id):
        lock_keys.append(task_id)
        return real_get_lock(task_id)

    monkeypatch.setattr(execute_module, '_get_task_lock', spy_get_lock)

    venv_dirs = []

    async def fake_ensure_venv(venv_dir, requirements, *, python_version=None):
        venv_dirs.append((venv_dir, python_version))
        raise RuntimeError('stop here: key resolution verified')

    monkeypatch.setattr(execute_module, 'ensure_venv', fake_ensure_venv)

    entry = execute_module.register_live_execution('exec-ver')
    assert entry is not None
    asyncio.run(execute_module._run_and_callback(
        ExecuteRequest(executionId='exec-ver',
                       task={'id': 'task-ver', 'runtime': 'python',
                             'runtimeVersion': '3.7',
                             'requirements': ['some-pkg']})))

    assert lock_keys == ['task-ver-3.7']
    assert entry.task_id == 'task-ver-3.7'
    assert venv_dirs == [(tmp_path / '.venvs' / 'task-ver-3.7', '3.7')]


# ---------------------------------------------------------------------------
# ensure_venv：argv 契约
# ---------------------------------------------------------------------------

class _FakeUvProc:
    def __init__(self, venv_dir=None, returncode=0, output=b'', hang=False):
        self.venv_dir = venv_dir
        self.returncode = returncode
        self._output = output
        self._hang = hang
        self.killed = False

    async def communicate(self):
        if self.venv_dir is not None:
            # simulate uv creating a half-built venv before (possibly) hanging
            self.venv_dir.mkdir(parents=True, exist_ok=True)
        if self._hang:
            await asyncio.sleep(999)
        return (self._output, b'')

    def kill(self):
        self.killed = True

    async def wait(self):
        return 0


def _capture_uv(monkeypatch, proc=None):
    calls = []

    async def fake_exec(*args, **kwargs):
        calls.append((args, kwargs))
        return proc if proc is not None else _FakeUvProc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    return calls


def test_ensure_venv_no_version_argv_is_byte_identical_to_legacy(monkeypatch, tmp_path):
    """兼容红线 §4.1 / AC-10a：无版本 argv 与改造前**逐字节一致**。

    改造前：`[UV_BIN, 'venv', '--no-project', str(venv_dir)]`。"""
    calls = _capture_uv(monkeypatch)
    venv_dir = tmp_path / '.venvs' / 'task-env'

    asyncio.run(execute_module.ensure_venv(venv_dir, []))

    assert len(calls) == 1
    argv = list(calls[0][0])
    assert argv == [execute_module.UV_BIN, 'venv', '--no-project', str(venv_dir)]


def test_ensure_venv_no_version_never_resolves_an_interpreter(monkeypatch, tmp_path):
    """无版本 → 完全不碰解释器池（存量路径零新增依赖）。"""
    _capture_uv(monkeypatch)
    called = []

    async def boom(*a, **k):
        called.append((a, k))
        raise AssertionError('no interpreter resolution for the legacy path')

    monkeypatch.setattr(execute_module, '_ensure_interpreter', boom)

    asyncio.run(execute_module.ensure_venv(tmp_path / '.venvs' / 'legacy', []))

    assert called == []


def test_ensure_venv_versioned_passes_absolute_pool_path_not_bare_version(monkeypatch, tmp_path):
    """D8/FR-15：`--python` 必须是**池内绝对路径**，绝不是裸版本号。

    裸版本号会让 uv 走"缺则隐式下载"的语义，绕过 D13 的全局单下载队列。"""
    pool_python = tmp_path / 'pool' / 'cpython-3.7.9-windows-x86_64-none' / 'python.exe'
    pool_python.parent.mkdir(parents=True)
    pool_python.write_bytes(b'')

    resolved = []

    async def fake_ensure_interpreter(version, timeout):
        resolved.append((version, timeout))
        return pool_python

    monkeypatch.setattr(execute_module, '_ensure_interpreter', fake_ensure_interpreter)
    calls = _capture_uv(monkeypatch)
    venv_dir = tmp_path / '.venvs' / 'task-env-3.7'

    asyncio.run(execute_module.ensure_venv(venv_dir, [], python_version='3.7'))

    assert resolved and resolved[0][0] == '3.7'
    argv = list(calls[0][0])
    assert argv[0] == execute_module.UV_BIN
    assert argv[1] == 'venv'
    assert argv[2] == '--python'
    assert argv[3] == str(pool_python)
    assert argv[3] != '3.7', 'must never pass the bare version to uv'
    assert argv[4:] == ['--no-project', str(venv_dir)]


def test_ensure_venv_uv_env_disables_implicit_python_downloads(monkeypatch, tmp_path):
    """lead 实测硬化：`UV_PYTHON_DOWNLOADS=manual` 让 uv 自身拒绝在 venv 阶段下载。

    这是 D8（"venv 阶段绝不下载"）的第二道保障：即便本文件的路径解析出 bug，
    uv 也会直接拒绝而不是偷偷下载。"""
    calls = _capture_uv(monkeypatch)

    asyncio.run(execute_module.ensure_venv(tmp_path / '.venvs' / 'task-env', []))

    env = calls[0][1]['env']
    assert env['UV_PYTHON_DOWNLOADS'] == 'manual'
    assert env['UV_NO_CONFIG'] == '1'


def test_ensure_venv_uv_env_also_covers_the_pip_install_phase(monkeypatch, tmp_path):
    calls = _capture_uv(monkeypatch)
    venv_dir = _make_reusable_venv(tmp_path / '.venvs' / 'task-env')

    asyncio.run(execute_module.ensure_venv(venv_dir, ['requests>=2']))

    assert len(calls) == 1  # reuse -> only the pip install invocation
    assert calls[0][1]['env']['UV_PYTHON_DOWNLOADS'] == 'manual'


@pytest.mark.parametrize('malformed', ['3', '3.7.9', '../x', '--index-url', '3.7;x'])
def test_ensure_venv_rejects_malformed_version_before_any_subprocess(
        monkeypatch, tmp_path, malformed):
    """NFR-03：畸形版本在任何 subprocess 之前终止，且不进 uv argv。"""
    calls = _capture_uv(monkeypatch)
    resolved = []

    async def fake_ensure_interpreter(version, timeout):
        resolved.append(version)
        raise AssertionError('must not resolve a malformed version')

    monkeypatch.setattr(execute_module, '_ensure_interpreter', fake_ensure_interpreter)

    with pytest.raises(RuntimeError, match='Invalid runtimeVersion'):
        asyncio.run(execute_module.ensure_venv(
            tmp_path / '.venvs' / 'bad', [], python_version=malformed))

    assert calls == []
    assert resolved == []


# ---------------------------------------------------------------------------
# 复用 / 重建 / 回滚
# ---------------------------------------------------------------------------

def _make_reusable_venv(venv_dir, version_info='3.12.13'):
    """构造一个"看起来还活着"的 venv（pyvenv.cfg 的 home 存在 + python 存在）。"""
    if sys.platform == 'win32':
        python_bin = venv_dir / 'Scripts' / 'python.exe'
    else:
        python_bin = venv_dir / 'bin' / 'python'
    python_bin.parent.mkdir(parents=True, exist_ok=True)
    python_bin.write_bytes(b'')
    venv_dir.mkdir(parents=True, exist_ok=True)
    (venv_dir / 'pyvenv.cfg').write_text(
        f'home = {venv_dir}\nimplementation = CPython\n'
        f'uv = 0.8.17\nversion_info = {version_info}\n'
        'include-system-site-packages = false\n',
        encoding='utf-8',
    )
    return venv_dir


def test_ensure_venv_reuses_a_healthy_venv_without_any_uv_call(monkeypatch, tmp_path):
    """AC-16b：健康的 venv 直接复用——**不产生任何 uv 调用**（性能语义不变）。"""
    calls = _capture_uv(monkeypatch)
    venv_dir = _make_reusable_venv(tmp_path / '.venvs' / 'task-reuse')

    result = asyncio.run(execute_module.ensure_venv(venv_dir, []))

    assert calls == [], 'a reusable venv must not trigger `uv venv`'
    assert result == execute_module._venv_python_bin(venv_dir)
    assert result.exists()


def test_ensure_venv_rebuilds_when_pyvenv_cfg_is_missing(monkeypatch, tmp_path):
    """空目录/半成品不再被当成"可复用"：删除并重建。"""
    calls = _capture_uv(monkeypatch)
    venv_dir = tmp_path / '.venvs' / 'task-stale'
    venv_dir.mkdir(parents=True)
    (venv_dir / 'leftover.txt').write_text('half-built')

    asyncio.run(execute_module.ensure_venv(venv_dir, []))

    assert len(calls) == 1, 'stale venv must be rebuilt'
    assert not (venv_dir / 'leftover.txt').exists(), 'old contents must be discarded'


def test_ensure_venv_rebuilds_when_backing_interpreter_was_reclaimed(monkeypatch, tmp_path):
    """lead 实测的事故场景：池内解释器被回收 → venv 是死 shim → 必须重建。

    真身（池目录）已不存在时，复用该 venv 会在 exec 阶段报
    `No Python at '...'`（exit 103），既难排查也把 D14 的语义搅浑。"""
    calls = _capture_uv(monkeypatch)
    venv_dir = tmp_path / '.venvs' / 'task-bricked'
    gone_home = tmp_path / 'pool' / 'cpython-3.8.20-windows-x86_64-none'
    _make_reusable_venv(venv_dir, version_info='3.8.20')
    (venv_dir / 'pyvenv.cfg').write_text(
        f'home = {gone_home}\nversion_info = 3.8.20\n', encoding='utf-8')
    assert not gone_home.exists()

    asyncio.run(execute_module.ensure_venv(venv_dir, []))

    assert len(calls) == 1, 'bricked venv must be rebuilt, not reused'


def test_ensure_venv_rebuilds_on_malformed_pyvenv_cfg(monkeypatch, tmp_path):
    """损坏的 pyvenv.cfg 一律按"不可用"处理，绝不崩。"""
    calls = _capture_uv(monkeypatch)
    venv_dir = tmp_path / '.venvs' / 'task-garbage'
    venv_dir.mkdir(parents=True)
    (venv_dir / 'pyvenv.cfg').write_bytes(b'\xff\xfe not text at all \x00')

    asyncio.run(execute_module.ensure_venv(venv_dir, []))

    assert len(calls) == 1


def test_ensure_venv_rebuilds_when_version_does_not_match(monkeypatch, tmp_path):
    """AC-15b：venv 记录的版本与任务声明不符 → 重建（绝不复用别的版本的环境）。"""
    calls = _capture_uv(monkeypatch)
    venv_dir = tmp_path / '.venvs' / 'task-version-mismatch'
    _make_reusable_venv(venv_dir, version_info='3.12.13')

    pool_python = tmp_path / 'pool' / 'cpython-3.7.9-x' / 'python.exe'
    pool_python.parent.mkdir(parents=True)
    pool_python.write_bytes(b'')

    async def fake_ensure_interpreter(version, timeout):
        return pool_python

    monkeypatch.setattr(execute_module, '_ensure_interpreter', fake_ensure_interpreter)

    asyncio.run(execute_module.ensure_venv(venv_dir, [], python_version='3.7'))

    assert len(calls) == 1, 'a 3.12 venv must not be reused for a 3.7 task'


def test_ensure_venv_reuses_when_version_matches(monkeypatch, tmp_path):
    """反向断言：版本一致时**仍然复用**（重建不是无条件的）。"""
    calls = _capture_uv(monkeypatch)
    venv_dir = _make_reusable_venv(tmp_path / '.venvs' / 'task-ok', version_info='3.7.9')

    resolved = []

    async def fake_ensure_interpreter(version, timeout):
        resolved.append(version)
        raise AssertionError('a matching cached venv needs no interpreter resolution')

    monkeypatch.setattr(execute_module, '_ensure_interpreter', fake_ensure_interpreter)

    asyncio.run(execute_module.ensure_venv(venv_dir, [], python_version='3.7'))

    assert calls == []
    assert resolved == []


def test_ensure_venv_rebuilds_when_python_binary_is_missing(monkeypatch, tmp_path):
    calls = _capture_uv(monkeypatch)
    venv_dir = tmp_path / '.venvs' / 'task-nopython'
    venv_dir.mkdir(parents=True)
    (venv_dir / 'pyvenv.cfg').write_text(f'home = {tmp_path}\n', encoding='utf-8')

    asyncio.run(execute_module.ensure_venv(venv_dir, []))

    assert len(calls) == 1


def test_ensure_venv_timeout_still_removes_half_built_dir(monkeypatch, tmp_path):
    """R4-C P2 既有回滚语义在版本化改造后必须原样保留。"""
    venv_dir = tmp_path / '.venvs' / 'taskA'
    proc = _FakeUvProc(venv_dir, hang=True)

    async def fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(execute_module, 'UV_VENV_TIMEOUT_SECONDS', 0.05)

    with pytest.raises(RuntimeError, match='timed out'):
        asyncio.run(execute_module.ensure_venv(venv_dir, []))
    assert proc.killed
    assert not venv_dir.exists()


def test_ensure_venv_timeout_rollback_also_applies_to_the_versioned_path(monkeypatch, tmp_path):
    """版本化路径同样要回滚（否则半个 3.7 venv 会被下次复用）。"""
    pool_python = tmp_path / 'pool' / 'cpython-3.7.9-x' / 'python.exe'
    pool_python.parent.mkdir(parents=True)
    pool_python.write_bytes(b'')

    async def fake_ensure_interpreter(version, timeout):
        return pool_python

    monkeypatch.setattr(execute_module, '_ensure_interpreter', fake_ensure_interpreter)
    venv_dir = tmp_path / '.venvs' / 'task-ver-timeout'
    proc = _FakeUvProc(venv_dir, hang=True)

    async def fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    monkeypatch.setattr(execute_module, 'UV_VENV_TIMEOUT_SECONDS', 0.05)

    with pytest.raises(RuntimeError, match='timed out'):
        asyncio.run(execute_module.ensure_venv(venv_dir, [], python_version='3.7'))
    assert proc.killed
    assert not venv_dir.exists()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _ok_client():
    from types import SimpleNamespace

    class FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json, headers):
            return SimpleNamespace(status_code=200)

    return FakeAsyncClient
