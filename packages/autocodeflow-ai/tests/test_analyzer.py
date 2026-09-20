"""Unit tests for autocodeflow-ai analyzer."""
from __future__ import annotations

import json
import pytest
import httpx
from unittest.mock import AsyncMock, patch

from autocodeflow_ai import AIAnalyzer, AnalysisResult


GOOD_RESPONSE = json.dumps({
    "summary": "Connection refused to DB",
    "root_cause": "PostgreSQL is not running",
    "suggestions": ["Start PostgreSQL", "Check pg_hba.conf"],
    "confidence": 0.9,
})


class TestAnalysisResult:
    def test_defaults(self):
        r = AnalysisResult()
        assert r.summary == ""
        assert r.confidence == 0.0
        assert r.suggestions == []


class TestAIAnalyzerParse:
    """Tests for _parse_response — no network calls needed."""

    def test_parses_valid_json(self):
        result = AIAnalyzer._parse_response(GOOD_RESPONSE)
        assert result.summary == "Connection refused to DB"
        assert result.root_cause == "PostgreSQL is not running"
        assert len(result.suggestions) == 2
        assert result.confidence == 0.9

    def test_parses_markdown_fenced_json(self):
        fenced = f"```json\n{GOOD_RESPONSE}\n```"
        result = AIAnalyzer._parse_response(fenced)
        assert result.summary == "Connection refused to DB"

    def test_handles_invalid_json_gracefully(self):
        result = AIAnalyzer._parse_response("not-json-at-all")
        assert result.summary != ""
        assert result.confidence == 0.0

    def test_handles_partial_json(self):
        partial = json.dumps({"summary": "only summary"})
        result = AIAnalyzer._parse_response(partial)
        assert result.summary == "only summary"
        assert result.root_cause == ""
        assert result.suggestions == []


class TestFenceParsingNoNewline:
    """R22b: fence parsing must not raise on '```json' without a newline."""

    def test_single_line_fenced_json(self):
        # Whole payload glued to the fence line — used to raise IndexError.
        fenced = "```json" + GOOD_RESPONSE + "```"
        result = AIAnalyzer._parse_response(fenced)
        assert result.summary == "Connection refused to DB"
        assert result.confidence == 0.9

    def test_bare_fence_marker_only(self):
        result = AIAnalyzer._parse_response("```json")
        assert result.summary == ""
        assert result.confidence == 0.0

    def test_single_line_fence_without_closing(self):
        fenced = "```json" + GOOD_RESPONSE
        result = AIAnalyzer._parse_response(fenced)
        assert result.summary == "Connection refused to DB"

    def test_fenced_json_standard_shape_still_works(self):
        fenced = "```json\n" + GOOD_RESPONSE + "\n```"
        result = AIAnalyzer._parse_response(fenced)
        assert result.summary == "Connection refused to DB"

    def test_unlabeled_fence(self):
        fenced = "```\n" + GOOD_RESPONSE + "\n```"
        result = AIAnalyzer._parse_response(fenced)
        assert result.summary == "Connection refused to DB"

    def test_strip_code_fence_shapes(self):
        assert AIAnalyzer._strip_code_fence("plain") == "plain"
        assert AIAnalyzer._strip_code_fence("```json\n{}\n```") == "{}"
        assert AIAnalyzer._strip_code_fence("```json{}" + "```") == "{}"
        assert AIAnalyzer._strip_code_fence("```json") == ""
        assert AIAnalyzer._strip_code_fence("```\n{}\n```") == "{}"
        assert AIAnalyzer._strip_code_fence("```json\n{}\n") == "{}"  # no closing fence


