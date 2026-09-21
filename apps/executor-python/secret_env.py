"""SEC-02 续（生产故障）：任务级 secrets 的**按原名注入**规则（python 侧对等物）。

与 ``apps/executor-node/src/secret-env.ts`` 逐条对等——两侧必须给出**同一个
判断**，否则同一个任务在 node 执行器上能拿到凭据、在 python 执行器上被拒绝
（或反之），这种分叉比两边都不支持更难排查。

## 为什么需要按原名注入

此前 secrets 与 params 走同一条通道，统一加 ``AUTOFLOW_`` 前缀。生产实证：
用户在平台配置 ``FEISHU_APP_ID`` 后，脚本读 ``os.environ["FEISHU_APP_ID"]``
拿到空串 → 报「缺少飞书凭证」。报错文案里写的名字与实际注入的名字不是同一个，
用户照提示配置也永远配不对。第三方 SDK（boto3 认 ``AWS_ACCESS_KEY_ID``、
openai 认 ``OPENAI_API_KEY``）更无从改写。

## 为什么必须有名字闸门

「按原名注入」意味着用户提供的键名会**直接成为子进程的环境变量名**：一个名为
``PATH`` 或 ``PYTHONIOENCODING`` 的 secret 会覆盖执行器赖以工作的环境（PATH
被覆盖后子进程连解释器都找不到，任务以与凭据无关的形态失败，极难定位）。

故：白名单式校验（``[A-Za-z_][A-Za-z0-9_]*``）+ 保留名拒绝。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set

# 合法环境变量名：字母或下划线开头，其余为字母/数字/下划线。与 node 侧
# SAFE_SECRET_NAME_RE 同款。非法名**静默跳过**而非抛错——一个手滑的键名不该让
# 整个任务跑不起来，凭据缺失会在脚本里以明确的业务报错暴露。
_SAFE_SECRET_NAME_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

# 保留名：不得由 secret 占用。三个来源与 node 侧一致：
#   1. 执行器注入的任务作用域变量（EXECUTION_ID / TASK_ID / TASK_NAME /
#      AUTOFLOW_*）——被覆盖会让回调、产物收集、追踪静默失效；
#   2. 环境白名单透传的宿主变量——被覆盖会让子进程连解释器都找不到；
#   3. 执行器密钥——本就不该进子进程。
#
# 注意本集合是 node 侧 RESERVED_SECRET_NAMES 的**镜像**，不是"python 自己的一份
# 清单"：两侧判断必须一致（见模块头注释）。
_RESERVED_SECRET_NAMES: Set[str] = {
    # 1. 执行器注入的任务作用域变量
    'EXECUTION_ID',
    'TASK_ID',
    'TASK_NAME',
    'NODE_PATH',
    # 2. 环境白名单透传的宿主变量（与 env-whitelist.ts 的 ENV_WHITELIST 同集）
    #
    # ⚠️ 必须**逐条大写**：判定处写的是 `upper in _RESERVED_SECRET_NAMES`
    # （见 is_injectable_secret_name），若这里留着 `npm_config_cache` 这样的
    # 小写条目，查表用的是 `NPM_CONFIG_CACHE`，永远匹配不上——该条目等于**不存在**，
    # 大写形态会绕过闸门。node 侧同样踩过这个坑（它靠集合构建时 `.map(toUpperCase)`
    # 规避），admin-api 的对等性测试逐条比对两侧集合内容，实测抓出本处遗漏。
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'NODE_PATH', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX',
    'TMPDIR', 'TEMP', 'TMP',
    'USER', 'LOGNAME', 'SHELL',
    'SYSTEMROOT', 'WINDIR',
    'COMSPEC', 'PATHEXT',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    # 3. 执行器密钥
    'EXECUTOR_SHARED_TOKEN',
    'EXECUTOR_SECRET',
    'EXECUTION_CALLBACK_SECRET',
}


def is_injectable_secret_name(name: str) -> bool:
    """该 secret 名是否可用于「按原名注入」。"""
    if not _SAFE_SECRET_NAME_RE.match(name or ''):
        return False
    upper = name.upper()
    if upper in _RESERVED_SECRET_NAMES:
        return False
    # AUTOFLOW_ 是 params 的命名空间（secret 占用会与 params 互相覆盖，语义不明）
    if upper.startswith('AUTOFLOW_'):
        return False
    # PYTHON* 是解释器自身的行为开关（PYTHONIOENCODING / PYTHONUTF8 /
    # PYTHONPATH…），执行器为保证日志编码正确**必须**独占。
    if upper.startswith('PYTHON'):
        return False
    return True


def inject_secret_env(
    env: Dict[str, str],
    secrets: Optional[Dict[str, Any]],
) -> List[str]:
    """把 secrets 按原名写进子进程 env，返回**被跳过**的键名列表。

    调用方应把被跳过的键名记一条 warn —— 静默丢弃凭据是最难排查的失败形态
    （脚本报"缺凭据"，用户在平台看配置明明存在）。
    """
    if not secrets or not isinstance(secrets, dict):
        return []
    skipped: List[str] = []
    for k, v in secrets.items():
        if not is_injectable_secret_name(k):
            skipped.append(k)
            continue
        # None 值跳过而非写成 "None"：`{"KEY": None}` 是"这个键没有值"的合理
        # 表达，写成字面量会让脚本拿到一个看起来合法、实则错误的凭据。
        if v is None:
            continue
        env[k] = str(v)
    return skipped
