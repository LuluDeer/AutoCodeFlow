"""执行器能力声明的单一事实源（双端注册/心跳共用同一组键名）。

协议层不强制这些键的业务含义；这里列出**本执行器真实实现**的能力，
避免把 node-only 的路由（deploy / app-stop / app-uninstall / update-package /
telemetry:deployed-apps）虚报给中台导致任务被错派。

``sandbox:bwrap`` 只有在 TASK_SANDBOX=bwrap（fail-closed 沙箱）时才声明。
"""
from __future__ import annotations

from config import settings
from sandbox import SANDBOX_BWRAP

# 与 node src/capabilities.ts 中的 NODE_EXECUTOR_CAPABILITIES 键名逐字对齐。
BASE_PYTHON_CAPABILITIES: tuple[str, ...] = (
    # 运行时代名词：admin findFleetCandidates 的派发闸门按 task.runtime
    # 逐一匹配 capabilities 列，去掉这两个会让所有 python/shell 任务永远
    # 派不到本执行器（详见 task.runtime 过滤分支）。
    'python',
    'shell',
    'execute',
    'pull',
    'control:config-reload',
    'control:kill',
    'telemetry:conflict-v8',
)

SANDBOX_CAPABILITY = 'sandbox:bwrap'


def python_executor_capabilities() -> list[str]:
    """返回本进程当前真实支持的能力清单（沙箱能力按配置条件加入）。"""
    caps = list(BASE_PYTHON_CAPABILITIES)
    if settings.task_sandbox == SANDBOX_BWRAP:
        caps.append(SANDBOX_CAPABILITY)
    return caps