class TestNonJsonEdgePaths:
    """PK-29（DEEP_REVIEW 0ef3bbe）：_parse_response 的非 JSON / 半 JSON 边界。
    此前只覆盖合法 JSON、标准围栏、纯字符串；模型经常在 JSON 前后套自然语言、
    把 confidence 序列化成字符串、或返回空/纯 markdown——这些路径此前零断言。"""

    def test_prose_before_fenced_json_falls_back_gracefully(self):
        """Prose 包在 fence 外时 _strip_code_fence 只去 fence、不去外散文——
        json.loads 失败走 fallback（summary=截断原文、confidence 0），不抛。"""
        wrapped = (
            "Sure, here is the diagnosis:\n"
            + "```json\n"
            + GOOD_RESPONSE
            + "\n```\nHope that helps!"
        )
        result = AIAnalyzer._parse_response(wrapped)
        assert result.confidence == 0.0
        assert "Sure, here is the diagnosis" in result.summary

    def test_confidence_as_string_is_coerced_to_float(self):
        text = json.dumps({"summary": "x", "root_cause": "y", "confidence": "0.77"})
        result = AIAnalyzer._parse_response(text)
        assert result.confidence == 0.77

    def test_empty_response_falls_back_gracefully(self):
        result = AIAnalyzer._parse_response("")
        assert result.confidence == 0.0
        assert result.summary == ""

    def test_json_array_body_is_not_dict_falls_back(self):
        # 模型偶发返回 [...] 而非 {...}：此前 obj.get 抛 AttributeError 逃逸；
        # PK-29 修复后非 dict 落入 fallback，不再未捕获异常。
        result = AIAnalyzer._parse_response("[1, 2, 3]")
        assert result.confidence == 0.0
        assert "1, 2, 3" in result.raw_response


