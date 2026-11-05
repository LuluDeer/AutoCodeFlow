# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 95 段全绿** · 工作区干净
**会话**：第 81 轮 · 并行第 19 批

## 本轮落地（HEAD）
1. **`*.localhost` DNS 旁路已修**（`de66dd52` + ADR-036 `56ad74f9`）：在 `safe-http.util.ts:179`（`assertAndPinHttpUrl`，lookup 在 `:184`）与 `:477`（`assertSafeHttpUrl`，lookup 在 `:482`）**DNS 之前**短路，复用 `address-category.util.ts` 的 `isLoopbackHostname`（**未写第二份**）。
   - **红证据**：注入 DNS 替身把 `*.localhost` 解析到 `93.184.216.34` ⇒ 旧实现 **4 failed**（四种形态/ pin 版全放行）→ 修后 **5 passed**；`example.com` 仍放行（对照）。
   - **反向验证**：两条短路置 `false &&` ⇒ 同样 **4 failed**；还原 ⇒ 全绿。
   - **错误码变更（刻意、已留痕）**：`SSRF_HOST_DNS_LOOKUP_FAILED` → `SSRF_HOST_DENIED` / `..._PINNED`。**先出 ADR（判为 ADR 级：错误码是对外可观测契约）**，六节齐备 + 索引 1 次；**依赖面已查清**：admin-api 测试无旧码断言、admin-web 只有 i18n 文案（两码都有 zh/en、无按码分支）、CLI/SDK/`protocol.json`/`api-reference` 均未列该码 ⇒ **无调用方需更新**。
   - 体量：`safe-http.util.ts` 445 → **452**（+7 是两条短路的注释与分支，仍在基线内）。
2. 全链复验：**95/95 exit 0**。

## ⚠ 同族未收口（W3 已在 ADR-036 §3.3 登记，**最高优先**）
**同样依赖 DNS、存在同款旁路**的两面：
- `assertSafeGitRepoUrl`（`:700` 的 lookup）
- `assertSafeExecutorUrl`（`:804`）
⇒ 契约点名的 `localhost` 系名字在这两面**仍可能被 DNS 解析结果绕过**。

## 待办（按优先级）
1. **同族两面收口**（GitRepo / Executor）。
2. **python 侧是否有同一旁路**（python 的 `host_safety_verdict` 是否也把主机名交给 DNS）—— 跨端对称性必须核。
3. **跨端对照判据**（两侧零依赖出口已就绪：admin `fc05ef71`、node `b3aac035`）⇒ 可接进 `check:*`。
4. ADR-034 实施第 1 步（契约段 + 生成物 + 一端读；验收信号 = 标签差异先仍 4 条、切完 admin 才降 0）。
5. 错误码变更的用户可见面：前端 i18n 已有两码文案，但**需真 UI 确认**新码能正确渲染（W2 可做）。
6. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；liveness 覆盖面仅 2 个脚本；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**对照断言只证「重构未改行为」，须另配独立锚定**；**零行为变化优先于顺手修好**；**错误码/可观测输出变更属行为变更 ⇒ 先 ADR + 查依赖面**（本轮示范：查清「无调用方按码分支」才改）；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**（并发期红可能是工作区噪声）；作者中断≠改动作废；一次只改一个文件 + `node --check` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
