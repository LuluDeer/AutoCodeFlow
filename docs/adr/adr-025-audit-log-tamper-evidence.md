# ADR-025: 审计日志不可篡改性——append-only 触发器已是有效控制，**不引入哈希链**

状态：Accepted（本轮拍板；**不实施哈希链**，理由见「决策」与「本轮实施与否」）

> 本文把 `PLAN-SECURITY-HARDENING.md` §6.1–6.2「审计日志不可篡改性」从「待办」转成**已拍板**。
> 结论前置：**本轮不做哈希链，也不做链式校验脚本。** 现有 DB 层 append-only 触发器是有效控制，
> 但它的**真实边界**必须写清楚（本文「实测」一节）；而计划 §6.1-6.2 的哈希链设计在这张表的
> 实际约束下存在**四类结构性假阴性**（尾部截断 / TRUNCATE 清空 / 无密钥可重算 / 存量行无基线），
> 外加**并发分叉**与**规范化序列化**两处阻塞——做了等于给运维一份虚假的安全感。
>
> 本文同时记录一项**比哈希链更便宜、更强**的改进方向（最小权限 DB 角色）——
> 它是当年迁移头注所依赖的「兜底」，而它**至今没有建立**。

---

## 背景

### 现有控制：一条 DB 层行级触发器

`audit_logs` 的不可改删由迁移 `1790000000006-AuditLogsAppendOnlyGuard` 建立的**行级触发器**承担：

| 事实 | 位置 |
|---|---|
| 守卫函数 `audit_logs_append_only_guard()`，`plpgsql` | `apps/admin-api/src/migrations/1790000000006-AuditLogsAppendOnlyGuard.ts:38-52` |
| `TG_OP = 'DELETE'` 且会话 GUC `app.bypass_audit_guard = 'on'` → `RETURN OLD`（放行） | 同文件 `:41-44` |
| 否则 DELETE → `RAISE EXCEPTION ... DELETE denied`（`ERRCODE = 'P0001'`） | 同文件 `:45-46` |
| UPDATE → 无条件 `RAISE EXCEPTION ... UPDATE denied` | 同文件 `:48-49` |
| 触发器 `trg_audit_logs_append_only`，`BEFORE UPDATE OR DELETE`，`FOR EACH ROW` | 同文件 `:56-60` |
| 幂等：`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` / 函数 `CREATE OR REPLACE` | 同文件 `:39`、`:54`；`down` 在 `:63-70` |

**唯一放行点**（应用侧）：保留期清理任务在事务内先 `SET LOCAL app.bypass_audit_guard = 'on'`，再分批 DELETE。
常量 `AUDIT_GUARD_BYPASS_SQL` 在 `apps/admin-api/src/modules/audit/audit.service.ts:20`，
唯一使用点 `retentionDelete()` 在 `:93-115`，调用方 `cleanupOldAuditLogs()` 在 `:126-140`。

**合法 UPDATE 场景经全仓核查为零**（迁移头注 `:16-25` 记录；`apps/admin-api/src/modules/audit/__tests__/audit-append-only.spec.ts:46-113`
用源码静态扫描把它钉成不变量：`AuditService.prototype` 方法面白名单、`this.repo.save(` 恰好 1 处、
`this.repo.delete(` 恰好 0 处、消费方不得出现 `auditService.(update|delete|save|...)`）。

### 实测：触发器**挡得住什么**、**挡不住什么**

以下不是推测。本次评估在本机真 PG（`PG 16`）上用**生产同一个守卫函数**建临时表逐项试写，
结果（`SAVEPOINT` 包裹，不留残留）：

| 攻击手法 | SQL | 结果 | 结论 |
|---|---|---|---|
| 改写一行 | `UPDATE ... WHERE id=2` | **DENIED**（`audit_logs is append-only: UPDATE denied`） | ✅ 挡得住 |
| 删掉一行 | `DELETE ... WHERE id=2` | **DENIED**（`... DELETE denied (use retention cleanup job)`） | ✅ 挡得住 |
| **清空表** | `TRUNCATE audit_logs` | **ALLOWED** | ❌ **挡不住** |
| **关触发器再改** | `ALTER TABLE ... DISABLE TRIGGER ...` 后 `UPDATE` | **ALLOWED** | ❌ **挡不住**（需属主） |
| **改会话复制角色再改** | `SET LOCAL session_replication_role = replica` 后 `UPDATE` | **ALLOWED** | ❌ **挡不住**（需超级用户） |