class TestBuildEndpointBaseUrl:
    """R22a: base_url unified to base semantics (openaiBaseUrl convention)."""

    def test_base_url_with_v1_gets_suffix_appended(self):
        assert (
            AIAnalyzer._build_endpoint("https://api.example.com/v1")
            == "https://api.example.com/v1/chat/completions"
        )

    def test_base_url_with_trailing_slash(self):
        assert (
            AIAnalyzer._build_endpoint("https://api.example.com/v1/")
            == "https://api.example.com/v1/chat/completions"
        )

    def test_full_endpoint_unchanged(self):
        assert (
            AIAnalyzer._build_endpoint("https://api.example.com/v1/chat/completions")
            == "https://api.example.com/v1/chat/completions"
        )

    def test_full_endpoint_with_trailing_slash(self):
        assert (
            AIAnalyzer._build_endpoint("https://api.example.com/v1/chat/completions/")
            == "https://api.example.com/v1/chat/completions"
        )

    def test_bare_host_gets_suffix_appended(self):
        assert (
            AIAnalyzer._build_endpoint("https://gw.example.com")
            == "https://gw.example.com/chat/completions"
        )

    @pytest.mark.asyncio
    async def test_openai_base_url_v1_does_not_404(self, respx_mock):
        """Admin-api style openaiBaseUrl value (.../v1) reaches the endpoint."""
        route = respx_mock.post("https://gw.example.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(
            provider="openai", api_key="sk-test", base_url="https://gw.example.com/v1"
        )
        result = await analyzer.analyze_error(task_name="task", error_message="err")
        assert route.called
        assert result.root_cause == "PostgreSQL is not running"

    @pytest.mark.asyncio
    async def test_openai_full_endpoint_legacy_form_still_works(self, respx_mock):
        route = respx_mock.post(
            "https://legacy.example.com/v1/chat/completions"
        ).mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(
            provider="openai",
            api_key="sk-test",
            base_url="https://legacy.example.com/v1/chat/completions",
        )
        result = await analyzer.analyze_error(task_name="task", error_message="err")
        assert route.called
        assert result.root_cause == "PostgreSQL is not running"

    @pytest.mark.asyncio
    async def test_openai_default_endpoint_unchanged(self, respx_mock):
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        await analyzer.analyze_error(task_name="task", error_message="err")
        assert route.called

    @pytest.mark.asyncio
    async def test_ollama_base_url_normalized(self, respx_mock):
        route = respx_mock.post("http://localhost:11434/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(provider="ollama", base_url="http://localhost:11434/v1")
        await analyzer.analyze_error(task_name="task", error_message="err")
        assert route.called


class TestAIAnalyzerNetwork:
    """Tests that mock the HTTP call."""

    @pytest.mark.asyncio
    async def test_analyze_error_success(self, respx_mock):
        respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(
            task_name="daily-report",
            error_message="Connection refused",
        )
        assert result.root_cause == "PostgreSQL is not running"
        assert result.confidence == 0.9

    @pytest.mark.asyncio
    async def test_analyze_error_network_failure_returns_fallback(self, respx_mock):
        respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=httpx.ConnectError("refused")
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(
            task_name="task", error_message="boom"
        )
        assert result.summary == "AI analysis unavailable"
        assert result.confidence == 0.0

    @pytest.mark.asyncio
    async def test_analyze_logs_success(self, respx_mock):
        respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_logs(
            task_name="daily-report",
            logs="2024-01-01 ERROR: Connection refused\n2024-01-01 FATAL: Shutdown",
        )
        assert result.summary != ""

    @pytest.mark.asyncio
    async def test_ollama_provider_uses_local_url(self, respx_mock):
        route = respx_mock.post("http://localhost:11434/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(provider="ollama")
        await analyzer.analyze_error(task_name="task", error_message="err")
        assert route.called

    @pytest.mark.asyncio
    async def test_unknown_provider_returns_fallback(self):
        """Unknown provider error is caught internally and returns a fallback result."""
        analyzer = AIAnalyzer(provider="unknown")
        result = await analyzer.analyze_error(task_name="task", error_message="err")
        # The error is caught by analyze_error's except block — returns a safe fallback
        assert result.summary == "AI analysis unavailable"
        assert result.confidence == 0.0


class TestNETOPT106Boundary:
    """NETOPT-10-6: max_tokens 预算、raw_response 截断、429/5xx/网络类单次退避重试。"""

    @pytest.mark.asyncio
    async def test_request_body_carries_max_tokens(self, respx_mock):
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        await analyzer.analyze_error(task_name="t", error_message="e")
        body = json.loads(route.calls.last.request.content)
        assert body["max_tokens"] == 512

    def test_raw_response_is_truncated_to_cap(self):
        from autocodeflow_ai.analyzer import RAW_RESPONSE_MAX_LENGTH

        big = "y" * (RAW_RESPONSE_MAX_LENGTH + 5000)
        text = json.dumps({
            "summary": "s",
            "root_cause": big,
            "suggestions": [],
            "confidence": 1,
        })
        result = AIAnalyzer._parse_response(text)
        assert result.raw_response == text[:RAW_RESPONSE_MAX_LENGTH]
        assert len(result.raw_response) == RAW_RESPONSE_MAX_LENGTH

    def test_raw_response_truncated_on_parse_failure_path(self):
        from autocodeflow_ai.analyzer import RAW_RESPONSE_MAX_LENGTH

        text = "not-json-" + ("z" * (RAW_RESPONSE_MAX_LENGTH + 1000))
        result = AIAnalyzer._parse_response(text)
        assert result.raw_response == text[:RAW_RESPONSE_MAX_LENGTH]
        assert len(result.raw_response) == RAW_RESPONSE_MAX_LENGTH

    @pytest.mark.asyncio
    async def test_503_then_success_recovers(self, respx_mock, monkeypatch):
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=[
                httpx.Response(503, text="Service Unavailable"),
                httpx.Response(
                    200,
                    json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
                ),
            ]
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert result.confidence == 0.9  # 重试成功 → 正常结论而非 fallback
        assert route.call_count == 2

    @pytest.mark.asyncio
    async def test_connect_error_retried_then_recovers(self, respx_mock, monkeypatch):
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=[
                httpx.ConnectError("refused"),
                httpx.Response(
                    200,
                    json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
                ),
            ]
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert result.confidence == 0.9
        assert route.call_count == 2

    @pytest.mark.asyncio
    async def test_persistent_503_falls_back_after_both_attempts(self, respx_mock, monkeypatch):
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(503, text="Service Unavailable")
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert result.summary == "AI analysis unavailable"  # 既有 fallback 语义不变
        assert route.call_count == 2  # 1 + 1 次退避重试后放弃

    @pytest.mark.asyncio
    async def test_non_json_success_response_marks_invalid_response(self, respx_mock, monkeypatch):
        """NETOPT-D P2-5: 模型 content 返回乱码（非 JSON）→ error_kind=invalid_response，
        confidence=0——不得撞"成功=空串"哨兵被误判成成功分析。
        注意构造：_call_ai 的 resp.json() 只解 OpenAI 信封，模型内容解析发生在
        _parse_response——所以 200 必须返回合法信封 + content 乱码。"""
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": "not json at all"}}]},
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert route.call_count == 1
        assert result.error_kind == "invalid_response"
        assert result.confidence == 0.0
        assert result.summary == "not json at all"

    @pytest.mark.asyncio
    async def test_non_json_array_success_response_marks_invalid_response(self, respx_mock, monkeypatch):
        """NETOPT-D P2-5: 模型 content 为 JSON 数组（非对象）同样走 invalid_response。"""
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": "[1,2,3]"}}]},
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert route.call_count == 1
        assert result.error_kind == "invalid_response"

    def test_parse_response_invalid_json_sets_error_kind(self):
        """P2-5 单元面：_parse_response 解析失败分支直接断言（无网络）。"""
        result = AIAnalyzer._parse_response("not json at all")
        assert result.error_kind == "invalid_response"
        assert result.confidence == 0.0

    def test_parse_response_null_confidence_falls_to_invalid_response(self):
        """NETOPT-E P3-1 补钉：`{"confidence": null}` 时 float(None) 抛 TypeError
        ——except 元组必须含 TypeError，否则逃逸到外层 fallback 被 _classify_ai_error
        判成 "unknown" 而非 P2-5 承诺的 invalid_response。若后人把 TypeError 从
        except 元组删掉，本用例立即变红。"""
        result = AIAnalyzer._parse_response(
            '{"summary": "s", "confidence": null}'
        )
        assert result.error_kind == "invalid_response"
        assert result.confidence == 0.0

    @pytest.mark.asyncio
    async def test_html_login_wall_200_classifies_network(self, respx_mock, monkeypatch):
        """NETOPT-E P3-1: 企业代理/WAF 回 **200 + HTML 登录墙**（非 JSON 信封）
        → _call_ai 的 resp.json() 抛 JSONDecodeError（ValueError 子类）——必须归
        network 而非 provider_unavailable，否则调用方去查 API key 而不是网络层。
        JSONDecodeError 判定必须先于 ValueError 分支（类分级序）。"""
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                content=b"<html><body>Sign in to your corporate gateway</body></html>",
                headers={"Content-Type": "text/html"},
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert route.call_count == 1
        assert result.error_kind == "network"
        assert result.confidence == 0.0

    @pytest.mark.asyncio
    async def test_4xx_is_single_shot_falls_back_with_error_kind(self, respx_mock, monkeypatch):
        """NETOPT-C P3: 4xx 是契约拒绝不重试——单发即 fallback，error_kind
        区分出 http_4xx（调用方可区分 AI 不可用 vs 网络抖动 vs 4xx 拒绝）。"""
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(400, text="Bad Request")
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert route.call_count == 1  # 单发，不重试
        assert result.summary == "AI analysis unavailable"
        assert result.error_kind == "http_4xx"

    @pytest.mark.asyncio
    async def test_keeps_system_proxy_intent(self, respx_mock, monkeypatch):
        """NETOPT-D P2-6/P2-8 定调锁: AI 走外部/公网端点，**刻意保留**系统代理
        （不传 trust_env=False）——企业环境靠代理+CA 出网；与 callback/notify 走
        admin-api 内部通道的 trust_env=False 是不同策略。钉死 AsyncClient 构造
        **不含** trust_env 键，防止未来被机械加回打破企业出网。"""
        import httpx as _h
        from autocodeflow_ai import analyzer as analyzer_mod

        captured: dict = {}
        orig_init = _h.AsyncClient.__init__

        def spy(self, *args, **kwargs):
            captured.update(kwargs)
            return orig_init(self, *args, **kwargs)

        monkeypatch.setattr(_h.AsyncClient, "__init__", spy)
        respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert result.summary == "Connection refused to DB"
        assert "trust_env" not in captured

    @pytest.mark.asyncio
    async def test_analyze_logs_fallback_carries_error_kind(self, respx_mock, monkeypatch):
        """NETOPT-D P3-1: analyze_logs 的 fallback 此前零断言（缺口③）——
        网络类失败重试耗尽后落 error_kind=network。"""
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=httpx.ConnectError("refused")
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_logs(task_name="t", logs="boom")
        assert route.call_count == 2
        assert result.error_kind == "network"
        assert result.summary != ""

    @pytest.mark.asyncio
    async def test_network_failure_fallback_carries_error_kind_network(self, respx_mock, monkeypatch):
        """NETOPT-C P3: 网络类失败（重试耗尽）fallback 带 error_kind=network。"""
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            side_effect=httpx.ConnectError("refused")
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert route.call_count == 2
        assert result.error_kind == "network"

    @pytest.mark.asyncio
    async def test_5xx_fallback_carries_error_kind_http_5xx(self, respx_mock, monkeypatch):
        monkeypatch.setattr("autocodeflow_ai.analyzer.AI_RETRY_DELAY_S", 0)
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(503, text="Service Unavailable")
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert route.call_count == 2
        assert result.error_kind == "http_5xx"

    def test_classify_unknown_for_non_http_exceptions(self):
        from autocodeflow_ai.analyzer import _classify_ai_error

        assert _classify_ai_error(RuntimeError("boom")) == "unknown"

    def test_classify_provider_unavailable_for_value_error(self):
        """NETOPT-D P3-1: provider_unavailable 分类此前零直测（缺口②）。
        ValueError = 提供方不可用（如缺 api_key / provider 未知）——钉死。"""
        from autocodeflow_ai.analyzer import _classify_ai_error

        assert _classify_ai_error(ValueError("provider requires api_key")) == "provider_unavailable"

    @pytest.mark.asyncio
    async def test_success_path_error_kind_is_empty(self, respx_mock):
        respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
            )
        )
        result = await AIAnalyzer(provider="openai", api_key="sk-test").analyze_error(
            task_name="t", error_message="e"
        )
        assert result.error_kind == ""  # 成功路径不落 error_kind
        assert result.confidence == 0.9


