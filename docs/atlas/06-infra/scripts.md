# 仓库脚本地图
> 所属: docs/atlas/06-infra · 最后核对: 2026-10-05 · 对应代码: Makefile、dev.sh、start-dev.sh、init-db.sh、scripts/（78 个文件）、package.json scripts

## 入口脚本（仓库根）

| 脚本 | 作用 | 关键点 |
|---|---|---|
| `dev.sh [start\|infra\|stop\|status\|clean]` | 薄转发壳（E-P2-P5 收口）：`start`→`make dev`、`infra`→`make infra-up`、`stop`→`make infra-down`、`status`→`make status`、`clean`→`make clean`；不再自维护第二套流程 | 行为一律以 Makefile 目标为准（真正的 infra compose → install → 迁移 → 并行起服务在 Makefile 内）；`clean` 经 `make clean` 清卷 |
| `start-dev.sh` | 较老的启动脚本：根 compose 起 `postgres redis` → 起本地 PG/Redis 自检 → install → 起 admin-api + admin-web（不起执行器） | 容器名硬编码 `autoflow-postgres-1/autoflow-redis-1` |
| `init-db.sh` | 初始化数据库：psql 连通检查 → `typeorm migration:run` → 检查并创建 admin 用户 | 连接参数经**环境变量前缀**传给 ts-node（防注入，勿改回内插写法）；密码取 `INITIAL_ADMIN_PASSWORD`（兜底 admin123） |
| `deploy.sh` | 生产/测试部署（见 [deployment-and-ci.md](deployment-and-ci.md)） | `-e env` `-b build --no-cache` `-d` |
| `install.sh`（scripts/） | 执行器一键安装脚本 | 与 `apps/admin-api/src/modules/executor/install-script.content.ts` **互为拷贝**（经 `GET /api/executors/install.sh` 下发），改需同步两处 |

## Makefile（17 个目标）

- 开发：`dev`（infra+install+迁移+并行起服务）、`install`、`infra-up`、`infra-down`。
- 构建/部署：`build`、`start`、`stop`、`restart`。
- 质量：`test` / `lint` / `typecheck`（ARCH-20：**全部委托** `npm run test:unit` 等，Makefile 不维护命令清单）。
- 数据库：`db-migrate`、`db-migrate-revert`、`db-migrate-gen`、`demo-seed`、`demo-seed-selftest`。
- 运维：`logs`、`status`、`clean`、`help`。

## package.json scripts（根，统一入口）

- 测试族 `test:*`：api / node / python / web / cli / mcp / pypi / sdk-py / node-sdk / lib-http / lib-ai / lib-notify / lib-db / desktop / registry-npm / private-registry(:live,:dispatch) / arch31-multi-instance / arch31-rollout / arch31-outbox / arch31-outbox-dup / pull-dispatch / control-plane-pull / oidc-sso / nginx-sse / ha-compose / compose-sandbox / qa05-callback-tier / env-drift / alerts / qwen / agent / sop / all。
- `typecheck:*`：api / node / cli / mcp / node-sdk / desktop / web / all。
- `lint:*`：api / web / node（显式跳过）/ all。`build:*`：web / node / node-sdk / cli / mcp / desktop / docs-site / `bundle:executor`。
- OpenAPI 链：`openapi:export`、`gen:api-types`（见 [../05-interfaces/README.md](../05-interfaces/README.md)）。
- 工具：`demo:seed(:selftest)`、`demo:failure:seed(:selftest)`、`load-test`、`bench:micro(:selftest)`。

## scripts/ 目录（78 个文件，分类清单）