**为什么 TRUNCATE 挡不住**：触发器声明是 `BEFORE UPDATE OR DELETE ... FOR EACH ROW`
（`1790000000006:57-59`）——**没有 `BEFORE TRUNCATE`**，而 `TRUNCATE` 是语句级操作、不逐行走行触发器。
全仓检索：迁移目录内 `TRUNCATE|session_replication_role|DISABLE TRIGGER` **零命中**，即没有任何地方补过这个缺口。
> **更新（已收口）**：`TRUNCATE` 已于迁移 `1790000000057-AuditLogsNoTruncateGuard.ts` 收口（`BEFORE TRUNCATE ... FOR EACH STATEMENT` 守卫，恒拒绝、无逃生门）；上表该行与下文同类表述是收口前的实测记录，其余两行（属主关触发器 / 超管改复制角色）**仍然放行**。

**为什么后两条挡不住**：触发器的禁用权在**表属主**手里，用户触发器的触发与否受
`session_replication_role` 控制（该 GUC 仅超级用户可设）。这两条不是实现疏漏，是 PostgreSQL 的固有语义
——**任何纯 DB 内的防篡改机制都无法对抗拥有 DB 属主/超级用户权限的人**。这一点是本文全篇的判据核心。

### 读面与鉴权（核实过，不是假设）

| 端点 | 位置 | 鉴权 |
|---|---|---|
| `GET /api/audit` 分页查询 | `apps/admin-api/src/modules/audit/audit.controller.ts:32-52` | 类级 `@UseGuards(JwtAuthGuard)`（`:19`）+ `@Roles(UserRole.ADMIN)`（`:34`） |
| `GET /api/audit/export` CSV 导出（上限 10 000 行） | 同文件 `:54-81` | 同上 + `@Roles(UserRole.ADMIN)`（`:59`） |

`RolesGuard` 是**全局** `APP_GUARD`（`apps/admin-api/src/app.module.ts:726` JwtAuthGuard、`:731` RolesGuard），
`canActivate` 读 `@Roles` 元数据、无元数据则放行已认证用户（`apps/admin-api/src/common/guards/roles.guard.ts:20-35`）。
两条审计读面都显式挂了 `@Roles(ADMIN)`，因此**非管理员读不到审计行**——这一条是好的，无需改动。

CSV 导出另有两条纵深（`audit.service.ts`）：公式注入前缀转义 `:211-222`、行上限有痕截断 `:244-247`。
查询面全部走**绑定参数**（`findAll` `:281-296`、`exportCsv` `:165-184`），无字符串拼接。

### DB 账号：迁移头注依赖的「兜底」**实际上没有建立**

迁移头注 `:14` 的原话是：

> 真正的越权 INSERT/直连 DB 篡改由 **DB 账号权限模型**兜底（不在应用面）。

这句话作为**论证**是正确的，但作为**本仓现状**并不成立。核实结果：

| 事实 | 位置/证据 |
|---|---|
| 应用连接账号缺省就是 **`postgres`（超级用户）** | `apps/admin-api/src/config/configuration.ts:58`（`process.env.DB_USERNAME \|\| "postgres"`） |
| compose 部署下 `POSTGRES_USER` 缺省 `autoflow`，官方镜像会把它建成**超级用户** | `docker-compose.yml:24`；`.env.example:8` |
| 应用连接的 `DB_USERNAME` 缺省 `autoflow`，与上同一个账号 | `docker-compose.yml:148`；`.env.example:17` |
| 迁移由**同一个连接账号**执行（`migration:run` 走 `src/migration-lock-cli.ts`） | `apps/admin-api/package.json:24-28` |
| **全仓从未创建过最小权限角色** | 迁移目录 `CREATE ROLE\|GRANT \|REVOKE ` **零命中**；`.yml/.sql/.md/.mjs/.sh` 全域 `CREATE ROLE\|REVOKE ALL\|NOSUPERUSER` **零命中** |
| 本机实测：`audit_logs` 的属主 = `postgres`（表属主即超级用户） | `SELECT pg_get_userbyid(relowner) ...` → `audit_logs` / `audit_logs_id_seq` 均为 `postgres` |

**推论**：应用账号要么是 `audit_logs` 的**属主**（能 `ALTER TABLE ... DISABLE TRIGGER`），要么是**超级用户**
（能 `SET session_replication_role = replica`）——上表两条「挡不住」的攻击手法**都在应用账号自己的权限范围内**。
换句话说：**目前挡住篡改的不是「账号权限模型」，而只是「应用代码里没有写 UPDATE/DELETE」这条约定**
——而「应用代码里没有」正是哈希链想要补强的那一层。

> 这是本次评估**唯一**发现的、比哈希链更值得做的事，见「决策」第 2 条。

### 写入频率：审计写入在**请求热路径**上

`audit.log(` / `auditService.log(` 在 `apps/admin-api/src` 下共 **44 处直接调用**，另有 `auth` 模块 4 处跨行调用
（`auth.controller.ts:150/205/403/441`，形如 `await this.auditService` 换行接 `.log({...})`，
故不计入上面的 44 处单行匹配）。分布：

