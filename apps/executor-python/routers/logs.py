from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from auth import verify_token
from config import settings

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

    all_lines = log_file.read_text(encoding='utf-8', errors='replace').splitlines()
    total = len(all_lines)
    sliced = all_lines[fromLine:fromLine + limit]
    return LogsResponse(lines=sliced, totalLines=total, hasMore=fromLine + len(sliced) < total)
