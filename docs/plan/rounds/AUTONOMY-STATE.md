# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 96 段全绿** · 工作区有 3 路在途改动
**会话**：第 87 轮 · 并行第 24 批

## 本轮落地（HEAD）
1. **归一化形态矩阵纳入跨端判据**（`4fc1c074`）：**54 → 74 格**（10 条形态 × 开关两态），形态含 `localhost` / `LOCALHOST` / `Foo.LocalHost` / `localhost.` / `localhost..` / `local%68ost` / `ⓛocalhost`(U+24DB) / `localhost.localdomain` + 2 条反例（`notlocalhost.com` / `localhost.evil.com`），期望依据 = 契约 `loopback.description`。红演示：`--root` 夹具把 admin `isLoopbackHostname` 改恒 `false` ⇒ exit 1；**反向验证再证双断言各自有牙**（契约比对改恒假后夹具仍红，因三端一致性分支独立命中）；既有 54 格仍绿。
2. **两处诚实降级（显式打印、不算通过也不算失败）**：① `local%68ost` / `ⓛocalhost` 的归一化发生在 **URL 解析层**（`new URL()`），纯函数层三端都不承担 ⇒ 由各端既有 URL 测试覆盖；② 反例的 **python 端**：`verdict_for_address` 对非 IP、非回环专用名 **fail-closed 拒绝**（纯函数无法解析 DNS）。
3. **复制语义收尾（W2，补完）**：反向验证（短路「附原始」⇒ exit 1，红的是【核心】用例）；**不重复**三条断言全绿（无 errorCode / 相同 / Error 无 response，计数=1）；**真 UI 读到剪贴板真实文本** = `URL host 10.0.0.9 在拒绝名单内（…）\n\n[SSRF_HOST_DENIED] URL host is on the deny list` ⇒ 本地化 + 原始**两段都有**；截图 `artifacts/autonomy/R85-web/copy-with-raw.png`；**未新增 i18n key**（`[CODE]` 标记用 errorCode 本身、语言中立）。

## ⚠ 已知跨端差异（本轮判据抓出，Lead 已裁决）
**`localhost..`（连续尾点）：admin 放行 / node+python 拒绝** —— 根因 admin 的 `isLoopbackHostname` **只折一个尾点**，折完剩 `localhost.`。契约对该形态**未表态（沉默区）**。
**裁决：fail-closed 对齐到「拒绝」**（node/python 已拒，让 admin 也拒是收紧方向、风险最小；不采用「折叠全部尾点后按 localhost 放行」的解释——沉默区不往放行方向解释）。已派 W3 修（改 `replace(/\.+$/,'')`），修后 W1 把该行从「已知差异」清单移除。

## 待办（按优先级）
1. 收 3 路：W3（registry 闸 + `localhost..`）、W4（python **IP 钉扎** / rebinding）、W5（node 语法闸与 admin 对齐）。
2. **ADR-034 实施步骤 1**（契约段 + 生成物 + 一端读；验收信号 = 标签差异先仍 4 条、切完 admin 才降 0）——**必须串行排期**。
3. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**契约沉默区一律 fail-closed，不往放行方向解释**；**先核对被测签名再判「不一致」**；**对照断言只证「重构未改行为」**；**错误码/文案都是对外接口**；**`new URL()` 归一编码与 IDN、但保留尾点；连续尾点是新坑**；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
