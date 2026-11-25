"""manifest.yaml parsing utility"""
import logging
from collections.abc import Mapping
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
            raw = yaml.safe_load(f)
        data = raw if raw is not None else {}
        if not isinstance(data, Mapping):
            logger.warning(
                f'Ignoring manifest with non-mapping top level: '
                f'{manifest_path} ({type(data).__name__})'
            )
            return {}
        logger.info(f'Loaded manifest: {manifest_path}')
        return dict(data)
    except Exception as e:
        logger.warning(f'Failed to parse manifest: {e}')
        return {}


_INVALID_REQUIREMENTS = object()


def _valid_requirements(value: Any, source: str) -> Any:
    """Return value only when it is truly list[str]; otherwise a sentinel."""
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        logger.warning('Ignoring non-list[str] requirements from %s: %r', source, value)
        return _INVALID_REQUIREMENTS
    return value


def merge_task_with_manifest(task: dict, manifest: dict) -> dict:
    """Fill in missing task fields with manifest values (task fields take priority)."""
    merged = {**manifest, **task}
    # Merge requirements (both manifest and task may have them). Malformed
    # sides are ignored instead of concatenated: a bare string used to become
    # a list of single-character package names (or blow up on list + str).
    m_reqs = _valid_requirements(manifest.get('requirements', []), 'manifest')
    t_reqs = _valid_requirements(task.get('requirements', []), 'task')

    if m_reqs is _INVALID_REQUIREMENTS and t_reqs is _INVALID_REQUIREMENTS:
        merged['requirements'] = []
    elif m_reqs is _INVALID_REQUIREMENTS:
        merged['requirements'] = list(dict.fromkeys(t_reqs))
    elif t_reqs is _INVALID_REQUIREMENTS:
        merged['requirements'] = list(dict.fromkeys(m_reqs))
    elif m_reqs or t_reqs:
        merged['requirements'] = list(dict.fromkeys(m_reqs + t_reqs))
    return merged
