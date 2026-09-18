import asyncio
import logging
import time
import uuid
import weakref
import httpx
import threading
from typing import Any
from urllib.parse import quote
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    wait_combine,
    wait_random,
    retry_if_exception_type,
    before_sleep_log,
)
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings, EXECUTOR_VERSION, PROTOCOL_VERSION
import psutil
from auth import get_current_token, adopt_executor_token_hash, request_with_self_heal

logger = logging.getLogger(__name__)

# R9 (round-9): the process-life identity now lives in startup_identity.py
# (auth.py needs it for POST /token and cannot import scheduler.py — cycle).
# Re-exported here so existing importers (main.py, tests) keep working.
from startup_identity import executor_started_at, executor_startup_id  # noqa: F401

# EXE-VER-1: 版本漂移告警节流（node scheduler.ts warnVersionDriftThrottled 对齐）
# —— 同一次不合规期最多每 10 分钟 warning 一条，防 30s 心跳刷屏。
_VERSION_DRIFT_WARN_INTERVAL_SECONDS = 10 * 60
_last_version_drift_warn_at = 0.0


def _warn_version_drift_if_noncompliant(payload: Any) -> None:
    """中心端 EXECUTOR_MIN_VERSION 门禁开启且本执行器版本低于下限时，心跳响应
    回显 ``versionCompliant: false`` —— 据此打漂移告警日志；升级执行器（重装
    artifact）后响应回到 true，日志自然静默。门禁关闭时回显恒 true，零开销。
    """
    global _last_version_drift_warn_at
    if not isinstance(payload, dict) or payload.get('versionCompliant') is not False:
        return
    now = time.monotonic()
    if now - _last_version_drift_warn_at < _VERSION_DRIFT_WARN_INTERVAL_SECONDS:
        return
    _last_version_drift_warn_at = now
    logger.warning(
        'Version drift: executor %s is below the admin-required minimum %s '
        '(EXECUTOR_MIN_VERSION). New task dispatch may be refused for this '
        'executor — upgrade by re-running the install command or downloading '
        'the latest executor artifact.',
        EXECUTOR_VERSION, payload.get('minVersion'),
    )


# Global count of currently-running tasks with thread-safe operations
running_count = 0
_running_count_lock = threading.Lock()


# O-24: process-wide httpx.AsyncClient singleton for the high-frequency admin
# paths (pull long-poll, heartbeat, and the executor-python callback report /
# replay). The previous code opened and closed a fresh pool per pull/heartbeat/
# callback (`async with httpx.AsyncClient()`), so every long-poll tick and every
# terminal result paid a new-connection-pool setup cost. One shared client keeps a
# warm connection pool.
#
# The client is keyed by the *running event loop*, not a single global: asyncio
# primitives bind to the loop that first awaits them, and the pytest suite runs
# one fresh loop per test (often monkeypatching httpx.AsyncClient). Keying by
# loop gives production a single long-lived client while each test loop builds
# (and the patch intercepts) its own, so there is no cross-loop reuse.
#
# The key is the loop OBJECT itself in a WeakKeyDictionary (not id(loop)):
# object ids are reused once a loop is garbage-collected, which would otherwise
# return a previous test's cached (patched/closed) client for a new loop.
# Weak-keying also drops the entry as soon as a loop is gone.
_http_client_by_loop: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]" = (
    weakref.WeakKeyDictionary()
)


def get_http_client() -> "httpx.AsyncClient":
    """Return the shared AsyncClient for the current event loop (O-24).

    Constructed lazily on first use on the running loop. ``trust_env=False``
    and a 10s default timeout preserve the previous pull/heartbeat
    (trust_env=False) and callback/replay (timeout=10) behavior; per-request
    ``timeout=`` overrides (pull 35s, heartbeat 5s) still win inside
    request_with_self_heal."""
    loop = asyncio.get_running_loop()
    client = _http_client_by_loop.get(loop)
    if client is None or getattr(client, "is_closed", False):
        client = httpx.AsyncClient(trust_env=False, timeout=10.0)
        _http_client_by_loop[loop] = client
    return client


async def aclose_http_clients() -> None:
    """Close every per-loop client (called from the executor shutdown hook)."""
    global _http_client_by_loop
    for client in list(_http_client_by_loop.values()):
        try:
            await client.aclose()
        except Exception:  # noqa: BLE001 - best-effort shutdown
            pass
    _http_client_by_loop.clear()

def get_running_count() -> int:
    global running_count
    with _running_count_lock:
        return running_count

