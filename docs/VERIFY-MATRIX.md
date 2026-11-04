# 真机验证矩阵 Checklist（QA-04）

> **受众**：发版前做真机验证的维护者 · **状态**：稳定 · **最后核对**：2026-11-02

> 目的：把十五轮真机验证（V 系列）沉淀的「单测全绿 ≠ 能跑」教训固化为**按改动类型必跑**的清单。
> 用法：每轮开发按「变更类型」勾选对应行；验证结论写进 `docs/VERIFY-roundN-<date>.md`。
> 纪律来源：N2（PG enum 单测全 mock 未暴露）、N1（迁移链空库断裂）、第八轮 P0（分步表单）、W-20（win32 大小写）——全部是真机/跨平台才暴露的缺陷。

## 一、平台矩阵

| 平台 | 拓扑 | 覆盖状态 | 必跑场景 |
|---|---|---|---|
| Linux x86_64 (Docker Compose: PG16+Redis7+nginx) | 基线 | ✅ 每轮（第五轮起 V 系列全量） | 全部 |
| Windows 11 全栈（Node 24 + uv + WSL2 PG/Redis） | 基线 | ✅ 2026-09-05 R14 起入 CI（PR/dispatch e2e） | node 执行器全链 + python venv 链 + taskkill 树杀 + 中文/空格路径 |
| macOS（Intel / Apple Silicon） | 扩展 | ⬜ 待 DSK-01 | desktop 打包 + 注册/任务/回调 + 自启动 |
| Linux ARM64 | 扩展 | ⬜ 待 DSK-05/BUG-20 | multi-arch 镜像冒烟 |
| 裸机部署（非容器） | 扩展 | ⬜ 从未测 | 路径分隔符/信号语义/服务化（systemd） |

## 二、拓扑矩阵

| 拓扑 | 覆盖状态 | 关注点 |
|---|---|---|
| 单 admin + 单执行器 | ✅ 基线 | 功能冒烟 |
| 双 admin 实例（Leader Election） | ✅ 第五轮 V（80 execution 无重复，kill 后 35s 接管） | 触发不重复、Leader 迁移、claim 双保险 |
| 双执行器混布 | ✅ 第五轮 V（精确 2+2 无超卖） | loadScore、槽位释放、pinned/broadcast |
| admin 滚动重启 | ⚠️ 部分（N51 已知一次 401，自愈） | 心跳对齐、回调连续性、BullMQ 恢复 |
| Redis 宕机 / PG 重启 | ⬜ 待 QA-06 混沌 | fail-open 降级、PENDING 兜底 FAILED |
| 执行器断网 30s 恢复 | ✅ 部分（stale 扫描+活性探测） | 误判率、429 重试链不双跑 |

## 三、变更类型 → 必跑清单（核心表）

