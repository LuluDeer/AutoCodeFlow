import asyncio
import gc
import os
import tempfile
import warnings

import pytest
from fastapi.testclient import TestClient

# Override settings before importing main so the lifespan registration
# does not attempt a real HTTP call to admin-api during tests.
os.environ.setdefault('ADMIN_API_URL', 'http://localhost:9999')
os.environ.setdefault('EXECUTOR_ADDRESS', 'localhost:8001')
os.environ.setdefault('EXECUTOR_TOKEN', 'testsecret')
os.environ.setdefault('EXECUTOR_SHARED_TOKEN', 'testsecret')
os.environ.setdefault('APP_NAME', 'test-executor')
# E2: tests that exercise give-up paths now persist callbacks under
# settings.work_dir — keep that off the developer's real workdir unless a
# test explicitly overrides it (most fs-touching tests monkeypatch work_dir
# to their own tmp_path anyway).
os.environ.setdefault('WORK_DIR', tempfile.mkdtemp(prefix='acf-executor-tests-'))


@pytest.fixture(autouse=True)
def _close_asyncio_loops():
    """QA-11: pytest-asyncio 0.23.8 leaves every test's event loop open and
    relies on GC to reclaim it. When a LATER test GCs those loop/socket
    objects (e.g. httpx transports created inside asyncio.run after an async
    test), pytest surfaces the ResourceWarning as a cross-test unraisable
    attributed to whichever test happens to be running — the same class of
    flake the 86bf0ef fix chased. Closing the thread's loop (if any) at test
    end makes socket/loop reclamation deterministic and owned by the test
    that created it, which is what lets pytest.ini keep `filterwarnings =
    error` for ResourceWarning.
    """
    yield
    with warnings.catch_warnings():
        # get_event_loop() emits "There is no current event loop" on 3.12
        # when the policy has none — irrelevant here, we only want the
        # pytest-asyncio loop if it is still bound to this thread.
        warnings.simplefilter('ignore', DeprecationWarning)
        try:
            loop = asyncio.get_event_loop_policy().get_event_loop()
        except (RuntimeError, DeprecationWarning):
            loop = None
    if loop is not None and not loop.is_closed():
        try:
            loop.close()
        except Exception:  # pragma: no cover - loop already torn down
            pass
        asyncio.set_event_loop(None)
    # Flush pending __del__ ResourceWarnings NOW (inside the owning test)
    # instead of letting them land on whichever test runs next.
    gc.collect()


@pytest.fixture(scope='session')
def app():
    """Create the FastAPI application with the lifespan disabled for tests."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import config as config_router, execute, health, logs
    from fastapi.middleware.cors import CORSMiddleware

    _app = FastAPI(title='Test Executor')
    _app.add_middleware(
        CORSMiddleware,
        allow_origins=['*'],
        allow_methods=['*'],
        allow_headers=['*'],
    )
    _app.include_router(health.router)
    _app.include_router(execute.router, prefix='/api')
    _app.include_router(logs.router, prefix='/api')
    _app.include_router(config_router.router, prefix='/api')
    return _app


@pytest.fixture()
def client(app):
    """Unauthenticated test client."""
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def auth_client(app):
    """Test client that always sends the correct Bearer token."""
    with TestClient(app, headers={'Authorization': 'Bearer testsecret'}) as c:
        yield c


@pytest.fixture(autouse=True)
def _clear_live_executions():
    """E1/E7: the live-execution registry is module state. Route-level tests
    fake the background task (so the terminal callback never runs to evict the
    entry); clear before and after every test to keep the duplicate-accept
    guard and the heartbeat liveness report from leaking across tests. E2:
    also reset the dead-letter count cache and the retry-sweep stop flag so
    their module state never leaks between tests either."""
    from routers import execute as execute_module
    execute_module._live_executions.clear()
    execute_module._dead_letter_count_cache[0] = -1
    execute_module._callback_retry_stop.clear()
    yield
    execute_module._live_executions.clear()
    execute_module._dead_letter_count_cache[0] = -1
    execute_module._callback_retry_stop.clear()