def increment_running() -> None:
    global running_count
    with _running_count_lock:
        running_count += 1

def decrement_running() -> None:
    global running_count
    with _running_count_lock:
        running_count = max(0, running_count - 1)


def try_reserve_running_slot() -> bool:
    """E-01（P1）pull 容量竞态——预留槽位原语（node pull.ts 同款原子模式）。

    在发起 pull 长轮询【之前】原子预留一个执行槽位：与 push 派发占用槽位
    的入口（accept_execution → increment_running）使用同一 running 计数账
    本，check-then-act 在同一把锁内完成。预留成功返回 True，槽位由调用方
    持有——admin 无任务返回/领取被拒时经 release_running_slot() 归还；领取
    成功（accept_execution 的 slot_pre_reserved 模式）时预留即正式占用，
    完成路径 _run_and_callback 的 decrement_running 归还的正是这一个槽位。
    """
    global running_count
    with _running_count_lock:
        if running_count >= settings.max_concurrent_tasks:
            return False
        running_count += 1
        return True


def release_running_slot() -> None:
    """E-01: 归还 try_reserve_running_slot() 预留的槽位（同一账本；
    max(0, …) 钳制与既有 decrement_running 释放路径一致）。"""
    decrement_running()


def _get_admin_api_url() -> str:
    """Get the appropriate Admin API base URL for heartbeat."""
    return get_admin_api_base_url()


# E1 (CONSISTENCY round, parity with executor-node scheduler.ts STALE-01):
# admin's recoverStaleExecutions grants liveness protection ONLY to executors
# that report runningExecutionIds — a missing field means "legacy executor,
# never reported" and skips the protection (scheduler.service.ts:631), so a
# python executor in the prepare stage (git clone + venv, up to ~600s) gets
# its execution misjudged FAILED mid-run. The live-execution registry lives
# in routers/execute.py which imports this module — importing back would form
# a cycle, so the data owner registers its getter here (same posture as node).
# The field must ALWAYS be sent (an empty list = reported & idle); the only
# forbidden shape is omitting it.
def _default_running_execution_ids() -> list:
    return []


_running_execution_ids_provider = _default_running_execution_ids


def register_running_execution_ids_provider(fn) -> None:
    """Install the getter returning currently-live executionIds."""
    global _running_execution_ids_provider
    _running_execution_ids_provider = fn


# E2 (node scheduler.ts deadLetterCountProvider parity): dead-letter backlog
# reported via heartbeat so long disconnections (callbacks parked on disk)
# stay visible to ops. Default provider returns 0 — an executor that has
# never imported routers/execute reports "no dead letters" rather than
# omitting the field.
def _default_dead_letter_count() -> int:
    return 0


_dead_letter_count_provider = _default_dead_letter_count


def register_dead_letter_count_provider(fn) -> None:
    """Install the getter returning the dead-letter file count."""
    global _dead_letter_count_provider
    _dead_letter_count_provider = fn


# FR-13/FR-14（python_task_multiversion, CONTRACT.md §2.3）：解释器缓存池清单
# 随心跳上报，完全复刻上面两个 provider 的模式（数据归 main.py 所有，本模块
# 只持有一个 getter——main 反向 import scheduler 会成环）。
#
# 字段缺省语义（§2.3 admin 采纳规则）：缺省 = 保留 DB 旧值；`[]` = 已上报且
# 池为空。默认 provider 返回 **[]（不是 None）**：本执行器版本必然会上报该
# 字段（main 在 lifespan 里接上真实 provider），未接线只可能是测试/独立导入，
# 此时"已上报且为空"比"未上报"更诚实，也不会让 admin 用 ["3.12"] 兜底把任务
# 派到池里没有该版本的执行器上。
#
# 刷新语义：provider 由 main 提供，内部复用 WS3 探测模块的缓存（池变化后由
# 模块侧 invalidate_cache 收敛），因此心跳路径**不会**每次 spawn 一个 uv 进程
# （NFR-10）。
def _default_interpreters() -> list:
    return []


_interpreters_provider = _default_interpreters


def register_interpreters_provider(fn) -> None:
    """Install the getter returning the interpreter pool inventory."""
    global _interpreters_provider
    _interpreters_provider = fn