| 变更类型 | 必跑项（缺一不验收） |
|---|---|
| **调度器 / BullMQ / 队列** | ① compose 真机冒烟（15s fixed_rate 任务 gap 均值 ±20ms）② 空库迁移链双轮 ③ 双实例无重复触发 ④ 队列深度/指标端点可见 |
| **数据库实体 / 迁移** | ① 空库纯迁移链（禁 DB_SYNCHRONIZE）② 存量库续跑无损 ③ 迁移幂等 up/down 双跑 ④ 实体↔迁移漂移守卫（第十五轮 e2e-full 教训） |
| **executor-node src** | ① 全量 jest ② **ncc bundle 同 commit 重打**（W-18 守卫）③ Windows CI job ④ 真机注册/四类任务/回调/kill 全链 |
| **executor-python** | ① pytest 全量 ② Windows venv/P-3 直连链 ③ 回调三方 HMAC 测试向量一致（admin/node/py 同向量）④ uv/uvicorn 真链路 |
| **RBAC / 权限收紧** | ① 前后端同批发布（N11/W2 教训）② 三角色 × 端点矩阵 spec ③ Playwright 角色门控例 ④ api-reference 同步 |
| **token / 认证链** | ① register/token/心跳三点采纳 ② 401 自愈（forceTokenRefresh）③ 回调 HMAC 三方同测试向量 ④ 旋转后 30min→一次往返收敛 |
| **通知 / 外发** | ① 五渠道真发（wecom/dingtalk/slack/webhook/SMTP）② config-first 语义 ③ SSRF deny 段回归（198.18/100.64/::ffff:）④ 密码脱敏回显 |
| **SSE / 日志流** | ① nginx 60s 读超时下 15s ping 保活长流 ② 并发上限 503 ③ 断流轮询兜底 ④ 多实例容量口径（线性叠加） |
| **上传 / 部署链** | ① 500MB 包流式上传不驻留内存 ② nginx client_max_body_size 510m 对齐 ③ 版本隔离+回滚 ④ 部署指令鉴权头 |
| **admin-web 表单/页面** | ① lint+vitest+build ② Playwright 全量 29 ③ 分步表单跨步提交（getFieldsValue(true) 守卫）④ 非 admin 视角走查（403 面隐藏） |
| **桌面端 / IPC** | ① npm run test:main（路径域 selftest）② bundle drift 守卫 ③ 托盘/自启动/停机信号链（Win SIGBREAK） |
| **回调链路改动** | ① 批量回调 ≤100 分片 ② 死信落盘+重试预算+deadLetterCount 心跳 ③ KILLED 终态不被覆盖 ④ 槽位释放（含秒级完成 RETURNING 窗口） |

### 3.1 R5 追加行（2026-11-04 · 调度/队列/迁移改动强制 compose 冒烟）

> 记录：A6（`230e3b54`）、A6b（`b9d8f70e`/`9903c0bf`/`292c6a52`）、X5（`71e593ae`）三簇改动
> **此前只有单测、一次真机未跑**；本轮按「调度器 / BullMQ / 队列」+「数据库实体 / 迁移」
> 两行的必跑项补齐。完整报告见 `artifacts/rounds/r5-smoke-matrix.md`。

| 变更类型 | 必跑项 | 本轮结果 | 脚本（可复现） |
|---|---|---|---|
| **数据库实体 / 迁移** | ① 空库纯迁移链 ② 存量库续跑无损 ③ 迁移幂等 up/down 双跑 ④ 实体↔迁移漂移 | ✅ 迁移 `1790000000096` 真 PG 上 up/幂等/down 全通过（存量零回填、DDL 重放 3 次 0 报错、down 后列消失且**内容指纹**不变） | `scripts/verify-smoke-migration.sh` |
| **调度器 / 队列** | ① compose 真机冒烟 ② 空库迁移链双轮 ③ 双实例无重复触发 ④ 队列深度/指标端点可见 | ✅ A6b 真链路 4 项全过（不勾选落点照跑 / 勾选跳过一次且下一拍恢复 / 重复勾选 409 / **重启后登记仍有效**）；A6 补偿窗口收紧后**未被无关执行吞点**（真产生 misfire 执行行）、抑制日志为 **warn** 级、同任务 30 分钟**限流**生效（第二次退回 debug） | `scripts/verify-smoke-firepoint.sh`<br>`scripts/verify-smoke-misfire.sh` |
| **retention / 不可逆删除** | （本轮新增口径）真库真删一次，验分批边界 + 幂等 + 边界不越界 + 不影响活跃数据 | ✅ X5 `cleanupExpiredMetricsHistory` / `cleanupOldRecords`（含完整 @Cron 入口）在真 PG 上真删除通过：5001 行跨两批删净、幂等返 0、保留期内行存活、`tasks`/`executors` 行数不变 | `scripts/verify-smoke-retention.mjs`（容器内跑） |

