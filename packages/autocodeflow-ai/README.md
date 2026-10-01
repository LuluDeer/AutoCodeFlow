# autocodeflow-ai

AutoCodeFlow 任务脚本的 AI 分析辅助库：为任务失败日志提供**根因分析**
（OpenAI / Ollama 后端，基于 openai SDK + httpx）。

## 特性

- 结构化结果：`AnalysisResult`（summary / root_cause / suggestions / confidence / raw_response）；
- 失败可分类、不抛异常：AI 不可用时返回降级结果并带 `error_kind`
  （network / http_5xx / http_4xx / provider_unavailable / invalid_response / unknown），
  调用方可区分「AI 结论不可用」与「网络瞬时失败」；
- 出站脱敏钩子（PK-17）：`redactor` 回调作用于所有送出的日志/错误文本，
  避免明文密钥流向第三方端点；提示词内置「不得回显凭据」约束；
- `base_url` 兼容 base 形态（`.../v1`）与完整端点两种写法（自动归一化）。

## 安装

```bash
pip install autocodeflow-ai
# 或作为任务依赖（AutoCodeFlow 任务 requirements 字段）：
#   requirements: ["autocodeflow-ai"]
```

## 最小示例

```python
from autocodeflow_ai import AIAnalyzer

analyzer = AIAnalyzer(provider="openai", api_key="sk-xxx")
result = await analyzer.analyze_error(
    task_name="daily-report",
    error_message="Connection refused",
    logs="...",
)
print(result.root_cause)
print(result.error_kind)  # 成功路径为 ""；降级时为错误分类
```

Ollama 后端：

```python
analyzer = AIAnalyzer(provider="ollama", base_url="http://localhost:11434/v1")
```

日志可能含密钥时务必提供 redactor：

```python
analyzer = AIAnalyzer(provider="openai", api_key="sk-xxx", redactor=mask_secrets)
```

## 开发

```bash
pip install -e ".[dev]"
pytest
```
