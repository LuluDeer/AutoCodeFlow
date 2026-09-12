# autocodeflow-ai — AI 分析助手库

> 所属: docs/atlas/02-packages/python-libs · 最后核对: 2026-09-13 · 对应代码: packages/autocodeflow-ai

## 职责

PyPI 包 `autocodeflow-ai`（v0.1.0，Python >= 3.10）：给任务脚本提供**AI 错误诊断与日志问答**能力。支持 OpenAI 兼容与 Ollama 两种后端，输出统一的结构化 `AnalysisResult`（summary / root_cause / suggestions / confidence）。它是任务侧的"轻量 AIAnalyzer"——与 admin-api 内置的执行失败 AI 分析、CLI/MCP 的 `analyze` 能力同源（admin-api 侧也有自己的 OpenAI/Ollama 接入），但本库面向任务代码本地调用。

依赖（pyproject.toml 核实）：`openai>=1.0.0`、`httpx>=0.25.0`。注意：实现（`analyzer.py`）实际用 **httpx 直接 POST chat/completions 端点**，并未 import openai SDK——openai 是声明依赖，调用走 OpenAI 兼容 HTTP 协议（Ollama 同样走 `/v1/chat/completions`）。

## 目录结构与关键文件

```
packages/autocodeflow-ai/
├── pyproject.toml
├── autocodeflow_ai/
│   ├── __init__.py          __all__ = ["AIAnalyzer", "AnalysisResult"]；__version__ = "0.1.0"
│   └── analyzer.py          全部实现（约 200 行）
└── tests/
    ├── conftest.py
    └── test_analyzer.py
```

## 公开 API 面（源码核实）

### AnalysisResult（dataclass）

```python
@dataclass
class AnalysisResult:
    summary: str = ""            # 摘要
    root_cause: str = ""         # 根因
    suggestions: list[str] = ... # 可执行建议列表
    confidence: float = 0.0      # 0.0–1.0
    raw_response: str = ""       # 原始返回（诊断用）
```

### AIAnalyzer

- `AIAnalyzer(provider="openai", api_key=None, base_url=None, model=None)`；model 缺省 `openai→"gpt-3.5-turbo"`、`ollama→"llama3"`。
- `await analyze_error(task_name, error_message, logs="") -> AnalysisResult`：错误诊断。logs 截 4000 字符进 prompt；要求模型返回 JSON（summary/root_cause/suggestions/confidence）。
- `await analyze_logs(task_name, logs, question="Summarize key events") -> AnalysisResult`：日志问答。
- 内部机制：
  - `_build_endpoint(base_url)`（R22）：`base_url` 统一按 admin-api `openaiBaseUrl` 约定——基址（含或不含 `/v1`）自动补 `/chat/completions`；已带完整端点的旧写法原样保留；容忍尾斜杠。
  - `_strip_code_fence`：剥 markdown 代码围栏，兼容单行 ```json{...}``` 形态（修复过 IndexError）。
  - `_parse_response`：JSON 解析失败时降级为 `summary=原文前 500 字`，不抛异常。
- **失败降级**：`analyze_error` 任何异常都返回 `AnalysisResult(summary="AI analysis unavailable", root_cause=<原错误>, confidence=0.0)` 并记 error 日志——**永不向上抛**，任务脚本可以放心 `await` 而不必包 try。
- 后端：`openai`（默认 `https://api.openai.com/v1`，需 api_key Bearer）与 `ollama`（默认 `http://localhost:11434/v1`，无鉴权头）；其他 provider 直接 `ValueError`。请求统一 `temperature=0.3`、超时 60s。

### 典型用法

```python
from autocodeflow_ai import AIAnalyzer

analyzer = AIAnalyzer(provider="openai", api_key="sk-xxx",
                      base_url="https://api.openai.com/v1")   # 或 ollama：base_url="http://localhost:11434/v1"
res = await analyzer.analyze_error(
    task_name="daily-report",
    error_message="Connection refused",
    logs="<执行日志文本，可截断>",
)
print(res.root_cause, res.suggestions, res.confidence)
```

`base_url` 归一化示例（R22）：`https://host` → `https://host/chat/completions`（补 `/v1` 前的基址也能工作）；`https://host/v1/` → `https://host/v1/chat/completions`；已经写全 `.../chat/completions` 的旧写法原样保留。

## 与其他组件的关系

- **被依赖**：仅任务脚本（跑在 [executor-python](../../01-apps/executor-python/README.md) 或 Node 执行器的 shell 任务里）；平台侧的失败分析走 admin-api 自身 AI 模块，与本库无 import 关系。
- **依赖**：openai（声明）、httpx（实现）；见 [python-libs 总览](README.md)。
- CLI/MCP 的 `task analyze` / `app analyze` 是 admin-api 侧的同主题能力，见 [acf-cli](../acf-cli.md) 与 [mcp-server](../mcp-server.md)。

## 常见改动场景

- **加一个 AI 能力**（如"总结本次执行产出"）：在 `analyzer.py` 加 `async def analyze_xxx(...)`，复用 `_call_ai` + `_parse_response` → `tests/test_analyzer.py` 补用例（conftest 已备 mock）→ 更新 `__init__` 导出（若新公开类）与本文档。
- **调整 prompt/JSON schema**：三处同步——prompt 文本、`_parse_response` 的字段、测试向量；注意老模型可能带围栏返回，保持 `_strip_code_fence` 兼容。
- **换默认模型/加 provider**：`__init__` 的 model 缺省与 `_call_ai` 的分支各改一处。

## 相关文档

- [python-libs 总览](README.md) · [admin-api 的 AI 接入](../../01-apps/admin-api/README.md)
- [产品能力地图（AI 辅助）](../../00-overview/01-product-overview.md)
