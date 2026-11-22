# R462 —— demo 首次体验真栈验收报告

> 受众：lead / 接手复核者 · 状态：已完成 · 最后核对：2026-11-21
> 报告人写域：仅本文件 `docs/plan/demo-first-experience-review.md`。未碰 `scripts/demo.sh`、`scripts/demo.selftest.sh`、`docs/AGENT_HANDOFF.md` 及任何其它文件。
> 结论一句话：`./scripts/demo.sh` 在独立真栈上两次 exit 0、3/3 task + 3/3 SOP、三句产品承诺逐句闭环；本报告为文档（静态）汇编，证据取自 R458/R460/R461 已完成的真跑，不冒充更高一级。

## 1. 验收目标与最高验收级别

- 验收目标：证明产品核心承诺——**开发者 10 分钟内跑出第一个结果，并愿意把第二件事交给它**。载体为 `./scripts/demo.sh`。
- 最高验收级别（按 AGENTS §4.4 定级）：本次验收以 **浏览器/真机级** 为标尺——要求真实构建产物 + 真实运行环境 + 真实用户路径可达，是四级阶梯的顶格；不接受用静态探查或内存替身替代该结论。
- 本次实际取证级别（诚实口径）：R458/R460/R461 的真跑在独立 docker compose 全栈上完成，落在 **真实进程内集成 + 容器级**——真 PG/Redis、真 Nest admin-api、真 node/python executor、真 HTTP API 触发、真副作用落库。这是本次拿到的最高实测证据；浏览器 GUI 交互路径（含 Windows GUI）未单独取证，详见 §7。
- 本报告性质：R462 为**文档（静态）**任务，汇编上述已完成的真跑证据，**未自行重跑、未改任何代码**。工作树既有的 3 项未提交（AGENT_HANDOFF.md、demo.sh、demo.selftest.sh）是前几轮成果，本报告一律未触碰。

## 2. 真栈环境与命令（隔离性）

- 编排：`docker compose` 起全套 6 组件——postgres、redis、admin-api、admin-web、node executor、python executor。
- 隔离：`compose project = acf-demo`；独立 `.env.demo`；回环端口映射；PG/Redis 走 compose 内部网络，不与宿主或其它项目端口冲突。
- 真跑命令（两次；第二次带 `--down` 保留 volume 重跑，验证幂等）：

```bash
ACF_DEMO_WEB_PORT=18080 ACF_DEMO_API_PORT=31050 ACF_DEMO_EXECUTOR_PORT=18002 ACF_DEMO_PY_EXECUTOR_PORT=18001 ./scripts/demo.sh
```

- 结果：两次均 **exit 0**。
- seed 见证（3/3 task + 3/3 SOP，零失败、零跳过）：

```text
ACF_SEED_SUMMARY {"tasks":3,"tasksFailed":0,"expectedTasks":3,"sops":3,"sopFailed":0,"sopSkipped":0,"expectedSops":3}
```

## 3. 三句承诺逐句验收证据

| # | 产品承诺 | 见证对象 | 真跑结果 | 判定 |
|---|---|---|---|---|
| ① | 第一个结果 | `demo-hello-fixed` trigger | `success`，32ms | PASS |
| ② | 失败可诊断 | `demo-fragile` | `failed`，`failureReason=script_error`；日志端点含原始错误 | PASS |
| ③ | 零代码模板 | 官方模板 `webhook_ping`（migration 预置） | 裸 body instantiate → trigger → `success` | PASS |

三句逐条见证（R458/R460/R461 真跑现场，非转述）：

```text
① 第一个结果   demo-hello-fixed  trigger -> status=success, duration=32ms
② 失败可诊断   demo-fragile      trigger -> status=failed, failureReason=script_error
                GET /tasks/executions/:id/logs -> 原始错误 "demo intentional failure"
                errorMessage 仅存退出摘要 "进程以退出码 1 结束"（execute.ts describeProcessExit）
③ 零代码模板   POST /task-templates/:id/instantiate body={name:"demo-from-template"}
                -> 实例化成功 -> trigger -> status=success
```

- ① 证明「10 分钟内跑出第一个结果」：seed 后第一个 task 即触发成功，端到端 32ms，无需手工编排。
- ② 证明「失败可诊断」：失败原因可通过日志端点定位到原始错误，而不是只给一个无信息的退出码——这正是「愿意把第二件事交给它」的前提。
- ③ 证明「零代码」：从 migration 预置的官方模板直接以裸 body 实例化并触发成功，无需先写代码或复制粘贴定义。

