import os

import pytest

from config import settings


def test_reload_config_accepts_admin_api_camel_case_payload(auth_client, monkeypatch):
    monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)
    monkeypatch.setattr(settings, 'task_timeout_seconds', 300)
    monkeypatch.setattr(settings, 'heartbeat_interval_seconds', 30)
    monkeypatch.setattr(settings, 'admin_api_url', 'http://old-admin:3105')
    monkeypatch.setattr(settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(settings, 'admin_api_url_external', '')

    resp = auth_client.post('/api/config/reload', json={
        'maxConcurrentTasks': 4,
        'taskTimeoutSeconds': 120,
        'heartbeatIntervalSeconds': 15,
        'adminApiUrl': 'http://new-admin:3105/api',
        'adminApiUrlInternal': 'http://new-admin-internal:3105/api',
        'adminApiUrlExternal': 'http://new-admin-external:3105/api',
    })

    assert resp.status_code == 200
    assert resp.json() == {
        'success': True,
        'message': 'Updated 6 field(s)',
        'updated_fields': [
            'max_concurrent_tasks',
            'task_timeout_seconds',
            'heartbeat_interval_seconds',
            'admin_api_url',
            'admin_api_url_internal',
            'admin_api_url_external',
        ],
        # E-22: 未识别的键显式回报（本请求全是已知键 → 空）
        'ignored_fields': [],
    }
    assert settings.max_concurrent_tasks == 4
    assert settings.task_timeout_seconds == 120
    assert settings.heartbeat_interval_seconds == 15
    assert settings.admin_api_url == 'http://new-admin:3105/api'
    assert settings.admin_api_url_internal == 'http://new-admin-internal:3105/api'
    assert settings.admin_api_url_external == 'http://new-admin-external:3105/api'


def test_reload_config_keeps_snake_case_payload_compatibility(auth_client, monkeypatch):
    monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)

    resp = auth_client.post('/api/config/reload', json={'max_concurrent_tasks': 2})

    assert resp.status_code == 200
    assert resp.json()['updated_fields'] == ['max_concurrent_tasks']
    assert settings.max_concurrent_tasks == 2


def test_reload_config_validates_camel_case_payload(auth_client):
    resp = auth_client.post('/api/config/reload', json={'maxConcurrentTasks': 0})

    assert resp.status_code == 400
    assert resp.json()['detail'] == 'max_concurrent_tasks must be >= 1'


def test_reload_config_requires_auth(client):
    resp = client.post('/api/config/reload', json={'maxConcurrentTasks': 4})

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# E-22（DEEP_REVIEW 0ef3bbe）：workDir 热更 + 未识别字段不再静默 success。
# 旧实现 ConfigReloadRequest 里没有 workDir，pydantic extra='ignore' 静默丢弃
# 后照样返回 success:true（updated_fields 为空）——调用方以为已生效。
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('field', ['work_dir', 'workDir', 'WORK_DIR'])
def test_reload_config_hot_swaps_work_dir(auth_client, tmp_path, monkeypatch, field):
    new_dir = tmp_path / 'new-work-dir'
    new_dir.mkdir()
    monkeypatch.setattr(settings, 'work_dir', str(tmp_path / 'old'))
    monkeypatch.setenv('WORK_DIR', str(tmp_path / 'old'))
    monkeypatch.setattr('routers.config.list_active_execution_ids', lambda: [])

    resp = auth_client.post('/api/config/reload', json={field: str(new_dir)})

    assert resp.status_code == 200
    body = resp.json()
    assert body['success'] is True
    assert body['updated_fields'] == ['workDir']
    assert body['ignored_fields'] == []
    # settings 与真实 env 同步更新（裸机子进程/惰性读取路径都生效）
    assert settings.work_dir == str(new_dir.resolve())
    assert os.environ['WORK_DIR'] == str(new_dir.resolve())


def test_reload_config_rejects_relative_work_dir(auth_client):
    resp = auth_client.post('/api/config/reload', json={'workDir': 'relative/path'})

    assert resp.status_code == 400
    assert resp.json()['detail'] == 'workDir must be an absolute path'


def test_reload_config_rejects_parent_segments(auth_client, tmp_path):
    target = str(tmp_path / '..' / 'escape')

    resp = auth_client.post('/api/config/reload', json={'workDir': target})

    assert resp.status_code == 400
    assert resp.json()['detail'] == 'workDir must not contain ".." segments'


def test_reload_config_rejects_missing_work_dir(auth_client, tmp_path):
    missing = tmp_path / 'does-not-exist'

    resp = auth_client.post('/api/config/reload', json={'workDir': str(missing)})

    assert resp.status_code == 400
    assert 'workDir does not exist' in resp.json()['detail']


def test_reload_config_rejects_symlink_work_dir(auth_client, tmp_path):
    real = tmp_path / 'real-dir'
    real.mkdir()
    link = tmp_path / 'link-dir'
    try:
        link.symlink_to(real, target_is_directory=True)
    except (OSError, NotImplementedError):  # pragma: no cover - Windows 无权限
        pytest.skip('symlink creation not permitted on this platform')

    resp = auth_client.post('/api/config/reload', json={'workDir': str(link)})

    assert resp.status_code == 400
    assert resp.json()['detail'] == 'workDir cannot be a symbolic link'


