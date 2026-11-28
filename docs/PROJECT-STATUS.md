# 项目状态总览（R290–R475 已发布 + 工作台改造第 75–84 轮 develop 待提交快照）

> **受众**：接手维护者 / 发布决策者 · **状态**：内部 · **最后核对**：2026-11-28
> 一页看懂这批改动的整体状态：交付地图、当前验证数字、已知未决项、发布与接手指引。本文是阶段性快照，不替代各专项文档。**产品定位（对齐 [POSITIONING.md](POSITIONING.md)）：跑在内网里的 SOP 执行运行时——人把"怎么算做完了"写成 SOP，AI agent 在真实桌面上照做，每一步留下可审计的证据；业务工作台只是这条主线的入口形态，不是平行产品线。**R290–R475 共 73 轮改动已合入 `main` 并随 `v2.3.0`（2026-11-22）发布；工作台改造第 75–84 轮（10 轮）在 `develop` 上、未提交未发布，逐轮事实源见 [AGENT_HANDOFF.md](AGENT_HANDOFF.md) 头部。**
> **第4轮真机补验（2026-11-24，HEAD=`4c531991`）**：此前「无 X/无 Chrome」系未导出 `XAUTHORITY` 的误判，图形环境打通后完成中台 Chrome + 桌面 Electron 双端真机补验（中台 8/8、桌面除 1 P1 外全过），返修 1 个 P1（桌面历史页日志查看器关闭后焦点归还）并真机复验；另补真机白屏量化归因（Xwayland 无 WM 的合成器 first-paint 迟到约 28s，属环境税、非产品缺陷）。最新逐轮事实源见 [AGENT_HANDOFF.md](AGENT_HANDOFF.md) 头部。
> **数字口径**：轮次/项数均由命令实测（`git status --short | wc -l`、`ls docs/plan/*.md | wc -l`），不手写估计——历史快照的手写值曾漂移，本版已按实测校正。

---

## 1. 一句话状态

**工作台改造第 75–84 轮（10 轮）在 `develop` 上待提交**（未发布）：围绕 objective「面向程序员/业务人员/老板」补齐三类受众主路径——业务人员方案卡发布链（批准必达跨进程恢复 + 发布失败一键重试）、老板驾驶舱（审批/价值/成本/TTFV 四卡 + gate_off 诚实化 + 角色化按 isAdmin 渲染）、程序员首次体验（VITE_API_URL 裸路径陷阱修复 + i18n 222 处硬编码中文迁移让 CI 门禁转绿）；并做两轮系统性质量收口（真栈 e2e 首次打通第 74–78 轮成果；CI-only 门禁体检抓 3 个被守卫链掩盖的红灯 lint:i18n/test:agent/test:sop 并纳入防复发）。功能可落地方向已接近穷尽，本轮转向收口固化而非制造低价值改动。10 轮全端实测见 §3、剩余项「为什么不做」见 §4。以下为已发布的 R290–R475 基线状态：

**R290–R475 共 73 轮改动**（R459 按主题分 11 组入库 + R475 追加 5 组；含 2 个新迁移、13 个新脚本；`docs/plan/` 保留 8 篇活跃方案/口径/runbook，其余 17 篇一次性验收/复演报告已归档至 `docs/archive/{reviews,verifies}/`）已合入 `main` 并随 **`v2.3.0`** 发布。整批在「admin-api/admin-web 全量测试 + 全守卫链 + typecheck 8 端 + 迁移 up/幂等/down 全链（dev 与 :prod 双路径真机复演）+ 北极星健康自检 + **真浏览器+真后端端到端**」下全绿。R458–R475 补齐 demo 三句产品承诺真跑验证（成功执行/失败可诊断/零代码模板）、CLI flag 与示例配置一致性守卫、SDK 编程式集成冒烟测试，并经两轮独立 review 修复 7+ 真实缺口。R436/R437 补上最后一层覆盖（看板与生产启用路径真栈端到端）；R439 把两个真栈 e2e 接入 CI；R440/R441 空库复演 CI 精确序列与 `:prod` 迁移路径（无 dev/prod 分叉）。R442–R452 清掉全量回归的 4 处并发 flake、拍板升主三阈值并贯通脚本→API→看板→真栈回归闸、补齐 W4 留存与 SOP 成功率/接管率两个 ROADMAP 先行指标。R453–R457 把指标脚本 selftest 接入 CI、新建先行指标健康度判定（`evaluateHealth`，无样本不算达标）+ 一条命令采集入口（`metrics-health-collect`）。**至此 ROADMAP 先行指标全部有可复算实现或明确放弃结论，主体产品线已收口；但仍留有自主可落地项——第4轮真机补验暴露的返修/复验（P1 焦点归还已返修并复验）、以及 ADR-024 后端流式导出端点、ADR-031 步骤 3/5 体量重构等既有明确下一步的工作，均不依赖外部输入即可推进。**「剩余全部依赖外部输入」仅指升主阈值达标本、模板转化率埋点等确需生产样本或外部系统的项，不是全部未决项。

