# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `b58b5e9a` · 工作区干净 · 真机并发轴第 3 轮（ADR 级）
**会话**：第 14 轮已收 · 13 轮产出（R01–R13，36 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（ADR 先于代码、降级如实报、不伪造证据文件，均已生效）

## R13 结论（**ADR + 降级结项**，这是本轮的正确形态）
- **ADR-030**（`docs/adr/adr-030-executor-token-cross-instance-idempotency.md`）：三方案对比后选 **②′ = 确定性派生 `HMAC(K, identity‖startupEpoch‖rotationEpoch)` + `tokenRotationEpoch` 列 CAS**。
  - ① Redis 明文缓存**否决**：挂了就**静默**退回 R12 已确诊的双轮换；且凭据明文进中间件（RDB/AOF/备份/`MONITOR` 可读）⇒ 攻破即得回调签名能力。
  - ② 原始「只存 hash + 唯一键」**走不通**：bcrypt 单向 ⇒ 失败方拿不回明文；退 409 再轮换会把赢家打死、退哈希立即 401 ⇒ 精化 ②′ 让「同输入同输出」，失败方重算同一枚再 bcrypt 复核。
  - ③ 单写者 lease **否决**：不解决明文问题，且与 R03 灰度租约、R11 接管 CAS 语义互撞。
- **本轮只交付**：ADR（独立提交 `9fb6d33a`，先于任何代码）+ 运行期**症状告警**（`2e67970c`，仅对 `foreign-rotation` 打 WARN、每身份每 TTL 去重、**行为零改变**）+ 台账 `b58b5e9a`。
- **为什么不在一轮内落地**（ADR §7.1）：改的是**凭据派生**，`rotateToken` 有 6 个调用点 + 管理台轮换面，还需迁移 + 混跑发布编排 + 两实例真机验证 ⇒ 单轮做完风险高于收益。
- 判据：`token-issue-serializer` spec **10/10**（含 `stale-own-rotation` 与 legacy **两态不误报**的反向判据）；回归 531/531 · `typecheck` 0 · `guards:repo`(87) 0 · `docs` 0 · `size-caps` 0（4288→4314，why 写明落地后回落）· `migrations` 0 · `race-wired` 0。
- **诚实边界**：本轮无运行时改动、**未起容器**，`cross-instance-proof.log` 不存在（不伪造）—— 两实例 N≥10 轮属落地轮验收。

## 方法论沉淀
㊳ **ADR 让「不做」变成合法结项**：不落地 ②′ 时，交付物是「决策 + 回滚路径 + 失效半径 + 过渡检测」，而不是「这轮没做完」。比硬上一半代码强得多 —— 尤其当改动面是凭据派生这种**错了就全机队 401**的地方。

## 未收口（按优先级）
1. **落地 ②′**（ADR §5.2 / §6）：迁移 `1790000000097-AddExecutorTokenRotationEpoch`（up+down、metadata-only 零回填、不建索引、`check:migrations`）→ 派生 + CAS（`EXECUTOR_TOKEN_EPOCH_MODE` **默认 `off`**）→ **两实例 N≥10 轮**真机 → 用例接进 `check:race-selftests-wired`。
2. **派生密钥轮换语义未定**（§7.12 P2）：换 `EXECUTOR_TOKEN_DERIVATION_SECRET` = **全机队令牌失效**，需运维手册段 + 启动告警。
3. 真机并发仍缺 3 轴（心跳 `runningTaskCount` 覆盖写 / `rolloutBatchClaimId` CAS / `agent_approvals` consume）。
4. `check:desktop-bundle-drift` 字节哈希待 CI；executor-node `.env` 约束（§7.4）；守卫框架 meta 改造（§7.2）；`UPGRADING.md` 头部基线。

## 下轮第一步（R14 = 落地 ②′）
1. `git log -1 --oneline` 确认 `b58b5e9a`（**自己跑**）；
2. 按 ADR-030 §5.2 顺序：**迁移先落**（含 down 脚本，`check:migrations` 必须 0）→ 派生 + `tokenRotationEpoch` CAS（默认 `off`，保留旧路径可回退）→ `EXECUTOR_TOKEN_EPOCH_MODE` 门控 → 两实例真机 N≥10 → 接链守卫；
3. 判据：确定性用例先红后绿 **+** 两实例真机 I1/I2/I3 逐轮成立；混跑「新×旧实例」行为必须与 ADR §灰度 一致（不幂等但不打死令牌）；
4. 若迁移或混跑出现不可控风险 → **回滚到 `b58b5e9a` 并如实报「未落地」**，不要硬推。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因（R01→R02）、我会错摘要（㊱）、别编 sha（㊲）、未复现如实写（R11/R12/R13 做对了）、**证据文件不存在就说不存在**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
