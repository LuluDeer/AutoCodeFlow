# 最小权限 DB 角色实施方案（`acf_migrator` / `acf_app`）

> **状态**：方案（Proposed）——**本文不改任何部署 / compose / `.env.example` / 代码 / 迁移**。
> 这是一次**部署契约变更**（拆迁移账号与运行账号、改表属主），须由维护者拍板后另行实施。
>
> **来源**：`docs/adr/adr-025-audit-log-tamper-evidence.md`「决策 2」——该 ADR 在评估哈希链时
> 核出 `audit_logs` 的不可改删只靠一条行级触发器，而迁移 `1790000000006:14` 声称兜底的
> 「**DB 账号权限模型**」**本仓从未建立**。本文是那一层的可执行实施方案。
>
> **实测环境**：本机 PostgreSQL **16.13**（WSL 提供，`127.0.0.1:5432`），全部 SQL 在**一次性临时库**
> （`acf_lp_final` / `acf_lp_probe*` / `acf_doc_check` 等）中真跑，跑完即 `DROP DATABASE` / `DROP ROLE`，
> **未触碰 `autoflow_test` 的结构**（收尾复核：45 张表、`audit_logs` 属主仍为 `postgres`、
> 49 行、`pg_default_acl` 仍为 0 行、探针库与角色零残留）。
> 文中标 **✅ 已实测** 的条目均有真实执行记录，逐条列在 §6.1；未实测的边界列在 §8。
>
> **来源标记**：标「实测」的，是本次在真 PG 上跑出来的；标「来自镜像/文档」而**未**实测的
> （如 compose 官方镜像把 `POSTGRES_USER` 建成超管），文中已显式区分。
>
> **本文地位**：ADR-025 决策 2 给出的是「目标」（应用账号非属主、非超管、无 TRUNCATE、迁移账号独立）。
> 本文补的是**怎么做**，以及实施时才会撞上的四个硬约束（§2.2）——其中两个是 ADR-025 未预见的。

---

## 0. 结论前置

1. **必须两个角色**：`acf_migrator`（属主，跑 DDL / 迁移）与 `acf_app`（运行时，仅 DML）。
   **应用账号绝不能是任何表的属主**——属主能 `ALTER TABLE ... DISABLE TRIGGER`，
   而 `audit_logs` 的防篡改完全建立在「触发器在位」上。

2. **但这个模型不能「一刀切」地全库生效**：`execution_log_lines` 的**运行时分区 DDL**
   （`CREATE TABLE ... PARTITION OF` / `DETACH PARTITION`）在 PostgreSQL 里
   **恒需父表属主权限，`GRANT` 无法替代**（✅ 已实测，§2.2 约束 C2）。
   因此存在**唯一一个属主例外**：该分区表必须归 `acf_app` 所有。代价与缓解见 §7 风险 R3/R4。

3. **最大的落地阻塞不是 SQL，而是启动路径**：生产环境 admin-api **在启动时自动跑迁移**
   （`apps/admin-api/src/main.ts:144-175` 的 `runBootstrapMigrations()`，非 development 即执行）。只要这条路径在，
   应用账号就必须持有 DDL 权限——**整个方案会被自己抵消**。必须先拆掉它（§4.3 阻塞项 B1）。

4. **TRUNCATE 必须单独 `REVOKE`**：PostgreSQL 里 `TRUNCATE` 是**独立权限**，不在 `DELETE` 里，
   也不在任何「DML 四件套」里。不显式撤销，一条 `GRANT ALL` 就会把闸门重新打开。

5. **纯 SQL 权限模型挡不住属主与超级用户**（这是 PostgreSQL 语义，不是实现疏漏）。
   本方案的价值是**把攻击面从「应用账号」压缩到「迁移账号」**，而不是消灭它。详见 §7 与 §8。

---

## 1. 现状与缺口（核实过，不是推断）

### 1.1 应用账号就是属主 / 超级用户

| 事实 | 位置 / 证据 |
|---|---|
| 应用连接账号**缺省即 `postgres`（超级用户）** | `apps/admin-api/src/config/configuration.ts:58`（`process.env.DB_USERNAME \|\| "postgres"`） |
| 迁移 CLI 的连接账号**缺省即 `autoflow`**（与运行面缺省不同值——本身是一处不一致） | `apps/admin-api/src/data-source.ts:24`（`getEnvVar("DB_USERNAME") \|\| "autoflow"`） |
| compose 里库账号 `POSTGRES_USER` 缺省 `autoflow`，官方镜像会把它建成**超级用户** | `docker-compose.yml:24`；`.env.example:8` |
| 应用连接账号 `DB_USERNAME` 也是 `autoflow`——**同一个账号** | `docker-compose.yml:148`；`.env.example:17` |
| 迁移由**同一个连接账号**执行 | `apps/admin-api/package.json:24-28`（`migration:run` → `src/migration-lock-cli.ts`） |
| **全仓从未创建过最小权限角色** | 迁移目录 `CREATE ROLE` / `GRANT` / `REVOKE` 零命中；`.yml/.sql/.md/.mjs/.sh` 全域 `CREATE ROLE\|REVOKE ALL\|NOSUPERUSER` 零命中 |

### 1.2 真库实测（✅ 已实测，`autoflow_test` 只读探测）

```
角色：autoflow  rolsuper=f  rolbypassrls=f   ← 本机这个账号其实只是 CREATEDB，不是超管
      postgres  rolsuper=t  rolbypassrls=t   ← audit_logs 的属主是它
表属主：public schema 45 张表，**全部** 属主 = postgres
audit_logs / audit_logs_id_seq / audit_logs_pkey 属主 = postgres
pg_default_acl：**0 行**（没有任何默认权限规则）
public schema ACL：{pg_database_owner=UC/pg_database_owner, =U/pg_database_owner}
   → PUBLIC 只有 USAGE，没有 CREATE（PG15+ 已收紧，这一点是好的）
execution_log_lines：relkind = 'p'（**已分区**），9 个日分区，属主全部 postgres
扩展：plpgsql 1.0、uuid-ossp 1.1
```

