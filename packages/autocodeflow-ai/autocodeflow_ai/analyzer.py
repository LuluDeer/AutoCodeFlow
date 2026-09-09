"""AI analysis helpers for AutoCodeFlow task code.

Provides AI-powered analysis of task execution results, error diagnosis,
and natural language data summarization.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class AnalysisResult:
    """Structured result from AI analysis."""
    summary: str = ""
    root_cause: str = ""
    suggestions: list[str] = field(default_factory=list)
    confidence: float = 0.0
    raw_response: str = ""


class AIAnalyzer:
    """
    AI analysis client for task code.

    Supports OpenAI and Ollama backends.

    Usage::

        analyzer = AIAnalyzer(provider="openai", api_key="sk-xxx")
        result = await analyzer.analyze_error(
            task_name="daily-report",
            error_message="Connection refused",
            logs="...",
        )
        print(result.root_cause)
    """

    #: URL suffix that completes a chat-completions endpoint. ``base_url``
    #: accepts either a base address (R22: same "base" semantics as the
    #: admin-api ``openaiBaseUrl`` setting, e.g. ``.../v1``) or a full
    #: endpoint (legacy form); the base form is normalized automatically.
    _CHAT_COMPLETIONS_SUFFIX = "/chat/completions"

    def __init__(
        self,
        provider: str = "openai",
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self.provider = provider
        self.api_key = api_key
        self.base_url = base_url
        self.model = model or ("gpt-3.5-turbo" if provider == "openai" else "llama3")

    async def analyze_error(
        self, task_name: str, error_message: str, logs: str = ""
    ) -> AnalysisResult:
        """Analyze a task execution error and provide root cause and suggestions."""
        prompt = f"""Analyze the following task execution error for "{task_name}":

Error: {error_message}

Logs:
{logs[:4000] if logs else "(no logs)"}

Respond in JSON format with:
- "summary": brief summary of what happened
- "root_cause": likely root cause of the error
- "suggestions": list of actionable suggestions to fix the error
- "confidence": confidence score from 0.0 to 1.0

JSON:"""

        try:
            response_text = await self._call_ai(prompt)
            return self._parse_response(response_text)
        except Exception as e:
            logger.error(f"AI analysis failed: {e}")
            return AnalysisResult(
                summary="AI analysis unavailable",
                root_cause=error_message,
                suggestions=["Check logs for more details"],
                confidence=0.0,
            )

    async def analyze_logs(
        self, task_name: str, logs: str, question: str = "Summarize key events"
    ) -> AnalysisResult:
        """Analyze execution logs and answer questions about them."""
        prompt = f"""Analyze the following execution logs for task "{task_name}":

{logs[:4000]}

Question: {question}

Respond in JSON format with:
- "summary": answer to the question
- "root_cause": key observations
- "suggestions": actionable insights
- "confidence": confidence score from 0.0 to 1.0

JSON:"""

        try:
            response_text = await self._call_ai(prompt)
            return self._parse_response(response_text)
        except Exception as e:
            logger.error(f"AI log analysis failed: {e}")
            return AnalysisResult(summary=str(e), confidence=0.0)

    async def _call_ai(self, prompt: str) -> str:
        """Call the AI provider API."""
        import httpx

        if self.provider == "openai":
            url = self._build_endpoint(self.base_url or "https://api.openai.com/v1")
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            }
            body = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
            }
        elif self.provider == "ollama":
            url = self._build_endpoint(self.base_url or "http://localhost:11434/v1")
            headers = {"Content-Type": "application/json"}
            body = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
            }
        else:
            raise ValueError(f"Unknown AI provider: {self.provider}")

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"]

    @classmethod
    def _build_endpoint(cls, base_url: str) -> str:
        """Normalize a base_url into a full chat-completions endpoint.

        R22: ``base_url`` is unified to the admin-api ``openaiBaseUrl``
        convention — a base address (``https://host`` or ``https://host/v1``)
        to which the ``/chat/completions`` path is appended, tolerating a
        trailing slash. A legacy value that already names the full endpoint
        keeps working unchanged.
        """
        trimmed = base_url.strip().rstrip("/")
        if trimmed.endswith(cls._CHAT_COMPLETIONS_SUFFIX):
            return trimmed
        return f"{trimmed}{cls._CHAT_COMPLETIONS_SUFFIX}"

    @staticmethod
    def _strip_code_fence(text: str) -> str:
        """Strip a markdown code fence (```lang ... ```) line by line.

        R22: the previous ``split("\\n", 1)[1]`` raised IndexError on a
        single-line response such as ``"```json{...}```"`` (no newline after
        the language tag). Peeling fence lines — while keeping JSON that is
        glued to the opening fence line — handles every shape.
        """
        lines = text.splitlines()
        if lines and lines[0].strip().startswith("```"):
            rest = lines[0].strip()[3:]  # text after the backticks
            starts = [i for i in (rest.find("{"), rest.find("[")) if i != -1]
            if starts:
                # Content glued to the opening fence (e.g. '```json{...}').
                lines[0] = rest[min(starts):]
            else:
                # Pure fence/language-tag line ('```' or '```json').
                lines = lines[1:]
        if lines:
            last = lines[-1].rstrip()
            if last.endswith("```"):
                trimmed = last[:-3].rstrip()
                if trimmed:
                    lines[-1] = trimmed
                else:
                    lines = lines[:-1]
        return "\n".join(lines).strip()

    @staticmethod
    def _parse_response(text: str) -> AnalysisResult:
        """Parse AI JSON response into AnalysisResult."""
        try:
            # Extract JSON from response (may have markdown fences)
            text = AIAnalyzer._strip_code_fence(text.strip())
            obj = json.loads(text)
            return AnalysisResult(
                summary=obj.get("summary", ""),
                root_cause=obj.get("root_cause", ""),
                suggestions=obj.get("suggestions", []),
                confidence=float(obj.get("confidence", 0)),
                raw_response=text,
            )
        except (json.JSONDecodeError, KeyError, ValueError, IndexError) as e:
            logger.warning(f"Failed to parse AI response: {e}")
            return AnalysisResult(summary=text[:500], raw_response=text)