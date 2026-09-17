"""FR-04 / D4 requirements 合并（python_task_multiversion, WS4）。

覆盖：
  * 任务级同名覆盖包内条目（AC-04a）
  * 不同包名取并集（AC-04b）
  * 顺序稳定（先包内、后任务级新增）
  * 注释/空行剥离、危险选项行按既有 `_validate_requirements` 纪律跳过
  * 两侧都空 → 不建 venv，直接用所选解释器跑入口（AC-04c）
"""
import asyncio
import sys

import pytest

from routers import execute as execute_module
from routers.execute import ExecuteRequest


# ---------------------------------------------------------------------------
# merge_requirements：纯函数
# ---------------------------------------------------------------------------

def test_task_requirement_wins_over_package_for_the_same_name():
    """AC-04a：同名 → 任务级胜出（uv 不会同时看到两个版本约束）。"""
    merged = execute_module.merge_requirements(
        ['requests==2.20.0', 'flask>=1.0'],
        ['requests==2.31.0'],
    )
    assert 'requests==2.31.0' in merged
    assert 'requests==2.20.0' not in merged
    assert 'flask>=1.0' in merged


def test_task_win_keeps_the_package_position_for_stable_ordering():
    """覆盖不改动首次插入位置 → 输出顺序稳定（同输入同输出）。"""
    merged = execute_module.merge_requirements(
        ['requests==2.20.0', 'flask>=1.0'],
        ['requests==2.31.0'],
    )
    assert merged == ['requests==2.31.0', 'flask>=1.0']


def test_union_of_distinct_names():
    """AC-04b：不同包名取并集。"""
    merged = execute_module.merge_requirements(['numpy', 'pandas'], ['scipy'])
    assert merged == ['numpy', 'pandas', 'scipy']


def test_task_only_and_package_only_inputs():
    assert execute_module.merge_requirements([], ['requests']) == ['requests']
    assert execute_module.merge_requirements(['requests'], []) == ['requests']
    assert execute_module.merge_requirements([], []) == []


def test_merge_is_idempotent():
    once = execute_module.merge_requirements(['a', 'b'], ['b', 'c'])
    twice = execute_module.merge_requirements(once, ['b', 'c'])
    assert once == twice


@pytest.mark.parametrize('package_spec,task_spec', [
    ('Requests>=2', 'requests==2.31'),
    ('requests[socks]>=2', 'requests==2.31'),
    ('requests ; python_version < "3.8"', 'requests==2.31'),
    ('requests', 'REQUESTS'),
    ('my_pkg', 'my-pkg==1.0'),
    ('zope.interface', 'zope-interface'),
])
def test_same_package_is_detected_across_spelling_variants(package_spec, task_spec):
    """PEP 503 归一 + extras/标记/版本约束剥离 → 都算同一个包。"""
    merged = execute_module.merge_requirements([package_spec], [task_spec])
    assert len(merged) == 1
    assert merged[0] == task_spec


def test_distinct_packages_are_never_collapsed():
    """解析不出包名时按整串比较——绝不能把不同包误判成同名。"""
    merged = execute_module.merge_requirements(['===', 'a'], ['b'])
    assert len(merged) == 3


def test_non_string_entries_are_ignored():
    merged = execute_module.merge_requirements(['ok', None, 42], ['fine', ''])
    assert merged == ['ok', 'fine']


# ---------------------------------------------------------------------------
# requirements.txt 解析（包内文件是**数据**，不是任务参数）
# ---------------------------------------------------------------------------

def test_comments_and_blank_lines_are_stripped():
    parsed = execute_module._parse_requirements_file(
        '# a comment\n'
        '\n'
        'requests>=2  # inline comment\n'
        '   \n'
        'flask\n'
    )
    assert parsed == ['requests>=2', 'flask']


@pytest.mark.parametrize('option_line', [
    '-r other.txt',
    '--index-url https://evil.example/simple/',
    '--extra-index-url https://evil.example/simple/',
    '-e .',
    '--find-links /tmp/wheels',
    '--trusted-host evil.example',
    '--hash=sha256:deadbeef',
])
def test_dangerous_option_lines_are_skipped(option_line):
    """与 `_validate_requirements` 同一纪律：`-` 开头是 pip **选项**，绝不透传。

    `--index-url` 尤其危险：包内文本若能改索引，就等于让 zip 上传者决定依赖
    从哪台服务器下载（索引劫持）。"""
    parsed = execute_module._parse_requirements_file(
        f'{option_line}\nrequests>=2\n')
    assert parsed == ['requests>=2']


def test_section_headers_and_urls_are_skipped():
    parsed = execute_module._parse_requirements_file(
        '[global]\n'
        'https://example.com/pkg.whl\n'
        './local/path\n'
        '/abs/path\n'
        'requests\n'
    )
    assert parsed == ['requests']


def test_parse_keeps_environment_markers_and_extras():
    parsed = execute_module._parse_requirements_file(
        'requests[socks]>=2 ; python_version < "3.8"\n')
    assert parsed == ['requests[socks]>=2 ; python_version < "3.8"']


def test_read_package_requirements_returns_empty_when_absent(tmp_path):
    assert execute_module._read_package_requirements(tmp_path) == []


def test_read_package_requirements_is_case_insensitive(tmp_path):
    """Windows 上 `Requirements.txt` 合法、Linux 上不是——两侧行为必须一致。"""
    (tmp_path / 'Requirements.txt').write_text('requests>=2\n', encoding='utf-8')
    assert execute_module._read_package_requirements(tmp_path) == ['requests>=2']


