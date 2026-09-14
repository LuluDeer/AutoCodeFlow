"""A6（DEEP_REVIEW §七）：死信目录定期对账（executor-python 侧）。

与 executor-node 的 ``src/callback.deadletter-reconcile.spec.ts`` 同语义、同
磁盘布局：两侧写同一份 `.deadletter.json` 侧车，运维拿同一套命令即可排查。

断言按「反证必须有牙」组织：每条在把实现改回旧行为（不写 poison / 不判
hasMore / 取不到就当空 / 计数把侧车也算进去）时都必须转红。
"""
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from routers import execute as ex


def _patch_env(monkeypatch, tmp_path):
    monkeypatch.setattr(ex.settings, 'work_dir', str(tmp_path))
    monkeypatch.setattr(ex.settings, 'admin_api_url', 'http://admin.local')
    monkeypatch.setattr(ex.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(ex.settings, 'admin_api_url_external', '')
    monkeypatch.setattr(ex.settings, 'executor_address', 'internal:8001')
    monkeypatch.setattr(ex.settings, 'executor_address_public', 'pub:9000')
    monkeypatch.setattr(ex, 'get_current_token', AsyncMock(return_value=None))


def _seed_dead_letter(tmp_path, name, execution_ids, poison=False, requeues=0,
                      dead_lettered_at=None):
    dead = Path(tmp_path) / 'callbacks' / 'dead-letter'
    dead.mkdir(parents=True, exist_ok=True)
    payload = dead / name
    payload.write_text(
        json.dumps([{'executionId': e, 'status': 'success'} for e in execution_ids]),
        encoding='utf-8')
    (dead / (name + ex.DEAD_LETTER_SIDECAR_SUFFIX)).write_text(json.dumps({
        'reason': 'seed',
        'poison': poison,
        'requeues': requeues,
        'deadLetteredAt': dead_lettered_at if dead_lettered_at is not None else int(time.time() * 1000),
    }), encoding='utf-8')
    return dead


def _dead_names(tmp_path):
    dead = Path(tmp_path) / 'callbacks' / 'dead-letter'
    return sorted(p.name for p in dead.iterdir()) if dead.exists() else []


def _live_names(tmp_path):
    live = Path(tmp_path) / 'callbacks'
    return sorted(p.name for p in live.iterdir() if p.is_file()) if live.exists() else []


# ---------------------------------------------------------------------------
# 基本分层处置
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_no_dead_letters_means_no_request(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    fetch = AsyncMock(return_value=set())
    monkeypatch.setattr(ex, '_fetch_terminal_states', fetch)

    result = await ex.reconcile_dead_letter_files()

    fetch.assert_not_awaited()
    assert result == {'scanned': 0, 'deleted': 0, 'requeued': 0, 'kept': 0,
                      'orphans': 0, 'skipped': 0, 'fetched': -1, 'hasMore': False}
    # 只读动作不凭空造目录
    assert not (Path(tmp_path) / 'callbacks' / 'dead-letter').exists()


@pytest.mark.asyncio
async def test_terminal_dead_letter_is_dropped_with_its_sidecar(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    _seed_dead_letter(tmp_path, 'callback-1.json', ['exec-1'])
    monkeypatch.setattr(ex, '_fetch_terminal_states', AsyncMock(return_value={'exec-1'}))

    result = await ex.reconcile_dead_letter_files()

    assert result['deleted'] == 1
    assert result['requeued'] == 0
    assert _dead_names(tmp_path) == []


@pytest.mark.asyncio
async def test_poison_payload_is_also_dropped_when_terminal(monkeypatch, tmp_path):
    """毒丸只要已终态也照样清理——这才是对账的正收益。"""
    _patch_env(monkeypatch, tmp_path)
    _seed_dead_letter(tmp_path, 'callback-poison.json', ['exec-9'], poison=True)
    monkeypatch.setattr(ex, '_fetch_terminal_states', AsyncMock(return_value={'exec-9'}))

    result = await ex.reconcile_dead_letter_files()

    assert result['deleted'] == 1
    assert _dead_names(tmp_path) == []


@pytest.mark.asyncio
async def test_open_execution_is_re_queued(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    _seed_dead_letter(tmp_path, 'callback-2.json', ['exec-2'])
    monkeypatch.setattr(ex, '_fetch_terminal_states', AsyncMock(return_value=set()))

    result = await ex.reconcile_dead_letter_files()

    assert result['requeued'] == 1
    assert result['deleted'] == 0
    assert 'callback-2.json' in _live_names(tmp_path)
    meta = json.loads((Path(tmp_path) / 'callbacks' / 'callback-2.json.meta').read_text())
    assert meta['retries'] == 0
    assert meta['deadLetterRequeues'] == 1


@pytest.mark.asyncio
async def test_poison_payload_stays_when_still_open(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    _seed_dead_letter(tmp_path, 'callback-4.json', ['exec-4'], poison=True)
    monkeypatch.setattr(ex, '_fetch_terminal_states', AsyncMock(return_value=set()))

    result = await ex.reconcile_dead_letter_files()

    assert result['kept'] == 1
    assert result['requeued'] == 0
    assert 'callback-4.json' in _dead_names(tmp_path)


@pytest.mark.asyncio
async def test_requeue_cap_prevents_endless_ping_pong(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    _seed_dead_letter(tmp_path, 'callback-3.json', ['exec-3'],
                      requeues=ex.DEAD_LETTER_MAX_REQUEUES)
    monkeypatch.setattr(ex, '_fetch_terminal_states', AsyncMock(return_value=set()))

    result = await ex.reconcile_dead_letter_files()

    assert result['requeued'] == 0
    assert result['kept'] == 1
    assert 'callback-3.json' in _dead_names(tmp_path)


@pytest.mark.asyncio
async def test_multi_execution_payload_needs_all_terminal(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    _seed_dead_letter(tmp_path, 'callback-multi.json', ['exec-a', 'exec-b'])
    monkeypatch.setattr(ex, '_fetch_terminal_states', AsyncMock(return_value={'exec-a'}))

    result = await ex.reconcile_dead_letter_files()

    assert result['deleted'] == 0
    assert result['requeued'] == 1


@pytest.mark.asyncio
async def test_unavailable_terminal_states_changes_nothing(monkeypatch, tmp_path):
    """取不到终态清单绝不能退化成"都没终态"——否则毒丸会被一股脑推回重发。"""
    _patch_env(monkeypatch, tmp_path)
    _seed_dead_letter(tmp_path, 'callback-5.json', ['exec-5'], poison=True)
    monkeypatch.setattr(ex, '_fetch_terminal_states', AsyncMock(return_value=None))

    result = await ex.reconcile_dead_letter_files()

    assert result['fetched'] == -1
    assert result['deleted'] == 0 and result['requeued'] == 0 and result['kept'] == 0
    assert 'callback-5.json' in _dead_names(tmp_path)


@pytest.mark.asyncio
async def test_fetch_failure_changes_nothing(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    _seed_dead_letter(tmp_path, 'callback-6.json', ['exec-6'])

    async def _boom(*_a, **_k):
        raise RuntimeError('ECONNREFUSED')

    monkeypatch.setattr(ex, '_fetch_terminal_states', _boom)

    result = await ex.reconcile_dead_letter_files()

    assert result['fetched'] == -1
    assert 'callback-6.json' in _dead_names(tmp_path)


@pytest.mark.asyncio
async def test_orphan_sidecar_is_reclaimed(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    dead = Path(tmp_path) / 'callbacks' / 'dead-letter'
    dead.mkdir(parents=True)
    (dead / 'callback-gone.json.deadletter.json').write_text(
        json.dumps({'reason': 'x', 'poison': False, 'requeues': 0,
                    'deadLetteredAt': int(time.time() * 1000)}), encoding='utf-8')

    result = await ex.reconcile_dead_letter_files()

    assert result['orphans'] == 1
    assert _dead_names(tmp_path) == []


# ---------------------------------------------------------------------------
# 对账请求本身
# ---------------------------------------------------------------------------

class _FakeClient:
    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.mark.asyncio
async def test_fetch_encodes_address_and_sends_since(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    captured = {}

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {'code': 200, 'message': 'success',
                    'data': {'items': [{'executionId': 'exec-1', 'status': 'success'}],
                             'hasMore': False}}

    async def _fake_request(client, method, url, **kwargs):
        captured['method'] = method
        captured['url'] = url
        return _Resp()

    monkeypatch.setattr(ex, 'request_with_self_heal', _fake_request)
    monkeypatch.setattr(ex.httpx, 'AsyncClient', _FakeClient)

    terminal = await ex._fetch_terminal_states('pub:9000', time.time() * 1000 - 3600_000)

    assert terminal == {'exec-1'}
    assert captured['method'] == 'get'
    # 地址含 ':' —— 不编码会破坏路径段
    assert '/executors/pub%3A9000/terminal-states' in captured['url']
    assert 'since=' in captured['url']


@pytest.mark.asyncio
async def test_fetch_bare_response_without_envelope(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {'items': [{'executionId': 'exec-7'}]}

    monkeypatch.setattr(ex, 'request_with_self_heal', AsyncMock(return_value=_Resp()))
    monkeypatch.setattr(ex.httpx, 'AsyncClient', _FakeClient)

    assert await ex._fetch_terminal_states('pub:9000', 0) == {'exec-7'}


@pytest.mark.asyncio
@pytest.mark.parametrize('payload', [
    {'code': 200, 'message': 'ok', 'data': {}},
    {'code': 200, 'message': 'ok', 'data': {'items': 'nope'}},
    None,
])
async def test_fetch_bad_shape_returns_none(monkeypatch, tmp_path, payload):
    _patch_env(monkeypatch, tmp_path)

    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return payload

    monkeypatch.setattr(ex, 'request_with_self_heal', AsyncMock(return_value=_Resp()))
    monkeypatch.setattr(ex.httpx, 'AsyncClient', _FakeClient)

    assert await ex._fetch_terminal_states('pub:9000', 0) is None


# ---------------------------------------------------------------------------
# 侧车写入 & 计数口径
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_corrupt_payload_is_dead_lettered_as_poison(monkeypatch, tmp_path):
    _patch_env(monkeypatch, tmp_path)
    live = Path(tmp_path) / 'callbacks'
    live.mkdir(parents=True)
    (live / 'callback-corrupt.json').write_text('{ not json', encoding='utf-8')
    (live / 'callback-corrupt.json.meta').write_text(
        json.dumps({'retries': 0, 'persistedAt': int(time.time() * 1000)}), encoding='utf-8')
    monkeypatch.setattr(ex, '_replay_persisted_callback_file', AsyncMock(side_effect=RuntimeError))

    await ex.retry_persisted_callbacks()

    sidecar = json.loads(
        (live / 'dead-letter' / ('callback-corrupt.json' + ex.DEAD_LETTER_SIDECAR_SUFFIX)
         ).read_text(encoding='utf-8'))
    assert sidecar['reason'] == 'corrupt payload'
    assert sidecar['poison'] is True
    assert isinstance(sidecar['deadLetteredAt'], int)


def test_dead_letter_count_excludes_sidecars(monkeypatch, tmp_path):
    """上报的是「积压了多少条没送出去的回调」，侧车不是回调。"""
    _patch_env(monkeypatch, tmp_path)
    dead = _seed_dead_letter(tmp_path, 'a.json', ['exec-a'])
    _seed_dead_letter(tmp_path, 'b.json', ['exec-b'])
    assert len([p for p in dead.iterdir() if p.is_file()]) == 4

    ex._refresh_dead_letter_count()
    assert ex.get_dead_letter_count() == 2


@pytest.mark.asyncio
async def test_retry_exhaustion_is_not_poison(monkeypatch, tmp_path):
    """重发预算耗尽 ≠ 毒丸：admin 恢复后这份回调仍可能救得回来。"""
    _patch_env(monkeypatch, tmp_path)
    live = Path(tmp_path) / 'callbacks'
    live.mkdir(parents=True)
    name = 'callback-exhausted.json'
    (live / name).write_text(json.dumps([{'executionId': 'exec-e'}]), encoding='utf-8')
    (live / (name + '.meta')).write_text(
        json.dumps({'retries': ex.CALLBACK_FILE_MAX_RETRIES,
                    'updatedAt': int(time.time() * 1000)}), encoding='utf-8')

    await ex.retry_persisted_callbacks()

    sidecar = json.loads(
        (live / 'dead-letter' / (name + ex.DEAD_LETTER_SIDECAR_SUFFIX)).read_text(encoding='utf-8'))
    assert sidecar['poison'] is False
