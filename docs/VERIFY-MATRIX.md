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

## 八、R8 追加行（2026-11-04 · 灰度 claim 的**真实部分唯一索引**真机闭环）

> 记录：`apps/admin-api/src/modules/application/__tests__/app-deployment.rollout-claim.spec.ts`
> 的头注自陈——上一版 25 条测试**全绿**，真机上**多机灰度全线失效**：`repo` 是 mock，
> **数据库的部分唯一索引根本不在测试环境里，23505 永远不会发生**。该 spec 现在的
> `enforceClaimUniqueness` 是**手动复刻**约束并**主动抛 23505**：测法正确（挡的是
> "服务层忘了处理 23505"），但**证明不了索引真被建出来、谓词真是 `IS NOT NULL`、
> UPDATE 时真做冲突检查**。本节把这条结构底线搬到**真 PG16** 上验。

| 变更类型 | 必跑项（本轮新增口径） | 本轮结果 | 脚本（可复现） |
|---|---|---|---|
| **application / 灰度 claim（部分唯一索引）** | ① 同应用**第二个非空 claim ⇒ 必须 23505**（UPDATE / INSERT / 同 batchId / plpgsql 诊断四路）② **NULL 不受约束**（同应用多行 NULL 合法）③ **释放后可再 claim**（置 NULL ⇒ claim 另一批次）④ **不同应用各自 claim** ⑤ **两条连接并发** claim 同一应用 ⇒ 一胜一 23505 ⑥ 索引**真的存在**且 `WHERE` 谓词含 `IS NOT NULL` | ✅ 六条全过（40 条断言 0 失败）：索引定义 `CREATE UNIQUE INDEX uq_app_deployments_rollout_claim ON public.app_deployments USING btree ("applicationId") WHERE ("rolloutBatchClaimId" IS NOT NULL)`；同应用第 2 个非空 claim 在 **UPDATE** 与 **INSERT** 两条路径都被 PG 拒（`ERROR:  23505 ... "uq_app_deployments_rollout_claim"`），同 batchId 也拒；plpgsql 诊断 `SQLSTATE=23505 CONSTRAINT_NAME=uq_app_deployments_rollout_claim`；claim 存在时同应用再插 2 行 NULL 仍成功（NULL=6 / 非空=1）；释放后另一行 claim 另一批次成功；两个应用各自 claim 同一 batchId 字符串都成功；并发下连接 A 持事务 4s、B 阻塞 ≈4278ms（`pg_locks` 出现 1 个 not-granted 锁）后被拒 23505，终态恰 1 条非空 claim | `scripts/verify-smoke-rollout-claim.sh`（场景名 `r5-rollout-claim`） |

### 8.1 关键实现选择（改脚本前必读）

1. **索引必须由 admin-api 自己的迁移链建成**：脚本**不**手工 `CREATE INDEX`，而是断言
   `migrations` 台账含 `AddRolloutBatchClaim1790000000095` —— 否则只是"我会写 DDL"，
   验不到"部署时迁移真的跑了"。
2. **造的行 `status='stopped'`（不是默认 `'pending'`）**。同表还有另一个部分唯一索引
   `uq_app_deployments_application_in_flight` = `UNIQUE("applicationId") WHERE status IN
   ('pending','deploying')`（迁移 `1789000000000`，实测谓词 `status = ANY (ARRAY[...])`）
   ⇒ 一个应用要多行时若用 `pending`，**第 2 行撞的是另一个索引** ⇒ 23505 会被**错误归因**
   到 claim 索引（正是本场景要防的形态）。`rolloutState` 同样留 NULL。
3. **并发用"真持锁 + 轮询"造，不用 sleep 猜**：连接 A `BEGIN; UPDATE; SELECT pg_sleep(4);
   COMMIT;`（SQL 走 stdin ⇒ psql 逐句发送，事务控制真实生效；`-c` 多语句会被塞进一个
   隐式事务，`BEGIN` 只报警告）；轮询 `pg_stat_activity` 见 `pg_sleep` active 才起 B；
   轮询 `pg_locks where not granted` = 1 作为"B 真的在等 A"的 **DB 侧证据**（这也顺带
   证明了两个 claim **时间上重叠**，不是顺序重试）。
4. **错误码与约束名从同一份输出取**：`psql -v VERBOSITY=verbose -v ON_ERROR_STOP=1`
   ⇒ 错误行形如 `ERROR:  23505: duplicate key value violates unique constraint "..."`
   （SQLSTATE + 索引名同现）；另有一条 plpgsql `GET STACKED DIAGNOSTICS` 的机读断言，
   不依赖文案格式。

