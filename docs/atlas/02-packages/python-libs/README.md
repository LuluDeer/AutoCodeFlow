# python-libs — 四个任务侧 Python 工具库总览

> 所属: docs/atlas/02-packages/python-libs · 最后核对: 2026-09-13 · 对应代码: packages/autocodeflow-{ai,db,http,notify}

## 一句话定位

`autocodeflow-ai / -db / -http / -notify` 是四个**面向任务脚本作者**的独立 Python 小库：任务跑在执行器上时，业务代码可以 import 它们来完成 AI 分析、连数据库、带重试的 HTTP 调用、发通知。它们不属于 SDK 的运行时，也不被 admin-api/执行器直接依赖——**唯一的消费者是任务代码本身**。

## 包索引（版本与依赖摘自各自 pyproject.toml）

| 库 | PyPI 名 | 版本 | Python | 运行时依赖 | 文档 |
|---|---|---|---|---|---|
| packages/autocodeflow-ai | `autocodeflow-ai` | 0.1.0 | >=3.10 | `openai>=1.0.0`、`httpx>=0.25.0` | [ai](ai.md) |
| packages/autocodeflow-db | `autocodeflow-db` | 0.1.0 | >=3.10 | `sqlalchemy>=2.0`、`psycopg2-binary>=2.9` | [db](db.md) |
| packages/autocodeflow-http | `autocodeflow-http` | 0.1.0 | >=3.10 | `httpx>=0.25.0`、`tenacity>=8.0.0` | [http](http.md) |
| packages/autocodeflow-notify | `autocodeflow-notify` | 0.1.0 | >=3.10 | `httpx>=0.25.0` | [notify](notify.md) |

构建体系统一为 setuptools（`pyproject.toml`，`requires = ["setuptools>=68"]`），每个库都是"单个源码模块 + 单个 `tests/` 目录"的最小布局（如 `autocodeflow_ai/analyzer.py` + `tests/test_analyzer.py`）。

## 依赖关系

```
任务脚本（跑在 executor-python / executor-node 的 shell 里调 python）
  ├─ autocodeflow-ai      ──依赖──▶ openai(声明) + httpx(实现直连 chat/completions)
  ├─ autocodeflow-db      ──依赖──▶ sqlalchemy + psycopg2-binary
  ├─ autocodeflow-http    ──依赖──▶ httpx + tenacity
  └─ autocodeflow-notify  ──依赖──▶ httpx ──POST /api/notification/send──▶ admin-api
```

- **四库之间零相互依赖**，也不依赖 `autoflow-sdk`——任意按需安装。
- 对 admin-api 只有 `notify` 一个明确的 REST 依赖点（`POST /api/notification/send`，N22 单数路由）；其余三库面向外部世界（AI 服务、业务数据库、任意 HTTP 端点）。
- 全部**不在** release-please / release.yml 的 lockstep 发布矩阵中（当前 0.1.0，未发布到 PyPI 的流程里；经 [私有 PyPI](../../01-apps/registry-pypi/README.md) 分发是预期路径）。

## 测试命令（根 package.json 核实）

```
npm run test:lib-ai       # cd packages/autocodeflow-ai    && python -m pytest tests -q
npm run test:lib-http     # cd packages/autocodeflow-http  && python -m pytest tests -q
npm run test:lib-notify   # cd packages/autocodeflow-notify&& python -m pytest tests -q
npm run test:lib-db       # cd packages/autocodeflow-db    && python -m pytest tests -q
```

注意：四个库的测试都跑 `tests/` 子目录（而非包根），dev extras 带 `pytest`、`pytest-asyncio`（http 另有 `pytest-httpx`）。

## 四个库的定位边界（避免误用）

- **ai vs admin-api AI 模块**：任务想"顺手"诊断自己的错误用本库；平台在执行失败后自动做的 AI 分析走 admin-api 自身的 OpenAI/Ollama 集成（写回 execution 的 analysis 字段）。两套实现同源（同样的 provider 约定），但没有代码共享。
- **http vs autoflow-sdk HttpClient**：调用业务外部服务（带重试/熔断诉求）用 `autocodeflow-http`；向 admin-api 回报执行结果只能用 `autoflow-sdk` 的 `CallbackClient`（协议与鉴权都不同，后者是执行器注入的一次性 HMAC 凭证）。
- **db 不含模型层**：平台自己的表（Task/Execution/...）归 admin-api/TypeORM 管，本库只提供空白的 Session 工厂，任务自己 `text()` 查询或自带 ORM 模型。
- **notify 不直连 IM**：Webhook 地址与 SMTP 凭据沉淀在 admin-api 通知配置里（admin-web 可管理），任务侧只有"渠道名 + 消息"，凭据不进任务环境。

## 运行时如何被拿到

任务脚本运行在执行器上：executor-python 直接载入 [autoflow-sdk](../autoflow-sdk.md)；四个工具库则需要任务作者显式引入——脚本内 `pip install autocodeflow-xxx`（可指向[私有 PyPI](../../01-apps/registry-pypi/README.md)）或把依赖写进任务的 requirements 声明。Node 执行器的 shell 任务里同样可以 `python -c` 调用，但纯 Node 任务用不到它们。

## 统一布局与导出约定

每个库都是同一套最小布局（以 ai 为例，其余同构）：

```
packages/autocodeflow-xxx/
├── pyproject.toml               setuptools>=68；[project] name/version/deps；dev extras
├── autocodeflow_xxx/            单一源码模块（下划线包名）
│   ├── __init__.py              __version__ = "0.1.0" + __all__（公开 API 白名单）
│   └── <核心模块>.py            ai→analyzer.py / db→connection.py / http→client.py / notify→notify.py
└── tests/                       conftest.py（mock 基建）+ 每模块一个 test_*.py
```

公开 API 一律经 `__init__.py` 的 `__all__` 收口；各库公开面都是 2–4 个名字：

- ai：`AIAnalyzer`、`AnalysisResult`
- db：`DatabaseConfig`、`DatabaseSession`、`get_session`
- http：`AutoFlowHttpClient`、`CircuitBreaker`、`RetryConfig`、`SAFE_METHODS`
- notify：`NotifyClient`、`NotifyChannel`

## 常见改动场景

- **修某个库的行为**：改对应单模块源码 → 补/改 `tests/` → 跑上面对应 test:lib-* 命令 → 更新本文档与该库文档的"最后核对"。
- **新增第五个工具库**：在 `packages/` 下建 `autocodeflow-xxx`（复制同构 pyproject + 单模块 + tests）→ 根 package.json 加 `test:lib-xxx` → 在 [包生态总览](../README.md) 与本目录挂新文档。
- **升级依赖版本下限**：只动各库自己的 `pyproject.toml`，无 lockstep 约束。

## 相关文档

- [包生态总览](../README.md) · [autoflow-sdk（平台侧 SDK，非本目录）](../autoflow-sdk.md)
- [executor-python](../../01-apps/executor-python/README.md) · [通知链路](../../04-flows/notification-flow.md)
