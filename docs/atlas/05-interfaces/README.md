# 05-interfaces — 对外接口总览
> 所属: docs/atlas/05-interfaces · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src、packages/mcp-server/src、packages/acf-cli/src、packages/autoflow-sdk、packages/autocodeflow-node-sdk

## 一句话定位

AutoCodeFlow 的所有外部能力都从 **admin-api（NestJS，端口 3105，全局前缀 `/api`）** 出去；本目录把四类入口（REST / MCP / CLI / SDK）汇成一张地图，对接方按自己的形态选路即可。

## 四类入口一张地图

```
                        ┌────────────────────────────────────────┐
   浏览器/前端  ────────▶│                                        │
   curl / 脚本  ────────▶│  admin-api :3105  (全局前缀 /api)       │
                        │   ├─ REST 控制器 24 个（21 个路由前缀）  │
   MCP 客户端           │   ├─ SSE 三条流（见 rest-api.md 末节）   │
  (Claude/Cursor) ──┐   │   └─ Swagger UI /api/docs（仅非生产）    │
                    │   └───────────────▲────────────────────────┘
          packages/mcp-server          ▲
          （stdio，40 工具，HTTP 转发） │ 所有入口最终都落在
                    ▲                  │ 同一组 REST 端点上
          packages/acf-cli             │
          （`acf` 命令，39 子命令）     │
                    ▲                  │
          任务子进程 SDK（回调面）      │
          autoflow-sdk (Python) /      │
          @autocodeflow/sdk (Node) ────┘  只调 POST /api/executions/callback
```

| 入口 | 包/位置 | 传输 | 典型使用者 | 本目录文档 |
|---|---|---|---|---|
| REST | `apps/admin-api/src/modules/*` | HTTP :3105 | 前端、CI 脚本、curl | [rest-api.md](rest-api.md) |
| MCP | `packages/mcp-server`（bin `autocodeflow-mcp`） | stdio（JSON-RPC），内部转 HTTP | AI Agent（Claude/Cursor 等） | [mcp-tools.md](mcp-tools.md) |
| CLI | `packages/acf-cli`（bin `acf`） | HTTP :3105 | 运维/开发终端 | [cli.md](cli.md) |
| SDK | `packages/autoflow-sdk`（PyPI）/ `packages/autocodeflow-node-sdk`（npm） | 进程内 → 回调 HTTP | 任务脚本作者 | [sdks.md](sdks.md) |

## 鉴权方式速查

| 凭证 | 形态 | 谁在用 | 发放/配置位置 |
|---|---|---|---|
| 用户 access token | JWT Bearer，默认 15 分钟（`JWT_EXPIRES_IN`） | 前端、CLI、MCP、脚本 | `POST /api/auth/login`（TOTP 启用者两步） |
| refresh token | 长效，原子轮换（DR-07） | 同上 | 登录/刷新响应，`POST /api/auth/refresh` |
| API Key | `Bearer acf_<64 hex>`（AUTH-03） | CI/CD 机器账号 | `POST /api/api-keys`，scope 见 [api-keys 模块](../01-apps/admin-api/modules/api-keys.md) |
| executor 共享/per-address token | Bearer `EXECUTOR_SECRET` 或 executor 专属 token | 执行器注册/心跳/回调/拉包 | env `EXECUTOR_SECRET`、`POST /api/executors/token`、`POST /api/executors/:id/rotate-token` |
| per-execution 回调 token | `v1.<executionId>.<exp>.<hmac>`（N23） | 任务子进程 SDK 主动回调 | executor 派发时注入 `AUTOFLOW_CALLBACK_TOKEN` |
| RBAC | JWT `role=ADMIN`（RolesGuard） | config 写面、executor-packages、用户管理、审批 | 用户表 role 字段 |

回调链路整体语义见 [security-model](../04-flows/security-model.md) 与 [execution-callback](../04-flows/execution-callback.md)。

## OpenAPI 生成链（契约是入库生成物）

```
controller 装饰器(@ApiOperation/DTO)
   │  npm run openapi:export            （= apps/admin-api 的 swagger:export，
   │                                      jest e2e "OpenAPI export" boot 整个 AppModule）
   ▼
apps/admin-api/openapi.json             ← 入库产物 ①
   │  npm run gen:api-types             （= admin-web 的 openapi-typescript）
   ▼
apps/admin-web/src/types/generated/api-types.ts   ← 入库产物 ②（前端请求类型）

人工维护的手册：docs/api-reference.md（按前缀分节，含鉴权/限流语义说明）
运行时交互文档：http://localhost:3105/api/docs（Swagger UI，SEC-06：仅非生产环境开放）
```

- 改了 DTO/controller 必须**重跑两条命令并提交两份产物**，否则 CI 的 `api-types-drift` job 红灯（见 [deployment-and-ci](../06-infra/deployment-and-ci.md)）。
- `docs/api-reference.md` 与生成物是两条独立链：手册允许归并次要端点、补充语义，但不得与 openapi.json 冲突。

## 常见坑

1. **全局前缀 `/api`**（`main.ts setGlobalPrefix("api")`）——直连 admin-api 时路径必须带 `/api`；经 admin-web 容器 nginx 访问时同样保留（`proxy_pass` 不带 URI）。写成 `http://host:3105/tasks` 会 404。
2. **响应统一 envelope**——REST 响应经全局 ResponseInterceptor 包裹；但三条 SSE 流走 `@Res()` 直写，**没有** envelope，是裸 `text/event-stream`。
3. **429**——全局限流默认 60 次/分钟（`THROTTLE_LIMIT`），登录/刷新有独立更严限流；压测前先调大（见 [env-vars](../06-infra/env-vars.md)）。
4. **Swagger UI 生产关闭**——自动化对接不要依赖 UI，直接消费 `openapi.json`。
5. 每个 REST 响应带 `X-Trace-Id` 头，报障时附上。

## 相关文档

- [rest-api.md](rest-api.md) — REST 端点分组地图与 SSE 三条流
- [mcp-tools.md](mcp-tools.md) — 40 个 MCP 工具
- [cli.md](cli.md) — `acf` 39 个子命令
- [sdks.md](sdks.md) — 双 SDK 对照
- [../01-apps/admin-api/README.md](../01-apps/admin-api/README.md) — admin-api 应用总览（各模块 DTO 细节进 `modules/` 单篇）
- [../02-packages/mcp-server.md](../02-packages/mcp-server.md) / [../02-packages/acf-cli.md](../02-packages/acf-cli.md) — 包实现细节
- [../04-flows/security-model.md](../04-flows/security-model.md) — 认证与信任链
