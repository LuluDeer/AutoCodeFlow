# 环境变量总表（以 .env.example 为准）
> 所属: docs/atlas/06-infra · 最后核对: 2026-09-13 · 对应代码: .env.example（162 行）、apps/admin-api/src/config/configuration.ts（Joi 校验侧）、docker-compose.yml（注入侧）

## 怎么用

`cp .env.example .env` 后填机密；根 compose 读取同一份 `.env` 注入各服务。下表默认值均摘自 `.env.example` 原文；`（无默认）`= 必填或留空生效。共 **20+ 分组、约 80 个变量**，此处列全分组与关键项。

## 数据库（PostgreSQL）

| 变量 | 默认 | 说明 |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `DB_DATABASE` | `autoflow` / change_me_strong_password / `autoflow` | 容器初始化；密码生产 ≥16 字符 |
| `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` | `postgres` / `5432` / `autoflow` / 同上 | admin-api 连接（compose 内固定 host=postgres） |
| `DB_POOL_SIZE` | `20` | 连接池；压测实爆瓶颈位（waiting 280），扩容先调它 |
| `DB_READ_REPLICA_URL` | 空=关闭 | ARCH-24 读写分离；SELECT 走副本，写/事务/迁移恒走主库 |

## Redis / JWT / CORS

| 变量 | 默认 | 说明 |
|---|---|---|
| `REDIS_HOST` / `REDIS_PORT` | `redis` / `6379` | compose 注入（不在 .env.example 顶层，经 configuration.ts 默认） |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | change_me…32chars | 生产 ≥32 字符，`openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | （配置默认 15m） | access token 有效期 |
| `CORS_ORIGINS` | `http://localhost,http://localhost:5176` | 生产替换真实域名，不能含 localhost |
| `ADMIN_WEB_ORIGIN` | `http://localhost` | admin-web 来源校验 |

## 执行器鉴权与安全

| 变量 | 默认 | 说明 |
|---|---|---|
| `EXECUTOR_SECRET` | change_me…16chars | 全部执行器共享密钥（注册/心跳/回调/拉包） |
| `EXECUTION_CALLBACK_SECRET` | 空=回落 `EXECUTOR_SECRET` | N23 per-execution token 的 HMAC 密钥（两侧必须同源） |
| `REQUIRE_TOKEN` | `true` | S9：执行器无 token 时拒绝 `/api/*`（503 fail-closed） |
| `EXECUTOR_ALLOW_PRIVATE_NETWORK` | `false` | SSRF 守卫（F-3/S7）：`true` 放行 RFC1918 出站/内网 gitRepo；同机部署必须 true |
| `EXECUTOR_PYTHON_PUBLIC_ADDRESS` / `EXECUTOR_NODE_PUBLIC_ADDRESS` | 空 | 多机部署时执行器公网注册地址 |
| `ADMIN_API_URL_INTERNAL` / `ADMIN_API_URL_EXTERNAL` | `http://admin-api:3105` / 空 | 执行器回调目标 |

## 限流（admin-api）

| 变量 | 默认 | 说明 |
|---|---|---|
| `THROTTLE_LIMIT` / `THROTTLE_TTL` | `60` / `60000` | 全局 API 限流（次/毫秒）；压测建议 600 |
| `LOGIN_THROTTLE_LIMIT` | `20` | 登录限流（生产建议 5） |
| `THROTTLE_CALLBACK_LIMIT` / `_TTL` | 60（代码默认） | 回调端点限流（env 可配，BUG-19 修复产物；NAT 多执行器同出口 IP 时调大） |

## 调度 / 恢复

| 变量 | 默认 | 说明 |
|---|---|---|
| `STALE_RECOVERY_RETRY_ENABLED` | `true` | stale sweep 兑现重试预算；false=旧行为（只置 FAILED） |

## SSE 流

| 变量 | 默认 | 说明 |
|---|---|---|
| `METRICS_STREAM_*`（槽位/idlePing） | 全局 32 / 15s（代码默认） | `/metrics/stream` 并发槽与保活间隔 |
| `EXECUTIONS_STREAM_IDLE_PING_MS` | `30000` | `/executions/stream` 空闲 ping（nginx-sse 自测 hold 必须大于它） |

## admin-web / 前端

