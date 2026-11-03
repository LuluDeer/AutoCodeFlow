r"""
GENERATED — DO NOT EDIT.

来源：packages/executor-protocol/protocol.json 的 failureReason.classifiers 段。
由 node scripts/generate-failure-classifiers.mjs 生成。

python 侧对等物是同目录的 failure-classifier.mjs（node/TS 侧）。

## 为什么两侧逐字等价（不是「看起来像」）

契约的 matcherSubset 禁掉了所有**两语言语义不同**的构造：
\b（JS ASCII / Python Unicode）、$、lookbehind、\d\w\s、Unicode 属性、
反向引用。留下的形态里：token 展开成**显式 ASCII 字符类**（两语言逐字相同）、
词边界用 **sentinel + {{NONWORD}}** 表达、句点归一成 {{ANY_ONE_LINE}}、
大小写折叠由**归一**（小写化）统一做（生成物**不带** re.IGNORECASE——
带标志就等于把 Unicode 大小写折叠差异藏进标志里）。

⚠️ 归一的小写化本身：Python str.lower() 与 JS toLowerCase() 都按 Unicode
Default Case Conversion，但**不是**逐字同义（例如 'İ'）。契约把这点记为
caseFoldEquivalence: measured-by-guard——由守卫在向量上**真执行两侧**并断言
相等，而不是靠本文档承诺。

手改本文件会在下次生成时被覆盖，且不会让契约生效——要改请改 protocol.json。
"""

from __future__ import annotations

import json
import re
from typing import Iterable, Optional

#: 契约 token 表（字符类；**不用** \w/\b/\d —— 那是两语言语义不同的构造）。
TOKENS = json.loads("{\"WS\":\"[ \\\\t\\\\n\\\\r\\\\f\\\\v]\",\"NONWS\":\"[^ \\\\t\\\\n\\\\r\\\\f\\\\v]\",\"WORD\":\"[A-Za-z0-9_]\",\"NONWORD\":\"[^A-Za-z0-9_]\",\"ANY_ONE_LINE\":\"[^\\\\n]\"}")

