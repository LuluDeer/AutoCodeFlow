"""R134-A1 错误处理 / 资源生命周期审计（autocodeflow-ai）的红灯用例。

审计对象：packages/autocodeflow-ai/autocodeflow_ai/analyzer.py

- 轴 1（吞原始错误）：analyze_error / analyze_logs 用 except Exception
  兜住一切，只 logger.error(f"...: {e}")（无 exc_info，traceback 丢失），
  再用一个常量 fallback AnalysisResult 顶替。异常**对象与文本一起被丢弃**：
  调用方看到 error_kind=network，却永远不知道是 DNS 失败还是连接被拒。
- 轴 1（分类正确性）：200 + 非 chat-completions 结构（网关返回
  {"error": ...}）时 data["choices"][0]["message"]["content"] 抛 KeyError，
  逃出 _call_ai 后被归成 "unknown"——而 P2-5 已定调"AI 响应不可用 =
  invalid_response"。调用方按 error_kind 分流时会把"响应格式坏了"误判成
  "未知错误"。
"""
from __future__ import annotations

import logging

import httpx
import pytest

from autocodeflow_ai import AIAnalyzer

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
GOOD = '{"summary": "s", "root_cause": "r", "suggestions": [], "confidence": 0.9}'


class TestFallbackPreservesOriginalError:
    """轴 1：fallback 不得把原始异常文本/traceback 一起吞掉。"""

    @pytest.mark.asyncio
    async def test_analyze_error_records_error_detail_and_traceback(self, monkeypatch, caplog):
        analyzer = AIAnalyzer(provider="ollama")

        async def boom(prompt):
            raise httpx.ConnectError("dns exploded")

        monkeypatch.setattr(analyzer, "_call_ai", boom)

        with caplog.at_level(logging.ERROR, logger="autocodeflow_ai.analyzer"):
            result = await analyzer.analyze_error(task_name="t", error_message="original failure")

        assert result.error_kind == "network"
        assert "dns exploded" in result.error_detail
        assert "ConnectError" in result.error_detail
        record = next(r for r in caplog.records if "AI analysis failed" in r.getMessage())
        assert record.exc_info is not None, "the traceback must reach the log"

    @pytest.mark.asyncio
    async def test_analyze_logs_records_error_detail(self, monkeypatch):
        analyzer = AIAnalyzer(provider="ollama")

        async def boom(prompt):
            raise httpx.ReadTimeout("read timed out")

        monkeypatch.setattr(analyzer, "_call_ai", boom)
        result = await analyzer.analyze_logs(task_name="t", logs="log line")
        assert result.error_kind == "network"
        assert "read timed out" in result.error_detail

    @pytest.mark.asyncio
    async def test_success_path_error_detail_stays_empty(self, respx_mock):
        respx_mock.post(OPENAI_URL).mock(
            return_value=httpx.Response(200, json={"choices": [{"message": {"content": GOOD}}]})
        )
        result = await AIAnalyzer(provider="openai", api_key="sk-test").analyze_error(
            task_name="t", error_message="e"
        )
        assert result.error_kind == ""
        assert result.error_detail == ""


class TestMalformedSuccessPayloadClassification:
    """轴 1：200 但结构不对 = invalid_response，而不是 unknown。"""

    @pytest.mark.asyncio
    async def test_200_without_choices_is_invalid_response(self, respx_mock):
        respx_mock.post(OPENAI_URL).mock(
            return_value=httpx.Response(200, json={"error": {"message": "quota exceeded"}})
        )
        result = await AIAnalyzer(provider="openai", api_key="sk-test").analyze_error(
            task_name="t", error_message="e"
        )
        assert result.error_kind == "invalid_response"

    @pytest.mark.asyncio
    async def test_200_with_empty_choices_is_invalid_response(self, respx_mock):
        respx_mock.post(OPENAI_URL).mock(return_value=httpx.Response(200, json={"choices": []}))
        result = await AIAnalyzer(provider="openai", api_key="sk-test").analyze_error(
            task_name="t", error_message="e"
        )
        assert result.error_kind == "invalid_response"
