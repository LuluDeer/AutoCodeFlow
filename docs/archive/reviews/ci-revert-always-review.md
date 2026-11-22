# R434 · CI revert drill 常态化独立验收

- 日期：2026-11-22（Asia/Shanghai）
- 执行者：子 agent `r434-ci-verify`（lead 派发，独立于实现 agent `r434-ci-revert`）
- 验收级别：**静态探查 + 守卫实跑**（CodeGraph CLI 探查源码；三个 workflow 守卫含 selftest 真跑；未真跑 GitHub Actions，未新跑 PG）
- 写域：仅新建本报告；未改 ci.yml / 实现 / baseline / 其它 docs；未 commit / push / revert 任何工作树改动
- 关联：R433 `docs/AGENT_HANDOFF.md`「本次交接（R433）」段 + `docs/plan/migration-roundtrip-review.md`；本次复核 `r434-ci-revert` 对 `.github/workflows/ci.yml` 的落盘改动

## 结论速览

| # | 复核项 | 结论 |
|---|---|---|
| 1 | 改动精准 | PASS |
| 2 | job 末态安全 | PASS |
| 3 | 触发矩阵 | PASS |
| 4 | 命令可行性 | PASS（含诚实边界） |
| 5 | CI 守卫 | PASS（三守卫含 selftest 全 exit 0） |
| 6 | 无越界 | PASS（单 hunk，10+/6−，仅目标 job） |
| 7 | 假绿反证 | **发现 P2 残余**：drill 只断言 exit code，无副作用断言 → no-op `down()` 仍可能绿 |

总体：**无 P0 / P1，不建议因本次改动阻断合并**；P2 是 drill 既有设计局限（R434 之前就存在），R434 只提高执行频率、未引入新风险。建议关闭本切片，另开 P2 follow-up 给 revert drill 加副作用断言。

---

## 1. 改动精准 — PASS

落盘后 `git diff -- .github/workflows/ci.yml` 的相关 hunk（改动后 :373–395）：

```diff
-      # ── QA-08：跨版本迁移演练月度增强步（仅 schedule 触发时执行）──────
+      # ── QA-08：跨版本迁移演练增强步（revert 全触发 / drift 月度）──────
...
-      #    否则说明实体与迁移链脱节——历史真机轮抓过迁移链断裂，此为防复发闸）；
-      # ② 最新迁移单步 revert → 重跑（演练 down 路径可达，部署回滚依赖它）。
+      #    否则说明实体与迁移链脱节——历史真机轮抓过迁移链断裂，此为防复发闸）
+      #    仍保持 schedule only（下方 if 不动）：秒级之外的漂移检查按月跑。
...
-      - name: QA-08 drill — revert latest then re-run (schedule only)
-        if: github.event_name == 'schedule'
+      - name: QA-08 drill — revert latest then re-run (all triggers)
```

逐点：

- revert drill 的 `if: github.event_name == 'schedule'` **确已删除**（原 :386；现步骤 :390 无 `if`）。
- drift check 步（:384–388）**完全未动**：`if: github.event_name == 'schedule'` 仍在（:385），步骤名仍为 `(schedule only)`，typeorm check 注释与 `run: npm run migration:generate -- --check ./src/migrations/Qa08DriftCheck` 逐字未改。
- 步骤名 `(schedule only)` → `(all triggers)`，与行为一致；顶部注释块由「月度增强步（仅 schedule 触发时执行）」改为「revert 全触发 / drift 月度」，不再声称 revert 是 schedule only。注释同时明确 drift check 仍 schedule only。
- `working-directory` 与 `run` 块（`migration:revert` → `migration:run` → echo）逐字未动。

## 2. job 末态安全 — PASS

