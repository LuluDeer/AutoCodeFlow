"""R2-1（T3-P0）：Node ↔ Python 执行器**行为对齐**的三条高危漂移（D1/D2/D3）。

本文件钉住三条「同一载荷、两侧相反结论」的漂移的**修复后行为**。三条都
**不改 `protocol.json`**（协议未描述这些语义，是「契约沉默区」——详见
`artifacts/rounds/2026-11-03-executor-parity.md` §3.3/§3.2）。

## 三条漂移与对齐目标（全部对齐到 **node 的既有语义**）

| # | 漂移 | 改前（python） | 改后（= node） | node 证据 |
|---|---|---|---|---|
| D1 | 畸形请求的 HTTP 状态码 | **422**（FastAPI 反序列化） | **400** | `execute.ts:560-570` |
| D2 | executionId 路径穿越闸层级 | accept 期 400（协议闸兜住）**但** `mkdir` 早于 resolve 复查 | accept 期 400 + mkdir 之前完成校验 | `execute.ts:571` / `:599` |
| D3 | gitRepo 六道闸层级 | **accept 零校验** ⇒ 200 accepted + 后台 failed 回调 | accept 期**同步 400** | `execute.ts:607-673` |

> **D2 的实测更正（重要，勿按旧结论回归）**：本轮实施前的评估报告把 D2 写成
> 「python 在后台才拒」，**实测证伪**——`accept_execution` 的**协议闸**
> （`ProtocolExecuteRequest.model_validate(strict=True)`）已经用
> `executionId` 的 `pattern` 在 accept 期拦下穿越形态并返回 400。D2 的**真实**
> 残余是：① 该闸位于 `_param_env_key_collisions` **之后**（与 node 的
> 「id 闸最先」顺序不同）；② `work_dir.mkdir` 与 resolve 复查的**相对顺序**在
> `run_task` 内仍存在（accept 拒绝时不落盘，故线上不可达，但顺序必须钉住）。

## 为什么这些用例「必须有牙」（反证方式写在每个 test 的 docstring 里）

每条用例都写成「把修复回退 ⇒ 本用例转红」的形态。只断言「返回 400」是不够的
——那会退化成永真断言（任何 4xx 都通过）。故：
  * 断言**精确状态码**（400，不是 4xx）；
  * 断言**不得留下 work_dir**（D2/D3 的核心不变量：拒绝必须发生在落盘之前）；
  * 断言**不得留下 live 条目**（E-19 的既有纪律：登记后 raise 会毒死
    executionId，admin 重试全撞 400）；
  * 断言**其它端点仍是 422**（D1 的作用域是单个 route，不是全局改 FastAPI 行为）。
"""
import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import execute as execute_module
from routers.execute import ExecutionRejected, ExecuteRequest

# 受限网络地址用 **IP 字面量**，避开 DNS（`_host_is_restricted` 对主机名走真实
# 解析；用字面量让本套件不依赖网络、不引入解析时延）。
_PRIVATE_IP = 'http://10.0.0.1/x.git'
_LOOPBACK_IP = 'http://127.0.0.1/x.git'
_METADATA_IP = 'http://169.254.169.254/latest/meta-data'
# 8.8.8.8 是公网 IP 字面量：能过 SSRF 闸，用来单独验证**后面的**闸门
# （否则 SSRF 闸先命中，ref 闸永远测不到）。
_PUBLIC_IP = 'http://8.8.8.8/x.git'


def _accept_raises(task, execution_id='probe-eid', params=None):
    """调用 accept_execution，返回它抛出的 ExecutionRejected（或 None）。"""
    req = ExecuteRequest(executionId=execution_id, task=task, params=params)
    try:
        execute_module.accept_execution(req)
    except ExecutionRejected as exc:
        return exc
    return None


# ---------------------------------------------------------------------------
# D1：畸形载荷 → 400（不是 422）。作用域 = 仅 /execute
# ---------------------------------------------------------------------------

