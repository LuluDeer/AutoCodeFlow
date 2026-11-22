# R447 独立验收：task-form-affinity 并发超时 flake 修复复核

**验收人**：r447-flake-verify（独立子 agent） · **时间**：2026-11-22 04:38–05:05 CST
**对象**：`apps/admin-web/src/__tests__/task-form-affinity.test.tsx`
**最终交付版**：sha256 `76cea21bcb19733e1e9e59716c209dfc87e40aaf136a24b91f8c63612890bc3d`（前16 `76cea21bcb19733e`，mtime 04:51:05，15016 bytes）
**方式**：CodeGraph CLI 先探查 → 逐字 diff → 探针单跑定位卡点 → 全量 2 次（独立）→ 双手法反证 → 字节级还原 + sha 基线比对
**写域**：仅本文件；未改 test/config/生产代码/baseline

## 逐条结论

1. **timeout 未加大、断言未放宽 — 通过（无 P0）**。
   - `15_000` 显式 timeout：改前 7 处、改后 7 处（`git show HEAD:file | grep -c 15_000` = 7；工作区 = 7），逐处行号/数值未变：189/203/220/252/282/294/309 各 `}, 15_000)`。无删除显式 timeout 后靠全局默认变相加大；`vite.config.ts` 的 `testTimeout: 30_000` 未动（git diff 空）。
   - 业务断言全部原样保留，仅包进 `waitFor` 等状态落地：broadcast 后 `classList.contains('ant-select-disabled')).toBe(false)`、pinned 后 `getByTestId('pinned-affinity-disabled')).toBeTruthy()` + disabled `.toBe(true)`、`buildExecutorPayload(...).toMatchObject(...)`、create/update payload 的 affinity/anti-aff tags、显式清空为 null、deploymentPolicy 保留、G6 runOnUpstreamFailure——逐字未改比较符/值。
   - 无 `.skip`/`.todo`/`.only`（grep 空）；12 个 `it()` 全部保留。
2. **根因对症 — 通过**。R445 handoff（AGENT_HANDOFF.md:35）只记录 `:203` 15s 超时现象，未定位。我用实现方临时探针版（sha d7ca2692）单跑独立复现：mousedown 时下拉已 `ant-select-open` 但 `.ant-select-item-option` 数 = 0（亲和标签由 `useTaskFormReferenceData.ts` useEffect 异步 `setAllTags`，非 react-query；共享 QueryClient 让 `findBy*` 秒回却证明不了选项就绪），`waitFor(getAllByText(tag)>0)` 首拍落在该窗口即空等到 15s 预算；`findByPlaceholderText('daily-report')` 两次探针均稳定（非卡点）。最终版修法正对该 await：`pickTag` 每拍检查下拉 open、未开补 mousedown 自愈（R445 python-wiring 同款），目标用例加 `findByPlaceholderText` + broadcast/pinned 状态 DOM 信号（已验证 `broadcast-pin-cleared` 是 production 既有 testid：`TaskFormExecutorSection.tsx:314`），不是全盘加 waitFor 掩盖。注释诚实写明「全量 350 文件并发 run3 实测 15s 超时、单跑 12/12 绿」与探针口径（open=true/option=0、0.3s→2.5~3s），与我的独立观测一致。
3. **全量不再假红（关键） — 目标用例两次全量均绿**。命令 `cd apps/admin-web && npm test -- --run`，两次均前后锁 sha=76cea21b（SHA_BEFORE==SHA_AFTER，未被反证/落盘污染）。
   - run1：04:51:53–04:58:16（383s），exit=1，350 files 中 2 failed/348 passed、2843 passed/2846；**目标用例绿 7508ms**（整文件 12 tests 32050ms）。
   - run2：04:58:16–05:01:20（184s），exit=0，**350/350 passed、2845 passed/1 skipped**；**目标用例绿 3981ms**（整文件 18491ms）。
   - run1 整体红的两个失败点与本切片无关：`task-form-page.test.tsx > 连点3次只发1个POST`（24828ms）、`task-form-ui06.test.tsx > 创建成功后 Glue 区块解锁`（16023ms），均为超时假红形态；发生于我全量与实现方第 1 次全量并行期间（383s vs 184s，负载近翻倍），属并发噪声，非目标用例、非本次 diff 因果（forks 池每文件独立进程，目标文件 diff 不涉及这两处）。run2 单实例全量整体绿，坐实「全量不再假红」在隔离跑下成立。