| 模块 | 调用点 | 是否热路径 |
|---|---|---|
| `task.controller.ts` | **17 处**（`:154, 202, 328, 377, 424, 470, 648, 687, 716, 764, 775, 1093, 1144, 1216, 1249, 1281, 1320`） | 写面请求，多数已挂 `OPS_THROTTLE` 30/min |
| `auth.controller.ts` | **login（`:150`）、logout（`:205`）、revokeSession（`:403`）、revokeOthers（`:441`）** | **登录是明确热路径** |
| `projects.controller.ts` | 6 处（`:200, 227, 249, 308, 337, 361`） | ADMIN 写面 |
| `task-batch.controller.ts` | 4 处 | 批量写面 |
| `notification-config.controller.ts` | 3 处 | ADMIN 写面 |
| `users.controller.ts` | 3 处 | ADMIN 写面 |
| `event-subscription.service.ts` / `app-deployment.service.ts` | 各 2 处 | 写面 |
| `execution-events.listener.ts:132` | **每次失败通知**（按执行事件触发） | **事件驱动，非用户操作限流保护** |
| 其余（`task-webhook.service` / `executor.service` / `registry.controller` / `api-keys.service` / `application.service` / `task-template.controller`） | 各 1 处 | 写面 |

**关键语义差异**：`auth.controller.ts:150-160` 等处是 `await ... .catch(warn)`——**写失败不阻断请求**（fail-open，刻意）；
而 `task.controller.ts` 等绝大多数是裸 `await this.audit.log({...})`——**审计写失败会抛到响应**（fail-closed）。
这个不一致不是本文要解决的问题，但它是评估「加锁」代价时必须看见的事实：
**任何给 `AuditService.log` 增加串行化的改动，都会把这 44+ 个调用点的延迟变成「排队时长」。**

---

## 当年为什么选 append-only 而非哈希链（引迁移头注），以及现在是否变化

迁移 `1790000000006` 头注 `:9-14` 原文照录：

> 拍板论证（append-only vs hash-chain）：audit_logs 已有 admin 写面唯一入口（`AuditService.log`；
> `findAll`/`exportCsv` 只读），哈希链在 PG 侧 UPDATE 权限模型下收益/成本比差——
> **链头要另存受保护位置、重算链要全表扫描、且防不住持 DBA 权限的攻击者改链头**；
> append-only 触发器把最常见的篡改路径（UPDATE 改写/DELETE 灭迹）直接堵死，纵深收益即达成本下限。
> 真正的越权 INSERT/直连 DB 篡改由 DB 账号权限模型兜底（不在应用面）。

### 这段论证今天还成立吗——逐条复核

| 当年论点 | 现在是否变化 | 依据 |
|---|---|---|
| 写面唯一入口 | **未变** | `audit-append-only.spec.ts:46-113` 把方法面/写点/消费方三重钉成不变量 |
| 链头需另存受保护位置 | **未变，且更明确** | 见下「假阴性 ①」——无外部锚点的链**天然**检不出尾部截断 |
| 重算链要全表扫描 | **未变** | 校验必须按 id 全序重算；`audit_logs` 是高频写入大表（迁移 `1790000000022:8-10` 的原话） |
| 防不住持 DBA 权限者改链头 | **未变，且实测加了一条**：`session_replication_role = replica` 可直接绕过触发器；`TRUNCATE` 完全不受触发器约束 | 本文「实测」表 |
| 由「DB 账号权限模型」兜底 | **⚠️ 这一条不成立** | 全仓从未建最小权限角色；应用账号即表属主/超级用户（见上节） |

**结论：这段记录的取舍在方向上依然正确，而且本次评估让「为什么不选哈希链」的理由更硬了**——
当年只是说「收益/成本比差」，现在可以证明：**在无外部锚点的前提下，哈希链对 §6 所针对的威胁
（DBA / 直连 DB 篡改）提供的是零保护**，而不是「较少保护」。

**唯一变化的条件**是：当年那条「兜底」是**假设**，现在核实为**不存在**。
但这不构成「所以要上哈希链」的理由——它构成「所以要先建最小权限角色」的理由（见「决策」第 2 条）。

---

## 三个选项的代价对比

### 选项 A：检测而非预防——只加链式哈希，写入路径不动，提供离线校验

**表面代价很低**：加两个可空列（`previousHash` / `selfHash`）+ 一个离线校验脚本，写入路径「不动」。

**但它必须证明一条命题才能成立**：
> 并发写入下，不会出现「行被删/被改，而校验仍通过」的假阴性。

**这条命题在本表上无法成立。以下是四类彼此独立的结构性假阴性，外加一类并发相关的假阴性与一处工程阻塞，逐条给出证据：**

