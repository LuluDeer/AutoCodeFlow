# 混沌演练报告（QA-06 / 故障注入）

> 日期：2026-09-12　|　工具：`scripts/chaos-drill.sh`（四场景 A/B/C/D）
> 目的：在真实 docker 拓扑上跑故障注入，验证 fail-open / 判离线 / Leader 接管等
> 韧性语义（operations.md「混沌演练」章节的落地证据）。

## 0. 运行环境与镜像来源（重要，先读）

| 项 | 值 |
|---|---|
| 拓扑 | 隔离 compose 工程 `acfchaos`（项目名隔离，避免碰已有容器）：`postgres` + `redis` + `admin-api` + `executor-node`，使用仓库根 `docker-compose.yml` |
| 镜像来源 | **缓存的 R5 镜像** `acf-r5-admin-api:latest` / `acf-r5-executor-node:latest`（commit `9bee15d`，2026-09-02）|
| 为何不是当前 HEAD | 本环境 `docker compose build` 的 `npm ci` 阶段 `ECONNRESET`（构建上下文内 npm registry 不可达），无法从当前源码构建镜像；改用仓库内唯一可用的预构建镜像 |
| admin-api 状态 | `onlineExecutors:1`（executor 正常注册/心跳），DB/Redis/Queue 组件 healthy；`migrationsRun` 在 `NODE_ENV=production` 下自动跑通 |
| 凭据 | 独立 `.env.chaos`（强密码 + 非 localhost CORS），与现有 `.env` 互不干扰 |

> ⚠️ **结论的适用范围**：本报告的「真机跑通」针对 R5 镜像；其中与 Redis 客户端相关的
> 行为受 R5 镜像已知缺陷影响（见 §2），**不代表当前 develop 源码行为**。当前源码的
> 韧性语义以源码核实为准（§3）。

## 1. 关键发现 ①：chaos-drill.sh 自身有「失败被静默吞掉」的严重缺陷（已修）

**现象**：脚本以 `scenario_${s}_body 2>&1 | tee -a "$slog"` 运行场景体——管道把体放进
**子 shell**，于是 `fail_scenario` 对 `FAILED` / `SCENARIO_FAILED` 的改动随子 shell 退出
而丢失，`run_scenario` 永远走 `SCENARIO_FAILED==0` 分支 → **任何失败都被报成通过**。

**复现（修复前）**：场景 A 的 A1 断言明明失败（见下），结尾却打印：
```
✗ 场景 A 失败：A1 Redis 停机 30s 内 /api/health 无一次 200
...
══ 混沌演练结束：通过 1 / 失败 0 / 跳过 0 ══
```
一个验证工具「自己测不出自己的失败」比没有工具更危险。

**修复**：改用进程替换 `> >(tee -a "$slog") 2> >(tee -a "$slog" >&2)`，场景体仍在
**当前 shell** 执行（变量改动可见），同时 stdout+stderr 都落日志。

**修复后验证（双向）**：
- 场景 B 真实通过 → 正确 `通过 1 / 失败 0`；
- 场景 A（R5 镜像下 A1 失败）→ 正确 `通过 0 / 失败 1`。
两方向计数一致，缺陷消除。该修复已提交。

## 2. 关键发现 ②：R5 镜像的 Redis 客户端是坏的（影响场景 A 的解释）

admin-api 启动即报错：
```
WARN SchedulerService Leader election unavailable
  (Cannot read properties of undefined (reading 'set')); degrading to leader
```
且 `/api/health` 的 redis 组件始终 `unhealthy / "Socket already opened"`（Redis 重启后
也连不上）。即 R5 镜像的 Redis 客户端初始化有问题。

**后果**：场景 A 注入 `docker stop redis` 后，`/api/health` 在 30s 观察窗内**零次 200**
（admin-api 卡在坏客户端上）——A1 断言在 R5 下失败。但这**不是当前源码的 fail-open
语义问题**，见 §3。

## 3. 场景结果与当前源码核实

| 场景 | 本环境结果 | 当前 develop 源码核实 | 结论 |
|---|---|---|---|
| **A** Redis 宕机 | R5 下 A1 失败（§2 的客户端缺陷所致） | `health.controller.health()` 直接 `return healthService.getFullHealth()`，无任何 `HttpStatus`/`statusCode` 覆盖 → **永远 HTTP 200**，仅 `status` 字段在 `healthy/degraded/unhealthy` 间变化（已读 `health.controller.ts` + `health.service.ts` 确认） | 设计意图（fail-open 保活 200）在源码成立；R5 的 A1 失败是镜像缺陷，非当前回归 |
| **B** 执行器断网 | **✓ 通过（干净）**：B1 在 70s 内观测到判离线（onlineExecutors 1→0）；B2 恢复后 10s 内 online 回归（0→1） | `markStaleOffline` 每 30s 扫描，cutoff = 心跳 30s × 乘数 3 = 90s（与脚本窗口 `阈值+扫描+缓冲=150s` 一致） | **真实跑通**：执行器离线判定 + 恢复正确，不依赖坏掉的 Redis 客户端（心跳走 DB/内存态） |
| **C** 双实例滚动重启 | 未跑 | 需第二个 admin-api 实例（compose `admin-api` 固定 `3105:3105`，`--scale` 端口冲突，须手工起第二实例 + `CHAOS_ADMIN2_CONTAINER`） | 已知边界（operations.md 已注明）；待双实例拓扑补充 |
| **D** PG 主从切换 | 跳过（本机单主无 replica） | 脚本仅保留 TODO 骨架 | 需真机主从拓扑 |

**判读**：场景 B 是本次最干净、最有价值的真实证据——执行器断网后的「判离线 + 恢复」
行为在数据面正确（与实现常量严格对齐）。场景 A 的真实语义需在当前镜像上重跑（见 §4）。

## 4. 在当前源码上做「确定性」混沌演练的步骤

本环境限制（构建期 npm registry 不可达）下做不到；在可构建环境：

```bash
# 1) 正常构建（需 npm registry 可达）
docker compose build admin-api executor-node
# 2) 起栈（含双实例以覆盖场景 C）
docker compose up -d postgres redis admin-api executor-node
# 3) 全场景（D 自动跳过）
bash scripts/chaos-drill.sh
# 4) 场景 C（双实例）：另起第二实例后
docker run -d --name admin-api-2 -p 3106:3105 \
  -e DB_HOST=postgres -e REDIS_HOST=redis ... <admin-api-image>
CHAOS_ADMIN2_CONTAINER=admin-api-2 bash scripts/chaos-drill.sh --scenario C
# 5) 纯函数自检（无 docker 也能跑，33 例）
bash scripts/chaos-drill.selftest.sh
```

修复后的脚本现已能正确区分通过与失败，可作为 CI/巡检门禁；建议把上述全场景
（尤其场景 A 在当前镜像上）纳入发布前演练。

## 5. 行动项

- [x] 修 chaos-drill.sh 子 shell 吞失败缺陷（已提交）
- [ ] 在可构建环境用**当前镜像**重跑场景 A（预期通过：health 200-with-degraded）
- [ ] 补场景 C 双实例真机验证（脚本已支持，缺拓扑）
- [ ] 待真机 PG 主从拓扑补场景 D（脚本已留骨架）
- [ ] （可选）R5 镜像的 Redis 客户端 `undefined.set` 缺陷若在当前源码已修复，建议在
      迁移说明/发布注记里确认；本环境无法构建故未独立验证