> **隔离与清理**：四个场景共用一个**与现网 `acf` 栈完全隔离**的最小栈
> （`acfsmoke-postgres`/`acfsmoke-redis`/`acfsmoke-admin-api`，端口 55432/56379/43105，
> 随机口令落 `/tmp` 不入库）。起停：`scripts/verify-smoke-stack.sh up|down`
> （down 会删净容器/网络/卷/临时口令文件）。
> **时区事实（下一轮必读）**：宿主 CST(UTC+8) 而容器/PG 是 UTC，
> `TIMESTAMP WITHOUT TIME ZONE` 列按宿主墙钟构造数据会**偏 8 小时** ⇒ 真机验证一律用 DB 侧 `now()`。
>
> **一键复跑**（R5 全部 + R6 全部，串行、任一失败即停并打印定位信息）：
> ```bash
> bash scripts/verify-smoke-all.sh          # 全量（约 15 分钟，不含首次构建镜像）
> bash scripts/verify-smoke-all.sh --list   # 列出场景名
> bash scripts/verify-smoke-all.sh --only=r5-migration   # 单场景调试
> ```
> 每步日志落 `/tmp/acf-smoke-<场景名>.log`；**不接 CI**（真机矩阵需要 docker daemon、
> 且场景 2/3 必须真等 cron 落点与自然 tick ⇒ 分钟级耗时 ⇒ 定位为本机/发版前手工跑）。

### 3.2 R6 追加行（2026-11-04 · S3 日志后端真机闭环）

> 记录：`LOG_STORAGE_DRIVER=s3` 的**写入 / 读取 / 保留期回收 / 故障回退**四条链路
> 此前只有替身 spec（mock 掉 `minio` 客户端）⇒ 本轮首次在**真 RustFS 1.0.4**（Apache-2.0，
> S3 兼容）上真跑。完整报告见 `artifacts/rounds/r6-smoke-s3.md`。

| 变更类型 | 必跑项 | 本轮结果 | 脚本（可复现） |
|---|---|---|---|
| **S3 日志后端 / 对象存储** | （本轮新增口径）① 写入：对象真落 S3 + gzip 签名 + **DB 侧不写行** + 指针正确 ② 读取：完整日志取回（含**超单页上限**的长日志分页无重复无遗漏）③ 保留期回收：删对象 / 清指针 / **边界不越界** / **幂等** / 非终态不动 ④ **S3 不可用时回退**（真停容器 ⇒ 落 DB + 指针收回 + 读面仍可用） | ✅ 四项全过：2500 行日志在 DB 侧 **0 行**、全部外置对象存储，读面仍分页取回**全部 2500 行**且游标精确衔接（`big-2000` 起、`big-2499` 止）；回收数恰为 2（终态+超期+s3 指针），保留期内(25d<30d)/`running`/`logStorage='db'` 三类守门者**均未被删**；二次跑返 0；真停 RustFS 后 `logStorage` 被收回 `'db'`、`execution_log_lines` 写入 2 行、读面仍可读 | `scripts/verify-smoke-s3-stack.sh`<br>`scripts/verify-smoke-s3.mjs`<br>`scripts/verify-smoke-s3-retention.mjs`<br>`scripts/verify-smoke-s3-fallback.sh` |

> **起 RustFS 的两个坑（脚本已内建处理）**：① 手工 `docker run` 起 rustfs **必须自己 chown**
> `10001:10001`（compose 靠一次性 `volume-permission-helper` 做），否则启动即
> `Permission denied (os error 13)`（`docs/deployment.md:826` 已记）；② **别用 `--profile minio`**——
> 本仓已从 MinIO 换成 RustFS。
>
> **一键复跑**（含 R5 全部）：同上一节 —— `bash scripts/verify-smoke-all.sh`。
> R6 三个场景的脚本单独跑也可（需先 `bash scripts/verify-smoke-s3-stack.sh up` 起栈）。

## 四、验证记录模板（VERIFY-roundN）

```markdown
# VERIFY-roundN（日期）
## 环境
- 拓扑 / 镜像 / commit / 平台
## 场景与断言
| # | 场景 | 断言 | 结果 |
|---|---|---|---|
## 新发现（真机才暴露的缺陷）
- N编号 P级 描述 → 修复 commit
## 临时放行回看（安全缺口候选）
- 本轮为通过验证做的任何临时放行 → 收紧措施
```

## 五、CI 与本清单的关系

- `ci.yml` 24 job 覆盖单测/构建/迁移链/e2e（Linux push + Windows PR）与 desktop-bundle-drift、npm-audit 守卫。
- 本清单覆盖 CI **不能**覆盖的面：真机拓扑（Leader 迁移、负载均衡）、渠道真发、长时稳定性、平台信号语义、性能水位。
- 每轮 PR 描述需附「本轮触达的变更类型 + 对应必跑项执行证据」。