## 2. 73 轮交付地图

按产品线分组，不逐轮流水账。验收级别按仓库四级口径：静态探查 < 单测/内存替身 < 真实进程内集成 < 浏览器/真机。

| 产品线 | 轮次跨度 | 关键产物 | 最高验收级别 |
|---|---|---|---|
| **TTFV 埋点线** | R290–R318 | [埋点方案](plan/ttfv-funnel-instrumentation.md)；迁移 `0101`（`funnel_events`）/ `0102`（`telemetry_optin`）；opt-in 双闸 + `deriveAnonymousId` HMAC 匿名 ID；`FunnelEventsService` + install/success/attempt 三类 listener；真实口径指标脚本；24h 激活率 `task_first_attempted` 事件 | 真实进程内集成（R310 / R316） |
| **北极星判据线** | R324–R326 | [判据方案](plan/north-star-business-confirmed.md)（严格判据 D：`business_confirmed`，`dedupe_key=confirmed:<hash>`）；可复算脚本 `north-star-weekly.mjs`（全串相等哨针 + `SET LOCAL TIME ZONE 'UTC'`）；显式确认端点 + `FunnelConfirmationListener`；真库对账脚本 `north-star-pg-reconcile.mjs`（R326 修代理时区漂移） | 真实进程内集成 + 真库逐字段对账 |
| **生产启用线** | R327–R330 / R431 / R436 | 数据 API `GET /agent/north-star/metrics`（CLI/API 真库同源）；[启用 runbook](plan/north-star-enablement.md)；双口径看板 `NorthStarCard` + `TelemetrySettings`（coverage 四态 + 显式重授权）；B3 原始指纹拦截；R431 确认端点非法 id 第一现场收口；[真栈浏览器 e2e](archive/reviews/browser-real-backend-review.md) | **真浏览器 + 真后端 + 真 PG（R436，AGENTS §4.4 最高级）**；生产启用实跑仍需目标环境按 runbook 执行 |
| **CI 防复发线** | R314 / R433–R434 / R439–R441 | CI 迁移闸本地复现；[迁移 roundtrip 报告](archive/verifies/migration-roundtrip-review.md)；[CI revert drill 常态化报告](archive/reviews/ci-revert-always-review.md)——revert 去 `if: schedule` 改每 PR 跑 + 加副作用断言（`grep DELETE/DROP`，防空 `down()` 假绿）；R439 新增 `north-star-real-e2e` job 把 R436/R437 两个真栈 spec 接入 CI（此前 CI 零引用、从不自动跑），[接入验收](archive/reviews/ci-realstack-e2e-review.md)；R440 [空库→迁移→两 spec 序列本机复演](archive/verifies/ci-replay-verification.md) 7 步全绿；R441 [`:prod` 迁移路径空库复演](archive/verifies/prod-migration-replay.md) 7 步全绿、无 dev/prod 分叉 | 真实 PG 进程级（R433 迁移链、R440 CI 序列、R441 `:prod` 路径真机复演）；静态 CI 配置 + 守卫（R434/R439）；仍未真跑 GitHub Actions / 生产环境（PG16 vs 本机 18 差异） |
| **质量与守卫线** | R297–R301 / R321–R323 / R432 / R444–R447 | 审批 granted 丢失唤醒 E-pure 修复 + 补偿 job 独立 dedup 命名空间（[方案](plan/approval-lost-wakeup-fix.md)）；全守卫链跨轮回归修复；[健康自检](../scripts/north-star-health.mjs)（一条命令验表/事件/口径/API/看板/双闸）；4 处全量并发 flake 清除（墙钟→CPU 口径、时间漂移、vi.fn 计数、DOM 就绪信号）——全量回归信号可信 | 真实进程内集成（R322 / R323）+ 纯函数 selftest / 真库查询（R432）+ 全量并发真跑（R444–R447） |
| **先行指标补全线** | R451–R452 / R455–R457 | [W4 实例留存](plan/w4-retention.md) ≥40%、[SOP 成功率/人工接管率](plan/sop-success-rate.md) ≥90%/≤10% 可复算脚本（复用漏斗/SOP 数据，零 DDL）；[健康度判定](plan/metrics-health.md)（`evaluateHealth`，无样本不算达标）+ [一条命令采集](plan/metrics-health-collect.md)（`metrics-health-collect`，fail-closed）；升主三阈值（R448–R450）贯通脚本→API→看板→真栈回归闸 | 纯函数 selftest + 真库造数对账 + 真浏览器+真后端（升主看板 R450）；指标脚本 selftest 已接 CI（R453/R455） |
| **首次体验验证线** | R458–R475 | [demo 真栈验收报告](archive/reviews/demo-first-experience-review.md)——三句产品承诺逐句真跑（成功执行/失败可诊断/零代码模板）；CLI flag 对账守卫 `check-cli-doc-flags`、示例配置/代码守卫 `check-examples-code`、SDK 编程式集成冒烟测试；两轮独立多 agent review 修复 7+ 真实缺口（含 SDK env 串扰、失败分类假绿、静态锚点假绿）；R475 分 5 组提交 | 真 docker compose 全栈真跑（R461 exit 0 两次含幂等）+ 静态守卫 selftest + SDK 进程内集成；未真跑生产环境 |