def test_oversized_requirements_file_is_ignored_not_truncated(tmp_path, monkeypatch):
    """超限即忽略：截断会**静默改变依赖集**，比"没读到"更危险。"""
    monkeypatch.setattr(execute_module, 'ZIP_REQUIREMENTS_MAX_BYTES', 10)
    (tmp_path / 'requirements.txt').write_text('requests>=2\nflask\n', encoding='utf-8')
    assert execute_module._read_package_requirements(tmp_path) == []


def test_unreadable_requirements_file_does_not_crash(tmp_path, monkeypatch):
    path = tmp_path / 'requirements.txt'
    path.write_text('requests\n', encoding='utf-8')

    def boom(*a, **k):
        raise OSError('permission denied')

    monkeypatch.setattr(execute_module.Path, 'read_text', boom)
    assert execute_module._read_package_requirements(tmp_path) == []


# ---------------------------------------------------------------------------
# 与 run_task 的接线
# ---------------------------------------------------------------------------

def _zip_bytes(files):
    import io
    import zipfile
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


class _FakeStreamResponse:
    def __init__(self, chunks, status_code=200):
        self._chunks = chunks
        self.status_code = status_code

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk


def _patch_env(monkeypatch, tmp_path, payload):
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(execute_module.settings, 'executor_address', 'localhost:8001')
    monkeypatch.setattr(execute_module.settings, 'executor_shared_token', 'tok')
    monkeypatch.setattr(execute_module.settings, 'executor_secret', '')
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )

    class FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        def stream(self, method, url, headers=None):
            return _FakeStreamResponse([payload])

        async def post(self, url, json=None, headers=None):
            from types import SimpleNamespace
            return SimpleNamespace(status_code=200)

    monkeypatch.setattr(execute_module.httpx, 'AsyncClient', FakeAsyncClient)


def _capture_spawns(monkeypatch):
    spawns = []

    class _Proc:
        returncode = 0

        async def communicate(self):
            return b'', b''

        def kill(self):
            pass

        async def wait(self):
            return 0

    async def fake_exec(*args, **kwargs):
        spawns.append(list(args))
        return _Proc()

    monkeypatch.setattr(execute_module.asyncio, 'create_subprocess_exec', fake_exec)
    return spawns


def test_package_and_task_requirements_are_merged_before_install(monkeypatch, tmp_path):
    """端到端：包内 requirements.txt ∪ 任务级 requirements（任务级同名覆盖）。"""
    payload = _zip_bytes({
        'main.py': b'print(1)',
        'requirements.txt': b'# deps\nrequests==2.20.0\nflask\n',
    })
    _patch_env(monkeypatch, tmp_path, payload)
    spawns = _capture_spawns(monkeypatch)

    captured = {}

    async def fake_ensure_venv(venv_dir, requirements, *, python_version=None):
        captured['requirements'] = list(requirements)
        return venv_dir / ('Scripts' if sys.platform == 'win32' else 'bin') / 'python'

    monkeypatch.setattr(execute_module, 'ensure_venv', fake_ensure_venv)

    asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-merge', task={
            'id': 'task-merge', 'runtime': 'python',
            'codeSource': 'application_zip', 'applicationId': 'app-1',
            'packageUrl': 'https://cdn.example.com/app.zip',
            'entrypoint': 'main.py',
            'requirements': ['requests==2.31.0'],
        })))

    assert captured['requirements'] == ['requests==2.31.0', 'flask']


def test_both_requirement_sources_empty_skips_venv_entirely(monkeypatch, tmp_path):
    """AC-04c：两侧都空 → **不建 venv**，直接用所选解释器跑入口。

    这条路径必须逐字节保持既有语义（`sys.executable`，无 `uv venv`）。"""
    payload = _zip_bytes({'main.py': b'print(1)'})
    _patch_env(monkeypatch, tmp_path, payload)
    spawns = _capture_spawns(monkeypatch)

    async def boom(*a, **k):
        raise AssertionError('no venv may be created when there are no requirements')

    monkeypatch.setattr(execute_module, 'ensure_venv', boom)

    asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-nodeps', task={
            'id': 'task-nodeps', 'runtime': 'python',
            'codeSource': 'application_zip', 'applicationId': 'app-1',
            'packageUrl': 'https://cdn.example.com/app.zip',
            'entrypoint': 'main.py',
        })))

    assert spawns, 'the entrypoint must still run'
    assert spawns[0][0] == sys.executable
    assert spawns[0][1] == 'main.py'


def test_package_only_requirements_still_creates_a_venv(monkeypatch, tmp_path):
    """反向断言：只要包内声明了依赖就必须建 venv（AC-04c 只针对"都空"）。"""
    payload = _zip_bytes({
        'main.py': b'print(1)',
        'requirements.txt': b'requests>=2\n',
    })
    _patch_env(monkeypatch, tmp_path, payload)
    _capture_spawns(monkeypatch)
    captured = {}

    async def fake_ensure_venv(venv_dir, requirements, *, python_version=None):
        captured['requirements'] = list(requirements)
        return venv_dir / 'bin' / 'python'

    monkeypatch.setattr(execute_module, 'ensure_venv', fake_ensure_venv)

    asyncio.run(execute_module.run_task(ExecuteRequest(
        executionId='exec-pkgonly', task={
            'id': 'task-pkgonly', 'runtime': 'python',
            'codeSource': 'application_zip', 'applicationId': 'app-1',
            'packageUrl': 'https://cdn.example.com/app.zip',
            'entrypoint': 'main.py',
        })))

    assert captured['requirements'] == ['requests>=2']
