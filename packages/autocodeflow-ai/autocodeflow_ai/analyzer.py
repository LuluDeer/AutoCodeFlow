"""AI analysis helpers for AutoCodeFlow task code.

Provides AI-powered analysis of task execution results, error diagnosis,
and natural language data summarization.

PK-17 (DEEP_REVIEW 0ef3bbe): task logs and error text routinely contain
connection strings / token fragments. ``AIAnalyzer`` accepts an optional
``redactor`` callable that is applied to every log/error chunk before it
leaves the process; with ``redactor=None`` the raw text is sent unchanged
(behaviour preserved for existing callers — but see the constructor
warning). An ``openai`` run without an ``api_key`` now fails fast with
``ValueError`` instead of emitting a literal ``Authorization: Bearer None``
header, and the prompt templates forbid echoing credentials back.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Callable, Optional

logger = logging.getLogger(__name__)

# NETOPT-10-6: raw_response 入库上限——模型跑飞/超长回复时内存与存储有界。
RAW_RESPONSE_MAX_LENGTH = 8 * 1024
# NETOPT-10-6: 429/5xx/网络类瞬时失败的有界重试（总尝试 = 1 + 1 次退避重试）。
AI_CALL_MAX_ATTEMPTS = 2
AI_RETRY_DELAY_S = 0.5


@dataclass
class AnalysisResult:
    """Structured result from AI analysis."""
    summary: str = ""
    root_cause: str = ""
    suggestions: list[str] = field(default_factory=list)
    confidence: float = 0.0
    raw_response: str = ""
    # NETOPT-C P3: fallback 时的错误分类（network / http_5xx / http_4xx /
    # provider_unavailable / unknown；NETOPT-D P2-5 加 invalid_response）——
    # 调用方可区分「AI 结论不可用」与
    # 「网络瞬时失败」；成功路径为 ""。
    error_kind: str = ""


# NETOPT-C P3: fallback 错误分类。httpx 在 _call_ai 内延迟 import，这里也
# 延迟（避免模块顶层硬依赖）。
def _classify_ai_error(exc: Exception) -> str:
    import httpx

    if isinstance(exc, httpx.TransportError):
        return "network"
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return "http_5xx" if code >= 500 else "http_4xx"
    if isinstance(exc, json.JSONDecodeError):
        # NETOPT-E P3-1: 200 + 非 JSON body（企业代理/WAF 回 200+HTML 登录墙、
        # 网关改写响应）是传输层形态——归 network 而非 provider_unavailable，
        # 否则调用方会去查 API key 配置而不是网络/代理层。注意 JSONDecodeError
        # 是 ValueError 子类，必须先于下面的 ValueError 分支判定。
        return "network"
    if isinstance(exc, ValueError):
        return "provider_unavailable"
    return "unknown"


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

    PK-17: ``redactor`` — optional ``Callable[[str], str]`` applied to
    every task log / error text before it is sent to the AI endpoint,
    e.g. ``redactor=lambda s: mask_secrets(s)``. Without a redactor the
    raw text (which may contain leaked secrets) is transmitted verbatim
    to a third-party endpoint — supply one whenever the logs are not
    guaranteed secret-free.
    """

    #: URL suffix that completes a chat-completions endpoint. ``base_url``
    #: accepts either a base address (R22: same "base" semantics as the
    #: admin-api ``openaiBaseUrl`` setting, e.g. ``.../v1``) or a full
    #: endpoint (legacy form); the base form is normalized automatically.
    _CHAT_COMPLETIONS_SUFFIX = "/chat/completions"

    #: PK-17: outbound hygiene clause appended to every prompt template.
    _NO_CREDENTIALS_ECHO_CLAUSE = (
        "Security: do not repeat, quote or echo back any credentials, "
        "API keys, tokens, passwords or connection strings from the "
        "materials above in your output."
    )

    def __init__(
        self,
        provider: str = "openai",
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: Optional[str] = None,
        redactor: Optional[Callable[[str], str]] = None,
        # NETOPT-10-6: 输出 token 预算 + 请求超时（默认保持旧行为）。
        max_tokens: int = 512,
        timeout_sec: float = 60.0,
    ):
        self.provider = provider
        self.api_key = api_key
        self.base_url = base_url
        self.model = model or ("gpt-3.5-turbo" if provider == "openai" else "llama3")
        self.redactor = redactor
        self.max_tokens = max_tokens
        self.timeout_sec = timeout_sec

    def _redact(self, text: str) -> str:
        """Apply the outbound redaction hook (PK-17); no-op when unset."""
        if self.redactor is None:
            return text
        return self.redactor(text)

    async def analyze_error(
        self, task_name: str, error_message: str, logs: str = ""
    ) -> AnalysisResult:
        """Analyze a task execution error and provide root cause and suggestions."""
        # PK-17: redact error/log text before it leaves the process.
        error_message = self._redact(error_message)
        logs = self._redact(logs)
        prompt = f"""Analyze the following task execution error for "{task_name}":

Error: {error_message}

Logs:
{logs[:4000] if logs else "(no logs)"}

{self._NO_CREDENTIALS_ECHO_CLAUSE}

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
                error_kind=_classify_ai_error(e),
            )

    async def analyze_logs(
        self, task_name: str, logs: str, question: str = "Summarize key events"
    ) -> AnalysisResult:
        """Analyze execution logs and answer questions about them."""
        # PK-17: redact log text before it leaves the process.
        logs = self._redact(logs)
        prompt = f"""Analyze the following execution logs for task "{task_name}":

{logs[:4000]}

Question: {question}