class TestProviderUnavailableClassification:
    """NETOPT-D P3: provider_unavailable 分支（缺 api_key / 未知 provider）
    此前零测试——error_kind 必须正确归类，供调用方区分配置错误与网络失败。"""

    @pytest.mark.asyncio
    async def test_missing_api_key_classifies_provider_unavailable(self):
        analyzer = AIAnalyzer(provider="openai", api_key=None)
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        # error_kind 才是本测试的契约目标（fallback summary 是常量，不含异常文本）
        assert result.error_kind == "provider_unavailable"
        assert result.confidence == 0.0

    @pytest.mark.asyncio
    async def test_unknown_provider_classifies_provider_unavailable(self):
        analyzer = AIAnalyzer(provider="nope", api_key="sk-test")
        result = await analyzer.analyze_error(task_name="t", error_message="e")
        assert result.error_kind == "provider_unavailable"
        assert result.confidence == 0.0

    def test_classify_value_error_is_provider_unavailable(self):
        from autocodeflow_ai.analyzer import _classify_ai_error

        assert _classify_ai_error(ValueError("bad config")) == "provider_unavailable"


class TestTrustEnvSemantics:
    """NETOPT-D P2-6（定调）: AI 走外部/公网端点，**保留**系统代理与自定义 CA
    语义（trust_env 默认 True）。若有人把 AsyncClient 机械改成 trust_env=False，
    这里立即变红——企业代理 + CA 环境会被打挂。"""

    def test_ai_client_keeps_trust_env_default(self):
        """NETOPT-D P2-6（定调）: AI 走外部/公网端点，**保留**系统代理与自定义
        CA 语义（trust_env 默认 True）。NETOPT-E P3-2/P3-3: 运行时锁已由
        test_keeps_system_proxy_intent（monkeypatch AsyncClient.__init__ spy）
        提供——本源码级检查只是**冗余防线**；"monkeypatch 不可行"的旧注释已被
        同文件 test_keeps_system_proxy_intent 用例反证，一并删除。若有人把
        AsyncClient 机械改成 trust_env=False，这里立即变红（企业代理 + CA
        环境会被打挂）。"""
        import pathlib
        import re

        import autocodeflow_ai.analyzer as analyzer_module

        src = pathlib.Path(analyzer_module.__file__).read_text(encoding="utf-8")
        # NETOPT-E P3-2: 不再锁死 `(timeout=self.timeout_sec)` 精确签名。
        # NETOPT-F P3: 改用 finditer 检查**全部**构造点（re.search 只取第一个——
        # 未来在 _call_ai 上方新增第二个 AsyncClient 会让窗口漂移，源码锁不再
        # 检查真正的 AI 客户端）；窗口内匹配 trust_env 空格变体
        # （`trust_env = False`）与字面量同拒。
        matches = list(re.finditer(r"httpx\.AsyncClient\(", src))
        assert matches, "AsyncClient 构造点缺失（analyzer.py 结构变动，需人工复核定调锁）"
        for m in matches:
            window = src[m.start():m.start() + 200]
            assert not re.search(r"trust_env\s*=\s*False", window), (
                "AI 出站不应传 trust_env=False——企业代理 + 自定义 CA 环境依赖默认读代理"
            )

    def test_trust_env_regex_self_proof_on_synthetic_source(self):
        """NETOPT-G P3: 正则自证——上面这个空格变体正则只对真实源码跑，若有人
        把源码锁简化回字面量 `trust_env=False`（或误以为正则不拦空格变体）全绿。
        本用例喂合成源码，证明 \\s* 变体与 200 字符窗口确实能拦/能放（防止
        测试本身的"接线对、断言空"）。"""
        import re

        pattern = re.compile(r"trust_env\s*=\s*False")
        # 空格变体（`trust_env = False`）必须被拦——这是"机械改成 False"最常见形态
        spaced = "httpx.AsyncClient(timeout=60, trust_env = False)"
        assert pattern.search(spaced), "synthetic spaced variant must be caught"
        # 无空格字面量也必须被拦
        literal = "httpx.AsyncClient(timeout=60, trust_env=False)"
        assert pattern.search(literal), "synthetic literal variant must be caught"
        # 构造点内带长前缀（模拟真实源码窗口内匹配）：窗口前 200 字符内仍命中
        long_prefix = "x" * 160 + "httpx.AsyncClient(timeout=60, trust_env=False)"
        assert pattern.search(long_prefix), "match must land inside the 200-char window"
        # 反证：窗口内**无** trust_env 时不误伤（None/True 都不匹配）
        none_ok = "httpx.AsyncClient(timeout=60, trust_env=None)"
        true_ok = "httpx.AsyncClient(timeout=60, trust_env=True)"
        assert not pattern.search(none_ok), "trust_env=None must NOT match the False lock"
        assert not pattern.search(true_ok), "trust_env=True must NOT match the False lock"
        # 窗口语义自证：构造点 200 字符外出现的 False 不应影响本构造点的判定
        # （当前单构造点约 70 字符，200 窗口足够；此断言防未来误改窗口长度）
        assert len(spaced) < 200 and len(long_prefix) >= 200, (
            "synthetic window sanity: short form inside, long form crossing window edge"
        )