### 8.2 有牙证明（反例，必做）

在隔离栈的**一次性** PG 上 `DROP INDEX uq_app_deployments_rollout_claim` 后重跑：
`PASS=26 FAIL=14`，红点正是 A1（indexdef 空 / indpred 为 NULL）与 A2/A6（`UPDATE 1`、
`INSERT 0 1` 全部**成功**、两条并发 claim 并存）。⇒ "删掉索引这条脚本确实会红"，
不是恒绿。栈随后 `down`（PG 数据在容器层，`rm -f` 即消失，下次 `up` 迁移重建索引）。

### 8.3 可重入与残留

- **跑前清理**（步骤 0a）：`smoke_preclean_tasks "smoke-claim-"`（本场景不建 tasks 行，
  但统一契约不破）+ 按 `applications.name LIKE 'smoke-claim-%'` 删 `app_deployments` /
  `applications`，并**验证两查残留 = 0**。每句 DELETE 都带 WHERE。
- **双跑实测**：连跑两次均 `PASS=40 FAIL=0 exit=0`（单次约 12s，含 4s 并发持锁）。
  `verify-smoke-selftest.sh --double=` 的 `run_twice` **只支持** `r5-migration`/
  `r5-retention` ⇒ 双跑证据由手工连跑给出，不声明 selftest 已覆盖本场景。
- **残留**：脚本**不**起容器/网络/卷（用调用方的 `acfsmoke-*` 隔离栈）；步骤 9 判据分两态
  —— 栈在跑时要求"**本栈之外**零残留 + 59000/59001 空闲"，栈已销毁时要求**四查全空**。

### 8.4 未验证项（如实）

- **服务层的 claim 接线**（`claimRolloutRows` 的 CAS `WHERE claim IS NULL`、失败终结时释放、
  `deploy()` 复用行清 claim）未在本场景覆盖：本脚本验的是**DB 约束本身**（这是单测永远
  验不到的那一层），服务层那一层仍由 `app-deployment.rollout-claim.spec.ts` 的源码契约 +
  假仓储覆盖。两层互补，**互不替代**。
- **真两实例**（两个 admin-api 进程抢同一应用）未造：需要两个 API 容器 + 共享 PG/Redis，
  且在灰度 API 面上造出"同时 upgradeAllWithRollout"的时序；本脚本用**两条 PG 连接**
  验证了同一约束下的并发语义（DB 是最终裁判），但"两个 Nest 实例的时序"未覆盖。
- **崩溃窗口**（claim 未释放即进程死亡 ⇒ `markInterruptedRolloutsFailed` 兜底扫描）未造：
  需要杀进程于特定窗口。


## 九、静态检查面改成**自动发现** + 双跑扩到三个场景（2026-11-04）

### 9.1 修的缺口（登记过两次的未收口项）

`scripts/verify-smoke-selftest.sh` 的静态检查面原先是**写死列表**（4 个 `.sh` + 3 个 `.mjs`），
不含第八轮新增的 `verify-smoke-dispatch.sh` 与第九轮新增的 `verify-smoke-rollout-claim.sh`
⇒ 三项静态判据（①有跑前清理 ②清理有验证 ③范围有界/无无 WHERE 的 `DELETE FROM tasks`）
**扫不到这两个文件**，它们写了全表删也不会红。**写死列表的失败形态是"漏检却报绿"**，
比误报红危险得多。

### 9.2 改法：自动发现 + **下界断言**（`SH_MIN=6` / `MJS_MIN=3`）

- 扫描面 = `scripts/verify-smoke-*.sh` ∪ `scripts/verify-smoke-*.mjs` **减去**非场景文件
  （`SH_EXCLUDE`：`selftest` 自身 / `common`（被 source 的库）/ `all`（入口）/
  `stack`·`s3-stack`（起栈工具））。实测命中 **6 个 `.sh` + 3 个 `.mjs`**。
- ⚠️ **下界是这条改法的必需品**：自动发现失去"写死列表"的自证性，目录改名或 glob 失配
  会变成**零命中全绿**。故两条下界断言计入 PASS/FAIL（不是只打印提示）。
- **静态 PASS 21 → 29**（+6 = 两个新场景 × 3 项；+2 = 两条下界断言）。实测
  `--static-only` = **PASS=29 FAIL=0 exit=0**。

