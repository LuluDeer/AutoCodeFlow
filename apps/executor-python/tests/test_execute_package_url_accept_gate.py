"""R71：zip 渠道 `packageUrl` 的 **accept 期**同步闸（契约 `enforcement.stage = accept`）。

## 为什么要有这一份

契约 `packages/executor-protocol/protocol.json` 的 `networkPolicy.enforcement` 写死四条：

```text
stage = "accept"        httpStatus = 400
mustNotLeaveLiveEntry   mustNotCreateWorkDir
```

注释原文：「SSRF 类非法载荷若留到后台 prepare 才拒，执行器会先「接单」（占容量槽、
admin 侧记 RUNNING、再收到 failed 回调）——拒绝语义从「同步拒」退化成「异步败」」。

改前 python 侧：`accept_execution()` 只查停机/容量/磁盘/`_validate_git_repo_task`/
协议 schema，**对 `packageUrl` 无任何 host 闸**；闸门本体 `_assert_safe_package_url`
的唯一调用点在后台 `run_task()` 里（且晚于 `work_dir` 创建）⇒ 三条不变量全不满足。
（node 侧同款缺口已在 `7985d945` 修掉；本文件是 python 侧的对齐。）

## 判据三条

1. **accept 期同步拒**：受限类地址 ⇒ `ExecutionRejected(400)`，且**不登记 live 条目**；
2. **`mustNotCreateWorkDir`**：被拒时 `work_dir` **不得存在**（用 tmp 目录断言不存在）；
3. **不误伤 git 渠道**：带 `gitRepo` 的任务，其 `packageUrl` 被忽略
   （优先级 git > glue > application_zip）⇒ 不该因它 400（node 同口径）。

## 反向护栏

- 公网 `packageUrl` 仍被接受（防「收成 deny-all」）；
- 非 zip 渠道（glue / 普通任务）**没有** `packageUrl` ⇒ 不受影响。
"""
from unittest.mock import MagicMock

import pytest

from routers import execute as execute_module
from routers.execute import ExecutionRejected


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------


@pytest.fixture
def idle_executor(monkeypatch):
    """把容量/后台任务副作用降到最小（与 test_execute_protocol_gate.py 同款）。

    `create_task` 也被替换：闸门失效时载荷会被接受并继续往后走（登记 + create_task），
    真实协程没人 await ⇒ `filterwarnings = error` 下抛
    `PytestUnraisableExceptionWarning`（变成与被测行为无关的噪声）。这里让它
    立刻关闭协程，使「闸门失效」表现为**干净的 DID NOT RAISE 断言失败**。
    """
    monkeypatch.setattr(execute_module.sched, 'get_running_count', lambda: 0)
    monkeypatch.setattr(execute_module.sched, 'increment_running', lambda: None)
    monkeypatch.setattr(execute_module.settings, 'max_concurrent_tasks', 10)

    def fake_create_task(coro):
        coro.close()
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)


@pytest.fixture
def work_dir(monkeypatch, tmp_path):
    """把 work_dir 指到临时目录 —— 用它断言「被拒时不得创建工作目录」。"""
    root = tmp_path / 'work'
    monkeypatch.setattr(execute_module.settings, 'work_dir', str(root))
    return root


@pytest.fixture
def public_dns(monkeypatch):
    """把主机名解析成公网地址。

    gitRepo / packageUrl 的闸走**真实 DNS 解析**（契约 resolution.mode =
    dns-resolve，fail-closed）。沙箱里 `git.example.com` 永远解析不出来 ⇒
    「公网 gitRepo 正常被接受」会因 DNS 而非主题失败（与 test_execute.py 的
    `_patch_public_dns` 同款处置）。
    """
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )


def _zip_task(package_url: str) -> dict:
    """zip 渠道载荷（与 node 的 zipBody 同形：codeSource + applicationId + packageUrl）。"""
    return {
        'runtime': 'python',
        'codeSource': 'application_zip',
        'applicationId': 'app-r71',
        'packageUrl': package_url,
    }


