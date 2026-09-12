# 第十三轮进度（2026-09-12）：多实例一致性收口 · 项目级角色 · 三处真实缺陷修复

> 本轮主线：把「单实例假设」与「代理层/并发层假设」逐条换成**真机可验证的事实**。
> 全部改动只增不减测试基线（admin-api 2296 → 2332），并新增两个真机验证入口。

## 1. 交付清单

| # | 主题 | 交付 | 证据 |
|---|---|---|---|
| 1 | **ARCH-31 多实例一致性（灰度批次）** | 心跳 hydration / 失败 claim / 并发批次互斥 / 活性租约 | 单测 +7；真机双实例 15/15 |
| 2 | **ARCH-31 真机双实例验证套件** | `scripts/arch31-multi-instance-selftest.mjs`（`npm run test:arch31-multi-instance`） | 本机 15/15 通过 |
| 3 | **AUTH-02 项目级角色细化** | `project_members` + 三档角色 + 成员 API + 写面/执行类写面放行 | 单测 +32；ADR-013 |
| 4 | **BUG-17 nginx SSE 长流验证** | `scripts/nginx-sse-selftest.mjs`（`npm run test:nginx-sse`） | 本机 19/19 通过 |
| 5 | **BUG-21 派发失败不发领域事件** | `publishTerminalEventForDispatch` + processor 改走统一出口 | 单测 +5 |
| 6 | **BUG-22 占坑版本 CAS 误伤良性并发** | 移除冗余 version 谓词 + 回归锁 | 压测复测 40%/65% → **100%** |
| 7 | **静默 CRUD 不进内存热路径** | `adoptPersistedSilence` / `forgetSilence` | 单测 +2 |
| 8 | **空库多实例种子竞态** | 23505 失败方跳过并继续启动 | 单测 +2 |
| 9 | **QA-05 四档容量验收** | 500 并发 / 1000 RPM / SSE 500 / 回调 10k 全部达成 + 服务端水位采样 | 见 §6 基线 |
| 10 | **outbox 快速路径收口** | 消除「每个成功事件必然重复投递」 | 单测 +9 |
| 11 | **回调限流提为可配** | `THROTTLE_CALLBACK_LIMIT`（默认 60 不变）+ 部署风险说明 | 压测实测 429 边界 |

## 2. ARCH-31：多实例一致性（矩阵第 5 项，🔴→🟡）

四条真实破坏路径逐条闭合（`docs/ARCH-MULTI-INSTANCE-MATRIX.md` 3.2/3.3/3.4 同步）：

1. **心跳 hydration**：非属主实例从 DB 行痕迹（`rolloutState IN (pending, probing)`）
   重建只读上下文 → 心跳不再被静默丢弃（此前批次只能靠 15min 硬超时收尾）。
2. **失败 claim**：`failBatch` 先条件 UPDATE 认领在途行，只有赢家执行自动回滚，
   杜绝两实例重复回滚。
3. **并发批次互斥**：canary 启动前查同应用在途灰度行 → 返回 `ok:false` +
   `blockedReason`（含持有者实例标识）。
4. **活性租约**：持有者每 tick 刷新 `leasedAt/leasedBy`；重启 sweep 跳过租约新鲜
   （60s）的行——滚动重启不再把另一实例正在推进的灰度标 failed。

**真机双实例验证（15/15）**：两个真实 admin-api 进程共享同一 PG16 + Redis7
（空库迁移链真跑）。核心断言：A 保存渠道配置 → **刷新前 B 仍是默认值**（实证了
改造前多实例必然失效）→ 一个读穿周期后 B 读到 A 的值；静默跨实例读面立即可见且
刷新不抖动；调度 Leader 恰一持有者。

## 3. AUTH-02：项目级角色（ADR-013）

- 角色：`viewer`（只读，执行类写面拒绝）/ `editor`（项目内读写 + trigger/pause/resume）
  / `admin`；全局 ADMIN 恒全量放行（项目角色是能力增量，不是第二套管理员）。
- **只增放行、不收紧**：迁移 1790000000015 不回填成员行 → 未配置成员关系时写面判定
  逐字节等价于改造前；唯一硬约束（viewer 拒绝执行类写面）只在显式配置后存在。
- 端点：`GET/POST/PATCH/DELETE /projects/:id/members`、`GET /projects/me/roles`；
  成员管理保持 ADMIN-only（避免嵌套提权链）。
- 保留缺口（需产品拍板）：非成员仍可 trigger/pause/resume 任意任务。

## 4. 三处真实缺陷（都由本轮真机验证/压测暴露）

