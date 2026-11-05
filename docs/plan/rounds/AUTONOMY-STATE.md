# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **并行流水线 5 worker（人工指令）** · 守卫链 93 段
**会话**：第 62 轮 · 并行第 2 批已全部落地

## 本轮并行交付（全部已入 HEAD）
| 席位 | 交付 | commit |
|---|---|---|
| W2 `web-worker` | 计数自相矛盾提示 + 卡片外提 `RunningMetricsCard`（**棘轮靠外提消解**：页面 874→837、函数体 1011→967，均回到上限内） | `2fa2230b` `b764ab92` `10b26864` |
| W5 `node-worker` | **真缺陷**：心跳上报只有下界归一、上界敞开 ⇒ 脏 provider 原样出网；修后 `0≤reserved≤running`（21 passed，相邻 50 passed） | `d9a67536` |
| W1 `guard-chain` | ADR 结构断言并入 `check-docs`（覆盖 adr-031+，三组红→绿；恒真改造⇒变绿证有牙）；**祖父条款**：adr-001..030 暂不套用（未偷偷降标） | `9e59bcd9` |
| W3 `api-worker` | ADR-031 + **步骤 1 修复**：台账写入目标收成一个判据 —— 已批准调用被**新 id 重提**不再丢在途行/残留 `awaiting_approval` | `7385fd7d` `a358d6e1` |
| W4 `py-worker` | 元数据地址恒拒在 python 闸门钉死（33 条用例，清单逐字读契约，无地址副本）；**并发现实现缺陷**：闸门未消费恒拒表 | `280b42cb` |

## ⚠ 本轮最重要的发现（W4，已派 ADR）
python 闸门在**开关开启**时仍放行 `cgnat / linkLocal / multicast / reserved / unspecified`，**含 AWS 元数据 `169.254.169.254`**；契约 `switch.semantics` 与 node/admin 的 `category_allowed` 都不放行这些类，且该行为被 `tests/test_execute.py:3618` **钉在相反方向**。⇒ **同一份契约、三端两种安全承诺**，属契约级变更 ⇒ 已派 W4 写 **ADR-032**（本轮只写设计，不落地）。

## 待办（下轮）
1. W3 的修复需 Lead 复核 + 收敛 `check:size-caps`（**当前全局 5 处违规全在 admin-api**：`tool-executor.service.ts` 919>876、spec 1447>1370 等，W3 写域）⇒ 要么让其收敛，要么由我**代签并写明 why 与回滚值**。
2. W1 的 B 项未做（`expectRequiredFixtures` 推广到其余 4 个守卫）+ 新 ADR 判据缺自检夹具。
3. 收 ADR-032 → 复核 → 再排实施轮。
4. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked；flaky 待复发取证；`EXECUTOR_TOKEN_EPOCH_MODE=on` 待运维；W5 遗留（服务端无 `reservedSlots<=running` 下限）。

## 纪律（并行版，继续生效）
只信「命令 + 真实 exit code」；未跑标 `unverified`；断言必须能失败（恒真⇒必须变绿才算有牙）；文档断言**命令形式**而非关键词；改 `ci.yml` 后立刻 `guards-wired`；验收用链内同形式；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；禁 `pkill -f`；**worker 只跑定向测试**，全量/93 段链由 Lead 在“无在途改动”时串行跑。