## 六、冒烟脚本的可重入纪律（2026-11-04 追加）

> **背景**：上一轮真机实测暴露的 harness 债 —— `verify-smoke-firepoint.sh`
> **步骤 7（等下一 cron 落点自然触发）未跑完**（撞 300s 硬上限）；**二次重跑时
> 步骤 0 建任务失败**，原因是首次运行残留了 `smoke-fp-cron-a` / `smoke-fp-cron-b`
> 两个任务 ⇒ **脚本在脏 DB 上不可重入** ⇒ 真机矩阵**只能跑一次**。
> 更糟的形态是**假绿**：某些断言（如「审计表里有没有某条记录」）在脏 DB 上
> **靠上一次的残留就能"通过"**。

### 6.1 盘点：每个脚本写什么 / 清不清 / 脏 DB 上重跑会怎样

| 脚本 | 写入的持久状态 | 原有清理 | 脏 DB 上重跑会怎样 |
|---|---|---|---|
| `verify-smoke-firepoint.sh` | `tasks`(name `smoke-fp-cron-a/b`) + `task_executions` + `audit_logs`(`task.fire_point_consumed`) | **跑后**删 tasks（子行靠 FK CASCADE；`execution_log_lines` 无 FK ⇒ 漏删） | **步骤 0 建任务失败**（`idx_tasks_name_unique` 唯一索引）⇒ 硬失败 |
| `verify-smoke-migration.sh` | `tasks`(name `smoke-mig-a/b/c/d`) | **跑后**删 tasks | **步骤 1 INSERT 失败**（唯一索引）⇒ 硬失败 |
| `verify-smoke-misfire.sh` | `tasks`(`smoke-misfire-c/d`) + **手工 INSERT 的 `task_executions`**（"无关执行"） | **跑后**删 tasks | **步骤 0 建任务失败** ⇒ 硬失败；且残留执行行会污染下一轮的"窗口内已有执行"判定 |
| `verify-smoke-retention.mjs` | `tasks`(name `smoke-retention-<ts>`) + `task_executions` + `executor_metrics_history`(`smoke-retention-*` / `smoke-bulk-*` / `smoke-boundary`) | **跑后**删 metrics（按 executorAddress）+ 执行行 + task | seed 名字带 `Date.now()`（不撞索引）⇒ **能跑**，但**上一轮的残留 metrics 行**会让"批量删 5001 行"断言**多算** ⇒ 假红（若断言写 `>=` ⇒ **假绿**） |
| `verify-smoke-s3.mjs` | `tasks`(`smoke-s3-<ts>`) + 2 个 `task_executions` + **S3 对象** `execution-logs/<execId>.log.gz`（键含 execId ⇒ **确定性复用、不会被覆盖**） | **跑后**删对象 + DB 行 | seed 名不撞索引 ⇒ 能跑；但**残留 S3 对象永远不会被覆盖** ⇒ 惰性垃圾，且"对象真在 RustFS 里"断言会被上一轮的残留干扰 |
| `verify-smoke-s3-retention.mjs` | `tasks`(`smoke-s3-gc-<ts>`) + 6 条 `task_executions` + **S3 对象** `execution-logs/gc-*.log.gz`（**确定性 tag**） | **跑后**删对象 + DB 行 | 同名对象被覆盖（无害）；但**上一轮的 victim 执行行还在 DB** ⇒ 本轮"回收数 = 2"会**多算** ⇒ 假红（`>=` ⇒ 假绿） |
| `verify-smoke-s3-fallback.sh` | `tasks`(`smoke-s3-fallback`) + `task_executions` + `execution_log_lines`(2 行) | **跑后**删三者 | **步骤 1 建任务失败**（唯一索引）⇒ 硬失败；且**RustFS 残留成 stopped** ⇒ 步骤 0 也失败 |
| `verify-smoke-stack.sh` / `verify-smoke-s3-stack.sh` | 容器 / 网络 / 卷 / 宿主端口 / `/tmp` 口令文件 | **有**（`down` 全删） | 幂等（`up` 复用已起的）⇒ 但端口被占时会硬失败 |
| `verify-smoke-all.sh` | 汇总入口（自身不写 DB） | 预检**自动清理**残留的 `acfsmoke-*` 容器/网络/卷 | 幂等（每步前后查残留） |

