"""R24（2026-11-05）：executor-python 侧 `.env` 读入的**自检开关**（与 R04/R23 同语义）。

为什么需要
----------
`config.py:142-144` 的 `SettingsConfigDict(env_file='.env', ...)` 让 **pydantic-settings
在实例化 `Settings()` 时读工作目录下的 `.env`**。而 `apps/executor-python/.env` 是**开发者
本地文件**（未入库，被 `.gitignore` 命中），里面通常带 `ADMIN_API_URL=http://localhost:3105`
之类的真地址。

⇒ 后果：**pytest 会静默读到开发者的 `.env`**。`tests/conftest.py` 只能用 `os.environ.setdefault`
覆盖若干键，而 `setdefault` **不覆盖已存在的键** —— 于是 `.env` 里的 `ADMIN_API_URL` 已经进了
`os.environ`（pydantic 载入即写入），`setdefault` 根本改不动它 ⇒ 测试可能**真连本机 admin-api**
（这正是 R04 在 admin 侧遇到过的形态：夹具被开发机环境绑走）。

开关语义（三态，逐字对齐 `apps/admin-api/src/config/selftest-env.ts` 与
`apps/executor-node/src/config/env-file.ts`）
-----------------------------------------------------
* 未设置 ⇒ **读** `.env`（生产 / compose 行为与引入开关前逐字节一致）；
* ``"1"`` ⇒ **不读**（自检唯一认可的取值）；
* 其它任意值（含 ``"0"`` / ``"true"`` / 空串）⇒ **读**（不发明宽松真值，
  避免"看起来关了其实开着"）。

开关的键名沿用全仓统一键 ``SELFTEST_SKIP_ENV_FILE``（node 侧同名，见
``apps/executor-node/src/config/env-file.ts``），python 侧用同一个键 ⇒ 一次设置，
两端同时生效。
"""

import os
from typing import Mapping, Optional

SELFTEST_SKIP_ENV_FILE_KEY = "SELFTEST_SKIP_ENV_FILE"


def should_skip_env_file(env: Optional[Mapping[str, str]] = None) -> bool:
    """是否跳过 ``.env`` 读入（只认字符串 ``"1"``）。"""
    source = os.environ if env is None else env
    return source.get(SELFTEST_SKIP_ENV_FILE_KEY) == "1"


def env_file_for_settings(env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """给 ``Settings`` 的 ``_env_file`` 用的值。

    * 开关打开 ⇒ ``None``（pydantic-settings **不读任何 env 文件**）；
    * 否则 ⇒ ``".env"``（与引入开关前的行为逐字节一致）。
    """
    return None if should_skip_env_file(env) else ".env"
