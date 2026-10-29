"""EXEC-01（审计 P2）：`/execute` 请求模型的**唯一性**守卫。

背景：`routers/execute.py` 曾经是

    try:
        from autocodeflow_sdk.models import ExecuteRequest
    except ImportError:
        <本地 fallback 模型>

两份模型字段语义不同 —— SDK 那份 ``task: TaskConfig``（嵌套模型）且**没有
``secrets`` 字段**，而 execute.py 全篇按 dict 消费 ``req.task``（``.get('requirements')``、
``.get('gitRepo')``、``merge_task_with_manifest``）并读 ``getattr(req, 'secrets', None)``。
于是"这台机器的镜像里是否恰好 ``pip install`` 了 ``packages/autoflow-sdk``"这一偶然
事实决定 /execute 是正常还是**每个任务都 500 + 凭据静默丢弃**——两份模型谁生效不该
由环境决定。

本文件把"只剩一份、且那份的形状是本文件真实消费的形状"钉成断言（纯静态 + 模型层，
不跑执行链；执行行为由 test_execute*.py 覆盖）：

  1. AST 断言 execute.py 不再 import ``autocodeflow_sdk``（含 try/except、函数内导入）；
  2. 断言运行时真在用的类 ``ExecuteRequest`` 定义在本模块（不是被 re-export 的 SDK 类）；
  3. 断言字段面 = 真实消费面，``task`` 是 dict 形态（可 ``.get``）、``secrets`` 存在且可空；
  4. 断言 ``secrets`` 是**字段访问**而非 ``getattr`` 兜底（兜底会把"模型漂移"藏成 None）。
"""
import ast
from pathlib import Path
from typing import Any, get_args, get_origin

from routers import execute as execute_module

# 本文件对 req 的属性访问只有这四个（grep `req\.` 的全集：executionId / task /
# params / model_dump，model_dump 不是字段）。字段面若变化必须同步本清单——这正是
# "字段由消费面决定"的可执行版本。
_CONSUMED_FIELDS = {'executionId', 'task', 'params', 'secrets'}


def _source() -> str:
    return Path(execute_module.__file__).read_text(encoding='utf-8')


def _imported_modules(tree: ast.AST) -> set[str]:
    """模块内所有 import 的模块名（``import a.b`` 记 'a.b'，``from a.b import c`` 记 'a.b'）。"""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            # 相对导入（level>0）没有 module 名前缀，与 SDK 无关
            if node.module and node.level == 0:
                names.add(node.module)
    return names


# ---------------------------------------------------------------------------
# 1) 静态守卫：不再有 SDK 导入分支（防回归）
# ---------------------------------------------------------------------------


def test_execute_module_does_not_import_sdk():
    """回归守卫：把 `try: from autocodeflow_sdk.models import ...` 加回来即红。

    用 AST 而不是子串匹配源码：本模块的**注释**里刻意留了旧代码的形状（解释为什么
    删掉它），子串断言会被自己的文档绊倒；而 AST 只看真实 import 节点，函数体、
    try/except、``if TYPE_CHECKING`` 里的导入全都在 ``ast.walk`` 覆盖范围内。
    """
    tree = ast.parse(_source())
    offenders = sorted(
        name for name in _imported_modules(tree)
        if name == 'autocodeflow_sdk' or name.startswith('autocodeflow_sdk.')
    )
    assert offenders == [], (
        'routers/execute.py 不允许再 import SDK 的请求模型——SDK 的 ExecuteRequest '
        f'是 task: TaskConfig 且没有 secrets 字段（EXEC-01）；实际导入：{offenders}'
    )