### 6.2 修法：**跑前清理**（不是跑后清理）

- 共用件：`scripts/verify-smoke-common.sh`（`smoke_clean_tasks` / `smoke_preclean_tasks`）。
- 每个脚本在**开始时**（步骤 `0a`）按**确定性的名字前缀**清掉**自己会写的那批数据**，
  并**验证清理生效**（清完查计数 = 0 ⇒ 计数 ≠ 0 或查询失败 ⇒ **中止**）。
  ⇒ **"上一次跑到一半失败"能被下一次自动修复**。
- **跑后清理保留**（同一实现、同一口径）⇒ 但**可重入不依赖跑后清理成功**。
- ⚠️ **清理范围严格限定在自己的前缀内**：
  - 每句 `DELETE` 都带 `WHERE`（`tasks.name LIKE '<前缀>%'` 或按**本前缀任务的 id** 反查）；
  - **绝不** `DELETE FROM tasks`（无 WHERE ⇒ 删全表）——
    `verify-smoke-selftest.sh` 的静态检查**专门守这条**（剥注释后扫无 `WHERE` 的
    `DELETE FROM tasks`）；
  - `execution_log_lines` 是**分区表**且对 `task_executions` **无外键**
    ⇒ 必须**显式**删（否则删了执行行，日志行还留着）。

### 6.3 可重入的**有牙证明**：`scripts/verify-smoke-selftest.sh`

- **连跑两次同一个脚本**，断言**两次都 PASS** ⇒ 这是"可重入"的唯一实测证据
  （"加了跑前清理"只是声明）。
- 覆盖策略（时间盒）：对**最快的两个脚本**（`r5-migration` ~4s、`r5-retention` ~1s）
  做**真双跑**；其余脚本做**静态检查**（有跑前清理 / 清理有验证 / 范围有界）。
- 用法：
  ```bash
  bash scripts/verify-smoke-selftest.sh                                  # 静态 + r5-migration 双跑
  bash scripts/verify-smoke-selftest.sh --double=r5-migration,r5-retention # 双跑两个快场景
  bash scripts/verify-smoke-selftest.sh --static-only                     # 不碰 docker
  ```
- **双跑已经抓到的三个真 bug**（单跑一次看不出）：
  ① `string_agg(uuid, text)` 在 PG 无此重载 ⇒ 需 `id::text`；
  ② `in (uuid1,uuid2)` 不是合法 SQL ⇒ 需 `quote_literal`；
  ③ `execution_log_lines."executionId"` 是 **varchar** 而 `task_executions.id` 是
     **uuid** ⇒ 直接比较报 `operator does not exist: character varying = uuid`
     ⇒ 子查询侧需 `id::text`。

### 6.4 `firepoint` 步骤 7 的等待上界（不再是硬编码 300s）

- **等的是什么**：任务 B（cron `*/1 * * * *`）在**被跳过的那一拍之后**的
  **下一个计划落点**自然触发（证明"不是永久 mute"）。
- **落点间隔**：由**生产代码同源**算出（容器内 `node-cron` 的 `getNextRuns(2)`，
  并用 `computeNextCronFirePoint` 交叉校验第一拍）⇒ 不硬编码。
  实测：`*/1 * * * *` ⇒ **60s**；`0 3 * * *` ⇒ **86400s**。
- **上界** = 落点间隔 + 余量（reload tick 注册 90s + 入队落库 30s）
  ⇒ `*/1 * * * *` 时 = 60+90+30 = **180s**（原为硬编码 300s，
  且那个数**与被等对象无关** ⇒ 换表达式就可能不够）。
- **超时消息**写清三件事：**等的是什么 / 已经等了多少 / 下次最早何时可验**
  （"下一个整分钟之后"）。

