"""`config.py` 解释器相关新增设置的校验单测（D9/D11/D12、NFR-14）。

覆盖：镜像 URL 校验（http(s)、拒绝 userinfo/query/fragment/非 http）、数值边界、
版本区间常量格式与顺序、以及**默认值与 CONTRACT.md 一致**。
"""
from pathlib import Path

import pytest

from config import (
    ONLINE_DOWNLOAD_MIN,
    RUNTIME_VERSION_PATTERN,
    Settings,
    validate_runtime_version,
    validate_uv_python_install_mirror,
)


def make_settings(**overrides) -> Settings:
    """构造不读 .env 的 Settings（测试必须与开发机 .env 隔离）。"""
    return Settings(_env_file=None, **overrides)


# ---------------------------------------------------------------------------
# 默认值 = CONTRACT.md（§1.1 / §2.5 / D11 / D12）
# ---------------------------------------------------------------------------

def test_defaults_match_contract():
    settings = make_settings()

    assert settings.uv_python_install_dir == '/data/interpreters'
    assert settings.uv_python_install_mirror == ''
    assert settings.interpreter_download_timeout_seconds == 300
    assert settings.interpreter_single_version_mb == 250
    assert settings.interpreter_total_gb == 4
    assert settings.python_runtime_version_min == '3.7'
    assert settings.python_runtime_version_max == '3.14'


def test_online_download_min_matches_contract():
    """CONTRACT.md §0.1：在线可下载区间为 3.8~3.14（3.7 仅离线预填）。"""
    assert ONLINE_DOWNLOAD_MIN == '3.8'


def test_runtime_version_pattern_is_major_minor_only():
    assert RUNTIME_VERSION_PATTERN.pattern == r'^\d+\.\d+$'


def test_online_download_min_comment_names_uv_platform_vocabulary():
    """回归（WS7 实测缺陷）：注释里的离线预填指引不得只说 `<platform>`。

    uv 对不匹配的平台三元组**静默忽略**（目录名照建、版本永不出现），照 pbs
    发布名操作的运维会得到"文件放对了但探测不到"的无解症状。因此本文件的
    指引必须点名 uv 词汇并给出 pbs 反面例子。
    """
    import config as config_module

    source = Path(config_module.__file__).read_text(encoding='utf-8')
    assert '<uv平台三元组>' in source, '离线预填指引必须标注 uv 平台三元组'
    assert 'linux-x86_64-gnu' in source
    assert 'windows-x86_64-none' in source
    assert 'x86_64-unknown-linux-gnu' in source, '必须给出 pbs 反面例子'


def test_install_dir_must_stay_outside_work_dir_by_default():
    """NFR-15：解释器层豁免 TTL 清扫的前提是它与 work_dir 物理隔离。"""
    settings = make_settings()
    assert not settings.uv_python_install_dir.startswith(settings.work_dir)
    assert not settings.work_dir.startswith(settings.uv_python_install_dir)
    # 字段默认值层面同样成立（.env 可能覆盖运行时值）
    assert Settings.model_fields['uv_python_install_dir'].default == '/data/interpreters'


def test_work_dir_default_unchanged():
    """兼容红线：本次改动不得改 work_dir 默认值（字段默认值，非运行时环境值）。"""
    assert Settings.model_fields['work_dir'].default == '/tmp/autocodeflow/tasks'


def test_existing_settings_untouched():
    settings = make_settings()
    assert settings.max_concurrent_tasks == 10
    assert settings.task_timeout_seconds == 300
    assert settings.heartbeat_interval_seconds == 30
    assert settings.pypi_registry_url == ''


# ---------------------------------------------------------------------------
# 镜像 URL 校验（D9/NFR-14，规则与 PYPI_REGISTRY_URL 同源）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('url', [
    'https://mirror.internal/python',
    'http://mirror.internal:8080/python-build-standalone',
    'https://mirror.internal/',
])
def test_mirror_accepts_valid_http_urls(url):
    assert make_settings(uv_python_install_mirror=url).uv_python_install_mirror == url


def test_mirror_accepts_empty_and_strips_whitespace():
    assert make_settings(uv_python_install_mirror='').uv_python_install_mirror == ''
    assert make_settings(uv_python_install_mirror='  ').uv_python_install_mirror == ''
    assert (
        make_settings(uv_python_install_mirror=' https://m.internal/x ').uv_python_install_mirror
        == 'https://m.internal/x'
    )


@pytest.mark.parametrize('url', [
    'https://user:password@mirror.internal/python',
    'https://user@mirror.internal/python',
    'https://mirror.internal/python?token=secret',
    'https://mirror.internal/python#frag',
])
def test_mirror_rejects_credentials_query_fragment(url):
    with pytest.raises(ValueError) as exc:
        make_settings(uv_python_install_mirror=url)

    assert 'must not contain userinfo, query, or fragment' in str(exc.value)


@pytest.mark.parametrize('url', [
    'ftp://mirror.internal/python',
    'file:///srv/python',
    'mirror.internal/python',
    '://mirror.internal',
    'https://',
])
def test_mirror_rejects_non_http_or_malformed(url):
    with pytest.raises(ValueError) as exc:
        make_settings(uv_python_install_mirror=url)

    assert 'UV_PYTHON_INSTALL_MIRROR must be a valid http(s) URL' in str(exc.value)


