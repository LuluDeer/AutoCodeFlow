# nginx 与反向代理（SSE 专用位置）
> 所属: docs/atlas/06-infra · 最后核对: 2026-09-13 · 对应代码: infra/nginx/default.conf、apps/admin-web/nginx.conf、scripts/nginx-sse-selftest.mjs、package.json（test:nginx-sse）

## 两份配置的关系

| 文件 | 谁在用 | 特点 |
|---|---|---|
| `apps/admin-web/nginx.conf` | **admin-web 容器运行时**（Dockerfile `COPY nginx.conf /etc/nginx/conf.d/default.conf`） | 额外带安全响应头（S-08：X-Frame-Options / CSP / Permissions-Policy）+ `/health` 直返 200 |
| `infra/nginx/default.conf` | 自建独立反代（非 compose 常驻服务）+ `nginx-sse-selftest.mjs` 的**原件**（仅替换上游地址与端口） | 无安全头，其余代理语义一致 |

两份配置**需保持同步**（docs/deployment.md 明确要求）：`/api/` 前缀 location、SSE 正则 location、`client_max_body_size 510m` 必须两边一致。已知差异（同步时无需抹平）：

- admin-web 版多出 S-08 安全响应头（X-Frame-Options / nosniff / XSS-Protection / Referrer-Policy / CSP / Permissions-Policy）与 `/health`（`access_log off`，直返 200 'ok'，供容器 healthcheck）。
- 静态资源：admin-web 版为 `try_files $uri =404` + expires；default.conf 版仅 expires + immutable。差异点只有安全头与静态资源 `try_files` 细节。

## location 语义（default.conf 实测核对）

```
server { listen 80;
  ① location /api/                        → 通用 API 代理
  ② location ~ ^/api/tasks/[^/]+/executions/[^/]+/logs/stream$  → SSE 专用（正则优先于①）
  ③ location /                            → SPA fallback（try_files … /index.html）
  ④ location ~* \.(js|css|png|…)$         → 静态资源缓存 expires 1y immutable
}
```

### ① 通用 `/api/`

- `proxy_pass http://admin-api:3105;` **不带 URI**——原样保留 `/api` 前缀（与 `setGlobalPrefix("api")` 对齐；误写尾斜杠会剥离前缀、全量 404）。
- `client_max_body_size 510m`（S7/QA2）：执行器包最大 500MB、应用包 200MB、PyPI 代理 50MB，nginx 默认 1m 会直接 413。
- `proxy_http_version 1.1`；`proxy_read_timeout 60s`、`proxy_connect_timeout 10s`。

### ② SSE 专用位置（核心）

- 匹配 URL 形态 `…/api/tasks/<taskId>/executions/<execId>/logs/stream`（task.controller 的 `@Get(":id/executions/:execId/logs/stream")` + 全局前缀）。**正则优先**于 `/api/` 前缀块，其余 `/api/` 请求不受影响、仍保 510m 上传语义。
- **正则 location 不继承兄弟 location 指令**——`proxy_set_header` 与 `client_max_body_size 510m` 全部就地重复（不写则回落 nginx 1m 默认）。
- 关键四件套：
  - `proxy_set_header Connection "";` —— 空 Connection 头保持上游 HTTP/1.1 长连接（保活），长流必需；
  - `proxy_read_timeout 1h;` —— 日志流可能长时间静默，通用位置的 60s 会掐断流；
  - `proxy_buffering off; proxy_cache off;` —— 不缓冲，首帧立即下发（缓冲会攒满 buffer 才转发 = "日志不实时"的根因）。
- 应用侧配合：响应头 `X-Accel-Buffering: no`（nginx 默认尊重，无需 `proxy_ignore_headers`）+ 空闲 `": ping"` 注释帧（15s 档）双保险。

### 其余

- `metrics/stream`、`executions/stream` 两条 SSE **没有**专用 location，走通用 `/api/`：靠应用侧 `X-Accel-Buffering: no` 关缓冲（nginx 默认尊重该头），30s 级 ping 撑活 60s 读超时；若把通用位置 `proxy_read_timeout` 调小于 ping 间隔，这两条流会断。
- ~~`/socket.io/`：WS 透传~~ —— F-4 已删除：全仓无 socket.io/WebSocket 实际使用（前端长连接仅 SSE，ADR-015 已否决 WebSocket 反向隧道）。
- 压缩：server 级 `gzip on`（default.conf 顶部），`gzip_types` 覆盖 text/css、application/json 等，`gzip_min_length 1024`——SSE 响应不在压缩之列（`text/event-stream` 未列入 gzip_types，且 `proxy_buffering off` 下无攒批面）。

