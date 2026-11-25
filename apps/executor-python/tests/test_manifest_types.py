"""Type-hardening tests for manifest.yaml loading / merging."""
import logging

import pytest

import manifest as manifest_module
from manifest import load_manifest, merge_task_with_manifest


@pytest.mark.parametrize(
    'task, manifest, expected',
    [
        ({'requirements': ['numpy']}, {'requirements': 'requests'}, ['numpy']),
        (
            {'requirements': 'requests'},
            {'requirements': ['numpy', 'pandas']},
            ['numpy', 'pandas'],
        ),
        ({'requirements': 'ab'}, {'requirements': 'cd'}, []),
        ({'requirements': ['numpy', 123]}, {'requirements': ['pandas']}, ['pandas']),
        ({'requirements': ['numpy']}, {'requirements': [123, 'pandas']}, ['numpy']),
    ],
)
def test_merge_requirements_ignores_malformed_sides(task, manifest, expected):
    """Malformed requirements never concatenate into single-character packages."""
    merged = merge_task_with_manifest(task, manifest)
    reqs = merged.get('requirements', [])
    assert reqs == expected
    assert not any(isinstance(item, str) and len(item) == 1 for item in reqs)


def test_merge_valid_list_str_keeps_order_and_dedup():
    """Valid list[str] merge keeps manifest-first order and stable dedup."""
    merged = merge_task_with_manifest(
        {'requirements': ['b', 'c', 'b']},
        {'requirements': ['a', 'b', 'a']},
    )
    assert merged['requirements'] == ['a', 'b', 'c']


def test_merge_valid_empty_lists_do_not_invent_requirements():
    merged = merge_task_with_manifest({'requirements': []}, {'requirements': []})
    assert merged['requirements'] == []


@pytest.mark.parametrize(
    'content',
    ['"requests"\n', '- a\n- b\n', '123\n', '[]\n'],
)
def test_load_manifest_returns_empty_for_non_mapping(tmp_path, content, caplog):
    (tmp_path / 'manifest.yaml').write_text(content, encoding='utf-8')
    with caplog.at_level(logging.WARNING, logger=manifest_module.logger.name):
        assert load_manifest(tmp_path) == {}
    assert 'non-mapping' in caplog.text


def test_load_manifest_keeps_valid_mapping(tmp_path):
    (tmp_path / 'manifest.yaml').write_text(
        'name: demo\nrequirements:\n  - numpy\n',
        encoding='utf-8',
    )
    assert load_manifest(tmp_path) == {'name': 'demo', 'requirements': ['numpy']}
