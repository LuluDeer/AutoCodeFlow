# 实施轮 #9（2026-10-27）：本地闸门与 CI 对齐 + 测试体系最后三处假绿

> 编排：主控 + 2 个实施 subagent。**两个 subagent 都在收尾前崩溃（无收尾消息）**，
> 但已把主要改动落盘：主控逐项复核、补完缺失部分（自检/接线）、并独立复跑验证。
> 这是本仓「多代理预案」的第一次实战触发——预案有效（没有半成品混进树里），
> 代价是主控要接管验证与收尾。
>
> 承接：[实施轮 #8 报告](implementation-round-8-2026-10-27.md) 的遗留清单前 4 条。

---

## 1. 本轮最重要的一件事：**闸门没接线，于是本地绿、CI 红**

`test:guards`（轮 #6 建）当时只覆盖了 CI 的一部分脚本；实测 `check-shell-multibyte-var.mjs`
长期"只在 CI 跑"。把它接进本地后**立刻抓到 7 处真违规**——而且全是**我上一轮（轮 #8）
自己写进 `deploy.sh` 的**：`$deployed_commit，` / `$head_commit（` 这类「裸变量紧跟
多字节字符」，在 macOS runner 的 bash 3.2 + 非 UTF-8 locale 下会把首字节并进变量名，
`set -u` 直接 `unbound variable` 中止 step。本地全绿、CI 必红。

这条是"接线"价值的最好证据：**判据存在 ≠ 判据在跑**。

落地：
- 新增 7 个 npm 别名（`check:compose-service-env` / `check:desktop-agent-packaging` /
  `check:enum-drift` / `check:index-drift` / `check:migrations` / `check:release-config` /
  `check:shell-multibyte`），并入 `test:guards:repo`；`check-migrations.selftest`
  并入 `test:guards:selftests`。实测全部离线可跑（合计 ~2 秒）。
- 在 `//guards-ci-parity` 注释里**逐条写明仍不纳入的 CI 脚本及其理由**
  （`e2e-full.sh` 需真栈、`install.sh`/`pg-backup.sh`/构建载体不是判据、
  `bug07-windows-selftest.mjs` 仅 windows runner 有意义、`install-artifact-sha256.selftest.sh`
  依赖打包产物），并把 `//test:guards` 里"逐一对应"的过头表述改成事实口径。
- 修掉 7 处违规（`--fix` 走的正是该守卫自己的自动修复路径），复跑 40 文件 0 命中。

---

## 2. 部署链（主控）

| 项 | 改动 | 为什么 |
|---|---|---|
| OPS-06 | `infra_phase` 在 **docker 模式**下不再起 `infra/` 那套 PG/Redis（就绪等待交给 compose 的 `depends_on: service_healthy`） | 此前两种模式都跑 infra compose，宿主上**并存两套 PG**：就绪等待探的是 infra 那套（127.0.0.1:5432 端口映射），而迁移/应用连的是根 compose 的 postgres（无宿主端口）⇒ 运维 `psql`/`pg_dump` 看到的是**空库**，"备份能恢复"演练证明的不是业务库；`compose down` 也停不掉 infra 栈（端口残留） |
| OPS-07 | `pg-backup` 服务挂上 `scripts/pg-restore.sh` | `pg-restore.sh` 自述的"最常用"命令是 `compose run --rm pg-backup bash /usr/local/bin/pg-restore.sh …`，而容器里**没有这个文件** ⇒ 灾备时照抄 runbook 得到 `No such file or directory` |
| 文档 | `operations.md`：恢复步骤改用 `migration:run:prod` + `psql` 查 `migrations` 表；uploads 备份说明改成"**已挂命名卷 `admin_uploads`**，但从不自动备份"并给 tar 命令 | 镜像 `npm ci --omit=dev` + 只 COPY dist ⇒ 容器内**没有 ts-node**，旧命令必失败；旧文案说"compose 未挂卷、重建即丢"与现状相反（→ 运维从不备份该卷） |

自证：`deploy.selftest.sh` **58 → 61 例**（新增：docker 模式不启动 infra 栈 /
source 模式仍启动 / pg-backup 已挂载恢复脚本），全绿。

---

## 3. 测试体系：最后三处假绿

| 位置 | 旧形态（为什么是假绿） | 新形态 | 验证 |
|---|---|---|---|
| `jwt-auth.guard.apikey.spec.ts` | 三处 `try { … } catch { /* 401/异常皆可 */ }` —— 实测吞掉的是 `TypeError: getResponse is not a function`，从没走到 passport；任何装配退化（含 500 泄漏）都判绿 | 补 `getResponse` 到假 context + 注册恒失败 jwt 桩策略把 passport 跑通到 `handleRequest`，断言 `UnauthorizedException` + `status/message` | 5/5 绿（子代理改，主控复核） |
| `agent-trigger.service.spec.ts` | `sweepAggregator()` 后一行 `expect(true).toBe(true)`——名字说"清理过期桶"，实现删空也照样绿 | 正反两态：leader + 已过期桶 → 桶数 0；非 leader + 同一过期桶 → 桶数 1（多副本不重复清理） | 17/17 绿（主控改） |
| `vite.config.ts` 的 `dangerouslyIgnoreUnhandledErrors: true` | **全域**豁免：把真缺陷的浮空拒绝一起无视，"忘了 await/catch"永不红 | 保留开关（关掉会让 React+jsdom teardown 竞态回到随机红——随机红的闸等于没有闸），但补**分类上报**：已知 teardown 特征静默、其余以 `[ACF][unhandledRejection]` 前缀大声打日志；分类器是纯函数并有 4 例边界用例；文件头写明"彻底关掉开关"的前置条件 | 4/4 绿 + `tsc -b` 0（主控改） |

---

## 4. 桌面 P2/P3（子代理改，主控补自检与接线）

| 项 | 改动 |
|---|---|
| uv 探测冻主线程 | 抽 `src/main/diag-probes.ts`：`createUvPathProbe`（**异步 execFile** + 60s TTL 缓存 + 并发合流 + "失败也是结论"），`ipc-handlers` 的 `config:python-env-status` 改为 `async` 先 await 探测再交给纯判定 `classifyUvResolution`；探测门槛也收窄到"纯判定里唯一会读 pathProbe 的第 4 分支" |
| 面板写盘 | `probeWorkDirWritable` 改为 `access(W_OK)` + 显式 `isDirectory`（**不落盘**）；代码里写明取舍：Windows ACL 级别拒绝查不出 ⇒ 面板可能误报"可写"，但误报方向是安全侧（执行器真写失败有结构化报错，面板不参与准入） |
| 过期编译产物 | `apps/executor-desktop/.gitignore` 挡住 `src/preload/*.js(.map)`；已跟踪的 `src/preload/index.js` 需人工 `git rm --cached`（**未执行**，留给提交者） |

主控补的两处（子代理崩溃处）：
- 新增 `src/main/diag-probes.selftest.ts`（3 组、含**反证向**断言：TTL 内只探一次 /
  并发合流 / 失败缓存 / invalidate / 目录内容前后一致 / 文件路径判不可写 / EACCES /
  源码钉"无 spawnSync、无写探针、execFile、preload 被忽略"）。
- 接入 `tsconfig.selftest.json` 的 include 与 `test:main` 链；
  `check-desktop-selftests-wired.mjs` 报告 **59 个 selftest 全部接线**。

---

## 5. 验证矩阵（本轮真实跑过）

| 项 | 结果 |
|---|---|
| `npm run test:guards:repo` | **EXIT=0**（含新接入的 7 个守卫；`check-shell-multibyte` 40 文件 0 命中） |
| `scripts/deploy.selftest.sh` | **61 通过 / 0 失败** |
| `docker compose --profile backup config` | OK（含新挂载） |
| admin-api `jwt-auth.guard.apikey.spec` / `agent-trigger.service.spec` | 5/5、17/17 |
| admin-web 分类器用例 + `tsc -b` | 4/4、0 错 |
| 桌面 `tsc` 双工程 + `diag-probes/health-panel/uv-wiring/export-flows/updater/heartbeat` + `renderer.selftest` | 全绿 |
| `check-desktop-selftests-wired` | 59/59 接线一致 |
| `check:guards-wired` / `check:docs` / `sync-check`（8 面） | 全绿 |
| admin-web 全量 vitest（`--maxWorkers=3`） | **EXIT=0**（249 文件全绿；新增的 rejection 监听未引入任何噪声/红） |
| desktop `test:main`（59 selftest 全链） | **EXIT=0**（含新增 `diag-probes` 与既有 zip-writer/package-candidate 链） |

**没跑**：docker compose up、真 AppImage/deb 更新链、demo-desktop 真机、Playwright e2e。

---

## 6. 遗留（下一轮候选）

1. `git rm --cached apps/executor-desktop/src/preload/index.js(.map)`（提交时一并做）。
2. 彻底移除 `dangerouslyIgnoreUnhandledErrors`（前置条件：teardown 竞态不再产生
   unhandled rejection；届时把分类器的非已知形态改成真抛出）。
3. `test:guards` 仍不含 `e2e-full.sh`（需真栈）——若要本地可跑，需给 e2e 一条
   `compose up + seed + 跑用例 + down` 的一键脚本。
4. docs-site 补 05 教程镜像页（补完删 `TUTORIAL_MIRROR_EXEMPT`）。
5. `deploy.sh` 的 `--build`/`--allow-degraded`/`--allow-stale-image` 三个开关需要
   一次真机/真镜像演练（当前只有白盒与 dry-run 证据）。
6. per-IP 硬顶 12000/min 待压测确认（轮 #8 遗留）。

---

## 7. 交付边界

未提交。当前工作区是**三轮叠加**：轮 #6（约 40 文件）/ #7（16）/ #8（16）/ #9（约 20），
足迹互不重叠。建议提交顺序：轮 #6 → #7 → #8 → #9（每轮一次 commit，消息里带本报告链接）。