def _collect_interpreters() -> list:
    """Provider 输出归一为契约形状的 list（CONTRACT.md §2.2）。

    上报的是"能力快照"，任何异常都不能让心跳失败——那会让 admin 判执行器
    OFFLINE，代价远大于少报一次清单。异常/非 list 一律收敛为空列表。"""
    try:
        value = _interpreters_provider()
    except Exception as exc:  # noqa: BLE001 - 心跳绝不因上报失败而中断
        logger.warning('interpreters provider failed; reporting an empty inventory: %s', exc)
        return []
    if not isinstance(value, list):
        logger.warning('interpreters provider returned %s, expected list', type(value).__name__)
        return []
    return value


def _heartbeat_retry_exhausted(retry_state):
    """Called when all retries are exhausted — return None to suppress RetryError."""
    logger.warning(f'Heartbeat failed after all retries: {retry_state.outcome.exception()}')
    return None


@retry(
    stop=stop_after_attempt(3),
    # E-44: 心跳重试叠加随机抖动（0~2s），避免多 executor 在相同 admin 恢复
    # 窗口后同步重试（惊群）；与 node/execute 回调退避的 (0.5+random) 抖动同源。
    wait=wait_combine(
        wait_exponential(multiplier=1, min=1, max=8),
        wait_random(min=0, max=2),
    ),
    retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException, httpx.TransportError, OSError)),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    retry_error_callback=_heartbeat_retry_exhausted,
)
async def _send_heartbeat(client: httpx.AsyncClient, token: str, trace_id: str = None) -> None:
    """ERR-04: single heartbeat attempt — tenacity retries this on transient failures.

    R11 (round-11, port of executor-node R10 gap #3): the request goes through
    ``request_with_self_heal`` so a 401 (admin rotated our per-executor token
    out from under us, e.g. the admin-UI rotate-token button) triggers ONE
    immediate re-fetch + retry instead of waiting for the 30-minute scheduled
    refresh — during which the heartbeat would keep 401ing and the executor
    get marked OFFLINE after 3 missed intervals. The heal is bounded to one
    auth retry per attempt (a persistent 401 still falls through to
    ``raise_for_status`` below and the tenacity loop), and admin-api's
    issueToken is idempotent per (address, startupId), so concurrent 401s
    converge on the same token instead of rotating.
    """
    # OPS-03: propagate trace ID for cross-service tracing
    headers = {'X-Trace-Id': trace_id} if trace_id else {}
    cpu = await asyncio.to_thread(psutil.cpu_percent, 1)
    mem = psutil.virtual_memory().percent
    response = await request_with_self_heal(
        client,
        'post',
        build_admin_api_url('/executors/heartbeat'),
        token=token,
        headers=headers,
        json={
            'address': settings.executor_address_public or settings.executor_address,
            'cpuUsage': cpu,
            'memUsage': mem,
            'runningTaskCount': get_running_count(),
            # E-01: runningTaskCount 诚实包含 pull 循环「预留中」的槽位——
            # 预留即占位（try_reserve_running_slot 与 push 派发同一账本），
            # admin 容量核算在长轮询窗口内看到的就是满载，不会再把 push 派
            # 发塞进最后一个空槽（这正是关闭竞态窗口的机制本身）。
            # E1: liveness report — capped at 200 ids (node parity,
            # scheduler.ts sendHeartbeat). Always present, never omitted.
            'runningExecutionIds': _running_execution_ids_provider()[:200],
            # E2: dead-letter backlog (node scheduler.ts sendHeartbeat sends
            # deadLetterCountProvider()). Always present, never omitted; the
            # provider serves a cached count so this never rescans the disk.
            'deadLetterCount': max(0, int(_dead_letter_count_provider())),
            # FR-13/FR-14（python_task_multiversion, CONTRACT.md §2.3）：解释器
            # 缓存池清单——与 runningExecutionIds/deadLetterCount 同一 provider
            # 模式。池变化时由 WS3 模块的 invalidate_cache 收敛，provider 本身
            # 走缓存，心跳不会每次探测（NFR-10）。
            'interpreters': _collect_interpreters(),
            'restartedAt': executor_started_at,
            'startupId': executor_startup_id,
            # EXE-VER-1: 版本随心跳上报（node scheduler.ts 对齐，可选字段）；
            # 中心端 EXECUTOR_MIN_VERSION 门禁开启时在响应回显合规态（下方消费）。
            'version': EXECUTOR_VERSION,
            # PROTOCOL-VER（B-3/U-2）：协议版本随心跳回传（与 register 同源），
            # 中台可据此在心跳路径做兼容性分支（见 config.py PROTOCOL_VERSION）。
            'protocolVersion': PROTOCOL_VERSION,
        },
        timeout=5,
    )
    response.raise_for_status()
    # R9 (round-9, W3 parity with executor-node scheduler.ts): admin
    # heartbeats echo the executor's current stored tokenHash
    # ({code,message,data:{tokenHash}} envelope) — adopt it so the
    # per-execution callback-token HMAC key follows admin-side rotations
    # instead of going stale (picked up within heartbeatIntervalSeconds).
    try:
        payload = response.json()
        adopt_executor_token_hash(payload)
        # EXE-VER-1: 版本漂移提醒（同一响应包络内消费 versionCompliant）。
        _warn_version_drift_if_noncompliant(payload)
    except Exception:  # pragma: no cover - non-JSON / empty admin bodies
        pass


