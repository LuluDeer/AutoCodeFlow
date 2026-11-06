# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · ⚠ **链红在 11/100 `check:actions-pinned`**（新 job 的可变引用）
**会话**：第 134 轮 · 并行第 64 批

## 本轮落地
1. **flaky 观测通道上线**（`e6c8a8b4`，W1）：新 job **`web-flake-watch`**（`if: schedule || workflow_dispatch`、**`continue-on-error: true` 不阻断合并**、`timeout-minutes: 60`）——admin-web 全量**跑两遍**（`--maxWorkers=2`），**每次运行单独存日志并带 `EXIT_N`**（便于与基线的 `signal` 对照），`actions/upload-artifact` 保留 14 天。
   - **两个有意设计**：① **不加 `--retry`**（retry 会把 flake 变成"看起来稳定"，正是这条通道要避免的）；② **日志按运行分开存**（能一眼看出"第几次运行被终止"）。
   - `actionlint` 未安装 ⇒ 用 **PyYAML 结构校验**（YAML 有效、`jobs` 39 个、`continue-on-error`/`timeout` 可确认）；`ci.yml` 内 `docker rm -f` 计数 **0**（无前缀清理隐患）。
2. **我裁决：monthly → nightly**（`cron: '20 3 * * *'`）——月度采样对偶发 flake 几乎没有诊断价值（R53 至今只见过一次，12 样本/年大概率错过复发窗口）；nightly 一年 365 样本、且不阻断合并 ⇒ 成本 ~20 分钟/天可接受。

## ⚠ 当前红（已派 W1 一并修）
`check:actions-pinned`（第 11 段）报**新 job 的 3 处可变引用**：
`ci.yml:2772 actions/checkout@v4` / `:2773 actions/setup-node@v4` / `:2801 actions/upload-artifact@v4` —— 守卫要求**固定到 40 位 SHA**（并给了 `gh api … --jq .sha` 的精确修法）。
**我给的补法**：优先**复用仓库既有已固定引用的同款 SHA**（`grep "actions/checkout@"`），**不许凭记忆写 SHA**（纪律：不编造 sha）。

## 剩余 backlog（3 条，性质已明确）
- `ci-pg-race-unverified`：本地不可解（需 CI 真跑；已接线 + 本地有 PG 时 2/2 实测）；
- `web-flake-not-reproduced`：**本轮已推进**（观测通道已上线）——它不会"修好"，只能"下次复发时能查"；
- `release-notice-ops`：属运维动作（公告已写在 `docs/RELEASE-NOTES-ssrf-posture.md`）。

## 教训（累积，本轮新增）
**加 CI job 会同时踩到仓库既有守卫**（`check:actions-pinned`）—— 新 workflow 片段的 action 引用必须与既有惯例一致（固定 SHA）；**flake 通道不许用 `--retry`**；**采样频率要匹配问题的时间尺度**（偶发 ⇒ nightly，不是月度）；**不编造 sha（包括 action SHA）**。

## 方法学（累积）
只信「命令 + 真实 exit code」；**否证一个提法比实现它更有价值**；**「现在没坏」≠「可以拆」**；**零回填要用「迁移前就存在的行」证明**；**写域边界 = 停手 + 给可粘贴内容**；**「判据没红」≠「问题不存在」**；**判据要盯正确对象**；**否决条件只对真判据生效**；**台账按证据记**；**测量工具会撒谎**（累计 5 次）；**同一列两种相反语义会互相抵消**；**不变量有适用范围**；**没有 dump 不归因产品**；文档与实测要对账；验收用链内同形式；收紧判据后复验原反例；守卫防「先咬自己」；**守卫头注要与实现一致、盲区要写出来**；**生成物不手改**；**元数据也会撒谎**；**行为判据 ≠ 接线判据**；**flake 不许 retry 掩盖**；**采样频率匹配时间尺度**；前缀式清理/固定临时路径是并行互杀源；样本量不足的绿不算绿；「期望值同源」≠ oracle 成立；假 oracle 要删；抖动段不挂门禁；基线撞上限不许调上限；**基线只来自真跑**；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；**不编造 sha**；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
