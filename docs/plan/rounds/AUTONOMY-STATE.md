# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `3ea44719` · 工作区干净 · 守卫链 **92 段**
**会话**：第 28 轮已收 · 26 轮产出（R01–R26，70 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；本会话第 2 次推翻我的结论）

## ⚠ 纠正 R25 的结论（**作废**）
我上一张卡写的「**57 个 admin-api spec 依赖开发者 `.env`**」**是测量假象**。真因：R25 全量用了 `npx jest`，该调用在本机把 **614 个 suite** 打挂（`Must use import to load ES Module: @nestjs/common`）且**与开关无关**（同一 spec：`npx jest` 两态都红、`npm test --` **51 passed exit 0**）⇒ 那次「57 failed / 1846 total」是**坏调用下的幸存者统计**。**正确全量 = 7920 例，`SELFTEST_SKIP_ENV_FILE=1 npm test` 实测 4 failed suites / 2 failed tests / 7918 passed**。

## R26 结论（部分完成，但纠错是主产出）
- **分类**：C1 = **3** / C2 = 0 / C3 = 0 + 1 项「非环境缺口」 ⇒ 真实缺口 **4 suites**（不是 57 specs），逐条依据在 `spec-classification.md`。
- **第一批（C1 全量）已收敛**：`app.module.spec.ts` · `throttle-domain-metadata.spec.ts` · `typeorm-replica.spec.ts` —— 共同根因 `Config validation error: DB_PASSWORD is required`（Joi 必填 `app.module.ts:152/185/186/190`）；做法 = `test/setup-env-file.ts` 置开关 + 最小夹具值 + 挂 `jest.setupFiles`。
- **缺口登记换条目（1→1）**：删掉 R25 的 `admin-api-jest-env-file`（前提被推翻，admin 已真正满足；守卫**收紧**为硬要求「必须有 setupFiles」，不再接受豁免），换成新发现的 `executor-stale-snapshot-harness-count`（`review_by=2026-11-20`）。**没有删断言、没有 skip、没有把 C3 伪装成夹具值**。
- 验证：`guards:repo` **0（92 段，末行「解析 92 / 执行 92 / diff 空」）** · `docs` 0 · `size-caps` 0 · `typecheck` 0 · admin 全量 **7918 passed / 2 failed（均为两态都失败的预存缺口）**。
- 提交：`3ea44719`。

## 方法论沉淀
㊼ **先验证"尺子"，再用它量东西**：`npx jest` 在本机是坏的调用方式，用它量出来的「57 个依赖 env」根本不是被测对象的属性，而是工具故障的投影。⇒ 任何「N 个失败/N 个问题」的统计，先用一个**已知该过**的样例校准测量方式（这里就是 `npm test --` 的 51 passed 对照）。

## 未收口（按优先级）
1. **剩 2 个失败 test**（两态都红，预存缺口）：`executor-stale-snapshot-write.spec.ts` 缺 `execRepo.count` 替身（R16 漏补）⇒ 补桩后删缺口条目。
2. **把「全量必须用 `npm test --`，`npx jest` 在本机不可用」写进 `docs/`** —— 否则下次还会拿坏调用数字下结论。
3. bundle-digest 回填摩擦（第 4 次：改 `executor-node/src/main.ts` 必触发）；②字节哈希待 CI。
4. R18-B 三条重启条件（§7.19，blocked）；并发轴仍缺 `rolloutBatchClaimId` CAS / `agent_approvals` consume。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3 越界态提示。

## 下轮第一步（R27）
1. `git log -1 --oneline` 确认 `3ea44719`（**自己跑**）；
2. 立项 **`stale-snapshot-harness`**（小、明确）：补 `executor-stale-snapshot-write.spec.ts` 的 `execRepo.count` 替身 —— 先摸清该 spec 的 exec 仓库注入方式（别硬塞 `jest.fn`），补桩后：
   - 判据：**该 spec 定向 exit 0**；`SELFTEST_SKIP_ENV_FILE=1 npm test` 全量 **7918 → 7920 passed / 0 failed**；然后**删除** `env-switch-known-gaps.json` 里 `executor-stale-snapshot-harness-count` 条目（守卫应仍 0）
   - **反向验证**：把替身移走 ⇒ 该 spec 重新红（证明它不是被跳过）
3. 同批把「全量必须 `npm test --`」写进 `docs/`（`docs/development.md` 或 `operations.md`），并让 `test:docs` 仍 0。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 7 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据本身也会误报（R25）、**先校准尺子再量（㊼）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
