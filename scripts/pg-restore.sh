#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# AutoCodeFlow PostgreSQL 备份恢复演练（M-1 配套，闭环 scripts/pg-backup.sh）
#
# ── 为什么需要它 ──────────────────────────────────────────────────────────
# pg-backup.sh 每天 02:00 往 backup_data 卷里写 db_<stamp>.sql.gz，但仓库里
# **从来没有过恢复路径**——备份从未被证明「能恢复」。没有恢复演练的备份是
# 一种信仰：真出事那天才发现 dump 是半截的、schema 是旧的、或者 psql 直接
# 报错，而那时已经没有第二次机会。本脚本把「备份可恢复」变成一条可重复
# 执行、可进 CI 的判据。
#
# ── 安全姿态（默认不碰生产）──────────────────────────────────────────────
# 恢复是**破坏性**操作：psql 把 dump 灌进哪个库，哪个库的既有数据就没了。
# 故默认行为刻意做得「没用」：
#   · 目标库默认是**一次性演练库** restore_drill_<时间戳>，绝不是 ${PGDATABASE}；
#   · 目标库若等于 ${PGDATABASE}，必须显式给 --force-overwrite-production，
#     否则拒绝执行（这条闸门先于任何数据库连接，连不上库也能拦住）；
#   · 目标库若不是演练库名（restore_drill_*），同样要求该显式标志；
#   · 演练库用完即 dropdb（--keep 保留现场，便于人工翻查）。
#
# ── 闸门顺序（每一步都先于下一步，绝不允许半灌状态）──────────────────────
#   ① 归档完整性：gzip -t（CRC 校验，抓截断/损坏）
#   ② 最小尺寸：< 256 字节直接判废——与 pg-backup.sh 的 NETOPT-4 同阈值
#      （空 gzip 流也有 ~20B 头，256B 是「迁移前空库 dump 实测 397B」与
#      「截断残件」之间的分界；备份侧拒收的东西，恢复侧也不能收）
#   ③ 归档身份：头部必须是 pg_dump 的完整 dump（含 TOC 目录项），抓「只有
#      表结构没有数据」或「随手 gzip 的无关文件」这类坏档
#   ④ 之后才建库、才灌数据；失败一律清理演练库（不留半灌库给下一个人）
#
# ── 恢复后校验 ────────────────────────────────────────────────────────────
# 断言一组**必然存在**的表确实存在且有行——「psql 退出码 0」不等于「数据
# 回来了」（dump 只含 schema、灌进了错的库、语句被静默跳过，都会让退出码
# 保持 0）。选表依据（逐条核对过迁移源文件）：
#   · migrations          —— typeorm 迁移记录表（data-source.ts 未改
#                            migrationsTableName，默认即 "migrations"）。
#                            非空 ⟺ 这个库被迁移过，是「是不是本系统的库」
#                            最便宜的判据。
#   · users / tasks / task_executions / executors / audit_logs /
#     system_configs      —— InitialSchema 建的核心表，已核对全部 migrations
#                            的 DROP TABLE / RENAME 语句，它们从未被删改，
#                            故对任意迁移版本都存在。
#   · task_templates / projects —— 由迁移自带 seed（ON CONFLICT DO NOTHING），
#                            迁移跑过就必然有行。这是「非空」断言能成立、
#                            又不依赖业务流量的两张表（users/tasks 在生产可能
#                            合法为空，故只断言「表在」，不断言「有行」）。
# 行数为 0 时该表判「○ 空」（不红），表缺失判「✘」（红）——空库是合法状态，
# 缺表不是。
#
# ── 用法 ──────────────────────────────────────────────────────────────────
#   bash scripts/pg-restore.sh <dump.sql.gz> [目标库名] [选项]
#
#   --dry-run                       只做 ①②③ 校验并打印将要做什么，不连库、
#                                   不建库、不灌数据（默认演练路径的预检）
#   --force-overwrite-production    允许写 $PGDATABASE / 非演练库名的既有库
#                                   （唯一能造成生产数据丢失的开关）
#   --keep                          演练结束后保留演练库（默认 dropdb 清理）
#   --skip-row-checks               只校验表存在，不校验行数
#   -h | --help                     打印用法
#
#   环境变量：PGHOST / PGUSER / PGPASSWORD / PGDATABASE（与 pg-backup.sh 同源，
#   由 compose pg-backup 服务的 environment 注入）；PGPORT 可选。
#
# ── 退出码 ────────────────────────────────────────────────────────────────
#   0 = 演练 PASS（或 dry-run 校验 PASS）；1 = 任一闸门失败
#
# 示例（compose 内，演练到一次性库，最常用）：
#   docker compose --profile backup run --rm pg-backup \
#     bash /usr/local/bin/pg-restore.sh /backup/db_20261017_020000.sql.gz
# 示例（只验证归档、不碰任何数据库）：
#   bash scripts/pg-restore.sh /backup/db_20261017_020000.sql.gz --dry-run
# ═══════════════════════════════════════════════════════════════════════════
set -eu -o pipefail

