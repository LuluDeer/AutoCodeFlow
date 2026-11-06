# AUTONOMY-STATE — 状态卡（≤40 行）

**基线**：以 `git log -1` 为准 · **5 worker 并行** · ⚠ **链红在 12/100 `check:runner-labels`**
**会话**：第 135 轮 · 并行第 65 批

## 本轮落地
1. **action 引用已固定**（`7c23f939`）：三处可变引用全部固定到 **40 位 SHA**，且**来源是复用仓库既有已固定引用**（`grep -rhoE "actions/(checkout|setup-node|upload-artifact)@[0-9a-f]{40}"`）——**没有编造 sha**（本机无 `gh`、无联网）。
2. **cron 已改 nightly**（`'20 3 * * *'`，注释写明为何不用 monthly）+ **`meta.txt`**（`date`/`head`/`node`/`swap`/`event`）随 artifact 上传 14 天；保留**不加 `--retry`**、每次运行日志单独存带 `EXIT_N`。
3. `check:actions-pinned`（链内同形式）⇒ **exit 0**；YAML 解析 OK、job 数 **39** 未变。

## ⚠ 当前红：**同一个 job 的第二关**
```text
✖ runner 标签守卫失败（1 项，扫了 10 个 workflow / 60 处取值）：
  · ci.yml:2769: runner 用了可变的 `ubuntu-latest` —— 改用固定版本（如 ubuntu-24.04），或在 ALLOW 里登记理由+复查日
```
⇒ 已派 W1：**与仓库既有惯例一致地**换成固定版本（先 `grep runs-on` 看别的 job 用什么，**别自选新版本**）；并要求**这次一定把 `guards:repo` 跑到尾**（前两次都卡在 11/12 段）。

## 教训（本轮新增）
**加 CI 片段会连续踩到多条既有守卫**（`check:actions-pinned` 第 11 段、`check:runner-labels` 第 12 段）—— **改动 workflow 片段后应先按链内顺序跑这两个守卫再提交**（W1 已确认这条要变成习惯）。
另外：**SHA/版本类引用一律从仓库既有惯例复用**，不要自己"选一个更新的版本"（会让同机不同 job 行为不一致）。

## 剩余 backlog（3 条，性质已明确）
- `ci-pg-race-unverified`：本地不可解（需 CI 真跑）；
- `web-flake-not-reproduced`：**已推进**（`web-flake-watch` nightly 观测通道上线，不阻断、无 retry）——它不会"修好"，只能"下次复发时能查"；
- `release-notice-ops`：属运维动作。

## 方法学（累积）
只信「命令 + 真实 exit code」；**否证一个提法比实现它更有价值**；**「现在没坏」≠「可以拆」**；**零回填要用「迁移前就存在的行」证明**；**写域边界 = 停手 + 给可粘贴内容**；**「判据没红」≠「问题不存在」**；**判据要盯正确对象**；**否决条件只对真判据生效**；**台账按证据记**；**测量工具会撒谎**（累计 5 次）；**同一列两种相反语义会互相抵消**；**不变量有适用范围**；**没有 dump 不归因产品**；文档与实测要对账；验收用链内同形式；收紧判据后复验原反例；守卫防「先咬自己」；**守卫头注要与实现一致、盲区要写出来**；**生成物不手改**；**元数据也会撒谎**；**行为判据 ≠ 接线判据**；**flake 不许 retry 掩盖**；**采样频率匹配时间尺度**；**改 CI 片段先跑 actions-pinned/runner-labels**；**版本与 SHA 复用仓库惯例**；前缀式清理/固定临时路径是并行互杀源；样本量不足的绿不算绿；「期望值同源」≠ oracle 成立；假 oracle 要删；抖动段不挂门禁；基线撞上限不许调上限；**基线只来自真跑**；一次只改一个文件；定位代码块只用 CodeGraph；断言源码文本必须登记；**不编造 sha**；`git add` 显式路径；遇 `index.lock` sleep 2s 重试；**禁 `pkill -f`**。