# 畸形载荷矩阵：每一条都**违反 protocol.json 的 ExecuteRequest schema**
# （`required: [executionId, task]`，`executionId.type = string`）。
_MALFORMED_BODIES = [
    ('missing-task', {'executionId': 'x'}),
    ('missing-execution-id', {'task': {}}),
    ('execution-id-not-string', {'executionId': 123, 'task': {}}),
    ('task-not-object', {'executionId': 'x', 'task': []}),
]


@pytest.mark.parametrize('name,payload', _MALFORMED_BODIES, ids=[c[0] for c in _MALFORMED_BODIES])
def test_d1_malformed_payload_returns_400_not_422(auth_client, name, payload):
    """D1：`/execute` 的畸形载荷必须是 **400**。

    反证：把 `router.add_api_route(..., route_class_override=ExecuteRequestRoute)`
    换回普通 `@router.post('/execute')`，本用例立刻转红（422）。
    这正是本轮修复前的线上行为：同一份非法载荷 node 给 400、python 给 422 ⇒
    admin 的派发失败归因文本不同（`executor.service.ts:5786` 对非 2xx 一律抛错）。
    """
    resp = auth_client.post('/api/execute', json=payload)
    assert resp.status_code == 400, (
        f'{name}: 期望 400（协议语义：违反 ExecuteRequest schema），实际 {resp.status_code}'
    )
    # 文案与 node 同形（node execute.ts:744 的 `无效的 execute 请求（违反
    # executor-protocol 协议）：<字段>：<原因>`）。只断言前缀，避免把 pydantic 的
    # 具体 msg 文本钉死（那会随 pydantic 版本漂移）。
    assert '无效的 execute 请求（违反 executor-protocol 协议）' in resp.json()['detail']


def test_d1_scope_is_single_route_other_endpoints_keep_422(auth_client):
    """D1 作用域纪律：**只改 `/execute` 一个 route**，其它端点维持 FastAPI 默认 422。

    反证：把 `ExecuteRequestRoute` 挂到整个 `APIRouter(route_class=...)`（或装全局
    `exception_handler`），本用例转红。本轮刻意用 `add_api_route` 的
    `route_class_override` 而非 router 级 `route_class`——已实测 router 级会把
    同 router 的 `/executions/{id}/kill` 也改成 400。

    选 `/logs` 作对照端点的原因：它的请求校验在 **Query 参数**上
    （`limit: int = Query(ge=1, le=2000)`，`routers/logs.py:31`），是一处**真实可达**
    的 422。而 `/config/reload` 的 `ConfigReloadRequest` **全部字段可选**
    （`routers/config.py:29-45`），未知键被 `extra=ignore` 吞掉 ⇒ 它根本 422 不了，
    做对照会得到假绿（实测：200）。这正是「断言必须有牙」的一个现场。
    """
    resp = auth_client.get('/api/logs/some-id', params={'limit': 99999})
    assert resp.status_code == 422, (
        f'/logs 不应受 /execute 的 400 映射影响（作用域必须是单 route），实际 {resp.status_code}'
    )


# ---------------------------------------------------------------------------
# D3：gitRepo 六道闸在 **accept 期同步 400**（改前：200 accepted + 后台 failed 回调）
# ---------------------------------------------------------------------------

# 六道闸逐条：协议 / userinfo / ssh password / 私网 / 回环 / 元数据地址 / ref。
# 每条都断言**精确 400** + **不得留下 live 条目** + **不得留下 work_dir**。
_GITREPO_GATES = [
    # (name, task, 期望文案片段)
    ('protocol-file-scheme', {'gitRepo': 'file:///etc/passwd'}, '不允许的 gitRepo URL 协议'),
    ('protocol-ftp-scheme', {'gitRepo': 'ftp://host/x.git'}, '不允许的 gitRepo URL 协议'),
    ('http-userinfo', {'gitRepo': 'https://user:pw@10.0.0.1/x.git'}, 'gitRepo 不得内嵌凭据（userinfo）'),
    ('ssh-password', {'gitRepo': 'ssh://git:pw@10.0.0.1/x.git'}, 'gitRepo 不得内嵌密码'),
    ('private-ip', {'gitRepo': _PRIVATE_IP}, 'gitRepo URL 指向受限网络地址'),
    ('loopback-ip', {'gitRepo': _LOOPBACK_IP}, 'gitRepo URL 指向受限网络地址'),
    ('metadata-ip', {'gitRepo': _METADATA_IP}, 'gitRepo URL 指向受限网络地址'),
    ('option-ref-branch', {'gitRepo': _PUBLIC_IP, 'gitBranch': '-b'}, '无效的 git ref'),
    ('option-ref-commit', {'gitRepo': _PUBLIC_IP, 'gitCommit': '--orphan'}, '无效的 git ref'),
]


