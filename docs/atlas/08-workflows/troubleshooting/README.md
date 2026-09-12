# 问题记录规范（troubleshooting）

> 所属: docs/atlas/08-workflows/troubleshooting · 最后核对: 2026-09-13 · 对应代码: docs/atlas/08-workflows/troubleshooting/

## 什么时候记

排障结束后，凡是满足**任一条**的都值得沉淀成独立问题文件：

- 根因不显然（表象与真因隔了多层，如 BUG-17 排查发现的"日志不实时 = nginx 专用位置缓冲"）；
- 会再犯（环境相关、时序相关、平台相关的坑）；
- 排查花费超过半小时、且下次没有这份记录还得重走一遍。

纯笔误、一眼能看出的错不必记——直接修掉并在认领板备注即可。**修复任务本身仍走 `docs/PLAN-CLAIMS.md` 认领**，本目录记的是修完之后留下的"问题知识"。

## 如何命名

```
YYYY-MM-DD-<简短英文 slug>.md
例：2026-09-11-nginx-sse-first-frame-stall.md
```

- 日期取**根因定位日**（不是复现首次出现日）；
- slug 全小写连字符，能一眼猜出主题；
- 一个问题一个文件；同一根因的多个表象合并进一个文件，用"现象"节列全。

## 文件结构

复制 [TEMPLATE.md](TEMPLATE.md) 起稿，八个段固定：现象 / 环境与影响面 / 复现步骤 / 根因 / 修复 / 验证 / 预防 / 相关代码锚点。写一半没结论也先入册，把"根因"标 `未定`，解决后回填——atlas README 维护规则第 5 条要求"解决后回填结论"。

## 与 docs/ 根下既有文档的职责边界

| 位置 | 记什么 | 例子 |
|---|---|---|
| `docs/atlas/08-workflows/troubleshooting/` | **问题知识**：单个问题的根因/修复/预防，长期有效、按问题组织 | 本目录 `YYYY-MM-DD-*.md` |
| `docs/` 根（`VERIFY-*.md`、`PROGRESS-*.md`、`windows-findings.md` 等） | **轮次过程**：某轮验证/交接的时序性记录，按时间组织、不拆散 | `docs/VERIFY-round11-DEP04-approval.md` 等 |

判断口诀：**"下次遇到同类问题该读哪份？"**——读哪份就把知识写进哪份的体系；轮次文档不回填、不改写（历史快照），问题文件会随认知更新。既有轮次文档里的结论若值得沉淀，复制提炼成问题文件，**不要**在两处重复维护同一份内容。

## 写好"根因"与"预防"两段的方法

- 根因段回答"**为什么恰好在这里坏**"，不是"改了什么"——改了什么属于修复段。定位过程的弯路一句话带过即可，但"已排除项"值得写（下次能少走）。
- 预防段优先落成**断言**（回归测试/CI 闸/selftest），其次是流程（checklist 加一条），最后才是"大家注意"——纯口头提醒等于没写。
- 时序/环境类问题把**触发条件概率**写清楚（"并发 >=2 worker 时必现，单 worker 不复现"），比描述现象更能救下一个人。

## 好记录与坏记录的差别

| | 坏 | 好 |
|---|---|---|
| 现象 | "日志不实时" | "SSE 日志流首帧延迟 >5s，且 nginx 开 proxy buffering 时必现" |
| 根因 | "配置问题" | "通用 /api/ 位置 `proxy_read_timeout` 60s + 缓冲攒帧；专用 logs/stream 位置未命中" |
| 验证 | "修好了" | "`npm run test:nginx-sse` 19/19，含首帧 <1s 断言" |
| 预防 | "以后注意" | "专用位置契约进 selftest 四断言（text/event-stream + chunked + 首帧不迟滞 + 长流保活）" |

## 索引与回填

- 已知/未解决问题索引：[known-issues.md](known-issues.md)（快照式，注明快照日期，认领板为准）；
- 已解决的问题文件不需要在 known-issues 登记，文件本身就是档案；
- 相关代码模块的 atlas 文档若因该问题更新了认知，顺手把对应篇目的"最后核对"日期刷新（维护规则第 2 条）。

## 相关文档

- [TEMPLATE.md](TEMPLATE.md) · [known-issues.md](known-issues.md)
- [../task-board/README.md](../task-board/README.md)（问题修复任务的认领）
- [../../07-testing/README.md](../../07-testing/README.md)（排障常先跑的测试面）
