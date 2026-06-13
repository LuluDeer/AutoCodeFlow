"""manifest.yaml parsing utility"""
import logging
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore

logger = logging.getLogger(__name__)


def load_manifest(work_dir: Path) -> dict[str, Any]:
    """Load manifest.yaml from the working directory. Returns an empty dict if not found."""
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
    """Fill in missing task fields with manifest values (task fields take priority)."""
    merged = {**manifest, **task}
    # Merge requirements (both manifest and task may have them)
    m_reqs = manifest.get('requirements', [])
    t_reqs = task.get('requirements', [])
    if m_reqs or t_reqs:
        merged['requirements'] = list(dict.fromkeys(m_reqs + t_reqs))
    return merged