4. **反证有牙 — 通过（两种独立手法）**。
   - 实现方手法：临时翻 broadcast 后 disabled 期望 false→true，单跑 exit=1、`AssertionError: expected false to be true`，失败用例正是目标用例；还原 sha=76cea21b 一致。
   - 我的独立手法：临时翻 pinned 后 disabled 期望 true→false（mutated sha 6c6ba205），单跑 exit=1、目标用例 `AssertionError: expected true to be false`、1 failed/11 passed；从最终版备份逐字还原，sha=76cea21b 一致。两条核心业务断言（放亲和可用 / pinned 禁用）均有牙；写到 waitFor 内也不会吞掉真失败。
5. **无越界 — 通过**。开工时记录 sha 基线清单（`apps/admin-web/src/__tests__/*.test.*` + `vite.config.ts` + `test-setup.ts` + `TaskFormPage.tsx` + `executor-mode.ts`），最终 `sha256sum -c` 仅目标文件 FAILED（即仅它变化）；`git diff --name-only` 中 vite.config.ts/test-setup.ts/TaskFormPage.tsx/executor-mode.ts/useTaskFormReferenceData.ts 均为空；无新增 affinity 相关 untracked 工件。R447 期间生产代码、其它测试、config、baseline 零改动。

## 缺口分级

- **P0**：无。timeout 未加大、断言未放宽、无 skip。
- **P1**：无。目标用例 2 次全量绿 + 两手法反证有牙 + 根因对症。
- **P2**：① run1 整体 exit=1（两处无关 flake，并发双跑放大所致）；「全量整体绿」由 run2 单实例坐实，但并发双跑下其它文件的既有 flake 未系统性穷尽（与 R444/R445 同类、非本切片写域）。② 实现方会后再跑其第 2 次全量确认（结果见文末补记）。
- **P3**：目标用例 run1 7508ms（15s 预算内，余量 ~2×），极端负载下仍非完全零风险；但相对修复前 15s 硬超时已是量级改善。注释中「useTaskFormReferenceData.ts:102-119/199」行号引用在 CURRENT 树中起始 useEffect 为 :102、setAllTags 为 :116（文件已迁至 `src/hooks/`，注释省略目录），方向正确、行号轻微漂移不影响结论。

## 建议

**建议关闭本切片**。铁律三条全部守住：timeout 数值/数量原样、业务断言原样（仅等状态）、无 skip；根因对症（补 mousedown 自愈 + DOM 就绪信号，非全盘 waitFor）；目标用例 2 次全量真跑均绿、两种独立手法反证转红且还原 sha 一致、写域零越界。run1 的两处无关 flake 单独记账，不构成本切片缺陷。

## 补记：实现方第 2 次全量

实现方 r447-affinity-flake-fix 在其第 2 次全量（我 2 次全量结束后单实例启动，sha 前后均 76cea21b）：exit=0，350/350 files、2845 passed/1 skipped（2846），Duration 180.87s；目标文件 12/12、目标用例 4055ms 未超时。另报其第 1 次全量（与我并行、负载翻倍 387s）exit=1，失败点是 `task-form-page.test.tsx:848` 15s 超时，目标用例 9021ms 绿——与我 run1 的观察同型：双全量并发下偶发无关文件假红，隔离单跑全量均整体绿。实现方另报单跑 12 passed exit=0、eslint exit=0。三方证据收敛，无相反证据。
