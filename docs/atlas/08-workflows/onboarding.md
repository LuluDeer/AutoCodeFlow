# 新人上手路径（第 1 小时 / 第 1 天 / 第 1 周）

> 所属: docs/atlas/08-workflows · 最后核对: 2026-09-13 · 对应代码: docs/atlas/（全部）、docs/quickstart.md、AGENT_HANDOFF.md

所有链接都指向 atlas 树内真实存在的文档；docs/ 根文档用仓库名给出。按顺序走，不必跳读。

## 第 1 小时：知道这是什么项目

1. 读仓库根 `README.md` 与 `docs/quickstart.md`——项目一句话与快速起跑。
2. 读 [../00-overview/01-product-overview.md](../00-overview/01-product-overview.md)——产品定位、能力地图、术语表。
3. 读 [../00-overview/02-system-architecture.md](../00-overview/02-system-architecture.md)——总体架构与数据流。
4. 读 [README.md](../README.md) 的「文档树总览」+「推荐阅读路线」——知道整棵树长什么样、以后去哪查。

产出自检：能用自己的话讲清"管理台建任务 → Cron/手动触发 → 执行器跑脚本 → 回收日志产物"这条主线。

## 第 1 天：概念闭环 + 环境跑起来

1. 读 [../00-overview/05-core-concepts.md](../00-overview/05-core-concepts.md)——Task/Execution/Executor 等领域核心概念。
2. 读 [../00-overview/03-repo-layout.md](../00-overview/03-repo-layout.md) 与 [../00-overview/04-tech-stack.md](../00-overview/04-tech-stack.md)——目录职责与技术栈。
3. **把环境起起来**：按 `docs/quickstart.md` / 仓库根 `docker-compose.yml` 启动栈；后端单跑用 `cd apps/admin-api && npm run start:dev`，前端 `cd apps/admin-web && npm run dev`。
4. 读 [../04-flows/task-lifecycle.md](../04-flows/task-lifecycle.md)——任务从创建到执行完成的全链路（最能串起所有组件的一篇）。
5. 在管理台里：登录 → 建一个任务 → 手动触发 → 看执行详情与日志。对照 [../04-flows/execution-callback.md](../04-flows/execution-callback.md) 理解日志/产物怎么回来的。
6. 读 [../07-testing/README.md](../07-testing/README.md)——知道各端测试怎么跑（根目录 `npm run test:api` / `test:web` / `test:python` 等脚本）。

产出自检：本地栈健康（`curl http://localhost:3105/health`），能完整跑通一次任务执行。

## 第 1 周：选定方向 + 领第一个任务

1. **选定地盘**，精读对应子树（按 [task-board/README.md](task-board/README.md) 第二节的"分工边界表"）：
   - 后端 → [../01-apps/admin-api/README.md](../01-apps/admin-api/README.md) + 你要改的 `modules/<模块>.md`
   - 前端 → [../01-apps/admin-web/README.md](../01-apps/admin-web/README.md) + `api-layer.md` / `routing-and-auth.md`
   - 执行器 → [../01-apps/executors-comparison.md](../01-apps/executors-comparison.md) + 对应执行器篇
   - 生态包 → [../02-packages/README.md](../02-packages/README.md) + 对应包篇
2. **过一遍流程文档**：数据层 [../03-data/README.md](../03-data/README.md)（改表结构前必读）+ [../05-interfaces/README.md](../05-interfaces/README.md)（对外接口地图）。
3. **领任务**：读 `docs/PLAN-CLAIMS.md` 文件头规则与 [task-board/README.md](task-board/README.md)，从 `unclaimed` 行认领第一个任务（当前遗留见 [troubleshooting/known-issues.md](troubleshooting/known-issues.md)），建卡用 [task-board/TEMPLATE.md](task-board/TEMPLATE.md)。
4. **照手册做**：后端任务走 [add-new-api-module.md](add-new-api-module.md)，前端任务走 [add-new-web-page.md](add-new-web-page.md)，SDK 任务走 [add-new-sdk-capability.md](add-new-sdk-capability.md)。
5. **知道发布怎么走**：通读 [release-process.md](release-process.md)（不必实操，知道 tag → version-guard → 审批闸 → npm/PyPI 的链路即可）。
6. **排障姿势**：遇到环境/时序问题，先查 [../07-testing/README.md](../07-testing/README.md) 与 `docs/` 根既有 VERIFY 文档；解决后按 [troubleshooting/README.md](troubleshooting/README.md) 沉淀。

产出自检：第一个任务 `done` 上板（状态 + commit hash + `AGENT_HANDOFF.md` 快照），且你改动过的模块在 atlas 里的文档"最后核对"日期被你刷新过。

## 三条贯穿性纪律（从第一天起遵守）

- **认领板是唯一防撞车事实源**：开工前 `git pull --rebase` + `git status`，未提交改动勿动。
- **测试只增不减**：所有回归全绿才收工（见 [../07-testing/testing-conventions.md](../07-testing/testing-conventions.md)）。
- **文档与代码同批**：改了模块行为，同 commit 更新 atlas 对应篇目（[README.md](../README.md) 维护规则第 2 条）。

## 常见首周疑问速答

| 疑问 | 去哪找答案 |
|---|---|
| 这个 env 变量是干嘛的 | [../06-infra/env-vars.md](../06-infra/env-vars.md)，源头在 `apps/admin-api/src/app.module.ts` 的 Joi schema |
| 这张表/字段是谁的 | [../03-data/README.md](../03-data/README.md) 与 `entities/` 逐表篇目 |
| 端点/CLI/MCP 工具有哪些 | [../05-interfaces/README.md](../05-interfaces/README.md) 分篇 |
| 部署与 CI 长什么样 | [../06-infra/deployment-and-ci.md](../06-infra/deployment-and-ci.md) |
| 排错从哪下手 | [../07-testing/README.md](../07-testing/README.md) + `docs/` 根 VERIFY 文档，沉淀规则见 [troubleshooting/README.md](troubleshooting/README.md) |
| 发版/上线怎么走 | [release-process.md](release-process.md) + 仓库根 `docs/release-checklist.md` |
| 我改的模块还有谁在改 | `docs/PLAN-CLAIMS.md` 认领板的"文件足迹"列（[task-board/README.md](task-board/README.md)） |
| 私有 npm/PyPI 仓库是怎么回事 | [../01-apps/registry-npm.md](../01-apps/registry-npm.md) 与 [../01-apps/registry-pypi/README.md](../01-apps/registry-pypi/README.md) |
| 任务怎么从创建到派发到执行器 | [../04-flows/task-lifecycle.md](../04-flows/task-lifecycle.md)（主链）+ [../04-flows/executor-registration.md](../04-flows/executor-registration.md)（执行器身份） |