# 最小可信尺寸：与 pg-backup.sh NETOPT-4 完全同阈值。改这里必须同步改那里，
# 否则会出现「备份侧收下的档，恢复侧拒收」这种自相矛盾。
MIN_DUMP_BYTES=256
# 纯文本 pg_dump 产物必有 TOC 目录项；没有它就不是一份可恢复的备份。
REQUIRED_TOC_TOKEN="PostgreSQL database dump"
FORCE_OVERWRITE_TOKEN="--force-overwrite-production"

DUMP_FILE=""
TARGET_DB=""
DRY_RUN=0
FORCE_OVERWRITE=0
KEEP_DB=0
SKIP_ROW_CHECKS=0

# 恢复后要校验的表：表名:是否要求非空。见文件头「恢复后校验」的选表依据。
REQUIRED_TABLES="migrations:0 users:0 tasks:0 task_executions:0 executors:0 audit_logs:0 system_configs:0"
SEEDED_TABLES="task_templates:1 projects:1"

usage() {
    cat <<'USAGE'
用法: bash scripts/pg-restore.sh <dump.sql.gz> [目标库名] [选项]

从 pg-backup.sh 产出的 db_<YYYYmmdd_HHMMSS>.sql.gz 恢复到 PostgreSQL，
并校验恢复结果的完整性。

默认安全行为（恢复是破坏性的，故默认最保守）：
  目标库默认 = restore_drill_<时间戳>（一次性演练库，用完即删），
  绝不是 ${PGDATABASE}。写生产库必须显式加 --force-overwrite-production。

选项:
  --dry-run                     只校验归档（gzip -t + 尺寸 + TOC），不连库
  --force-overwrite-production  允许写 $PGDATABASE 或非演练库名的既有库
  --keep                        演练后保留演练库（默认清理）
  --skip-row-checks             只校验表存在，不校验行数
  -h, --help                    打印本帮助

环境变量: PGHOST PGUSER PGPASSWORD PGDATABASE [PGPORT]
          （与 scripts/pg-backup.sh 同源，由 compose pg-backup 服务注入）

退出码: 0 = PASS；1 = FAIL（任一闸门不过）
USAGE
}

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
err() { printf '%s %s\n' "$(date -Is)" "$*" >&2; }

die() {
    err "FAIL: $*"
    exit 1
}

# ── 参数解析 ─────────────────────────────────────────────────────────────
# 位置参数最多两个（dump 路径、目标库名），其余一律走 --flag；未知参数必须
# 拒绝而不是静默忽略——静默忽略会把 --force-overwrite-production 的拼写错误
# 变成「以为强制了，其实没强制」。
while [ "$#" -gt 0 ]; do
    case "$1" in
        -h|--help)
            usage
            exit 0
            ;;
        --dry-run)
            DRY_RUN=1
            ;;
        --force-overwrite-production)
            FORCE_OVERWRITE=1
            ;;
        --keep)
            KEEP_DB=1
            ;;
        --skip-row-checks)
            SKIP_ROW_CHECKS=1
            ;;
        --*)
            err "未知参数: $1"
            usage >&2
            exit 1
            ;;
        *)
            if [ -z "$DUMP_FILE" ]; then
                DUMP_FILE="$1"
            elif [ -z "$TARGET_DB" ]; then
                TARGET_DB="$1"
            else
                err "多余参数: $1（最多接受 <dump 路径> 与 <目标库名> 两个位置参数）"
                exit 1
            fi
            ;;
    esac
    shift
done

[ -n "$DUMP_FILE" ] || { usage >&2; die "缺少备份文件路径（必填）"; }

