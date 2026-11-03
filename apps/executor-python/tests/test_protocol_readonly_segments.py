"""R2-1/P1a：五个「只读消费段」的**契约即常量**断言（python 侧）。

与 `apps/executor-node/src/protocol-readonly-segments.spec.ts` **同形**：两侧加载
**同一份** `protocol.json`，跑**同一批**断言。任一侧的生成物与协议分叉 ⇒ 那侧红。

## 这批用例钉住什么

R2-1 评估轮查明：protocol.json 的段里，**只有 `schemas` 段**被运行时真正消费，
其余各段全是 `guard-only`（运行时零消费 + 实现侧手抄 N 份）—— 「契约说有、
但两端各抄一份」正是漂移宿主。

P1a 把五个新段（`networkPolicy` / `errorStatusCodes` / `taskFieldAliases` /
`timeoutPrecedence` / `callbackLogRetention`）**以只读常量**发射到两侧。

## 为什么 P1a 只断言「常量 == 协议」，不断言「实现 == 常量」

因为**两侧运行时的判定逻辑本批不动**（P1b 才改行为）。若在 P1a 就断言
「实现读常量」，会逼着两侧立刻改行为 —— 那就把「协议扩段」与「行为变更」
混进一个 commit，失去 P1a 可独立回滚的意义（Lead 明确要求两个 commit）。

⇒ 本文件是「**契约已就位**」的证明；「**两侧按它实现**」由 P1b 的用例证明。
"""
import json
from pathlib import Path

import pytest

from generated import protocol_schemas as ps

REPO_ROOT = Path(__file__).resolve().parents[3]
PROTOCOL = REPO_ROOT / "packages" / "executor-protocol" / "protocol.json"

protocol = json.loads(PROTOCOL.read_text(encoding="utf-8"))

SEGMENTS = [
    ("networkPolicy", ps.PROTOCOL_NETWORK_POLICY),
    ("errorStatusCodes", ps.PROTOCOL_ERROR_STATUS_CODES),
    ("taskFieldAliases", ps.PROTOCOL_TASK_FIELD_ALIASES),
    ("timeoutPrecedence", ps.PROTOCOL_TIMEOUT_PRECEDENCE),
    ("callbackLogRetention", ps.PROTOCOL_CALLBACK_LOG_RETENTION),
]


def strip_meta(seg: dict) -> dict:
    """剔除段级治理元数据键（与生成器的 stripMeta 同规则）。"""
    return {
        k: v for k, v in seg.items() if not (k.startswith("x") or k.startswith("$"))
    }


def test_scan_surface_is_wired():
    """扫描面非空——五个段都存在且生成物已接线（防扫描器静默失效）。"""
    assert len(SEGMENTS) == 5
    for name, value in SEGMENTS:
        assert value is not None
        assert len(value) > 0, f"{name} 段常量为空"
        assert name


@pytest.mark.parametrize("name,generated", SEGMENTS, ids=[s[0] for s in SEGMENTS])
def test_generated_equals_protocol(name, generated):
    """生成物与 protocol.json **逐字段相等**（全量深比较，不是抽样）。"""
    raw = protocol[name]
    assert raw is not None, f"protocol.json 缺 {name} 段"
    assert generated == strip_meta(raw)


@pytest.mark.parametrize("name,generated", SEGMENTS, ids=[s[0] for s in SEGMENTS])
def test_generated_excludes_segment_meta(name, generated):
    """生成物不含段级治理元数据（xConsumption / xConsumptionNote）。"""
    keys = list(generated.keys())
    assert not [k for k in keys if k.startswith("x")], f"{name} 段含 x- 前缀治理元数据"
    assert not [k for k in keys if k.startswith("$")], f"{name} 段含 $- 前缀元数据"