#: 规则表：body 是**已翻译**的正则体（token 已展开、禁令已规避）。
RULES = json.loads("[\n  {\n    \"id\": \"interpreter_unavailable\",\n    \"order\": 10,\n    \"code\": \"interpreter_unavailable\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"no interpreter found|no download found|python downloads are set to|interpreter[^\\\\n]{0,40}?(?:unavailable|not found|missing|unable)|(?:unavailable|not found|missing|unable)[^\\\\n]{0,40}?interpreter|interpreter[^\\\\n]{0,40}?(?:download|install)[^\\\\n]{0,40}?(?:fail|timeout|timed out)|(?:download|install)[^\\\\n]{0,40}?(?:fail|timeout|timed out)[^\\\\n]{0,40}?interpreter|python [A-Za-z0-9_]+?(?:[.][A-Za-z0-9_]+)*(?: unavailable| not found| 不可用| 未找到)|[（(](?:not_downloadable|download_failed|download_timeout|mirror_unreachable|corrupt|uv_missing)[）)]|解释器[^\\\\n]{0,20}?(?:无法获取|不可用|不可获得|缺失|找不到)|解释器[^\\\\n]{0,20}?下载[^\\\\n]{0,20}?(?:失败|超时)\"\n  },\n  {\n    \"id\": \"application_missing\",\n    \"order\": 20,\n    \"code\": \"application_missing\",\n    \"appliesTo\": [\n      \"admin\"\n    ],\n    \"body\": \"cannot resolve packageurl|application[ \\\\t\\\\n\\\\r\\\\f\\\\v]+[^ \\\\t\\\\n\\\\r\\\\f\\\\v]+[ \\\\t\\\\n\\\\r\\\\f\\\\v]+not found|无法解析[ \\\\t\\\\n\\\\r\\\\f\\\\v]*packageurl|应用[ \\\\t\\\\n\\\\r\\\\f\\\\v]*[^ \\\\t\\\\n\\\\r\\\\f\\\\v]*[ \\\\t\\\\n\\\\r\\\\f\\\\v]*不存在|找不到应用\"\n  },\n  {\n    \"id\": \"application_missing_defer\",\n    \"order\": 25,\n    \"code\": null,\n    \"appliesTo\": [\n      \"executor\"\n    ],\n    \"body\": \"cannot resolve packageurl|application[ \\\\t\\\\n\\\\r\\\\f\\\\v]+[^ \\\\t\\\\n\\\\r\\\\f\\\\v]+[ \\\\t\\\\n\\\\r\\\\f\\\\v]+not found|无法解析[ \\\\t\\\\n\\\\r\\\\f\\\\v]*packageurl|应用[ \\\\t\\\\n\\\\r\\\\f\\\\v]*[^ \\\\t\\\\n\\\\r\\\\f\\\\v]*[ \\\\t\\\\n\\\\r\\\\f\\\\v]*不存在|找不到应用\"\n  },\n  {\n    \"id\": \"terminal_timeout\",\n    \"order\": 30,\n    \"code\": \"timeout\",\n    \"appliesTo\": [\n      \"executor\"\n    ],\n    \"body\": \"任务执行超时|execution timed out|task execution timed out\"\n  },\n  {\n    \"id\": \"git_fetch_failed\",\n    \"order\": 32,\n    \"code\": \"git_fetch_failed\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"git (?:clone|fetch|checkout) failed|git (?:clone|fetch|checkout) 执行失败|[^A-Za-z0-9_]git[^A-Za-z0-9_][^\\\\n]*returned non-zero|[^A-Za-z0-9_]git[^A-Za-z0-9_][^\\\\n]*[^A-Za-z0-9_](?:clone|fetch|checkout)[^A-Za-z0-9_][^\\\\n]*fail|git (?:clone|fetch|checkout)[^\\\\n]{0,20}?(?:timed out|超时)\"\n  },\n  {\n    \"id\": \"dependency_install_failed\",\n    \"order\": 34,\n    \"code\": \"dependency_install_failed\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"npm install failed|uv pip install failed|pip install failed|dependency installation failed|npm install[^\\\\n]{0,10}?失败|uv pip install[^\\\\n]{0,10}?失败|pip install[^\\\\n]{0,10}?失败|依赖安装失败|uv (?:pip install|venv) (?:install )?failed|uv venv[^\\\\n]{0,20}?超时|uv venv timed out|uv venv 执行失败|uv pip install 执行失败\"\n  },\n  {\n    \"id\": \"terminal_timeout_admin_broad\",\n    \"order\": 35,\n    \"code\": \"timeout\",\n    \"appliesTo\": [\n      \"admin\"\n    ],\n    \"body\": \"timeout|timed out|etimedout|execution timed|超时|执行已超时\"\n  },\n  {\n    \"id\": \"runtime_missing\",\n    \"order\": 40,\n    \"code\": \"runtime_missing\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"spawn[^\\\\n]*enoent|no such file or directory[^\\\\n]{0,60}(?:uv|git|python3?)|runtime[^\\\\n]*not (?:supported|available)|runtime[^\\\\n]{0,20}?(?:不可用|缺失|未安装|未找到)|不支持的 run ?time|unsupported runtime\"\n  },\n  {\n    \"id\": \"invalid_package_name\",\n    \"order\": 45,\n    \"code\": \"package_fetch_failed\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"invalid npm package name|无效的 npm 包名\"\n  },\n  {\n    \"id\": \"sandbox_unavailable\",\n    \"order\": 58,\n    \"code\": \"sandbox_unavailable\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"sandbox_unavailable|task_sandbox|task sandbox|sandbox (?:is )?(?:unavailable|not available|disabled|missing)|bwrap|沙箱|task_launcher|资源限制启动器\"\n  },\n  {\n    \"id\": \"executor_offline\",\n    \"order\": 60,\n    \"code\": \"executor_offline\",\n    \"appliesTo\": [\n      \"admin\"\n    ],\n    \"body\": \"executor[^\\\\n]*(?:offline|unavailable)|no available executor|[^A-Za-z0-9_]econnrefused[^A-Za-z0-9_]|[^A-Za-z0-9_]enotfound[^A-Za-z0-9_]|network error|socket hang up|无可用执行器|没有可用(?:的)?执行器|执行器[^\\\\n]{0,120}?(?:离线|不可用|不可达)\"\n  },\n  {\n    \"id\": \"executor_restart\",\n    \"order\": 70,\n    \"code\": \"executor_restart\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"shutting down before this execution started|正在停机\"\n  },\n  {\n    \"id\": \"package_fetch_failed\",\n    \"order\": 80,\n    \"code\": \"package_fetch_failed\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"git clone|package fetch|pull package|download package|npm install|pip install|requirements|dependency|module not found|cannot find module|modulenotfounderror|no module named|拉取(?:应用包|依赖|代码)|克隆代码|下载(?:应用包|依赖|包)|依赖安装|安装依赖|代码拉取|package download failed|package exceeds the|zip package rejected|packageurl|包下载失败|包体积超过|zip 包未通过安全检查|zip 包渠道不可用|unsafe or invalid package archive|压缩包下载失败|压缩包不安全或不合法\"\n  },\n  {\n    \"id\": \"script_error\",\n    \"order\": 99,\n    \"code\": \"script_error\",\n    \"appliesTo\": [\n      \"executor\",\n      \"admin\"\n    ],\n    \"body\": \"traceback|syntaxerror|referenceerror|typeerror|uncaught|exception|command failed|exit code|脚本(?:错误|异常)|命令执行失败\"\n  }\n]")