### 工作台改造第 75–95 轮（develop 待提交，objective 面向三类受众）

> 21 轮交付按受众分组；逐轮细节见 [AGENT_HANDOFF.md](AGENT_HANDOFF.md) 头部倒序段。全部为 develop 未提交改动，**未发布**。

| 受众 / 主题 | 轮次 | 关键产物 | 最高验收级别 |
|---|---|---|---|
| **业务人员 · 发布链** | 75 / 78 / 90 / 92 | 批准必达跨进程恢复（argsDigest 对账）+ 发布失败一键重试（consume 前白名单）+ 审批三态诚实化（不再假成功+死路）+ 失败跨角色闭环（管理员 audit 重新发起审批，不绕四眼） | 真 PG e2e 第 3 级 + 真栈 e2e 第 4 级（R79 复验） |
| **老板 · 驾驶舱与成本** | 76 / 77 / 81 / 84 / 91 / 93 / 94 | 四卡首屏（审批/价值/成本/TTFV）+ 诚实标缺 + 角色化（USER 只见审批卡，不看 ADMIN 三卡）+ TTFV 真实口径上屏 + gate_off 诚实化 + 价目表管理 UI + 顶层折算出数 + 时间窗口径 | 真 PG 出数 3.5/OK 第 3 级；驾驶舱 e2e 第 4 级（传输层 mock） |
| **程序员 · 首次体验** | 80 / 82 | VITE_API_URL 裸路径陷阱修复（配置+文档+守卫）+ i18n 222 处硬编码中文迁移（CI `lint:i18n` 转绿） | 组件级第 2 级 + CI 门禁 EXIT 0 |
| **质量与可靠性** | 79 / 83 / 86 / 87 / 88 | 真栈 e2e 打通第 74–78 轮成果（51 passed）+ CI-only 门禁体检（抓 lint:i18n/test:agent/test:sop 三红灯纳入链）+ 跨实例真双进程 selftest 37 断言 + 审批跨实例恢复真双实例 e2e | 真栈第 4 级 + 真进程第 3 级 |