# E-1（中台↔执行器深度审查）：pull 模式配置热更新——记录已应用的 configVersion
# 指纹；admin pull 响应里的 configVersion 与之不一致时主动拉取配置并复用本地
# /api/config/reload 的校验与应用路径（与 node pull.ts 的 maybePullConfig 同构）。
_applied_config_version: str | None = None


async def _maybe_pull_config(admin_config_version: Any) -> None:
    """admin pull 响应附带 configVersion 指纹；变化时主动 GET /api/executors/config
    拉取全量配置，再回环本地 /api/config/reload 应用（apply 逻辑单一事实源）。

    失败不阻塞任务取件：保留旧版本号，下一轮 pull 重试；旧版 admin 无指纹字段
    （非字符串）时不拉取，行为零变化。"""
    global _applied_config_version
    if not isinstance(admin_config_version, str) or not admin_config_version:
        return
    if _applied_config_version == admin_config_version:
        return
    try:
        token = await get_current_token()
        client = get_http_client()  # O-24: shared per-loop pool
        address = settings.executor_address_public or settings.executor_address
        response = await request_with_self_heal(
            client,
            'get',
            build_admin_api_url(f'/executors/config?address={quote(address)}'),
            token=token,
            timeout=10,
        )
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict):
            logger.warning('Pull-mode config fetch returned a non-object payload; '
                           'keeping applied config version')
            return
        # 复用本地 /api/config/reload 的校验 + 应用路径（协议闸门 + workDir
        # 四闸 + ignored_fields 上报），与 admin 主动推送逐字节一致。
        local_url = f'http://127.0.0.1:{settings.port}/api/config/reload'
        local = await client.post(
            local_url,
            json=body,
            headers={'Authorization': f'Bearer {token}'},
            timeout=10,
        )
        if 200 <= local.status_code < 300:
            _applied_config_version = admin_config_version
            updated = local.json().get('updated_fields', [])
            logger.info('Pull-mode config hot-reloaded (version %s): %s',
                        admin_config_version, ', '.join(updated) or 'no changes')
        else:
            logger.warning('Pull-mode config reload rejected by local /config/reload (HTTP %s)',
                           local.status_code)
    except Exception as exc:  # pragma: no cover - best-effort, next pull retries
        logger.warning('Pull-mode config reload failed: %s', exc)