@pytest.mark.parametrize('name,task,expected', _GITREPO_GATES, ids=[c[0] for c in _GITREPO_GATES])
def test_d3_gitrepo_gates_reject_at_accept_with_400(name, task, expected):
    """D3：六道闸全部在 **accept_execution** 内同步拒绝（400）。

    反证：把 accept 里的 `_validate_git_repo_task(req.task)` 调用删掉，本组用例
    **全部转红**——改前 python 这里零校验，`file:///etc/passwd` 会拿到
    `{'status':'accepted', ...}`（实测确认），随后在后台 `run_task` 才拒，
    错误经 `_run_and_callback` 的 `except Exception` 变成 **failed 回调**。

    为什么这是高危：① SSRF/凭据泄漏类载荷在本执行器上**先被当成已接单**
    （占坑、计容量、admin 侧记 RUNNING）；② 拒绝信息变成异步失败，
    与 node 的同步 400 语义完全不同。
    """
    eid = f'gitrepo-{name}'
    exc = _accept_raises(task, execution_id=eid)
    assert exc is not None, f'{name}: 期望 accept 期拒绝，实际被接受（D3 回归）'
    assert exc.status_code == 400, f'{name}: 期望 400，实际 {exc.status_code}'
    assert expected in exc.detail, f'{name}: 文案不含 {expected!r}，实际 {exc.detail!r}'


@pytest.mark.parametrize('name,task,_expected', _GITREPO_GATES, ids=[c[0] for c in _GITREPO_GATES])
def test_d3_rejected_gitrepo_leaves_no_live_entry_and_no_workdir(
    name, task, _expected, tmp_path, monkeypatch
):
    """D3 的**两个不变量**：拒绝不得留下 live 条目，也不得落盘 work_dir。

    live 条目残留的后果（E-19 既有纪律）：该 executionId 在本执行器上**永久**
    被当成「已在运行」——admin 的每次重试都撞 400，心跳还会上报一个并不存在的
    执行。

    work_dir 残留的后果：`run_task` 里 `Path(work_dir) / executionId` 之后就是
    `mkdir`，若校验晚于 mkdir，一个被拒的 payload 仍然在磁盘留下目录（可被
    后续同 id 任务复用/污染，且是信息泄漏面）。
    """
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path), raising=False)
    eid = f'gitrepo-leak-{name}'

    exc = _accept_raises(task, execution_id=eid)
    assert exc is not None and exc.status_code == 400

    # ① 不变量 1：live 表必须干净
    assert execute_module.execution_exists(eid) is False, f'{name}: live 条目残留'
    assert eid not in execute_module.list_active_execution_ids()

    # ② 不变量 2：不得落盘 work_dir
    #    注意 accept 阶段本来就**不**建 work_dir（那是 run_task 的事），故本断言
    #    在改前改后都为真；它的价值是**锁住「accept 拒绝 ⇒ 不落盘」这条不变量**，
    #    防止将来有人把 mkdir 前移到 accept 却放在闸门之前。
    assert not (tmp_path / eid).exists(), f'{name}: 被拒的载荷留下了 work_dir'


