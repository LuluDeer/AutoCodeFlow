"""
Configuration hot-reload endpoint.
Allows admin-api to push configuration updates without executor restart.
"""
import os
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import AliasChoices, BaseModel, Field, ValidationError
from auth import verify_token
from config import settings
# A3-C：协议闸门/响应契约（由 packages/executor-protocol/protocol.json 生成，勿手改产物）
from generated.protocol_schemas import (
    ConfigReloadRequest as ProtocolConfigReloadRequest,
    ConfigReloadResponse as ProtocolConfigReloadResponse,
)
# E-22：list_active_execution_ids 定义在 routers/execute.py（main.py 以
# `from routers import execute` 装载），须用包路径导入；routers/__init__.py 先 import
# execute 再 import config，故此处无循环加载。
from routers.execute import list_active_execution_ids
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


class ConfigReloadRequest(BaseModel):
    """Configuration hot-reload request body."""
    max_concurrent_tasks: int | None = Field(
        default=None,
        validation_alias=AliasChoices('max_concurrent_tasks', 'maxConcurrentTasks'),
    )
    task_timeout_seconds: int | None = Field(
        default=None,
        validation_alias=AliasChoices('task_timeout_seconds', 'taskTimeoutSeconds'),
    )
    heartbeat_interval_seconds: int | None = Field(
        default=None,
        validation_alias=AliasChoices('heartbeat_interval_seconds', 'heartbeatIntervalSeconds'),
    )
    admin_api_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices('admin_api_url', 'adminApiUrl'),
    )
    admin_api_url_internal: str | None = Field(
        default=None,
        validation_alias=AliasChoices('admin_api_url_internal', 'adminApiUrlInternal'),
    )
    admin_api_url_external: str | None = Field(
        default=None,
        validation_alias=AliasChoices('admin_api_url_external', 'adminApiUrlExternal'),
    )
    # E-22（DEEP_REVIEW 0ef3bbe）：旧 ConfigReloadRequest 无 workDir 字段，pydantic
    # extra='ignore' 静默丢弃 admin 下发的 workDir 并返回 success:true（不含 workDir），
    # 调用方误以为热更生效——与 node routes/config.ts 完整支持 workDir 切换的能力漂移。
    # 现补齐 workDir 热更（两字段名都收，与 node 对齐）。
    work_dir: str | None = Field(
        default=None,
        validation_alias=AliasChoices('work_dir', 'workDir', 'WORK_DIR'),
    )


class ConfigReloadResponse(BaseModel):
    """Configuration hot-reload response."""
    success: bool
    message: str
    updated_fields: list[str]
    # E-22（DEEP_REVIEW 0ef3bbe）：请求里本端点不认识的键。pydantic 的
    # extra='ignore' 会把它们静默丢掉，旧响应仍是 success:true + 空
    # updated_fields——调用方（运维/UI）读起来像「已生效」。改为显式回报，
    # 字段名拼错/下发不支持项时不再静默成功。与 node routes/config.ts 同名同义。
    ignored_fields: list[str]


# /config/reload 真正支持的请求键（两种命名都算，与 ConfigReloadRequest 的
# AliasChoices 一一对应）。注意 adminApiUrls 只在 node 侧支持——python 侧收到
# 会如实列进 ignored_fields，而不是假装已应用。
_KNOWN_CONFIG_FIELDS = {
    'max_concurrent_tasks', 'maxConcurrentTasks',
    'task_timeout_seconds', 'taskTimeoutSeconds',
    'heartbeat_interval_seconds', 'heartbeatIntervalSeconds',
    'admin_api_url', 'adminApiUrl',
    'admin_api_url_internal', 'adminApiUrlInternal',
    'admin_api_url_external', 'adminApiUrlExternal',
    'work_dir', 'workDir', 'WORK_DIR',
}


def _conform_response(resp: 'ConfigReloadResponse') -> 'ConfigReloadResponse':
    """A3-C：出参必经**生成的**协议 schema——契约不再只是被测试引用的产物。

    本地 ConfigReloadResponse 与生成物字段同名同义，这里再让生成物过一遍：
    若以后有人把响应改回 camelCase / 漏掉 required 字段，会在运行时直接抛
    ValidationError（走 500），而不是把一个 admin/UI 无法解析的载荷静默发回。
    """
    ProtocolConfigReloadResponse.model_validate(resp.model_dump())
    return resp


