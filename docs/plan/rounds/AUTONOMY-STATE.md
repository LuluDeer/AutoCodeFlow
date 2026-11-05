# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 96 段全绿** · 工作区干净
**会话**：第 84 轮 · 并行第 21 批收尾

## 本轮落地（HEAD）
1. **跨端出站姿态一致性判据**（`e8e043f2`，链 **95 → 96**）：`check:cross-end-consistency` 覆盖 **54 格 = 契约 27 条地址（25 IP + 2 恒拒表，逐字读）× 开关两态 × 三端真跑**；**主机名形态也纳入**（admin `isLoopbackHostname` / node `verdictForAddress` / python `verdict_for_address`）。
   - **绿**：真仓库 exit 0（`✔ 跨端姿态一致：54 格 × 3 端真跑，三端互一致且与契约期望一致`）。
   - **红**：`--root` 夹具把 node 副本 deny 分支 `allowed:false → true` ⇒ exit 1。
   - **反向验证的更细结论**：把「与契约期望比对」改恒假后夹具**仍红**——因为守卫有**两条独立断言**（①与契约一致 ②三端互相一致），放宽一端会命中 ② ⇒ **两个分支各自都有牙**（比单断言更强）。
2. **链红修复**（`2d926e03`）：node `posture-matrix.spec.ts` 的 EXTRA 里抄了 2 条契约已有地址 ⇒ 直接删（ROWS 本就逐字读契约）；`localhost.localdomain` 属子串误报且是 `isLocalhostSynonym` 覆盖项 ⇒ 按约定行尾标 `// allowed-literal:`。修后 `posture`（链内形式）exit 0、`posture-matrix|ssrf` **319 passed**。
3. **StateError 本地化修正**（`4c3285bf`）：`StateError.tsx` 改为优先 `translateByErrorCode`、缺码回退 `message`；7 例（含 4 条回退保护：无码/未知码/Error 无 response/无 message 兜底「请求失败」）；反向验证短路翻译 ⇒ 2 条核心红、4 条保护仍绿；抽查 6 个页面 + **真 UI 截图对照**（同场景面板从英文变中文）。
4. 全链复验：**96/96 exit 0**（`grep -c` = 96）。

## 已裁决（本轮）
**复制按钮语义**：同时给「本地化 + 原始」（排障要原文、用户要中文，受众不同不该二选一）；无 errorCode 或两者相同 ⇒ **只复制一份**（断言计数 = 1）。已派 W2 实现。

## 待办（按优先级）
1. **ADR-034 实施步骤 1**（契约段 + 生成物 + 一端读；验收信号 = 标签差异先仍 4 条、切完 admin 才降 0）。需协调 `packages/` + 三端写域 ⇒ **必须串行排期，不能与其他 worker 并行改同文件**。
2. node `verdictForAddress` **接线**（与 ADR-034 §9 步骤 2 同批；会改约 6 条按文案断言的用例）。
3. liveness 覆盖面**扩面**（现仅 2 个脚本；前提仍是零误报）。
4. 全仓「依赖 DNS 结果决定放行」的闸**普查**（R80/R81 只修了 4 处：webhook×2、gitRepo、executor）。
5. 未收口：真机脚本接链（需 CI postgres，本地无法验证 CI 真跑）；R18-B blocked；flaky 待复发取证。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红**；**先核对被测签名再判定「不一致」**；**对照断言只证「重构未改行为」**；**错误码变更属行为变更 ⇒ 先 ADR + 查依赖面**；**尾点/大小写这类归一化是三端同族坑**；**双断言守卫比单断言强**（本轮实证）；**共享组件变更注意 24 处调用方**；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