# 目标库名必须能在 psql 里安全引用（下面有单引号拼接的 pg_database 查询）。
if [ -n "$TARGET_DB" ]; then
    case "$TARGET_DB" in
        *[!A-Za-z0-9_]*)
            die "目标库名只允许字母/数字/下划线: ${TARGET_DB}"
            ;;
    esac
fi

# ── 闸门 ①：文件存在且可读 ────────────────────────────────────────────────
[ -e "$DUMP_FILE" ] || die "备份文件不存在: ${DUMP_FILE}"
[ -f "$DUMP_FILE" ] || die "备份路径不是普通文件: ${DUMP_FILE}"
[ -r "$DUMP_FILE" ] || die "备份文件不可读: ${DUMP_FILE}"

DUMP_SIZE="$(wc -c < "$DUMP_FILE" | tr -d '[:space:]')"
[ -n "$DUMP_SIZE" ] || die "无法读取备份文件大小: ${DUMP_FILE}"

# ── 闸门 ②：最小尺寸（与 pg-backup.sh NETOPT-4 同阈值）────────────────────
# 先于 gzip -t：截断到几字节的档连 gzip 头都不完整，报「尺寸可疑」比报
# 「gzip 损坏」更能指向真正的原因（备份被中断，不是文件被改）。
if [ "$DUMP_SIZE" -lt "$MIN_DUMP_BYTES" ]; then
    die "备份文件可疑过小（${DUMP_SIZE} 字节 < ${MIN_DUMP_BYTES} 阈值）——疑似截断/空档，拒绝恢复: ${DUMP_FILE}"
fi

# ── 闸门 ③：gzip 完整性（CRC 校验，抓截断与位翻转）────────────────────────
# -t 会把整条流解压校验一遍，截断的 gzip 必然在这里失败。恢复一份坏档进
# 半个库，比直接失败更糟：它会留下「看起来有数据」的残库。
if ! gzip -t "$DUMP_FILE" 2>/dev/null; then
    die "gzip 完整性校验失败（归档损坏或截断），拒绝恢复: ${DUMP_FILE}"
fi

# ── 闸门 ④：必须是 pg_dump 的完整 dump ────────────────────────────────────
# 只解压头部 64KiB（大备份全文扫描会把演练拖成分钟级）。gzip 在 head 提前
# 退出时吃 SIGPIPE，配合 pipefail 会让整条管道返回非 0——那不是错误，故
# 先落到临时文件再 grep，避免用退出码误判归档好坏。
toc_head="$(mktemp)"
trap 'rm -f "$toc_head"' EXIT
gzip -dc "$DUMP_FILE" 2>/dev/null | head -c 65536 > "$toc_head" || true
if ! grep -qF -- "$REQUIRED_TOC_TOKEN" "$toc_head"; then
    die "归档头部缺少 pg_dump 目录项「${REQUIRED_TOC_TOKEN}」，不是可恢复的 pg_dump 产物: ${DUMP_FILE}"
fi
rm -f "$toc_head"
trap - EXIT

log "PASS archive: ${DUMP_FILE} (${DUMP_SIZE} 字节，gzip 完整，含 pg_dump 目录项)"

# ── dry-run：校验到此为止，不碰任何数据库 ────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$KEEP_DB" -eq 1 ]; then
        keep_note="保留演练库（--keep）"
    else
        keep_note="dropdb 清理演练库"
    fi
    cat <<DRYRUN

──────────── DRY RUN（未连接任何数据库）────────────
  归档:       ${DUMP_FILE}（${DUMP_SIZE} 字节，校验通过）
  目标库:     ${TARGET_DB:-<未指定，正式执行时将生成为 restore_drill_<时间戳>>}
  将校验的表: ${REQUIRED_TABLES} ${SEEDED_TABLES}
  收尾:       ${keep_note}
  正式执行:   createdb → psql 灌入 → 表/行数校验 → 收尾
  本次未执行: createdb / psql / dropdb（零数据库写入）
──────────── DRY RUN END ────────────
DRYRUN
    log "PASS dry-run（归档可恢复；未连接数据库）"
    exit 0
fi

