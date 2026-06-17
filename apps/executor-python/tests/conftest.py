import os
import pytest
from fastapi.testclient import TestClient

# Override settings before importing main so the lifespan registration
# does not attempt a real HTTP call to admin-api during tests.
os.environ.setdefault('ADMIN_API_URL', 'http://localhost:9999')
os.environ.setdefault('EXECUTOR_ADDRESS', 'localhost:8001')
os.environ.setdefault('EXECUTOR_TOKEN', 'testsecret')
os.environ.setdefault('EXECUTOR_SHARED_TOKEN', 'testsecret')
os.environ.setdefault('APP_NAME', 'test-executor')


@pytest.fixture(scope='session')
def app():
    """Create the FastAPI application with the lifespan disabled for tests."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers import execute, health, logs
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