**① 尾部截断——永远检不出（结构性，无解除非外部锚点）**
攻击者删掉**最后 k 行**，剩余序列仍然是一个自洽的链（每一行的 `previousHash` 都与前一行 `selfHash` 吻合）。
校验「从头算到尾、每步比对」会**全部通过**。
这正是迁移头注「链头要另存受保护位置」说的那件事——而**本仓没有任何受保护的外部锚点**
（无 WORM 存储、无外部日志汇聚、无签名高水位）。**在补齐锚点前，A 类机制对「删掉最近的痕迹」这一
最现实的攻击（灭迹）完全无效。** 计划 §6.2 的校验脚本 `PLAN-SECURITY-HARDENING.md:433-449`
正是「从头顺序重算」的形态，**不含任何锚点比对**。

**② `TRUNCATE` 清空——校验在空表上「通过」**
实测 `TRUNCATE audit_logs` **被放行**（触发器没有 `BEFORE TRUNCATE` 分支）。
清空后校验遍历零行、零违例 → 退出码 0。**「表被清空」与「表本来就是空的」在校验输出上不可区分。**

**③ 全链重算——无密钥哈希对「有 DB 写权限者」提供零保护**
计划 §6.1（`PLAN-SECURITY-HARDENING.md:426-429`）用的是 `sha256(JSON.stringify({...entry, previousHash}))`
——**无密钥**。任何能写这张表的人（= 当前的属主/超级用户，见上文）都能 O(n) 地把全部哈希重新算一遍，
产出一条**完全合法**的新链。这与「同时也能直接改内容」是同一批人。
→ 对 §6 明确点名的威胁模型（「理论上可被 ADMIN 修改」，`:402-403`），A 的防护强度是 **0，不是打折**。
（注：改成**带密钥 HMAC** 并把密钥只放在应用侧 env 里，能挡住「纯 DB 权限」攻击者——但这不再是计划
§6.1 的方案，且仍需 ① ② ④ 全部解决。）

**④ 存量行无法回溯建链——链有一段永不可验的前缀**
`previousHash`/`selfHash` 只能新增可空列，而**存量行无法 UPDATE 回填**——append-only 触发器禁止 UPDATE
（本文「实测」第一行），这一点仓库文档已经写明：`docs/atlas/03-data/entities/audit-log.md:56`
「注意**存量行不可 UPDATE 回填**（append-only 触发器），只能接受 NULL」。
→ 链必然从某个 `id` 中途起步。**该 `id` 之前的所有行连同「删除它们」这个行为，都不在校验覆盖范围内**；
且链的起点本身是一个无锚点的「创世哈希」，投毒/伪造成本为零。

**⑤ 并发分叉——若容忍分叉则产生假阴性，若不容忍则产生假报警**
计划 §6.1 的写法是 `findOne({order:{id:'DESC'}})` 再 `save`（`PLAN-SECURITY-HARDENING.md:423-429`），
这是典型的 **read-then-write 竞态**：两个并发 `log()` 会读到同一个链头，写出两行 `previousHash` 相同的记录
→ 链**分叉**。之后：
- 若校验**不容忍**分叉（要求 `row[i].previousHash === row[i-1].selfHash`）→ 正常业务并发就**报篡改**（假阳性）；
- 若校验**容忍**分叉 → 分叉区间内删行**检不出**（假阴性）。

**这正是上一轮的判定**（`PLAN-SECURITY-HARDENING.md:487-488`）：
「计划里的 `findOne` + `save` 在并发下不是安全的链式写入，需要串行化或 advisory lock」。
本轮补充的是：**即使串行化了，① ② ③ ④ 依然全部成立**——串行化只解决 ⑤，而 ⑤ 是五个里最不重要的一个。

**⑥ 规范化序列化本身也不成立（工程细节，但足以让校验永远误报）**
必须确定键序、时间格式、NULL 处理，否则校验永远误报。本表有两个具体陷阱：

- `createdAt` 列是 `TIMESTAMP`（**无时区**），默认 `now()`（`apps/admin-api/src/migrations/1717473142678-InitialSchema.ts:147`）。
- PG 存**微秒**，JS `Date` 只有**毫秒**。本机实测：`audit_logs` 49 行中 **49 行**的 `createdAt` 微秒位非零；
  例 `2026-10-18 00:58:02.752295` 经 `pg` 驱动读成 JS `2026-10-17T16:58:02.752Z`（**丢掉 295 微秒**）。
- 因此**写时用 JS 对象算哈希、校验时用 JS 对象重算**必然不一致 → **永久性假阳性**。
  唯一正确做法是在 SQL 侧用 `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` 之类生成规范串，
  但那样写入路径就必须让 DB 参与算哈希（多一次往返或改用生成列），**「写入路径不动」的承诺直接破产**。

> **A 的判决**：命题「无假阴性」**证伪**（①②③④ 独立成立，⑤ 是并发相关，⑥ 是工程阻塞）。
> 按任务纪律「证明不了就不要实现」——**A 不实施。**