# ── 从这里开始才会碰数据库 ────────────────────────────────────────────────
: "${PGHOST:?PGHOST required（与 pg-backup.sh 同源，由 compose pg-backup 服务注入）}"
: "${PGUSER:?PGUSER required}"
: "${PGDATABASE:?PGDATABASE required——默认目标库要与生产库比对，故必需}"

STAMP="$(date +%Y%m%d_%H%M%S)"
if [ -z "$TARGET_DB" ]; then
    TARGET_DB="restore_drill_${STAMP}"
fi

# ── 安全闸门（本脚本存在的核心理由）──────────────────────────────────────
# 顺序刻意放在任何 createdb/psql 之前：即使数据库连不上、即使后面的一切
# 都还没发生，「把生产库当恢复目标」这件事也必须先被拦住。
if [ "$TARGET_DB" = "$PGDATABASE" ] && [ "$FORCE_OVERWRITE" -ne 1 ]; then
    cat >&2 <<REFUSE
REFUSE: 目标库 ${TARGET_DB} 等于当前生产库 PGDATABASE —— 恢复会覆盖生产数据。
        这是破坏性操作，必须显式确认：加 ${FORCE_OVERWRITE_TOKEN}。
        正常情况下请省略目标库参数，让本脚本建一次性演练库：
            bash scripts/pg-restore.sh <dump.sql.gz>
REFUSE
    exit 1
fi

# 非演练库名：同样只在显式强制下才写（避免手滑把 staging 灌掉）。
case "$TARGET_DB" in
    restore_drill_*)
        ;;
    *)
        if [ "$FORCE_OVERWRITE" -ne 1 ]; then
            cat >&2 <<REFUSE
REFUSE: 目标库 ${TARGET_DB} 不是演练库名（restore_drill_*），可能已存在且在用。
        覆盖既有库必须显式确认：加 ${FORCE_OVERWRITE_TOKEN}。
REFUSE
            exit 1
        fi
        ;;
esac

# 目标库是否已存在（to_regclass 走不了 pg_database，故直接查目录表）。
TARGET_EXISTED=0
existing_db="$(
    psql -h "$PGHOST" -U "$PGUSER" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'" 2>/dev/null || true
)"
case "$existing_db" in
    *1*) TARGET_EXISTED=1 ;;
    *)   TARGET_EXISTED=0 ;;
esac

if [ "$TARGET_EXISTED" -eq 1 ] && [ "$FORCE_OVERWRITE" -ne 1 ]; then
    # 走到这里说明目标库真实存在却没过上面的闸门（典型：上次 --keep 的遗留）。
    die "目标库 ${TARGET_DB} 已存在；加 ${FORCE_OVERWRITE_TOKEN} 才会覆盖，或换个库名"
fi

cleanup_target() {
    if [ "$KEEP_DB" -eq 1 ]; then
        log "保留演练库 ${TARGET_DB}（--keep）"
        return 0
    fi
    if dropdb -h "$PGHOST" -U "$PGUSER" --if-exists "$TARGET_DB" 2>/dev/null; then
        log "已清理演练库 ${TARGET_DB}"
    else
        err "WARN: 清理演练库 ${TARGET_DB} 失败，请手动 dropdb ${TARGET_DB}"
    fi
    return 0
}

# 失败路径必须收尾：半灌的库留在那里，下一个人会以为是「恢复出来的数据」。
on_exit() {
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        err "FAIL: 恢复演练中止（exit=${rc}）"
        cleanup_target
    fi
    exit "$rc"
}
trap on_exit EXIT

if [ "$TARGET_EXISTED" -eq 1 ]; then
    log "目标库 ${TARGET_DB} 已存在，按 ${FORCE_OVERWRITE_TOKEN} 重建"
    dropdb -h "$PGHOST" -U "$PGUSER" --if-exists "$TARGET_DB" \
        || die "无法删除既有目标库 ${TARGET_DB}"
fi

log "创建演练库 ${TARGET_DB}"
createdb -h "$PGHOST" -U "$PGUSER" "$TARGET_DB" \
    || die "createdb ${TARGET_DB} 失败"

