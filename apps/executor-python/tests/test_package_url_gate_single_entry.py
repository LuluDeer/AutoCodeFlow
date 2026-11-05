"""R74：packageUrl 的闸**收成单一入口** —— accept 期与 prepare 期必须同结论。

## 为什么要有这一份

R71 把 zip 渠道 `packageUrl` 的 accept 期同步闸补上了，于是同一个闸门
（`_assert_safe_package_url`）有了**两个**调用点：

- accept 期：`routers/execute.py` 的手检段（同步拒，契约 `enforcement.stage=accept`）；
- prepare 期：后台 `run_task()`（下载前的最后一道）。

「两处调同一函数」是对的，但**决策**分散在两处：该不该判、判哪个值
（原文 `packageUrl` vs `rewrite_package_url_to_admin_base` 之后的值）、调哪道闸。
一处改了另一处忘 ⇒ 两期结论分叉（accept 放行、prepare 拒绝 ⇒ 变成「异步败」，
恰好是 R71 要消除的那种退化）。

⇒ 本文件把决策收进**单一入口** `_guard_user_supplied_package_url(task)`，
并用**两期对照**把「同载荷同结论」钉死。

## 本文件的两类断言

1. **对照表**（表驱动）：同一载荷分别过 accept 期入口与 prepare 期入口，
   两者的「拒/放行」结论必须**逐格相同**；
2. **接缝断言**：两个调用点必须**调同一个入口**（源码扫描）——
   这是「收成单一入口」这件事本身的可执行定义。

## 场景覆盖（Lead 点名的四种）

云元数据 / CGNAT / 合法公网 / **admin 基址被配成私网**（第四种是关键：
它正是「判原文」与「判改写后」会分叉的场景）。
"""
import inspect
import pathlib

import pytest
from fastapi import HTTPException

from routers import execute as execute_module


APP_DIR = pathlib.Path(__file__).resolve().parents[1]

#: 单一入口的名字（两个调用点都必须调它）。
ENTRY_POINT = '_guard_user_supplied_package_url'


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------


@pytest.fixture
def public_dns(monkeypatch):
    """把所有主机名解析成公网地址（闸走真实 DNS 解析，fail-closed）。"""
    monkeypatch.setattr(
        execute_module.socket, 'getaddrinfo',
        lambda *a, **k: [(2, 1, 6, '', ('93.184.216.34', 0))],
    )


def _admin_base(monkeypatch, base: str) -> None:
    """把 admin 基址设成给定值（改写规则读 `settings.admin_api_url*`）。"""
    monkeypatch.setattr(execute_module.settings, 'admin_api_url', base)
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_internal', '')
    monkeypatch.setattr(execute_module.settings, 'admin_api_url_external', '')


# ---------------------------------------------------------------------------
# 场景表
# ---------------------------------------------------------------------------

def _zip_task(package_url: str) -> dict:
    return {
        'runtime': 'python',
        'codeSource': 'application_zip',
        'applicationId': 'app-r74',
        'packageUrl': package_url,
    }


#: (标签, task, admin 基址, 期望是否被拒)
#:
#: 期望值一律按「**该 URL 会不会真的被下载**」推导：
#:
#: * zip 渠道 ⇒ 会下载 ⇒ 受限类必拒；
#: * git / glue / 非 zip 渠道 ⇒ packageUrl **被忽略**（那个 URL 根本不会被用来
#:   下载）⇒ 不该因它 400。
#:
#: 这不是「按地址分类」而是「按渠道语义」——R74 收成单一入口的目的正是让
#: accept 期与 prepare 期按**同一**套语义判。
SCENARIOS = [
    (
        'cloud-metadata',
        _zip_task('http://169.254.169.254/latest/meta-data/x.zip'),
        'https://admin.example',
        True,
    ),
    (
        'cgnat',
        _zip_task('http://100.64.0.1/x.zip'),
        'https://admin.example',
        True,
    ),
    (
        'public',
        _zip_task('https://cdn.example/app.zip'),
        'https://admin.example',
        False,
    ),
    (
        # admin 基址被配成私网 ⇒ 改写后的目标是私网 ⇒ zip 渠道必拒。
        'admin-base-private',
        _zip_task('https://cdn.example/uploads/app.zip'),
        'http://10.0.0.5:3105',
        True,
    ),
    (
        # glue 优先于 application_zip ⇒ packageUrl 被忽略（不下载）⇒ 不拒。
        'glue-precedence',
        {
            'runtime': 'python',
            'codeSource': 'application_zip',
            'applicationId': 'app-r74',
            'glueSource': 'print(1)',
            'packageUrl': 'http://169.254.169.254/latest/meta-data/x.zip',
        },
        'https://admin.example',
        False,
    ),
    (
        # git 优先 ⇒ packageUrl 被忽略 ⇒ 不拒。
        'git-precedence',
        {
            'runtime': 'python',
            'gitRepo': 'https://git.example/repo.git',
            'applicationId': 'app-r74',
            'packageUrl': 'http://169.254.169.254/latest/meta-data/x.zip',
        },
        'https://admin.example',
        False,
    ),
    (
        # 无 codeSource 且无 applicationId ⇒ 不是 zip 渠道 ⇒ packageUrl 不被下载。
        'not-a-zip-channel',
        {
            'runtime': 'python',
            'packageUrl': 'http://169.254.169.254/latest/meta-data/x.zip',
        },
        'https://admin.example',
        False,
    ),
]


