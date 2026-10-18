# VERIFY-round11 DEP-04 审批全链（P0-2 收尾，2026-09-11）

> P0-2 目标：DEP-04「部署审批」真机收尾——双人第二人规则全链 + approve→真机派发 + reject/cancel 各一例 + 并发双审批 409。**滚动结论：本机（用户授权 ubuntu，真实 PG16+Redis7+admin-api+executor-node+vite+chromium）全链闭环，新增正向用例 36 补齐旧有 30~35 的失败路径偏置；生产形态（物理双人账号/反代/持久化）留部署轮。**

## 环境

- 拓扑：单 admin-api(:3105) + 单 executor-node(:8002 在线) + PG16 + Redis7 + admin-web vite(:5176) + chromium（`bash scripts/e2e-full.sh` 同栈）
- commit：e2e 用例 36（见下）随 develop 本轮提交
- 平台：Linux x86_64（ubuntu）

## 场景与断言（e2e-full.spec.js security-redline-approval describe）

| # | 场景 | 断言 | 结果 |
|---|---|---|---|
| 30 | approvalRequired 应用 deploy → 冻结 | 201 + approvalStatus=pending_approval + status=pending（零派发）；重复 deploy 409（in-flight 槽位仍持有） | ✅（既有，本栈复跑） |
| 31 | 第二人规则（提交者自批） | 提交者本人 approve → 403；行保持 pending_approval | ✅（既有） |
| 32 | 并发双审批 | 双路 approve 恰一 201 一 409；终态 approved | ✅（既有——原子认领 UPDATE WHERE） |
| 33 | reject 语义 | 非提交者 reject → 201 + rejected/failed；槽位释放可再次提交 | ✅（既有） |
| 34 | cancel 语义 | 他人 cancel 403；提交者 cancel 200 → cancelled/failed | ✅（既有） |
| 35 | 审批 RBAC | 普通用户 403 / 无 token 401 全三动作 + pending-inbox | ✅（既有） |
| **36（新增）** | **第二人 approve → 真机派发** | 冻结行 status=pending + approvalStatus=pending_approval（零派发）；B approve → 201 + approved + approvalMeta.actedByName=第二人；**30s 内行离开 pending（进入 deploying/running/failed 任一 = 部署链真实触发）** | ✅ **44/44 全清单例复跑 1.7m 通过** |

## 本机全链总账

`bash scripts/e2e-full.sh e2e-full.spec.js` → **44 passed（1.7m）**（原 43 + 新 36）。

## 新发现（真机/全链才暴露）

- 无。既有 30~35 断言在补正向用例前已覆盖失败/并发路径；本次新增正向用例未发现新缺陷。
- 说明：用例 36 断言「行离开 pending 进入部署链」而非「executor 跑到 RUNNING」——后者的前提是应用带可达 git 源 + 写面放行本地 fixture，属部署轮范畴；审批语义的正向闭环（冻结→批准→真实派发触发）已由本用例钉死。

## 临时放行回看

- 无临时放行。e2e 栈沿用 e2e-full.sh 既有测试专用配置（限流放大等，见脚本头注记，非生产）。

## 归属

- P0-2 状态：**done（本机全链）**；生产形态留验项见 PLAN-CLAIMS P0-2 行备注（物理双人账号第二人全链、反代后派发）。