def test_d3_valid_gitrepo_task_is_not_rejected(tmp_path, monkeypatch):
    """反向护栏：**合法** gitRepo 不得被六道闸误伤（不扩大拒绝面）。

    反证：把任何一道闸的条件写严（例如把 `re.match` 换成 `re.fullmatch`、
    或把 SSRF 闸改成对所有主机名 fail-closed），本用例转红。

    用公网 IP 字面量 + 合法 ref，避开 DNS 与「私网域名」歧义。
    """
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(tmp_path), raising=False)
    monkeypatch.setattr(
        execute_module.asyncio, 'create_task',
        lambda coro: (coro.close(), __import__('unittest.mock', fromlist=['MagicMock']).MagicMock())[1],
    )
    eid = 'gitrepo-valid-probe'
    req = ExecuteRequest(
        executionId=eid,
        task={'runtime': 'python', 'entrypoint': 'main.py', 'gitRepo': _PUBLIC_IP, 'gitBranch': 'main'},
    )
    try:
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'
    finally:
        # 后台任务被 fake 掉了，不会自己注销 —— 手工清理，免得污染后续用例
        execute_module._live_executions.pop(eid, None)
        execute_module.sched.decrement_running()


# ---------------------------------------------------------------------------
# D2：executionId 穿越闸 —— accept 期 400，且**先于**任何落盘
# ---------------------------------------------------------------------------

_TRAVERSAL_IDS = [
    '../../etc/passwd',
    'a/../../b',
    '/etc/passwd',
    '..',
    './x',
    'x/../../y',
]


@pytest.mark.parametrize('bad_id', _TRAVERSAL_IDS, ids=[repr(i) for i in _TRAVERSAL_IDS])
def test_d2_traversal_execution_id_rejected_at_accept(bad_id):
    """D2：穿越形态的 executionId 必须在 **accept 期**返回 400。

    ## 实测更正（本用例的注释价值就在这条）

    评估报告初版把 D2 描述成「python 在后台 run_task 才拒、被吞成 failed 回调」。
    **实施前实测证伪**：`accept_execution` 的**协议闸**
    （`ProtocolExecuteRequest.model_validate(strict=True)`）已经用
    `protocol.json` 里 `executionId` 的 `pattern`
    （`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`）在 accept 期拒绝并返回 400。
    所以 D2 的 accept 行为**改前改后都是 400** —— 本组用例是**回归锁**，
    防止「协议闸被移出 accept」或「pattern 被放宽」导致穿越形态重新溜进后台。

    真正的 D2 残余见 `test_d2_traversal_rejected_before_mkdir`：**顺序**不变量。
    """
    exc = _accept_raises({'id': 'probe-task'}, execution_id=bad_id)
    assert exc is not None, f'{bad_id!r}: 期望 accept 期拒绝，实际被接受'
    assert exc.status_code == 400, f'{bad_id!r}: 期望 400，实际 {exc.status_code}'
    # 不留下 live 条目（登记前就拒）
    assert execute_module.execution_exists(bad_id) is False


