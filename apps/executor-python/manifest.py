"""manifest.yaml 解析工具"""
import logging
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore

logger = logging.getLogger(__name__)


def load_manifest(work_dir: Path) -> dict[str, Any]:
    """从工作目录加载 manifest.yaml，不存在则返回空 dict。"""
    manifest_path = work_dir / 'manifest.yaml'
    if not manifest_path.exists():
        manifest_path = work_dir / 'manifest.yml'
    if not manifest_path.exists():
        return {}

    if yaml is None:
        logger.warning('PyYAML not installed, cannot parse manifest.yaml')
        return {}

    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f) or {}
        logger.info(f'Loaded manifest: {manifest_path}')
        return data
    except Exception as e:
        logger.warning(f'Failed to parse manifest: {e}')
        return {}


def merge_task_with_manifest(task: dict, manifest: dict) -> dict:
    """用 manifest 的值补充 task 中缺失的字段（task 优先）。"""
    merged = {**manifest, **task}
    # requirements 合并（manifest 和 task 都可能有）
    m_reqs = manifest.get('requirements', [])
    t_reqs = task.get('requirements', [])
    if m_reqs or t_reqs:
        merged['requirements'] = list(dict.fromkeys(m_reqs + t_reqs))
    return merged
