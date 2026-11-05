# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 95 段全绿** · 工作区干净
**会话**：第 75 轮 · 并行第 13 批收尾

## 本轮落地（HEAD）
1. **node accept 闸判值口径修错**（`6a3c8207`）：闸判**原文** `packageUrl`，而**实际下载用改写后**的值（`execute.ts:2048 effectivePackageUrl → downloadZipWithCache`）⇒ 「admin 基址配成私网时，原文公网但下载目标是元数据」可绕过。改为判**改写后**（两处 accept 闸 + pull 预闸统一）；4 条验收用例（原文公网+基址→元数据 / 原文 linkLocal+基址公网 / 非 `/uploads/` 路径 / 全安全）；反向验证：改回判原文 ⇒ 红。
2. **admin 出站姿态抽成零依赖纯函数**（`3b72ba52`）：`outbound-posture.util.ts` 导出 `evaluateOutboundPosture({risk, metadata, allowPrivateNetwork, posture})`，`safe-http.util.ts` 三处谓词改**逐字委托**（行为零变化）。**方法学亮点**：委托后「旧入口 vs 纯函数」的对照只能证「委托没改行为」、**不能证符合契约** ⇒ W3 主动补了 **2 条独立锚定**（契约期望值写死、不依赖被测实现）。
3. **python packageUrl 闸收单一入口**（`70a16438`）：新增 `_guard_user_supplied_package_url(task)`（该不该判/判哪个值/调哪道闸三项决策全在入口，返回被判定过的 URL ⇒ **判的值与下载的值物理同源**）+ `_zip_channel_enabled(task)` 渠道判定唯一事实源。**修掉真分叉**：accept 期此前**误伤 glue 任务**（其 packageUrl 根本不会被下载）。252 passed；全量 `-k not slow` **1810 passed**。
4. **source-text-contracts 隔离红已修**（`c08d23ed`）：根因不是新断言未登记，而是既有 **STC-064 的 `specLine` 漂移**（W3 的 application 模块改动把 `const SERVICE_SRC = fs.readFileSync(` 从 :419 挪到 :473）⇒ 按仓规登记同步 + `dispositionNote`；反向验证（改 needle ⇒ 点名）。
5. **体量代签**（`8a2ead93`）：`execute.ts` 2154、`execute.spec.ts` 2481，含回滚值；digest 已回填。

## 本轮方法学（值得记）
**对照断言只能证明「重构没改行为」，不能证明「行为正确」** —— 必须另有**独立锚定**（期望值来自契约/需求，而非被测实现）。W3 自己发现并补上了，这是这类「抽纯函数」重构的通用要求。

## 待办（按优先级）
1. **W1 webhook 面判据已解锁**：W3 已提供纯函数与调用示例 ⇒ 可把 R71/R72 blocked 的「源码文本断言」升级为**真跑**判据。
2. **渠道判定歧义**（W4 发现）：admin 用 `codeSource==null && applicationId`，python 多一个 `packageUrl` 条件 ⇒ 「无 codeSource + 有 applicationId + 无 packageUrl」两端行为不同（admin 派发失败 / python 照常跑）；统一要改 admin 且可能改变派发结果 ⇒ **另立项**。
3. `classifyAddressRisk` / `isMetadataAddress` 仍带 Nest 依赖（W3 遗留①）⇒ 再抽一层纯函数可让判据端到端自判。
4. `posture` 目前是语义占位，没有守卫钉「webhook 与 executor 两面必须同构」（W3 遗留②）。
5. 未收口：ADR-034 契约类别表实施；真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证；liveness 覆盖面仅 2 个脚本。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红——绿而不可红 = 死判据**；**对照断言须配独立锚定**；作者中断≠改动作废；覆盖边界先判「差异 vs 缺口」；跨端改动**同载荷同结论**且**判的值须与真正使用的值同源**；定位代码块只用 CodeGraph 符号边界；断言源码文本必须登记；worker 只跑定向，全量/链由 Lead 串行跑；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
