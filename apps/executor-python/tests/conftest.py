import os
import tempfile

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