### 6.5 真机残留四查（每次自检结束必查）

容器 / 网络 / 卷 / 端口（`55432` `56379` `43105` `59000` `59001`）**四项全空**才算通过。

### 6.6 复跑时的推荐顺序

```bash
bash scripts/verify-smoke-selftest.sh   # ① 先验「可重入」（静态 + 快场景双跑）
bash scripts/verify-smoke-all.sh        # ② 再跑全矩阵（7 场景）
bash scripts/verify-smoke-all.sh        # ③ **同一台机器再跑一遍** ⇒ 应仍然 7/7 PASS
```
③ 是"真机矩阵可重复执行"的端到端证据（② 之后 DB 里已有第一轮的数据 ⇒
第三步若还能过 ⇒ 跑前清理确实生效）。


## 七、R7 追加行（2026-11-04 · `dispatch` 候选排序与偏好分区真机闭环）

> 记录：T1-B3e 把 `dispatch` 的评分排序 / `scoredSnapshot` / 部署偏好分区 /
> 解释器缓存分区搬进 `ExecutorDispatchRanking` 协作者之后，**真机只做到
> 「注册 3 台 + 触发任务」**——上一轮的任务指向不存在的 `s3://b/x.zip`，
> 执行落 `failed/script_error`、容器日志里没有 `dispatch.decision`
> ⇒ 派发根本没走到排序环节，五条断言全部未验证
> （见 `artifacts/rounds/r7-dispatch-impl.md` §4）。本节把那五条补齐。

| 变更类型 | 必跑项（本轮新增口径） | 本轮结果 | 脚本（可复现） |
|---|---|---|---|
| **executor / 调度派发（dispatch 排序）** | ① 落到**评分预期**的执行器（不是注册最早/最近、也不是在跑任务最少那台）② 部署**偏好分区**生效（有亲和性那台评分更差也优先）③ `scoredSnapshot` 在**占坑前**截取（E-2）④ **重复派发抑制**仍在 ⑤ **三条失败出口**分别造出 | ✅ 五条全过（59 条断言 0 失败）：评分 0.450/0.100/0.525 三台实测与公式一致，落点 B 既非最早注册（A）也非最近注册（C）、也非 runningTaskCount 最小（C=1）；给评分最差的 C 造一条 running 部署行后任务改落 C 且 `deploymentAffinity={preferred:1,matchedByExecutorId:1}`、C 评分 0.525 > 候选最低 0.117（纯评分会派别人）；同一份 decision 日志里 `topRunners` 是占坑**前**读数（B=2）而 `selected` 是占坑**后**实体（B=3）且 DB 占坑后 = 3；同参在跑时二次触发 409 且只有 1 条执行行 / 1 条 decision 日志 / 槽位只 +1；`PINNED_EXECUTOR_AT_CAPACITY`（只满钉定那台）/ `NO_DISPATCHABLE_EXECUTOR`（3 台在线全满）/ `NO_EXECUTOR_MATCHING_FILTERS`（3 台全离线）三条文案两两不同、`executorAddress` 均为空 | `scripts/verify-smoke-dispatch.sh`（场景名 `r5-dispatch`） |

### 7.1 三个「怎么造场景」的关键实现选择（改脚本前必读）

1. **执行器用 `dispatchMode='pull'`**。排序/分区/决策日志全部发生在传输分支
   **之前**；若用 push + 不存在的地址，占坑会被 `compensateClaimedSlot` 回滚
   ⇒ 占坑前后的 `runningTaskCount` 无法区分 ⇒ **E-2（③）就验不了**。
   pull 走 Redis 队列入队、占坑保持 ⇒ 「日志里的占坑前读数」与「DB 里的占坑后
   读数」可同时拿到。**代价（如实）**：本场景不覆盖 push 的 HTTP 传输面
   （那由 `docs/VERIFY-MATRIX.md` 拓扑矩阵的既有项覆盖）。
2. **亲和性用真 `app_deployments` 行**（`status='running'`，指向评分最差那台），
   不是伪造分区输入 —— 走的是 `resolveDeploymentConstraintContext` 的生产读路径。