async def pull_task() -> None:
    """ARCH-32（ADR-015）: pull 派发循环——EXECUTOR_PULL_MODE=true 时由 main
    启动。E-01（P1）预留槽位方案：先经 try_reserve_running_slot() 原子预留
    一个执行槽位（与 push 派发同一账本），预留成功才向 admin 发长轮询（服
    务端阻塞至多 25s）——长轮询窗口内该槽位已被本执行器诚实占用（心跳
    runningTaskCount 同源可见），push 派发抢不走最后一个空槽，accept 阶段
    的容量竞态窗口随之关闭。取到载荷即走与 push 完全相同的 accept_execution
    领取路径与回调通道：

      * 无任务返回 → finally 立即释放预留，进入下一轮；
      * 领取成功（slot_pre_reserved=True）→ 预留即正式占用，完成路径
        _run_and_callback 的 decrement_running 归还该槽位；
      * 领取因非容量原因（400 校验失败等）被拒 → 释放预留 + 补发 failed
        回调（真失败，admin 侧不留僵尸 RUNNING 行，既有语义不变）；
      * 防御路径：领取仍返回 429（账本异常/竞态残余，正常流程不可达）→
        释放预留 + warning，但【不回调 failed】——429 是「暂时没容量」的
        瞬态，补发 failed 恰是把瞬态固化成 admin 侧永久失败的行为（评审
        E-01 要关闭的正是它）；admin 侧 stale sweep 对无人认领的 RUNNING
        行兜底收敛。"""
    # 函数内延迟导入：routers.execute 模块级 import sched，模块级反向引入
    # 会成环（import 顺序敏感）；ExecuteRequest 一并在延迟段导入。
    from routers.execute import (
        accept_execution,
        reject_pulled_execution,
        ExecutionRejected,
        ExecuteRequest,
    )
    from auth import _unwrap_envelope

    while True:
        await asyncio.sleep(1)
        # E-01: 预留标记——True 期间本协程持有且仅持有一个账本槽位；
        # finally 是唯一释放点，杜绝双释放。
        reserved = False
        try:
            if not try_reserve_running_slot():
                continue  # 满载：本轮不拉取（未预留任何槽位）
            reserved = True
            token = await get_current_token()
            client = get_http_client()  # O-24: shared per-loop pool
            response = await request_with_self_heal(
                client,
                'post',
                build_admin_api_url('/executors/pull'),
                token=token,
                json={
                    'address': settings.executor_address_public or settings.executor_address,
                    'waitMs': 25000,
                },
                timeout=35,
            )
            response.raise_for_status()
            try:
                data = _unwrap_envelope(response.json()) or {}
            except Exception:  # pragma: no cover - non-JSON / empty admin bodies
                continue  # finally 释放预留
            # E-1: 配置指纹比对 + 主动拉取（失败不阻塞取件，下一轮重试）。
            await _maybe_pull_config(data.get('configVersion'))
            task = data.get('task')
            if not isinstance(task, dict) or not task.get('executionId'):
                continue  # 无任务：finally 释放预留

            execution_id = str(task['executionId'])
            traceparent = task.get('traceparent')
            logger.info('Pulled execution %s from admin pull queue', execution_id)
            body = {k: v for k, v in task.items() if k != 'traceparent'}
            req = ExecuteRequest(**body)
            try:
                # E-01: 预留即正式占用——slot_pre_reserved 模式下 accept 不
                # 再重复计数（详见 accept_execution 注释）。
                accept_execution(req, traceparent if isinstance(traceparent, str) else None,
                                 slot_pre_reserved=True)
                reserved = False  # 所有权移交：完成路径归还该槽位
            except ExecutionRejected as e:
                if e.status_code == 429:
                    # 防御路径（正常流程不可达）：释放预留（finally）、warn、
                    # 绝不回调 failed——让 admin 侧 stale sweep 兜底收敛。
                    logger.warning(
                        'Pulled execution %s rejected with 429 despite pre-reserved slot '
                        '(capacity ledger drift) — releasing reservation, no failed callback '
                        '(admin stale sweep converges the orphan RUNNING row)',
                        execution_id,
                    )
                else:
                    # 真失败（校验被拒）：维持既有语义，补发 failed 回调。
                    await reject_pulled_execution(execution_id, e.detail,
                                                  traceparent if isinstance(traceparent, str) else None)
        except Exception as e:
            logger.warning('Pull failed: %s', e)
        finally:
            if reserved:
                release_running_slot()
                reserved = False


async def heartbeat_task() -> None:
    # HEALTH-01: 延迟导入——routers/__init__ 会 import execute.py，而 execute.py
    # 在模块级回调 scheduler.register_running_execution_ids_provider（E1 那段
    # 注释已说明过这条依赖），所以 scheduler 顶层 import routers.* 会形成循环导入
    # （已实测 AttributeError）。改为在函数内导入，运行时 routers 早已加载完毕。
    from routers.health import record_heartbeat

    while True:
        try:
            await asyncio.sleep(settings.heartbeat_interval_seconds)
            # SEC-03: use dynamic token with auto-refresh
            token = await get_current_token()
            # OPS-03: generate trace ID for heartbeat
            trace_id = str(uuid.uuid4())
            logger.info(f'[{trace_id}] Sending heartbeat')
            await _send_heartbeat(get_http_client(), token, trace_id)  # O-24: shared pool
            # HEALTH-01（本轮审计）：此前**没有任何地方**调用
            # routers/health.record_heartbeat —— 它是死代码。后果是
            # /health 的 _admin_api_reachable 永远是 None，于是每次探针都退化成
            # 一次 5s 超时的实时外呼（docstring 声称「用缓存值」是假的），
            # lastHeartbeat 也永远是 null，运维无法据此判断心跳链路是否健康。
            # 现在把真实心跳结果回灌给健康模块。
            record_heartbeat(True)
        except Exception as e:
            # ERR-04: all retries exhausted — log as warning and keep the loop alive
            logger.warning(f'Heartbeat failed after all retries: {e}')
            record_heartbeat(False)
