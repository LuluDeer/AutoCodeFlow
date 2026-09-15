from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from auth import verify_token
from config import settings
# A3（kill/logs 契约化）：出参契约（由 protocol.json 生成，勿手改产物）
from generated.protocol_schemas import LogsResponse as ProtocolLogsResponse

router = APIRouter()


class LogsResponse(BaseModel):
    lines: list[str]
    totalLines: int
    hasMore: bool


@router.get(
    '/logs/{execution_id}',
    response_model=LogsResponse,
    dependencies=[Depends(verify_token)],
)
def get_execution_logs(
    execution_id: str,
    fromLine: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=2000),
) -> LogsResponse:
    # Path traversal guard: reject IDs that contain '..' or path separators
    if '..' in execution_id or '/' in execution_id or '\\' in execution_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Invalid executionId')
    base = Path(settings.work_dir).resolve()
    # B-05: log is written inside the execution's work subdirectory by execute.py
    log_file = (base / execution_id / f'{execution_id}.log').resolve()
    if not str(log_file).startswith(str(base)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Invalid executionId')

    if not log_file.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Log file not found')

    # E-21（DEEP_REVIEW 0ef3bbe）：旧实现 read_text().splitlines() 把整份日志（上限
    # 64MB，MAX_LOG_FILE_BYTES）每请求全量读入内存并 splitlines（~3x 峰值内存），
    # admin LOG-01 回填按 2000 行/页翻页——每页请求都重读整个 64MB。改为按行流式
    # 迭代（Python buffered IO，逐行 yield，永不整文件驻留内存），语义与 node
    # routes/logs.ts pageLogLines 完全对齐：整文件走一遍以维持 totalLines 正确，
    # 但只缓存落在 [fromLine, fromLine+limit) 窗口内的行。
    total = 0
    window: list[str] = []
    with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
        for raw in f:
            # rl.on('line') 按 '\n' 切并去掉换行符；splitlines 还会吞末尾 '\r'。
            line = raw.rstrip('\r\n')
            if fromLine <= total < fromLine + limit:
                window.append(line)
            total += 1
    result = LogsResponse(lines=window, totalLines=total, hasMore=fromLine + len(window) < total)
    # A3：再让**生成的** LogsResponse 过一遍（与 executor-node 同源、forbid 额外键）——
    # 本地 response_model 管序列化，生成物管「两侧形状不漂移」，缺字段/改字段名在此抛错。
    ProtocolLogsResponse.model_validate(result.model_dump())
    return result
