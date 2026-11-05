# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `ed876e75` · 工作区干净 · 派生密钥运维债已收口
**会话**：第 16 轮已收 · 15 轮产出（R01–R15，44 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（每件一提交、先取证后写文档、会主动推翻错误假设，均生效）

## ⚠ 事实修正（推翻我 R13/R14 的说法，以 R15 实测为准）
**换 `EXECUTOR_TOKEN_DERIVATION_SECRET` 不会吊销已签发令牌。** 校验只走 `bcrypt.compare(出示值, 行上 tokenHash)`
（`executor-credentials.collaborator.ts:209/245/297`），**从不重新派生**。实测：K1≠K2 派生值不同，但**旧令牌仍校验 true**、新派生令牌反而 false。ADR-030 已新增 **§5.5** 记录（先改 ADR 再改文档，证据 `runbook-evidence.md`）。
⇒ 旧状态卡与 R13 回执里「换密钥 = 全机队立即失效」**是错的，已作废**。

## R15 结论（完成）
- **手册**：`docs/operations.md`「轮换 per-executor 令牌派生密钥」+ `UPGRADING §14` 交叉引用；三要素齐全（语义/流程：灰度一台→观察→全量逐个重启→回退/失效半径表 + 「不要在业务高峰做」）。**回退：能，且无需迁移**（写回旧密钥即恢复实例间一致性；已发生的轮换不可逆，执行器自愈、无数据丢失）。
- **启动告警**：`token-derivation-posture.ts` + `main.ts:70` 接线（R06 形状：模块顶层纯函数，bootstrap 只调一次）。触发 = `EXECUTOR_TOKEN_EPOCH_MODE=on` 且（两键都空 ⇒ 报「缺失，取令牌会 500」／回落共享口令 ⇒ 报「违反凭据分层」）。
- **机读守卫**：新增 `check:ops-runbook`（6 条反向用例）+ 接进 `guards:repo`(**88 段**) 与 CI。反向验证在**真实仓库**做过两次：删「失效半径」⇒ **exit 1 点名缺什么**；删 `main.ts` 接线 ⇒ **exit 1 报「存在≠被执行」**；还原 ⇒ exit 0。
- 回归：`docs` 0 · `guards:repo`(88) 0 · `size-caps` 0（main.ts 281→284，why 含回落值）· `typecheck` 0 · 定向 25/25 · `guards-wired` 0（78 个 check-* 全被 CI 执行）；真机 `unverified`（纯文档 + 启动期纯函数 + 静态守卫，无运行时变更/无迁移；唯一「真机性」动作是 bcrypt/派生实测并附输出）。
- 提交：`d3768140`(手册→ADR 修正→文档) + `ad9cfb87`(告警) + `798eb0d7`(守卫+接链) + `ed876e75`(台账)。

## 未收口（按优先级）
1. **`EXECUTOR_TOKEN_EPOCH_MODE=on` 仍是运维动作**（代码默认 `off`），手册步骤已就绪，**待人类/运维执行**。
2. **手册两个观察项无法机读**（`foreign-rotation` 告警频率、执行器 401 率目前只能看日志）⇒ §7.14 P2：做成**只读指标**（按 `tokenRotationEpoch` 分布 + 按地址聚合的 401 计数），把「观察」步骤换成看板。
3. 真机并发仍缺 3 轴（心跳 `runningTaskCount` 覆盖写 vs 派发占坑 / `rolloutBatchClaimId` CAS / `agent_approvals` consume）。
4. `check:desktop-bundle-drift` 字节哈希待 CI；executor-node `.env` 约束（§7.4）；守卫框架 meta 改造（§7.2）；`UPGRADING.md` 头部基线。

## 下轮第一步（R16）
1. `git log -1 --oneline` 确认 `ed876e75`（**自己跑**）；
2. **两条路二选一**（建议 B，理由：A 是纯增量可观测性，B 是仍未验证的正确性风险）：
   - A. `rotation-observability`：按 §7.14 P2 做只读指标（epoch 分布 + 401 计数按地址聚合），判据 = 指标接口/导出有单测 + 手册「观察」步骤改成引用该指标；
   - **B. `heartbeat-vs-dispatch`（真机并发第 3 轴）**：心跳 `runningTaskCount` 覆盖写 vs 派发占坑的一致性 —— 这是「统计数字与真实占坑不一致」类缺陷的温床，判据 = 并发 N 轮断言「心跳不会把已占坑数改小/改大」，先注入式确定性用例再真机。
3. 无论选哪条，**先写四要素 brief 再动手**。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因（R01→R02）、我会错摘要（㊱）、别编 sha（㊲）、未复现如实写、**ADR 里的事实也会错（R15 已证）—— 写文档前先取证**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
