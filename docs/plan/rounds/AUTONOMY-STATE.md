# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · **守卫链 97 段全绿** · 工作区干净
**会话**：第 94 轮 · 并行第 30 批

## 本轮落地（HEAD）
1. **ADR-034 收口**（`8988fdbe`，链 **96 → 97**）：新守卫 `check:categories-single-source` 三条判据——
   - ① **禁硬编码类别→放行映射**（只匹配契约 `categories.order` 成员，避免误判普通 `allowed: false` 字段；`// allowed-literal:` 豁免）；
   - ② **生成物 = 契约**（`CATEGORY_ORDER`/`ALLOWED_UNDER_PRIVATE` 与 `categories.order`/`allowedUnderPrivateNetwork` 逐字比对，不等即点名两侧值）；
   - ③ **三端覆盖**（admin/node/python 必须出现「引用生成物 / 由调用方注入」痕迹）。
   - **红演示**：node 实现副本加 `const HARDCODED = { "multicast": true }` ⇒ exit 1 点名 `[node] …:532 出现硬编码类别→放行映射`；真仓库 exit 0；**反向验证**（判据①改恒假 ⇒ 红消失）+ **注入源缺失 ⇒ 明确报错不回落**。
   - **如实边界**：判据③是**静态特征**（挡「完全不引用生成物」），挡不住「引用了又自己硬编码一份」——**后者由判据①兜住**，两者组合已覆盖 ADR-034 的实际失效模式。
   - 链 **97/97 exit 0**（Lead 独立复验，`grep -c` = 97）。
2. **体检器三谎已修**（`9a4a384d`，上批）：`killed: SIGTERM` 与 `exit 1` 不再同形、`vitestSummary` 表驱动 5 例（失败行可解析）、web 步 `--maxWorkers=2`。

## 在途
- **W1**：**全量体检**（上次全量 R53，已过 24 轮）—— 目的 = 把新 `signal` 字段带进基线 + 给真实 delta；若被 SIGTERM **如实报 `killed: SIGTERM`**（正是新字段要表达的），不许用预期值填表。
- **W3**：ADR-034 遗留清扫 —— 找残留的「第二份真理」（`CATEGORY_ALIASES` / 本地副本 / 重复兜底常量）；**只做零行为变化的最小清理**，若判断不值得清理可零改动（附清单与理由）；并要求**反向验证**「改回副本改值会不会有人咬住」。

## 待办
1. 收 W1（体检 delta）、W3（第二份真理）；W2 的浮空 rejection 评估仍在（上批派出，未见回执）。
2. 未收口：真机脚本接链（需 CI postgres，本地无法验证 CI 真跑）；R18-B blocked；ADR-031 步骤 4/5（`execute` 余下审批状态机，事务边界不跨函数）。

## 纪律（并行版）
只信「命令 + 真实 exit code」；未跑标 `unverified`；**「契约键写错」与「映射写粗」是两层**；**allow-list 与枚举黑名单对新增标签的反应相反**；**中间信号（标签差异 4→0）是验收核心**；**兜底常量必须与生成物逐字一致 + 钉住**；**静态特征判据只能挡一类失效**（要写明它挡不住什么）；**注入源缺失必须报错**；**测量工具会撒谎**；**链必须在无在途改动时跑**；作者中断≠改动作废；一次只改一个文件 + `node --check`/`tsc` + 失败即回滚；定位代码块只用 CodeGraph；断言源码文本必须登记；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
