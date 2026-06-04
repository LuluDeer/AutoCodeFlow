import os
from fastapi import Header, HTTPException, status

_EXECUTOR_SECRET = os.environ.get('EXECUTOR_SHARED_TOKEN') or os.environ.get('EXECUTOR_SECRET') or ''


async def verify_token(authorization: str = Header(default='')) -> None:
    """Dependency: validate Bearer token from EXECUTOR_SHARED_TOKEN / EXECUTOR_SECRET env."""
    if not _EXECUTOR_SECRET:
        # Dev mode: no secret configured, allow all
        return
    scheme, _, token = authorization.partition(' ')
    if scheme.lower() != 'bearer' or token != _EXECUTOR_SECRET:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='Invalid or missing executor token',
            headers={'WWW-Authenticate': 'Bearer'},
        )