### 选项 B：用 advisory lock 串行化链式写入

**基建已存在，不必新造锁**（这一点核实过）：

| 现有锁基建 | 位置 | 形态 |
|---|---|---|
| `RedisLockService`（`acquireLock` / `extendLock`，内置 watchdog 按 TTL/3 续期） | `apps/admin-api/src/common/services/redis-lock.service.ts:28`（N3 惰性建连 `:41-59`） | 分布式锁，已在 `SchedulerService`、`TaskService`、`LeaderGateService` 中使用 |
| `pg_try_advisory_lock` 会话级锁 + 固定常量键 | `apps/admin-api/src/common/utils/migration-runner.util.ts:33`（`MIGRATION_ADVISORY_LOCK_KEY = 727412345678`）、`:96` | 迁移互斥；轮询 try 而非阻塞等待（`:18-22` 记录了「阻塞等待会被 `statement_timeout` 掐断」的教训） |
| `LeaderGateService`（cron Leader 门控） | `apps/admin-api/src/common/leader-gate/leader-gate.service.ts:59` | 已在 `AuditService` 保留期清理中使用（`audit.service.ts:75-76`、`:129`） |

所以 B **在工程上可行**，代价也能量化：

| 维度 | 评估 |
|---|---|
| 安全收益 | **0**。串行化只消除「分叉」（假阴性 ⑤），①②③④⑥ 一条都没解决。**买到的只是「链是漂亮的」，不是「篡改能被发现」** |
| 吞吐影响 | 审计写入是**请求热路径**（44+ 直接调用点，含登录、每次失败通知）。全局一把锁 = 所有实例的审计写串行。`RedisLockService` 的 `commandTimeout: 3000`（`redis-lock.service.ts:50`）意味着 Redis 抖动时单次获取最长可挂 3s；`TaskService` 对锁是 `@Optional` fail-open（`task.service.ts:944`），而审计若 fail-open 就等于「锁只是装饰」、若 fail-closed 就等于「Redis 抖动 → 登录失败」 |
| 失败姿态 | 两难：**fail-open** ⇒ 并发下照样分叉，锁失去意义；**fail-closed** ⇒ 把审计的可用性风险升级成业务的可用性风险（登录写审计失败 → 登录失败） |
| 额外复杂度 | 分叉窗口、锁超时、跨实例时钟、以及对 44+ 调用点延迟特征的改变；还要给 `cappedBatchedDelete`/retention 的 bypass 事务另开一条不加锁的路径 |

**B 的判决**：安全收益为 0、代价落在最热路径上、且失败姿态无解——**不实施。**

### 选项 C：什么都不做，只把评估写清楚（现有 append-only 触发器已是有效控制）

| 维度 | 评估 |
|---|---|
| 安全强度 | **挡得住**：应用层/普通 SQL 的 UPDATE、DELETE（实测 DENIED，P0001）。**挡不住**：TRUNCATE、属主关触发器、超级用户改 `session_replication_role`、以及「应用账号本身就是属主/超管」这一现状 |
| 实现成本 | **0**（已上线，且有迁移结构 spec + 应用层旁路 spec 双重守护） |
| 失败姿态 | 触发器的拒绝是**硬失败**（P0001），不会静默放行——这是它相对哈希链的最大优点 |
| 运维可验证性 | **已有工具**：`scripts/audit-verify.mjs`——`guard-present`（触发器存在且 `tgenabled='O'`，`:32-39`）、`mutation-denied`（ROLLBACK 事务内受控 UPDATE 写试 + P0001 指纹，`:46-62`、`:160-190`）、`sequence-integrity`（id 序 vs `createdAt` 序，`:70-79`）；`--report-only` 跳过写试；退出码非 0 = 发现可篡改面 |
| 已知局限 | ① 写试**只试 UPDATE，不试 DELETE**（`:177`）；② `sequence-integrity` 明说 id 空洞合法（`:68`），因此它**不是删除检测器**，只检测「时间序倒挂」；③ 不检查 TRUNCATE 能力、不检查连接账号是否超管/是否表属主 |

### 汇总矩阵

| | 检出删行 | 检出改行 | 检出清空 | 抗 DBA | 吞吐代价 | 复杂度 | 运维可信度 |
|---|---|---|---|---|---|---|---|
| **A** 哈希链 | ❌ 尾部截断检不出 | ⚠️ 仅无密钥→可重算伪造 | ❌ 空表也「通过」 | ❌ **0** | 低（但写入路径实际要动） | 中高（规范化/微秒/分叉） | ❌ **虚假安全感** |
| **B** A+串行化 | ❌ 同 A | ⚠️ 同 A | ❌ 同 A | ❌ **0** | **高（热路径全局锁）** | 高 | ❌ 同 A，且多一层锁故障面 |
| **C** 现状+文档 | ⚠️ 只防「删一行」（触发器），不防 TRUNCATE | ✅ **防改行（硬拒绝）** | ❌ 不防 | ❌ 不防（但**不假装防**） | **0** | 0 | ✅ **边界诚实** |

