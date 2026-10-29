# 实施轮 #10（2026-10-27）：镜像补齐 + 过期产物下线 + 三套全量回归

> 编排：主控 + 2 个**只读**调研 subagent（SDK 与共享库层 / Agent·SOP 运行时纵深），
> 主控并行做「可立即偿还的技术债」并跑三套全量回归。
> 这是第一次把「调研」与「清账」放在同一轮里并行——调研慢、清账快，互不阻塞。

承接：[实施轮 #9 报告](implementation-round-9-2026-10-27.md) 的遗留 1 与 4。

---

## 1. 落地

| 项 | 改动 | 为什么 |
|---|---|---|
| 站点补 05 教程镜像 | 新增 `packages/docs-site/tutorial-05-sop-agent-demo.md`（重组自 `docs/tutorials/05-sop-agent-demo.md`）+ `.vitepress/config.mts` sidebar 条目 + `tutorials.md` 索引行与「四篇 → 五篇」措辞 | 站点是源头文档的镜像，05 缺席一年无人发现（判据⑧ 是轮 #8 才补的）。**补页 = 让豁免归零**，否则「豁免」会变成永久续期 |
| 下线教程镜像豁免 | `TUTORIAL_MIRROR_EXEMPT` 由 1 条改为 **`[]`**；selftest 沙箱基线同步去掉被豁免条目 | 豁免表的设计意图是"登记待偿还项"，补完必须删——空表才有约束力。**反证**：删掉 sidebar 的 05 条目 → `sync-check` 立即红（"站点 sidebar 缺教程 05-sop-agent-demo"），恢复后 8 面无 drift |
| 过期编译产物下线 | `git rm --cached apps/executor-desktop/src/preload/index.js`（文件仍在磁盘，只是不再入库）；`.gitignore` 早已挡住 `src/preload/*.js(.map)` | 该文件是 2026-06 的编译产物，与已大改的 `index.ts` 漂移；真实产物落 `dist/preload`（`bundle-preload.cjs`），打包只收 `dist/**`。留着它 = 任何按文件名读/grep/评审的工具都会读到过期桥实现 |

自证：`sync-check` 8 面无 drift + 自检全绿；`vitepress build` **build complete**，
产出 `dist/tutorial-05-sop-agent-demo.html`，索引页含该链接；桌面 `tsc` 0、
`renderer.selftest` 0、`check-desktop-selftests-wired` **59/59**。

| 项 | 改动 | 为什么 |
|---|---|---|
| 新开关的 CLI 契约 | `deploy.selftest.sh` 第 13 段：`--help` 能查到 `--allow-degraded`/`--allow-stale-image`、dry-run 下带它们不被当未知参数、拼错（`--allow-degrade`）必须报"未知参数" | 这两个开关是「默认从严 + 显式逃生门」的形态，**最容易在后续重构里被悄悄删掉**——删掉不报错，只是行为退回"永远严格"或"永远宽松"，而这种退化没有任何测试会红 |

自证：`deploy.selftest.sh` **61 → 65 例**，全绿。

## 2. 三套全量回归（本仓第一次在同一轮跑齐）

| 套件 | 结果 |
|---|---|
| admin-api `npm test` | **354 套件 / 6221 例全绿**（61s） |
| admin-web `vitest run --maxWorkers=3` | **250 文件 / 2101 例全绿**（275s） |
| executor-python `pytest -q` | **EXIT 0**，覆盖率 **87.31%**（地板 86） |

这三套是「四轮未提交改动叠加」之后第一次全量跑——此前每轮只跑了受影响的子集。
结论：**四轮叠加没有引入回归**。

## 2.5 真机 e2e：第一次在真实 PG/Redis 上跑通，并当场抓到一个静默污染

本轮首次把 admin-api 的 **e2e 套件**跑在真实数据库上（此前各轮报告都只写"没跑 e2e"）。
环境：复用本机 demo 栈的 Postgres/Redis，但**另建隔离库 `acf_e2e_verify`**
（`127.0.0.1:5432` 被另一个项目占用，故走容器 IP 直连；迁移 + admin seed 全真跑）。

结果：**4 套件 / 38 例全绿**（auth / tasks / executors / openapi-export）。

### 顺带抓到：单独跑 e2e 会**静默抹掉** 1503 处 `x-i18n-en`

- **现象**：跑完 e2e 后 `git status` 多出一份 5059 行的 `openapi.json` diff，
  而所有测试都是绿的。
- **实测证据**：`grep -c 'x-i18n-en' openapi.json` → **1503 → 0**。
- **根因**：`openapi-export.e2e-spec.ts` 是 openapi.json 的 canonical writer，但它写的是
  **纯中文**文档；`swagger:export` 是「spec + `inject-openapi-en.mjs` 注入」两步串联。
  任何**单独**跑 e2e 的入口（`npm test`、裸 `jest --config test/jest-e2e.json`、
  CI 的 admin-api-test job）都只跑了第一步 ⇒ 产物退化成中文单语，且没有任何报错。
  开发者看到的是"e2e 全绿 + 一个莫名其妙的大 diff"，顺手 commit 就把整片英文文档面删了。
- **修法（两层）**：
  1. **落盘开关**：spec 只在 `ACF_OPENAPI_EXPORT=1` 时写文件（该变量**只有**
     `npm run swagger:export` 会设）；其余入口改为"只校验能导出"（断言规模与
     `"openapi"` 字段），并打印 `dry: 203 paths, 604900 bytes (未落盘…)`。
  2. **产物形态守卫**：`inject-openapi-en.mjs --check` 先数产物里的 `x-i18n-en` 条数，
     低于地板 1200 就红并**直接点名成因**（"单独跑了 e2e 而不是 swagger:export"）。
- **反证**：把产物里的 `x-i18n-en` 全剥掉 → 守卫立即红（"只有 0 处，地板 1200"）；
  恢复后绿。改后跑整套 e2e：`x-i18n-en` **1503 → 1503**、`git diff` 为空；
  `npm run swagger:export` 仍能正常落盘且 **零漂移**（注入 1623 处，`x-i18n-en` 1503）。

## 2.6 首部署自举的真机演练（不再只是"读码推断"）

轮 #8 的 OPS-03 此前只有 dry-run 证据。本轮把它做成**真跑**（白盒：tmp 目录里复制
deploy.sh，摘掉末尾 `main`，直接调 `config_phase`——ROOT_DIR 由脚本位置推导，
天然指向 tmp）：

| 场景 | 期望 | 实测 |
|---|---|---|
| staging 全新目录 | 生成并打印管理员口令、写 `ALLOW_LOOPBACK_CORS=true` | ✔ 口令 `c097…`（37 字节）、`ALLOW_LOOPBACK_CORS=true`、`.env` 中 `INITIAL_ADMIN_PASSWORD` 长度合规 |
| production 缺真实域名 | **当场 fail-fast**，不是崩到 ⑧ 才暴露 | ✔ `✘ 生产部署需要真实域名：先设置 ADMIN_WEB_ORIGIN=https://your.domain…本机试跑请用 --env staging` |

三条断言已固化进 `deploy.selftest.sh` 第 14 段（**61 → 69 例**）。

## 3. 两个只读调研 subagent：超时无产出，按预案中断并如实登记

派出的 SDK 层与 Agent·SOP 运行时纵深两个只读 subagent 跑了约 50 分钟没有任何
产出（既无中间消息、也无收尾），主控已 `interrupt_agent` 中断，**不把它们当作
已覆盖**。这是本仓「多代理预案」的第二次触发（第一次是轮 #9 的两个实施 subagent
在收尾前崩溃）——预案有效（没有半成品混进树里），代价是主控要接管。

主控自行做了 SDK 层的**初查**（结果如实记录，不作为完整结论）：

| 检查点 | 结论 | 证据 |
|---|---|---|
| 两个发布 SDK 的重试语义 | **已对齐且有注释**：node `HttpClient` 仅对幂等方法（GET/HEAD/OPTIONS）重试、非幂等只计入熔断；python `autoflow-sdk` 的任务内通道**刻意无重试**（docstring 自述"原文档串声称 basic retry logic 但实现从未有过"），带重试+熔断契约的是 `autocodeflow-http`（与管理面客户端对齐） | `packages/autocodeflow-node-sdk/src/http-client.ts:57,191`；`packages/autoflow-sdk/autoflow_sdk/http.py:150-166` |
| 熔断 | node 是**单实例跨端点共享**（`http-client.ts:497`），python 侧 `autocodeflow-http` 有同构 `CircuitBreaker`（按客户端实例） | 已在 OPEN-DECISIONS B3 登记 |
| 四个 python 库 | 版本仍冻结 `0.3.2`、**仓内零消费者**（grep 全仓无 import、无 pyproject 依赖引用） | `packages/autocodeflow-{ai,http,db,notify}/pyproject.toml:6-7` |
| 可发布包接线守卫 | 8 个可发布包中 4 已接线、4 显式基线豁免 | `node scripts/check-publishable-wiring.mjs` → "✔ …4 个显式基线豁免（待产品决策）" |

**结论**：SDK 层没有发现新的 P0/P1；唯一待决策项仍是 **OPEN-DECISIONS A2**
（四个 python 库：接发布线 vs 删除）——这是产品决策，不是技术债，本轮不动。
Agent·SOP 运行时纵深**未被覆盖**，仍列为下一轮候选。

## 4. 验证矩阵

`npm run test:guards:repo` EXIT=0 · `deploy.selftest` 61/61 ·
`check-desktop-selftests-wired` 59/59 · `sync-check` 8 面 + 自检 ·
`vitepress build` OK · admin-api 6221 例 · admin-web 2101 例 · python 87.31%。
**没跑**：docker compose up、真 AppImage/deb、demo-desktop 真机、Playwright e2e。

## 5. 遗留

1. `dangerouslyIgnoreUnhandledErrors` 仍开（已有分类上报兜底；彻底关掉需 teardown
   竞态不再产生 unhandled rejection）。
2. `e2e-full.sh` 不在本地闸（需真栈）。
3. `deploy.sh` 三个新开关（`--build` / `--allow-degraded` / `--allow-stale-image`）
   需一次真机/真镜像演练。
4. per-IP 硬顶 12000/min 待压测确认。
5. 待下一轮：SDK 层与 Agent 运行时纵深的调研结论。