## 3. 当前验证状态

主 agent 最新实跑数字（**2026-11-27 全端聚合回归**：R290–R475 已发布基线 + 工作台改造第 75–84 轮 develop 累积改动；admin-api/admin-web/guards 由主控本会话实测，其余 7 端由验证 agent 本会话真跑，全部真实退出码）：

| 项目 | 数字 | 结果 |
|---|---|---|
| admin-api 全量测试（`--maxWorkers=2`） | 582 suites passed（2 skipped）/ 9613 tests passed（6 skipped） | exit 0 |
| admin-web 全量测试（`vitest run`） | 387 files / 3192 passed（1 skipped） | exit 0 |
| executor-node 全量（`npx jest`） | 64 suites / 1877 passed（13 skipped） | exit 0 |
| executor-python 全量（`node scripts/py.mjs ... pytest -q`，用仓库 .venv） | 2010 passed（3 skipped）/ 87.32% 覆盖，达标 | exit 0 |
| acf-cli 全量（`vitest run`） | 16 files / 466 passed | exit 0 |
| mcp-server 全量（`vitest run`） | 12 files / 370 passed（57 工具） | exit 0 |
| node-sdk 全量（`npx jest`） | 6 suites / 151 passed | exit 0 |
| executor-desktop 全量（`test:main` + `test:renderer`） | 65 main selftest + 306 renderer 断言全通过 | exit 0 |
| 跨切面审计 | 错误码中英同步 / 路由授权矩阵 / consumer-routes / 文档链接零死链 | exit 0 |
| `typecheck:all` | 8 个端（api/specs/node/cli/mcp/node-sdk/desktop/web） | exit 0 |
| `test:guards:chain` | 全守卫链（含 e2e 迁移就绪守卫 + 本会话新增 `test:agent`/`test:sop`） | exit 0 |
| `lint:i18n`（CI 门禁，链外） | 222→0 硬编码中文，zh/en 各 4168 键 parity | exit 0 |
| **跨实例 selftest（第 13 轮加固）** | 真双 admin-api 进程 + 真 PG/Redis：multi-instance 17/17 + outbox 7/7 + outbox-dup 13/13 = **37 断言全绿**；覆盖 leader election 恰 1、配置读穿、SKIP LOCKED claim 零重叠、双实例事件零重复 | exit 0 |
| **审批跨实例恢复 e2e（第 14 轮补缺口）** | 两真 Nest 实例共享 PG/Redis：appA 申请+批准（Map 有 key）、appB 空 Map 走 findByKey 持久化恢复 → `sop_versions` 恰 1 行 `published_by='agent:tool-call'`、`agent_approvals.status='consumed'`；篡改反证零版本行 | exit 0（2/2） |
| **真栈全链 e2e（`bash scripts/e2e-full.sh`，第 12 轮复验）** | **52 声明 / 51 passed / 1 skipped / 0 failed（2.8m）**；真 PG（时间戳命名的临时 e2e 库）+ 真 Redis + admin-api + executor-node/python + admin-web vite + 真 Chromium，零 page.route；R5 发布链真库副作用 + 网络证据 `apiResponses=120, bad=[]` | exit 0 |
| north-star-health | 静态 5/5（真库 6/6，本会话未重跑，引用旧值） | exit 0 |

> **历史口径（2026-11-25 R41 五端聚合）**：admin-api 511/8651、admin-web 367/3029、executor-node 64/1875、python 87.32%、cli 466、mcp 348、sdk 151 —— 本轮 2026-11-26 聚合**各端不低于历史基线，多数增长**（工作台改造 58 轮新增能力 + 测试）。CI 四分片口径（128/127/127/128 suites）仍是 CI job 的权威复演，本表为 `--maxWorkers=2` 本地口径。
| 真浏览器深链 e2e（真 Chrome 158，系统 Chrome 通道） | 4 passed / 0 failed，pageerror=[] | exit 0 |
| 真浏览器 + 真后端 e2e（R436，历史） | 真 PG/后端 dist/系统 Chrome：确认端点→漏斗落行→看板真读→反证 1→0→1 | 1 passed / exit 0，无 mock、pageerror=[] |
| 迁移独立库往返（R433/R441，历史） | 146 up → 幂等 → revert ×2 → 清理 | 全 exit 0 |