def test_mirror_validation_does_not_echo_secret():
    """错误信息不得回显 URL 里的凭据（与 PyPI 设置同一姿态）。"""
    with pytest.raises(ValueError) as exc:
        make_settings(uv_python_install_mirror='https://u:super-secret@mirror.internal/x')

    assert 'super-secret' not in str(exc.value)


def test_mirror_validator_function_is_public_and_reusable():
    assert (
        validate_uv_python_install_mirror('https://mirror.internal/x')
        == 'https://mirror.internal/x'
    )
    with pytest.raises(ValueError):
        validate_uv_python_install_mirror('ftp://mirror.internal')


def test_mirror_and_pypi_registry_share_rules():
    """两个 URL 设置必须接受/拒绝同一批取值（规则同源，避免安全姿态漂移）。"""
    accepted = 'https://registry.internal/simple/'
    rejected = 'https://u:p@registry.internal/simple/?q=1'
    assert (
        make_settings(
            uv_python_install_mirror=accepted, pypi_registry_url=accepted,
        ).uv_python_install_mirror == accepted
    )
    with pytest.raises(ValueError):
        make_settings(uv_python_install_mirror=rejected)
    with pytest.raises(ValueError):
        make_settings(pypi_registry_url=rejected)


# ---------------------------------------------------------------------------
# 数值边界
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('value', [1, 60, 300, 86400])
def test_download_timeout_accepts_positive_bounds(value):
    assert make_settings(interpreter_download_timeout_seconds=value).interpreter_download_timeout_seconds == value


@pytest.mark.parametrize('value', [0, -1, 86401])
def test_download_timeout_rejects_out_of_range(value):
    with pytest.raises(ValueError) as exc:
        make_settings(interpreter_download_timeout_seconds=value)

    assert 'INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS must be in [1, 86400]' in str(exc.value)


@pytest.mark.parametrize('value', [64, 250, 1024])
def test_single_version_mb_accepts_values_at_or_above_floor(value):
    assert make_settings(interpreter_single_version_mb=value).interpreter_single_version_mb == value


@pytest.mark.parametrize('value', [0, -250, 63])
def test_single_version_mb_rejects_nonsense(value):
    with pytest.raises(ValueError) as exc:
        make_settings(interpreter_single_version_mb=value)

    assert 'INTERPRETER_SINGLE_VERSION_MB must be >= 64' in str(exc.value)


@pytest.mark.parametrize('value', [0, -4])
def test_total_gb_rejects_nonsense(value):
    with pytest.raises(ValueError) as exc:
        make_settings(interpreter_total_gb=value)

    assert 'INTERPRETER_TOTAL_GB must be >= 1' in str(exc.value)


def test_single_version_cap_must_not_exceed_total_pool_cap():
    """跨字段：单版本红线 ≤ 总池红线（否则配置自相矛盾）。"""
    with pytest.raises(ValueError) as exc:
        make_settings(interpreter_single_version_mb=4096, interpreter_total_gb=1)

    assert 'INTERPRETER_SINGLE_VERSION_MB must not exceed' in str(exc.value)

    # 边界等值合法（250MB 单版本 + 1GB 总池）
    assert make_settings(
        interpreter_single_version_mb=1024, interpreter_total_gb=1,
    ).interpreter_single_version_mb == 1024


# ---------------------------------------------------------------------------
# 版本区间常量
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('value', ['3.7', '3.8', '3.14'])
def test_version_bounds_accept_major_minor(value):
    assert make_settings(python_runtime_version_min=value).python_runtime_version_min == value


def test_version_bounds_accept_versions_above_default_max():
    """区间上界可放宽（部署方自行决定支持区间，如未来 4.0）。"""
    settings = make_settings(python_runtime_version_max='4.0')
    assert settings.python_runtime_version_max == '4.0'


@pytest.mark.parametrize('value', ['3', '3.7.9', '3.x', '3.7; rm -rf /', '', 'v3.7'])
def test_version_bounds_reject_bad_format(value):
    with pytest.raises(ValueError):
        make_settings(python_runtime_version_min=value)
    with pytest.raises(ValueError):
        make_settings(python_runtime_version_max=value)


def test_version_bounds_strip_surrounding_whitespace():
    assert make_settings(python_runtime_version_min=' 3.7 ').python_runtime_version_min == '3.7'


def test_version_bounds_must_be_ordered():
    """跨字段：区间下界不得大于上界（数值比较，不是字符串比较）。"""
    with pytest.raises(ValueError) as exc:
        make_settings(python_runtime_version_min='3.14', python_runtime_version_max='3.7')

    assert 'PYTHON_RUNTIME_VERSION_MIN must not be greater' in str(exc.value)


def test_version_bounds_numeric_not_lexicographic():
    """`3.9` < `3.14` 必须按数值判定（字符串比较会判反）。"""
    settings = make_settings(python_runtime_version_min='3.9', python_runtime_version_max='3.14')
    assert settings.python_runtime_version_min == '3.9'
    with pytest.raises(ValueError):
        make_settings(python_runtime_version_min='3.14', python_runtime_version_max='3.9')


