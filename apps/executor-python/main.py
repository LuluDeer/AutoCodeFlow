from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import asyncio
import logging
import os
import httpx

from routers import execute, health
from config import settings
from scheduler import heartbeat_task

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时注册到 admin-api
    await register_executor()
    # 启动心跳后台任务
    task = asyncio.create_task(heartbeat_task())
    logger.info(f'Executor started: {settings.app_name} @ {settings.executor_address}')
    yield
    task.cancel()


async def register_executor():
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f'{settings.admin_api_url}/api/executors/register',
                json={
                    'appName': settings.app_name,
                    'address': settings.executor_address,
                    'type': 'python',
                    'version': '1.0.0',
                    'capabilities': ['python', 'shell'],
                },
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

app.include_router(health.router)
app.include_router(execute.router, prefix='/api')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('main:app', host='0.0.0.0', port=settings.port, reload=False)