> **注意 `autoflow` 在本机不是超管**：这与 compose 官方镜像的行为**不一致**（镜像会把
> `POSTGRES_USER` 建成超级用户——**这一条来自镜像文档，本次未在容器里实测**）。也就是说该账号在
> **本机**是「只差表属主这一层」，在**容器部署**下则是「属主 + 超管」两层全占。
> **两种都必须收**——本方案对两者等价成立（`ALTER ... OWNER TO` + `REVOKE TRUNCATE` 对超管同样无效，
> 但超管这一层只能靠「换掉 `DB_USERNAME`」解决，不是靠 GRANT）。

### 1.3 为什么收掉这层「属主/超管」是最高性价比

ADR-025 的实测表（本文不重复论证）给出了三条「触发器挡不住」的手法及其**所需权限**：

| 攻击手法 | 结果 | 所需权限 | 收掉属主/超管后 |
|---|---|---|---|
| `UPDATE` / `DELETE` 单行 | DENIED（`P0001`） | 无（触发器即挡） | 不变，仍 DENIED |
| `TRUNCATE audit_logs` | **ALLOWED** | 表上的 `TRUNCATE` 权限 | ✅ **变成 `permission denied`** |
| `ALTER TABLE ... DISABLE TRIGGER` + `UPDATE` | **ALLOWED** | **表属主** | ✅ **变成 `must be owner`** |
| `SET session_replication_role = replica` + `UPDATE` | **ALLOWED** | **超级用户** | ✅ **变成 `permission denied to set parameter`** |

后两条正是 ADR-025 判据的核心：「任何纯 DB 内的防篡改机制都无法对抗拥有属主/超级用户权限的人」。
**本方案把那两个人的名字，从「应用账号」换成了「迁移账号」。**

---

## 2. 目标权限模型

### 2.1 两个角色

| 角色 | 用途 | 登录 | 超级用户 | BYPASSRLS | 属主范围 | 权限面 |
|---|---|---|---|---|---|---|
| `acf_migrator` | 迁移 / DDL / 属主 | ✅ | ❌ | ❌ | 全部业务对象（除 `execution_log_lines`） | DDL + DML |
| `acf_app` | admin-api 运行时 | ✅ | ❌ | ❌ | **仅 `execution_log_lines`**（见 §2.2 C2） | DML only |

两者都显式写 `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`——
**不要依赖缺省值**：`CREATE ROLE` 的缺省确实是这些，但把安全属性写死能让
`\du` 一眼复核，也让「有人手工建了这个角色」无法成为借口。

### 2.2 四条硬约束（后两条是 ADR-025 未预见的，实施时必然撞上）

**C1：PostgreSQL 没有列级 DENY。**
不存在「授予 UPDATE 但禁止改 `action` 列」的写法。最小权限只能靠
**「只 GRANT 需要的」**实现，而不是「先 GRANT ALL 再 DENY 某列」。
推论：`audit_logs` 上应用仍会持有 `UPDATE`（见表权限矩阵的说明）——
**挡住改行的是触发器，不是权限**；权限负责挡住的是「绕开触发器的手段」。

**C2（关键，✅ 已实测）：`CREATE TABLE ... PARTITION OF` 与 `ALTER TABLE ... DETACH PARTITION`
恒需父表属主权限，任何 `GRANT` / `MAINTAIN` 都无法替代。**

实测记录（非属主角色逐档放开权限）：

```text
只 GRANT DML                 → ERROR: permission denied for schema public
+ GRANT CREATE ON SCHEMA     → ERROR: must be owner of table execution_log_lines
+ GRANT ALTER/TRIGGER/MAINTAIN → ERROR: must be owner of table execution_log_lines   ← 不可绕过
（注：PostgreSQL 无 "ALTER" 这一 privilege 类型，GRANT ALTER 直接报 unrecognized privilege type）
```

而 `apps/admin-api/src/modules/task/log-retention/log-retention-cleanup.service.ts`
**在运行时执行这两条 DDL**：

| 代码 | 语句 | 频率 |
|---|---|---|
| `:232-236`（`ensureUpcomingPartitions`） | `CREATE TABLE IF NOT EXISTS "<分区名>" PARTITION OF "execution_log_lines" ...` | 每日 03:30 cron，预建未来 7 天 |
| `:207-212`（`cleanupExpiredPartitions`） | `ALTER TABLE "execution_log_lines" DETACH PARTITION "<分区名>"` + `DROP TABLE IF EXISTS "<分区名>"` | 每日 03:30 cron，清理超期 |

**因此 `execution_log_lines` 必须归 `acf_app` 所有**，否则：
1. 每日预建分区失败 → 第二天日志无分区可落；
2. 无分区时 `INSERT` **硬失败**（✅ 已实测：`ERROR: no partition of relation "execution_log_lines" found for row`），
   且**本机的真实库没有 `DEFAULT` 分区兜底**（实测分区数 9，无 default）——
   这会直接打成「任务日志写入全挂」。

这是本方案**唯一**的属主例外，代价见 §7 R3/R4。

**C3（✅ 已实测）：`ALTER TABLE ... OWNER TO <new_owner>` 要求**新属主**在 schema 上有 `CREATE`。**
所以 `GRANT CREATE ON SCHEMA public TO acf_app` 是「把分区表转给 app」的**前置条件**，不是可选项。
副作用：**app 因此能在 public 建表**（✅ 已实测，EXPOSED）——见 §7 R3。

**C4（✅ 已实测）：角色成员关系会被属主检查认可，方向必须单向。**