def test_d2_traversal_rejected_before_mkdir(tmp_path, monkeypatch):
    """D2 的**顺序**不变量：拒绝必须发生在 `mkdir` 之前，磁盘上不得出现目录。

    这是 D2 唯一真正存在的残余（见上一条 docstring 的更正）：`run_task` 里
    `work_dir = Path(settings.work_dir) / req.executionId` → resolve/prefix 复查
    → `mkdir` 的顺序，**必须**是「复查在前、mkdir 在后」。

    反证：把 `run_task` 里的 resolve 复查挪到 `mkdir` 之后，本用例转红
    （被拒的穿越 id 会在磁盘上留下目录）。

    ⚠️ **断言写法注意**：不能写成 `(tmp_path / bad_id).exists()` ——
    `pathlib` 的 `/` 运算符遇到**绝对路径**会丢弃左边（`tmp_path / '/etc/passwd'`
    == `PosixPath('/etc/passwd')`），于是断言变成了「检查宿主机的 /etc/passwd
    存不存在」⇒ 恒真失败，且是**假红**（本轮实测踩到）。故这里显式拼字符串再
    `Path(...)`，保证断言的是**我们关心的那个 work_dir**。
    """
    work_root = tmp_path / 'work'
    work_root.mkdir()
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(work_root), raising=False)
    # 判据用「work_root 内容快照不变」——比 exists() 稳，且**不会假红**：
    #   * `(tmp_path / bad_id).exists()` 对绝对路径会丢弃左边（假红：去查宿主机的
    #     /etc/passwd）；本轮实测踩到。
    #   * `Path(f'{work_root}/{bad_id}').exists()` 对 `..` 会指回已存在的父目录
    #     （假红）；对 `../../etc/passwd` 会规范化到 work_root 之外（那恰恰**证明**
    #     了危险，而不是「没落盘」）。
    # 故改用「拒绝之后 work_root 里没有**新增**条目」——这才是「未落盘」的正解。
    before = sorted(p.name for p in work_root.iterdir())
    for bad_id in _TRAVERSAL_IDS:
        exc = _accept_raises({'id': 'probe-task'}, execution_id=bad_id)
        assert exc is not None and exc.status_code == 400, f'{bad_id!r} 未被拒'
        after = sorted(p.name for p in work_root.iterdir())
        assert after == before, (
            f'{bad_id!r}: accept 拒绝后 work_root 出现了新条目 {set(after) - set(before)}'
            '——说明校验发生在 mkdir 之后'
        )
    # 附：确认这批 id 若真被 mkdir **确实**会逃出 work_root（证明闸门不是无事可做）
    escapes = [
        bid for bid in _TRAVERSAL_IDS
        if not str(Path(f'{work_root}/{bid}').resolve()).startswith(str(work_root.resolve()) + '/')
    ]
    assert escapes, '本组探针里没有任何一个会逃出 work_root —— 探针失去了证明力'


def test_d2_accept_gate_runs_before_registration(monkeypatch):
    """E-19 纪律（D2/D3 共用）：所有 400 闸门必须在 `register_live_execution` **之前**。

    反证：把任一闸门挪到登记之后，本用例转红（live 表残留）。
    这条比「返回 400」重要得多：登记后 raise 会让该 executionId **永久**被重复
    领取守卫拒绝——admin 每次重试都 400，心跳还上报一个不存在的执行。
    （既有用例 `test_execute_protocol_gate.py::test_rejected_execution_leaves_no_live_entry`
    钉的是 requirements 那条；本用例把范围扩到 gitRepo 与穿越 id。）

    ⚠️ 需要 patch `asyncio.create_task`：gitRepo/traversal 两条**被拒**路径在
    `create_task` 之前就 raise，但第三个探针若因回归变成「被接受」，就会走到
    `asyncio.create_task(...)` —— 在没有运行中事件循环的同步测试里那是
    `RuntimeError: no running event loop`，**掩盖**真正要断言的东西（live 残留）。
    patch 掉它让失败信息始终指向 live 表。
    """
    class _FakeTask:
        def add_done_callback(self, *_a, **_k):
            return None

    def _fake_create_task(coro):
        coro.close()  # 避免 "coroutine was never awaited"
        return _FakeTask()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', _fake_create_task)

    # 三个探针各命中一条**不同的** accept 期闸门（都在登记之前）：
    #   ① param 折叠冲突（EXEC-07）；② gitRepo 协议闸（D3）；③ executionId 穿越（D2）。
    # 注意不能拿 `{'id':'x'}` 当探针——它是合法 task，根本不会被拒（本轮实测踩到）。
    probes = [
        # ① params 折叠冲突（EXEC-07）：{"limit","LIMIT"} 折叠成同一个 AUTOFLOW_LIMIT
        ('param-collision', {'id': 'x'}, 'd2-before-reg-param', {'limit': 1, 'LIMIT': 2}),
        ('gitrepo', {'gitRepo': 'file:///etc/passwd'}, 'd2-before-reg-git', None),
        ('traversal', {'id': 'x'}, '../../etc/passwd', None),
    ]
    for label, task, eid, params in probes:
        exc = _accept_raises(task, execution_id=eid, params=params)
        assert exc is not None and exc.status_code == 400, f'{label}: 未被拒'
        assert execute_module.execution_exists(eid) is False, f'{label}: live 条目残留'
        execute_module._live_executions.pop(eid, None)
        execute_module.sched.decrement_running()
