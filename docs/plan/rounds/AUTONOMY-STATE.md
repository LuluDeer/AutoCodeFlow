# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · 守卫链 93 段
**会话**：第 66 轮 · 并行第 4 批

## 本轮落地（HEAD）
1. **python 出站闸按契约收紧**（`8f04f468` 红 → `4cf4ebdb` 绿，ADR-032 Step1–3）：开关**只放行 privateIPv4**；`linkLocal`（含 `169.254.169.254`/`fd00:ec2::254`）、`cgnat`(100.64/10)、`unspecified`(0.0.0.0/8)、`multicast`(224/4)、`reserved`(198.18/15、240/4) **全部改拒**；开关关闭零变化。定向 33 passed + parity 32 passed/1 skipped；**整个 python 套件 `-k "not small"` 1724 passed/1 skipped**；反向验证三处恒拒同时短路 ⇒ **11 failed**。
2. **`.env.example` 补 `PY_EXECUTOR_SWITCH_POSTURE_STRICT=1`**（Lead，`4a33b5e0`）⇒ `test:env-drift` **exit 0**（231 键全覆盖/豁免 39）。**不走 WHITELIST 豁免**（它是回滚阀，藏起来就又是看不见的开关）。
3. **W2 消歧**（`411d475f`/`86018f10`）：部署模态那条**不是进度条而是候选执行器容量占用**（`runningTaskCount`＝已占槽位，picker 无 `reservedSlots`）⇒ 判定**不同语义**，只消歧不改换算；并钉住「不消费 `reservedSlots`」。反向验证：改成 `displayedRunningCount` ⇒ exit 1。
4. **W1 三/四形态助手**（`7dc708f0`）：`expectContentContains` / `expectRequiredFieldsInJson`，selftest **12/12**；`compose`、`package-adoption` 已接（**对副本删项**的隔离法有效）；`protocol-breaking` 未接（需先把局部 `base()` 提到模块级）。
5. **W3 per-call context 恢复**（`29bf2fca`）：**我误判它是半成品并删掉，是我错**；W3 按原版逐字恢复，5 suites/200 passed、`tsc` 0。

## Lead 决定（已下发）
- **原则**：不接受「放开 cgnat 而挡住 linkLocal」的逃生阀；粒度不足的正解是**契约拆分地址类**（新 ADR），已要求写进 ADR-032 后续。
- **体量代签（批准，W1 执行）**：`tool-executor.service.spec.ts` 1448→**1493**（+45 全是 2 条红→绿 characterization）、`agent-runtime.service.ts` 986→**987**（+1 是共享类型 import，内联会把形状写两份）；回滚值 1448/986。`tool-executor.service.ts` 911 与 `execute` 676 **已回到已签上限内**。

## 在途
- **W1**：代签两处体量 + 接 `check-protocol-breaking` + **跑全链验收**（docs/size-caps/guards-wired/93 段链）。
- **W5**：node **下载面**姿态核查（`ssrf-guard.ts:359` 的 `if (allow) return` 是否同族缺陷）——工作区已有 `git-repo-network-policy.ts`/`ssrf-guard.*` 改动。
- **W4/W3**：收尾写 ADR/回执，不改代码。

## 待办
1. 收 W1 全链（**若红用 `--only <k>` 定位，不跳段**）；W5 收口后需 `digest:regen`（源文件改了）。
2. **用户可见行为变更**要同步文档：开关开启时 Tailscale `100.64/10`、`169.254.x`、`0.0.0.0` 形态、`198.18/15` 会被拒（RFC1918 与 loopback 不变）⇒ 需在 `docs/`（运维/升级）说明，属 W1 域。
3. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；服务端仍无 `reservedSlots<=running` 下限。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（恒真⇒变绿才算有牙；**删副本来隔离**）；形态不合不套用；**删除别人写域的文件前必须先确认它是否已验证**（本轮教训）；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`。
