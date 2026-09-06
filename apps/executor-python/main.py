from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from functools import partial
import asyncio
import logging
import os
import signal
import httpx

from routers import execute, health, logs, config as config_router
import maintenance
from admin_api import build_admin_api_url, check_admin_api_connectivity, get_admin_api_base_url
from config import settings
from scheduler import heartbeat_task, get_running_count, executor_started_at, executor_startup_id
from auth import get_current_token, get_static_token, require_token_enabled, adopt_executor_token_hash

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)

# Graceful shutdown state
_shutting_down = False
_heartbeat_task = None


def is_shutting_down() -> bool:
    return _shutting_down


def _get_admin_api_url() -> str:
    """Get the appropriate Admin API base URL."""
    return get_admin_api_base_url()


async def notify_offline():
    """Send offline notification to admin-api during graceful shutdown."""
    try:
        token = await get_current_token()
        headers = {'Authorization': f'Bearer {token}'} if token else {}
        async with httpx.AsyncClient() as client:
            await client.post(
                build_admin_api_url('/executors/offline'),
                json={'address': settings.executor_address_public or settings.executor_address},
                headers=headers,
                timeout=5,
            )
            logger.info('Sent offline notification to admin-api')
    except Exception as e:
        logger.warning(f'Failed to send offline notification: {e}')


