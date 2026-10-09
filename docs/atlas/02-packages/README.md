# packages/ 包生态总览

> 所属: docs/atlas/02-packages · 最后核对: 2026-09-13 · 对应代码: packages/

## 一句话定位

`packages/` 收纳 AutoCodeFlow 全部**可复用包**：两个面向人的操作入口（CLI、MCP Server）、两个任务侧 SDK（Node / Python）、四个任务脚本可用的 Python 工具库、一份四端共享的契约测试向量，以及 SDK 文档站。除 `docs-site` 与 `contract-fixtures` 外，其余均以独立包形式发布（npm / PyPI）。

## 包索引表（名称与版本摘自各 package.json / pyproject.toml）

| 目录 | 发布名 | 当前版本 | 形态 | 一句话职责 | 文档 |
|---|---|---|---|---|---|
| packages/acf-cli | `acf-cli`（bin: `acf`） | 1.0.0 | npm（**不发布**，npmjs 名称已被第三方占用） | 命令行管理任务/执行/应用/执行器/审计 | [acf-cli](acf-cli.md) |
| packages/mcp-server | `autocodeflow-mcp-server`（bin: `autocodeflow-mcp`） | 1.2.0 | npm | MCP Server，让 AI Agent 管理任务与执行（40 个工具） | [mcp-server](mcp-server.md) |
| packages/autocodeflow-node-sdk | `@autocodeflow/sdk` | 1.2.0 | npm | Node/TS SDK：TaskContext、结构化日志、回调客户端 | [node-sdk](autocodeflow-node-sdk.md) |
| packages/autoflow-sdk | `autoflow-sdk` | 1.2.0 | PyPI | Python SDK：TaskContext、回调客户端、HTTP 基础件 | [autoflow-sdk](autoflow-sdk.md) |
| packages/autocodeflow-ai | `autocodeflow-ai` | 0.1.0 | PyPI | AI 分析助手（错误诊断 / 日志问答，OpenAI/Ollama） | [python-libs/ai](python-libs/ai.md) |
| packages/autocodeflow-db | `autocodeflow-db` | 0.1.0 | PyPI | SQLAlchemy 会话工厂（任务脚本连库用） | [python-libs/db](python-libs/db.md) |
| packages/autocodeflow-http | `autocodeflow-http` | 0.1.0 | PyPI | 带重试 / 鉴权 / 熔断的 HTTP 客户端 | [python-libs/http](python-libs/http.md) |
| packages/autocodeflow-notify | `autocodeflow-notify` | 0.1.0 | PyPI | 通过 admin-api 发通知（企微/钉钉/Slack/邮件/Webhook） | [python-libs/notify](python-libs/notify.md) |
| packages/contract-fixtures | —（无 package.json，不发布） | — | 静态 JSON | 四个客户端包共享的信封/错误体契约测试向量 | [contract-fixtures](contract-fixtures.md) |
| packages/docs-site | `autocodeflow-docs-site`（private） | 1.0.1 | VitePress 站点 | SDK 文档站，发布到 GitHub Pages | [docs-site](docs-site.md) |

> 注意：根 package.json 是 `autocodeflow-monorepo`（private），**刻意不启用 npm/yarn workspace 提升**（ARCH-20，各 app 独立安装依赖），只提供统一命令入口（`npm run test:cli`、`build:mcp` 等）。

## 包间依赖关系图

```
                        ┌────────────────────────┐
                        │   apps/admin-api       │  REST + 全局 {code,message,data} 信封
                        └──┬───────┬────────┬────┘
           JWT/refresh 常规 │       │ JWT    │ 一次性 v1. HMAC 回调凭证(N23)
              ┌────────────┘       │        └──────────────┐
   ┌──────────┴─────────┐  ┌───────┴────────┐   ┌──────────┴──────────┐
   │ acf-cli (axios)    │  │ mcp-server     │   │ executor-node /     │
   │ conf+commander     │  │ (node-fetch +  │   │ executor-python     │
   └────────────────────┘  │  MCP SDK)      │   └──────┬──────────────┘
                           └────────────────┘          │ 注入 env + 下发
                                            ┌──────────┴──────────┐
              任务脚本（Glue/入口文件）        │ TaskContext         │
   ┌──────────────┐  ┌──────────────┐        │  ├ @autocodeflow/sdk│(axios)
   │autocodeflow- │  │autocodeflow- │        │  └ autoflow-sdk     │(httpx)
   │http/ai/db/   │  │notify        │        └─────────────────────┘
   │notify        │  └──────┬───────┘
   └──────────────┘         │ POST /api/notification/send
                            ▼
                       admin-api

   packages/contract-fixtures/contract.json ──被 4 端测试加载──▶ acf-cli /
   mcp-server / @autocodeflow/sdk / autoflow-sdk 的契约测试
```

- **运行时依赖方向**：CLI / MCP / 双 SDK 都是 admin-api 的客户端，互不依赖；四个 Python 库只依赖第三方库（httpx/sqlalchemy/tenacity/openai…），彼此之间**零相互依赖**，也没有依赖 autoflow-sdk。
- **构建期/测试期关系**：contract-fixtures 是唯一被跨包共享的文件（append-only 契约向量）；docs-site 内容重组自各包 README 与 docs/，但独立构建、不进任何运行时包。