3. **带 `applicationId` 的任务必须显式 `codeSource:'glue'`**。只给
   `applicationId` 时 `resolveDispatchTask` 按「存量 zip 兜底」
   （`codeSource == null && applicationId`）当 zip 渠道 ⇒ 要求应用配
   `packageUrl`，派发在传输前就失败（本轮实测踩到：`failed/script_error`
   「未配置 packageUrl」）。

### 7.2 可重入与残留

- **跑前清理**（步骤 0a）覆盖三张表：`tasks`（`smoke_preclean_tasks`，含
  `task_executions`/`execution_log_lines`/审计行）+ `applications` + `app_deployments`
  + **`executors`**。⚠️ 执行器必须清：地址唯一性只在 push 模式成立
  （`uq_executors_address` 的 partial 谓词），pull 模式下重注册会**新增同地址第二行**
  ⇒ 候选池从 3 变 6 ⇒ 评分期望值全错。
- **双跑实测**：`bash scripts/verify-smoke-dispatch.sh` 连跑两次，两次均
  `PASS=59 FAIL=0 exit=0`（单次约 6s）。`verify-smoke-selftest.sh --double=` 目前
  只支持 `r5-migration`/`r5-retention`（`run_twice` 的 `case` 分支），**不支持**
  `--double=r5-dispatch` ⇒ 双跑证据由手工连跑给出，不声明 selftest 已覆盖本场景。
- **残留四查**：容器 / 网络 / 卷 / 端口（55432 / 56379 / 43105 / 59000 / 59001）
  结束全空（`verify-smoke-all.sh --only=r5-dispatch` 自己会 down 栈并打印三查为空；
  端口与 `/tmp/acf-smoke-env*.sh` 由人工复核）。
- **镜像**：本场景断言「镜像 `Created` 晚于 `apps/admin-api/src` 最新 mtime」+
  「`/app/dist/.../executor-dispatch-ranking.collaborator.js` 含
  `scoredSnapshot`/`INTERP-CACHE`/`ARCH-35` 三处源码标记」。⚠️ 实测教训：
  `docker build` 命中**全缓存**时 `Created` 仍是上一次构建的时间 ⇒ 该断言会红，
  此时必须 `docker build --no-cache`（或先 `down` 再 `up` 不带
  `ACF_SMOKE_SKIP_BUILD=1`）。

### 7.3 未验证项（如实）

- **push 传输分支**（HTTP POST 到执行器 + SSRF pinning + 槽位补偿回滚）未在本场景
  覆盖：拉起的隔离栈在容器网络内、宿主端口对容器不可达（实测 `172.26.0.1`/`172.17.0.1`
  均 `CONNECT_TIMEOUT`），且假地址会让占坑被补偿回滚（见 7.1-1）。要验需要
  一个真监听 `api/execute` 的执行器（或 `EXECUTOR_ALLOW_PRIVATE_NETWORK=true` + 可达宿主端口）。
- **解释器缓存分区**（`interpreterCacheAffinity`）未造场景：需要执行器上报
  `interpreters` 且任务声明 `runtimeVersion`（Python 多版本面），本轮只验了
  「未声明版本 ⇒ `null` 且不影响排序」这一条隐式行为。
- **strict 部署约束**（`deploymentConstraint` / `DeploymentConstraintWaitError`）未造场景：
  属 FEAT-22 的独立面，本轮只验 prefer（软偏好）。
- **多实例（双 admin）下的重复派发抑制**未覆盖：本场景单实例，验的是触发闸门
  （`blockStrategy=discard` / 触发短锁）+ 「一次执行一条 decision 日志」，
  跨实例的 DB claim（`claimTaskTrigger`）由 `r5-firepoint`/`r5-misfire` 间接覆盖。
- ⚠️ 场景观测面：`blockStrategy` 闸门**刻意不计 PENDING**（只算 RUNNING/WAITING）
  ⇒ 「刚建好就 5 个并发触发」真会出现 2×201（本轮实测）。这不是重复派发抑制失效，
  故 A4 的场景改为「先等第一次落 RUNNING，再打第二次」。
