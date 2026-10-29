"""EXEC-05（P3，2026-10-29 执行器域审计）：两端**转发集合**的协议级守卫（python 端）。

背景：node 与 python 各有一份 SEC-01 白名单（``apps/executor-node/src/env-whitelist.ts``
的 ``ENV_WHITELIST`` 与 ``routers/execute.py`` 的 ``_ENV_WHITELIST``），此前只靠
注释互指「parity」。实测两份**转发集合并不相同**：python 多
``PYTHONPATH`` / ``PYTHONHASHSEED`` / ``VIRTUAL_ENV``，node 多
``npm_config_cache`` / ``npm_config_prefix``；而既有的对等守卫
（admin-api ``secret-key-map.parity.spec.ts``）只比对**保留名集合**——那正好是
两端交集，差异侧完全无信号：任一端日后静默增删一个转发变量，CI 全绿。

判据不是「强行统一」（语言运行时专属变量本来就不该统一），而是把现状登记进
``packages/executor-protocol/protocol.json`` 的 ``envForward`` 段，并断言：

  ① 清单自洽：三桶（common / executor-node / executor-python）互斥，每条专属
     差异都有非空 reason（没有理由的差异就是待修的漂移）；
  ② 本端白名单 == common ∪ 本端专属（不多转发、也不少登记）；
  ③ 与**另一端真实源码**解析出的集合对账：common 完全一致，两侧差异恰好等于
     已登记的两侧专属集合；
  ④ 执行器凭据（neverForward）不在任何一端的转发集合里。

与 node 侧 ``src/env-whitelist.spec.ts`` 的 EXEC-05 describe 逐条对等。
**本文件只登记现状，不新增转发面**——多转发一个宿主变量就多一份泄漏面。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from routers.execute import _ENV_WHITELIST

_REPO_ROOT = Path(__file__).resolve().parents[3]
_PROTOCOL_PATH = _REPO_ROOT / 'packages' / 'executor-protocol' / 'protocol.json'
_NODE_WHITELIST_PATH = _REPO_ROOT / 'apps' / 'executor-node' / 'src' / 'env-whitelist.ts'


def _upper(names) -> set[str]:
    """统一按大写归一后比对。

    名单按各端源码**原始拼写**登记（node 的 ``npm_config_cache`` 是小写），而归
    一前的集合比对历史上出过事：判定用 ``upper()`` 查表、集合却留着小写条目，
    大写形态就绕过了闸门（见 ``secret_env.py`` 的 ``_RESERVED_SECRET_NAMES`` 注释
    与 admin parity spec 的实测教训）。归一后只问「转发哪个变量」，不问拼写。
    """
    return {str(n).upper() for n in names}


def _load_manifest() -> dict:
    return json.loads(_PROTOCOL_PATH.read_text(encoding='utf-8'))['envForward']


MANIFEST = _load_manifest()
COMMON = _upper(MANIFEST['common'])
NODE_ONLY = _upper(e['name'] for e in MANIFEST['runtimeOnly']['executor-node'])
PY_ONLY = _upper(e['name'] for e in MANIFEST['runtimeOnly']['executor-python'])
PY_ACTUAL = _upper(_ENV_WHITELIST)


def _node_forward_set() -> set[str]:
    """解析 node 侧真实白名单：``ENV_WHITELIST = new Set([...])`` 里的字符串条目。

    先剥掉 ``//`` 行尾注释——注释里有 ``degrade to '~'`` 这种带引号的散文，
    不剥就会把 ``~`` 当成转发变量。
    """
    src = _NODE_WHITELIST_PATH.read_text(encoding='utf-8')
    start = src.index('export const ENV_WHITELIST = new Set([')
    end = src.index(']);', start)
    body = '\n'.join(
        line.split('//', 1)[0] for line in src[start:end].split('\n')
    )
    names = re.findall(r"'([A-Za-z0-9_]+)'", body)
    assert len(names) > 15, '源码结构变了就显式修守卫，别让它静默失效'
    return _upper(names)


NODE_ACTUAL = _node_forward_set()


def test_manifest_is_self_consistent():
    """三桶非空、两两互斥、每条专属差异都有非空 reason。"""
    assert len(MANIFEST['common']) >= 20
    assert NODE_ONLY and PY_ONLY
    for left_name, left in (('common', COMMON), ('executor-node', NODE_ONLY),
                            ('executor-python', PY_ONLY)):
        for right_name, right in (('common', COMMON), ('executor-node', NODE_ONLY),
                                  ('executor-python', PY_ONLY)):
            if left_name >= right_name:
                continue
            assert not (left & right), (
                f'envForward 清单桶重叠：{left_name} ∩ {right_name} = {left & right}'
            )
    for entry in (
        MANIFEST['runtimeOnly']['executor-node']
        + MANIFEST['runtimeOnly']['executor-python']
    ):
        assert entry['name']
        # 「按运行时区分的允许差异」必须写明理由。
        assert len(entry['reason']) > 10, f"{entry['name']} 缺少登记理由"


def test_python_whitelist_equals_common_plus_python_only():
    """本端白名单 == common ∪ 本端专属（不多转发、也不少登记）。"""
    expected = COMMON | PY_ONLY
    assert PY_ACTUAL == expected, (
        f'python 转发集合与协议清单漂移：多余 {PY_ACTUAL - expected}，缺失 {expected - PY_ACTUAL}'
    )
    # 差异方向显式化：node 专属项真的不在本端转发集合里。
    assert not (PY_ACTUAL & NODE_ONLY)


def test_node_source_and_python_source_agree_on_common_exactly():
    """与 node 真实源码对账：common 完全一致，差异只落在已登记的两侧专属集合。"""
    # ① common 必须与另一端解析结果逐项相等（「共同转发集合完全一致」）。
    node_common = NODE_ACTUAL - NODE_ONLY
    assert node_common == COMMON, (
        f'两端 common 不一致：node 侧多 {node_common - COMMON}，python 侧多 {COMMON - node_common}'
    )
    # ② 两端转发集合的差异，恰好等于清单登记的两侧专属集合（对称差判据）。
    assert NODE_ACTUAL - PY_ACTUAL == NODE_ONLY
    assert PY_ACTUAL - NODE_ACTUAL == PY_ONLY


@pytest.mark.parametrize('secret', MANIFEST['neverForward'])
def test_executor_credentials_are_never_forwarded(secret):
    """执行器凭据永不转发（node 侧另有显式 denylist，本端靠白名单的「不在集合内」）。"""
    assert secret.upper() not in PY_ACTUAL
    assert secret.upper() not in NODE_ACTUAL


def test_python_only_entries_are_really_python_runtime_specific():
    """python 专属三项确实是解释器/venv 语义（防止有人把通用变量塞进专属桶）。"""
    assert {'PYTHONPATH', 'PYTHONHASHSEED', 'VIRTUAL_ENV'} == PY_ONLY
    # 反向：node 专属只有 npm 工具链变量，且不得混入任何 PYTHON*/AUTOFLOW_*。
    assert NODE_ONLY == {'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX'}
    for name in PY_ONLY | NODE_ONLY:
        assert not name.startswith('AUTOFLOW_')
