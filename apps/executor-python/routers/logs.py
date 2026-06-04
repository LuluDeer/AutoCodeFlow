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
) -> LogsResponse:
    # Path traversal guard
    base = Path(settings.work_dir).resolve()
    log_file = (base / f'{execution_id}.log').resolve()
    if not str(log_file).startswith(str(base)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Invalid executionId')

    if not log_file.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Log file not found')

    all_lines = log_file.read_text(encoding='utf-8', errors='replace').splitlines()
    total = len(all_lines)
    sliced = all_lines[fromLine:]
    return LogsResponse(lines=sliced, totalLines=total, hasMore=False)