说明：健康自检区分「代码在（静态）」与「运行时健康（真库）」，静态 PASS ≠ 运行时健康；迁移链在独立干净库实测，`down()` 真回滚已验证（R314 只验 up+幂等的缺口已补）。R436 端到端验收抓到浏览器真发 `GET /api/agent/north-star/metrics` 200，看板数值=真后端数（非 mock/硬编码），反证增删漏斗行看板随之变化——这是四级验收里的最高层。R442 在 R433 之后所有改动落定后**最终复跑**双端全量：admin-api 8602 passed exit 0；admin-web 首跑遇 1 例性能红线 flake（`maintenance-window-parity` 20 tasks best-of-3 72.8ms > 50ms，与文案改动无关，单跑 13ms），重跑全量 350/350 / 2845 passed exit 0，坐实为 350 workers 并发争抢的一次性抖动而非回归。R477 在 R475 提交后、用户 push 前，按 CI 真实命令逐个复演关键 job（SDK/docs/admin-web/executor-node 的 coverage 与 test:docs），全部 exit 0——消除 R459 首推后曾出现「本地绿 CI 红」的那类风险，确认这批提交在 CI 命令下不会红。**R40（2026-11-25）五端全量回归**：此前只跑定向测试 + 守卫链，首次整体复跑发现 3 个 executor-package spec 因 R31 新增 `UsersService` 构造器参数却未补夹具而 TS2554 红（定向测试与守卫链均发现不了）——补齐构造器第 5 参 + Test 模块 Provider 后 admin-api 全量 511 suites / 8651 tests exit 0；admin-web 367/3029、executor-node 64/1875、executor-python 87.32% 覆盖、acf-cli 16/466、executor-desktop、mcp-server 11/348、node-sdk 6/151 全 exit 0。**教训**：跨端 DI 签名变更必须全量复跑，定向测试覆盖不到所有 `new Controller(...)` 夹具点。**R41 追加 CI 分片复演**：按 CI 真实口径 `--node-options=--experimental-vm-modules jest --shard=N/4` 串行跑完 4 片（129/127/127/128 suites、2841/1670/2218/1922 tests，全 exit 0），四片 suites 合计 511、tests 合计 8651 与 `--maxWorkers=2` 全量逐字吻合——坐实本批改动在 CI 分片口径下同样全绿，无测试间状态泄漏/顺序依赖。

## 4. 已知未决项

诚实列出，每项标注「为什么现在不做」。

