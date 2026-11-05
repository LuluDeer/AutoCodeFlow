# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 95 段全绿** · 工作区干净
**会话**：第 77 轮 · 并行第 15 批收尾

## 本轮落地（HEAD）
1. **posture 自检红已修（a1）+ 反向验证终于做成**（`ba90be10`）：根因 = webhook 真跑探针在 `--root` fixture 里解析不到 util（`esm/resolve:272`）；修法 = **fixture 内放真实 util 副本**（a1，保持真跑语义，而不是 a2 的「只验降级文案」）。反向验证三次 exit 齐全：宽松副本 ⇒ 1；`if (got !== c.expected)` → `if (false)` ⇒ **0（红变绿）**；还原 ⇒ 1。
2. **地址分类抽成零依赖纯函数**（`8c752280` + `a8cdd714`）：`address-category.util.ts` 导出 `classifyAddress(addr, tables)` / `classifyMetadataAddress`，**模块零 import**（连 `node:net` 都不 import，`isIP` 走入参）；段表整段搬入、`safe-http.util.ts` 改 re-export ⇒ **565 → 462（净降 103）**。
   - **判据**：表驱动 4 例（期望逐字读契约，含 ipv4Mapped 按内嵌 IPv4 判定 + 恒拒表专例）+ **独立锚定 2 例**（断言契约 `allowedUnderPrivateNetwork` 字段本身）+ 对照 2 例。
   - **反向验证再次印证教训**：把 cgnat 段 risk 改错 ⇒ 表驱动红，**而对照断言仍绿**（委托下两端一起错）。
   - **仓外探针实测**：只 require 两个纯函数模块（不再需要 ts-node 子进程），25 条契约地址 × 开关两态 ⇒ 与契约**零差异**（`mismatches: []`）。
3. **ADR-035 落地**（`530f4d15`）：python `_zip_channel_enabled` 去掉 `packageUrl` 条件（与契约/admin 对齐），`run_task` 内联副本并入同一函数；歧义行三行对照 = admin 派发失败（指向 application）/ python 改前**照常跑** / 改后 **400 显式拒**（指向载荷）；1 条既有用例按行为变化翻案。定向 269 passed；全量 `-k not slow` **1828 passed / 1 skipped**。
4. **真 UI 验证（首次）**：W2 用 mock admin-api（3199）+ vite dev（5199）实跑浏览器，三处提示文案逐字一致（详情页 0/10+橙 Tag、列表 0/10任务+警示图标、卡片整句 Tag），**反向用例**（`running=10/reserved=3` ⇒ 显示 7/10 且无提示）实跑确认**不常显**；截图落 `artifacts/autonomy/R76-web/*.png`（`artifacts/` gitignored，按仓库惯例未入库）；进程按**精确 PID** 清理，未用 `pkill -f`。
   **如实边界**：矛盾数据来自 **mock 后端**，验证的是**前端渲染层**，不是该状态在生产出现的频率。

## 待办（按优先级）
1. **W1 可把 webhook 判据升级到端到端真跑**（W3 已给调用示例：两个零依赖模块 + 契约 25 地址）。
2. **release-notes 五节判据**（W2 规格已备，落 `scripts/**` = W1 域；注意**与 `checkAdrStructure` 平级**、白名单、同步自检夹具）。
3. **ADR-035 跨端对照判据**（W4 遗留①，需两侧真跑、落 `scripts/**`）——在它之前「两端一致」只有单侧真值表 + 契约引用，没有机器判据盯回归。
4. `addressRiskSegmentId` 与 `ADDRESS_CATEGORY_TABLES` 装配仍在 `safe-http.util.ts`（同族最后两个非纯函数出口）。
5. 未收口：ADR-034 契约类别表实施；存量歧义行清账（ADR-035 步骤 4）；真机脚本接链（需 CI postgres）；R18-B blocked；liveness 覆盖面仅 2 个脚本。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**对照断言只能证「重构未改行为」，必须另配独立锚定**（期望值来自契约/需求）；作者中断≠改动作废；跨端改动**同载荷同结论**且**判的值须与真正使用的值同源**；**链必须在无在途改动时跑**（并发改 `apps/**` 会让 33/40/81/94 段出现假红，本轮已两次复现）；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**（用精确 PID）。
