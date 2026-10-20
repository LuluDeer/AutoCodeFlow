# 待决策清单（OPEN DECISIONS）

> 本文件只放**需要人拍板**的事，不放已完成的工作（那些在 `PLAN-CLAIMS.md` 的按轮记录里）。
> 每条都带**证据出处**与**两个选项的代价** —— 目的是让决策可以在 5 分钟内做完，而不需要重读整本板子。
>
> 排序：先放「现在就在影响行为」的，后放「只是不一致、暂不影响」的。

## A. 现在就在影响正确性 / 用户体验

### A1. FIRE_ONCE 补偿要不要把「窗口内存在任何执行」当成已覆盖
- **现象**：手动触发不推进 `lastTriggerTime`，于是「手动跑过一次之后」补偿扫描仍可能再补派一次。
- **证据**：`PLAN-CLAIMS.md` R130（三场景表）、R133（claim 原子性复核）。
- **选项**：① 保持现状（严格 cron 语义：手动跑 ≠ 服务该计划点）；② 补偿前查「窗口内有无执行」（运维语义：人已经跑过了）。
- **代价**：② 每次候选多一条索引查询；① 保留一次多余执行。

### A2. 四个 Python 库（`autocodeflow-{ai,http,notify,db}`）接发布线还是删除
- **现象**：有源码 + 测试 + pyproject + CHANGELOG，但**不在** version-guard、**不在** publish 矩阵、版本冻结 `0.2.3`、**仓内零消费者**。
- **证据**：R135（现状表）、R136（守卫）、R134-A1（已修 6 处缺陷 + 20 条用例）。
- **选项**：① 接进 PyPI 发布线（补 version-guard + 矩阵 + 文档 + 版本归位）；② 删掉。
- **代价**：① 一条发布流水线 + 版本线决策；② 丢掉 `R134-A1` 那批已写好的回归用例。
- **守卫**：`check-publishable-wiring.mjs` 已把这条**钉成红灯风险**（新增第五个这样的包会立刻红）。

### A3. `acf-cli` 那 7 个破坏性命令要不要加确认门（以及加到什么程度）
- **无门候选**：`task kill` / `task rollback` / `task webhook rotate·disable` / `apikey revoke` / `executor offline` / `deploy stop`。
- **证据**：R193（`apikey revoke` 自述 cannot be undone 却零确认）、R195（我的文件级计数方法太粗，按命令枚举才发现 7 处）、R198（退出码/确认门设计本身是好的，应复用）。
- **建议分级而非一刀切**：不可逆的（`apikey revoke`）必须有；可重跑的（`task kill`）**加了反而让自动化变笨**。

## B. 跨语言/跨包语义不一致（两边都自洽，合起来不齐）

### B1. 两个发布 SDK 的重试语义不同
- **现象**：node 的 `HttpClient` 默认对幂等方法重试（含熔断、`Retry-After`）；python 的**完全无重试**（文档已如实写明）。
- **证据**：R180（发现）、R183（python README 修正）、R191（node 回调等待封顶 5s）。
- **现状**：已在两边 README 互相指认（`R182`/`R183`），**用户可读到**，但仍会踩。
- **选项**：① 保持（各语言按各自习惯）；② python 加重试（= 改变既有任务失败时机）。

### B2. 配置错语义两包相反：`from_env()` 不抛 / `fromEnv()` 抛
- **现象**：python 侧 `execution_id` 默认 `unknown` 且继续跑，回调可能带着 `unknown` 发出去；node 侧直接抛。
- **证据**：R177-A1 遗留 1。
- **代价**：统一 = **破坏性变更**，需要 deprecation 周期。

### B3. 熔断能力不对等
- node 有 breaker（且**跨端点共享**，回调连续失败会顺带阻断无关 GET）；python 没有。
- **证据**：R177-A1 遗留 5。

## C. 已接受但值得知道的风险

| 项 | 状态 | 出处 |
|---|---|---|
| 渠道配置 **明文落库**（`notification_channel_configs`） | ADR-028 明确接受（附四条重开条件） | ADR-028 / R150-A1 |
| system-config 密钥静态明文 | 同上 | ADR-028 |
| python 侧**嵌套 zip >64 MiB 仅 warn**（admin 是 fail-closed） | 未统一 | R94 |
| Slack / Feishu **path 型凭据**日志不掩（掩 path 会破坏「掩码回传保存」） | 有意保留 | R150-A1 |
| node `isNetworkLevelError` 白名单可能漏 `EPIPE` 类 | **未实测**（需真 socket 半关） | R177-A1 遗留 4 |

## D. 小决策（一句话可拍）

- **D1**：`acf app create --json <body>` 这个 **DEPRECATED 旗标**要不要删？它污染了 `isJsonInvocation` 的探针判断（R196）。删 = 兼容性变更，收益是「按名字做的判断不再误命中」。
- **D2**：`acf task kill` / `rollback` 要不要补 `--json`？它们现在只能人读，而 `task list` 可以机器读（R197）。`approval approve/reject` 不用补（输出就是一句确认）。
- **D3**：`task kill` / `rollback` 的 `process.exit(0)` 要不要统一成 `process.exitCode`？只在大输出 + 管道时可能截断（R194）。
- **D4**：66 个未分类错误码要不要加第 7 类，或改成域级提示（R108）。

---

## 已结案（无需决策，列出以免重复讨论）

- **6 字段 cron 的「静默降级」**：已证明**不可达** —— 四条写入口全部收口在 `normalizeTaskDto`，非 5 字段在落库前就被拒（R131）。
- **四个库是否导出异常类型**：已修，且 `R134-A1` 是错误面修复，不是设计问题。
- **DST 语义**：`R126-A1` 的实测声明**未被独立复核**（我试了三次未能复现），但仍记在账上，不下结论。
