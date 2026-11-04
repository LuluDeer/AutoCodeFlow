# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `955c6829` · 工作区干净 · 换轴第一轮（真机并发）已完成
**会话**：第 12 轮已收 · 11 轮产出（R01–R11，30 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（每单元一提交、实验后清容器，已生效）

## R11 结论（完成，口径重要）
- **真机 10 轮 × 4 场景：历史担心的「接管 CAS 竞态」复现 0 次**（I1–I4 全成立，exit 0）。**台账不写「竞态不存在」，只写「真机未触发」** —— 时序极窄，10 轮绿不等于没有。
- **本轮真修掉的是相邻的跨写窗口**：`register()` 的**指纹命中**写路径（`executor.service.ts:2974` 起）尾部 `repo.update({id})` **无谓词**，而并发接管在 `:2961` 用 `update({id, status: OFFLINE})` CAS 打同一行 ⇒ 接管先提交、回归方旧快照后落库会把 `deviceFingerprint`/`executorStartupId` 改回旧安装 ⇒ **回归方 2xx 静默覆盖、接管方令牌失效（401 死循环）**。修法：指纹谓词 CAS + 409 收口（`EXECUTOR_ADDRESS_TAKEN`）。
- **判据红→绿（代码层确定性）**：注入式用例「判定之后、尾部 update 之前」插入一次并发接管 —— 未修：register 成功返回且行身份被改回旧指纹 **exit 1** → 修后：**409 且行身份保持并发赢家 exit 0**；定向 **521/521**；真机用例 **10 轮×4 场景 13/13**（第 6 轮出现 409/201 反向次序 ⇒ **并发交错真实发生**）。
- 回归：`typecheck` 0 · `guards:repo`(86) 0 · `docs` 0 · `size-caps` 0（why 已写）· 容器清理 `acf-r11` 残留 0。
- 提交：`b66643b9`（核心 7 文件）+ `955c6829`（台账）。
- ⚠ 未核实观察：`docker ps -q` 现显示 **10 个运行中容器**（非本轮 `acf-r11`；疑为其他栈，未动）。**下轮开工前请确认不是遗留污染**。

## 未收口（按优先级）
1. **运行时并发轴继续（§7.10 P1）**：本轮只覆盖「注册」一轴。下一候选 `issueToken` 幂等签发（`(address,startupId)` 复用）或 `rolloutBatchClaimId` 唯一索引 CAS 的真机并发。
2. **真机用例 `test:executor-register-race` 不在离线链**（需 docker）⇒ 建议进 `test:guards:selftests` + CI service container（否则又会腐烂成「没人跑的门禁」）。
3. 该窗口的**更强保证**需人为 DB 延迟或乐观锁版本列（后者要 ADR + 迁移，暂不做）。
4. `check:desktop-bundle-drift` 字节哈希待 CI；executor-node `.env` 约束（§7.4）；守卫框架 meta 改造（§7.2）；`UPGRADING.md` 头部基线。
5. §7.9 P2：SSRF 矩阵扩到闸层（非紧急）。

## 下轮第一步（R12）
1. `git log -1 --oneline` 确认 `955c6829`（**自己跑**）＋ `docker ps` 确认那 10 个容器不是本项目残留（若是，先取证再清理，别误删别人的）；
2. 立项 **`token-issue-idempotency`（真机并发第二轴）**：`issueToken` 的 `(address, startupId)` 复用路径，判据 = 并发 N 次签发同一 `(address,startupId)` 断言「至多一枚有效令牌 / 旧令牌被明确吊销 / 不出现两枚同时可用」；先写注入式确定性判据（可红）再真机压测；
3. 同批把 `test:executor-register-race`（与新增真机用例）接进 `test:guards:selftests` + CI service container，避免真机用例腐烂。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 7 次。
- **只信命令 + 真实 exit code**；回执会错归因（R01→R02）、我会错摘要（㊱）、别编 sha（㊲）、**未复现不许写成已验证**（R11 做对了）。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
