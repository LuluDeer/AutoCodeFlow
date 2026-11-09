#!/usr/bin/env bash
#
# verify-smoke-common.sh —— `scripts/verify-smoke-*.sh` 的**共用件**。
#
# ⚠️ **本文件是被 `source` 的，不是可执行脚本**。入口脚本在 source 栈的
#    env 文件**之后** source 本文件（清理需要 SMOKE_PG_CONTAINER 等栈变量）。
#
# ## 本文件解决什么问题
#
# 真机矩阵的脚本**写持久状态**（tasks / task_executions / execution_log_lines /
# audit_logs / S3 对象）。上一轮实测教训：
#
#   · 首次运行跑到一半失败 ⇒ 残留数据留在 DB 里；
#   · 二次运行**步骤 0 就建任务失败**（tasks.name 上有唯一索引
#     `idx_tasks_name_unique` ⇒ 同名任务直接创建失败）⇒ **脚本在脏 DB 上不可重入**；
#   · 更糟的形态：某些断言（如「审计表里有没有某条记录」）在脏 DB 上
#     **靠上一次的残留就能"通过"** ⇒ **假绿**。
#
# ⇒ 对策不是"跑后清理"（跑到一半失败就没了），而是**跑前清理**：
#   每次脚本**开始时**按**确定性的名字前缀**把自己会写的那批数据清干净，
#   并**验证清理生效**（清完查计数 = 0）⇒ "上一次跑到一半失败" 能被
#   **下一次**自动修复。跑后清理保留（不冲突），用同一个函数。
#
# ## 清理范围的纪律（硬约束）
#
#   · **只删本脚本自己造的数据** —— 一律按 `tasks.name` 的**确定性前缀**定位
#     （如 `smoke-fp-`、`smoke-mig-`），**绝不**做 `DELETE FROM tasks` 这种
#     无 WHERE 的全表删。每条 DELETE 都带 `WHERE`。
#   · **绝不**碰不属于本前缀的行：子表（task_executions / execution_log_lines /
#     audit_logs）按**本前缀任务的 id** 反查后删 ⇒ 与主表严格同源。
#   · 前缀只允许 `[A-Za-z0-9_-]` ⇒ 拼进 SQL 无注入面（且拒绝其它字符）。
#
# ## 为什么 execution_log_lines 要显式删
#
# `execution_log_lines` 是**分区表**，它对 `task_executions` **没有外键**
# （实测：只有 execution_artifacts / execution_finalizations 才有 CASCADE）
# ⇒ 删 task_executions **不会**带走它的日志行 ⇒ 必须显式删，否则同一
# executionId 的日志行会跨运行堆积。
#
# 用法：
#   source "$ROOT/scripts/verify-smoke-common.sh"
#   smoke_clean_tasks "smoke-fp-" "说明文字"   # 0 = 清理生效且已验证
#
# shellcheck shell=bash

# ── DB 访问（栈变量必须已由 env 文件 source 进来）─────────────────────────
smoke_psql_q() {
  docker exec -i "$SMOKE_PG_CONTAINER" psql -U "$SMOKE_PG_USER" -d "$SMOKE_PG_DB" -tAX -c "$1"
}

