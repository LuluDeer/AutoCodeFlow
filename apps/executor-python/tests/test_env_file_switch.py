"""R24（2026-11-05）：executor-python 侧 `.env` 读入开关的红→绿判据。

核心那条不是"函数返回 True/False"（自我实现），而是**真造一个投毒 `.env`**：
开关打开时 `Settings()` **读不到**它；关闭时**读得到**。
"""

import os
import tempfile
from pathlib import Path

from config_env_file import (
    SELFTEST_SKIP_ENV_FILE_KEY,
    env_file_for_settings,
    should_skip_env_file,
)


def _write_poison_env(tmpdir: str) -> str:
    path = Path(tmpdir) / ".env"
    path.write_text("ADMIN_API_URL=http://poisoned.invalid:1\n", encoding="utf-8")
    return str(path)


def test_unset_means_load(tmp_path, monkeypatch):
    """未设置 ⇒ 读 `.env`（生产/compose 与引入开关前一致）。"""
    monkeypatch.delenv(SELFTEST_SKIP_ENV_FILE_KEY, raising=False)
    assert should_skip_env_file({}) is False
    assert env_file_for_settings({}) == ".env"


def test_only_exactly_one_is_skip(tmp_path):
    """只认字符串 "1"；其它取值（"0"/"true"/空串）仍读。"""
    assert should_skip_env_file({SELFTEST_SKIP_ENV_FILE_KEY: "1"}) is True
    for value in ("0", "true", "", "yes", " 1"):
        assert should_skip_env_file({SELFTEST_SKIP_ENV_FILE_KEY: value}) is False


def test_poison_env_is_visible_when_switch_off(tmp_path, monkeypatch):
    """【对照】开关关闭 ⇒ 投毒 `.env` **确实**被读到（证明下一条真在测开关）。"""
    monkeypatch.delenv(SELFTEST_SKIP_ENV_FILE_KEY, raising=False)
    poison = _write_poison_env(str(tmp_path))
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("ADMIN_API_URL", raising=False)

    from config import Settings  # 延迟导入，确保 env_file 判定发生在开关生效之后

    settings = Settings(_env_file=env_file_for_settings())
    assert settings.admin_api_url == "http://poisoned.invalid:1"


def test_poison_env_is_invisible_when_switch_on(tmp_path, monkeypatch):
    """【核心】开关打开 ⇒ 投毒 `.env` **读不到**（自检跑在干净环境里）。"""
    monkeypatch.setenv(SELFTEST_SKIP_ENV_FILE_KEY, "1")
    poison = _write_poison_env(str(tmp_path))
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("ADMIN_API_URL", raising=False)

    from config import Settings

    settings = Settings(_env_file=env_file_for_settings())
    assert settings.admin_api_url != "http://poisoned.invalid:1"
    assert "poisoned.invalid" not in (settings.admin_api_url or "")
