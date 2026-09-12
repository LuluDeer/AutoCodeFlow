# 任务卡模板（TEMPLATE）

> 所属: docs/atlas/08-workflows/task-board · 最后核对: 2026-09-13 · 对应代码: docs/atlas/08-workflows/task-board/

使用方式：一次性任务通常**直接在 `docs/PLAN-CLAIMS.md` 加行**即可（板是事实源，多数任务不需要独立文件）；满足任一条才建独立任务卡文件——① 背景复杂需要长文交代；② 验收标准超过 5 条；③ 需要跨多轮/多会话接力。文件放本目录，命名 `<编号或slug>.md`，并在认领板加行指向它。状态一律以**认领板**为准，卡内不另设状态真相。

---

```markdown
# 任务卡：<任务名>（<板上编号，如 FEAT-XX / NF-XX / 自编号 TEMP-01>）

> 任务卡: docs/atlas/08-workflows/task-board/<文件名>.md · 最后核对: YYYY-MM-DD
> 认领行: docs/PLAN-CLAIMS.md「<编号>」行（状态/Owner/commit 以板为准）

## 任务名与优先级

- 任务名：<一句话动词开头，如"为 XX 模块补齐项目级角色门控">
- 优先级：<P0 / P1 / P2 / P3>（与认领板行一致）

## 背景

<为什么做：来源任务/缺陷编号、用户故事或运维痛点、上游决策（ADR/认领板行）链接。
两三段以内，历史细节外链 docs/ 下既有文档，不要复制。>

## 涉及文档（开工前按序读完）

<全部用 atlas 树内相对链接，逐条列出，例：>
1. [../../00-overview/05-core-concepts.md](../../00-overview/05-core-concepts.md) — 领域概念
2. [../../01-apps/admin-api/modules/task.md](../../01-apps/admin-api/modules/task.md) — 改动主模块
3. [../../03-data/migrations.md](../../03-data/migrations.md) — 若涉及迁移
4. [../add-new-api-module.md](../add-new-api-module.md) — 操作手册

## 文件足迹（认领板同步填写）

- 独占：<预计新增文件/目录>
- 触碰：<预计修改的既有文件，标注是否热点（app.module.ts / task.service.ts / api-reference.md）>
- 明确不碰：<避让声明，指明在途会话的足迹>

## 验收标准

- [ ] <可判定的验收项，命令/数字优先，如"npm run test:api 全绿且测试只增">
- [ ] <契约项，如"openapi.json + api-types 重导出，CI api-types-drift 绿">
- [ ] <文档项，如"atlas 对应篇目最后核对日期已刷新">

## 回归范围

- 必跑：<本改动直接影响的测试面，如 `npm run test:api` + `npm run test:web`>
- 视足迹加跑：<执行器/SDK/私服自检，如 `npm run test:node-sdk`、`npm run test:nginx-sse`>
- 真机留验：<需要特定环境的项目，注明归入哪轮（参照板上"真机轮"惯例）>

## 完成后

按 [README.md](README.md) 第三节收尾三件套：板行 `done` + commit hash → `AGENT_HANDOFF.md` 状态快照 → 如实声明缩水/遗留。
```

---

## 填写要点

- **涉及文档链接必须真实可点**：指向本树已存在文件；写完自查一遍相对路径层级（本目录在 `08-workflows/task-board/`，上两级到 atlas 根）。
- **足迹写"目录级 + 关键文件"**：与认领板行的粒度一致，足以让他人判断避让。
- **验收项不写"做好 XX 功能"**：写可执行判定（命令 + 期望结果）。
- **回归范围宁多勿漏**：拿不准就对照 [../../07-testing/README.md](../../07-testing/README.md) 的测试面清单选。
