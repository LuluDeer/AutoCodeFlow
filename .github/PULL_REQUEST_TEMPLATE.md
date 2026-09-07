<!--
  提交前请通读下方检查清单并勾选。清单的价值在于强制核对——
  历史上多次出现「端点已合入、docs/api-reference.md 忘更」的文档滞后
  （历轮 N37 等），勾选项即防线。不适用的小节整段保留、勾「否」即可，
  不要删除—— reviewer 需要「看过并裁定不适用」的证据。
-->

## 变更说明

<!-- 一两句话说清本 PR 做了什么、为什么（关联任务号/issue，如 CORE-05 / BUG-01）。 -->

## 自测证据

<!-- 贴测试数字与命令输出摘要，例如：admin-api 1819/1819 · admin-web 286/286 · tsc 绿。 -->

## API 变更？（DOC-01 检查项，必须逐项勾选）

- [ ] **新增/修改端点？** → 若是：必须在本 PR 内列明端点（方法 + 路径），
      并同步更新 `docs/api-reference.md`（写明更新位置/章节）。
      例外：纯内部端点（无外部消费方）请注明豁免理由。
- [ ] **Breaking 变更？**（删字段/改语义/改状态码/收紧鉴权）→ 若是：必须列影响面，
      并说明四个客户端包是否需同批适配：`acf-cli` / `mcp-server` /
      `autocodeflow-node-sdk` / `autoflow-sdk`（python）。
      参考先例：RBAC 收紧前后端同批发布（W2）、DR-04 撤销语义。
- [ ] **新增环境变量？** → 若是：必须三处同批登记——
      `apps/admin-api/src/config/configuration.ts`（+ app.module Joi 校验）、
      `.env.example`、`docs/`（api-reference 环境变量表或 deployment/operations 对应表）。
      历轮教训：漏登记 = 死配置（W-22 前科）。
- [ ] **新增数据库迁移？** → 若是：填写迁移时间戳 `____________`
      （须与 `apps/admin-api/src/migrations/` 文件名一致；多会话并行时先查
      `docs/PLAN-CLAIMS.md` 认领板确认时间戳未被占用）。

## 平台影响？（执行器/桌面端同 commit 纪律）

- [ ] **改动了 executor-node / executor-python / executor-desktop？** → 若是：
      executor-node 改动必须与重打的 `bundle` 同一 commit 提交（ADR 纪律），
      Windows 相关行为变更请对照 `docs/VERIFY-MATRIX.md` 补真机项。
- [ ] **改动了公共包（packages/*）？** → 若是：跑受影响包的测试并在自测证据里给出数字。

## 交付纪律

- [ ] 测试只增不减（基线见 `AGENT_HANDOFF.md` 状态快照）；
- [ ] `PLAN-CLAIMS.md` 认领状态已同步（in_progress → done + commit hash）；
- [ ] 中文 conventional commits，`git log --stat` 核对无他人文件误带入。
