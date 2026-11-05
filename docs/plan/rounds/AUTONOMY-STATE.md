# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · ⚠ **链当前红在 94/95 `check:posture-matrix-tables`**
**会话**：第 83 轮 · 并行第 20 批收尾

## 本轮落地（HEAD）
1. **同族两面收口（admin）**（`998e3970` + ADR-036 §3.3 `a18054d3`）：`assertSafeGitRepoUrl`（`:700` lookup）与 `assertSafeExecutorUrl`（`:804`）同样在 **DNS 前**拒绝 localhost 系；错误码**刻意各自保留**（`GIT_REPO_HOST_BLOCKED` / `EXECUTOR_HOST_BLOCKED`），理由=两面各有自己的错误域（git 克隆失败 vs 执行器不可达），套用 webhook 的码会让运维按错误域排查走偏；已用「两面的错误码各自保留」用例钉住。反向验证两面同时短路 ⇒ 5 failed。
2. **跨端 localhost 旁路三端全收口**：
   - **python**（`cc18ff13`）：名字判定**本来 DNS 无关**（`network_policy.py:76` `is_localhost_synonym`），但**尾点归一化漏了** ⇒ `localhost.` 掉进 DNS 分支被解析替身放行；补 `rstrip(".")` 后 **15 failed → 46 passed**；全量 `-k not slow` **1874 passed**。
   - **node**（`0ffe5f69`）：新增零依赖 `normalizeHostname`（trim→去方括号→小写→去尾点），`git-repo-network-policy.ts:168` 先归一化再判 ⇒ **4 failed → 7 passed**；**如实更正 W3「大小写也漏」的推断**：真正漏的只有**尾点**（`LOCALHOST` 早已被 URL/host 小写化）。
   - **admin**（R80 已修）。
   - **三端对照（W4 产出）**：`localhost`/`foo.localhost` 解析到公网 ⇒ admin/python/node **三道全拒**；尾点与大小写形态 ⇒ **三道全拒**。
3. **两个同形判决出口就绪**（跨端一致性判据的前置）：
   - **node**（`008eb199`）：`verdictForAddress(addr, allowPrivateNetwork, metadata?)` ⇒ `{allowed, category, metadata, reason}`，**0 import**、仓外 require exit 0；**等价性 = 30 地址 / 60 格与真实闸逐条相同**；反向验证 76 failed。
   - **python**（`40802dea`）：`verdict_for_address(addr, allow_private_network) -> dict`，**裸 python3 可跑 exit 0**；与真实闸 `_package_url_host_denied` **27 地址 × 2 态 = 54 组逐条相同**；反向验证（cgnat 随开关放行）3 failed；未知主机名 fail-closed 为 `dns-required`。
4. **错误码真 UI 验证（W2）**：`SSRF_HOST_DENIED` / `_PINNED` 两码在 toast 里**正确渲染中文 + host 插值**，`body.innerText` 无原始 key、非空白；截图 `artifacts/autonomy/R81-web/*.png`；进程按精确 PID 清理。
5. atlas 量级层已刷新（`545236a5`）。

## ⚠ 当前红（下一轮第一件事）
`check:posture-matrix-tables`（94/95）。本轮已取到失败摘要（见本轮输出）：**很可能**是 W4/W5 的归一化把某些形态判成拒，而 posture 探针的期望值仍按旧口径；**也可能是 selftest 正例**。**先看完整输出再决定改代码还是改期望**，不许放宽判据。

## 待办（按优先级）
1. 上述红。
2. **跨端一致性判据可以建了**（三端出口齐备：admin `fc05ef71` / node `008eb199` / python `40802dea`）⇒ W1 一次建成。
3. `StateError.tsx` 本地化缺口（W2 已授权修：优先 `translateByErrorCode`，缺码回退 `message`；24 处调用方签名不变）。
4. ADR-034 实施步骤 1（契约段 + 生成物 + 一端读）；node `verdictForAddress` 的**接线**建议与 §9 步骤 2 同批（会改 6 条按文案断言的用例）。
5. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；liveness 覆盖面仅 2 个脚本；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**先核对被测签名再判定「不一致」**（W1 本轮示范：差点错怪 python，实为自家 harness 缺开关语义）；**对照断言只证「重构未改行为」**；**错误码变更属行为变更 ⇒ 先 ADR + 查依赖面**；**尾点/大小写这类归一化是三端同族坑，改一处要查三处**；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