@pytest.mark.parametrize('value', ['3.7', '3.13', '4.0'])
def test_validate_runtime_version_helper_accepts(value):
    assert validate_runtime_version(value) == value


@pytest.mark.parametrize('value', ['3', '3.7.9', '../evil', '3.7; rm -rf /', None, 3.7])
def test_validate_runtime_version_helper_rejects(value):
    with pytest.raises(ValueError):
        validate_runtime_version(value)


def test_validate_runtime_version_strips_surrounding_whitespace():
    assert validate_runtime_version(' 3.7 ') == '3.7'


# ---------------------------------------------------------------------------
# 环境变量接线
# ---------------------------------------------------------------------------

def test_settings_read_from_environment(monkeypatch):
    monkeypatch.setenv('UV_PYTHON_INSTALL_DIR', '/srv/interpreters')
    monkeypatch.setenv('UV_PYTHON_INSTALL_MIRROR', 'https://mirror.internal/python')
    monkeypatch.setenv('INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS', '120')
    monkeypatch.setenv('INTERPRETER_SINGLE_VERSION_MB', '300')
    monkeypatch.setenv('INTERPRETER_TOTAL_GB', '8')
    monkeypatch.setenv('PYTHON_RUNTIME_VERSION_MIN', '3.9')
    monkeypatch.setenv('PYTHON_RUNTIME_VERSION_MAX', '3.13')

    settings = make_settings()

    assert settings.uv_python_install_dir == '/srv/interpreters'
    assert settings.uv_python_install_mirror == 'https://mirror.internal/python'
    assert settings.interpreter_download_timeout_seconds == 120
    assert settings.interpreter_single_version_mb == 300
    assert settings.interpreter_total_gb == 8
    assert settings.python_runtime_version_min == '3.9'
    assert settings.python_runtime_version_max == '3.13'


def test_unknown_interpreter_env_does_not_break_startup(monkeypatch):
    """`extra='ignore'`：未识别的环境变量不得让执行器起不来。"""
    monkeypatch.setenv('INTERPRETER_TOTALLY_UNKNOWN', 'x')
    assert make_settings().interpreter_total_gb == 4


# ---------------------------------------------------------------------------
# SEC-NEW：任务沙箱/资源限制/下载校验 pin 配置（F-1/B-1/F-2）
# ---------------------------------------------------------------------------

def test_task_sandbox_default_is_disabled():
    """F-1：默认 ''（本地开发/测试零变化）；生产容器由 docker-compose 显式开启。"""
    assert Settings.model_fields['task_sandbox'].default == ''


@pytest.mark.parametrize('value', ['', 'bwrap'])
def test_task_sandbox_accepts_valid_values(value):
    assert make_settings(task_sandbox=value).task_sandbox == value


@pytest.mark.parametrize('value', ['firejail', 'docker', 'cgroup'])
def test_task_sandbox_rejects_unknown_values(value):
    with pytest.raises(ValueError):
        make_settings(task_sandbox=value)


def test_task_resource_limit_defaults():
    """B-1：内存 2048MB 默认开启；CPU 回落超时宽限；fsize/nofile 有界；nproc 默认 0。"""
    settings = make_settings()
    assert settings.task_memory_limit_mb == 2048
    assert settings.task_cpu_limit_seconds == 0
    assert settings.task_fsize_limit_mb == 4096
    assert settings.task_nofile_limit == 1024
    assert settings.task_nproc_limit == 0


def test_task_resource_limit_rejects_negative():
    with pytest.raises(ValueError):
        make_settings(task_memory_limit_mb=-1)


def test_sha256_pins_valid_json_roundtrip():
    digest = 'a' * 64
    settings = make_settings(uv_python_sha256_pins={'3.12': digest})
    assert settings.uv_python_sha256_pins == {'3.12': digest}


@pytest.mark.parametrize(
    'pins',
    [
        {'3.12': 'abc'},          # 非 64 位 hex
        {'3.12': 'z' * 64},       # 非法 hex 字符
        {'3.12.9': 'a' * 64},     # 键必须 X.Y
        {'3': 'a' * 64},          # 键必须 X.Y
    ],
)
def test_sha256_pins_reject_malformed(pins):
    with pytest.raises(ValueError):
        make_settings(uv_python_sha256_pins=pins)


def test_sha256_pins_merge_per_version_env(monkeypatch):
    """F-2：UV_PYTHON_SHA256_<MAJ>_<MIN> 逐版本注入 + 大小写归一。"""
    digest = 'B' * 64
    monkeypatch.setenv('UV_PYTHON_SHA256_3_12', digest)
    settings = make_settings()
    assert settings.uv_python_sha256_pins == {'3.12': digest.lower()}


def test_sha256_pins_env_rejects_bad_digest(monkeypatch):
    monkeypatch.setenv('UV_PYTHON_SHA256_3_12', 'not-a-hash')
    with pytest.raises(ValueError):
        make_settings()
