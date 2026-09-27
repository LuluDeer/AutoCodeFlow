# AutoCodeFlow 开发计划（2026-10 期 · 第 27 轮起）

> 基线：develop @ 2907bf8d · CI 全绿 · 认领板全清（201 行 done，H2 池空）·
> 多实例矩阵 15 项全绿（3.7 令牌缓存 / #8 快速路径本周收口）·
> agent-and-deployment P0–P7e + Linux GUI S1/S2/S3 全落。
> 基线数字：admin-api 3790 测试（覆盖率 87.6/76.4/80.6/88.6，地板 84/75/78/85）·
> desktop test:main 35 套 · admin-web vitest 1265 · release 链 v1.5.0 打通。
> **认领事实源仍为 [PLAN-CLAIMS.md](./PLAN-CLAIMS.md)**；本表 §2 注册本期新任务，
> 认领纪律不变（claimed→in_progress→done + 足迹独占）。

---

## 0. 本期定位

H2 计划（2026-09-08 建账）的任务池已全部清偿。本期不是"清欠"而是**从收敛走向扩张**：
平台底座（多实例安全、Agent/SOP 生态、Linux 执行面）已收敛，下一阶段的价值方向有三条
——①已知缺口的清偿（有据可查，低风险）；②Agent/SOP 生态延伸（本周线的自然续章）；
③平台纵深（把"能用"加固成"可长期运维"）。每项都标注了证据来源与认领前复核要求。

---

## 1. 滚动项（外部条件触达，不占轮次）

| 项 | 触达条件 | 动作 |
|---|---|---|
| Xorg 会话生态复跑 | 目标机登录「Ubuntu on Xorg」 | 复跑 `scripts/gui-x11-s2-verify.mjs` + 负向脚本，补 [VERIFY-2026-09-27-gui-x11.md](./VERIFY-2026-09-27-gui-x11.md) §5 滚动项 |
| 跨机拓扑留验 | 第二台机器/云主机 | ARCH-MULTI-INSTANCE-MATRIX 跨机清单（AGNET/DB/Redis 分离部署） |
| BUG-04 minio 上游 | **复查日 2026-10-01 临近** | 复查 GHSA patched_versions 是否实际发版；未发则续期豁免归档 |
| P7d 后半端到端 | DashScope 账号+配额 | SOP→Agent 造包→DEP-04 审批→拉包部署→中台验收真闭环（06-roadmap §9.6 残差） |

---

## 2. 新任务池（认领前逐项复核现状——板行可能滞后于代码）

### A. 已知缺口清偿（证据：done 行明示的后续项）

| 编号 | 优先级 | 内容 | 证据来源 | 验收 |
|---|---|---|---|---|
| N-01 | P2 | **ARCH-28b：turbo 增量接入**——评估报告已裁定方向，缺实际接入 + CI 时长 A/B 对比 | ARCH-28 行（2026-09-10）"turbo 增量接入列 ARCH-28b 后续任务带 A/B" | turbo.json 落地；CI 关键路径时长对比报告；test:all/typecheck:all 全绿 |
| N-02 | P1 | **ADR-013 保留缺口清偿**（四项，均 AUTH-02 行明示）：① 非成员 trigger/pause/resume 宽松语义收紧（⚠️破坏性，需产品拍板）；② 项目列表按成员过滤；③ 项目内 executor/package 角色细分；④ admin-web 权限门控 UI | AUTH-02 行"明确保留的已知缺口（需产品拍板）" | ①②③④逐项销账；RBAC 收紧前后端同批发布纪律 |
| N-03 | P2 | **覆盖率棘轮续期**：branches 75 已复；functions 78/lines 85 地板上探。目标函数 ≥80 / 行 ≥87 | 本周 3dd4d68a/ae601f8a 棘轮线；sop-collab.controller 56%、agent.processor 44% 等仍是洼地 | 地板上调且全量绿；不写凑数弱断言 |
| N-04 | P3 | **i18n 页面迁移收尾**：UI-10 框架+多阶段已落，清点未迁移页面并完成（越晚成本越高） | UI-10 行（渐进迁移策略） | 硬编码中文源码守卫零豁免；zh/en key 对齐 |

### B. Agent/SOP 生态延伸（本周线自然续章）

