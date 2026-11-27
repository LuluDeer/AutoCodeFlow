"""跨端运行时一致性：executor-python 侧断言。

与 apps/executor-node/__tests__/runtime-parity.spec.ts 读**同一份** fixture
（两份 JSON 逐字节相同），覆盖 protocol.json 三段 runtime 消费：
networkPolicy / timeoutPrecedence / callbackLogRetention。
"""
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import network_policy as np  # noqa: E402
from generated.protocol_schemas import ExecuteRequest as ProtocolExecuteRequest  # noqa: E402
from routers import execute as execute_module  # noqa: E402

FIXTURE = Path(__file__).parent / 'fixtures' / 'runtime-parity.json'
FIXTURES = json.loads(FIXTURE.read_text(encoding='utf-8'))


class _MemLogFile:
    """_build_callback_logs 只需要 .name。"""

    name = 'execution.log'


@pytest.mark.parametrize('v', FIXTURES['urlVectors'], ids=lambda v: v['name'])
def test_network_policy_url_verdict(v):
    host = urlsplit(v['url']).hostname or ''
    allow_private = v['switch'] == 'on'
    denied = np.host_denied_under_policy(host, allow_private)
    assert ('deny' if denied else 'allow') == v['expected'], v['name']


@pytest.mark.parametrize('v', FIXTURES['dnsVectors'], ids=lambda v: v['name'])
def test_network_policy_dns_verdict(v):
    denied = np.host_denied_under_policy(
        v['host'], False, resolver=lambda _host: v['addresses']
    )
    assert ('deny' if denied else 'allow') == v['expected'], v['name']


@pytest.mark.parametrize('v', FIXTURES['timeoutVectors'], ids=lambda v: v['name'])
def test_timeout_precedence_and_status(v):
    task = v['task']
    selected = next(
        (k for k in execute_module._TIMEOUT_PRECEDENCE
         if isinstance(task, dict) and task.get(k) is not None),
        None,
    )
    assert selected == v.get('selected'), v['name']

    raw = task.get(selected) if selected is not None else None
    if v['expectedStatus'] == 400:
        assert (
            not isinstance(raw, int)
            or isinstance(raw, bool)
            or not (1 <= raw <= 86400)
        ), v['name']
        return

    assert raw == v['effective'], v['name']
    # 协议闸只喂规范化副本：旁键越界不得被 strict schema 拒
    normalized = {
        k: value for k, value in task.items()
        if k not in execute_module._TIMEOUT_PRECEDENCE or k == selected
    }
    payload = {'executionId': 'runtime-parity', 'task': normalized}
    ProtocolExecuteRequest.model_validate(payload, strict=True)


@pytest.mark.parametrize('v', FIXTURES['logVectors'], ids=lambda v: v['name'])
def test_callback_log_retention_keeps_tail(v):
    filler = max(v['inputChars'] - len(v['expectedHeadContains']) - len(v['tailProbe']), 0)
    text = v['expectedHeadContains'] + 'X' * filler + v['tailProbe']
    buffer = execute_module._BoundedLogBuffer()
    buffer.append(text)
    rendered = execute_module._build_callback_logs(buffer, _MemLogFile())
    assert v['expectedHeadContains'] in rendered
    assert (v['tailProbe'] in rendered) is v['expectedTailContainsProbe']
    assert bool(__import__('re').search(r'\[\s*(?:logs\s+)?truncated\b', rendered)) is v['expectedTruncated']