# ── 灌入：--single-transaction 保证「要么全进、要么全不进」────────────────
# pg_dump 纯文本 dump 的每条语句都在同一事务里执行，中途任何错误整体回滚，
# 不会留下半灌库。ON_ERROR_STOP 必须开：默认 psql 遇错继续、最终退出码仍为
# 0，那正是「恢复失败却报成功」的来源。
log "恢复 ${DUMP_FILE} → ${TARGET_DB}"
if ! gzip -dc "$DUMP_FILE" | psql -h "$PGHOST" -U "$PGUSER" -d "$TARGET_DB" \
        -v ON_ERROR_STOP=1 --single-transaction --quiet; then
    die "psql 恢复失败（dump 与目标库不兼容，或归档在传输中损坏）"
fi

# ── 恢复后校验 ────────────────────────────────────────────────────────────
FAILURES=0
CHECKS=0

# 表存在性：to_regclass 在表不存在时返回 NULL（不抛错），比查
# information_schema 更直接，也避开 schema 搜索路径差异带来的假阴。
table_exists() {
    local got
    got="$(psql -h "$PGHOST" -U "$PGUSER" -d "$TARGET_DB" -tAc \
        "SELECT to_regclass('public.\"$1\"') IS NOT NULL" 2>/dev/null || true)"
    got="$(printf '%s' "$got" | tr -d '[:space:]')"
    [ "$got" = "t" ]
}

table_row_count() {
    local n
    n="$(psql -h "$PGHOST" -U "$PGUSER" -d "$TARGET_DB" -tAc \
        "SELECT count(*) FROM \"$1\"" 2>/dev/null || true)"
    printf '%s' "$n" | tr -d '[:space:]'
}

check_table() {
    local tbl="${1%%:*}" require_rows="${1##*:}" rows
    CHECKS=$((CHECKS + 1))
    if ! table_exists "$tbl"; then
        err "  ✘ 表缺失: ${tbl}"
        FAILURES=$((FAILURES + 1))
        return 0
    fi
    if [ "$SKIP_ROW_CHECKS" -eq 1 ]; then
        log "  ✔ 表存在: ${tbl}（--skip-row-checks）"
        return 0
    fi
    rows="$(table_row_count "$tbl")"
    if [ -z "$rows" ]; then
        err "  ✘ 无法统计行数: ${tbl}"
        FAILURES=$((FAILURES + 1))
        return 0
    fi
    if [ "$rows" -gt 0 ]; then
        log "  ✔ 表存在且有数据: ${tbl}（${rows} 行）"
    elif [ "$require_rows" -eq 1 ]; then
        # seed 表为空 = 迁移没跑过或 seed 被删，这不是「合法的空库」。
        err "  ✘ 表应非空但为 0 行: ${tbl}（迁移 seed 缺失？）"
        FAILURES=$((FAILURES + 1))
    else
        log "  ○ 表存在但为空: ${tbl}（空库是合法状态，不判失败）"
    fi
}

log "恢复后校验（${TARGET_DB}）"
for spec in $REQUIRED_TABLES; do check_table "$spec"; done
for spec in $SEEDED_TABLES; do check_table "$spec"; done

# 迁移记录非空是「这份 dump 属于本系统」的最便宜判据：表在但 0 行，说明
# 灌进来的可能是个空 schema 或别的库。
if [ "$SKIP_ROW_CHECKS" -ne 1 ]; then
    CHECKS=$((CHECKS + 1))
    mig_rows="$(table_row_count migrations)"
    if [ -z "$mig_rows" ] || [ "$mig_rows" -lt 1 ]; then
        err "  ✘ migrations 表为空（dump 不是本系统的库，或迁移记录未备份）"
        FAILURES=$((FAILURES + 1))
    else
        log "  ✔ 迁移记录: ${mig_rows} 条（dump 确属本系统）"
    fi
fi

cleanup_target
trap - EXIT

# ── 汇总 ──────────────────────────────────────────────────────────────────
if [ "$FAILURES" -ne 0 ]; then
    err ""
    err "════════ RESTORE DRILL: FAIL（${FAILURES}/${CHECKS} 项校验未过）════════"
    err "  归档: ${DUMP_FILE}"
    err "  目标: ${TARGET_DB}"
    exit 1
fi

if [ "$KEEP_DB" -eq 1 ]; then
    final_note="已保留"
else
    final_note="已清理"
fi

log ""
log "════════ RESTORE DRILL: PASS（${CHECKS}/${CHECKS} 项校验通过）════════"
log "  归档: ${DUMP_FILE}（${DUMP_SIZE} 字节）"
log "  恢复至: ${TARGET_DB}（${final_note}）"
exit 0
