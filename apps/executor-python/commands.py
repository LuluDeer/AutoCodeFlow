"""ARCH-33（ADR-016）：pull 控制面命令的本地执行分派（node 侧 commands.ts 的同构实现）。

背景：ADR-015 只把「任务派发」搬上了 pull 通道，而所有「中台主动拨入执行器」
的控制面调用（deploy / app-stop / app-uninstall / config-reload / kill /
update-package）仍是纯 push 硬编码。公网中台 + 内网执行器拓扑下这些调用必然
超时（生产实证：app_deployments.statusMessage = "Failed to reach executor
after 3 attempts: timeout of 30000ms exceeded"）。

本模块把中台经 pull 响应下发的命令，**回环**到本执行器自己的既有本地路由：
``http://127.0.0.1:{port}/api/...`` + 本执行器令牌。这是 E-1 配置热更新已验证
的先例（``_maybe_pull_config``）——apply 逻辑单一事实源，零漂移；本地路由的
全部校验（协议闸门、workDir 四闸、停机守卫）照常生效。

能力缺口（**如实声明，不得粉饰**）
----------------------------------
python 执行器只有 6 类命令中的 2 类有对应本地路由：

======================  ==========================  ==========================
命令类型                  python 本地路由              行为
======================  ==========================  ==========================
``config-reload``        ``POST /api/config/reload``  支持
``kill-execution``       ``POST /api/executions/{id}/kill``  支持
``deploy``               无                            回报 unsupported
``app-stop``             无                            回报 unsupported
``app-uninstall``        无                            回报 unsupported
``update-package``       无                            回报 unsupported
======================  ==========================  ==========================

这**不是**本次改动引入的回归：今日中台对 python 执行器 push ``/api/deploy``
同样是 404（``packages/executor-protocol/protocol.json`` 的 ``executorNodeOnly``
段已把这三个端点登记为「python 缺席」，并规定：若 python 将来补齐这些路由，
必须把条目提升进 ``schemas`` 并从中删除）。

选择「回报 unsupported」而不是「回环打一个必然 404 的请求」：后者的错误信息是
``HTTP 404``，运维无法据此判断「执行器版本旧」还是「中台发错了」；前者直接给出
能力缺口的可行动结论。

安全边界（与 node 侧一致）
--------------------------
命令类型是**封闭枚举**，本地路径由本模块按类型构造，**绝不接受中台下发的自由
路径**。这**不扩大**信任面——中台今日就能对 push 执行器发同样的入站 POST，也能
给任何 pull 执行器下发含任意脚本的 glue 任务（等价于任意代码执行），执行器本就
完全信任中台。封闭枚举的意义是**限制误配与内部错误的影响半径**，不是新增授权。
"""
from __future__ import annotations

import logging
import time
from typing import Any

from auth import get_current_token, request_with_self_heal
from config import settings
from admin_api import build_admin_api_url

logger = logging.getLogger(__name__)


def _get_http_client():
    """O-24: 取共享的 per-loop 连接池。

    函数内延迟导入——``get_http_client`` 定义在 ``scheduler`` 里，而
    ``scheduler.pull_task`` 要导入本模块；模块级互相 import 会成环。运行时
    scheduler 早已加载完毕，延迟导入是安全的（scheduler.py 自身对
    ``routers.execute`` 用的是同一套手法）。
    """
    from scheduler import get_http_client

    return get_http_client()

#: 中台可下发的命令类型（封闭枚举——新增类型必须两端同批）。
CONTROL_COMMAND_TYPES: tuple[str, ...] = (
    'deploy',
    'app-stop',
    'app-uninstall',
    'config-reload',
    'kill-execution',
    'update-package',
)

#: 本执行器有本地路由的命令类型 → 路由构造函数 + 超时预算。
#:
#: 超时按「本地路由何时返回」定，而非按命令何时**做完**定。
_LOCAL_ROUTES: dict[str, dict[str, Any]] = {
    'config-reload': {'path': lambda _p: '/api/config/reload', 'timeout': 10},
    'kill-execution': {
        # executionId 进 URL 路径段——必须编码（同 node 侧的路径注入防御）。
        'path': lambda p: '/api/executions/{}/kill'.format(
            quote_path_segment(p.get('executionId'))
        ),
        'timeout': 5,
    },
}


def quote_path_segment(value: Any) -> str:
    """把任意值编码成单个 URL 路径段（防路径注入）。

    ``urllib.parse.quote`` 默认 ``safe='/'``——斜杠**不会**被编码，形如
    ``../../etc/passwd`` 的载荷会原样穿进 URL 并改变路由匹配。故显式
    ``safe=''``。
    """
    from urllib.parse import quote

    return quote('' if value is None else str(value), safe='')


def is_control_command_type(command_type: Any) -> bool:
    """类型是否属于封闭枚举。"""
    return isinstance(command_type, str) and command_type in CONTROL_COMMAND_TYPES


