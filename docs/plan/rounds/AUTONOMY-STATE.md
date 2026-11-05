# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 95 段全绿** · 工作区仅有 W3 在途改动
**会话**：第 78 轮 · 并行第 16 批

## 本轮落地（HEAD）
1. **发版公告五节判据（R77-B）**（`4133a226`）：`checkReleaseNotesSections` 作为 `check-docs` 第 7 项（**与 `checkAdrStructure` 平级**，白名单 `^docs/RELEASE-NOTES-[^/]*\.md$`）；三种反例：白名单删「回滚」⇒ 红并点名；**非白名单缺同样小节 ⇒ 不红**（防误伤）；围栏内假标题 ⇒ 仍红；自检夹具同步 ⇒ selftest **43 通过 / 0 失败**。
2. **`addressRiskSegmentId` 下沉**（`9e1609ae`）：admin 纯函数模块再收一个非纯出口。
3. **node 侧纯函数出口（R77-W5）**（`b3aac035`）：新增 `src/lib/address-category.ts`（**0 import**），`ssrf-guard.ts` 逐字委托、导出名签名不变；**仓外 require 实测 exit 0**：`{rows:25, statesChecked:50, categoryDiffs:0, verdictDiffs:0}`；反向验证注入错类别 ⇒ **6 条差异**（loopback 系列开关态）。选方案 C（node 内建零依赖模块）而非 B（抽到 `packages/`）= B 属 ADR 级、另议。
4. **digest 回填 + 全链复验**（`71f066a2`）：**95/95 exit 0**（末行自证）。

## ⚠ 一条 blocked（第 2 次失败，按止损停手）
**webhook 判据「地址→决定」端到端真跑**（W1，R77 A + R78 两轮失败）：根因 = admin `address-category.util.ts:42` 的**无扩展名导入** `"../../generated/protocol-metadata-addresses"`，在**子进程 + `--experimental-strip-types`** 下 ESM 解析不稳（`esm/resolve:272`），夹具补副本也失败。
**处置**：已升级为 W3「装配收敛」的**硬验收条件** —— 该模块必须变成 **`grep -c '^import'` = 0**，并把 `METADATA_ADDRESSES` 改由调用方装配入参；验收含**仓外 `require` 实测 exit 0**。达成后 W1 可按已验证形状（`classifyAddress` → `evaluateOutboundPosture`，契约 25 地址 × 开关两态）接线，**不再需要子进程**。
**当前交付层级**：webhook 判据仍停在 R75 的**决策层**（以 `risk` 为入参），端到端未交付（如实）。

## 待办（按优先级）
1. W3 装配收敛完成 ⇒ 唤醒 W1 做端到端判据（**这是下一步的关键路径**）。
2. ADR-035 步骤 4：存量歧义行清账（需数据侧证据）。
3. B 路径（`packages/` 真·单源分类表）属 ADR 级 —— 需另立 ADR（W5 已给方案）。
4. 未收口：ADR-034 契约类别表实施；跨端对照判据（依赖 1）；真机脚本接链（需 CI postgres）；R18-B blocked；liveness 覆盖面仅 2 个脚本。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**对照断言只证「重构未改行为」，须另配独立锚定**；作者中断≠改动作废；跨端改动**同载荷同结论**且**判的值须与真正使用的值同源**；**链必须在无在途改动时跑**（并发改 `apps/**` ⇒ 33/40/81/94 段假红，已多次复现）；**改 lib 前先 `node --check`、一次只改一个文件、失败即 `git checkout` 回滚**（W1 上轮把 lib 改坏过）；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**（用精确 PID）。
