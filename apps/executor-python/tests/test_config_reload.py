import os

import pytest

from config import settings, MAX_RUNNING_EXECUTION_IDS


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
        'message': '已更新 6 个字段',
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
    assert resp.json()['detail'] == 'max_concurrent_tasks 必须 >= 1'


class TestMaxConcurrentTasksUpperBound:
    """NETOPT-D P3-5 对齐：max_concurrent_tasks 必须有上界
    （MAX_RUNNING_EXECUTION_IDS = 10000），与 node routes/config.ts 的
    'between 1 and 10000' 同语义。

    反证（本类的存在理由）：此前 python **只检下界**，故 `maxConcurrentTasks:
    50000` 会被 200 接受并真的放行 50000 并发——而心跳体 runningExecutionIds
    只报得出 10000 条，第 10001+ 个在跑执行从 admin stale sweep 的活性判据里
    消失，被提前恢复成 FAILED。这条用例把这个入口钉死。
    """

    def test_rejects_above_cap(self, auth_client, monkeypatch):
        monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)
        resp = auth_client.post(
            '/api/config/reload',
            json={'maxConcurrentTasks': MAX_RUNNING_EXECUTION_IDS + 1},
        )
        assert resp.status_code == 400
        assert resp.json()['detail'] == (
            f'max_concurrent_tasks 必须在 1 到 {MAX_RUNNING_EXECUTION_IDS} 之间'
        )
        # 关键：拒绝必须发生在**任何写入之前**（否则 settings 已被污染）
        assert settings.max_concurrent_tasks == 10

    def test_rejects_absurd_value(self, auth_client, monkeypatch):
        """反证有牙：旧实现会接受 50000（仅下界检查）。"""
        monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)
        resp = auth_client.post('/api/config/reload', json={'maxConcurrentTasks': 50000})
        assert resp.status_code == 400
        assert settings.max_concurrent_tasks == 10

    def test_accepts_cap_boundary(self, auth_client, monkeypatch):
        """边界值本身必须放行（上界是闭区间，与 node 的 > 10000 判据一致）。"""
        monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)
        resp = auth_client.post(
            '/api/config/reload',
            json={'maxConcurrentTasks': MAX_RUNNING_EXECUTION_IDS},
        )
        assert resp.status_code == 200
        assert resp.json()['updated_fields'] == ['max_concurrent_tasks']
        assert settings.max_concurrent_tasks == MAX_RUNNING_EXECUTION_IDS

    def test_env_value_is_clamped_not_rejected(self):
        """env 走**钳制**（与 node config.ts 的 Math.min(Math.max(...)) 同语义）：
        运维把 MAX_CONCURRENT_TASKS 设到天上时执行器仍要能起来——钳到上界比
        启动失败更符合「活性优先」。reload 端点则是 400（交互式推送，能立刻
        反馈给推送方）。
        """
        from config import Settings

        over = Settings(max_concurrent_tasks=MAX_RUNNING_EXECUTION_IDS + 12345)
        assert over.max_concurrent_tasks == MAX_RUNNING_EXECUTION_IDS

        under = Settings(max_concurrent_tasks=0)
        assert under.max_concurrent_tasks == 1

        ok = Settings(max_concurrent_tasks=37)
        assert ok.max_concurrent_tasks == 37


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
    assert resp.json()['detail'] == 'workDir 必须是绝对路径'


def test_reload_config_rejects_parent_segments(auth_client, tmp_path):
    target = str(tmp_path / '..' / 'escape')

    resp = auth_client.post('/api/config/reload', json={'workDir': target})

    assert resp.status_code == 400
    assert resp.json()['detail'] == 'workDir 不得包含 ".." 片段'


def test_reload_config_rejects_missing_work_dir(auth_client, tmp_path):
    missing = tmp_path / 'does-not-exist'

    resp = auth_client.post('/api/config/reload', json={'workDir': str(missing)})

    assert resp.status_code == 400
    assert 'workDir 不存在' in resp.json()['detail']


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
    assert resp.json()['detail'] == 'workDir 不能是符号链接'


def test_reload_config_rejects_work_dir_change_with_running_executions(
    auth_client, tmp_path, monkeypatch
):
    new_dir = tmp_path / 'busy-target'
    new_dir.mkdir()
    monkeypatch.setattr('routers.config.list_active_execution_ids', lambda: ['exec-1', 'exec-2'])

    resp = auth_client.post('/api/config/reload', json={'workDir': str(new_dir)})

    assert resp.status_code == 400
    assert '旧目录上仍有 2 个执行在运行' in resp.json()['detail']


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
    assert '已忽略不支持的字段' in body['message']


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
    assert '无效的 config reload 请求：maxConcurrentTasks' in resp.json()['detail']
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

