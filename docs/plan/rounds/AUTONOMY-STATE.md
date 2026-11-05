# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `7992cf99` · 工作区干净 · 守卫链 92 段 · 缺口登记 **1 → 0（空）**
**会话**：第 29 轮已收 · 27 轮产出（R01–R27，72 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本次一次 `git add` 路径拼错、已自行补齐）

## R27 结论（部分完成，**唯一未闭合项是"全量两态未实测"**）
- **根因**：`executor.service.ts:3805-3818` 的心跳落库前会用 `execRepo.count({where:{executorId, status IN (pending/running/waiting)}})` 统计**在途执行数**作为 `runningTaskCount` 下限（R16 的 `resolveHeartbeatRunningTaskCount`）；该 spec 的 `makeService()` 直接 `new ExecutorService(...)`，**第 2 个形参**就是 `@InjectRepository(TaskExecution) execRepo`，原先只塞 `{ find: jest.fn() }` 裸对象 ⇒ `count` 缺失。
- **修法（按语义）**：复用 R16 `executor.service.security.spec.ts` 的 `makeRepo()` 范式 `count: jest.fn().mockResolvedValue(0)`；本夹具没有任何执行行 ⇒ 在途数**语义上就是 0** ⇒ `max(上报值, 0) = 上报值`，**19 条既有断言一条不改**（注释写明形参身份与「0 是业务事实」）。
- **判据**：定向 **exit 0（19/19）**；**反向验证**：注释掉替身 ⇒ **exit 1**（`TypeError: this.execRepo.count is not a function`，2 failed/17 passed）⇒ 证明不是跳过、也没吞断言；缺口条目删除后 `check:env-switch-default-policy` 仍 **exit 0**；`guards:repo` **0（92 段）** · `docs` 0 · `size-caps` 0 · `typecheck` 0。
- **未闭合**：全量 `npm test` 与 `SELFTEST_SKIP_ENV_FILE=1 npm test` **两次跑到中途被 SIGTERM 终止**（日志 226KB/292KB 无汇总行，**非用例失败**）⇒ 可引用 R26 开关态基线 **7918/7920**、仅有的 2 个失败正是本轮修掉的两个 ⇒ **预期 7920/7920，但未实测**（如实标未验证）。
- 提交：`26180ff9` + `7992cf99`（一次路径拼错导致主体晚一个提交，已补齐）。
- **量尺已入文档**：`docs/operations.md` 写明「admin-api 全量必须 `npm test --`，`npx jest` 在本机因 ESM 打挂 614 suite；看到异常大失败数先怀疑调用方式」。

## 方法论沉淀
㊽ **测试套件跑不完，也是"测量不了"**：R26 是「调用方式错」导致假数字，R27 是「进程被 SIGTERM 杀」导致没数字。⇒ 结论里必须区分「测出来是坏」与「根本没测成」；后者只能标未验证，**不许用预期值代替实测**（本轮做对了）。

## 未收口（按优先级）
1. **闭合全量两态实测**（下轮主靶）：用 `--maxWorkers` 限制并发、后台跑、日志落盘，避免被内存/会话回收杀掉；顺带**查清 SIGTERM 原因**（OOM？外层超时？）。
2. bundle-digest 回填摩擦（第 4 次：改 `executor-node/src/main.ts` 必触发）；②字节哈希待 CI。
3. R18-B 三条重启条件（§7.19，blocked）；并发轴仍缺 `rolloutBatchClaimId` CAS / `agent_approvals` consume。
4. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示。

## 下轮第一步（R28）
1. `git log -1 --oneline` 确认 `7992cf99`（**自己跑**）；
2. 立项 **`full-suite-run-closure`**：目标只有一个 —— **拿到全量两态的真实数字**：
   - 手段：`npm test -- --maxWorkers=2`（或 `--runInBand` 备选）× 两态，**后台运行 + 日志落盘**（`artifacts/autonomy/R28/full-*.log`），避免前台被终止；
   - 判据：贴 **真实汇总行**（passed/failed 数 + exit code）；若仍被终止 ⇒ **换手段再试一次**（降低并发/分片 `--shard`），最多 2 次后如实报「本机无法跑全量」并把它写成**已知限制**（含证据与重启条件）；
   - **不许**用「预期 7920」冒充实测；
3. 同批顺带记录 SIGTERM 的最可能原因（`dmesg`/`journalctl` 里有无 OOM kill，或外层 runner 超时）。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 7 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据本身会误报（R25）、**先校准尺子（㊼）**、**没测成 ≠ 测出来是坏（㊽）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