```text
GRANT acf_app TO acf_migrator   → migrator 可 SET ROLE app、可 ALTER app 拥有的表 ✅
                                → app 不能 SET ROLE migrator（ERROR: permission denied to set role）
```

即 `acf_migrator ∈ acf_app`（migrator 是 app 的成员），**绝不能反向**。
这样迁移脚本仍能对 app 拥有的分区表做 DDL（新增列、建索引），
而不需要让迁移脚本 `SET ROLE`（`DATABASE_URL` 里带连接选项容易被误读为提权后门）。

---

## 3. 具体 SQL

> 全部语句按**执行者**分组。`✅ 已实测` 表示该段已在 §6 的探针里逐条跑过。

### 3.1 Phase 0：角色与库（执行者：**超级用户**，一次性，不进迁移）

```sql
-- 角色：安全属性全部显式写死（不依赖缺省值）
CREATE ROLE acf_migrator LOGIN PASSWORD '<强口令>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT;

CREATE ROLE acf_app LOGIN PASSWORD '<强口令>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT;

-- C4：migrator 成为 app 的成员（单向！）。迁移因此可维护 app 拥有的分区表。
GRANT acf_app TO acf_migrator;
```

> **库属主给谁**：推荐 `ALTER DATABASE <db> OWNER TO acf_migrator`。
> 在 PG15+ 里库属主通过 `pg_database_owner` 隐式持有 `public` schema 的 `CREATE`（✅ 已实测：
> 以库属主身份建表无需额外 GRANT）。**不要**把库属主给 `acf_app`。
>
> **幂等**：`CREATE ROLE` 无 `IF NOT EXISTS`。要幂等请用
> `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='acf_app') THEN ... END IF; END $$;`。
> 口令不要写死进版本库：用 `\prompt` 或 `psql -v` 传入，或走 vault/secret 注入。

### 3.2 Phase 1：schema 权限（执行者：以库属主身份 connect，或超级用户）

```sql
-- 归零：PUBLIC 在 schema 上的权限（PG15+ 本已无 CREATE，显式再撤一次防历史残留）
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- migrator：建对象必须
GRANT USAGE, CREATE ON SCHEMA public TO acf_migrator;

-- app：USAGE 必给；CREATE 是 C3 的硬前置（不情愿，但不给就没法把分区表转给 app）
GRANT USAGE, CREATE ON SCHEMA public TO acf_app;
```

> ⚠️ **`REVOKE ALL ON SCHEMA public FROM PUBLIC` 之后**，`public` 的 ACL 变成
> `{pg_database_owner=UC/pg_database_owner}`（✅ 已实测）。**库属主仍保有 `CREATE`**，
> 非属主角色则必须显式 GRANT 才能建表——这一点在排障时容易误判为「权限配错了」。

### 3.3 Phase 2：表/序列授权（执行者：**acf_migrator**，即属主）

```sql
-- ---- 3.3.1 归零（防历史 GRANT ALL 残留）
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

-- ⚠️ 不要撤函数上的 EXECUTE：gen_random_uuid() / uuid_generate_v4() 被列默认值使用，
--    撤掉会让 INSERT 直接失败。PUBLIC 默认持有 EXECUTE 是可接受的。
-- ⚠️ 不要用 REVOKE ALL ON ALL FUNCTIONS：非属主执行会刷一堆
--    "no privileges could be revoked" WARNING，且撤了会连带打死 uuid 默认值。

-- ---- 3.3.2 DML 全量下发（不含 TRUNCATE）
-- 注意：显式列四件套，绝不用 GRANT ALL
-- （GRANT ALL = 四件套 + TRUNCATE + TRIGGER + REFERENCES，等于把闸门又打开）
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO acf_app;
GRANT USAGE                            ON ALL SEQUENCES IN SCHEMA public TO acf_app;

-- ---- 3.3.3 TRUNCATE 闸（PostgreSQL 里 TRUNCATE 是独立 privilege，必须单独撤）
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM acf_app;

-- ---- 3.3.4 额外收紧 audit_logs 的属主面权限（防漏授）
REVOKE TRIGGER, REFERENCES ON TABLE "audit_logs" FROM acf_app;

-- ---- 3.3.5 默认权限：以后 migrator 新建的表/序列 **自动** 把 DML 授给 app
-- 这是「新增迁移零改动」的关键：不用每加一张表就配一次 GRANT
ALTER DEFAULT PRIVILEGES FOR ROLE acf_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO acf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE acf_migrator IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO acf_app;
```

**表权限矩阵（目标终态）**

| 对象 | app 持有 | app 不持有 | 说明 |
|---|---|---|---|
| 全部业务表 | `SELECT, INSERT, UPDATE, DELETE` | `TRUNCATE, TRIGGER, REFERENCES`，DDL | DML 四件套显式列出 |
| `audit_logs` | 同上 + **`DELETE` 必须保留** | `TRUNCATE, TRIGGER, REFERENCES` | `DELETE` 是保留期清理（180 天）用的，靠 `app.bypass_audit_guard` GUC 放行触发器——**收权限不能顺手把这个功能砍掉** |
| 全部序列 | `USAGE`（= `nextval`） | `UPDATE`（= `setval`） | `USAGE` 足够 INSERT 取号；`UPDATE` 能让应用改写序列，不给 |
| `execution_log_lines`（父表 + 分区） | 全部 + **属主**（C2 例外） | — | 见 §7 R3/R4 |
| 函数 | `EXECUTE`（PUBLIC 缺省） | — | 不动，见 3.3.1 警告 |

> **为什么 `audit_logs` 上还要给 `UPDATE`**：C1——没有列级 DENY，而应用确实需要更新
> 其他表；对 `audit_logs` 而言 `UPDATE` 已被**触发器**无条件拒绝（`P0001`），
> 所以这条 `GRANT` 不是攻击面。**但绝不因此省略触发器**——权限与触发器是两层，不是替代关系。

