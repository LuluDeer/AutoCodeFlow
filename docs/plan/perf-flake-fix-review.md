# R444 独立验收：性能红线假红修复复核

**验收人**：r444-perf-verify（独立子 agent） · **时间**：2026-11-22 03:23–03:52 CST
**对象**：`apps/admin-web/src/__tests__/maintenance-window-parity.test.tsx` 性能 describe
**方式**：CodeGraph MCP/CLI 先探查 → 逐字 diff → 真跑全量 4 次 → 双手法反证 → 字节级还原
**写域**：仅本文件；未改 test/config/生产代码/baseline

## 版本时间线（实现方在我验收期间多次落盘）

| sha256 前 16 | 时间 | 内容 |
|---|---|---|
| `50dc27c2c1422784` | 开工时 | 修复前 best-of-3 |
| `39d5700d…` | 03:25:19 | best-of-9 + 提前停止 20ms |
| `e2473e7f…` | 03:34:52 | CPU 口径中间调试版（占位符 + DEBUG 日志） |
| `c7123947…` | 03:36:40 | **CPU 口径候选最终版**（本次全量验收对象） |
| `a7901f4d…` | 03:50:33 | 在上一版基础上仅加 `[DBGWALL]` 日志（反证对象之一） |

## 逐条结论

1. **阈值未放宽 — 通过（无 P0）**。最终版 `:438` 仍为 `toBeLessThan(CPU_LIMIT_MS)`，`CPU_LIMIT_MS = 50`；数值 50、比较符 lessThan 原样。无 `<=`、无调高、无 `.skip`/`todo`/条件跳过。口径从墙钟换成 CPU user time 后阈值含义变化：我实测 CPU 基线 10.59–34.90ms（多跑中位数约 20ms），50ms 上限对应 1.4–4.7× 余量，对比 R282 墙钟 13.07ms→50ms 的 3.8× 属同量级或更严，**未变相放宽**。
2. **采样口径合理 — 通过**。`CPU_SAMPLES = 5`，`cpuMs = Math.min(cpuMs, sample)` 确实取最小值；`process.cpuUsage()` 差值 user µs→ms；注释诚实说明 5 次取最小是为滤 CPU 记账抖动而非掩盖并发；fail-closed 两条（`typeof process?.cpuUsage`、`Number.isFinite && ≥0`）齐备，无降级/无 skip。
3. **全量不再假红 — 目标用例通过**。最终版 `c7123947` 串行真跑 2 次全量，目标用例两次均绿：**run3 PERF 27.33ms**（samples 51.0/37.8/27.3/31.2/32.3）、**run4 PERF 18.41ms**（69.5/25.0/23.0/18.4/23.5），均稳定在 50ms 下。run4 整体 exit=1 但失败点是**另一个**测试 `python-multiversion-form-wiring.test.tsx:347`（`vi.fn()` 调用 0 次，典型并发 flake），与目标用例无关。
4. **断言有牙 — 通过（两种手法交叉验证）**。
   - 耗 CPU 忙等（每 task 注入 4ms CPU 忙等，非 sleep）：PERF **92.56ms** > 50 → 转红；还原 sha 一致（`c7123947`），复绿 10.59ms。
   - tasks 20→200（并同步长度断言）：PERF **103.32ms** > 50 → 转红；还原 sha 一致（`a7901f4d`），复绿 34.90ms。
5. **无越界 — 通过**。R444 期间仅目标 test 文件被改（mtime 03:36:40/03:50:33）；`git diff -- apps/admin-web/vite.config.ts` 为空；未碰其它测试、生产代码、baseline。
6. **测试不变成负担 — 通过**。3 次预热 + 最多 5 次采样，性能用例本身墙钟量级 ~100–200ms；单文件 40 例整跑 11.07s，无秒级新增开销。

## 关键证据：墙钟口径确实不够（换口径的必要性）

同一 best-of-9 代码两次全量：**run1 红 61.94ms（9/9 samples 全被抢占）/ run2 绿 23.82ms（9/9）**。3 倍波动坐实 OS 抢占，多采样取最小在 350 workers 无上限 forks 池下不可靠；`process.cpuUsage()` 是正确方向。

## 全量数据（命令 `cd apps/admin-web && npm test -- --run`）

| run | 版本 | 起止 | exit | 套件/用例 | 目标用例 PERF |
|---|---|---|---|---|---|
| 1 | `39d5700d` best-of-9 | 03:25:09–03:30:57 | 1 | 1 failed/349 passed；1 failed/2844 passed/1 skipped | **61.94ms 红** |
| 2 | `39d5700d` best-of-9 | 03:31:19–03:35:09 | 0 | 350 passed；2845 passed/1 skipped | 23.82ms 绿 |
| 3 | `c7123947` CPU | 03:37:23–03:43:37 | 0 | 350 passed；2845 passed/1 skipped | **27.33ms 绿** |
| 4 | `c7123947` CPU | 03:43:51–03:49:44 | 1 | 1 failed/349 passed（**另有 flake**） | **18.41ms 绿** |

run1/run2 启动瞬间文件 sha 与结束时不同（实现方并发落盘），但日志行号与 `best-of-9` 打印证明执行的是新代码；run3/run4 SHA_BEFORE == SHA_AFTER，为干净数据。

## 缺口分级

- **P0**：无。
- **P1**：无（目标用例 2 次全量绿 + 双反证有牙）。
- **P2**：① 实现方 03:50:33 又加了 `[DBGWALL]` 日志（`a7901f4d`），与我全量验收的 `c7123947` 存在字节差异；若该版为最终交付，需再补 1 次全量。② run4 整体红来自 `python-multiversion-form-wiring` 的另一处并发 flake，非本切片范围，但"全量整体绿"尚未成立。
- **P3**：① 注释称 CPU 基线 11.17ms（余量 4.5×），我多跑实测 10.59–34.90ms（中位数约 20ms，余量约 2.4×）；数字应修正为实测区间，结论方向（未放宽/更严）不变。② 首次采样偶发 51–69ms（冷 JIT/GC 记账），best-of-5 能滤掉，但极端负载下 5 采样全高仍有残差风险。

## 建议

**建议关闭本切片**（修复成立：阈值未动、断言有牙、目标用例全量不再假红），前置两件小事：移除 `[DBGWALL]` 调试日志并对最终版补 1 次全量确认；修正注释中的 CPU 基线数字。另一处 flake 单独开切片处理。