- 步骤序列（改动后）：checkout → setup-node → npm ci → 全链 `migration:run`(:362) → 幂等守卫(:364–370) → `npm run typecheck`(:371) → drift check(:384，仅 schedule) → **revert + re-run(:390–395，末步)**。
- revert 步是该 job **最后一步**；下一个 job `npm-audit` 从 :412 起，且全文件仅一处 `needs:`（:692 `needs: admin-web-build`），**没有任何 job 依赖 `admin-api-migrations`**，不存在跨 job 的 DB 状态继承。
- typecheck 在 :371、**位于 revert 之前**且脚本为 `tsc --noEmit`（`apps/admin-api/package.json`），纯静态、不连 DB；revert 窗口只在该步内部，不影响前面任何已完成的 step。
- 末态：revert 调 `undoLastMigration()` 回退最近一个迁移（0102），紧接 `migration:run` 重放其 `up()`；`up()` 为 `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`（`1790000000102-AddTelemetryOptin.ts`），重放后表/索引/migrations 记录回到全链状态，与注释「job 结束时 DB 状态与全链一致」相符。
- **PR 轮误红判据**：revert 后无任何 step 依赖 DB，无 `needs` 下游，无新增条件阻断 ⇒ 不存在「revert 后某步读不到表而红」的 P0 形态。

## 3. 触发矩阵 — PASS

js-yaml 解析 `.github/workflows/ci.yml` 实测：

```text
on keys: [ 'push', 'pull_request', 'workflow_dispatch', 'schedule' ]
job if: (none -> runs on ALL triggers)          # admin-api-migrations 无 job 级 if
step[6] name="QA-08 drill — entity/migration drift check (schedule only)" if="github.event_name == 'schedule'"
step[7] name="QA-08 drill — revert latest then re-run (all triggers)" if=(none)
```

| 触发 | admin-api-migrations job | drift check | revert drill |
|---|---|---|---|
| `push`（develop） | 跑（无 job 级 if） | skip（if 不匹配） | **跑** |
| `pull_request`（main/develop） | 跑 | skip | **跑** |
| `schedule`（nightly cron） | 跑 | 跑 | **跑** |
| `workflow_dispatch` | 跑 | skip | **跑** |

无残留 `if` 或条件阻断；drift check 严格只在 schedule。

## 4. 命令可行性 — PASS（含边界）

- `apps/admin-api/package.json`：`migration:revert` → `ts-node -r tsconfig-paths/register src/migration-lock-cli.ts down`；`migration:run` → 同 CLI `up`。`migration-lock-cli.ts:18` 用 `process.argv[2] === "down"` 选方向，:25 进 `runMigrationsWithAdvisoryLock`，异常经 `main().catch` → `process.exit(1)`，故真抛错会让 CI 红。
- `data-source.ts:26–30` 读 `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE`，与 job 级 env 和 postgres service（`postgres:16-alpine@sha256:0cefaab…`，POSTGRES_USER/DB 由 job env 给出）逐一对应<!-- metric-docs:ignore-unknown 这是 PostgreSQL 数据库名，不是指标名 -->。
- R433 实证（`docs/plan/migration-roundtrip-review.md`，真实 PG 进程级）：独立库上 ①建库 ②全量 146 up ③二次 up 打 `No migrations are pending` ④表/索引/记录断言 ⑤`migration:revert` ×2（0102→0101，终态 144=146−2）⑥DROP DATABASE 残留 0，**六步全 exit 0**；日志显示 revert 实际执行 `DROP INDEX`/`DROP TABLE`/`DELETE FROM migrations` + `COMMIT`，不是空跑。
- **诚实边界**：R433 用的是 PG 18.7 + 独立库，只验了「up/revert 各自」与「revert 链」，**没有验「revert 一步后立即 re-run 恢复」这一完整往返**，也没在 CI 的 `postgres:16-alpine` + job DB 上跑。本次验收**未真跑 GitHub Actions，也未新起 PG 做往返实测**；命令可行性结论建立在「同一 CLI、R433 已证 up 与 down 各自可用、SQL 为 PG 通用 DDL」的推断上。属静态+守卫级证据，不是进程级往返证据。

## 5. CI 守卫 — PASS

改动后逐个实跑（含各自 selftest）：

```text
npm run check:workflow-yaml   EXIT=0   13/13 selftest；10 个 workflow 全可解析，1154 映射项 0 处未加引号冒号
npm run check:actions-pinned  EXIT=0   13/13 selftest；10 文件 / 109 处 uses —— 109 已固定 SHA、0 本地、0 docker
npm run check:runner-labels   EXIT=0   7/7 selftest；10 workflow / 60 处取值全为固定版本或登记豁免
```