#: 受限类地址（与 node 的 5 条同集合：云元数据 / CGNAT / loopback / IPv6 link-local /
#: 非 http(s) scheme）。地址取自**契约**（见 test_posture_matrix.py 的读法），
#: 这里用字面量是因为本文件断言的是「具体 URL 的 accept 期结论」。
RESTRICTED_URLS = [
    ('cloud-metadata', 'http://169.254.169.254/latest/meta-data/x.zip'),
    ('cgnat', 'http://100.64.0.1/x.zip'),
    ('loopback', 'http://127.0.0.1:8080/x.zip'),
    ('ipv6-link-local', 'http://[fe80::1]/x.zip'),
    ('non-http-scheme', 'file:///etc/passwd'),
]


# ---------------------------------------------------------------------------
# 判据 1：accept 期同步拒
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('label,url', RESTRICTED_URLS, ids=[c[0] for c in RESTRICTED_URLS])
def test_zip_package_url_is_rejected_at_accept_stage(
        label, url, idle_executor, work_dir):
    """受限类 packageUrl ⇒ accept 期 400（不是后台异步失败）。"""
    eid = f'exec-r71-{label}'
    req = execute_module.ExecuteRequest(executionId=eid, task=_zip_task(url))

    with pytest.raises(ExecutionRejected) as excinfo:
        execute_module.accept_execution(req)

    assert excinfo.value.status_code == 400, f'{url} 应当在 accept 期被 400 拒绝'
    assert '出站目标被拒' in str(excinfo.value.detail), (
        f'{url} 的拒绝文案应点名「出站目标被拒」，实际：{excinfo.value.detail}'
    )
    # mustNotLeaveLiveEntry：被拒不得留下 live 条目。
    assert execute_module.execution_exists(eid) is False
    # mustNotCreateWorkDir：被拒不得创建工作目录。
    assert not (work_dir / eid).exists(), '被拒时不得创建 work_dir（契约 mustNotCreateWorkDir）'


# ---------------------------------------------------------------------------
# 判据 2：不误伤 git 渠道（packageUrl 被忽略）
# ---------------------------------------------------------------------------


def test_git_task_with_restricted_package_url_is_not_rejected(
        idle_executor, work_dir, public_dns, monkeypatch):
    """带 `gitRepo` 的任务：其 `packageUrl` **被忽略**（优先级 git > glue > zip）。

    node 同口径（`7985d945` 的注释：「只判『会真的被用来下载』的形态」）——
    若这里也判 packageUrl，git 渠道的任务会因为一个**用不到**的字段被 400。
    """
    created: list = []

    def fake_create_task(coro):
        created.append(coro)
        coro.close()
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)

    eid = 'exec-r71-git-precedence'
    req = execute_module.ExecuteRequest(
        executionId=eid,
        task={
            'runtime': 'python',
            'gitRepo': 'https://git.example.com/org/repo.git',
            'packageUrl': 'http://169.254.169.254/latest/meta-data/x.zip',
        },
    )
    try:
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'
    finally:
        execute_module.unregister_live_execution(eid)


# ---------------------------------------------------------------------------
# 判据 3：反向护栏（不得收成 deny-all）
# ---------------------------------------------------------------------------


def test_public_package_url_is_still_accepted(
        idle_executor, work_dir, public_dns, monkeypatch):
    """公网 packageUrl 仍被 accept（防「闸门收成一律拒绝」）。"""
    created: list = []

    def fake_create_task(coro):
        created.append(coro)
        coro.close()
        return MagicMock()

    monkeypatch.setattr(execute_module.asyncio, 'create_task', fake_create_task)

    eid = 'exec-r71-public'
    req = execute_module.ExecuteRequest(
        executionId=eid,
        task=_zip_task('https://example.com/app.zip'),
    )
    try:
        result = execute_module.accept_execution(req)
        assert result['status'] == 'accepted'
    finally:
        execute_module.unregister_live_execution(eid)