> 关键判据：**A/B 在「抗 DBA」这一列是 0，而 §6 的问题陈述（`PLAN-SECURITY-HARDENING.md:403`）
> 恰恰是「理论上可被 ADMIN 修改」。对同一个威胁，一个提供 0 保护却声称「可校验完整性」的机制，
> 比明确的「不防 DBA，只防应用层与普通 SQL」更危险**——后者会让运维在真出事时去查别的方向。

---

## 决策

1. **维持 append-only 触发器作为 `audit_logs` 的防篡改控制，本轮不引入哈希链、不引入链式校验脚本、
   不改 `AuditService.log` 的写入路径。** 状态取 Accepted。

   理由：计划 §6.1-6.2 的方案在「无外部锚点 + 应用账号即属主/超管」的现实下存在 ①②③④ 四类结构性假阴性，
   命题「并发下无假阴性」已被证伪；B 只消除 ⑤ 且把代价压到热路径；C 的边界是**诚实的**。

2. **`audit_logs` 防篡改真正的下一增量不是哈希链，而是「把迁移头注假设过的那层 DB 账号权限模型建起来」。**
   这是本次评估唯一发现的、比哈希链更便宜且更强的动作，**本轮不实施**（需要部署/运维配合，见下「前置条件」）。
   具体目标（按收益/成本排序）：

   a. **应用账号必须不是 `audit_logs` 的属主、且不是超级用户**；
   b. 从应用账号 **REVOKE `TRUNCATE`**（以及 `TRIGGER`/`ALTER` 之外的 DDL 面）；
   c. 迁移/DDL 用一个**独立的、仅迁移时使用**的高权限账号执行，与应用运行账号分离；
   d. 可选叠加：给 `audit_logs` 补一条 `BEFORE TRUNCATE ... FOR EACH STATEMENT` 触发器（挡不住属主，
      但能挡住「应用账号意外拿到 TRUNCATE」这一档）。

   > 注意 c 与现状冲突：目前 `migration:run` 与运行时共用 `DB_USERNAME`（`package.json:24-28`）。
   > 拆账号是一个**部署契约变更**，必须与 runbook 同批交付，不能顺手改。

3. **`scripts/audit-verify.mjs` 的「防篡改」措辞必须收敛到它的真实能力**（下文「后果」列成可执行验收项）。
   它现在是「触发器在位 + 应用层常规 SQL 打不进去」的探针，**不是**完整性校验器。

4. **禁止**在任何文档/注释中把 `audit_logs` 描述为「可检出篡改」。正确表述是
   「**阻止**应用层与普通 SQL 的 UPDATE/DELETE；不阻止 TRUNCATE、属主关触发器、超级用户改写、以及账号权限内的任何 DDL」。

---

## 后果

### 正向收益

- **没有引入一条「声称防篡改、实际有假阴性」的写入路径。** 这比任何新增代码都重要——
  一个会在真出事时给出「校验通过」的机制，其危害大于没有机制。
- `audit_logs` 的写路径保持**零额外延迟**：44+ 个调用点（含登录、每次失败通知）不受影响。
- 现有的双重守护继续有效：迁移结构 spec（`apps/admin-api/src/migrations/__tests__/audit-logs-append-only-guard.migration.spec.ts`）
  钉 SQL 文本，应用层旁路 spec（`audit-append-only.spec.ts`）钉方法面与消费方写点。
- 把「迁移头注的兜底是假设而非事实」这件事**显式化**了。这是本轮最有价值的产出：
  它把一条一直被认为「已经有了」的控制，还原成「还没做」。

### 接受的代价与边界（必须同时被接受）

- **TRUNCATE 不设防**（实测 ALLOWED）。一个拿到应用账号的人可以 `TRUNCATE audit_logs` 清空全部痕迹，
  且事后**无法从表内区分**「被清空」与「本来为空」。
- **不抗 DBA / 表属主 / 超级用户**：`ALTER TABLE ... DISABLE TRIGGER` 与 `SET session_replication_role = replica`
  都可绕过（均实测 ALLOWED）。
- **没有删除检测能力**：现有 `sequence-integrity` 明确把 id 空洞视为合法（`scripts/audit-verify.mjs:68`），
  它检测的是「时间序倒挂」，不是「少了行」。**删掉任意一行，现有工具检不出来。**
- **写入是 fail-open / fail-closed 混合的**（`auth` 模块 fail-open，`task` 等 fail-closed），
  本文不改变这一现状，但它是「审计写入不可用」时行为不一致的已知来源。

### 可执行验收项（下一轮如要动手，按此核验）