# ---------------------------------------------------------------------------
# NETOPT-9-5 对齐：heartbeat_interval_seconds 必须有**上界** 60。
#
# 反证（本组用例的存在理由）：此前 python 只检下界（< 5），而 node
# routes/config.ts 对同一载荷回 400。热更到 120 之后，admin 的 stale sweep 仍用
# **自身** interval ×3（默认 30s×3=90s）判 OFFLINE——每两次心跳之间的空档都落在
# stale 窗之外，执行器被判离线、派发静默停止，且只有重启能救回。
# 又因为 pydantic 未开 validate_assignment，`settings.x = v` 这种裸赋值**不**触发
# Settings 的 5..60 钳制（实测 120 会原样写进去），所以端点自身必须是那道闸。
# ---------------------------------------------------------------------------
class TestHeartbeatIntervalUpperBound:
    def test_rejects_above_60_before_any_write(self, auth_client, monkeypatch):
        monkeypatch.setattr(settings, 'heartbeat_interval_seconds', 30)
        monkeypatch.setattr(settings, 'max_concurrent_tasks', 10)

        resp = auth_client.post('/api/config/reload', json={
            'heartbeatIntervalSeconds': 120,
            'maxConcurrentTasks': 4,  # 同一载荷里的合法字段也不得被写入
        })

        assert resp.status_code == 400
        assert resp.json()['detail'] == 'heartbeat_interval_seconds 必须在 5 到 60 之间'
        assert settings.heartbeat_interval_seconds == 30
        assert settings.max_concurrent_tasks == 10

    def test_rejects_absurd_value(self, auth_client, monkeypatch):
        """反证有牙：旧实现会 200 接受 3600 并写到 settings。"""
        monkeypatch.setattr(settings, 'heartbeat_interval_seconds', 30)

        resp = auth_client.post('/api/config/reload', json={'heartbeatIntervalSeconds': 3600})

        assert resp.status_code == 400
        assert settings.heartbeat_interval_seconds == 30

    def test_accepts_upper_boundary(self, auth_client, monkeypatch):
        """上界是闭区间（与 node 的 > 60 判据一致）：60 本身必须放行。"""
        monkeypatch.setattr(settings, 'heartbeat_interval_seconds', 30)

        resp = auth_client.post('/api/config/reload', json={'heartbeatIntervalSeconds': 60})

        assert resp.status_code == 200
        assert resp.json()['updated_fields'] == ['heartbeat_interval_seconds']
        assert settings.heartbeat_interval_seconds == 60

    def test_env_path_still_clamps_instead_of_rejecting(self):
        """env 走**钳制**而不是报错（活性优先，与 node config.ts 同语义）——
        端点 400 只针对交互式推送，两条路径的处置**不同且都要保留**。"""
        from config import Settings

        assert Settings(heartbeat_interval_seconds=120).heartbeat_interval_seconds == 60
        assert Settings(heartbeat_interval_seconds=1).heartbeat_interval_seconds == 5


# ---------------------------------------------------------------------------
# R12-fix 对齐：空 adminApiUrl 不得覆盖既有连接拓扑
# （node routes/config.ts:242-253 同一处置；「旧版 admin / 第三方生产者仍会发 ""」）。
#
# 反证：应用 "" 后 build_admin_api_url('/executors/heartbeat') 会拼出相对路径
# "/api/executors/heartbeat"（base 为空串），httpx 直接抛 → 心跳/注册/回调全挂，
# 且不会自愈（只有重启 + 改 env 能救）。
# ---------------------------------------------------------------------------
class TestEmptyAdminApiUrlIsIgnored:
    def _pin(self, monkeypatch, primary='http://keep-me:3105'):
        monkeypatch.setattr(settings, 'admin_api_url', primary)
        monkeypatch.setattr(settings, 'admin_api_url_internal', '')
        monkeypatch.setattr(settings, 'admin_api_url_external', '')

    def test_empty_string_keeps_existing_topology(self, auth_client, monkeypatch):
        self._pin(monkeypatch)

        resp = auth_client.post('/api/config/reload', json={'adminApiUrl': ''})

        assert resp.status_code == 200
        body = resp.json()
        assert body['updated_fields'] == []
        assert body['ignored_fields'] == ['adminApiUrl(empty)']
        assert '已忽略不支持的字段' in body['message']
        assert settings.admin_api_url == 'http://keep-me:3105'

    def test_whitespace_only_is_also_ignored(self, auth_client, monkeypatch):
        """node 判据是 `trim().length > 0`，纯空白等价于空值（规则不得漂移）。"""
        self._pin(monkeypatch)

        resp = auth_client.post('/api/config/reload', json={'adminApiUrl': '   '})

        assert resp.status_code == 200
        assert resp.json()['updated_fields'] == []
        assert resp.json()['ignored_fields'] == ['adminApiUrl(empty)']
        assert settings.admin_api_url == 'http://keep-me:3105'

    def test_derived_url_stays_absolute_after_empty_reload(self, auth_client, monkeypatch):
        """端到端证据（不只是 settings 字段值）：派生 URL 仍是绝对地址。"""
        from admin_api import build_admin_api_url

        self._pin(monkeypatch)

        auth_client.post('/api/config/reload', json={'adminApiUrl': ''})

        derived = build_admin_api_url('/executors/heartbeat')
        assert derived == 'http://keep-me:3105/api/executors/heartbeat'
        assert derived.startswith('http://')

    def test_non_empty_value_still_applies(self, auth_client, monkeypatch):
        """对照：非空值照旧生效（不能因为加了空值豁免就把正常热更也吞掉）。"""
        self._pin(monkeypatch)

        resp = auth_client.post('/api/config/reload', json={'adminApiUrl': 'http://new:3105'})

        assert resp.status_code == 200
        assert resp.json()['updated_fields'] == ['admin_api_url']
        assert resp.json()['ignored_fields'] == []
        assert settings.admin_api_url == 'http://new:3105'