### 全链编排（起真实栈）
| 脚本 | 说明 |
|---|---|
| `e2e-full.sh` | 根级 43 例 Playwright e2e 编排（CI 与本地同一入口）；PG+Redis→admin-api→executor-node 注册在线→vite；`SKIP_DOCKER=1` 复用外部依赖（CI 用） |
| `load-test-stack.sh` | QA-05/BUG-19 容量压测编排（同栈形态，末段驱动 load-test.mjs；含 RSS/CPU/DB 池/事件循环水位采样） |
| `chaos-drill.sh`（+ `.selftest.sh`） | QA-06 混沌注入演练：注入→断言→恢复→二次断言 |
| `ci-local.sh` | 本地一条命令复刻 ci.yml 的**主要测试 job**（12 个单测/e2e/audit；静态守卫族/selftests/docs 等不覆盖，见脚本头注）——R8 远端无凭证时的等价物 |
| `start-isolated.sh` / `stop-isolated.sh` | 隔离启动/停止（不干扰本机已有服务） |
| `nginx-sse-selftest.mjs` | BUG-17 反代 SSE 真机门禁，详见 [nginx-and-reverse-proxy.md](nginx-and-reverse-proxy.md) |

### 压测/基准
| 脚本 | 说明 |
|---|---|
| `load-test.mjs`（+ `load-test.README.md` + `.selftest.mjs`） | 零依赖压测工具；场景 `tasks` / `sse` / `callback`（详见 README） |
| `micro-benchmark.mjs`（+ `.selftest.mjs`） | 微基准 |
| `qa05-callback-tier-selftest.mjs` | QA-05 回调 10k/分钟档：探针执行器造 1000 个 RUNNING 执行 → 100×100 批量回调（`npm run test:qa05-callback-tier`） |

### 种子/演示数据
`demo-seed.mjs`（demo- 前缀任务）、`demo-failure-seed.mjs`、各自 `.selftest.mjs`——需 admin-api 已启动。

### 校验/门禁（零依赖或只读）
| 脚本 | 说明 |
|---|---|
| `check-migrations.mjs`（+ `.selftest`） | ARCH-29 迁移时间戳唯一 + 分配表注册校验（CI job） |
| `audit-verify.mjs`（+ `audit-verify.lib.mjs` + `.selftest`） | SEC-10 审计防篡改验证：append-only 触发器存在性 + 只读校验 |
| `bug18-private-registry-selftest.mjs`（+ `-dispatch-`） | 私服 npm/PyPI 契约闸（CI 跑 `--dry-run`） |
| `registry-npm-config.selftest.mjs` | Verdaccio 配置自检 |
| `smoke-round16.mjs` | 第 16 轮冒烟套件 |
| `check-consumer-routes.mjs`（+ `.selftest`） | A4 消费方路由快照守卫：mcp/CLI 硬编码路由 ⊆ openapi.json（CI） |
| `check-openapi-response-schema.mjs`（+ `.selftest` + 基线/白名单两个 json） | ARCH-23/N-12 响应体 schema 覆盖率棘轮（CI） |
| `check-enum-drift.mjs` / `check-index-drift.mjs` / `check-failure-reasons.mjs` | PK-26 TS 枚举 ⊆ PG 枚举 / NETOPT-3 实体索引 ⊆ 迁移 DDL / FR-08 failureReason 四方对齐（均 CI 门禁，秒级） |
| `check-env-drift.mjs` / `check-alerts-rules.mjs`（+ `.selftest`） | B-6 .env.example ↔ 三端 configuration 漂移 / 告警规则（含 Grafana dashboard 同源）结构守卫（均 CI） |
| `check-lint-gates.mjs` / `check-no-hoisting.mjs`（+ `.selftest`） | E-41 lint 门禁覆盖守卫 / ARCH-28b 禁 hoisting 安装模型守卫（均 CI） |
| `check-dependency-review.mjs`（+ `.selftest`） | SEC-06 豁免清单复查机制：到期 fail-closed + CI 豁免 ↔ 注册表双向对账 |
| `check-desktop-bundle-drift.mjs` / `check-desktop-update-chain.mjs`（+ `.selftest`） | F-19 bundle 语义漂移闸 / N-11 桌面更新链元数据守卫 |
| `check-compose-sandbox.mjs` | DEEP-AUDIT D2-P1-1：compose executor-python 必须显式 `TASK_SANDBOX: 'bwrap'`（CI） |
| `check-release-config.mjs` / `check-release-hygiene.mjs`（+ 同名 `.md` 手册） | 发版配置一致性（release-please ↔ release.yml）/ 发布卫生守卫 |
| `check-shell-multibyte-var.mjs` | shell 变量名吞多字节字符守卫（macOS bash 3.2 实爆回归，CI） |
| `generate-executor-protocol.mjs` | A3 协议双生成器：protocol.json → zod + pydantic（CI `gen:protocol` diff 闸） |

