"""
Configuration hot-reload endpoint.
Allows admin-api to push configuration updates without executor restart.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from auth import verify_token
from config import settings
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


class ConfigReloadRequest(BaseModel):
    """Configuration hot-reload request body."""
    max_concurrent_tasks: int | None = None
    task_timeout_seconds: int | None = None
    heartbeat_interval_seconds: int | None = None
    admin_api_url: str | None = None


class ConfigReloadResponse(BaseModel):
    """Configuration hot-reload response."""
    success: bool
    message: str
    updated_fields: list[str]


@router.post('/config/reload', response_model=ConfigReloadResponse, dependencies=[Depends(verify_token)])
async def reload_config(req: ConfigReloadRequest) -> ConfigReloadResponse:
    """
    Hot-reload configuration from admin-api.
    
    This endpoint allows updating executor configuration without restart.
    Only specified fields will be updated.
    """
    updated_fields = []
    
    try:
        if req.max_concurrent_tasks is not None:
            if req.max_concurrent_tasks < 1:
                raise HTTPException(status_code=400, detail='max_concurrent_tasks must be >= 1')
            settings.max_concurrent_tasks = req.max_concurrent_tasks
            updated_fields.append('max_concurrent_tasks')
            logger.info(f'Hot-reloaded max_concurrent_tasks={req.max_concurrent_tasks}')
        
        if req.task_timeout_seconds is not None:
            if req.task_timeout_seconds < 1:
                raise HTTPException(status_code=400, detail='task_timeout_seconds must be >= 1')
            settings.task_timeout_seconds = req.task_timeout_seconds
            updated_fields.append('task_timeout_seconds')
            logger.info(f'Hot-reloaded task_timeout_seconds={req.task_timeout_seconds}')
        
        if req.heartbeat_interval_seconds is not None:
            if req.heartbeat_interval_seconds < 5:
                raise HTTPException(status_code=400, detail='heartbeat_interval_seconds must be >= 5')
            settings.heartbeat_interval_seconds = req.heartbeat_interval_seconds
            updated_fields.append('heartbeat_interval_seconds')
            logger.info(f'Hot-reloaded heartbeat_interval_seconds={req.heartbeat_interval_seconds}')
        
        if req.admin_api_url is not None:
            settings.admin_api_url = req.admin_api_url
            updated_fields.append('admin_api_url')
            logger.info(f'Hot-reloaded admin_api_url={req.admin_api_url}')
        
        if not updated_fields:
            return ConfigReloadResponse(success=True, message='No fields to update', updated_fields=[])
        
        return ConfigReloadResponse(
            success=True,
            message=f'Updated {len(updated_fields)} field(s)',
            updated_fields=updated_fields,
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Config reload failed: {e}')
        raise HTTPException(status_code=500, detail=f'Config reload failed: {str(e)}')
