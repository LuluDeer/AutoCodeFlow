"""R76：ADR-035 落地 —— zip 渠道判定与 admin / 契约逐字对齐。

## 背景（ADR-035，`1c667369`）

两端对「这一行任务走不走 zip 渠道」各有一套判定，差在**第三个条件 `packageUrl`**：

| 端 | 判定 |
| --- | --- |
| admin（派发期）`apps/admin-api/src/modules/executor/executor.service.ts:5465` | `codeSource === 'application_zip'` **或**（`codeSource == null` **且** `applicationId` 非空） |
| python（接单期）`routers/execute.py:2318` | `codeSource === 'application_zip'` **或**（无 `codeSource` **且** `applicationId` **且** `packageUrl`） |

契约（`docs/design/python-task-upload-and-multiversion/CONTRACT.md:355` / `:430`）
与存量回填优先级（`:245`「`applicationId NOT NULL → application_zip`」）都写的是
**admin 口径**；且 admin 判定时**手上还没有 `packageUrl`**（要先查 applications 表
解析）⇒ python 那个条件是「先有鸡还是先有蛋」。

⇒ ADR-035 裁决：**admin 口径正确，python 去掉 `packageUrl` 条件**。

## 对齐后的语义（歧义行 = 无 codeSource + 有 applicationId + 无 packageUrl）

两端**都**判 zip 渠道；区别只在「载荷缺 `packageUrl` 时怎么办」：

- admin：派发期解析不到 ⇒ **派发失败**（消息指向 application）；
- python：accept 期载荷缺 `packageUrl` ⇒ **400**（消息指向载荷）。

⇒ 两端**同结论（都显式拒绝）**，「照常跑」被明确排除。

## 本文件的判据

1. **渠道真值表**（12 组）：`_zip_channel_enabled` 的判定与契约/admin 逐字一致；
2. **歧义行显式拒绝**：accept 期 400（不是「照常跑」），且**不建 work_dir / 不留 live 条目**；
3. **反向护栏**：合法 zip 任务（带 `packageUrl`）不受影响。
"""
import pytest

from routers import execute as execute_module
from routers.execute import ExecutionRejected


# ---------------------------------------------------------------------------
# 判据 1：渠道真值表（12 组）
# ---------------------------------------------------------------------------

#: (标签, task, 期望是否 zip 渠道)
#:
#: 期望值按**契约 / admin 口径**推导：zip = `codeSource=='application_zip'`
#: **或**（无 codeSource 且 applicationId 非空），再由 git > glue 优先级让位。
ZIP_CHANNEL_CASES = [
    # --- codeSource 显式 ---
    ('explicit-zip-with-url', {'codeSource': 'application_zip', 'applicationId': 'a',
                               'packageUrl': 'https://cdn.example/x.zip'}, True),
    ('explicit-zip-no-url', {'codeSource': 'application_zip', 'applicationId': 'a'}, True),
    ('explicit-git', {'codeSource': 'git', 'gitRepo': 'https://git.example/r.git'}, False),
    ('explicit-glue', {'codeSource': 'glue', 'glueSource': 'print(1)'}, False),
    # --- 歧义行（无 codeSource）---
    ('ambiguous-with-url', {'applicationId': 'a', 'packageUrl': 'https://cdn.example/x.zip'}, True),
    ('ambiguous-no-url', {'applicationId': 'a'}, True),          # ← ADR-035 的行为变化点
    ('ambiguous-with-git-repo', {'applicationId': 'a',
                                 'gitRepo': 'https://git.example/r.git'}, False),
    ('ambiguous-with-glue', {'applicationId': 'a', 'glueSource': 'print(1)'}, False),
    # --- 非 zip 形态 ---
    ('no-code-source-no-app-id', {'packageUrl': 'https://cdn.example/x.zip'}, False),
    ('plain-python-task', {'runtime': 'python', 'entrypoint': 'main.py'}, False),
    ('git-only', {'gitRepo': 'https://git.example/r.git'}, False),
    ('glue-only', {'glueSource': 'print(1)', 'glueLanguage': 'python'}, False),
]


@pytest.mark.parametrize('label,task,expected', ZIP_CHANNEL_CASES,
                         ids=[c[0] for c in ZIP_CHANNEL_CASES])