@router.post('/config/reload', response_model=ConfigReloadResponse, dependencies=[Depends(verify_token)])
async def reload_config(req: ConfigReloadRequest, request: Request) -> ConfigReloadResponse:
    """
    Hot-reload configuration from admin-api.

    This endpoint allows updating executor configuration without restart.
    Only specified fields will be updated.
    """
    updated_fields = []
    ignored_fields: list[str] = []
    # E-22: 读原始 body 取「不认识的键」。Starlette 会缓存请求体，FastAPI 解析过
    # 一次后这里再 json() 拿的是同一份缓存，不会二次读 socket。
    try:
        raw_body = await request.json()
    except Exception:
        raw_body = None
    if isinstance(raw_body, dict):
        ignored_fields = sorted(k for k in raw_body if k not in _KNOWN_CONFIG_FIELDS)

    # A3-C：先做手检（数值下界，400 文案更具体且被既有用例钉住），再过协议
    # 闸门——与 executor-node routes/config.ts 同一原则：手检兜具体文案，生成的
    # schema 兜手检没覆盖的**类型/形状**错误（如 maxConcurrentTasks 传字符串、
    # adminApiUrls 传非数组），且必须发生在任何 settings 写入**之前**。
    if req.max_concurrent_tasks is not None and req.max_concurrent_tasks < 1:
        raise HTTPException(status_code=400, detail='max_concurrent_tasks must be >= 1')
    if req.task_timeout_seconds is not None and req.task_timeout_seconds < 1:
        raise HTTPException(status_code=400, detail='task_timeout_seconds must be >= 1')
    if req.heartbeat_interval_seconds is not None and req.heartbeat_interval_seconds < 5:
        raise HTTPException(status_code=400, detail='heartbeat_interval_seconds must be >= 5')
    if isinstance(raw_body, dict):
        try:
            # strict=True：pydantic 默认 lax 会把字符串 "4" 强转成 int，而 zod 与
            # JSON Schema 的 type:integer 都不强转。协议闸门要与 executor-node 同
            # 语义，必须用 strict，否则字符串型数值在 python 侧被静默洗白、node 侧 400。
            ProtocolConfigReloadRequest.model_validate(raw_body, strict=True)
        except ValidationError as exc:
            first = exc.errors()[0]
            where = '.'.join(str(p) for p in first['loc']) or '(root)'
            raise HTTPException(
                status_code=400,
                detail=f'Invalid config reload request: {where}: {first["msg"]}',
            ) from exc

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

        if req.admin_api_url_internal is not None:
            settings.admin_api_url_internal = req.admin_api_url_internal
            updated_fields.append('admin_api_url_internal')
            logger.info(f'Hot-reloaded admin_api_url_internal={req.admin_api_url_internal}')

        if req.admin_api_url_external is not None:
            settings.admin_api_url_external = req.admin_api_url_external
            updated_fields.append('admin_api_url_external')
            logger.info(f'Hot-reloaded admin_api_url_external={req.admin_api_url_external}')

        # E-22（DEEP_REVIEW 0ef3bbe）：WORK_DIR 热切换——新基目录必须过与 node
        # routes/config.ts 同一套四闸（规则不得漂移）：
        #   1) 绝对路径（Windows 盘符或 POSIX 根），无 ".." 段；
        #   2) 真实存在；
        #   3) 非 symlink；
        #   4) 旧目录上无活跃执行（避免运行中任务目录与清理/日志回捞脱钩）。
        # 全部消费方（logs/execute/maintenance）均在调用期读 settings.work_dir，
        # 改 settings.work_dir 即全链路惰性生效，无需模块级重算。
        if req.work_dir is not None:
            raw = req.work_dir.strip()
            is_absolute = os.path.isabs(raw) or (len(raw) >= 2 and raw[1] == ':')
            if not raw or not is_absolute:
                raise HTTPException(status_code=400, detail='workDir must be an absolute path')
            # 对原始路径段（resolve 之前）查 ".." 分量，对齐 node 的
            # /(^|[\\/])\.\.([\\/]|$)/ 正则——resolve() 会把 ".." 折叠掉，事后查不到。
            raw_parts = [p for p in re.split(r'[\\/]', raw) if p not in ('', '.')]
            if any(p == '..' for p in raw_parts):
                raise HTTPException(status_code=400, detail='workDir must not contain ".." segments')
            # E-22：symlink 判定必须在 resolve() **之前**——Path.resolve() 本身
            # 就会把符号链接规范化掉，对结果再 is_symlink() 恒为 False（旧写法
            # 等于没有这道闸，与 node 的 path.resolve(词法) + lstatSync 语义漂移）。
            candidate = Path(raw)
            if candidate.is_symlink():
                raise HTTPException(status_code=400, detail='workDir cannot be a symbolic link')
            resolved_new = candidate.resolve()
            if not resolved_new.exists():
                raise HTTPException(status_code=400, detail=f'workDir does not exist: {resolved_new}')
            active = list_active_execution_ids()
            if active:
                raise HTTPException(
                    status_code=400,
                    detail=f'workDir cannot change while {len(active)} execution(s) are running on the old directory',
                )
            settings.work_dir = str(resolved_new)
            # 同步真环境变量，与 node 写 process.env.WORK_DIR 对齐（裸机/子进程读取）。
            os.environ['WORK_DIR'] = str(resolved_new)
            updated_fields.append('workDir')
            logger.info(f'Hot-reloaded workDir={resolved_new}')

        if ignored_fields:
            logger.warning('Config reload ignored unsupported field(s): %s',
                           ', '.join(ignored_fields))

        if not updated_fields:
            return _conform_response(ConfigReloadResponse(
                success=True,
                message=(
                    'No fields to update (ignored unsupported field(s): '
                    f'{", ".join(ignored_fields)})'
                    if ignored_fields else 'No fields to update'
                ),
                updated_fields=[],
                ignored_fields=ignored_fields,
            ))

        return _conform_response(ConfigReloadResponse(
            success=True,
            message=f'Updated {len(updated_fields)} field(s)',
            updated_fields=updated_fields,
            ignored_fields=ignored_fields,
        ))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f'Config reload failed: {e}')
        raise HTTPException(status_code=500, detail=f'Config reload failed: {str(e)}')