action SHA 未被破坏：diff 不含 `uses:` 行；checkout `3d3c42e5…` / setup-node `949feb24…` 原样，守卫统计 109/109 pinned 与基线一致。

## 6. 无越界 — PASS

`git diff --numstat -- .github/workflows/ci.yml` → `10 6`，单文件单 hunk，全部落在 `admin-api-migrations` job 的注释块 + 两个目标 step。其它 job / step / 触发条件 / 顶层 `on:` / `permissions` / `concurrency` 零改动；action pin、runner label、scripts、baseline 均未触碰。

## 7. 假绿反证 — 发现 P2 残余风险

**问题**：revert drill 的 `run` 块只有三条命令，`echo "revert + re-run OK：down 路径可达"` 是硬编码成功语，**没有任何副作用断言**：

```yaml
run: |
  npm run migration:revert
  npm run migration:run
  echo "revert + re-run OK：down 路径可达"
```

**两种 no-op 形态都能绿**：

1. `undoLastMigration()` 空退：TypeORM 1.1.2 `MigrationExecutor.js:296–302` 在 `migrations` 表无记录时只打日志 `No migrations were found in the database. Nothing to revert!` 并 `return`，**不抛错**；CLI 正常 exit 0。随后 `migration:run` 若也无 pending 会打 `No migrations are pending` 并 exit 0 ⇒ 步骤绿。（本 job 全链刚跑完，正常路径不会触发此形，但一旦有前置故障/竞态使它成立，CI 不会报。）

2. **更现实的一种——`down()` 本身是空实现**：`undoLastMigration()` 仍会跑完（空 down）并 `DELETE` 掉 migrations 记录 ⇒ revert exit 0；紧接着 re-run 执行 0102 的 `up()`，而该 `up()` 用 `CREATE TABLE IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`（已核源码），表已存在也不报错，记录重新插入 ⇒ re-run exit 0，步骤绿。**此时 down() 根本没反向做任何事，CI 仍宣称 "down 路径可达"。** 这正是 R434 想堵的「down() 写了从没日常验证」缺口的一个没被真正覆盖的角。

对照：幂等守卫(:364–370)有 `grep -q "No migrations are pending"` 断言，R433 报告也用 psql 断言了终态（两表 NULL、migrations 计数 144）；**revert 步没有等价断言**——既不校验 revert 输出里的迁移名，也不校验表/索引消失或行数从 146→145。

**结论**：R434 的收益是真实的（把 down() 从「只在 nightly 跑」变成「每个 PR 都跑」，抛错型 down() 缺陷现在会在 PR 轮被抓）；但 drill 无法识别「静默 no-op 型 down()」。这是**既有设计局限**，非 R434 引入的回归，不阻断本切片关闭。

**修复建议（follow-up，不在本切片做）**：revert 后加一条可证伪断言，二选一——
- 捕获 revert 输出并要求出现被回退迁移名（如 `AddTelemetryOptin`）与 `DELETE FROM "migrations"`，否则 `exit 1`；
- 或 revert 后用 psql/to_regclass 断言最新迁移的表已不存在，re-run 后再断言表恢复；并校验 re-run 输出**不应**含 `No migrations are pending`。

---

## 缺口分级与建议

| 级别 | 项 | 说明 |
|---|---|---|
| P0 | 无 | 未发现 PR 轮误红路径；revert 为末步、无 DB 依赖下游 |
| P1 | 无 | 改动精准、守卫全绿、无越界 |
| **P2** | 假绿反证 | revert drill 无副作用断言，no-op `down()` 仍可能绿（既有局限）；建议 follow-up 加断言 |
| P3 | 证据边界 | R433 未覆盖「revert→re-run 往返」与 CI 的 PG 16；本次未真跑 GH Actions；属披露，不阻断 |

**是否建议关闭：建议关闭 R434。** 改动本身精确、安全、无越界，PR 轮不会误红；P2 作为独立 follow-up 单独立项。