### 3.4 Phase 3：迁移路径拆账号（执行者：运维 / CI，改的是部署契约）

应用运行时账号由 `DB_USERNAME` 决定（`configuration.ts:58`）。迁移账号由
**同名的** `DB_USERNAME` 决定（`data-source.ts:24`）——**两者目前共用一个键**，这是本次拆分的核心矛盾。

> 具体改法见 §4.1（**本节只给方案，不落盘**）。原则：
> 运行面 `DB_USERNAME=acf_app`；迁移面新增**独立** env 键（如 `MIGRATION_DB_USERNAME` /
> `MIGRATION_DB_PASSWORD`），由迁移脚本读取，**不共用** `DB_USERNAME`。
> 这需要改 `data-source.ts`（读新键）+ `.env.example`（登记新键）+ compose（注入）+ 部署文档。

---

## 4. 对现有部署的影响与迁移步骤

### 4.1 部署契约变更清单（**只描述，本文不改**）

| # | 文件 | 现状 | 目标 | 为何必须改 |
|---|---|---|---|---|
| 1 | `.env.example:8` | `POSTGRES_USER=autoflow` | 保持 `autoflow` 作为**镜像超管**，或改为专用 `acf_bootstrap` | 该值决定镜像初始化出的超级用户 |
| 2 | `.env.example:17` | `DB_USERNAME=autoflow` | `DB_USERNAME=acf_app` | 运行面必须是低权账号 |
| 3 | `.env.example`（新增键） | 无 | `MIGRATION_DB_USERNAME=acf_migrator` / `MIGRATION_DB_PASSWORD=...` | 迁移与应用必须拆账号（ADR-025 决策 2c）；**新 env 键须同时登记 `.env.example`** |
| 4 | `.env.example:18` | `DB_PASSWORD=change_me_strong_password` | 拆成 `DB_PASSWORD`（app）+ `MIGRATION_DB_PASSWORD`（migrator） | 同上 |
| 5 | `docker-compose.yml:148` | `DB_USERNAME: ${DB_USERNAME:-autoflow}` | `DB_USERNAME: ${DB_USERNAME:-acf_app}` | 缺省值必须已经是低权账号，否则「忘了配」= 回退到高权 |
| 6 | `docker-compose.yml` admin-api `environment` | 只有 `DB_PASSWORD:?` 守卫 | 迁移键同样用 `:?` fail-fast 守卫 | 沿用 `F-2` 既有纪律（未设置即 compose 解析报错） |
| 7 | `docker-compose.yml:642`（`pg-backup`） | `PGUSER: ${POSTGRES_USER:-autoflow}` | 保持超管或给专用 `BACKUP_USER` | `pg_dump` **需要读取全部表**，用低权账号会静默漏数据——**不要顺手改** |
| 8 | `docker-compose.yml:781`（`postgres-exporter`） | `DATA_SOURCE_NAME: postgresql://${POSTGRES_USER}:...` | 保持，或改用 `pg_monitor` 成员账号 | exporter 需要读统计视图；换低权账号会导致指标缺失 |
| 9 | `docs/operations.md` §安全加固 | 无 DB 账号条目 | 增「DB 角色模型」小节 | 运维必须知道谁是属主 |
| 10 | `docs/deployment.md` | 无迁移账号说明 | 升级 runbook 增「用 migrator 跑迁移」 | 迁移命令要带对账号 |

> **反向提醒**：`pg-backup`（#7）与 `postgres-exporter`（#8）**刻意不应改成低权账号**。
> 它们不是应用面，改错会让备份不完整/监控空白——**这比权限收得不彻底更危险**。

### 4.2 已有库怎么迁（✅ 已实测，含属主批量变更）

存量库全部对象属主是 `postgres`，必须批量转移。**这段以超级用户执行**，且**在维护窗口内**。

```sql
-- ① schema 权限先就位（C3：转属主要求新属主有 CREATE）
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO acf_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO acf_app;

-- ② 全部表（含分区父表与子分区）→ acf_migrator
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO acf_migrator', r.rel);
  END LOOP;
END $$;

-- ③ 全部视图 / 物化视图 → acf_migrator
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO acf_migrator',
      CASE WHEN r.relkind = 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END, r.rel);
  END LOOP;
END $$;

-- ④ 全部序列 → acf_migrator
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO acf_migrator', r.rel);
  END LOOP;
END $$;

-- ⑤ 唯一例外：分区父表 + 其全部子分区 → acf_app（C2）
ALTER TABLE "execution_log_lines" OWNER TO acf_app;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
      FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = '"execution_log_lines"'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO acf_app', r.rel);
  END LOOP;
END $$;
```

然后执行 §3.3 的授权与默认权限（以 `acf_migrator` 身份）。

**实测结果（✅ 已实测）**

```text
变更前：postgres 属主 9 个对象
变更后：acf_migrator 6 个、acf_app 3 个（父表 + 2 个子分区）
表注释保留：keep me            ← ALTER ... OWNER TO 不会丢 COMMENT
migrator 新建表后，app 直接 INSERT 成功（返回 id=2） ← 默认权限生效
app 仍不能 TRUNCATE 任何表：ERROR: permission denied for table audit_logs
app 仍不能 TRUNCATE audit_logs：ERROR: permission denied for table audit_logs
```

> **为什么用 `DO` 块而不是一条 `REASSIGN OWNED BY`**：
> `REASSIGN OWNED BY postgres TO acf_migrator` 会连**系统目录对象**（PG16 里 `postgres` 是所有
> `pg_catalog` 对象的属主）一起尝试改，在真实库上极其危险且大概率报错。
> 上面的 `DO` 块把范围**精确限制在 `nspname='public'`**，这是必须的。
>
> **幂等性**：两个 `DO` 块都可重复执行（属主已正确时 `ALTER ... OWNER TO` 是 no-op）。

