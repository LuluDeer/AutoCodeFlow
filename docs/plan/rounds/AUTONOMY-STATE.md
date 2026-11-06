# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 96 段全绿** · 工作区干净
**会话**：第 92 轮 · 并行第 28 批

## 本轮落地（HEAD）
1. **ADR-034 步骤 2/3 完成**（node `b1dac485`+`259674d1` · python `87f87fc8`）：
   - **node**：`categoryAllowed`/`verdictForAddress` 增 `unlockedUnderSwitch` 入参，**由调用方注入生成物** `ALLOWED_UNDER_PRIVATE`（`ssrf-guard.ts:91/:188`、`git-repo-network-policy.ts:219/:276`），**纯模块仍 0 import**；默认值改用 `DEFAULT_UNLOCKED_UNDER_SWITCH`（契约值兜底）并由新 spec **4 例钉死「兜底 ≡ 生成物 ≡ 契约」**（漂移即红）。并发方另加的重复字面量已改为**单向别名**（消除第二份真理）。
   - **python**：`network_policy.py` 从 `generated/protocol_categories.py` 导入 `CATEGORY_ORDER`/`ALLOWED_UNDER_PRIVATE`；`category_allowed` **不再硬编码 `"privateIPv4"`**，未知类别 **fail-closed**；**不内置兜底副本**（三种运行方式都能 import 生成物，兜底只会多一个漂移源）。
   - **标签差异数：4 → 4（未变）** —— 两侧逐侧对拍证实**node/python 本就不是差异源**；残留 4 条**全在 admin 粗标签**（`0.0.0.0`/`::` ⇒ `reserved` vs `unspecified`；`224.0.0.1`/`239.255.255.250` ⇒ `reserved` vs `multicast`）。
   - `cross-end` **exit 0（74 格）**；行为零变化（node 831 passed / python 1980 passed）；`protocol-sync`/`size-caps`/`guards-wired` 0。
2. **修 digest 过期**（`34acf5bd`）：R90 新增 node 生成物使 bundle 输入从 ? → **59 个文件**；回填后 `check:desktop-bundle-drift` **exit 0**，全链 **96/96 exit 0**。

## flaky 狩猎结论（W2：3/3 未复现，但挖出 3 个「测量工具撒谎」缺陷）
1. `health-snapshot.mjs:55` `code = r.status ?? 1` ⇒ **SIGTERM/OOM 被杀记成 exit 1**，与真失败**同形**，且从不记 `r.signal`；R53 台账 `exit 1`+`passed=—` 正是被杀签名。
2. `vitestSummary()` 只匹配 `Tests N passed`，实测 `Tests 2 failed | 5 passed (7)` 返回 **null** ⇒ **一有失败就丢数字**。
3. **admin-web 那步没加 `--maxWorkers=2`**（admin-api 两处都有；swap 现 98.7%）。
另：`settings-page-b0-branches.test.tsx` 的 `mockRejectedValue` 产生 **4 条数量恒定的浮空 rejection**（确定性噪声，被 `dangerouslyIgnoreUnhandledErrors` 全域豁免）。

## 在途
- **W3**：ADR-034 步骤 4 —— admin 按契约 `endLabels` 拆细粗标签，目标**标签差异 4 → 0**（若 `endLabels.admin` 仍是粗的 ⇒ 先补契约键，不许自造）。
- **W1**：修上述 3 个测量缺陷（记 signal / 修正则 / web 加 `--maxWorkers=2`），三件各自红→绿。

## 待办
1. 收 W3（4→0 是 ADR-034 收口判定）与 W1（测量修复）。
2. ADR-034 步骤 5：`CATEGORY_ALIASES` 退役 + 「契约段是唯一来源」的守卫。
3. 浮空 rejection 纪律：`dangerouslyIgnoreUnhandledErrors` 是否该收窄到具体用例（需评估 24 处影响）。
4. 未收口：真机脚本接链（需 CI postgres）；R18-B blocked。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**中间信号（标签差异数）是验收核心**（4→0 才对；提前变 0 说明派生写错）；**兜底常量必须与生成物逐字一致 + 双向/三向钉住**；**标签也是对外接口 ⇒ 变更前查依赖面**；**并发方在同一文件加的第二份字面量必须消重（单向别名）**；**「测量工具会撒谎」是本会话反复出现的坑**（R33/R54/R69/R91）：未记录 signal、正则匹配不到失败行，都会让台账给出错误结论；**flaky 不许 retry 掩盖**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
