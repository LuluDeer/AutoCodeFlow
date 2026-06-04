import asyncio
import logging
import httpx
from config import settings
import psutil

logger = logging.getLogger(__name__)

# 全局运行中任务数
running_count = 0


async def heartbeat_task():
    while True:
        try:
            await asyncio.sleep(30)
            cpu = psutil.cpu_percent(interval=1)
            mem = psutil.virtual_memory().percent
            # S5/S14: include shared token in heartbeat
            import os as _os
            _token = _os.environ.get('EXECUTOR_SHARED_TOKEN')
            _headers = {'Authorization': f'Bearer {_token}'} if _token else {}
            async with httpx.AsyncClient() as client:
                await client.post(
                    f'{settings.admin_api_url}/api/executors/heartbeat',
                    json={
                        'address': settings.executor_address,
                        'cpuUsage': cpu,
                        'memUsage': mem,
                        'runningTaskCount': running_count,
                    },
                    headers=_headers,
                    timeout=5,
                )
        except Exception as e:
            logger.warning(f'Heartbeat failed: {e}')