| 项 | 为什么现在不做 | 出处 / 重开条件 |
|---|---|---|
| 升主量化阈值 / 外部回执 E | **升主三阈值已于 R448 拍板并贯通脚本→API→看板→真栈**（≥4 周 + active_install_weeks≥20 + 运营前置 coverage=full，见 [判据方案 §8](plan/north-star-business-confirmed.md)）；仍依赖生产样本才能判断是否**已达**升主。外部回执 E 需真实外部系统对接需求 | [判据方案 §10](plan/north-star-business-confirmed.md)；积累样本后巡检 |
| 模板 → 成功转化率 ≥80% | ROADMAP 先行指标，但确无 DDL 埋点、无数据支撑；加 DDL 不可逆，风险收益不匹配（R432 明确放弃该方向） | [ROADMAP 指标段](ROADMAP.md)；出现真实数据需求时重开 |
| 指标接入运营看板 / 定时巡检 | W4/SOP 指标与健康度已可复算（脚本级），但看板接入与定时巡检需生产数据验证价值——生产未启用漏斗时每帧都是 no_data，无意义 | [健康度采集](plan/metrics-health-collect.md)；生产启用并积累样本后重开 |
| A2 四个 Python 库处置 | 仓内三个有等价实现、零外部需求证据；删会丢 `R134-A1` 回归用例与 tag 史。维持不发布等 `check-publishable-wiring` 的 `review_by`（2026-12-15）到期再拍（届时选「冻结 + README 标注」成本最低） | [OPEN-DECISIONS A2](OPEN-DECISIONS.md)；`review_by` 到期变红时重开 |
| D7 限流 12000/min | 该值是推算值（100 台 × 60/min 留 2 倍余量），需真机压测确认（需真实 execution token/UUID）——属测量问题，用改分桶语义回答方向错误；per-IP 名额表 + body-parser 前置闸已封住放大器 | [OPEN-DECISIONS D7](OPEN-DECISIONS.md)；目标拓扑含 >200 台共享出口时先调 env 再压测 |
| 成本归责真实金额（老板看板出数） | **顶层总账单已闭环（第 91/93 轮）**：价目表管理 UI + `convertToAmount` 接进 stats，真 PG 验证配价目+非零 token → `currencyValue=3.5/priceReason=OK`；零样本仍诚实标缺。**剩余**：按项目/能力行级归责需外部业务权重来源（没有，做份额分摊即伪归责）+ 关联键 ADR（sessionId 写 SOP id）+ 生产 `capability_activation_log` 迁移 0105 + 真实 provider 配置（外部 API/运维），完整约 8–11 人日 | [AGENT_HANDOFF.md](AGENT_HANDOFF.md) 第 91/93 轮；**重开条件**：operator 对按项目归责的 8–11 人日立项拍板，或有 design partner 提供真实 provider 环境 |
| 完整北极星严格值三态 DTO | **第 81 轮 gate_off 最小切片已覆盖用户可见冲突**；剩余 no_data/ok 细分是过度工程：严格值 SQL 有行则 `confirmed_events>=1`，「闸门开但零确认」的 no_data 数值仍应显示 0（不像 TTFV 可 null），加独立 dataStatus 只多一个「换标签的 0」，却要完整 openapi 重导出 + 4 处 tsc 夹具 + enum-drift + 对账脚本同步 | [AGENT_HANDOFF.md](AGENT_HANDOFF.md) 第 81 轮；**重开条件**：产品要求严格值独立可观测 或 代理值也需状态语义 |
| TTFV 真 PG 对账（脚本 FIELD_PATHS 接 ttfv） | **用户价值 0 感知**：第 77 轮已上屏、第 81 轮已消除同屏冲突、第 4 级浏览器 e2e 已绿；权威口径已有逐字同源断言 + 口径哨。对账要改 6 处 + 双 CLI 适配 + 触碰全局 telemetry gate（有并行污染风险），约 0.5–1 人日，收益是后端/QA 回归护栏而非用户可见 | [AGENT_HANDOFF.md](AGENT_HANDOFF.md) 第 77 轮；**重开条件**：telemetry 真开启积累样本后，或口径出现真库类型/边界漂移证据 |
| 安装包瘦身（≤100MB） | ROADMAP P1 唯一未做项，仓库零实现；按需下载 runtime + 真机验证成本高，且 electron-builder 仍打 executor-node/uv/agent-worker/playwright | [ROADMAP.md](ROADMAP.md) P1；**重开条件**：有明确 design partner 真机体积诉求 |
| ~~审批单跨实例恢复的真双实例验证~~ | **第 14 轮已关闭**：新增 `release-cross-instance.e2e-spec.ts`，两真 Nest 实例共享 PG/Redis，appB 空 Map + findByKey spy 证明走持久化恢复，真库副作用 + 篡改反证 2/2 全绿；边界：两实例同一 OS 进程（DI 容器级隔离），非两 OS 进程 | [AGENT_HANDOFF.md](AGENT_HANDOFF.md) 第 88 轮；如需 OS 进程级证据另起多主机轮 |
| 真跨主机拓扑 / 生产环境实测 | 第 13/14 轮跨实例验证是**单宿主双进程/双实例**，非多主机；生产 PG16 vs 本机 PG18 差异、真机长稳、通知渠道实测、私有仓库集成均未覆盖 | [ROADMAP.md](ROADMAP.md) P2；**重开条件**：有目标部署拓扑/真机环境时按 runbook 执行 |

## 5. 发布 / 接手指引

