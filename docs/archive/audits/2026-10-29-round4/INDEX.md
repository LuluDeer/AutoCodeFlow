# 第 4 轮审计与实施汇总（2026-10-29 · 测试/守卫牙齿）

> 输入：[test-guard-quality.md](test-guard-quality.md)（只读审计，10 条守卫评分 + 弱断言清单 +
> 零覆盖清单 + T1–T5 补强建议）。
> 本轮只做「让守卫真的会咬人」这一类工作：不给产品加功能，改的是**判据与扫描面**。
> 每个落地项都带反证（把修复还原后必须红），验证以 `npm run test:guards:repo` 整链为准。

## 1. 审计结论摘要

| 守卫 | 分 | 一句话 |
|---|---:|---|
| check-metric-docs | 5 | 唯一「判据 + 退出码自检 + 扫描面下界」齐全 |
| check-cron-guard | 4 | 掩码严谨、有下界；但只认「有 try」 |
| check-index-drift | 3 | 四元组真比；partial WHERE / DROP INDEX / 无表名 @Entity 三盲区 |
| check-conditional-writes | 3 | 6 类真实无条件写形态 **0 命中**；`--report-saves` 不在 CI |
| check-ssrf-deny-parity | 3 | 字符串 contains；条目数无下界 |
| check-user-facing-language | 3 | 「含一个汉字即合规」→ 半英半中免检；admin-web 不在面内 |
| check-alerts-rules | 2 | **从不判断规则会不会触发**（5 种永不响形态全绿） |
| check-guards-wired | 2 | 注释里出现即算接线；`npm run check` 命中 `check:all` |
| check-enum-drift | 2 | 映射手维护 13 条、无覆盖自检、嵌套对象截断丢值 |
| check-sdk-docs-truthfulness | 2 | 关键词共现；只 2 篇文档 |

同时更正了第 3 轮三个「以为没测」的判断：错误码 i18n 运行时回退、SSE 断开重连退避**都有测试**；
CI 里没有非阻塞守卫（唯一 `continue-on-error` 是 micro-benchmark）。

## 2. 本轮落地（按提交）

| 条目 | 内容 | commit | 验证 |
|---|---|---|---|
| CIR-05 | 10 个 workflow 的 **106 处** `uses:` 全部固定到 40 位 SHA（12 个 action，保留 `# v7` 注释）；新增 `check-workflow-actions-pinned`（selftest 14 夹具 + 6 元断言，含 `pull_request_target` 需 `# allow-prt: 理由`） | `5ebf751f` | yaml 全部可解析；反证 `@v4`/7 位短 SHA/改 PRT → 红 |
| DT-04 | 新增 `check-infra-doc-counts`：workflow 数 / ci.yml `jobs:` 直接子键 / `deploy.sh` 行数 / 迁移数，6 处定点正则，**解析不到也红**；上线即抓到迁移数 119→122 | `5ebf751f` | selftest 15；反证「1963→129」「共 10 个→十个」→ 红 |
| WEB-6 | 新建会话弹窗：`<Text>` 标签 → `Form.Item label htmlFor`（可访问名与可见文本同源）；新增 `useModalA11y`（rc-dialog 的焦点动作挂在 motion 过渡回调上，过渡跑不完就停在 body） | `2259d211` | 259 文件 2157 例全绿；反证还原 `<Text>` → 7 条红 |
| T1 | 告警守卫加 expr 静态体检：配平/截断、恒真恒假、对 gauge 用 rate、`histogram_quantile` 缺 `_bucket`、无比较运算符、`for` < 2×抓取间隔 warn | `319eeb82` | 31 条真实规则 0 红 0 warn；5 种坏形态逐条点名；9 个突变体证明自检有齿 |
| T3 | 新增 `check-migration-symmetry`：up 的可逆对象必须在 down 有对应 DROP、CONCURRENTLY 两边一致；122 个迁移实测对称为 298/303，抓到 **5 条 down 用普通 DROP 回滚并发索引**（入基线待修） | `e5ace43c` | selftest 14；反证删一条 DROP / 基线陈旧 → 红 |
| T2 | `check-conditional-writes` 扩面（qb 链状态写 / 裸 SQL / 整行 save 基线）；**当场修掉首跑抓到的真实违规**：`markInterruptedRolloutsFailed` 按 id 盲写 rolloutState，补源状态谓词 + RETURNING 计数，基线 1→0 | `d13506e4` | selftest 40；application 441 例全绿；反证注入两种形态 → 红并点名 |
| T5 | 枚举守卫补覆盖自检（36 个声明 = 16 映射 + 20 豁免）+ 括号配平；语言守卫换判据（residualEnglish）+ 补 admin-web/python `detail=`/**错误码码表**三面，基线 10 条 | `60d06890` | selftest 24 / 28；反证新增未登记枚举、半英半中、基线陈旧 → 红 |

## 3. 本轮发现但未做（登记，避免下轮重审）

1. **T4（大）**：把 40+ 条守卫的 `--selftest` 统一到 metric-docs 模板（子进程断言退出码 + 扫描面下界）。本轮只补了 4 条，剩余仍多为「断言不抛」。
2. **5 条迁移的 CONCURRENTLY 回滚**：`1790000000022`（3 个索引）/`1790000000049`/`1790000000050` 的 down 用普通 `DROP INDEX`，回滚会锁表。已入基线，改法是把 down 改成 `DROP INDEX CONCURRENTLY` + `transaction = false` 迁移的既有豁免。
3. **产品决策 3 处**：`ApiKeysSettings:128` 的 `Scope：`（真欠账，应走 i18n）、`NotificationSettingsPage:786` 的 `Webhook`、`ExecutorPackagesPage:76` 的 `Universal`（机器值不动，label 是否中文化待定）。
4. **SopsPage 5 个 Modal 只有 placeholder**（WEB-6 的同族另一型）：placeholder 输入后即消失，需要引入可见标签，属独立一条。
5. **openapi `info.description`/`tags[].description` 未纳入语言守卫**（现在纯英文，纳入即红一条，先决策）。
6. 守卫剩余盲区（各脚本头注已写明）：index-drift 的 partial WHERE、conditional-writes 的 `pessimistic_write` 读后写与拼接 SQL、migration-symmetry 只比名字不比语义。

## 4. 验证基线（本轮结束时）

- `npm run test:guards:repo` → **exit 0**（44 个 `check-*.mjs` 全部在 CI，1 个显式豁免；含本轮新增/补牙的 5 条）
- admin-api：**388 套件 / 6699 例全绿**（并发会话的 `metrics-snapshot.service.spec.ts` 落地后复跑，exit 0）
- admin-web：**259 文件 / 2157 例**
- executor-desktop：`test:main`（61 selftest）+ `test:renderer`（本轮未改桌面代码，沿用上一轮结果）

## 5. 下一轮建议顺序

1. T4 统一自检模板（收益最大：它让「以后新增的守卫」自动有齿）
2. 5 条迁移的 CONCURRENTLY 回滚（真实缺陷、改动局部、有守卫兜底）
3. SopsPage 可见标签 + 3 处产品文案（小、可见）
4. 剩余 deferred（rt-2 的 S3 回填异步 gzip、rt-4+OBS3-03 的 SSE 快照泵）——这两项在并发会话写域，需与它的 SSE 改动合并评审。