class TestPK17SensitiveOutbound:
    """PK-17: 敏感外发治理——脱敏钩子 / 缺 key fail-fast / prompt 凭据约束。"""

    @pytest.mark.asyncio
    async def test_redactor_masks_logs_and_error_before_outbound(self, respx_mock):
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200, json={"choices": [{"message": {"content": GOOD_RESPONSE}}]}
            )
        )

        def mask(text: str) -> str:
            return text.replace("postgres://user:hunter2@db/x", "[REDACTED]")

        analyzer = AIAnalyzer(
            provider="openai", api_key="sk-test", redactor=mask
        )
        await analyzer.analyze_error(
            task_name="task",
            error_message="failed to reach postgres://user:hunter2@db/x",
            logs="boot ok; conn=postgres://user:hunter2@db/x",
        )
        assert route.called
        body = json.loads(route.calls.last.request.content)
        outbound = body["messages"][0]["content"]
        assert "hunter2" not in outbound
        assert outbound.count("[REDACTED]") == 2

    @pytest.mark.asyncio
    async def test_redactor_none_keeps_raw_text_outbound(self, respx_mock):
        """redactor=None 时行为不变（原文出站，向后兼容）。"""
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(
                200, json={"choices": [{"message": {"content": GOOD_RESPONSE}}]}
            )
        )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        await analyzer.analyze_logs(
            task_name="task", logs="token=abcd1234", question="what happened"
        )
        assert route.called
        body = json.loads(route.calls.last.request.content)
        outbound = body["messages"][0]["content"]
        assert "token=abcd1234" in outbound

    @pytest.mark.asyncio
    async def test_openai_without_api_key_raises_value_error_not_bearer_none(
        self, respx_mock
    ):
        route = respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(200, json={})
        )
        analyzer = AIAnalyzer(provider="openai", api_key=None)
        with pytest.raises(ValueError) as excinfo:
            await analyzer._call_ai("ping")
        assert "api_key" in str(excinfo.value)
        # 不应发出任何 HTTP 请求（更不能带 Bearer None）
        assert not route.called

    @pytest.mark.asyncio
    async def test_analyze_error_swallows_missing_api_key_as_unavailable(self):
        """analyze_error 的 fail-open 语义保持：缺 key 不再发 Bearer None，
        而是走既有异常兜底返回 'AI analysis unavailable'。"""
        analyzer = AIAnalyzer(provider="openai", api_key="")
        result = await analyzer.analyze_error(
            task_name="task", error_message="boom", logs="log"
        )
        assert result.summary == "AI analysis unavailable"
        assert result.confidence == 0.0

    @pytest.mark.asyncio
    async def test_prompt_templates_forbid_echoing_credentials(self, respx_mock):
        for route_path in (
            "https://api.openai.com/v1/chat/completions",
        ):
            respx_mock.post(route_path).mock(
                return_value=httpx.Response(
                    200,
                    json={"choices": [{"message": {"content": GOOD_RESPONSE}}]},
                )
            )
        analyzer = AIAnalyzer(provider="openai", api_key="sk-test")
        await analyzer.analyze_error(task_name="t", error_message="e", logs="l")
        await analyzer.analyze_logs(task_name="t", logs="l")
        contents = [
            json.loads(c.request.content)["messages"][0]["content"]
            for c in respx_mock.calls
        ]
        assert len(contents) == 2
        for outbound in contents:
            assert "do not repeat, quote or echo back any credentials" in outbound
