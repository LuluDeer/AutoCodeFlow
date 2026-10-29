"""SEC-02 续 + I18N-01：python 侧 secrets 原名注入与编码开关的对等性。

与 ``apps/executor-node/src/secret-env.spec.ts`` 逐条对等——两侧必须给出**同一个
判断**，否则同一任务在 node 执行器上能拿到凭据、在 python 执行器上被拒绝
（或反之），这种分叉比两边都不支持更难排查。

另有 I18N-01 的守卫：PYTHONIOENCODING/PYTHONUTF8 必须被注入，且不得被
secret 覆盖——两处修复的交叉点。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from secret_env import inject_secret_env, is_injectable_secret_name

EXECUTE_PY = Path(__file__).resolve().parents[1] / 'routers' / 'execute.py'


class TestInjectableSecretName:
    @pytest.mark.parametrize('name', [
        'FEISHU_APP_ID',
        'FEISHU_APP_SECRET',
        'AWS_ACCESS_KEY_ID',       # boto3 认的规范名
        'AWS_SECRET_ACCESS_KEY',
        'OPENAI_API_KEY',
        'GITHUB_TOKEN',
        'MY_KEY_1',
        '_private',
        'lowercase_ok',
    ])
    def test_legal_names_allowed(self, name):
        assert is_injectable_secret_name(name) is True

    @pytest.mark.parametrize('name', [
        '', 'KEY=VALUE', 'MY KEY', 'MY-KEY', 'my.key',
        '1KEY', 'A/B', 'A\nB', 'KEY; rm -rf /', '$HOME',
    ])
    def test_illegal_names_rejected(self, name):
        assert is_injectable_secret_name(name) is False

    # ------------------------------------------------------------------
    # Round6-P3-3（八域审计第 6 轮，执行器域 P3）：**尾随**换行/空白的绕过
    #
    # 缺陷形态：旧判据是 `re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$').match(name)`。
    # python 的 `$`（无 re.M）也匹配「串尾换行之前」的位置，于是 `"FOO\n"` 通过
    # 校验并被原样写进子进程 env —— 一个名为 `FOO\n` 的环境变量既无法被 shell
    # 引用、在 Windows env 块里也不能表达，且它与合法名 `FOO` 在日志/审计里
    # 逐字不可区分（真正的 `FOO` 反而**没有**被注入：脚本报「缺凭据」）。
    # 而 node 的 JS `$` 只匹配真末尾，`isInjectableSecretName("FOO\n")` 为 false
    # 并记一条 warn —— 同一份 secrets 在两端得到相反的注入结果。
    #
    # 判据收敛到更严的一侧（丢掉 `$` 锚点 + `fullmatch`，与同仓
    # `routers/execute.py::_is_injectable_param_key` 的既有处置一致）。
    # ------------------------------------------------------------------

    @pytest.mark.parametrize('name', ['FOO\n', 'FOO ', 'FOO\t'])
    def test_trailing_whitespace_names_rejected(self, name):
        """尾随换行/空格/制表符一律拒绝——与 node `SAFE_SECRET_NAME_RE.test` 同判。"""
        assert is_injectable_secret_name(name) is False

    @pytest.mark.parametrize('name', ['\nFOO', ' FOO', '\tFOO', 'FO\nO', 'FOO\r\n', 'FOO\r'])
    def test_leading_and_embedded_whitespace_names_rejected(self, name):
        """首部/中部/CRLF 同样拒绝（`fullmatch` 语义：整串必须被字符类覆盖）。"""
        assert is_injectable_secret_name(name) is False

    def test_trailing_whitespace_name_is_not_injected(self):
        """行为级反证：`{"FOO\\n": "v"}` 必须被跳过并上报，且不污染 `FOO`。"""
        env = {}
        skipped = inject_secret_env(env, {'FOO\n': 'v', 'FOO': 'real'})

        assert skipped == ['FOO\n']
        assert env == {'FOO': 'real'}, (
            '尾随换行名不得落进 env（它会让同一份配置在 node/python 执行器上'
            '给出不同的注入结果）'
        )

    @pytest.mark.parametrize('name', ['FOO\n', 'FOO '])
    def test_node_regex_semantics_reference(self, name):
        """钉住「node 拒绝」这一侧：JS 的 `$`（无 m 标志）只匹配真末尾。

        这里不复刻 JS 引擎，只断言本侧已与 node 同判（`fullmatch` = 整串覆盖）。
        对照组：同样两个载荷在**改动前**的 `re.match(r'^...$')` 下均为 True
        （见 test_trailing_whitespace_names_rejected 的反证注释）。
        """
        import re as _re
        old = _re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', name)
        # `FOO ` 旧判据本来就拒（`$` 只放过换行）；`FOO\n` 旧判据放行 —— 正是漏洞。
        assert (old is not None) is name.endswith('\n')
        assert is_injectable_secret_name(name) is False

    def test_path_rejected(self):
        """PATH 被拒绝——否则子进程连解释器都找不到。"""
        assert is_injectable_secret_name('PATH') is False
        assert is_injectable_secret_name('Path') is False   # Windows 拼法

    @pytest.mark.parametrize('name', [
        'EXECUTOR_SHARED_TOKEN', 'EXECUTOR_SECRET', 'EXECUTION_CALLBACK_SECRET',
        'EXECUTION_ID', 'TASK_ID', 'TASK_NAME',
        'AUTOFLOW_FOO', 'AUTOFLOW_CALLBACK_TOKEN',
    ])
    def test_reserved_names_rejected(self, name):
        assert is_injectable_secret_name(name) is False

    @pytest.mark.parametrize('name', [
        'PYTHONIOENCODING', 'PYTHONUTF8', 'PYTHONPATH',
        'PYTHONSTARTUP', 'PYTHONHOME',
    ])
    def test_python_prefix_rejected(self, name):
        """PYTHON* 前缀被拒绝——执行器必须独占日志编码开关（I18N-01）。"""
        assert is_injectable_secret_name(name) is False


class TestInjectSecretEnv:
    def test_injects_under_original_name(self):
        """按原名写入，不做大小写变换、不加前缀。"""
        env = {}
        skipped = inject_secret_env(env, {
            'FEISHU_APP_ID': 'cli_abc',
            'FEISHU_APP_SECRET': 'sec_xyz',
        })
        assert skipped == []
        assert env['FEISHU_APP_ID'] == 'cli_abc'
        assert env['FEISHU_APP_SECRET'] == 'sec_xyz'
        # 关键反证：不得出现带前缀的形态
        assert 'AUTOFLOW_FEISHU_APP_ID' not in env

    def test_non_string_values_stringified(self):
        env = {}
        inject_secret_env(env, {'PORT': 8080, 'FLAG': True})
        assert env['PORT'] == '8080'
        assert env['FLAG'] == 'True'

    def test_none_values_skipped(self):
        """None 值跳过（不写成语义错误的字面量 'None'）。"""
        env = {}
        inject_secret_env(env, {'A': None, 'C': 'ok'})
        assert 'A' not in env
        assert env['C'] == 'ok'

    def test_skipped_names_returned_and_not_written(self):
        env = {}
        skipped = inject_secret_env(env, {
            'GOOD_KEY': 'v',
            'PATH': '/evil',
            'BAD-NAME': 'v',
            'AUTOFLOW_X': 'v',
            'PYTHONIOENCODING': 'latin-1',
        })
        assert sorted(skipped) == sorted(
            ['AUTOFLOW_X', 'BAD-NAME', 'PATH', 'PYTHONIOENCODING'])
        assert env['GOOD_KEY'] == 'v'
        assert 'PATH' not in env
        assert 'PYTHONIOENCODING' not in env

    def test_does_not_overwrite_existing_reserved_vars(self):
        """被拒绝的名字绝不能改写调用方已设的值。"""
        env = {
            'PATH': '/usr/bin',
            'PYTHONIOENCODING': 'utf-8',
            'AUTOFLOW_CALLBACK_TOKEN': 'v1.exec-real-token',
        }
        inject_secret_env(env, {
            'PATH': '/evil',
            'PYTHONIOENCODING': 'latin-1',
            'AUTOFLOW_CALLBACK_TOKEN': 'stolen',
        })
        assert env['PATH'] == '/usr/bin'
        assert env['PYTHONIOENCODING'] == 'utf-8'
        assert env['AUTOFLOW_CALLBACK_TOKEN'] == 'v1.exec-real-token'

    @pytest.mark.parametrize('value', [None, {}, []])
    def test_falsy_payload_no_side_effect(self, value):
        env = {'EXISTING': 'x'}
        assert inject_secret_env(env, value) == []
        assert env == {'EXISTING': 'x'}


class TestI18n01EncodingGuard:
    """I18N-01：编码开关必须注入，且不得被 secret 覆盖。"""

    @classmethod
    def setup_class(cls):
        src = EXECUTE_PY.read_text(encoding='utf-8')
        # 剥掉注释行，避免被说明文字里的反面示例绊倒
        cls.code = '\n'.join(
            line for line in src.split('\n')
            if not line.strip().startswith('#')
        )

    def test_pythonioencoding_injected(self):
        assert re.search(r"env\['PYTHONIOENCODING'\]\s*=\s*'utf-8'", self.code)

    def test_pythonutf8_injected(self):
        assert re.search(r"env\['PYTHONUTF8'\]\s*=\s*'1'", self.code)

    def test_injected_after_params_loop(self):
        """注入点在 params 循环之后（用户参数不得覆盖编码开关）。"""
        params_idx = self.code.find("env[f'AUTOFLOW_{k.upper()}']")
        enc_idx = self.code.find("env['PYTHONIOENCODING']")
        assert params_idx > -1
        assert enc_idx > params_idx