### 4.3 迁移脚本用哪个账号（含一个必须先解决的阻塞项）

**目标**：`npm run migration:run` 走 `acf_migrator`；`node dist/main.js` 走 `acf_app`。

**阻塞项 B1（必须先解决，否则方案自相抵消）**：
`apps/admin-api/src/main.ts:144-175` 的 `runBootstrapMigrations()` 在
**非 development 环境启动时自动跑迁移**（`:149` 仅 `development` 直接 return，`:171` 调 `runMigrationsWithAdvisoryLock`）。
即生产镜像启动 → 先跑 DDL → 再用同一 `DataSource` 建连接池。
**只要这条路径在，`acf_app` 就必须有 DDL 权限，整个最小权限就是假的。**

- 方案 a（推荐）：删掉 boot 路径的自动迁移，迁移退化为**显式运维步骤**
  （`docker compose run --rm admin-api npm run migration:run:prod`，或独立 job）。
  这与 `DB_SYNCHRONIZE` 的既有纪律一致（`configuration.ts:1074-1080`：生产显式请求 `DB_SYNCHRONIZE=true` 直接 fail-fast，schema 一律走迁移）。
- 方案 b：保留自动迁移，但让 boot 路径用**独立的高权连接**（如 `MIGRATION_DB_*`），
  跑完即 `destroy`。**风险**：高权口令因此进了运行容器的环境变量——
  攻击者拿到容器环境即可连库提权，等于没拆。**不推荐**。
- 方案 c：不改，放弃本方案。**若维护者选 c，请在 ADR-025 上明确记录「决策 2 无法实施及原因」**，
  而不是让它悬着。

**CI**：CI 一次跑干净库的迁移，必须用 `MIGRATION_DB_*`。
**注意** `data-source.ts:24` 的缺省是 `"autoflow"`，与 `configuration.ts:58` 的 `"postgres"`
**不一致**——拆账号时顺手统一，否则「CI 用 app 账号跑迁移」会以 `must be owner` 的形式
在**某条 DDL 上**才炸，而不是在连接阶段就炸（更难查）。

### 4.4 建议的推进顺序（分阶段，每阶段可独立回滚）

| 阶段 | 动作 | 可观察结果 | 回滚 |
|---|---|---|---|
| P0 | 建角色、装 `BEFORE TRUNCATE` 触发器（§5） | 无行为变化（触发器对应用是 no-op） | `DROP TRIGGER` |
| P1 | 存量库批量转属主（§4.2 ①②③④，**暂不含 ⑤**） | 应用仍工作（属主对 DML 无影响） | 转回 `postgres` |
| P2 | 授权 + 默认权限（§3.3） | 断言 §6 全绿 | `GRANT ALL`（见 §7） |
| P3 | 分区表转属主给 app（§4.2 ⑤） | 预建分区恢复可用 | 转回 `acf_migrator` |
| P4 | 运行面切 `DB_USERNAME=acf_app` | 应用启动并写库正常 | 改回 `autoflow` |
| P5 | **删 boot 路径自动迁移（B1）** | 启动不再需要 DDL | 恢复代码 |
| P6 | 迁移面切 `MIGRATION_DB_*` | `migration:run` 用 migrator | 改回 `DB_USERNAME` |

> **P5 必须在 P4 之前完成**，否则 P4 一上线应用就起不来（启动迁移被拒）。
> 上表按「先建后收、最后拆启动」排列即可：把 P4/P5 交换为 **P5 → P4**。

---

## 5. 可选加固：`BEFORE TRUNCATE` 语句级触发器

`audit_logs` 现有触发器是 `BEFORE UPDATE OR DELETE ... FOR EACH ROW`，
**没有 `TRUNCATE` 分支**（`TRUNCATE` 是语句级、不逐行走行触发器）——这是 ADR-025
实测「`TRUNCATE audit_logs` ALLOWED」的直接原因。

### 5.1 SQL（PG 11+ 支持 `BEFORE TRUNCATE`）

```sql
CREATE OR REPLACE FUNCTION audit_logs_truncate_guard() RETURNS trigger AS $$
BEGIN
  -- 与 append-only 守卫共用同一个 bypass GUC，保持「唯一放行点」不被分裂成两个
  IF current_setting('app.bypass_audit_guard', true) = 'on' THEN
    RETURN NULL;   -- 语句级 BEFORE 触发器：返回 NULL 即不干预，语句继续
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only: TRUNCATE denied'
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON "audit_logs";
CREATE TRIGGER trg_audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_truncate_guard();
```

> **返回值语义**：`BEFORE ... FOR EACH STATEMENT` 触发器的返回值被忽略（`NULL` 即可）。
> **别写成 `FOR EACH ROW`**——`TRUNCATE` 不会逐行触发，行级 `BEFORE TRUNCATE` 写不出来。
> **幂等**：`DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`（PG 无 `CREATE OR REPLACE TRIGGER`），
> 与既有迁移 `1790000000006:53-60` 同一姿态。

> **部署提醒**：触发器创建后 `tgenabled = 'O'`（正常）。用 `pg_trigger` 复核时**务必过滤
> `tgisinternal`**，否则会把外键约束的内部触发器混进来；本文 §6.2 的结构查询已按此写。
> 另外 `tgisinternal` 之外还可能有**继承自父表**的触发器（本表没有，但分区表有），
> 用 `tgrelid = '<表>'::regclass` 精确限定即可。

### 5.2 它能挡什么、挡不住什么（✅ 全部已实测）

