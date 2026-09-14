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
