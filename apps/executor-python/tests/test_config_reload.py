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