### 9.3 有牙证明（在 `/tmp` 副本上做，**不改真文件**）

复制整份 `scripts/verify-smoke-*` 到 `/tmp/acf-probe`（基线同样 29/0，证明探针忠实现行代码），
再逐项变异：

| 变异 | 结果 |
|---|---|
| `dispatch` 副本加 **无 WHERE** 的 `psql_q "delete from tasks;"` | **红**：点名该文件 + `行 138`，PASS=28 FAIL=1 exit=1 |
| `rollout-claim` 副本加 `psql_q "DELETE FROM tasks"`（大写无 WHERE） | **红**：点名该文件 + `行 135`，PASS=28 FAIL=1 exit=1 |
| 同上但只写在 `#` **注释**里（对照组） | **绿**（PASS=29 FAIL=0）⇒ 剥注释状态机仍有效，无误报 |
| 只留 2 个 `.sh` + 1 个 `.mjs`（模拟 glob 失配） | **红**：两条下界失守，PASS=9 FAIL=2 exit=1 |
| 全删（模拟零命中） | **红**：`发现 0 个`，PASS=0 FAIL=2 exit=1 ⇒ **零命中不再可能全绿** |

### 9.4 双跑扩到三个场景（默认值）

`DOUBLE_SCENARIOS="r5-dispatch,r5-migration,r5-rollout-claim"`（`run_twice` 的 `case` 同步加了
两个宿主 bash 分支；容器 `.mjs` 分支保留给 `r5-retention`）。真机实测（镜像**重建**后
`Created 2026-11-04T23:24:46+08:00` 晚于 `apps/admin-api/src` 最新改动，且
`/app/dist` 内含排序协作者与三个源码标记）：

| 场景 | 第 1 次 | 第 2 次 | 两跑小结 |
|---|---|---|---|
| `r5-dispatch` | exit=0 / 7s | exit=0 / 6s | **PASS=59 FAIL=0** 两跑逐字一致 |
| `r5-migration` | exit=0 / 4s | exit=0 / 3s | PASS=15 FAIL=0 两跑一致 |
| `r5-rollout-claim` | exit=0 / 8s | exit=0 / 7s | **PASS=40 FAIL=0** 两跑一致 |

自检整跑 **PASS=34 FAIL=0 exit=0**（29 静态 + 起栈 + 3 个双跑 + 残留四查）；
残留四查**全空**（容器/网络/卷/端口 55432·56379·43105·59000·59001）；
现网 `acf-*` 栈**零触碰**。

### 9.5 两个新场景的清理验证（静态关第二项）——**均达标**

- `dispatch`：`smoke_preclean_tasks "smoke-disp-"`（`tasks` 本前缀 = 0）+ 自建
  `clean_own_executor_rows` 三查（`applications` / `executors` / `app_deployments` 各 = 0），
  失败即 `exit 1`（不带着脏数据继续）。
- `rollout-claim`：`smoke_preclean_tasks "smoke-claim-"`（本场景不建任务，契约不破）
  + 两查（`applications` / `app_deployments` = 0），失败即 `exit 1`。
- 两者**每句 DELETE 都带 WHERE**（否则 9.3 的反证会红）。

### 9.6 口径更正（**本节作废两处旧说法**）

- **§6.3** 的「对最快的两个脚本（migration / retention）做真双跑」已过时：默认双跑现在是
  `dispatch` / `migration` / `rollout-claim` 三个；`retention` 仍在 `run_twice` 的容器分支里
  可按需 `--double=r5-retention` 指定。
- **§8.3** 的「`--double=` 只支持 `r5-migration`/`r5-retention` ⇒ 双跑证据由手工连跑给出，
  不声明 selftest 已覆盖本场景」**已经不再成立**：`r5-rollout-claim` 的双跑现由 selftest
  真跑（上表 PASS=40 两跑一致）。

### 9.7 未收口（如实）

- 下界 `SH_MIN` / `MJS_MIN` 是**人工登记的事实常量**，新增场景必须同步 +1，否则会**早报红**
  （不是漏检，但仍需人改）。这是刻意取舍：宁可早红。
- 静态关 ①（`.sh`）的判据仍是 `smoke_preclean_tasks` 这个**字面量**：将来若出现用别的清理
  入口的场景，会**假红**（当前 6 个场景全部走共用件，不构成问题）。
- 静态关只看源码形态，**不证明清理真的生效**：那由 9.4 的双跑与全矩阵第二遍证明。