def test_execute_request_class_is_defined_in_this_module():
    """真在用的类必须是本模块定义的，而不是从任何地方 re-export 来的。

    与上一条互补：上一条抓 import 语句，这一条抓"绕过 import 的替换"（例如
    ``ExecuteRequest = some_other_module.ExecuteRequest`` 或从别的本地模块转发）。
    """
    tree = ast.parse(_source())
    classdefs = {node.name for node in tree.body if isinstance(node, ast.ClassDef)}
    assert 'ExecuteRequest' in classdefs, 'routers/execute.py 必须自己定义 ExecuteRequest'
    assert execute_module.ExecuteRequest.__module__ == execute_module.__name__, (
        f'ExecuteRequest 来自 {execute_module.ExecuteRequest.__module__}，'
        f'不是 {execute_module.__name__}——请求模型又变成外部依赖了'
    )


# ---------------------------------------------------------------------------
# 2) 字段面：= 真实消费面
# ---------------------------------------------------------------------------


def test_declared_fields_match_the_consumed_surface():
    fields = set(execute_module.ExecuteRequest.model_fields)
    assert fields == _CONSUMED_FIELDS, (
        '字段面必须与 execute.py 真实消费的入参一致；'
        f'多出 {sorted(fields - _CONSUMED_FIELDS)}，缺少 {sorted(_CONSUMED_FIELDS - fields)}'
    )


def test_task_annotation_is_dict_shaped():
    """``task`` 必须是 ``Dict[str, Any]``：本文件 13 处 ``req.task`` 属性访问，其中
    ``accept_execution`` 的 requirements 手检与 ``run_task`` 的 gitRepo 解析用 ``.get(...)``。

    若退回 SDK 的 ``task: TaskConfig``，这些行在运行时是 AttributeError（
    ``TaskConfig`` 没有 ``.get``）——这正是 EXEC-01 的 500 根因，故连注解形态一起钉住。
    """
    annotation = execute_module.ExecuteRequest.model_fields['task'].annotation
    assert get_origin(annotation) is dict, f'task 必须是 dict 形态，实际 {annotation!r}'
    assert get_args(annotation) == (str, Any)


def test_secrets_field_exists_and_is_optional_dict():
    """SEC-02 的凭据段必须是**声明字段**：形状对齐协议（record|null）与 inject_secret_env。"""
    field = execute_module.ExecuteRequest.model_fields['secrets']
    args = get_args(field.annotation)
    assert type(None) in args, f'secrets 必须可空（node zod 允许 null/undefined），实际 {field.annotation!r}'
    dict_args = [arg for arg in args if get_origin(arg) is dict]
    assert len(dict_args) == 1, f'secrets 必须是 dict 形态，实际 {field.annotation!r}'
    assert get_args(dict_args[0]) == (str, Any)
    assert field.default is None


def test_params_field_exists_and_is_optional_dict():
    field = execute_module.ExecuteRequest.model_fields['params']
    assert type(None) in get_args(field.annotation)
    assert field.default is None


def test_secrets_is_read_as_a_plain_field_not_getattr():
    """``getattr(req, 'secrets', None)`` 是旧的故障放大器：模型没有该字段时

    凭据被静默变成 None（**一个 warning 都不留**）。字段既然由模型保证，就必须
    直接读——兜底会把"模型又漂移了"藏成"这个任务没配凭据"。

    同样用 AST 而非子串：本模块注释里为解释改动保留了 ``getattr(req, 'secrets', ...)``
    的原文，子串断言会被自己的文档绊倒。这里要求的是"没有任何 getattr(req, ...)"，
    并正向断言注入调用读的是 ``req.secrets`` 属性。
    """
    tree = ast.parse(_source())
    getattr_on_req = [
        ast.unparse(node)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == 'getattr'
        and node.args
        and isinstance(node.args[0], ast.Name)
        and node.args[0].id == 'req'
    ]
    assert getattr_on_req == [], (
        '请求字段必须直接访问（模型已保证存在），不能再 getattr 兜底：'
        f'{getattr_on_req}'
    )

    inject_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == 'inject_secret_env'
    ]
    assert inject_calls, 'inject_secret_env 调用点不见了（SEC-02 凭据注入被删？）'
    assert any(
        len(node.args) >= 2
        and isinstance(node.args[1], ast.Attribute)
        and node.args[1].attr == 'secrets'
        and isinstance(node.args[1].value, ast.Name)
        and node.args[1].value.id == 'req'
        for node in inject_calls
    ), 'SEC-02 的凭据注入必须直接读 req.secrets'