def parse_control_command(raw: Any) -> dict[str, Any] | None:
    """解析并校验一条来自队列的命令载荷。畸形条目返回 None（丢弃 + warn）。"""
    if not isinstance(raw, dict):
        return None
    command_id = raw.get('commandId')
    command_type = raw.get('type')
    if not isinstance(command_id, str) or not command_id:
        return None
    if not is_control_command_type(command_type):
        return None
    payload = raw.get('payload')
    if not isinstance(payload, dict):
        payload = {}
    issued_at = raw.get('issuedAt')
    return {
        'commandId': command_id,
        'type': command_type,
        'payload': payload,
        'issuedAt': issued_at if isinstance(issued_at, (int, float)) else None,
    }


async def execute_control_command(command: dict[str, Any]) -> dict[str, Any]:
    """执行一条命令：回环 POST 到本地路由。

    **绝不抛出**——任何失败都收敛为 ``ok=False`` 的结果对象，由调用方上报中台。
    抛错会让 pull 循环的 except 吞掉命令 ID，中台侧就再也无法把「命令没生效」
    与「命令没送达」区分开。
    """
    started_at = time.monotonic()
    command_id = command['commandId']
    command_type = command['type']

    def _result(ok: bool, *, status: int | None = None,
                error: str | None = None) -> dict[str, Any]:
        return {
            'commandId': command_id,
            'type': command_type,
            'ok': ok,
            'status': status,
            'error': error,
            'durationMs': int((time.monotonic() - started_at) * 1000),
        }

    route = _LOCAL_ROUTES.get(command_type)
    if route is None:
        # 能力缺口：本执行器没有该命令对应的本地路由。**不**回环打一个必然
        # 404 的请求——那只会产出一句无行动价值的 "HTTP 404"。
        logger.warning(
            'Control command %s (%s) is not supported by the python executor '
            '(no local route; see protocol.json executorNodeOnly)',
            command_type, command_id,
        )
        return _result(
            False,
            error=(
                f'{command_type} is not implemented by the python executor '
                '(node-only capability; see protocol.json executorNodeOnly)'
            ),
        )

    path = route['path'](command['payload'])
    url = f'http://127.0.0.1:{settings.port}{path}'
    try:
        token = await get_current_token()
        client = _get_http_client()
        logger.info('[command] Executing %s (%s) via local route %s',
                    command_type, command_id, path)
        response = await client.post(
            url,
            json=command['payload'],
            headers={'Authorization': f'Bearer {token}'},
            timeout=route['timeout'],
        )
    except Exception as exc:
        message = str(exc)
        logger.warning('[command] %s (%s) failed to reach local route %s: %s',
                       command_type, command_id, path, message)
        return _result(False, error=message[:1000])

    if 200 <= response.status_code < 300:
        logger.info('[command] %s (%s) accepted by local route',
                    command_type, command_id)
        return _result(True, status=response.status_code)

    # 本地路由的错误信封：FastAPI 默认 {"detail": ...}；取到就用，取不到报状态码。
    detail: str | None = None
    try:
        body = response.json()
        if isinstance(body, dict):
            raw_detail = body.get('detail') or body.get('error') or body.get('message')
            if isinstance(raw_detail, str) and raw_detail:
                detail = raw_detail
    except Exception:  # pragma: no cover - 非 JSON 错误体
        detail = None
    if detail is None:
        detail = f'HTTP {response.status_code}'
    logger.warning('[command] %s (%s) rejected by local route: %s',
                   command_type, command_id, detail)
    return _result(False, status=response.status_code, error=detail[:1000])


async def report_command_result(result: dict[str, Any]) -> None:
    """把命令执行结果上报中台（best-effort）。

    上报失败只 warn：业务终态另有回调通道收敛（deploy →
    /app-deployments/heartbeat；update-package → push-result），结果上报覆盖的
    是这两条之外没有回执通道的命令（config-reload / kill-execution）。
    """
    try:
        token = await get_current_token()
        client = _get_http_client()
        address = settings.executor_address_public or settings.executor_address
        await request_with_self_heal(
            client,
            'post',
            build_admin_api_url('/executors/command-result'),
            token=token,
            json={**result, 'address': address},
            timeout=10,
        )
    except Exception as exc:
        logger.warning('[command] Failed to report result for %s: %s',
                       result.get('commandId'), exc)


async def run_control_commands(raw_commands: Any) -> None:
    """执行一批控制面命令，并逐条上报结果。

    逐条**串行**执行——``app-uninstall`` 依赖同一批里先到的 ``app-stop`` 已生效，
    并发会把「先停后删」的时序打乱。

    单条失败不中断整批：一条坏命令不该让同批的其余命令一起丢掉。
    """
    if not isinstance(raw_commands, list) or not raw_commands:
        return

    for raw in raw_commands:
        command = parse_control_command(raw)
        if command is None:
            # 畸形条目：中台侧 parse_command 已拦一道，这里是第二道（队列被外部
            # 写入 / 版本错配）。丢弃 + warn，不上报（没有 commandId 可关联）。
            logger.warning('[command] Discarded malformed control command from pull response')
            continue
        result = await execute_control_command(command)
        await report_command_result(result)