| 编号 | 优先级 | 内容 | 证据来源 | 验收 |
|---|---|---|---|---|
| N-05 | P1 | **P7d 后半端到端闭环**（滚动项，DashScope 就绪后立即开工） | 06-roadmap §9.6/§9.11 残差 | 真 SOP→执行器 Agent 自主实现→澄清→交付→审批→部署→中台独立验证全真机 |
| N-06 | P2 | **打包接线双项**：host 拆独立子进程（07 §4.2 完整形态）+ 打包态 Playwright 浏览器分发（electron-builder extraResources） | 06-roadmap §9.5/§9.10 残差 | 打包产物内 GUI/浏览器能力探针真实可用；宿主主进程不卡 |
| N-07 | P3 | **macOS GUI 后端侦察**（对齐 12 号 Linux 侦察稿形态：权限模型 vs 逐动作复核的张力评估） | 12-executor-gui-linux.md §5 待拍板 3 | 侦察稿 + 立项/否决建议 |
| N-08 | P3 | **SOP 生态演示包**：预置 2-3 条可跑 SOP + 教程序列（Linux GUI/X11 会话演示含） | NF-08 姿态 + 本周 Linux GUI 能力 | seed 后教程零配置可复现 |

### C. 平台纵深（低频高价值）

| 编号 | 优先级 | 内容 | 证据来源 | 验收 |
|---|---|---|---|---|
| N-09 | P3 | **QA-10 关键路径微基准**：handleCallback 批量 / storeLogLines 万行 / dispatch 决策 / loadScore 防退化 | H2 §7 遗留（QA-10 未清） | 基准入库 + CI 可选 job + 阈值告警 |
| N-10 | P3 | **QA-12 桌面端 Electron e2e**：Playwright `_electron` 冒烟（注册/托盘/任务面板） | H2 §7 QA-12 | 3 例入 CI |
| N-11 | P2 | **DSK-02/03 Linux 打包与自动更新真机**：AppImage/deb 产包 + electron-updater 在 Linux 主场验证 | Linux 侧接管后的自然项；本周 randPort/ffmpeg 经验都在这条线上 | 产包 + 更新链真机走通 |
| N-12 | P3 | **ARCH-23 OpenAPI→前端类型生成**（认领前复核：确认是否已在某轮顺带落地） | H2 §5 遗留 | admin-web 手写 interface 替换过半；drift CI |
| N-13 | P3 | **BUG-04 复查机制化**：minio 上游复查（10-01）结论入库；之后每次依赖审计轮自动带复查 | BUG-04 行（2026-10-01 复查日） | 复查记录 + 豁免续期归档 |

---

## 3. 里程碑建议（第 27~30 轮）

| 轮次 | 主题 | 建议包 | 出口标准 |
|---|---|---|---|
| **27** | 小而确定的清偿 | N-01 · N-03 · N-13（10-01 复查） | turbo A/B 报告；地板上探；复查归档 |
| **28** | 权限域收口 | N-02（①需产品拍板先行，②③④可并行）· N-04 | ADR-013 缺口全销账；i18n 守卫零豁免 |
| **29** | 桌面纵深 | N-06 · N-10 · N-11 | 打包态能力探针真实可用；Electron 冒烟入 CI；Linux 产包 |
| **30** | Agent 生态 | N-05（DashScope 就绪后）· N-07 · N-08 | 端到端真闭环；macOS 侦察稿；演示包 |
| 滚动 | 外部触达 | Xorg 复跑 · 跨机 · N-12 | 逐项条件成熟即认领 |

---

## 4. 风险与纪律（延续 + 本期新增）

| 项 | 说明 |
|---|---|
| 认领纪律 | 不变：PLAN-CLAIMS 独占 + 足迹声明 + 开工前复核现状（板行可能滞后代码） |
| 真机矩阵 | 调度/队列/迁移改动强制 compose 冒烟；GUI/X11 改动跑 s2 双脚本 |
| bundle 纪律 | executor-node src 与 bundle 同 commit；desktop 改动跑双 tsconfig + test:main |
| lint 前置 | 推送前跑模块自身 lint（check:lint-gates 只验配置面——本周教训） |
| 覆盖率棘轮 | 只增不减；新模块定向补测后再抬地板（QA-02 模式） |
| 多代理预案 | 子代理平台故障（reasoning-level-missing）→ 主会话直落，同等纪律 |
| **N-02①破坏性** | 权限收紧是行为变更：ADR 修订 + 前后端同批 + CHANGELOG 显著位 + 升级说明 |

---

## 5. 待拍板（用户决策项）

1. **N-02① 语义**：非成员 trigger/pause/resume 收紧为「项目成员或 ADMIN」是否可接受（破坏性变更，影响存量部署的既有用法）。
2. **N-05 前提**：DashScope 账号与配额何时就绪（决定轮 30 是否如期）。
3. **大项优先级**：N-01（工程效率）/ N-02（安全域）/ N-05（Agent 生态）三条线的先后，或并行。
4. **v1.6.x 发版窗口**：本周落地的 GUI-Linux、3.7、#8 是否凑一个 minor 发版（release-please 链已通）。