# ---------------------------------------------------------------------------
# 3) 模型层行为：线上载荷进来后仍是 dict，secrets 可达
# ---------------------------------------------------------------------------


def test_wire_payload_keeps_task_as_dict_and_secrets_reachable():
    """admin 的真实载荷（含 task 嵌套字段与 secrets）反序列化后：

    * ``task`` 仍是 dict，``.get(...)`` 照常（``accept_execution`` 的 requirements 手检 /
      ``run_task`` 的 gitRepo 解析）；
    * ``secrets`` 是字段，值原样保留（SEC-02 按原名注入的输入）；
    * ``model_dump()`` 带着 secrets —— 协议闸门 ``ProtocolExecuteRequest`` 看的就是它。
    """
    payload = {
        'executionId': 'exec-exec01-wire',
        'task': {
            'id': 'task-1',
            'requirements': ['requests==2.32.0'],
            'gitRepo': 'https://git.example.com/group/repo.git',
        },
        'params': {'GREETING': 'hi'},
        'secrets': {'FEISHU_APP_ID': 'cli_abc', 'FEISHU_APP_SECRET': 's3cr3t'},
    }
    req = execute_module.ExecuteRequest.model_validate(payload)

    assert isinstance(req.task, dict)
    assert req.task.get('requirements') == ['requests==2.32.0']
    assert req.task.get('gitRepo') == 'https://git.example.com/group/repo.git'
    assert req.params == {'GREETING': 'hi'}
    assert req.secrets == {'FEISHU_APP_ID': 'cli_abc', 'FEISHU_APP_SECRET': 's3cr3t'}
    assert req.model_dump()['secrets'] == payload['secrets']


def test_defaults_mean_no_params_no_secrets_without_attribute_error():
    """缺省载荷（pull 循环里的最小 body）不能因为字段缺失而 AttributeError。"""
    req = execute_module.ExecuteRequest(executionId='exec-exec01-min', task={'name': 'noop'})
    assert req.params is None
    assert req.secrets is None
    # 直接属性访问（不是 getattr 兜底）也不需要 try/except：注入侧把 None 当"无凭据"
    assert execute_module.inject_secret_env({}, req.secrets) == []


def test_unknown_top_level_keys_are_ignored_not_forwarded():
    """``extra='ignore'`` 是刻意选择（不是 pydantic 默认值的偶然结果）。

    本文件没有任何"透传未知顶层字段"的消费方，被删掉的 SDK 分支与旧 fallback 也都是
    默认 ignore；显式钉住它，防止将来有人为了"兼容"改成 ``extra='allow'`` 却没同步
    协议闸门（那会把用户没声明的键喂进 ``req.model_dump()``）。
    """
    assert execute_module.ExecuteRequest.model_config.get('extra') == 'ignore'
    req = execute_module.ExecuteRequest.model_validate({
        'executionId': 'exec-exec01-extra',
        'task': {'name': 'noop'},
        'someFutureField': {'nested': 1},
    })
    assert 'someFutureField' not in req.model_dump()


def test_dict_consumers_still_work_end_to_end():
    """消费者契约：``_derive_task_key`` 对同一个 req 做 ``task.get('id')``。

    旧 SDK 模型下 ``task`` 是 ``TaskConfig``：``isinstance(task, dict)`` 为假，
    这里会退回 executionId —— 断言因此变红（而在真正执行链上是 AttributeError）。
    """
    req = execute_module.ExecuteRequest(
        executionId='exec-exec01-consumer', task={'id': 'task-consumer'}
    )
    assert execute_module._derive_task_key(req) == 'task-consumer'
