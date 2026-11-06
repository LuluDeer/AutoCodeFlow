# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 96 段全绿** · 工作区仅 W3 在途（`protocol.json`）
**会话**：第 90 轮 · 并行第 26 批

## 本轮（串行大件启动）
1. **ADR-034 步骤 1 开工**（W3，**独占写域**：`packages/executor-protocol/**` + `scripts/generate-executor-protocol.mjs` + `apps/admin-api/src/common/utils/**` + `docs/adr/**`）：只加契约段 + 生成物 + **只让 admin 读**；**验收信号 = `check:ssrf-three-way-matrix` 的标签差异应仍是 4 条**（不是 0；变成 0 反而说明派生写错），且 `cross-end`（74 格）exit 0、行为零变化。当前 `protocol.json` 已改、其余在推进中。
2. **姿态结论入文档**（`0e46ec4c`，W1）：`docs/operations.md` 新增「**出站姿态：四面对照 · 两层防御 · IP 钉扎**」节（1544 → **1602** 行）：
   - 四面对照表（webhook/executor/gitRepo/registry）+ registry 允许 loopback 的**三条依据** + **重新裁决条件**；
   - **两层防御**（语法闸 DNS 无关，不能只靠 DNS 兜底）+ **归一化坑**（尾点被 `new URL()` 保留、连续尾点 fail-closed 拒绝、百分号编码与 IDN 在 URL 解析层归一）；
   - **rebinding 与 IP 钉扎**（逐跳复检为何不够 + 三端各自手段）。
   - 建议的机读判据（下轮可立项）：本节「三张表 + 四个关键词」（`registry` 重启条件 / `语法闸` / `fail-closed` / `sni_hostname`）存在性判据。
3. **flaky 狩猎**（W2，在跑）：连跑 3 次 web 全量（串行、`--maxWorkers=2`），要么复现并给出失败用例名+日志，要么如实报「3/3 未复现」+ 下一步定位建议；**禁止加 retry、禁止改断言求稳**。

## 待办（按优先级）
1. 收 W3 的 ADR-034 步骤 1（**关键在标签差异数仍 4**）+ W2 的 flaky 结论。
2. ADR-034 步骤 2/3（让 node/python 也读契约段；**那一步标签差异应从 4 → 0**）。
3. operations.md 的机读判据（W1 给的建议）。
4. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**判据必须能红且红在语义层**；**反向验证要能隔离到单端**；**注入源缺失必须明确报错**；**契约变更必须先有 ADR + 一步一提交可回滚**；**「标签差异数」这类中间信号是验收核心**（4 条 → 0 条才是对的顺序）；**有意的不对称写成依据 + 重启条件**；**flaky 不许用 retry 掩盖**；**降级/跳过必须显式打印**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
