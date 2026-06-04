from fastapi import APIRouter
import psutil
from config import settings

router = APIRouter()


@router.get('/health')
async def health():
    return {
        'status': 'ok',
        'appName': settings.app_name,
        'address': settings.executor_address,
        'cpu': psutil.cpu_percent(),
        'mem': psutil.virtual_memory().percent,
    }
