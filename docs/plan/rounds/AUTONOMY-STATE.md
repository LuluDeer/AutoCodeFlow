# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `77212b78` · 工作区干净 · 真机并发轴第 2 轮完成
**会话**：第 13 轮已收 · 12 轮产出（R01–R12，33 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（A/B 分开提交、实验后清容器、未复现如实写，均已生效）

## R12 结论（完成）—— 幂等在并发下完全失效（真机复现）
- **缺陷**：`issueToken` 用「**同步读**进程内缓存 → 命中才复用 → 否则 await `rotateToken`」⇒ 并发请求都能在写入前读到 miss，**各自轮换**（`executor.service.ts:6635`）。真机 4 并发 **6/6 轮都是 4 枚不同令牌**；先返回的令牌刚签发就被下一次轮换覆盖 ⇒ 401 ⇒ 再取 ⇒ 又一轮换。
- **不变量**：I1 至多一枚有效 ✘(4 枚)→✔(1 枚)；I2 旧令牌明确吊销 ✔→✔（DB `tokenHash` bcrypt **恰好一枚**命中）；I3 active ≤1 ✘(2–3 hash)→✔。真机**未修 6 轮 / 修后 10 轮**，平均不同令牌数 **4.00 → 1.00**。
- **改法**：新增 `token-issue-serializer.util.ts`（`KeyedSerializer`：同 key 串行、异 key 并发、失败不毒化），把「读缓存→复核→轮换→回填」整段包进 `run(identityKey,…)`。
- **防腐烂（本轮亮点）**：两条真机用例接进 `test:guards:selftests`，新增 `check:race-selftests-wired` 挂 `test:guards:repo`(87 段) 与 CI；**反向验证两层** —— fixture selftest 5/5（删引用/删脚本/删文件/入口漂移均红）+ **真实仓库删引用 ⇒ exit 1 点名、还原 ⇒ exit 0**（另实测：新守卫未挂 CI 时 `check:guards-wired` 先红，已补）。
- 回归：定向 527/527 · `typecheck` 0 · `guards:repo`(87) 0 · `docs` 0 · `size-caps` 0 · `guards-wired` 0 · `migrations` 0。
- 提交：`63431667`(A) + `e3a3aeea`(B) + `77212b78`(台账)。

## 容器悬案已结（R11 遗留清零）
`acf-*` 7 个经取证属本仓 `acf` compose 项目、**已跑 31h–5d（早于本会话）**，卷 `acf_postgres_data` 69MB 有真实数据 ⇒ **未动**；`heuristic_solomon`/`metabase`/`flow2api` 非本项目**未动**；本轮新栈 `acf-r12-*` 已清残留 0。⇒ R11 状态卡里「10 个容器」的疑问**已被这条推翻**，不再追问。

## 未收口（按优先级）
1. **跨实例幂等不成立**（§7.11 P1）：`KeyedSerializer` 是**进程内**的 —— 多实例部署下同一身份的并发签发仍会各轮换。需共享存储或「只存哈希 + DB 幂等键」的设计变更 ⇒ **ADR 级**。
2. 真机并发仍缺 3 轴：心跳 `runningTaskCount` 覆盖写 vs 派发占坑 / `rolloutBatchClaimId` CAS / `agent_approvals` consume。
3. `check:desktop-bundle-drift` 字节哈希待 CI；executor-node `.env` 约束（§7.4）；守卫框架 meta 改造（§7.2）；`UPGRADING.md` 头部基线。
4. §7.9 P2：SSRF 矩阵扩到闸层（非紧急）。

## 下轮第一步（R13 = 跨实例面）
1. `git log -1 --oneline` 确认 `77212b78`（**自己跑**）；
2. 立项 **`token-idempotency-cross-instance`**：**先写 ADR**（三个方案对比：①Redis 明文令牌缓存 ②只存 hash + DB 唯一幂等键 ③lease/单写者；必须写清**失效半径**——指错令牌的代价、回滚路径、多实例灰度期间的兼容行为），**没 ADR 不动代码**；
3. ADR 通过后再改实现 + 判据：起 **两个 admin-api 实例**真机并发签发同一 `(address,startupId)`，断言 I1/I2/I3 仍成立；
4. 若 ADR 显示代价过大（如需新中间件），**降级为「记录为已知限制 + 加运行期检测告警（多实例部署时告警）」** 也可结项 —— 但必须在回执里说明选了哪条路。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 7 次。
- **只信命令 + 真实 exit code**；回执会错归因（R01→R02）、我会错摘要（㊱）、别编 sha（㊲）、未复现如实写（R11/R12 做对了）。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