# ── 清理 + 验证：按 name 前缀删掉本脚本自己造的那批数据 ─────────────────
#
# $1 = tasks.name 的**确定性前缀**（不含 %，如 'smoke-fp-'）
# $2 = 可选的说明文字（用于日志）
#
# 返回 0 = 清理生效且**已验证**（清理后本前缀计数 = 0）
# 返回 1 = 清理失败（DB 不可达 / 清理后仍有残留 / 前缀非法）
smoke_clean_tasks() {
  local prefix="${1:?need prefix}"
  local note="${2:-}"
  local pat ids left

  # 前缀只允许字母/数字/短横/下划线 ⇒ 拼进 SQL 不会有注入面
  if [[ ! "$prefix" =~ ^[A-Za-z0-9_-]+$ ]]; then
    printf 'smoke_clean_tasks: 非法前缀 %q（只允许 [A-Za-z0-9_-]）\n' "$prefix" >&2
    return 1
  fi
  pat="${prefix}%"

  printf '  · 清理：tasks.name LIKE %s%s\n' "'" "$pat"
  [[ -n "$note" ]] && printf '    （%s）\n' "$note"

  # ① 先取本前缀命中的 task id（子表与审计按 id 反查 ⇒ 与主表严格同源）
  #    ⚠️ uuid 列必须显式 ::text 才有 string_agg 重载（PG 无 string_agg(uuid,text)）。
  #    ⚠️ **必须带引号**：`in (uuid1,uuid2)` 不是合法 SQL（uuid 不是数字字面量）
  #       ⇒ 用 `quote_literal` 产出 `'uuid1','uuid2'`。
  #       ⚠️ 本轮**双跑自检实测踩到**：未加引号 ⇒ PG 报
  #          `trailing junk after numeric literal at or near "5cbdce1b"`
  #          ⇒ 清理语句失败 ⇒ 脚本把自己的残留留在 DB 里。
  #    ⚠️ **必须区分"查询失败"与"确实没有残留"** —— 两者都可能返回空串 ⇒
  #    若不区分，DB 不可达时会把"什么都没删"当成"清理成功" ⇒ **假绿**。
  ids="$(smoke_psql_q "select coalesce(string_agg(quote_literal(id::text),','),'') from tasks where name like '${pat}';" 2>/dev/null)" || ids=""
  if [[ -z "$ids" ]]; then
    # 空结果有两种可能：① 真的没有残留 ② 查询失败。**再查一次计数**来分辨：
    # 计数查询能成功 ⇒ 确属无残留；计数查询也失败 ⇒ DB 不可达 ⇒ 清理未生效。
    if ! left="$(smoke_psql_q "select count(*) from tasks where name like '${pat}';" 2>/dev/null)"; then
      printf 'smoke_clean_tasks: 查询 DB 失败（DB 不可达？）⇒ 清理无法验证，中止\n' >&2
      return 1
    fi
    if [[ "$left" != "0" ]]; then
      printf 'smoke_clean_tasks: 清理后仍有 %s 行 tasks.name LIKE %s ⇒ 清理未生效\n' "$left" "'$pat'" >&2
      return 1
    fi
    printf '  ✓ 清理生效：本前缀本来就无残留（残留 = 0）\n'
    return 0
  fi
  # 形态校验：必须是 `'uuid1','uuid2'` 这种**带引号的 uuid 列表**
  # ⚠️ 不能用 `[[ "$ids" =~ ^'...'$ ]]` —— 单引号在 [[ ]] 里是**引用字符**，
  #    不是正则的一部分 ⇒ 会变成语法错误（本轮实测：`未预期的记号 ")"`）。
  #    ⇒ 改用 grep（正则整个在双引号内，引号是普通字符）。
  if ! printf '%s' "$ids" | grep -qE "^'[0-9a-fA-F-]+'(,'[0-9a-fA-F-]+')*$"; then
    printf 'smoke_clean_tasks: 拿到的 id 列表形态异常（%q）⇒ 中止清理\n' "$ids" >&2
    return 1
  fi

  # ② 子表：日志行（分区表，**无 FK** ⇒ 必须显式删）
  #    ⚠️ `execution_log_lines."executionId"` 是 **varchar**，而
  #    `task_executions.id` 是 **uuid** ⇒ 直接比较会报
  #    `operator does not exist: character varying = uuid`
  #    （本轮双跑实测踩到）⇒ 子查询侧显式 `::text`。
  smoke_psql_q "delete from execution_log_lines where \"executionId\" in (select id::text from task_executions where \"taskId\" in (${ids}));" >/dev/null || return 1
  # ③ 执行行（FK 是 CASCADE，但显式删 ⇒ 顺序可控、且不依赖 FK 形态）
  smoke_psql_q "delete from task_executions where \"taskId\" in (${ids});" >/dev/null || return 1
  # ④ 审计行：resourceId 指向本前缀的任务 ⇒ 只删这些（动作前缀 'task.%'）
  #    ⚠️ `audit_logs` 是**追加只读**表（迁移 1790000000006 的
  #    `trg_audit_logs_append_only` 触发器：DELETE/UPDATE 一律 RAISE EXCEPTION），
  #    **逃生门**是会话 GUC `app.bypass_audit_guard = 'on'`（生产审计服务自己的
  #    retention 清理路径就是这么走的 —— 见 apps/admin-api/src/modules/audit/
  #    audit.service.ts 的 `AUDIT_GUARD_BYPASS_SQL`）。
  #    ⇒ 必须 `SET LOCAL`（**事务内**，事务结束自动失效 ⇒ 不会留下后门）。
  #    ⇒ 本轮实测踩到：不带 bypass 直接 DELETE ⇒
  #    `ERROR: audit_logs is append-only: DELETE denied` ⇒ 清理失败。
  #    ⇒ 顺带：`SET LOCAL` **只在事务内**有效 ⇒ 整句必须在 BEGIN…COMMIT 里。
  smoke_psql_q "begin; set local app.bypass_audit_guard = 'on'; delete from audit_logs where \"resourceId\" in (${ids}) and action like 'task.%'; commit;" >/dev/null || return 1

  # ⑤ 主表（**带 WHERE 的前缀删** —— 不是 `DELETE FROM tasks`）
  smoke_psql_q "delete from tasks where name like '${pat}';" >/dev/null || return 1

  # ⑥ **验证清理生效**：本前缀的残留计数必须 = 0
  left="$(smoke_psql_q "select count(*) from tasks where name like '${pat}';" 2>/dev/null)" || left=""
  if [[ "$left" != "0" ]]; then
    printf 'smoke_clean_tasks: 清理后仍有 %s 行 tasks.name LIKE %s ⇒ 清理未生效\n' "${left:-?}" "'$pat'" >&2
    return 1
  fi
  printf '  ✓ 清理生效：本前缀残留 = 0\n'
  return 0
}

# ── 跑前清理（语义化别名；与跑后清理用同一实现）─────────────────────────
smoke_preclean_tasks() {
  local prefix="${1:?need prefix}"
  local note="${2:-}"
  printf '  · 跑前清理（幂等的前提：上次跑到一半失败也能被本次自动修复）\n'
  smoke_clean_tasks "$prefix" "$note"
}