def test_network_policy_key_fixes():
    """云元数据 169.254.169.254 必须在 linkLocal 样例里，且**不可被开关放行**。

    反证：把 linkLocal 的 allowedUnderPrivateNetwork 改成 true ⇒ 本用例转红
    （那会让「开开关就打云元数据」成为可能 —— SSRF 的头号目标）。
    """
    np = ps.PROTOCOL_NETWORK_POLICY
    for key in (
        "loopback",
        "privateIPv4",
        "linkLocal",
        "cgnat",
        "unspecified",
        "multicast",
        "reserved",
    ):
        assert key in np["addresses"], f"networkPolicy 缺 {key} 类"
    assert "169.254.169.254" in np["addresses"]["linkLocal"]["examples"]
    assert np["addresses"]["linkLocal"]["allowedUnderPrivateNetwork"] is False
    # loopback 不随开关放行（打自己回环没有合法拓扑）
    assert np["addresses"]["loopback"]["allowedUnderPrivateNetwork"] is False
    # 只有私网可被开关放行
    assert np["addresses"]["privateIPv4"]["allowedUnderPrivateNetwork"] is True
    # DNS 解析 + fail-closed
    assert np["resolution"]["mode"] == "dns-resolve"
    assert np["resolution"]["onResolutionFailure"] == "deny"
    # accept 期同步拒 + 400
    assert np["enforcement"]["stage"] == "accept"
    assert np["enforcement"]["httpStatus"] == 400


def test_network_policy_switch_vectors_are_self_consistent():
    """开关语义的两条向量自洽（Q-A 拆分后的追加条目）。

    原向量 `allow-private-under-switch` 的 `expected: deny` 与 `switch: on` 打架
    —— 错的是**向量本身**、不是语义 ⇒ 处置是**追加**两条自洽向量、**保留原向量
    不改写**（append-only 纪律），并在其 `$comment` 里显式声明已被拆分取代。

    反证：删掉任一拆分条目、或改动原向量的 `$comment` ⇒ 本用例转红。
    """
    vectors = ps.PROTOCOL_NETWORK_POLICY["vectors"]
    by_name = {v["name"]: v for v in vectors}

    legacy = by_name["allow-private-under-switch"]
    assert "自相矛盾" in legacy.get("$comment", "")
    assert "拆分" in legacy.get("$comment", "")

    deny_default = by_name["deny-private-under-switch-default"]
    assert deny_default["expected"] == "deny"
    assert deny_default["switch"] == "off"

    allow_enabled = by_name["allow-private-under-switch-enabled"]
    assert allow_enabled["expected"] == "allow"
    assert allow_enabled["switch"] == "on"


def test_network_policy_link_local_examples_include_both_metadata_endpoints():
    """linkLocal 的 examples 含 IPv4 与 AWS IPv6 两个云元数据地址。

    R2-1/P1b：`fd00:ec2::254` 从「只在 $comment 提到」升级为**可断言条目**。
    反证：从 examples 删掉 fd00:ec2::254 ⇒ 本用例转红。
    """
    examples = ps.PROTOCOL_NETWORK_POLICY["addresses"]["linkLocal"]["examples"]
    assert "169.254.169.254" in examples
    assert "fd00:ec2::254" in examples


def test_pull_path_equivalent_rejection_is_registered():
    """pull 入口的等价失败形态已登记（failed 回调，不是 400）。

    R2-1/P1b：契约此前只描述 HTTP `/execute` 入口，而 pull 循环没有同步调用方
    ⇒ 只能走 failed 回调。不登记的话下一个人会以为是漂移。

    反证：删掉 pullPathEquivalent 段 ⇒ 本用例转红。
    """
    es = ps.PROTOCOL_ERROR_STATUS_CODES
    pull = es["pullPathEquivalent"]
    assert pull["stage"] == "pull"
    assert pull["equivalentForm"] == "failed-callback"
    assert pull["failureReason"] == "unknown"
    # 三条不变量同样适用
    assert pull["mustNotLeaveLiveEntry"] is True
    assert pull["mustNotCreateWorkDir"] is True
    # E-01 预留槽必须归还（否则预留泄漏）
    assert pull["mustReleaseReservedSlot"] is True
    # 且有一条专门向量
    names = [v["name"] for v in es["vectors"]]
    assert "pull-path-rejection-is-failed-callback" in names


