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
from admin_api import build_admin_api_url, get_admin_api_base_url
from config import settings
from scheduler import heartbeat_task, get_running_count
from auth import get_current_token

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
    # Register to admin-api on startup
    await register_executor()
    # Start heartbeat background task
    _heartbeat_task = asyncio.create_task(heartbeat_task())
    logger.info(f'Executor started: {settings.app_name} @ {settings.executor_address}')
    yield
    # Graceful shutdown: wait for running tasks to complete
    _heartbeat_task.cancel()
    if get_running_count() > 0:
        logger.info(f'Graceful shutdown: waiting for {get_running_count()} task(s) to finish...')
        await wait_for_tasks()
    await notify_offline()
    logger.info('Executor shutdown complete')


async def register_executor():
    try:
        token = await get_current_token()
        headers = {'Authorization': f'Bearer {token}'} if token else {}
        async with httpx.AsyncClient() as client:
            await client.post(
                build_admin_api_url('/executors/register'),
                json={
                    'appName': settings.app_name,
                    'address': settings.executor_address_public or settings.executor_address,
                    'type': 'python',
                    'version': '1.0.0',
                    'capabilities': ['python', 'shell'],
                    'maxConcurrentTasks': settings.max_concurrent_tasks,
                },
                headers=headers,
                timeout=10,
            )
            logger.info('Registered to admin-api')
    except Exception as e:
        logger.warning(f'Register failed (will retry via heartbeat): {e}')


app = FastAPI(
    title='AutoFlow Python Executor',
    version='1.0.0',
    lifespan=lifespan,
)

# S10: restrict CORS to explicit origin whitelist
_cors_origins = [o.strip() for o in os.environ.get('CORS_ORIGINS', 'http://localhost:5173').split(',') if o.strip()]
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
    
    uvicorn.run('main:app', host='0.0.0.0', port=settings.port, reload=False)
