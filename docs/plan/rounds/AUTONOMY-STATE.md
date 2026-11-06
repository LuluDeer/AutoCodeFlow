# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 96 段全绿**（上次全绿 `594b942c` 之后）
**会话**：第 86 轮 · 并行第 23 批

## 本轮最重要的结论（W3 全仓普查，24 个出站入口）
**全仓已无「纯 DNS 决定放行」的 SSRF 闸** —— R80/R81 修的 4 处就是最后 4 处；node R82b 与 python `is_localhost_synonym` 早已名字优先。实测证据：admin 4 处对 `LOCALHOST` / `localhost.` / `Foo.LocalHost` 全拒且错误码正确；node 三种形态全 DENY、`example.com` ALLOW。
**一条重要事实**：`new URL()` 会把 **百分号编码**（`local%68ost`）与 **IDN**（`ⓛocalhost` U+24DB）**归一成 `localhost`**，但**尾点保留** ⇒ 名字判定必须自己折尾点（三端都已折）。

## 普查发现的 3 条（已登记，附「该谁修」）
1. 🟡 中 · **python 下载面不钉扎已校验 IP**（`routers/execute.py:2582` httpx 流式下载，仅 `:2622` 逐跳复检）⇒ **rebinding 双解析窗口**：判定时解析公网、建连时解析 `169.254.169.254` 就能连到元数据；而 **admin 用 `pinnedAxiosConfig`、node 用 `createPinnedLookup` 都钉扎** ⇒ 三端口径差。**已派 W4（R85）**。
2. 🟡 中低 · **admin `RegistryController.fetchText` 零闸**（env 来源、用户不可达，属加固）。**已派 W3（R85）**。
3. 🟢 信息 · node 语法闸只认两个字面名（仍被 DNS 级兜住，无旁路）⇒ 留作 backlog。

## 上一批已收口
- `verdictForAddress` 成为 node **唯一判决入口**（`006fe7b4`）：4 处接线、**错误文案逐字保持** ⇒ 6 条按文案断言的用例**零改动**、等价性 54 格差 0、反向验证 70 failed。
- **liveness 扩面 2 → 20 个脚本**（`71a67169`）：纳入 20 / 跳过 65（原因写进注释）、真仓库零误报、红演示点名 `check-credential-columns.mjs:862`。
- **W2 中断的「复制语义」已由 Lead 定向验收代收编**（`20b9573c`，5 文件 26 passed；反向验证待补 ⇒ 已派 W2）。

## 待办（按优先级）
1. 收 W4（IP 钉扎）、W3（registry 闸）、W2（复制反向验证）。
2. **ADR-034 实施步骤 1**（契约段 + 生成物 + 一端读；验收信号 = 标签差异先仍 4 条、切完 admin 才降 0）——**必须串行排期**，不能与其它 worker 并行改 `packages/` + 三端。
3. node 语法闸扩名（🟢，可延后）；真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**先核对被测签名再判「不一致」**；**对照断言只证「重构未改行为」**；**错误码/错误文案都是对外接口 ⇒ 尽量逐字保持**；**`new URL()` 会归一编码与 IDN，但保留尾点**；**rebinding 需要 IP 钉扎，逐跳复检不够**；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**；**作者中断≠改动作废（Lead 定向验收后收编，已两次实证）**；一次只改一个文件 + `node --check` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
