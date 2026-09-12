# 契约测试与自测脚本
> 所属: docs/atlas/07-testing · 最后核对: 2026-09-13 · 对应代码: packages/contract-fixtures/、scripts/*selftest*（15 个）、docs/VERIFY-MATRIX.md、docs/WINDOWS-TESTING-PLAN.md

## 契约测试：contract-fixtures 的四个消费测试

`packages/contract-fixtures/`（QA-07）= `contract.json` + `README.md`，是四个客户端包共享的**语言无关契约向量**——单一事实源。固化的信封语义（源头 `apps/admin-api/src/common/interceptors/response.interceptor.ts`）：

1. **envelope**：成功响应一律 `{ code, message: "success", data }`；客户端必须拆出 `data`，`data: null` 拆包结果为 `null`。
2. **passthrough**：非信封形态的 body 原样返回（数组永远不是信封）。
3. **2xx 区间**：200..299 一律按成功处理。
4. **错误体 detail 提取顺序**：`message`(string) → `message`(string[], `"; "` 连接) → `error`(string) → 空串（不得吞原始状态码/文本）。

四端测试加载**同一份文件**断言，杜绝"信封拆包缺陷四端各修各的、测试向量各自漂移"再发生（第八轮教训）：

| 消费测试 | 语言/框架 | 运行命令 |
|---|---|---|
| `packages/acf-cli/src/__tests__/client.test.ts` | TS / vitest | `npm run test:cli` |
| `packages/mcp-server/src/__tests__/api.test.ts` | TS / vitest | `npm run test:mcp` |
| `packages/autocodeflow-node-sdk/src/__tests__/contract.test.ts` | TS / jest | `npm run test:node-sdk` |
| `packages/autoflow-sdk/tests/test_contract.py` | Python / pytest | `npm run test:sdk-py` |

第五个消费方是文档侧：`packages/docs-site/scripts/sync-check.mjs`（DOC-09，CI `docs-site-build` job 连跑其 selftest）把契约面七项机检进站点文档（版本号/截断常量/failureReason 枚举/env 注入表/能力矩阵等，改源头没同步站点时 CI 变红）。契约细节与向量结构见 [contract-fixtures](../02-packages/contract-fixtures.md)。

另一条契约防漂移链（生成物入库 + CI diff，ARCH-23）：改 DTO/装饰器后必须 `npm run openapi:export`（admin-api）+ `npm run gen:api-types`（admin-web）并提交产物，CI `api-types-drift` job 对两份生成物做 `git diff --exit-code`。

## 何时要动 contract.json

- admin-api 改了 `ResponseInterceptor` 信封语义、错误体形状、2xx 判定边界 → 四端语义实质变化，更新向量后四端测试必须全绿。
- 新增客户端包 → 消费同一份 `contract.json`，不要另造样例（见 [testing-conventions](testing-conventions.md)）。
- 仅改某端内部实现、向量全绿 → 不动 fixture。

## scripts/ 下 *selftest* 清单（15 个，ls 核实）

### 独立真机/契约门禁（跑真实进程或真实配置）

| 脚本 | 一句话 | 运行命令 |
|---|---|---|
| `nginx-sse-selftest.mjs` | BUG-17：真 nginx 反代下 SSE 长流语义（缓冲/读取超时/连接复用），部署前代理层门禁 | `npm run test:nginx-sse` |
| `qa05-callback-tier-selftest.mjs` | QA-05 第四档：回调入口 10k 条/分钟真机验收（真实 execution fixture，非 load-test 幂等分支充数） | `npm run test:qa05-callback-tier` |
| `registry-npm-config.selftest.mjs` | 校验 `apps/registry-npm/config.yaml` ↔ `docker-compose.yml` ↔ README 三处配置一致 | `npm run test:registry-npm` |
| `bug18-private-registry-selftest.mjs` | BUG-18 私服 npm/PyPI 契约；默认 `--dry-run` 源码断言（CI 只跑此形态），live 起临时 PyPI uvicorn + 一次性 Verdaccio 容器 | `npm run test:private-registry`（dry）/ `npm run test:private-registry:live` |
| `bug18-private-registry-dispatch-selftest.mjs` | executor 侧互补：拉起**真实 executor-node 进程**走私服依赖安装链路，凭据不落任务树 | `npm run test:private-registry:dispatch` |
| `arch31-multi-instance-selftest.mjs` | ARCH-31：两个**真实 admin-api 进程**共享 PG+Redis（迁移链真跑）的多实例一致性 + 调度 Leader 单点性 | `npm run test:arch31-multi-instance` |
| `arch31-rollout-cross-instance-selftest.mjs` | 真实 canary 灰度 + 心跳落在非属主实例 | `npm run test:arch31-rollout` |
| `arch31-outbox-claim-selftest.mjs` | outbox 行级 claim 的双实例 DB 级并发竞争（SSRF 纪律禁回环，故不走 HTTP 回调面） | `npm run test:arch31-outbox` |

### 脚本自检（验证 scripts/ 工具自身的纯函数判据，零外部依赖，秒级）

| 脚本 | 一句话 | 运行命令 |
|---|---|---|
| `check-migrations.selftest.mjs` | check-migrations.mjs 判据自检（临时目录构造迁移/注册表矩阵） | `node scripts/check-migrations.selftest.mjs`（CI `check-migrations` job 连跑两个） |
| `audit-verify.selftest.mjs` | audit-verify.mjs 纯函数自检（零 DB），CI 私服审计链的判据侧 | `node scripts/audit-verify.selftest.mjs` |
| `chaos-drill.selftest.sh` | chaos-drill.sh 纯函数自检 + `bash -n` 语法检查（QA-06 混沌演练的判据侧） | `bash scripts/chaos-drill.selftest.sh` |
| `demo-seed.selftest.mjs` | demo-seed.mjs 纯函数自检 | `npm run demo:seed:selftest` |
| `demo-failure-seed.selftest.mjs` | demo-failure-seed.mjs 纯函数自检 | `npm run demo:failure:seed:selftest` |
| `load-test.selftest.mjs` | 压测工具判据自检（百分位/终态重复判定/429 退避/错误分类/envelope/参数边界） | `node scripts/load-test.selftest.mjs` |
| `micro-benchmark.selftest.mjs` | 微基准脚本自检 | `npm run bench:micro:selftest` |

> 规律：凡"自检"后缀 = 验证**工具脚本自身**的判据（改 `load-test.mjs` 跑 `load-test.selftest.mjs`）；凡无后缀直挂 selftest 名（nginx-sse/arch31/bug18/qa05）= 本身就是**真机门禁**（改被验证的链路时跑它）。

## CI 与本地的分工（ci.yml 核实）

| 脚本 | CI 是否跑 | 形态 |
|---|---|---|
| `check-migrations.selftest.mjs` | 是（`check-migrations` job） | 与 check-migrations.mjs 连跑 |
| `bug18-private-registry-selftest.mjs` | 是（`private-registry-contract` job） | 仅 `--dry-run` 源码契约断言（live 需 docker，只本地/真机轮） |
| `docs-site/scripts/sync-check.selftest.mjs` | 是（`docs-site-build` job） | 与 sync-check.mjs 连跑（判据自检） |
| `nginx-sse` / `qa05-callback-tier` / `arch31-*` / `:live` / `:dispatch` / `chaos-drill` 实弹 | 否 | 本地/真机轮按 [VERIFY-MATRIX](../../VERIFY-MATRIX.md) 执行 |
| 其余 `*.selftest.mjs`（demo/load-test/micro-benchmark/audit-verify） | 否（不在 ci.yml） | 随对应工具改动时手动跑，秒级 |

## 真机矩阵（既有文档，直接链接）

- [docs/VERIFY-MATRIX.md](../../VERIFY-MATRIX.md) — QA-04 真机验证矩阵 Checklist：把十五轮真机验证（V 系列）"单测全绿 ≠ 能跑"的教训固化为**按改动类型必跑**的清单。
- [docs/WINDOWS-TESTING-PLAN.md](../../WINDOWS-TESTING-PLAN.md) — Windows 深度测试任务书（R13–R16 路线）：逐轮任务、验收标准、已知风险点（附源码位置）与问题回传格式。

## 失败时先看什么

1. **契约四端红**：基本是信封/错误体语义在 admin-api 侧变了——先看 `apps/admin-api/src/common/interceptors/response.interceptor.ts` 的最近改动；四端同时红属**预期联动**，改完 `contract.json` 需四端同步过并更新 [contract-fixtures 文档](../02-packages/contract-fixtures.md)。
2. **`--dry-run` 与 live 形态**：CI 只跑 dry-run 源码断言；live 需 docker + verdaccio/uvicorn，失败先看容器/端口而非代码。
3. **arch31 / nginx-sse / qa05 真机门禁红**：这类脚本断言真实进程行为，先确认 PG/Redis/admin-api 健康、端口无占用，再查业务回归；nginx-sse 依赖 `infra/nginx/default.conf`，改反代配置后必跑（见 [nginx-and-reverse-proxy](../06-infra/nginx-and-reverse-proxy.md)）。
4. **自检类红**：只可能是对应 scripts 工具本身被改坏，直接对照被自检脚本的 diff。
5. 全部脚本头注都写明"为什么必须真机跑/为什么用 DB 级并发"等裁定依据，排查前先读头注，别按猜的语义改断言。