| # | 场景 | 结果 | 判定 |
|---|---|---|---|
| A | 属主直接 `TRUNCATE audit_logs` | **DENIED**（`audit_logs is append-only: TRUNCATE denied`） | ✅ **挡住** |
| B | 属主带 `SET LOCAL app.bypass_audit_guard='on'` 后 `TRUNCATE` | **ALLOWED** | ⚠️ 刻意放行（与 `DELETE` 同一开关） |
| C | 属主 `DISABLE TRIGGER` 后 `TRUNCATE` | **ALLOWED** | ❌ **挡不住**（属主恒能关自己的触发器） |
| D | 超级用户 `SET session_replication_role=replica` 后 `TRUNCATE` | **ALLOWED** | ❌ **挡不住**（该 GUC 仅超管可设） |
| E | `acf_app`（非属主、无 TRUNCATE 权限）`TRUNCATE` | **DENIED**（`permission denied for table audit_logs`） | ✅ 挡住（**但这是权限挡的，不是触发器**） |

**结论（必须如实写进任何引用本文的文档）**：
这条触发器**不改变**「谁有权关触发器」这个事实。它的真实价值是
**在 `REVOKE TRUNCATE` 之外再加一层「即使有人手滑 `GRANT ALL` 也还能拦住」的纵深**——
属于**冗余防线**，不是新的安全边界。**C 与 D 两档它完全无解**，
这与 ADR-025「决策 4」的措辞纪律一致：不得把 `audit_logs` 描述为「可防属主/DBA 篡改」。

> **顺带的风险提示**：`B` 放行了 `bypass` 下的 `TRUNCATE`，而应用代码里**没有任何**
> 调用 `TRUNCATE` 的地方（已核查：`apps/admin-api/src` 全域 `TRUNCATE` 零命中，
> 仅 `task.service.spec.ts:5031` 有一个无关的 `TRUNCATED` 变量名）。
> 若维护者希望更严，可让该守卫**忽略 bypass**（即 `TRUNCATE` 永远拒绝，连清理任务也不许）——
> 因为保留期清理走的是 `DELETE`（`audit.service.ts:93-115`），**不需要 `TRUNCATE`**。
> 本文保留 bypass 分支是为了与既有 GUC 语义一致；这一取舍留给维护者。

---

## 6. 验证清单（可直接执行）

### 6.1 已实测：21 条断言全绿

**测试方法（这一步很关键）**：不是照着我脑子里的模型建库，而是**从本文 Markdown 里按围栏
自动抽取全部 6 个 `sql` 代码块、逐字送进 `psql`**（仅替换刻意保留的 `<强口令>` 占位符），
得到一个「由本文自己的 SQL 建出来的库」，再对它跑下表 21 条断言。

> 换句话说：**这张表验证的是「本文的 SQL 能建出它承诺的东西」，而不是「我手工搭的库能通过测试」。**

以下断言以 `acf_app` / `acf_migrator` 分别连接执行，逐条判定「期望报错子串」。

```bash
# 通用形态：以应用账号连接，期望非零退出 + 指定报错
PGPASSWORD='<acf_app 口令>' psql -h 127.0.0.1 -p 5432 -U acf_app -d <db> -X -v ON_ERROR_STOP=1 -c "<SQL>"
```

| # | 断言（以 `acf_app` 连接） | 期望 | 实测报错 |
|---|---|---|---|
| 1 | `UPDATE audit_logs SET action='x' WHERE ...` | ❌ 失败 | `audit_logs is append-only: UPDATE denied` |
| 2 | `DELETE FROM audit_logs WHERE ...` | ❌ 失败 | `audit_logs is append-only: DELETE denied (use retention cleanup job)` |
| 3 | `TRUNCATE audit_logs` | ❌ 失败 | `permission denied for table audit_logs` |
| 4 | `ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_logs_append_only` | ❌ 失败 | `must be owner of table audit_logs` |
| 5 | `DROP TRIGGER trg_audit_logs_append_only ON audit_logs` | ❌ 失败 | `must be owner of relation audit_logs` |
| 6 | `DROP TABLE audit_logs` | ❌ 失败 | `must be owner of table audit_logs` |
| 7 | `ALTER TABLE audit_logs ADD COLUMN z int` | ❌ 失败 | `must be owner of table audit_logs` |
| 8 | `SET session_replication_role = replica` | ❌ 失败 | `permission denied to set parameter "session_replication_role"` |
| 9 | `SET ROLE acf_migrator` | ❌ 失败 | `permission denied to set role "acf_migrator"` |
| 10 | `INSERT INTO audit_logs(...)` | ✅ 成功 | 返回新 id |
| 11 | `SELECT count(*) FROM audit_logs` | ✅ 成功 | — |
| 12 | `INSERT INTO execution_log_lines(...)` | ✅ 成功 | 返回新 id |
| 13 | `INSERT INTO system_configs ... ON CONFLICT DO UPDATE` | ✅ 成功 | 返回 id |
| 14 | `BEGIN; SET LOCAL app.bypass_audit_guard='on'; DELETE FROM audit_logs ...; COMMIT` | ✅ 成功 | 保留期清理通道未被权限打断 |
| 15 | `CREATE TABLE execution_log_lines_<日期> PARTITION OF execution_log_lines ...` | ✅ 成功 | 运行时预建分区可用（C2） |
| 16 | `ALTER TABLE execution_log_lines DETACH PARTITION ...` | ✅ 成功 | 运行时清理可用（C2） |
| 17 | 无分区时间点 `INSERT INTO execution_log_lines`（建分区后） | ✅ 成功 | 证明 15 的必要性 |
| 18 | 以 `acf_migrator` 执行 `ALTER TABLE execution_log_lines ADD COLUMN ...` | ✅ 成功 | 迁移仍能维护 app 拥有的表（C4） |
| 19 | 属主 `TRUNCATE audit_logs`（装 §5 触发器后） | ❌ 失败 | `audit_logs is append-only: TRUNCATE denied` |
| 20 | 属主 `DISABLE TRIGGER` 后 `TRUNCATE` | ✅ 成功 | **已知挡不住**（§5.2 C），列为「预期放行」 |
| 21 | 超管 `session_replication_role=replica` 后 `TRUNCATE` | ✅ 成功 | **已知挡不住**（§5.2 D），列为「预期放行」 |