1. `docs/operations.md:918-924` 与 `docs/atlas/03-data/entities/audit-log.md:39-56` 的措辞必须与本文「决策 4」一致
   （**本轮不改这两处**——它们不在本文足迹内，且当前表述「任何 UPDATE/DELETE 都会被拒绝」本身是对的，
   只是没写「TRUNCATE 不在此列」）。
2. `scripts/audit-verify.mjs` 若要继续被称作「防篡改验证」：应补 ① DELETE 写试（当前只试 UPDATE，`:177`）、
   ② 「连接账号是否表属主/超管」报告项、③ 「是否可 TRUNCATE」报告项。**这些是报告项，不是断言项**
   ——因为它们在任何真实部署里都可能为「是」，硬断言会变成第二个假警报源。
3. 若将来真的要做 A：前置条件见下节，**六条全绿才允许动工**。

### 若将来要做 A / B —— 前置条件（全部满足才允许实施）

| # | 前置条件 | 为什么是硬条件 | 现状 |
|---|---|---|---|
| 1 | **外部锚点**：链头/高水位定期写到本表之外（WORM 对象存储、外部 SIEM、或至少一张只有 DBA 能写、应用只读的表） | 否则尾部截断永远检不出（假阴性 ①） | ❌ 无 |
| 2 | **`BEFORE TRUNCATE` 语句级触发器** + 应用账号无 TRUNCATE 权限 | 否则清空后校验「通过」（假阴性 ②） | ❌ 无 |
| 3 | **带密钥 MAC（HMAC）而非裸 SHA256**，密钥只存在于应用 env、**永不进 DB** | 否则有 DB 写权限者可 O(n) 重算全链（假阴性 ③） | ❌ 无 |
| 4 | **存量行基线快照**（迁移前导出一份 `(id, hash-of-content)` 并离线保管） | 否则链有一段落不可验前缀（假阴性 ④） | ❌ 无 |
| 5 | **写入序列化**（复用 `RedisLockService` 或 `pg_advisory_lock`，**不新造锁**），且明确 fail-open/fail-closed 姿态 | 否则并发分叉导致假阳性或假阴性（⑤） | ✅ 基建已有（`redis-lock.service.ts:28`、`migration-runner.util.ts:33`），但**未接入写入路径** |
| 6 | **规范化序列化在 SQL 侧生成**（`to_char(..., '...US')`），且反证测试覆盖「微秒位非零」的行 | 否则 JS `Date` 截断到毫秒 → 永久假阳性（⑥）。本机实测 **49/49 行**微秒位非零 | ❌ 无 |

**六条里现在只满足第 5 条的一半。** 结论：**现在动工 A/B 会交付一个半成品**——这正是本文要避免的结果。

**其中 1–4 与哈希链无关、且单独就有价值**（1 和 2 甚至是本文「决策 2」的子集）。
建议的推进顺序是 **决策 2（最小权限账号 + TRUNCATE 闸）→ 外部锚点 → 再谈链条**，
而不是反过来。

---

## 本轮实施与否

**本轮不实施任何代码、不改任何迁移、不动 `apps/admin-api/src/modules/audit/` 下的源码。**

变更足迹仅两个文件：

- 新增 `docs/adr/adr-025-audit-log-tamper-evidence.md`（本文）
- `docs/adr/README.md` 追加一行索引

理由（与 ADR-024「本轮不实施」同构，但判据更强）：

1. **A 的核心命题已被证伪，不是「成本高」。** 假阴性 ①②③④ 独立成立，⑤ 是并发相关，⑥ 是工程阻塞。
   任务纪律写得很清楚：「证明不了就不要实现」。
2. **B 的安全收益为 0，代价落在最热路径。** 串行化只修 ⑤，且 Redis 抖动时 fail-open/fail-closed 两难。
3. **「什么都不做但要记录」与「什么都不做且不记录」后果不同。** 后者会让运维以为
   `audit_logs` 有完整性保证；本文把真实边界（含 TRUNCATE 与 DBA 两条实测放行）钉成文档。
4. **本轮唯一可执行的改进（决策 2）不在本文足迹内**：它要改部署契约（拆迁移/运行账号）、
   改 `docker-compose.yml` 与 runbook、可能还要给 `audit_logs` 加 `BEFORE TRUNCATE` 迁移。
   那是独立的实施项，硬塞进本轮会变成「顺手改部署权限模型」——风险远高于收益。

**明确不做的三件事**（防止后续被误读为「已完成」）：
- 不加 `previousHash` / `selfHash` 列；
- 不写 `verify-audit-log-integrity` 脚本；
- 不在 `AuditService.log` 里加任何锁。

---

## 替代方案（被否）