## 4. 过程中发现的 bug 与修复（heredoc 反引号）

- 症状：`demo.sh` 生成 `.env.demo` 时用**未加引号的 `<<EOF`** heredoc，其注释含反引号 `` `--profile rustfs` ``；shell 在展开 heredoc 时执行了反引号命令替换，报 `--profile: command not found`。
- 根因：无引号定界符 `<<EOF` 会对内容做参数/命令替换；带反引号的注释被当成命令执行。
- 修复：将生成 `.env.demo` 的 heredoc 定界符加引号，使内容按字面量展开，不再触发命令替换。
- 影响面：仅限 demo 脚本生成 env 的路径，不涉及产品运行时逻辑。
- 防复发：`demo.selftest.sh` 新增静态守卫，见 §5 的 R458 行。

## 5. 防复发（3 个 selftest 守卫 + 反证）

`demo.selftest.sh` 现有 3 个静态守卫，逐一对应三句承诺所在路径与前述 bug；每个守卫都配反证（故意回归该缺陷即被守卫命中），证明守卫对该类回归敏感、非空跑。

| 守卫 | R | 守护对象 | 反证（守卫敏感性） |
|---|---|---|---|
| heredoc 反引号 | R458 | `.env.demo` 生成用带引号定界符，注释中的反引号不得被命令替换 | 把定界符改回无引号 `<<EOF` 并保留 `` `--profile rustfs` `` 注释 → 守卫命中失败，复现 `--profile: command not found` 回归 |
| 失败诊断 | R460 | `demo-fragile` 失败经日志端点暴露原始错误、`failureReason=script_error` | 去掉日志端点断言或只留退出摘要 `errorMessage` → 守卫命中失败，退回「失败不可诊断」 |
| 模板路径 | R461 | 官方模板 `webhook_ping` 经 `POST /task-templates/:id/instantiate` 裸 body 实例化并触发 | 改掉 instantiate 路径或移除裸 body 实例化步骤 → 守卫命中失败，退回「必须先写代码」 |

三个守卫与反证均在 `demo.selftest.sh` 内，属静态自检层；真实闭环仍由 R458/R460/R461 的真跑证据背书（§3）。

## 6. 幂等与清理证据

- 幂等：同一命令连续跑两次，第二次在**保留 volume** 的 `--down` 之后重跑，seed 仍为 3/3 task + 3/3 SOP、两次均 exit 0——证明可重复执行、不因既有 volume 破坏首次体验。
- 清理：每次跑完执行 `--down`；复核无残留容器、端口释放、`.env.demo` 被 gitignore（不进仓库）。
- 结论：demo 的「起—验—收」闭环干净，适合作为开发者首次体验入口反复运行。

## 7. 边界与诚实声明

- 本机非 GH Actions：真跑在本机 docker compose 环境完成，未在 CI runner 上验证。
- 真跑级别：真实进程内集成 + 容器级（真 PG/Redis、真 Nest、真 executor、真 HTTP API、真副作用落库），以 API 见证点取证；**不是**浏览器 GUI 交互级证据。
- 生产环境部署另按 runbook 执行，本报告不覆盖生产发布口径。
- 未验证 Windows GUI：浏览器/桌面交互路径（尤其 Windows 侧）未单独取证，§1 的浏览器/真机级仅作为验收标尺，不代表本报告已拿到该级证据。
- 本报告为文档（静态）汇编，未自行重跑上述命令；所有数字均来自 R458/R460/R461 已完成的真跑记录。

## 8. 证据索引

- 脚本：`scripts/demo.sh`（首次体验载体）、`scripts/demo.selftest.sh`（3 个守卫 + 反证）——均为工作树既有未提交成果，本报告未修改。
- 上游真跑记录：R458（heredoc 反引号 bug 修复 + 首个结果）、R460（失败诊断路径）、R461（零代码模板路径）。
- 相关 plan 文档：`docs/plan/` 下既有验收报告（风格参照 `ci-realstack-e2e-review.md`、`browser-real-backend-review.md`）；交接口径见 `docs/AGENT_HANDOFF.md`（本报告未改）。
- 关键见证：`ACF_SEED_SUMMARY`（§2）、三句承诺逐条见证（§3）。