#: 归一参数。
JOIN_WITH = "\n"
DROP_FALSY = True
CASE_FOLD = "ascii-lower"

#: sentinel（词边界的合法替代）。
SENTINEL_PAD = "\u0001"

#: 兜底（executor 阶段为 None = 「我不知道，交给中台」）。
FALLBACKS = {"executor": None, "admin": "unknown"}

_COMPILED = []
for _rule in RULES:
    _COMPILED.append({**_rule, "re": re.compile(_rule["body"])})

_BY_STAGE: dict[str, list] = {"executor": [], "admin": []}
for _rule in _COMPILED:
    for _stage in _rule["appliesTo"]:
        _BY_STAGE.setdefault(_stage, []).append(_rule)
for _stage in _BY_STAGE:
    _BY_STAGE[_stage].sort(key=lambda r: r["order"])


def normalize_text(parts: Iterable[Optional[str]]) -> str:
    """拼接 → ASCII 小写化 → astral 折叠（两侧逐字同构）。"""
    kept = [p for p in parts if p is not None and p != ""] if DROP_FALSY else list(parts)
    joined = JOIN_WITH.join(kept)
    return fold_astral(ascii_lower(joined))


def ascii_lower(text: str) -> str:
    """**ASCII** 小写化（只 A-Z → a-z）。

    刻意**不用** str.lower()：JS 的 toLowerCase 与 Python 的 str.lower 都按
    Unicode Default Case Conversion，但**不是**逐字同义（实测 ſ→s、K(U+212A)→k
    在两侧不同），且 Unicode 小写化会**改变长度**——长度一变，与 {n,m} 的
    计数耦合就又成了跨语言不等价的入口。只做 ASCII 折叠：两侧逐字相同、不改长度。
    """
    out = []
    for ch in text:
        code = ord(ch)
        out.append(chr(code + 32) if 0x41 <= code <= 0x5A else ch)
    return "".join(out)


def fold_astral(text: str) -> str:
    """astral 折叠（码点 > U+FFFF → U+FFFD）。

    存在的唯一理由：JS 的 {n,m} 按 **UTF-16 code unit** 计数、Python 按
    **code point** 计数。实测 a[^\n]{0,3}b 对 a😀😀b 在 JS 不命中、在
    Python 命中 ⇒ 同一 {0,N} 在两侧覆盖不同长度。折叠成单码点的 U+FFFD 后，
    两侧的计数单位一致（1 code unit = 1 code point）。
    """
    return "".join("\ufffd" if ord(ch) > 0xFFFF else ch for ch in text)


def pad(text: str) -> str:
    """首尾各补一个 sentinel，于是词边界在串边界处也成立。"""
    return SENTINEL_PAD + text + SENTINEL_PAD


def classify(parts: Iterable[Optional[str]], stage: str = "executor") -> Optional[str]:
    """分类。stage = 'executor' | 'admin'。不命中时 executor 返 None、admin 返兜底码。"""
    text = pad(normalize_text(parts))
    for rule in _BY_STAGE.get(stage, []):
        if rule["re"].search(text):
            return rule["code"]
    return FALLBACKS["admin"] if stage == "admin" else FALLBACKS["executor"]


def rule_ids(stage: str) -> list:
    """规则明细（供守卫比对「生成物 ↔ 契约」）。"""
    return [r["id"] for r in _BY_STAGE.get(stage, [])]