def test_error_status_codes_rejections_are_400():
    """拒绝一律 400（不是框架默认的 422），四条不变量齐备。

    反证：把 rejectedRequest.httpStatus 改成 422 ⇒ 本用例转红
    （那会让 python 侧的 FastAPI 默认行为重新成为事实源）。
    """
    es = ps.PROTOCOL_ERROR_STATUS_CODES
    assert es["rejectedRequest"]["httpStatus"] == 400
    assert es["protocolViolation"]["httpStatus"] == 400
    assert es["policyRejection"]["httpStatus"] == 400
    assert es["capacityRejection"]["httpStatus"] == 429
    assert es["capacityRejection"]["retryable"] is True
    assert es["shuttingDownRejection"]["httpStatus"] == 503
    assert es["shuttingDownRejection"]["retryable"] is True
    assert len(es["invariants"]) >= 4
    assert "accept" in "\n".join(es["invariants"])


def test_task_field_aliases_git_repo_registered():
    """gitRepo/git_repo 已登记（此前协议未声明、node 侧不读）。

    反证：把 gitRepo<->git_repo 这条从 aliases 删掉 ⇒ 本用例转红。
    """
    ta = ps.PROTOCOL_TASK_FIELD_ALIASES
    pairs = [f"{a['canonical']}<->{a['alias']}" for a in ta["aliases"]]
    assert "gitRepo<->git_repo" in pairs
    assert "gitCommit<->git_commit" in pairs
    assert "gitBranch<->git_branch" in pairs
    # 别名**不改变线缆载荷形状** ⇒ wireAdded 全 false ⇒ 不 bump 协议版本
    assert all(a["wireAdded"] is False for a in ta["aliases"])
    assert len(ta["rules"]) >= 4


def test_timeout_precedence_canonical_first():
    """正名优先、旁键不校验（python 现状是逐键全检 —— 这是裁定点）。

    反证：把 order 改成 ['timeout','timeout_seconds','timeoutSeconds'] ⇒ 转红；
    把 ignoredAliasesAreNotValidated 改成 false ⇒ 转红。
    """
    tp = ps.PROTOCOL_TIMEOUT_PRECEDENCE
    assert tp["order"] == ["timeoutSeconds", "timeout_seconds", "timeout"]
    assert tp["rule"] == "canonical-first"
    assert tp["ignoredAliasesAreNotValidated"] is True
    assert tp["selectedValueBounds"]["min"] == 1
    assert tp["selectedValueBounds"]["max"] == 86400
    assert tp["selectedValueBounds"]["zeroMeans"] == "unlimited"


def test_callback_log_retention_head_tail_500k():
    """头尾各 500KB（尾部诊断价值最高）+ marker 命中 admin 的正则。

    反证：把 mode 改成 'head-only' 或 tailChars 改成 0 ⇒ 转红
    （那会让尾部错误栈在 python 侧永远进不了回调载荷 —— R2-1 评估轮实测的漂移本体）。
    """
    import re

    cr = ps.PROTOCOL_CALLBACK_LOG_RETENTION
    assert cr["inMemory"]["mode"] == "head-tail"
    assert cr["inMemory"]["headChars"] == 500_000
    assert cr["inMemory"]["tailChars"] == 500_000
    # marker 必须命中 admin 的 LOG_TRUNCATION_MARKER
    assert re.search(
        cr["marker"]["pattern"], "[logs truncated in memory, 123 chars total]", re.I
    )
    # 上报给 admin 的最终长度（另一层上限）
    assert cr["finalCallbackChars"]["default"] == 10_000
    assert cr["finalCallbackChars"]["adminCap"] == 512_000