> selftest（`.selftest.mjs` / `.selftest.sh`）模式：不连真库，用临时沙箱验证判据本身——CI 与本地都跑，改判据时先改 selftest。

### ARCH-31 多实例
`arch31-multi-instance-selftest.mjs`（同实例第 3 条流 503/另一实例可建）、`arch31-outbox-claim-selftest.mjs`（outbox 认领）、`arch31-outbox-duplication-selftest.mjs`（outbox 投递去重）、`arch31-rollout-cross-instance-selftest.mjs`（跨实例发布）。

### 文档/安装同步链（生成物 ↔ 源头，CI diff 闸）
`gen-install-script-content.mjs`（install.sh → `install-script.content.ts` 单一事实源生成器，E-38）、`install-artifact-sha256.selftest.sh`（install.sh 的 X-SHA256 校验块回归自检，CI）。跨目录同类：`packages/docs-site/scripts/sync-check.mjs`（DOC-09 站点 ↔ 源头文档七面机检，含四包 lockstep 版本标记锁）。

### 行为自检族（有 docker 真跑全链，无则显式 skip 退 0）
`oidc-sso-selftest.mjs`、`pull-dispatch-selftest.mjs`（ARCH-32 任务派发零入站依赖）、`control-plane-pull-selftest.mjs`（ARCH-33 控制面 pull 命令队列，`unreachable-nat-host.invalid` 对照证明）、`ha-compose-selftest.mjs`、`bug07-windows-selftest.mjs`（Windows detached/信号深验，windows CI job 专跑）——除 bug07 外均接入 ci.yml `selftests` 串跑清单。

### Agent / Qwen 源码级检查
`agent-runtime-check.mjs` / `agent-boundary-check.mjs` / `agent-trigger-check.mjs`（`test:agent`）、`agent-sop-check.mjs`（`test:sop`）、`qwen-runtime-check.mjs` + `ai-qwen-structural-check.mjs`（`test:qwen`）——零依赖源码契约守卫。

### 运维/杂项
`pg-backup.sh`（+ `-entrypoint.sh`，PG 定时备份容器入口）、`pg-provision.lib.mjs`、`warm-interpreters.sh`（预热解释器 venv）、`gui-x11-s2-verify.mjs` / `gui-x11-s2-xvfb-verify.mjs`（GUI X11 一次性验收）、`verify-config.cjs`。

### 打包
`bundle-executor-artifact.sh` — 生成 `executor-node.tar.gz` 安装 artifact（dist+package.json+生产 node_modules），供 `GET /api/executors/artifact/executor-node.tar.gz` 下发（N24 根治）。

## 常见坑

1. `dev.sh` 与 `start-dev.sh` 行为不同（后者不起执行器、容器名硬编码）；新环境一律用 `dev.sh` 或 `make dev`。
2. 多数 selftest 脚本起真实容器/端口，**并行跑会撞端口**；CI 已隔离，本地逐个跑。
3. `e2e-full.sh` 每次全新库（时间戳库名）消除种子残留；别在共享库上跑。
4. `install.sh` 与后端内嵌脚本双向拷贝——只改一侧会造成下发脚本与仓库漂移。

## 相关文档

- [../07-testing/README.md](../07-testing/README.md) — 测试策略与自测脚本细目
- [deployment-and-ci.md](deployment-and-ci.md) — CI job 与脚本的对应
- [nginx-and-reverse-proxy.md](nginx-and-reverse-proxy.md) — nginx-sse-selftest 细节