> 第 20/21 条**故意断言「成功」**：它们记录的是「本方案挡不住什么」。
> 把它们写成「期望失败」是自欺——它们是 PostgreSQL 语义，不是配置疏漏。

### 6.2 结构与属主断言（只读，随时可跑）

```sql
-- 6.2.1 三个角色属性：证明没有超级用户 / 没有 BYPASSRLS
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin
  FROM pg_roles WHERE rolname IN ('acf_app','acf_migrator');

-- 6.2.2 属主分布：audit_logs 必须不是 acf_app
SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
 ORDER BY 1;
-- 断言：audit_logs -> acf_migrator（绝不能是 acf_app）

-- 6.2.3 应用账号绝无 TRUNCATE（execution_log_lines 因属主例外会除外，属已知代价）
SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = 'acf_app' AND privilege_type IN ('TRUNCATE','TRIGGER','REFERENCES');
-- 断言：`audit_logs` 不出现在结果里

-- 6.2.4 默认权限已就位（否则新迁移建的表 app 会 permission denied）
SELECT defaclrole::regrole AS grantor, defaclnamespace::regnamespace AS schema,
       defaclobjtype, defaclacl
  FROM pg_default_acl;
-- 断言：至少两行，grantor = acf_migrator，objtype = r / S

-- 6.2.5 成员关系方向（C4）：app 绝不能是 migrator 的成员
SELECT r.rolname AS member, g.rolname AS granted_role
  FROM pg_auth_members m
  JOIN pg_roles r ON r.oid = m.member
  JOIN pg_roles g ON g.oid = m.roleid
 WHERE r.rolname IN ('acf_app','acf_migrator')
    OR g.rolname IN ('acf_app','acf_migrator');
-- 断言：只允许 acf_migrator -> acf_app 一行；出现 acf_app -> acf_migrator 即严重错误

```

### 6.3 回归：启动冒烟

权限收错最典型的失败姿态是「应用启动即挂」。切换后**必须**跑：

```bash
docker compose up -d admin-api
docker compose logs --tail=100 admin-api          # 断言无 permission denied / must be owner
curl -s http://127.0.0.1:3105/api/health/live
curl -s http://127.0.0.1:3105/api/health/ready
```

并手工触发一次日志保留任务，确认分区预建未被权限打断（P3 的核心验证）：
预建失败只写 error 日志、**不会**让健康检查变红（`log-retention-cleanup.service.ts:112-120`
是 try/catch 吞错），**绝不能只看健康检查就判定成功**。

---

## 7. 风险与回滚

### 7.1 风险清单

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| **R1** | **应用启动即失败** | `DB_USERNAME` 切到 `acf_app` 但授权不全 / boot 路径仍在跑迁移 | 服务完全不可用 | 严格按 §4.4 P5→P4 顺序；切前先在预发库跑 §6.1 |
| **R2** | **新迁移静默失效** | 忘记配 `ALTER DEFAULT PRIVILEGES`，新表建出来 app 无权限 | 新功能上线即 `permission denied for table xxx` | §6.2.4 断言；把默认权限写进 bootstrap 脚本而非口头约定 |
| **R3** | **`acf_app` 能在 `public` 建表**（✅ 已实测 EXPOSED） | C3：转属主要求新属主有 schema `CREATE` | 应用被攻破后可建表/建视图，但不能改既有表属主 | **接受**（见下「已知代价」）；或用 P3 之后撤销 `CREATE`——但那样**再也无法把表转给 app**，只能在维护窗口临时授予 |
| **R4** | **`acf_app` 是 `execution_log_lines` 的属主，因此能 `TRUNCATE`/`DROP` 它**（✅ 已实测） | C2 例外 | 应用被攻破后可清空**执行日志**（非审计日志） | **接受**：`execution_log_lines` 是 30 天保留期的运维日志，非审计证据；**审计面（`audit_logs`）不受影响**。这是本方案最重要的一处取舍 |
| **R5** | **备份/监控变哑** | 误把 `pg-backup`/`postgres-exporter` 改成低权账号 | `pg_dump` 静默漏表；指标缺失 | §4.1 #7/#8 明确**不改**；改后必须验证备份体积与指标条数 |
| **R6** | **迁移账号口令进入运行容器** | 若选 §4.3 方案 b | 拿到容器环境即可提权，方案归零 | 不选方案 b；迁移账号口令只出现在迁移 job / 运维 shell |
| **R7** | **`acf_migrator` 成为下一个「万能账号」** | 迁移账号长期在线、口令共用 | 属主面重新变宽 | 迁移账号**仅在迁移时存在**：可加口令轮换 + 迁移完成即 `NOLOGIN`（下一轮迁移再临时开启） |

### 7.2 已知代价（必须与收益一并接受）

1. **`execution_log_lines` 归应用属主**——这是 C2 逼出来的，不是选择。应用因此对这张表有
   属主级权力（含 `TRUNCATE`/`DROP`）。
   **判据**：ADR-025 要保护的是 `audit_logs`；`execution_log_lines` 不在其内。
   **若维护者认为不可接受**，唯一替代是「禁止应用建分区 + 改成分区由迁移/独立 job 预建 +
   给该表加 `DEFAULT` 分区兜底」——那是**另一次代码改动**，超出本文范围。
2. **应用仍持有 `audit_logs` 的 `UPDATE` 权限**（C1 无列级 DENY）。挡住改行的是触发器。
3. **`acf_app` 有 schema `CREATE`**（R3）。
4. **挡不住属主与超管**：本方案只是把这两个身份从「应用账号」挪到「迁移账号」。

### 7.3 回滚（按阶段，均为分钟级）

