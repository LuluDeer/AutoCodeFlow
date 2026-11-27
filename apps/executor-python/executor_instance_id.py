"""执行器行 id 的本地持久化（工单 11 / ADR-017 §3，python 侧对等实现）。

与 node ``src/executor-instance-id.ts`` 同形：注册响应里的 ``id``（executors
表行 id）写入 ``<WORK_DIR>/.device-identity/<kind>.instance``，后续 pull /
config / heartbeat 一并回传，使中台在「同址多行 + 指纹采集失败」的歧义态
下可以按行定位，而不是 fail-closed 把合法执行器拒成 404。

安全边界：id 来自注册响应且是 LOCAL 落盘值，只在本执行器持有 per-executor
令牌的前提下作为线索上报；服务端不会仅凭自报 id 授权（见 admin-api
authenticateMachineRequest）。写盘失败 best-effort 降级为不报告，绝不阻断
注册/心跳主链。
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Optional

from config import settings
from device_identity import DEVICE_IDENTITY_DIR_NAME, resolve_instance_kind

logger = logging.getLogger(__name__)

# 与 node EXECUTOR_ID_RE 对齐：uuid 文本（长度上限防脏文件污染请求体）。
EXECUTOR_ID_RE = re.compile(r'^[0-9a-fA-F-]{8,64}$')

_cached: Optional[str] = None
_cached_key: Optional[tuple[str, str]] = None


def executor_instance_id_path(work_dir: str, kind: str) -> str:
    return str(Path(work_dir) / DEVICE_IDENTITY_DIR_NAME / f'{kind}.instance')


def read_persisted_executor_instance_id(
    work_dir: Optional[str] = None, kind: Optional[str] = None
) -> Optional[str]:
    """读本地已持久化的行 id；缺失/非法/读失败一律 None（视同未上报）。"""
    path = executor_instance_id_path(
        work_dir or settings.work_dir, kind or resolve_instance_kind()
    )
    try:
        raw = Path(path).read_text(encoding='utf-8').strip()
        return raw if EXECUTOR_ID_RE.match(raw) else None
    except OSError:
        return None


def get_executor_instance_id(
    work_dir: Optional[str] = None, kind: Optional[str] = None
) -> Optional[str]:
    """进程级缓存的行 id（惰性读盘，注册成功后由 persist 覆盖）。"""
    global _cached, _cached_key
    key = (work_dir or settings.work_dir, kind or resolve_instance_kind())
    if _cached_key != key:
        _cached = read_persisted_executor_instance_id(*key)
        _cached_key = key
    return _cached


def persist_executor_instance_id(
    raw: Any, work_dir: Optional[str] = None, kind: Optional[str] = None
) -> Optional[str]:
    """持久化注册响应里的行 id（best-effort，失败只 warn 不抛）。"""
    global _cached, _cached_key
    key = (work_dir or settings.work_dir, kind or resolve_instance_kind())
    instance_id = raw.strip() if isinstance(raw, str) else ''
    if not EXECUTOR_ID_RE.match(instance_id):
        # 旧中台未下发 id 不是错误；返回已有本地值，保持调用方形状稳定。
        return get_executor_instance_id(*key)
    if get_executor_instance_id(*key) == instance_id:
        return instance_id
    try:
        target = Path(executor_instance_id_path(*key))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(instance_id, encoding='utf-8')
        try:
            target.chmod(0o600)
        except OSError:  # pragma: no cover - Windows 上 chmod 语义有限
            pass
        logger.info('Adopted executor row id %s from the register response', instance_id)
    except OSError as exc:
        logger.warning('Failed to persist executor row id (falling back to fingerprint identity): %s', exc)
    _cached = instance_id
    _cached_key = key
    return instance_id


def reset_for_test() -> None:
    """测试出口：清空进程级缓存（盘上文件仍在）。"""
    global _cached, _cached_key
    _cached = None
    _cached_key = None
