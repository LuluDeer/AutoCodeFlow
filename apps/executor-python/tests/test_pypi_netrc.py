"""P1 契约断裂修复（2026-10-25）：registry-pypi Basic 凭据的 netrc 通道。

钉住的修复路径（先红后绿；设计稿 docs/archive/reports/pypi-credential-channel-design.md）：
  1. 未配置凭据 → build_uv_env 不含 NETRC（现状逐字节不变）；
  2. 配置凭据对 + 索引 → NETRC 键存在、文件 0600、machine/login/password 与
     索引 host 一致；附加索引 host 不同则多一条 machine 记录；
  3. 宿主环境的 NETRC 不穿透白名单（只有受控生成文件生效）；
  4. config 校验：凭据对残缺 / 无索引 → ValueError，消息不回显凭据值。
"""
import os
import stat
from pathlib import Path

import pytest

import interpreters
from config import Settings
from config import settings


@pytest.fixture()
def pool(tmp_path, monkeypatch):
    """把解释器池指到 tmp_path/pool（与 test_interpreters.pool 同法，本文件自带）。"""
    root = tmp_path / 'pool'
    root.mkdir()
    monkeypatch.setattr(settings, 'uv_python_install_dir', str(root))
    monkeypatch.setattr(settings, 'uv_python_install_mirror', '')
    interpreters.invalidate_cache()
    return root


def _configure_credentials(monkeypatch, *, user='reg-user', password='reg-pass',
                           registry_url='http://registry-pypi:8003/simple/',
                           extra_url=''):
    monkeypatch.setattr(settings, 'pypi_registry_username', user)
    monkeypatch.setattr(settings, 'pypi_registry_password', password)
    monkeypatch.setattr(settings, 'pypi_registry_url', registry_url)
    monkeypatch.setattr(settings, 'pypi_extra_index_url', extra_url)


def test_build_uv_env_without_credentials_has_no_netrc(pool, monkeypatch):
    """未配置凭据对 → 零行为变化（现状钉住，红线：默认部署姿态不变）。"""
    monkeypatch.setattr(settings, 'pypi_registry_username', '')
    monkeypatch.setattr(settings, 'pypi_registry_password', '')
    env = interpreters.build_uv_env(cache_dir=pool / '.uv-cache')
    assert 'NETRC' not in env


def test_build_uv_env_with_credentials_injects_netrc(pool, monkeypatch, tmp_path):
    """配置凭据对 → NETRC 指向 0600 netrc，内容与索引 host/凭据一致。"""
    _configure_credentials(monkeypatch)
    cache = tmp_path / 'uv-cache'
    env = interpreters.build_uv_env(cache_dir=cache)
    assert 'NETRC' in env
    netrc = Path(env['NETRC'])
    assert netrc == cache / '.uv-netrc'
    # 权限红线：0600（同 UID 进程外不可读）
    assert stat.S_IMODE(netrc.stat().st_mode) == 0o600
    content = netrc.read_text(encoding='utf-8')
    assert 'machine registry-pypi' in content
    assert 'login reg-user' in content
    assert 'password reg-pass' in content


def test_build_uv_env_netrc_covers_extra_index_host(pool, monkeypatch, tmp_path):
    """附加索引 host 不同 → 同一凭据集多一条 machine 记录（去重保序）。"""
    _configure_credentials(
        monkeypatch,
        registry_url='http://registry-pypi:8003/simple/',
        extra_url='https://pypi.example.org/simple/',
    )
    env = interpreters.build_uv_env(cache_dir=tmp_path / 'c')
    content = Path(env['NETRC']).read_text(encoding='utf-8')
    assert content.count('machine ') == 2
    assert 'machine registry-pypi' in content
    assert 'machine pypi.example.org' in content
    # 同 host 的附加索引不重复
    _configure_credentials(
        monkeypatch,
        extra_url='http://registry-pypi:8003/simple/',
    )
    env2 = interpreters.build_uv_env(cache_dir=tmp_path / 'c2')
    content2 = Path(env2['NETRC']).read_text(encoding='utf-8')
    assert content2.count('machine ') == 1


def test_build_uv_env_ignores_host_netrc_env(pool, monkeypatch):
    """宿主 NETRC 环境变量不穿透白名单——只有受控生成文件才生效。"""
    monkeypatch.setenv('NETRC', '/host/rogue-netrc')
    monkeypatch.setattr(settings, 'pypi_registry_username', '')
    monkeypatch.setattr(settings, 'pypi_registry_password', '')
    env = interpreters.build_uv_env()
    assert env.get('NETRC') != '/host/rogue-netrc'


def test_maybe_inject_skips_when_pair_incomplete(pool, monkeypatch, tmp_path):
    """只配一半凭据 → 不注入（config 校验已拒，这里钉注入点的防御性）。"""
    monkeypatch.setattr(settings, 'pypi_registry_username', 'only-user')
    monkeypatch.setattr(settings, 'pypi_registry_password', '')
    monkeypatch.setattr(settings, 'pypi_registry_url', 'http://registry-pypi:8003/simple/')
    env: dict[str, str] = {}
    interpreters.maybe_inject_pypi_netrc(env, tmp_path)
    assert env == {}


def test_write_pypi_netrc_overwrites_in_place(tmp_path):
    """幂等覆写（不 delete+rename）：并发 install 各持同路径 fd 仍指向同一 inode。"""
    dest = tmp_path / '.uv-netrc'
    first = interpreters.write_pypi_netrc(
        dest, username='u1', password='p1', hosts=['h1.example'],
    )
    inode_first = first.stat().st_ino
    second = interpreters.write_pypi_netrc(
        dest, username='u2', password='p2', hosts=['h2.example'],
    )
    assert second.stat().st_ino == inode_first, '覆写必须保持 inode（并发 fd 语义）'
    content = dest.read_text(encoding='utf-8')
    assert 'login u2' in content and 'login u1' not in content
    assert stat.S_IMODE(dest.stat().st_mode) == 0o600


def test_settings_rejects_half_configured_credentials():
    """凭据对残缺 → ValueError；消息不得回显凭据值。"""
    with pytest.raises(ValueError) as exc_info:
        Settings(pypi_registry_username='user-only', pypi_registry_password='')
    assert 'user-only' not in str(exc_info.value)
    with pytest.raises(ValueError):
        Settings(pypi_registry_username='', pypi_registry_password='pass-only')


def test_settings_rejects_credentials_without_any_index():
    """凭据对完整但无任何索引 → ValueError（fail-fast，防凭据永远闲置）。"""
    with pytest.raises(ValueError) as exc_info:
        Settings(
            pypi_registry_username='reg-user',
            pypi_registry_password='reg-pass',
            pypi_registry_url='',
            pypi_extra_index_url='',
        )
    assert 'reg-pass' not in str(exc_info.value)


def test_settings_accepts_credentials_with_index():
    """凭据对 + 至少一个索引 → 合法（修复的 401 通道成立）。"""
    s = Settings(
        pypi_registry_username='reg-user',
        pypi_registry_password='reg-pass',
        pypi_registry_url='http://registry-pypi:8003/simple/',
    )
    assert s.pypi_registry_username == 'reg-user'