- **照抄 `PLAN-SECURITY-HARDENING.md:408-431` 的 §6.1 实现**：不能落地。
  它的 `findOne({order:{id:'DESC'}})` + `save` 是 read-then-write 竞态（并发分叉，`PLAN-SECURITY-HARDENING.md:487-488`
  上一轮已记录）；哈希是**无密钥 SHA256**（对 DBA 零保护）；`JSON.stringify({...entry, previousHash})`
  的键序依赖对象字面量插入顺序、且 `createdAt` 的 JS `Date` 会丢微秒（本机 49/49 行受影响）。
- **照抄 §6.2 的校验脚本（`:433-449`）**：它「从头顺序重算 + 逐步比对」，**不含外部锚点**，
  因此对尾部截断与 TRUNCATE 完全无效；且 `JSON.stringify({...log, selfHash: undefined})` 会把
  `selfHash: undefined` 从序列化里丢掉——恰好「能跑通」，让假阴性更难被发现。
- **只做「检测」而不动写入路径（选项 A 的字面形态）**：已论证——`createdAt` 微秒截断使
  「写时算、读时算」必然不一致（永久假阳性）；而在 SQL 侧算则写入路径必须动。
  **「不动写入路径」与「校验可靠」二者不可兼得。**
- **给 `audit_logs` 加软删列（`deletedAt`）来「保留痕迹」**：与 append-only 触发器**直接冲突**
  （UPDATE 被拒），要加只能先开 bypass——等于给篡改开一条通用后门。收益为负。
- **靠全库备份当完整性证据**：`BACKUP_RETENTION_DAYS` 缺省 30（`.env.example:476`），
  比审计保留期 180 天更短；且恢复是整库时间点恢复，无法用来证明「某一行没被删」。
- **什么都不做、也不记录**：本文的目的就是消灭这个状态。现状的边界（TRUNCATE 不防、DBA 不防）
  若不写下来，「有触发器 = 不可篡改」这个误解会一直被继承下去。

---

## 关联

- 计划项：`PLAN-SECURITY-HARDENING.md` §6「审计日志不可篡改性」（`:400-449`）、
  路线图第 4 项「6.1-6.2 审计日志哈希链」（`:487-488`，本轮给出终结判定）、
  概览表 `:19`、`:31-32`
- 前序拍板：迁移 `1790000000006` 头注 `:9-30`（append-only vs hash-chain 的原始论证，
  本文「当年为什么选 append-only」一节逐条复核）
- 相关实现：
  - `apps/admin-api/src/migrations/1790000000006-AuditLogsAppendOnlyGuard.ts:38-70`（触发器本体）
  - `apps/admin-api/src/modules/audit/audit.service.ts:20`（bypass 常量）、`:93-115`（retention 分批删）、`:117-123`（`log`）、`:126-140`（清理 cron）
  - `apps/admin-api/src/modules/audit/audit.controller.ts:32-52`（列表，ADMIN）、`:54-81`（CSV 导出，ADMIN）
  - `apps/admin-api/src/modules/audit/entities/audit-log.entity.ts:19-51`（实体，无哈希列）
  - `apps/admin-api/src/migrations/1717473142678-InitialSchema.ts:136-149`（表 DDL，`createdAt TIMESTAMP DEFAULT now()`）
  - `apps/admin-api/src/config/configuration.ts:56-61`（DB 连接，`:58` 缺省 `postgres`）
  - `apps/admin-api/src/common/utils/migration-runner.util.ts:33,96`（`pg_advisory_lock` 基建，B 的唯一现成复用点）
  - `apps/admin-api/src/common/services/redis-lock.service.ts:28`（`RedisLockService`，B 的另一个复用点）
  - `scripts/audit-verify.mjs:32-39`（guard-present）、`:46-62`（mutation-denied）、`:70-79`（sequence-integrity）、`:160-198`（DB 检查）
- 相关测试：
  - `apps/admin-api/src/migrations/__tests__/audit-logs-append-only-guard.migration.spec.ts`（SQL 文本逐段断言，7 例）
  - `apps/admin-api/src/modules/audit/__tests__/audit-append-only.spec.ts`（方法面白名单 / 写点唯一 / 消费方静态扫描）
- 相关文档：`docs/operations.md:918-924`、`docs/atlas/03-data/entities/audit-log.md:39-56`、
  `docs/atlas/04-flows/security-model.md:60,70`、`docs/atlas/01-apps/admin-api/modules/audit.md:50`
- 相关 ADR：
  - **ADR-024**（执行记录归档）——同构的「先评估、不实施」先例；本文复用了它的「触发条件表 + 本轮不实施」
    结构，但本文的判据是**技术性证伪**，不是 ADR-024 那种**业务前提缺失**。
  - ADR-008（mock vs reality）——本文「实测」一节的方法论来源：`TRUNCATE`/`DISABLE TRIGGER`/
    `session_replication_role` 三条都是在真 PG 上试出来的，不是读代码推断的。
