# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 96 段全绿** · 工作区干净
**会话**：第 93 轮 · 并行第 29 批

## 本轮落地（HEAD）
1. **ADR-034 步骤 4 完成：标签差异 4 → 0**（`7ee92e84` 单元A + `a891867f` 单元B）：
   - **根因比预想深一层**：admin 的**段表把契约键本身写成了 `reserved`**，所以只改 `endLabels` 不够（映射后仍是 `reserved`）⇒ **两处都改**才归零；
   - 单元A：契约 `categories.endLabels.admin` 拆细（`unspecified→unspecified`、`multicast→multicast`；`cgnat→restricted` 不动）+ 三端生成物同 commit；单元B：admin `AddressCategory` 加两值、`ADMIN_LABEL_FALLBACK` 拆细、**四条段表 risk 改契约键**，`safe-http.util.ts`/`outbound-posture.util.ts` 的校验集同步；
   - **唯一真行为风险点已覆盖**：三处 posture 都是 **allow-list**（新标签自动落拒绝），但 `registry.controller.ts:200` 的 `upstreamBlockedReason` 是**枚举式黑名单**——不显式加 `unspecified`/`multicast` 就会漏放，已补并写注释；
   - **反向验证**：把 `ipv4-multicast` 改回 `reserved` ⇒ 差异数 **2** 并点名 `224.0.0.1` / `239.255.255.250`；还原 ⇒ 0；
   - `cross-end` **exit 0（74 格）**；行为零变化 **2243 passed**（112 suites）、`tsc` 0；`sync`/`size-caps`/`guards-wired` 0。
2. **体检器三处测量缺陷已修**（`9a4a384d`，W1）：
   - `run()` 返回 `{code, signal}`，stderr 区分 `killed: SIGTERM` 与 `exit 1`，markdown exit 列被杀时写 `**killed: SIGTERM**`，分类抽成纯函数 `classifyStep`；
   - `vitestSummary()` **表驱动 5 例**：`Tests 2 failed | 5 passed (7)` ⇒ `{passed:5,failed:2,total:7}`（旧正则返回 null）；
   - web 步补 `--maxWorkers=2 --no-file-parallelism`（注释写清 R28 的 SIGTERM 实证 + swap 98.7%）；
   - 双向反向验证：去 signal 判定 ⇒ 2 条红；正则回退 ⇒ 失败行用例红；自检 **9/9**。
   - **如实说明**：`health-baseline.json` 现有 step 字段仍是旧的（本轮 `--skip-heavy` 沿用上次全量数据），**下次全量跑会自然带上 `signal`**。
3. **digest 回填**（`b67261d3`）：契约 endLabels 影响 node 生成物 ⇒ 回填后全链 **96/96 exit 0**。

## 在途
- **W1**：ADR-034 步骤 5 —— `categories-single-source` 守卫（禁硬编码类别→放行映射 / 生成物≡契约 / 三端覆盖），**96 → 97** 段。
- **W2**：浮空 rejection 纪律（`dangerouslyIgnoreUnhandledErrors` 全域豁免）——先评估三档，本轮只做最小安全档，**不许改宽断言**。

## 待办
1. 收 W1（单源守卫）⇒ ADR-034 收口；收 W2（浮空 rejection）。
2. 其余 backlog：真机脚本接链（需 CI postgres）；R18-B blocked；`CATEGORY_ALIASES` 退役（如仍存在）。
3. 下次例行体检要跑**全量**（让 `signal` 字段进基线，并把两端 `--maxWorkers=2` 的收益记进 delta）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**「契约键写错」与「映射写粗」是两层，改一层不够**（本轮实证）；**allow-list 与枚举黑名单对「新增标签」的反应相反**——加类时必须逐个检查黑名单；**中间信号（标签差异数 4→0）是验收核心**；**兜底常量必须与生成物逐字一致 + 钉住**；**测量工具会撒谎**（signal 未记 / 正则匹配不到失败行 / worker 超配）；**全局豁免会让纪律形同虚设**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