def test_zip_channel_matches_contract_and_admin(label, task, expected):
    """渠道判定逐格与契约 / admin 对齐（**含**歧义行：无 packageUrl 也算 zip）。"""
    assert execute_module._zip_channel_enabled(task) is expected, (
        f'{label}: `_zip_channel_enabled` 判 {not expected} —— '
        '与契约 CONTRACT.md:355/430 及 admin resolveDispatchTask 的口径不符'
    )


# ---------------------------------------------------------------------------
# 判据 2：歧义行在 accept 期必须**显式拒绝**（不是「照常跑」）
# ---------------------------------------------------------------------------


@pytest.fixture
def idle_executor(monkeypatch):
    """把容量/后台任务副作用降到最小 —— 让「闸门没生效」表现为干净的
    `DID NOT RAISE`，而不是 `no running event loop` 这类无关噪声。"""
    from unittest.mock import MagicMock

    monkeypatch.setattr(execute_module.sched, 'get_running_count', lambda: 0)
    monkeypatch.setattr(execute_module.sched, 'increment_running', lambda: None)
    monkeypatch.setattr(execute_module.settings, 'max_concurrent_tasks', 10)

    def fake_create_task(coro):
        coro.close()
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)


@pytest.fixture
def work_dir(monkeypatch, tmp_path):
    root = tmp_path / 'work'
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(root))
    return root


def test_ambiguous_row_is_rejected_at_accept(idle_executor, work_dir):
    """歧义行（无 codeSource + 有 applicationId + 无 packageUrl）：
    accept 期 **400**（契约 `enforcement.stage=accept`），而不是「照常跑」。

    ADR-035 §2.2：走 zip 渠道 ⇒ 载荷必须带 `packageUrl` ⇒ 不带 ⇒ 400。
    改前 python 判「非 zip」⇒ 照常跑（不下载、不建 venv）—— 与 admin 的
    「派发期就失败」不一致，且「静默按普通任务跑」违背契约的存量回填语义。
    """
    eid = 'exec-r76-ambiguous'
    req = execute_module.ExecuteRequest(
        executionId=eid,
        task={'runtime': 'python', 'applicationId': 'app-r76'},   # 无 codeSource、无 packageUrl
    )

    with pytest.raises(ExecutionRejected) as excinfo:
        execute_module.accept_execution(req)

    assert excinfo.value.status_code == 400, '歧义行必须在 accept 期 400（不是照常跑）'
    detail = str(excinfo.value.detail)
    assert 'packageUrl' in detail, (
        f'拒绝文案应指向载荷缺 packageUrl（本层可验证的事实），实际：{detail}'
    )
    # 契约两条不变量：不留 live 条目、不建 work_dir。
    assert execute_module.execution_exists(eid) is False
    assert not (work_dir / eid).exists()


def test_explicit_zip_without_url_is_also_rejected_at_accept(idle_executor, work_dir):
    """显式 zip（`codeSource='application_zip'`）但缺 `packageUrl`：
    同样 accept 期 400（改前也是 400，此处防回归）。"""
    eid = 'exec-r76-explicit-no-url'
    req = execute_module.ExecuteRequest(
        executionId=eid,
        task={'runtime': 'python', 'codeSource': 'application_zip', 'applicationId': 'app-r76'},
    )

    with pytest.raises(ExecutionRejected) as excinfo:
        execute_module.accept_execution(req)
    assert excinfo.value.status_code == 400
    assert execute_module.execution_exists(eid) is False


# ---------------------------------------------------------------------------
# 判据 3：反向护栏（合法 zip 任务不受影响）
# ---------------------------------------------------------------------------


def test_legit_zip_task_still_proposed_for_accept(idle_executor, work_dir, monkeypatch):
    """合法 zip 任务（带公网 packageUrl）仍被接受 —— 防「收成一律拒绝」。"""
    from unittest.mock import MagicMock

    def fake_create_task(coro):
        coro.close()
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', 'https://admin.example')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')

    eid = 'exec-r76-legit-zip'
    req = execute_module.ExecuteRequest(
        executionId=eid,
        task={'runtime': 'python', 'applicationId': 'app-r76',
              'packageUrl': 'https://cdn.example/app.zip'},
    )
    try:
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'
    finally:
        execute_module.unregister_live_execution(eid)