async def wait_for_tasks(timeout_seconds: int = 30):
    """Wait for running tasks to complete with timeout."""
    start_time = asyncio.get_event_loop().time()
    while get_running_count() > 0:
        if asyncio.get_event_loop().time() - start_time > timeout_seconds:
            logger.warning(f'Grace period expired, {get_running_count()} tasks still running, forcing shutdown')
            return
        logger.info(f'Waiting for {get_running_count()} task(s) to complete...')
        await asyncio.sleep(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _heartbeat_task
    # Check Admin API connectivity first so startup logs show clear diagnostics.
    await check_admin_api_connectivity()
    # R4-C P2: warn loudly when the executor would run in dev-mode (no token).
    # With REQUIRE_TOKEN=true the auth dependency instead refuses /api/*.
    if not get_static_token():
        if require_token_enabled():
            logger.warning('REQUIRE_TOKEN=true but no executor token is configured — /api/* requests will be refused')
        else:
            logger.warning(
                'No executor token configured — /api/* is open to unauthenticated callers (dev mode). '
                'Set EXECUTOR_SHARED_TOKEN or set REQUIRE_TOKEN=true to refuse.'
            )
    # Register to admin-api on startup
    await register_executor()
    # Start heartbeat background task
    _heartbeat_task = asyncio.create_task(heartbeat_task())
    # E2: background replay of persisted callbacks (node startCallbackThread).
    # The retry task's sweep keeps the deadLetterCount heartbeat field fresh.
    execute.start_callback_retry_task()
    # E8: disk TTL reclamation (node startWorkDirCleanup). The live-execution
    # snapshot provider is registered first so sweeps can protect active dirs.
    maintenance.register_live_entries_provider(execute.list_live_execution_entries)
    maintenance.start_disk_cleanup_task()
    logger.info(f'Executor started: {settings.app_name} @ {settings.executor_address}')
    yield
    # Graceful shutdown: wait for running tasks to complete
    _heartbeat_task.cancel()
    if get_running_count() > 0:
        logger.info(f'Graceful shutdown: waiting for {get_running_count()} task(s) to finish...')
        await wait_for_tasks()
    # E5 (parity with executor-node main.ts killRunningTaskProcesses): the
    # grace period expired (or nothing was running) — tree-kill every task
    # process still registered so detached children don't outlive the
    # executor as unmanaged orphans. No-op when the registry is empty.
    try:
        killed = await execute.kill_running_task_processes()
        if killed:
            logger.warning(
                f'Shutdown: killed {killed} task process tree(s) still running'
            )
    except Exception as e:
        logger.warning(f'Shutdown task tree-kill failed: {e}')
    # QA8: 树杀后、drain 前，给 worker 协程一个有限窗口把终态回调投出去或
    # 落盘——被杀任务的 _run_and_callback 要先观察到子进程退出才会产出回调，
    # 若不等它们，进程退出会把未送达的回调一起带走（执行只能等 stale sweep
    # 修复，真实 killed/timeout 分类丢失）。窗口耗尽未完成的 worker 被取消，
    # _run_and_callback 的 CancelledError 守卫保证载荷落盘。
    try:
        flushed = await execute.await_background_tasks_after_kill()
        if flushed:
            logger.info(
                f'Shutdown: {flushed} task worker(s) completed their terminal callback after tree-kill'
            )
    except Exception as e:
        logger.warning(f'Shutdown worker callback flush failed: {e}')
    # E2 (node stopCallbackThread parity): bounded drain of the callback
    # re-send loop — in-flight replay gets a limited wait, undelivered files
    # simply stay on disk for the next process's replay.
    try:
        await execute.stop_callback_retry_task()
    except Exception as e:
        logger.warning(f'Shutdown callback drain failed: {e}')
    # E8: stop the disk sweep before exiting.
    maintenance.stop_disk_cleanup_task()
    await notify_offline()
    logger.info('Executor shutdown complete')


async def register_executor():
    try:
        # R9-fix (P1, VERIFY-round9-e2e §1.4): admin's POST /executors/register
        # authenticates with verifyExecutorToken, which only accepts the shared
        # bootstrap token. get_current_token() prefers the dynamic per-executor
        # token — once R9 fixed _fetch_token, that dynamic token started winning
        # the race to register and the call was rejected with 401, silently
        # dropping the rich metadata (capabilities/maxConcurrentTasks/
        # executorVersion) the scheduler filters on. Register therefore carries
        # the static bootstrap token (parity with executor-node's
        # postWithStaticToken); heartbeats keep using the dynamic token.
        token = get_static_token()
        headers = {'Authorization': f'Bearer {token}'} if token else {}
        async with httpx.AsyncClient() as client:
            response = await client.post(
                build_admin_api_url('/executors/register'),
                json={
                    'appName': settings.app_name,
                    'address': settings.executor_address_public or settings.executor_address,
                    'type': 'python',
                    'version': '1.0.0',
                    'capabilities': ['python', 'shell'],
                    'maxConcurrentTasks': settings.max_concurrent_tasks,
                    'restartedAt': executor_started_at,
                    'startupId': executor_startup_id,
                },
                headers=headers,
                timeout=10,
            )
            # R9-fix: the old code logged "Registered" even on 4xx — check the
            # status and surface rejections (with a body summary) as errors.
            # N41 (round-10): the old "(will retry via heartbeat)" wording was
            # false — heartbeat never registers (unknown address → 404). The
            # only self-heal is the register-on-token side effect of
            # POST /executors/token in the heartbeat loop, which rebuilds the
            # row WITHOUT the rich metadata above (type/capabilities/
            # maxConcurrentTasks/version); full metadata returns only on
            # process restart.
            if not 200 <= response.status_code < 300:
                body_summary = (response.text or '')[:200]
                logger.error(
                    'Register rejected by admin-api: HTTP %s %s '
                    '(no auto re-register; /token fallback would rebuild the row without rich metadata)',
                    response.status_code,
                    body_summary,
                )
                return
            # R9 (round-9, W3 parity with executor-node main.ts): the
            # register response carries the stored tokenHash (N26) — adopt
            # it as the per-execution callback-token HMAC source secret.
            try:
                adopt_executor_token_hash(response.json())
            except Exception:  # pragma: no cover - non-JSON admin bodies
                pass
            logger.info('Registered to admin-api')
    except Exception as e:
        # N41 (round-10): no heartbeat re-register exists (heartbeat 404s for
        # unknown addresses); see the rejection branch above for the real
        # (lossy) self-heal path.
        logger.warning(f'Register failed (no auto re-register; /token fallback rebuilds the row without rich metadata): {e}')


app = FastAPI(
    title='AutoFlow Python Executor',
    version='1.0.0',
    lifespan=lifespan,
)

# S10: restrict CORS to explicit origin whitelist
_cors_origins = [o.strip() for o in os.environ.get('CORS_ORIGINS', 'http://localhost:5176').split(',') if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)
app.include_router(health.router)
app.include_router(execute.router, prefix='/api')
app.include_router(logs.router, prefix='/api')
app.include_router(config_router.router, prefix='/api')

if __name__ == '__main__':
    import uvicorn
    
    # Signal handlers for graceful shutdown
    def handle_signal(sig):
        global _shutting_down
        _shutting_down = True
        logger.info(f'Received signal {sig}, initiating graceful shutdown...')
    
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, partial(handle_signal, sig))
    # R-08 (windows-findings): SIGBREAK is Windows-only (Ctrl+Break); POSIX has
    # no such attribute, so register it only where it exists.
    _sigbreak = getattr(signal, 'SIGBREAK', None)
    if _sigbreak is not None:
        signal.signal(_sigbreak, partial(handle_signal, _sigbreak))
    
    uvicorn.run('main:app', host='0.0.0.0', port=settings.port, reload=False)