{self._NO_CREDENTIALS_ECHO_CLAUSE}

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
            return AnalysisResult(
                summary=str(e),
                confidence=0.0,
                error_kind=_classify_ai_error(e),
            )

    async def _call_ai(self, prompt: str) -> str:
        """Call the AI provider API."""
        import httpx

        if self.provider == "openai":
            # PK-17: fail fast on a missing key instead of transmitting a
            # literal "Authorization: Bearer None" header that turns a
            # configuration mistake into a confusing server-side 401.
            if not self.api_key:
                raise ValueError(
                    "openai provider requires api_key — refusing to send an "
                    "'Authorization: Bearer None' header; configure the key "
                    "or switch provider (e.g. provider='ollama')"
                )
            url = self._build_endpoint(self.base_url or "https://api.openai.com/v1")
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            }
            body = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
                # NETOPT-10-6: 显式 token 预算——模型跑飞时输出有界。
                "max_tokens": self.max_tokens,
            }
        elif self.provider == "ollama":
            url = self._build_endpoint(self.base_url or "http://localhost:11434/v1")
            headers = {"Content-Type": "application/json"}
            body = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
                "max_tokens": self.max_tokens,
            }
        else:
            raise ValueError(f"Unknown AI provider: {self.provider}")

        # NETOPT-10-6: 瞬时网络抖动/429/5xx 单次退避重试——否则一次抖动直接
        # 落 fallback AnalysisResult，调用方无法区分「AI 结论不可用」与
        # 「网络瞬时失败」。重试耗尽后抛原异常，走调用方 fallback；该
        # fallback 现带 error_kind（_classify_ai_error），调用方可区分
        # network / http_5xx / http_4xx / provider_unavailable / unknown。
        last_error: Optional[Exception] = None
        for attempt in range(1, AI_CALL_MAX_ATTEMPTS + 1):
            try:
                # NETOPT-D P2-6（定调）: AI 走**外部/公网**端点（api.openai.com、
                # 企业 OpenAI 网关、Ollama），**刻意保留**系统代理与自定义 CA
                # 语义（不传 trust_env=False）——企业环境通常靠代理 + CA 才能
                # 出网，机械禁代理会打挂可用环境。这与 callback/http.py、
                # autocodeflow-http/client.py、notify、executor-python 的
                # scheduler.py/artifacts.py 走 admin-api 内部通道的
                # trust_env=False 是**不同的刻意策略**：内部通道不经代理直连
                # 内网，AI 外发出站走系统网络栈。
                # NETOPT-E P3-4: 第三种策略——executor-python 的包下载
                # （execute.py:1357）对 admin + 第三方 CDN **一律** trust_env=False
                # 且 follow_redirects=False：包下载 URL 可含凭据，禁代理防
                # 凭据泄漏进代理环境、禁重定向防 URL 改写。三分法：内部通道
                # False（直连内网）、AI 外发 True（走代理出网）、凭据 URL 下载
                # False（防泄漏）。
                async with httpx.AsyncClient(timeout=self.timeout_sec) as client:
                    resp = await client.post(url, json=body, headers=headers)
                    if resp.status_code >= 500 or resp.status_code == 429:
                        last_error = httpx.HTTPStatusError(
                            f"{resp.status_code} {resp.reason_phrase}",
                            request=resp.request,
                            response=resp,
                        )
                        if attempt < AI_CALL_MAX_ATTEMPTS:
                            await asyncio.sleep(AI_RETRY_DELAY_S)
                            continue
                        raise last_error
                    resp.raise_for_status()
                    data = resp.json()
                    return data["choices"][0]["message"]["content"]
            except httpx.TransportError as exc:
                # Timeout/connect/read/protocol reset — retry once, then re-raise.
                last_error = exc
                if attempt < AI_CALL_MAX_ATTEMPTS:
                    await asyncio.sleep(AI_RETRY_DELAY_S)
                    continue
                raise
        raise last_error  # pragma: no cover - loop always returns or raises

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
            # PK-29（DEEP_REVIEW 0ef3bbe）：模型偶发返回 JSON 数组/标量而非对象
            # （如 "[1,2,3]"）——此前 obj.get 抛 AttributeError 逃逸出本函数，
            # 把"解析失败"升级成未捕获异常。非 dict 一律走 fallback。
            if not isinstance(obj, dict):
                raise ValueError(
                    f"AI response is not a JSON object (got {type(obj).__name__})"
                )
            return AnalysisResult(
                summary=obj.get("summary", ""),
                root_cause=obj.get("root_cause", ""),
                suggestions=obj.get("suggestions", []),
                confidence=float(obj.get("confidence", 0)),
                # NETOPT-10-6: raw_response 入库截断（有界内存/存储）。
                raw_response=text[:RAW_RESPONSE_MAX_LENGTH],
            )
        # NETOPT-E P3-1: except 元组必须含 TypeError——confidence:null 时
        # float(None) 抛 TypeError，若不捕获会逃逸到外层 fallback，被
        # _classify_ai_error 判成 "unknown" 而非 P2-5 承诺的 "invalid_response"。
        except (json.JSONDecodeError, KeyError, ValueError, TypeError, IndexError, AttributeError) as e:
            logger.warning(f"Failed to parse AI response: {e}")
            return AnalysisResult(
                summary=text[:500],
                raw_response=text[:RAW_RESPONSE_MAX_LENGTH],
                # NETOPT-D P2-5: 解析失败也是「AI 不可用」——漏填 error_kind 会
                # 撞上"成功=空串"哨兵，调用方把模型乱码响应误判成成功分析。
                error_kind="invalid_response",
            )