| 缺陷 | 现象 | 根因 | 修复 |
|---|---|---|---|
| **BUG-21** 派发失败终态不发领域事件 | 执行器离线时执行直接失败，但 Dashboard 终态流、FEAT-07 出站 webhook、通知订阅者**三方全漏** | processor 派发失败分支直调通知，绕过 ARCH-21 的事件出口 | 终态落库成功后调 `publishTerminalEventForDispatch`，通知回归订阅者统一发出 |
| **BUG-22** 占坑版本 CAS 误伤良性并发 | 单执行器并发触发成功率 40%/65%，失败全是 `…concurrency conflict` | 占坑 UPDATE 带 `version = :version`；并发首个成功即让其余全部 affected=0 | 移除冗余版本谓词（容量/在线不变量由同条 WHERE 原子保证）→ 容量放开后 **100%** |
| **静默 CRUD 不进内存热路径** | 管理台新建静默**不生效**，要等进程重启 | `POST/GET/DELETE /notification/silences` 只写 DB，`isSilenced` 读的是进程内 Map | create → `adoptPersistedSilence`；delete → `forgetSilence` + 删库双删 |
| **空库多实例种子竞态** | 全新环境同时拉起两个副本，第二个**启动崩溃** | 两实例都看到 `count=0` → 都 INSERT 种子管理员 → 输家吞 23505 未捕获 | 输家复核「已有用户」后跳过（幂等引导），非唯一冲突异常照旧上抛 |

## 5. 工程陷阱（顺带修掉）

`nest build` 配了 `deleteOutDir=true`，在带批量删除保护的环境里清理 dist 会被拦 →
构建**静默失败（退出码 0 但 dist 未刷新）**，压测/e2e 脚本随后用**旧产物**跑
（现象：改了代码，结果完全不变；本轮实测踩到一次，浪费一整轮复测）。
`scripts/load-test-stack.sh` 与 `scripts/e2e-full.sh` 已追加
`npx tsc -p tsconfig.build.json` 兜底刷新产物。

## 6. 基线

- admin-api **2332/2332**（2296 → 2332，只增）· tsc/eslint 0 error
- admin-web 651/651 · tsc 0 error（openapi + api-types 已重导出，无 drift）
- **e2e-full 46 passed / 1 skipped**（唯一 skip = 默认关闭的私服场景 44）
- 真机套件：ARCH-31 双实例 15/15 · nginx SSE 19/19
- 压测（QA-05 四档全部达成 + 服务端水位）：tasks 500@500 **500/500**（p50/p95 21/26ms）·
  2000@300 **1321 任务/分钟**（超 1000 RPM 目标 32%）· SSE 500 连接 **500/500**·
  回调 **73189 条/分钟**（1000 真实 RUNNING 执行池，DB 核对 1000 条终态）；
  admin-api 500 并发档**峰值 RSS 403MB / 平均 CPU 6.59%**（单核）

## 7. 未完成（如实）

- **ARCH-31**：outbox 行级 claim（`FOR UPDATE SKIP LOCKED`）；真机双实例清单第 3 项
  （心跳落非属主实例的真实灰度推进，需执行器 + 可达 git 源）。
- **QA-05 / BUG-19**：500 并发 / 1000 RPM / SSE 500 连接 / 回调 10k 四档目标验收、
  服务端 Prometheus 水位采集、容量白皮书定稿。
- **BUG-17**：24h 档（`NGINX_SOAK_SECONDS=86400`）留目标环境作为上线门禁。
- **AUTH-02 后续**：项目列表按成员过滤（读面仍全员可见）、项目内 executor/package
  角色细分、admin-web 权限门控 UI。
- **需真机/外部条件**：DSK-01（macOS 打包）、BUG-07（Windows detached 信号）、
  AUTH-04（OIDC SSO，可选）、BUG-04（minio 上游）。

## 8. 本轮踩到并固化的工程教训（供后续会话省时间）

1. **`nest build` 在该环境下静默失败**（`deleteOutDir=true` 的 dist 清理被批量删除
   保护拦下，退出码仍为 0）→ 编排脚本会拿**旧产物**跑。已在 `load-test-stack.sh` /
   `e2e-full.sh` 追加 `npx tsc -p tsconfig.build.json` 兜底；自建验证脚本一律直接用 tsc。
2. **子进程清理必须对进程组下手**：admin-api 优雅关停最长 15s，父进程直接退出会留
   孤儿进程占端口（实测污染下一次运行）。三个真机脚本统一改为 `detached` +
   进程组 SIGTERM→SIGKILL，并在 `summary()` 末尾 **显式 `process.exit()`**
   （事件循环里有 http server/管道句柄，只设 `exitCode` 可能不退出——曾出现脚本
   挂 5h 连带子进程占端口）。
3. **端口随机化**：验证脚本默认在 15000-25000 随机取端口，并在开跑前自愈清理
   同名残留容器，避免「上一次跑崩留下的容器占端口」。
4. **admin-web 全量 vitest 在有重负载并行时会假失败**：本轮 4 个文件 7 例
   `Test timed out in 5000ms`，单独重跑**全绿**（机器同时跑着压测栈）。判定：
   资源竞争型超时，不是代码回归——重跑对照后再下结论。
5. **回调限流按 IP 计**（见 QA-05 §8.2.1）：压测 429 不是「客户端太猛」，而是
   服务端设计边界；生产多执行器同出口 IP 时需显式调 `THROTTLE_CALLBACK_LIMIT`。