| 变量 | 默认 | 说明 |
|---|---|---|
| `VITE_API_URL_INTERNAL` | `http://admin-api:3105` | nginx 反代注入前端的内部 API 地址 |
| `VITE_API_URL_EXTERNAL` | 空 | 外部直连地址（可选） |
| `REACT_APP_API_URL` | `http://localhost:3105` | 旧变量名，compose 注入 admin-web 容器 |

## 私有包仓库

| 变量 | 默认 | 说明 |
|---|---|---|
| `NPM_REGISTRY_URL` / `PYPI_REGISTRY_URL` | 空=官方源 | 私服地址（compose 内默认注入 `http://registry-npm:4873`、`http://registry-pypi:8003/simple/`） |
| `NPM_REGISTRY_TOKEN` / `NPM_REGISTRY_USER` / `NPM_REGISTRY_PASS` | 空 | S5 私服服务账号；token 优先于 user/pass |
| `REGISTRY_UPLOAD_TIMEOUT_MS` | `60000` | registry 上传代理超时 |
| `REGISTRY_USER` / `REGISTRY_PASS` | `admin` / change_me | registry-pypi 服务自身凭证（仅 Basic Auth；E-34 起无 `PYPI_API_KEY`） |

## AI 集成

| 变量 | 默认 | 说明 |
|---|---|---|
| `AI_PROVIDER` | `disabled` | `disabled \| openai \| ollama` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | 空 / `gpt-4o-mini` | OpenAI 侧 |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | `http://localhost:11434` / `llama3` | Ollama 侧 |

## 通知（五通道）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WECOM_WEBHOOK` / `DINGTALK_WEBHOOK` / `SLACK_WEBHOOK` | 空 | 企业微信 / 钉钉 / Slack webhook |
| `FEISHU_WEBHOOK` / `FEISHU_SECRET` | 空 / 空 | 飞书机器人（NF-05）；SECRET 为可选加签密钥 |
| `EMAIL_HOST/PORT/SECURE/USER/PASS/FROM/TO` | 空 / `465` / `true` / … / `autocodeflow@noreply.com` / 空 | SMTP 邮件 |

## 日志与对象存储

| 变量 | 默认 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `info` | 各服务日志级别 |
| `LOG_RETENTION_DAYS` | `7` | 执行器工作目录 TTL 清理（node 侧取 max(1, 值)） |
| `LOG_STORAGE_DRIVER` | `db` | LOG-02：`db`=execution_log_lines；`s3`=MinIO gzip 对象（需 minio profile） |
| `LOG_STORAGE_BUCKET/ENDPOINT/ACCESS_KEY/SECRET_KEY/USE_SSL` | `autoflow-logs` / `minio:9000` / `autoflow` / 空 / `false` | S3 驱动参数 |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `autoflow` / **无默认（必填）** | minio profile 启动凭证 |
| `DISK_CLEANUP_TTL_DAYS` / `_INTERVAL_SECONDS` / `_INITIAL_DELAY_SECONDS` | `7` / `21600` / `600` | executor-python 磁盘回收（E8） |

## 初始管理员（首次部署）

| 变量 | 默认 | 说明 |
|---|---|---|
| `INITIAL_ADMIN_PASSWORD` | `change_me_immediately` | 首启 seed admin 用户（compose 另有默认 `INITIAL_ADMIN_EMAIL=admin@autoflow.local`） |

## 常见坑

1. `EXECUTION_CALLBACK_SECRET`/`THROTTLE_CALLBACK_LIMIT`/`NPM_REGISTRY_TOKEN` compose **默认未注入**——需要时自行加进 compose `environment` 或独立部署传参。
2. `LOG_STORAGE_DRIVER=s3` 但没启用 minio profile → 日志写入失败。
3. `POSTGRES_PASSWORD` 改了但卷已初始化 → 容器仍用旧密码；换密码须 `down -v`。
4. admin-api 侧 env 经 Joi 校验（configuration.ts），格式非法直接拒绝启动——报错信息里会指出变量名。

## 相关文档

- [docker-compose.md](docker-compose.md)（注入关系）· [deployment-and-ci.md](deployment-and-ci.md)（CI env）
- 各应用专属 env：[../01-apps/executor-node/README.md](../01-apps/executor-node/README.md)、[../01-apps/executor-python/README.md](../01-apps/executor-python/README.md)、[../01-apps/admin-api/README.md](../01-apps/admin-api/README.md)