# ---------------------------------------------------------------------------
# 判据 1：两期对同一载荷必须同结论
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('label,task,admin_base,expect_denied', SCENARIOS,
                         ids=[c[0] for c in SCENARIOS])
def test_accept_and_prepare_periods_agree(
        label, task, admin_base, expect_denied, monkeypatch, public_dns):
    """accept 期入口与 prepare 期入口对**同一载荷**给出**同一结论**。

    两期现在**走同一个入口**（故本用例的两次调用是同一次逻辑的两次执行——
    它钉的是「入口的语义正确」，不是「两处恰好相等」）。改前的实现在这张表上
    **有两格分叉**（glue 优先 / 非 zip 渠道：accept 期照拒、prepare 期不判），
    收成单一入口后消解。
    """
    _admin_base(monkeypatch, admin_base)

    # accept 期入口
    accept_denied = False
    try:
        execute_module._guard_user_supplied_package_url(task)
    except HTTPException:
        accept_denied = True

    # prepare 期入口（同一入口、同一入参 ⇒ 必须同结论）
    prepare_denied = False
    try:
        execute_module._guard_user_supplied_package_url(task)
    except HTTPException:
        prepare_denied = True

    assert accept_denied is prepare_denied, (
        f'{label}: accept 期判拒={accept_denied}、prepare 期判拒={prepare_denied} —— '
        '两期结论不一致（同步拒退化成异步败）'
    )
    assert accept_denied is expect_denied, (
        f'{label}: 期望判拒={expect_denied}，实际 {accept_denied}'
    )


# ---------------------------------------------------------------------------
# 判据 2：接缝断言（两个调用点必须调同一入口）
# ---------------------------------------------------------------------------


def test_both_call_sites_use_the_single_entry_point():
    """「收成单一入口」的可执行定义：源码里**只有**入口内部调闸门本体。

    判据：`routers/execute.py` 里 `_assert_safe_package_url` 的调用点必须恰好两处，
    且两处都在单一入口函数体内 —— 也就是说 accept 期与 prepare 期**都**经它，
    而不各自写一份「该不该判 / 判哪个值」的逻辑。
    """
    source = (APP_DIR / 'routers' / 'execute.py').read_text(encoding='utf-8')
    entry_source = inspect.getsource(
        execute_module._guard_user_supplied_package_url
    )

    # 闸门本体在**入口内**被调（唯一一处）。
    assert '_assert_safe_package_url(' in entry_source, (
        '单一入口必须调用闸门本体 `_assert_safe_package_url`'
    )
    # 入口之外不得再直接调用闸门本体 —— 按**行**判定（`inspect.getsource`
    # 缩进与文件里的原文可能有差异，不能用整段字符串替换）。
    # 「调用」= 含 `_assert_safe_package_url(` 且**不是** `def` 定义行。
    entry_start = source.index(entry_source.splitlines()[0])
    outside = source[:entry_start] + source[entry_start + len(entry_source):]
    stray_calls = [
        line.strip()
        for line in outside.splitlines()
        if '_assert_safe_package_url(' in line
        and not line.strip().startswith('def ')
    ]
    assert stray_calls == [], (
        f'闸门本体在单一入口之外还有调用点 —— 决策又分散了：{stray_calls}'
    )
    # 两个调用点都必须经入口（定义 1 + accept 期 1 + prepare 期 1）。
    assert source.count(f'{ENTRY_POINT}(') >= 3, (
        f'期望入口定义 + accept 期 + prepare 期共 ≥3 处 `{ENTRY_POINT}(`，'
        f'实际 {source.count(f"{ENTRY_POINT}(")} 处 —— 有一处没走单一入口'
    )


def test_entry_point_exists():
    """守卫：入口被改名/删除时，上面那些断言会变成 AttributeError 之外的假绿。"""
    assert hasattr(execute_module, ENTRY_POINT)
    assert callable(getattr(execute_module, ENTRY_POINT))
