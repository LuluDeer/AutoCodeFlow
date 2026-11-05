# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：HEAD `8632a9c6` · 工作区干净 · 守卫链 92 段 · **backlog 主表已清空（5 → 0）**
**会话**：第 37 轮已收 · 35 轮产出（R01–R35，83 提交）· 手册 §7 已修正（禁止冻结）
**teammate**：`guard-chain`（崩 2 次均 recover；多次自纠假绿/假数字）

## R35 结论（完成，**无真缺陷**，处置都有机制证据）
主表 **5 → 0**，逐条：
| 条目 | 结论 | 证据 |
|---|---|---|
| `diff-card-inline-columns` | **仅设计说明** | `grep tokenHash` 在 `ExecutorDetailPage.tsx` **0 命中** ⇒ 密列从不进 web，内联哪 3 列属展示选择 |
| `iana-special-purpose-sweep` | **已被 HEAD 推翻** | `safe-http.util.ts:666-669` 已有 `192.0.0.192` 处理 + `/24` RFC 7335 说明 |
| `release-path-race` | **已被 HEAD 推翻** | `heartbeat-count.util.ts:21` 的 R16「取大」修法已覆盖「释放后不低于在途」 |
| `running-minus-reserved-drift` | **已被 HEAD 推翻** | `executor-metrics.ts:23` `resolveRunningCount` + `ExecutorDetailPage.tsx:342` 已调用 ⇒ 负值被 clamp |
| `reserved-slots-semantics-vs-inflight` | **仅设计说明** | `executor.service.ts:3287-3297` 已写明不同源 + `reservedSlots <= effectiveRunningCount` 配对校验兜住 |

- **§7-A**：**76 条全部带 `since=`**（74 + 新入 2，日期 2026-11-05）⇒ 口径④「30 天未立项自动入池」**字段已就位**（尚无脚本执行）。
- 回归：`test:docs` 0 · `guards:repo` **0（92 段）** · `size-caps` 0。提交 `8632a9c6`。

## 方法论沉淀
(53) **「清空主表」的正确姿势是给机制证据，不是给判断**：两条判「设计说明」的条目都给出了「为什么无害」的可观测事实（密列 0 命中 / 硬校验兜住），而不是「我觉得没问题」。**判断可以被下一个人的判断推翻，机制证据不能。**

## 未收口（按优先级）
1. **`ssrf-parity` 探针不可靠**（R33 时 `node scripts/check-ssrf-deny-parity.mjs` ⇒ exit 1 但语义未明）—— **一个安全守卫的判定结果没人能解释，是比缺陷更糟的状态**。下轮主靶。
2. 真机并发轴：`rolloutBatchClaimId` 真机未测（R30 降级）；`agent_approvals` consume 未压。
3. 口径④的「30 天筛选」尚无脚本（`since=` 已就位）—— 小活，可并入任意轮。
4. R18-B 三条重启条件（§7.19，blocked）。
5. `EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；`UPGRADING.md` 头部基线；§7.17 P3；web 侧 `.env`；python 通过数（需改 pytest 配置）。

## 下轮第一步（R36）
1. `git log -1 --oneline` 确认 `8632a9c6`（**自己跑**）；
2. 立项 **`ssrf-parity-probe-reliability`**：查清 `check:ssrf-deny-parity` 的 exit 1 到底意味着什么：
   - **先复现**：跑它并**完整解释**退出码来源（哪条判据、比对的哪两侧、差异是什么）—— 若它其实**是对的**（例如确实有真实差异），把它变成一条**可读的失败**（点名差异 + 怎么修）；
   - **若探针本身有 bug**（例如 R33 观察到的「口径不可靠」）⇒ 修探针，判据 = **注入一个已知差异 ⇒ 探针必须红且点名**；**无差异 ⇒ exit 0**；
   - **顺带**：把口径④的「30 天筛选」做成 `npm run backlog:stale`（**不接链**，纯手工工具），一行 `node -e` 即可；
3. 判据：探针可信 = 「有差异必红且点名 + 无差异必绿」两侧都实测；回归 `guards:repo` 0（92 段）· `test:docs` 0 · `size-caps` 0。

## 纪律速记
- 主会话 ≤8 次调用/轮；只读本卡 + 手册 + git 摘要。本轮实测 6 次。
- **只信命令 + 真实 exit code**；回执会错归因、我会错摘要（㊱）、别编 sha（㊲）、ADR 也会错（R15）、压测会假绿（R16）、不等式证据要审时起点（㊸）、与自比对是假绿（㊹）、换载体先 grep 读者（㊺）、「恰好碰不到」不是判据、不为对称而对称、判据会误报（R25）、先校准尺子（㊼）、没测成≠测得坏（㊽）、总量变大看分母（㊾）、只报现象的门禁会被当噪音（㊿）、断言源码文本要登记、基线是退步可判定的前提、不可靠探针不能当判据、规范没稳定前别上机读守护、**清空 backlog 要给机制证据（53）**。
- 未跑标 `unverified`；`git add`/`checkout` 只用显式路径，禁 `-A`；每单元一提交。
