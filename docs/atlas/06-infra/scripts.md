# 仓库脚本地图
> 所属: docs/atlas/06-infra · 最后核对: 2026-09-13 · 对应代码: Makefile、dev.sh、start-dev.sh、init-db.sh、scripts/（32 个文件）、package.json scripts

## 入口脚本（仓库根）

| 脚本 | 作用 | 关键点 |
|---|---|---|
| `dev.sh [start\|infra\|stop\|status\|clean]` | 开发环境一键起：infra compose → 各子项目 install → 迁移 → 并行起 4 服务 | 检查 node/npm/python3/docker；自动补 `.env`；打印默认登录 admin/admin123；`clean` 会 `down -v` 清卷 |
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

- 测试族 `test:*`：api / node / python / web / cli / mcp / pypi / sdk-py / node-sdk / lib-http / lib-ai / lib-notify / lib-db / desktop / registry-npm / private-registry(:live,:dispatch) / arch31-multi-instance / arch31-rollout / arch31-outbox / nginx-sse / qa05-callback-tier / all。
- `typecheck:*`：api / node / cli / mcp / node-sdk / desktop / web / all。
- `lint:*`：api / web / node（显式跳过）/ all。`build:*`：web / node / node-sdk / cli / mcp / desktop / docs-site / `bundle:executor`。
- OpenAPI 链：`openapi:export`、`gen:api-types`（见 [../05-interfaces/README.md](../05-interfaces/README.md)）。
- 工具：`demo:seed(:selftest)`、`demo:failure:seed(:selftest)`、`load-test`、`bench:micro(:selftest)`。

## scripts/ 目录（32 个文件，分类清单）

### 全链编排（起真实栈）
| 脚本 | 说明 |
|---|---|
| `e2e-full.sh` | 根级 43 例 Playwright e2e 编排（CI 与本地同一入口）；PG+Redis→admin-api→executor-node 注册在线→vite；`SKIP_DOCKER=1` 复用外部依赖（CI 用） |
| `load-test-stack.sh` | QA-05/BUG-19 容量压测编排（同栈形态，末段驱动 load-test.mjs；含 RSS/CPU/DB 池/事件循环水位采样） |
| `chaos-drill.sh`（+ `.selftest.sh`） | QA-06 混沌注入演练：注入→断言→恢复→二次断言 |
| `ci-local.sh` | 本地一条命令复刻 ci.yml 全部 job（R8：远端无凭证时的等价物） |
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

> selftest（`.selftest.mjs` / `.selftest.sh`）模式：不连真库，用临时沙箱验证判据本身——CI 与本地都跑，改判据时先改 selftest。

### ARCH-31 多实例
`arch31-multi-instance-selftest.mjs`（同实例第 3 条流 503/另一实例可建）、`arch31-outbox-claim-selftest.mjs`（outbox 认领）、`arch31-rollout-cross-instance-selftest.mjs`（跨实例发布）。

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