| 阶段 | 回滚动作 |
|---|---|
| P0（触发器） | `DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON "audit_logs";`<br>`DROP FUNCTION IF EXISTS audit_logs_truncate_guard();` |
| P1/P3（属主） | 以超级用户把 `audit_logs` 等改回：`ALTER TABLE "audit_logs" OWNER TO postgres;`<br>批量回滚：把 §4.2 的 `DO` 块里 `TO acf_migrator` / `TO acf_app` 换成 `TO postgres` 重跑。<br>⚠️ 属主回滚**必须同时**回滚 schema 权限，否则 §3.2 的 `REVOKE ... FROM PUBLIC` 会让 `postgres` **丢掉** public 的 `CREATE`（PG15+ 靠 `pg_database_owner` 隐式持有，一般不受影响——但别赌） |
| P2（授权） | 一键宽容回滚（**临时**，事后必须重新收紧）：<br>`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO acf_app;`<br>`GRANT USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public TO acf_app;` |
| P4（运行账号） | 改回 `DB_USERNAME` 原值（compose / `.env`），`docker compose up -d --force-recreate admin-api`。**这是最快的一键回滚**（不需要动库） |
| P5（删自动迁移） | 恢复代码后重新构建镜像 |
| P6（迁移账号） | 迁移脚本改回读 `DB_USERNAME` |

> **回滚优先级**：线上出问题先走 **P4 回滚**（改 env 重启，不碰库、无 schema 变更），
> 再排查。**不要在故障中去做属主回滚**——那是不可逆操作里最不该急的一类。

---

## 8. 本次未验证的边界（诚实清单）

1. **未在真实容器部署上验证**：本文全部实测都在本机 PG 16.13 + `psql` 上完成。
   compose 镜像（`postgres:16-alpine`）的官方 entrypoint 用 `POSTGRES_USER` 建超级用户这一行为
   **来自镜像文档而非本次实测**（本机 `autoflow` 账号实测 `rolsuper=f`，与镜像行为不一致，
   已在上文标注）。
2. **未验证 `pg_dump` 在低权账号下的具体失败形态**（R5 只给了「不要改」的建议，未做实验）。
3. **未验证多副本（HA `--scale admin-api=2`）下的表现**：默认权限/属主都是库级对象，
   理论上与副本数无关，但**两个副本以同一 `acf_app` 身份并发建同名分区**的竞态
   （代码用 `CREATE TABLE IF NOT EXISTS` 兜底，`:231-236`）**本次未压测**。
4. **未验证 `DB_READ_REPLICA_URL`（ARCH-24）路径**：只读副本上的账号权限未涉及。
   **若启用只读副本，需要单独给副本侧的 `acf_app` 授 `SELECT`**，本文未覆盖。
5. **未做 `R2` 的自动化守护**：默认权限缺失目前只能靠 §6.2.4 人工断言。
   建议后续加一条迁移结构 spec（先例：`audit-logs-append-only-guard.migration.spec.ts`）。
6. **`acf_migrator` 的 `NOLOGIN` 化（R7）未设计**：需要迁移 job 临时提权，属下一轮。

---

## 9. 关联

- **来源 ADR**：`docs/adr/adr-025-audit-log-tamper-evidence.md`——「决策 2」（`:267-278`，目标 a/b/c/d）、
  「后果·可执行验收项」（`:311-319`）、「前置条件」表第 2 条（`:326`）、「本轮实施与否」（`:340-364`）
- **迁移头注（本文要兑现的那句话）**：`apps/admin-api/src/migrations/1790000000006-AuditLogsAppendOnlyGuard.ts:14`
  （「真正的越权 INSERT/直连 DB 篡改由 DB 账号权限模型兜底」）
- **触发器本体**：同文件 `:38-60`（函数 `audit_logs_append_only_guard`、触发器 `trg_audit_logs_append_only`）
- **连接配置（要拆的两个键）**：
  - `apps/admin-api/src/config/configuration.ts:58`（运行面 `DB_USERNAME`，缺省 `postgres`）
  - `apps/admin-api/src/data-source.ts:24`（迁移面 `DB_USERNAME`，缺省 `autoflow`）
- **启动路径阻塞项 B1**：`apps/admin-api/src/main.ts:124-155`（`runBootstrapMigrations`，`:129` 跳过 development）
- **迁移命令入口**：`apps/admin-api/package.json:24-28`、`apps/admin-api/src/migration-lock-cli.ts:20-35`
- **运行时 DDL（C2 的证据）**：`apps/admin-api/src/modules/task/log-retention/log-retention-cleanup.service.ts:207-212`（DETACH+DROP）、`:232-236`（CREATE PARTITION OF）、`:248-256`（`isPartitionedTable`）
- **分区建表迁移（形状参考）**：`apps/admin-api/src/migrations/1789900000002-PartitionExecutionLogLines.ts:128-143`
- **保留期清理通道（权限不能砍）**：`apps/admin-api/src/modules/audit/audit.service.ts:20`（`AUDIT_GUARD_BYPASS_SQL`）、`:93-115`（`retentionDelete`）
- **部署契约（要改的位置，本文不改）**：`.env.example:8,17,18`、`docker-compose.yml:24,148,642,781`
- **相关文档**：`docs/operations.md` §安全加固（`:876`）、§审计防篡改（`:918-924`）、
  §执行日志分区表运维（`:962-968`）；`docs/deployment.md`（迁移命令 `:253`、`:670`、`:905`）；
  `docs/atlas/03-data/entities/audit-log.md:39-56`
- **相关脚本**：`scripts/audit-verify.mjs`——ADR-025 验收项 2 建议给它补
  「连接账号是否表属主/超管」「是否可 TRUNCATE」两个**报告项**；
  本方案落地后这两个报告项应当从「可能为是」变成「恒为否」，正好可以拿来做回归。