## lockstep 版本发布策略（证据：release-please-config.json + .github/workflows/，2026-10 根治轮）

四个**对外发布**的包走 **lockstep 单版本线**（`@autocodeflow/sdk`、`autocodeflow-mcp-server`、`@autocodeflow/cli`、`autoflow-sdk`，当前均 1.9.0）：

1. **release-please.yml**（push main 触发）：按中文 conventional commits 汇总，开/更新 Release PR，bump 版本并追加 CHANGELOG。`release-please-config.json` 关键配置：
   - **单一 root 条目（`.`）**承担整条 1.x 版本线（`release-type: simple` + `version-file: version.txt`）；
   - `include-component-in-tag: false` → tag 形态为裸 `vX.Y.Z`（非 `pkg-vX.Y.Z`）；
   - 版本落点全部由该条目的 `extra-files` **广播**：三 npm 包的 `package.json` 与各自 `package-lock.json`（**两个** version 槽位各一条 jsonpath：`$.version` 与 `$.packages[''].version`；**禁用** `$..version`，实测会改写 lockfile 里全部 165 个依赖版本）、`pyproject.toml`、`autoflow_sdk/__init__.py` 的 `__version__`、docs-site 五页、`docs/sdk-guide.md`；
   - root 条目的 `exclude-paths` 把 `apps/`、`docs/`、四个 py-libs 等排除在外，避免无关提交驱动 1.x 发版；
   - 必须配 PAT secret `RELEASE_PLEASE_TOKEN`，否则 GITHUB_TOKEN 打的 tag 不会级联触发 release.yml。
   - **为何不再是「每包一个条目 + `linked-versions`」**：顶层 `linked-versions` 键被 release-please **静默丢弃**（它只是 plugin，必须写在 `plugins` 数组里）；写对位置后本仓仍修不好——`include-component-in-tag: false` 时 `getComponent()` 恒返回 `''`，`preconfigure()` 匹配零组员，版本统一永不执行；而打开该开关 tag 会变成 `pkg-vX.Y.Z`，与 `v*` 触发器不再匹配。详见 `scripts/check-release-config.mjs` 头部注释（含实验证据与上游 issue #1750）。
2. **release.yml**（push tag `v*` 触发）：
   - `version-guard` 校验 tag == 五处版本（node-sdk / acf-cli / mcp-server 的 `package.json`、autoflow-sdk 的 `pyproject.toml` 与 `autoflow_sdk/__init__.py` 的 `__version__`），不一致直接拒绝发布；
   - 两个 publish job（npm：`@autocodeflow/sdk` + `@autocodeflow/cli` + `autocodeflow-mcp-server`；PyPI：`autoflow-sdk`）挂 `environment: release` 人工审批闸门（N42）；
   - 版本一经发布不可复用（npm EP409 / PyPI 400），恢复走 `gh run rerun --failed`（N44）。

四个 Python 工具库（http/ai/db/notify，当前 0.2.2）归独立的 `linked-versions` 组，逐包开 `include-component-in-tag: true`，tag 形态为 `autocodeflow-http-v0.2.2`——**带前缀、退出 `v*` 命名空间**，不会误触发 release.yml；它们与 docs-site 一样**不在**发布矩阵中。

## 各包测试命令速查（根 package.json 核实）

| 包 | 根命令 | 底层 |
|---|---|---|
| acf-cli | `npm run test:cli` | vitest run |
| mcp-server | `npm run test:mcp` | vitest run |
| autocodeflow-node-sdk | `npm run test:node-sdk` | jest |
| autoflow-sdk | `npm run test:sdk-py` | pytest -q |
| autocodeflow-http / ai / notify / db | `npm run test:lib-http/ai/notify/db` | pytest tests -q |
| docs-site | `npm run build:docs-site`（构建即验证，死链 fail） | vitepress build |
| contract-fixtures | 无独立命令（被上表四个客户端包的测试加载） | — |

类型检查（Node 侧）：`npm run typecheck:cli` / `typecheck:mcp` / `typecheck:node-sdk`；全量收口 `npm run test:unit` 与 `typecheck:all`。

## 包生态的两条硬约束

1. **ARCH-20**：根 package.json 刻意不做 workspace 依赖提升，各包独立 `npm install`/`pip install`——新增包时不要引入跨包的相对路径 import。
2. **契约单向源头**：响应信封行为的源头是 admin-api 的 ResponseInterceptor，四个客户端只是消费者；契约一致性由 [contract-fixtures](contract-fixtures.md) 的共享向量强制，四端测试跑的是同一份 JSON。

## 相关文档

- [产品总览](../00-overview/01-product-overview.md) · [仓库目录树](../00-overview/03-repo-layout.md)
- [admin-api 应用总览](../01-apps/admin-api/README.md) · [executor-node](../01-apps/executor-node/README.md) · [executor-python](../01-apps/executor-python/README.md)
- [MCP 审批流（DEP-04）](../04-flows/approval-flow.md) · [执行回调链路](../04-flows/execution-callback.md)
- [扩展 SDK 能力](../08-workflows/add-new-sdk-capability.md) · [发版流程](../08-workflows/release-process.md)
