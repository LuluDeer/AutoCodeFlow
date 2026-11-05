# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · ⚠ **链当前红在 81/94 `check:size-caps`**
**会话**：第 72 轮 · 并行第 10 批收尾

## 本轮落地（HEAD）
1. **node `zip` 渠道补 accept 期同步闸**（`7985d945`）：`acceptExecution` 内直接调 `ssrf-guard.assertSafeHttpUrl`（与下载/部署/自更新**同一入口、同一类别表、同一开关语义**，零第二份逻辑）；旧实现 5 failed（全 200）→ 修后 `routes/execute.spec` **148 passed**；短路即 5 failed。
2. **node gitRepo scp-like fail-open 修复**（`11247598`）：git 2.43.0 实测「第一个 `/` 前有 `:`」即走 ssh，**与 userinfo 无关**；旧 `gitRepoHost` 只认 `user@host:path` ⇒ 裸 scp-like（`169.254.169.254:repo.git`）与异常 userinfo 提取失败 ⇒ `if (!host) return` **放行**。已改 **fail-closed**，新增 7 例（含 `./local/repo.git`、`file:///` 本地路径反证）旧 7 failed → 新 **180 passed**。
3. **ADR-034 共享类别表**（`9f59c1f3`，只写设计）：契约新增 `networkPolicy.categories`，三端从生成物派生，`CATEGORY_ALIASES` 退役；**验收信号很巧**：切到派生后标签差异应**仍是 4 条**（不是 0），admin 切完才降为 0。回滚**不需要特性开关**（无双轨行为，本仓已两次裁决「双轨＝制度化两种承诺」）。`metadataMembers` 刻意留空（恒拒表是地址清单，不对应类别）。
4. **CLI↔web 反漂移判据**（`ea90b0ff`/`a69a1d3e`）：跨包 import 不可行（CLI `rootDir: ./src` 实测 TS2835）⇒ 期望表改为**web 真实实现的实测快照**（13 主档 + 6 边界档），23 例；改任一方向都会红。
5. **python parametrize 噪音收口**（`c5dafaaa`）：失败 5 条 → **1 条**（断言抽成独立用例）。
6. **W1 覆盖边界裁决**（`d7bd6d72`）：admin **gitRepo 恒放行 private-lan = 契约允许的差异**（契约无 git 面，该面自定为「public + private-lan」，自建内网 git 必须可拉）；**admin webhook 面 = 覆盖缺口**（已有明确 posture 但未进四向判据）⇒ 已登记，**不硬加**。
7. atlas 量级层已刷新（`21cc2672`）。

## ⚠ 链红（唯一来源）
`check:size-caps`（第 81/94 段）。W5 的 node 改动使文件增长，**需代签或收敛**（诊断输出见本轮末尾；具体违规文件/行数本轮未拿到，下轮第一件事）。

## 未收口（按优先级）
1. **size-caps 代签/收敛**（当前唯一红）。
2. **`zip`/`packageUrl` accept 期闸：python 仍缺**（W4 核实 `accept_execution()` 只查停机/容量/磁盘/schema，`_assert_safe_package_url` 唯一调用点在后台 `run_task()`，**违反契约 stage=accept + mustNotLeaveLiveEntry + mustNotCreateWorkDir**，但 SSRF 不可达）。⇒ 下一批让 W4 按 node 同法补，**要求两端同载荷同结论**。
3. **webhook 面进四向判据**（W1 登记，需真跑两侧实现）。
4. 发版公告（运维动作）；契约层类别表实施（ADR-034 分步）；真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败；形态不合不套用；**作者中断≠改动作废（Lead 独立验收后收编）**；覆盖边界先判「差异 vs 缺口」；跨端改动**同载荷同结论**；worker 只跑定向，全量/链由 Lead 串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