def test_reload_config_rejects_work_dir_change_with_running_executions(
    auth_client, tmp_path, monkeypatch
):
    new_dir = tmp_path / 'busy-target'
    new_dir.mkdir()
    monkeypatch.setattr('routers.config.list_active_execution_ids', lambda: ['exec-1', 'exec-2'])

    resp = auth_client.post('/api/config/reload', json={'workDir': str(new_dir)})

    assert resp.status_code == 400
    assert '2 execution(s) are running' in resp.json()['detail']


def test_reload_config_reports_unknown_fields_instead_of_silent_success(auth_client):
    """E-22: 不支持的键必须显式回报，不能只回 success:true + 空 updated_fields。"""
    resp = auth_client.post('/api/config/reload', json={
        'logRetentionDays': 3,
        'maxConcurrentTask': 5,  # 拼错（少个 s）
    })

    assert resp.status_code == 200
    body = resp.json()
    assert body['success'] is True
    assert body['updated_fields'] == []
    assert body['ignored_fields'] == ['logRetentionDays', 'maxConcurrentTask']
    assert 'ignored unsupported field(s)' in body['message']


def test_reload_config_reports_ignored_fields_alongside_applied_ones(auth_client, monkeypatch):
    monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)

    resp = auth_client.post('/api/config/reload', json={
        'maxConcurrentTasks': 3,
        'adminApiUrls': ['http://a:3105'],  # node 支持、python 不支持
    })

    assert resp.status_code == 200
    body = resp.json()
    assert body['updated_fields'] == ['max_concurrent_tasks']
    assert body['ignored_fields'] == ['adminApiUrls']
    assert settings.max_concurrent_tasks == 3


def test_reload_config_ignored_fields_empty_for_known_keys(auth_client, monkeypatch):
    monkeypatch.setattr(settings, 'heartbeat_interval_seconds', 30)

    resp = auth_client.post('/api/config/reload', json={'heartbeatIntervalSeconds': 20})

    assert resp.status_code == 200
    assert resp.json()['ignored_fields'] == []
    assert settings.heartbeat_interval_seconds == 20


# ---------------------------------------------------------------------------
# A3-C（DEEP_REVIEW 0ef3bbe §七 残差收口）：ConfigReload 的生成 schema 不再只被
# 测试引用——请求过协议闸门、出参过生成 schema。下列用例让这条接线「有牙」。
# ---------------------------------------------------------------------------


def test_reload_config_rejects_non_numeric_max_concurrent_via_protocol_gate(auth_client, monkeypatch):
    """字符串型 maxConcurrentTasks 手检（< 1 数值比较）抓不到，必须由协议闸门 400。"""
    monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)

    resp = auth_client.post('/api/config/reload', json={'maxConcurrentTasks': '4'})

    assert resp.status_code == 400
    assert 'Invalid config reload request: maxConcurrentTasks' in resp.json()['detail']
    # 畸形载荷在任何写入之前被拒
    assert settings.max_concurrent_tasks == 10


def test_reload_config_rejects_non_array_admin_api_urls_via_protocol_gate(auth_client):
    """协议声明 adminApiUrls 为数组；python 虽不应用它，但畸形类型必须 400（合法数组仍 ignored）。"""
    resp = auth_client.post('/api/config/reload', json={'adminApiUrls': 'http://only-one'})

    assert resp.status_code == 400
    assert 'adminApiUrls' in resp.json()['detail']


def test_reload_config_well_formed_admin_api_urls_array_is_ignored_not_rejected(auth_client):
    """对照：合法数组不被协议闸门拦（python 选择不应用，列入 ignored_fields）。"""
    resp = auth_client.post('/api/config/reload', json={'adminApiUrls': ['http://a:3105']})

    assert resp.status_code == 200
    assert resp.json()['ignored_fields'] == ['adminApiUrls']


@pytest.mark.parametrize('payload', [
    {},
    {'maxConcurrentTasks': 4},
    {'workDir': '/tmp/x', 'adminApiUrls': ['http://a']},
])
def test_reload_config_request_vectors_pass_generated_schema(payload):
    from generated.protocol_schemas import ConfigReloadRequest as ProtocolRequest

    # 不抛即通过（与 executor-node 跑同一份 protocol.json 向量）
    ProtocolRequest.model_validate(payload)


def test_reload_config_response_body_conforms_to_generated_schema(auth_client, monkeypatch):
    """反证有牙：真实出参必须能被**生成的** ConfigReloadResponse 接受。"""
    from generated.protocol_schemas import ConfigReloadResponse as ProtocolResponse

    monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)
    applied = auth_client.post('/api/config/reload', json={'maxConcurrentTasks': 3})
    assert applied.status_code == 200
    ProtocolResponse.model_validate(applied.json())  # 不抛即契约一致

    empty = auth_client.post('/api/config/reload', json={})
    assert empty.status_code == 200
    ProtocolResponse.model_validate(empty.json())

    ignored = auth_client.post('/api/config/reload', json={'totallyUnknown': 1})
    assert ignored.status_code == 200
    ProtocolResponse.model_validate(ignored.json())