## 改配置 checklist（上线前）

1. 两份配置同步改：`apps/admin-web/nginx.conf` 与 `infra/nginx/default.conf`（deployment.md 明文要求）。
2. SSE 正则 location 的四件套齐全：`Connection ""`、`proxy_read_timeout 1h`、`proxy_buffering off`、`proxy_cache off`；`proxy_set_header` 五项就地重复。
3. `client_max_body_size 510m` 两处都有（通用 + SSE 正则内），否则大包上传 413。
4. 自建反代部署后必跑：`npm run test:nginx-sse`（默认 180s soak）；发布门禁用 `NGINX_SOAK_SECONDS=86400`。
5. 上游地址改为非 compose 部署时，同时检查 `X-Forwarded-Proto`（影响回调/跳转的 scheme 识别）。

## 怎么验证：`npm run test:nginx-sse`

- 命令：`node scripts/nginx-sse-selftest.mjs`（= 根 package.json `test:nginx-sse`）。
- 机制：取 `infra/nginx/default.conf` **原件**（仅替换上游地址/监听端口）起真实 nginx 容器 + 探针执行器（接受派发、永不回报、周期心跳，把执行钉在 RUNNING 才有长流可测）。
- 断言（BUG-17 套件）：
  1. 通用 `/api/` 透传正常；2. 专用位置流式契约（`text/event-stream`、无 Content-Length=chunked、首帧不迟滞）；3. 长流 soak 不断连、ping 间隔 ≤45s（`NGINX_SOAK_SECONDS` 默认 180s，支持 86400=24h 发布门禁）；4. 业务事件穿透真实路径（executor 回调→领域事件→SSE→nginx→客户端）；5. **三条 SSE 并存**互不干扰；6. 长流期间普通请求不被拖慢；7. admin-api RSS 涨幅受控。
- 环境开关：`NGINX_SKIP_DOCKER=1` 复用本机 PG/Redis；`NGINX_PROXY_PORT` 等可注入；无 docker 时显式 skip 退出 0。
- 实测记录：经反代 500 条 SSE 并发 500/500 建连存活（`NGINX_SSE_CONNS=500`，套件 24/24）；hold 必须 > `EXECUTIONS_STREAM_IDLE_PING_MS`（30s），否则出现"一半零帧"假象。
- 脚本可注入的环境开关（读自脚本源码）：`NGINX_SOAK_SECONDS`（soak 时长）、`NGINX_SKIP_DOCKER`、`NGINX_SSE_CONNS`、端口族 `NGINX_DB_PORT/NGINX_REDIS_PORT/NGINX_API_PORT/NGINX_PROXY_PORT`、库参数 `NGINX_DB_HOST/USER/PASS/NAME`、`NGINX_EXECUTOR_SECRET`。

## 鉴权与坑

- SSE 流鉴权与 REST 同源（JWT Bearer；`/metrics/stream`、`/executions/stream` 另支持 `?access_token=` 兜底）——EventSource 无法自定义 header 时用该兜底。
- 改 `client_max_body_size` 只在 `/api/` 与 SSE location 各写一份才有效（继承规则陷阱）。
- 排障口诀：实时日志"固定时间断开"→ 查两份 nginx 配置的 SSE location 是否存在、`proxy_read_timeout` 是否被调小（docs/operations.md 同款结论）。
- 不要在 admin-web 前再叠加会缓冲响应的代理层（CDN 二次缓冲同理）。
- 通用位置 `proxy_read_timeout 60s` 同时约束所有普通 API：长耗时同步请求经反代不得超过该值，需要更长时单独加 location，而不是全局调大。
- default.conf 顶部的 server 级 `gzip on` 与 SSE 无冲突（`text/event-stream` 不在 `gzip_types` 清单中），勿把 `text/event-stream` 手工加进压缩类型。

## 相关文档

- [docker-compose.md](docker-compose.md)（admin-web 容器 = 反代宿主）· [scripts.md](scripts.md)（nginx-sse-selftest 归类）
- [../05-interfaces/rest-api.md](../05-interfaces/rest-api.md)（三条 SSE 流语义）· `docs/deployment.md`「反代 SSE」章节