1. **启用**：接手方（appa）按 [生产启用 runbook](plan/north-star-enablement.md) 操作。三项前置缺一不可且按顺序——① 生产库真跑 `0101`/`0102` 迁移并核对账本（`:prod` 入口、`migrationsRun=false` 不自愈）；② `SEC_SECRETS_KEY` 配非空 32 字节 hex（空 key 会致授权端点 503 + listener 静默跳过）；③ 至少一个带 `deviceFingerprint` 的执行器在线（先装执行器再授权，避免 `coverage=no_executors` 静默零采集）。授权后用 `GET /agent/telemetry/status` 验 `coverage` 与 `count`（`count=0` 一律视为未启用）、用 `GET /agent/north-star/metrics?as_of=` 验出数。
2. **发布前 rebuild dist**：R327 曾因 stale dist 导致 warnings 缺项被真库对账抓红——改过后端再验前端/脚本前必须重建产物，勿用旧 dist 数字。
3. **发布状态**：R290–R475 共 73 轮改动（R459 分 11 组 + R475 追加 5 组）已合入 `main` 并随 **`v2.3.0`**（2026-11-22）发布。
4. **隐私红线不可破**：生产唯一 grant 写入点是显式 `POST /agent/telemetry/consent`（ADMIN + JWT）；新设备永不自动授权；漏斗只落匿名 HMAC ID + 90 天 TTL。

## 6. 证据索引

**方案与 runbook**

- [TTFV 首次成功漏斗埋点方案](plan/ttfv-funnel-instrumentation.md)
- [北极星「被业务确认」判据（R324）](plan/north-star-business-confirmed.md)
- [北极星 / TTFV 生产启用 runbook（R329）](plan/north-star-enablement.md)
- [审批 granted 丢失唤醒修复方案](plan/approval-lost-wakeup-fix.md)
- [W4 实例留存（R451）](plan/w4-retention.md) · [SOP 成功率/接管率（R452）](plan/sop-success-rate.md) · [健康度判定（R455）](plan/metrics-health.md) · [健康度采集入口（R456）](plan/metrics-health-collect.md)

**独立验收报告（历史快照，已归档）**

- [北极星判据验收（R324）](archive/reviews/north-star-review.md) · [真库对账验收（R326）](archive/reviews/north-star-pg-reconcile-review.md)
- [数据 API 验收（R327）](archive/reviews/north-star-api-review.md) · [双口径看板验收（R328）](archive/reviews/north-star-ui-review.md)
- [生产启用断点验收（R329）](archive/reviews/north-star-enablement-review.md) · [B3 指纹拦截验收（R330）](archive/reviews/b3-installid-guard-review.md)
- [健康自检验收（R432）](archive/reviews/north-star-health-review.md) · [迁移 roundtrip 验收（R433）](archive/verifies/migration-roundtrip-review.md) · [CI revert 常态化验收（R434）](archive/reviews/ci-revert-always-review.md)
- [真浏览器+真后端端到端验收（R436）](archive/reviews/browser-real-backend-review.md) · [生产启用路径真栈验收（R437）](archive/reviews/telemetry-enablement-e2e-review.md) · [CI 真栈接入验收（R439）](archive/reviews/ci-realstack-e2e-review.md)
- [CI 复演（R440）](archive/verifies/ci-replay-verification.md) · [`:prod` 迁移复演（R441）](archive/verifies/prod-migration-replay.md) · [性能红线 flake 验收（R444）](archive/reviews/perf-flake-fix-review.md) · [affinity flake 验收（R447）](archive/reviews/affinity-flake-fix-review.md) · [demo 真栈验收（R462）](archive/reviews/demo-first-experience-review.md) · 真栈 e2e spec `apps/admin-web/e2e/north-star-real-backend.spec.ts`

**交接与决策事实源**

- [跨会话交接与状态快照（逐轮证据）](AGENT_HANDOFF.md) · [待决策清单](OPEN-DECISIONS.md) · [路线图·指标段](ROADMAP.md)
- [健康自检脚本](../scripts/north-star-health.mjs) · [全仓健康基线](health-baseline.md)
