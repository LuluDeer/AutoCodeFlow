#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# pg-restore.sh 自检 —— 全离线、零数据库、零网络
#
# 为什么需要它：pg-restore.sh 是**唯一会写数据库的恢复路径**，而恢复本身是
# 破坏性操作——它最该被证明的不是「能恢复」，而是「默认不碰生产」。
# 故本自检的重心是安全不变量，而不是 happy path：
#   · 语法（bash -n）+ shebang
#   · 参数校验（缺参 / 文件不存在 / 未知参数 / 多余位置参数）
#   · 归档闸门（<256B 截断件、gzip 损坏、非 pg_dump 产物 三种都必须拒绝）
#   · **安全闸门**：目标库 == PGDATABASE 且无 --force-overwrite-production
#     时必须拒绝——且要用**真实调用**证明（不看源码 grep，看进程行为）
#   · 默认目标库必须是 restore_drill_* 一次性演练库（断言 createdb 的实参）
#   · --dry-run 必须零数据库写入（断言 createdb/psql/dropdb 一次都没被调）
#   · 清理语义（默认 dropdb，--keep 不 drop）
#
# 怎么做到离线：把 psql / createdb / dropdb / gzip 全部用 PATH 前置的桩替换，
# 桩把每次调用写进日志文件。于是「有没有碰数据库」变成可断言的事实，而不是
# 阅读源码后的推测——这正是本仓 selftest 的一贯路线（见 deploy.selftest.sh
# 的 health/logs 桩、chaos-drill.selftest.sh 的 library 模式）。
#
# 用法: bash scripts/pg-restore.selftest.sh
# 退出码: 0=全通过, 1=有失败
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly SCRIPT_DIR ROOT_DIR
readonly RESTORE="$ROOT_DIR/scripts/pg-restore.sh"
readonly SELFTEST="$ROOT_DIR/scripts/pg-restore.selftest.sh"

FAILURES=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); printf '  ✔ %s\n' "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  ✘ %s\n' "$1" >&2; }

# assert_exit <测试名> <期望退出码> <命令...>
assert_exit() {
    local name="$1" expected="$2"; shift 2
    local actual=0
    "$@" >/dev/null 2>&1 || actual=$?
    if [ "$actual" -eq "$expected" ]; then
        pass "${name}（exit=${actual}）"
    else
        fail "${name}（期望 exit=${expected}，实际 exit=${actual}）"
    fi
}

# assert_contains <测试名> <期望子串> <实际输出>
assert_contains() {
    local name="$1" needle="$2" haystack="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        pass "$name"
    else
        fail "${name}（期望含: ${needle}；实际: $(printf '%s' "$haystack" | head -c 240)）"
    fi
}

# assert_not_contains <测试名> <禁止子串> <实际输出>
assert_not_contains() {
    local name="$1" needle="$2" haystack="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        fail "${name}（不应含: ${needle}）"
    else
        pass "$name"
    fi
}

[ -f "$RESTORE" ] || { echo "找不到 pg-restore.sh: $RESTORE" >&2; exit 1; }

printf '\n=== pg-restore.sh 自检（离线，无数据库）===\n\n'

# ── 1. 语法 / shebang / 可执行性 ─────────────────────────────────────────
printf '── 1. 语法与可执行性 ──\n'
assert_exit "pg-restore.sh bash -n 语法检查通过" 0 bash -n "$RESTORE"
assert_exit "pg-restore.selftest.sh bash -n 语法检查通过" 0 bash -n "$SELFTEST"

# shebang 必须让 `bash <path>` 与直接执行两条路径都成立（CI 用前者）。
shebang="$(head -n 1 "$RESTORE")"
if [ "$shebang" = '#!/usr/bin/env bash' ]; then
    pass "shebang 为 #!/usr/bin/env bash"
else
    fail "shebang 非预期（实际: ${shebang}）"
fi

# 可执行位：本仓 scripts/*.sh 一律以 `bash <path>` 方式被 CI/package.json 调用，
# 且多数提交为 100644；在 filemode 不被跟踪的检出（Windows）上 `-x` 也不可信。
# 故仅在确有可执行位时计一条通过，否则如实打印跳过——不造假绿。
if [ -x "$RESTORE" ]; then
    pass "具有可执行权限"
else
    printf '  (跳过可执行位断言：本仓 scripts/*.sh 以 `bash <path>` 调用，检出未保留 755)\n'
fi

# ── 2. 离线桩：psql / createdb / dropdb / gzip ───────────────────────────
# 桩把每次调用追加到 ${STUB_LOG}，于是「碰没碰数据库」可被断言。
printf '\n── 2. 搭建离线桩（无真实数据库、无网络）──\n'
stub_bin="$(mktemp -d)"
work_dir="$(mktemp -d)"
cleanup_dirs() { rm -rf "$stub_bin" "$work_dir"; }
trap cleanup_dirs EXIT

cat > "$stub_bin/psql" <<'STUB'
#!/usr/bin/env bash
# psql 桩：按 SQL 形态给出确定性应答，其余一律吞掉 stdin 后成功退出。
printf 'psql %s\n' "$*" >> "${STUB_LOG:?}"
last="${!#}"
if [ -n "${STUB_PSQL_FAIL:-}" ]; then exit 1; fi
case "$last" in
    *pg_database*)
        # 目录表探测：默认「目标库不存在」；STUB_DB_EXISTS=1 时报告已存在。
        if [ "${STUB_DB_EXISTS:-0}" = "1" ]; then printf '1\n'; fi
        ;;
    *to_regclass*)
        # 表存在性探测：命中 STUB_MISSING_TABLES 里的表则输出空（= 表不存在）。
        for t in ${STUB_MISSING_TABLES:-}; do
            case "$last" in
                *"\"$t\""*) exit 0 ;;
            esac
        done
        printf 't\n'
        ;;
    *count\(\*\)*)
        # 行数探测：命中 STUB_ZERO_TABLES 里的表则回 0 行。
        for t in ${STUB_ZERO_TABLES:-}; do
            case "$last" in
                *"\"$t\""*) printf '0\n'; exit 0 ;;
            esac
        done
        printf '%s\n' "${STUB_ROW_COUNT:-7}"
        ;;
    *)
        # 灌入阶段（-v ON_ERROR_STOP=1 --single-transaction --quiet）：
        # 必须把 stdin 读干净，否则上游 gzip 会吃 SIGPIPE。
        cat >/dev/null
        ;;
esac
exit 0
STUB
chmod +x "$stub_bin/psql"

cat > "$stub_bin/createdb" <<'STUB'
#!/usr/bin/env bash
printf 'createdb %s\n' "$*" >> "${STUB_LOG:?}"
if [ -n "${STUB_CREATEDB_FAIL:-}" ]; then exit 1; fi
exit 0
STUB
chmod +x "$stub_bin/createdb"

cat > "$stub_bin/dropdb" <<'STUB'
#!/usr/bin/env bash
printf 'dropdb %s\n' "$*" >> "${STUB_LOG:?}"
exit 0
STUB
chmod +x "$stub_bin/dropdb"

cat > "$stub_bin/gzip" <<'STUB'
#!/usr/bin/env bash
# gzip 桩：-t 的成败由 STUB_GZIP_T_FAIL 控制；-dc 原样吐出文件内容
# （供脚本校验 TOC 目录项）。真实 gzip 行为已由闸门 ②③ 之外的真实用例覆盖。
printf 'gzip %s\n' "$*" >> "${STUB_LOG:?}"
case "${1:-}" in
    -t)
        if [ -n "${STUB_GZIP_T_FAIL:-}" ]; then
            printf 'gzip: stub: unexpected end of file\n' >&2
            exit 1
        fi
        exit 0
        ;;
    -dc)
        # 最后一个参数是文件路径
        cat -- "${!#}" 2>/dev/null || true
        exit 0
        ;;
esac
exit 0
STUB
chmod +x "$stub_bin/gzip"

# 桩隔离自证：本 selftest 全程只会看见这些桩，不会命中系统 psql/createdb。
if PATH="$stub_bin:$PATH" command -v psql | grep -qF "$stub_bin"; then
    pass "psql 已被 PATH 前置桩接管（不会连真实数据库）"
else
    fail "psql 未被桩接管（自检可能触碰真实数据库）"
fi
if PATH="$stub_bin:$PATH" command -v createdb | grep -qF "$stub_bin"; then
    pass "createdb 已被 PATH 前置桩接管"
else
    fail "createdb 未被桩接管"
fi

# 桩日志（每次运行前清空，用 STUB_LOG 传给子进程）
STUB_LOG="$work_dir/calls.log"
export STUB_LOG
reset_log() { : > "$STUB_LOG"; }
calls() { cat "$STUB_LOG" 2>/dev/null || true; }
# 「碰没碰数据库」只统计 psql/createdb/dropdb；gzip 是本地归档工具，不算。
# 这条区分是本自检的判据基础：归档校验必然调 gzip，但**绝不该**调数据库。
db_calls() {
    grep -E '^(psql|createdb|dropdb) ' "$STUB_LOG" 2>/dev/null || true
}
# assert_no_db_calls <label> —— 断言本用例一次数据库调用都没发生。
assert_no_db_calls() {
    local n
    n="$(db_calls)"
    if [ -n "$n" ]; then
        fail "$1（已发生: $(printf '%s' "$n" | head -n1)）"
    else
        pass "$1"
    fi
}

# 运行恢复脚本的统一入口：桩 PATH + 受控 PG* 环境变量。
# PGHOST 用不可解析的域名是刻意的：即使桩失效也不可能连上真实库。
run_restore() {
    PATH="$stub_bin:$PATH" \
    PGHOST="stub.invalid" PGUSER="stub_user" PGPASSWORD="stub_pw" \
    PGDATABASE="autoflow_prod" \
    bash "$RESTORE" "$@"
}

# 构造归档：good = 够大且含 pg_dump TOC；tiny = <256B；noTOC = 够大但无 TOC。
good_dump="$work_dir/db_20261017_020000.sql.gz"
{
    printf -- '--\n-- PostgreSQL database dump\n--\n'
    i=0
    while [ "$i" -lt 40 ]; do
        printf -- '-- padding line %s for size floor\n' "$i"
        i=$((i + 1))
    done
} > "$good_dump"

tiny_dump="$work_dir/db_tiny.sql.gz"
printf 'x' > "$tiny_dump"

no_toc_dump="$work_dir/db_notadump.sql.gz"
{
    printf -- 'not a database dump at all\n'
    i=0
    while [ "$i" -lt 40 ]; do
        printf -- '-- filler %s\n' "$i"
        i=$((i + 1))
    done
} > "$no_toc_dump"

for f in "$good_dump" "$tiny_dump" "$no_toc_dump"; do
    sz="$(wc -c < "$f" | tr -d '[:space:]')"
    printf '  构造归档 %s（%s 字节）\n' "$(basename "$f")" "$sz"
done

# ── 3. 参数校验 ──────────────────────────────────────────────────────────
printf '\n── 3. 参数校验 ──\n'
reset_log
out="$(run_restore 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "缺少备份路径被拒绝（exit=${rc}）"; else fail "缺少备份路径竟被接受"; fi
assert_contains "缺参时打印用法" "用法" "$out"
assert_no_db_calls "缺参时零数据库调用"

reset_log
assert_exit "不存在的文件被拒绝" 1 run_restore "$work_dir/nope.sql.gz"
out="$(run_restore "$work_dir/nope.sql.gz" 2>&1 || true)"
assert_contains "文件不存在报错可读" "备份文件不存在" "$out"

reset_log
assert_exit "未知参数被拒绝" 1 run_restore "$good_dump" --bogus-flag
out="$(run_restore "$good_dump" --bogus-flag 2>&1 || true)"
assert_contains "未知参数报错可读" "未知参数" "$out"

reset_log
assert_exit "多余位置参数被拒绝" 1 run_restore "$good_dump" db_a db_b
out="$(run_restore "$good_dump" db_a db_b 2>&1 || true)"
assert_contains "多余参数报错可读" "多余参数" "$out"

reset_log
assert_exit "目标库名含非法字符被拒绝" 1 run_restore "$good_dump" 'evil;drop'
out="$(run_restore "$good_dump" 'evil;drop' 2>&1 || true)"
assert_contains "非法库名报错可读" "只允许字母/数字/下划线" "$out"

reset_log
assert_exit "--help 退出码为 0" 0 run_restore --help
out="$(run_restore --help 2>&1)"
assert_contains "--help 说明默认演练库" "restore_drill_" "$out"
assert_contains "--help 说明生产覆盖开关" "--force-overwrite-production" "$out"

# ── 4. 归档闸门（截断 / 损坏 / 非 pg_dump）───────────────────────────────
printf '\n── 4. 归档完整性闸门 ──\n'
reset_log
out="$(run_restore "$tiny_dump" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "截断归档（<256B）被拒绝（exit=${rc}）"; else fail "截断归档竟被接受"; fi
assert_contains "截断归档报「可疑过小」" "可疑过小" "$out"
assert_contains "截断归档报出实际字节数" "1 字节" "$out"
# 反证：尺寸闸门必须先于 gzip -t——截断档连 gzip 头都不完整，报尺寸才对症。
assert_not_contains "截断归档未被误报成 gzip 损坏" "gzip 完整性校验失败" "$out"
assert_no_db_calls "截断归档零数据库调用"

reset_log
out="$(STUB_GZIP_T_FAIL=1 run_restore "$good_dump" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "gzip 损坏的归档被拒绝（exit=${rc}）"; else fail "gzip 损坏的归档竟被接受"; fi
assert_contains "gzip 损坏报错可读" "gzip 完整性校验失败" "$out"
assert_no_db_calls "gzip 损坏零数据库调用"

reset_log
out="$(run_restore "$no_toc_dump" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "非 pg_dump 产物被拒绝（exit=${rc}）"; else fail "非 pg_dump 产物竟被接受"; fi
assert_contains "非 pg_dump 产物报缺目录项" "PostgreSQL database dump" "$out"
assert_no_db_calls "非 pg_dump 产物零数据库调用"

# ── 5. 安全闸门：目标库 == PGDATABASE 必须拒绝（核心不变量）──────────────
printf '\n── 5. 安全闸门：不得默认覆盖生产库 ──\n'
reset_log
out="$(run_restore "$good_dump" autoflow_prod 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then
    pass "目标库 == PGDATABASE 且无 --force 时被拒绝（exit=${rc}）"
else
    fail "目标库 == PGDATABASE 且无 --force 竟被接受（会覆盖生产！）"
fi
assert_contains "拒绝时明确点名生产库覆盖风险" "等于当前生产库 PGDATABASE" "$out"
assert_contains "拒绝时给出显式开关" "--force-overwrite-production" "$out"
# 最关键的反证：被拒绝时**一次数据库调用都不能发生**。
assert_no_db_calls "拒绝发生在任何数据库调用之前（零 createdb/psql/dropdb）"

# 非演练库名的既有库同样要被拦（防手滑灌掉 staging）。
reset_log
out="$(run_restore "$good_dump" autoflow_staging 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "非演练库名（staging）无 --force 时被拒绝（exit=${rc}）"; else fail "非演练库名竟被直接接受"; fi
assert_contains "拒绝非演练库名时说明原因" "不是演练库名" "$out"
assert_no_db_calls "拒绝非演练库时零数据库调用"

# --dry-run 也不该因此被拦（只打印不落地）。
reset_log
out="$(run_restore "$good_dump" autoflow_prod --dry-run 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "dry-run 不受生产覆盖拦截（只读，exit=0）"; else fail "dry-run 被生产覆盖拦截（应放行）"; fi
assert_no_db_calls "dry-run 零数据库调用"

# ── 6. --dry-run 不建库、不灌数据、不改任何东西 ──────────────────────────
printf '\n── 6. --dry-run 安全性 ──\n'
reset_log
out="$(run_restore "$good_dump" --dry-run 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "dry-run 归档校验通过（exit=0）"; else fail "dry-run 应 exit=0（实际 ${rc}）"; fi
assert_contains "dry-run 打印 DRY RUN 横幅" "DRY RUN" "$out"
assert_contains "dry-run 声明未连接数据库" "未连接任何数据库" "$out"
assert_contains "dry-run 打印将校验的表" "audit_logs" "$out"
assert_no_db_calls "dry-run 零 createdb / 零 psql / 零 dropdb"
# 反证：dry-run 不得留下任何数据库（桩日志里没有 createdb 即证明没建库）。
if printf '%s' "$(calls)" | grep -qF "createdb"; then
    fail "dry-run 竟创建了数据库"
else
    pass "dry-run 未创建数据库"
fi

# ── 7. 默认目标库 = 一次性演练库（不是生产库）────────────────────────────
printf '\n── 7. 默认目标库为演练库 ──\n'
reset_log
out="$(run_restore "$good_dump" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "完整演练 PASS（exit=0）"; else fail "完整演练应 exit=0（实际 ${rc}）；输出: $(printf '%s' "$out" | tail -c 400)"; fi
assert_contains "汇总打印 PASS" "RESTORE DRILL: PASS" "$out"
assert_contains "校验表存在且有数据" "audit_logs" "$out"
assert_contains "迁移记录非空校验" "迁移记录" "$out"

createdb_calls="$(calls | grep -F 'createdb ' || true)"
assert_contains "createdb 被调用（演练真的建了库）" "createdb " "$createdb_calls"
if printf '%s' "$createdb_calls" | grep -qF "restore_drill_"; then
    pass "默认目标库为 restore_drill_* 演练库"
else
    fail "默认目标库不是演练库（实际: ${createdb_calls}）"
fi
# 核心反证：默认路径**绝不能**把 PGDATABASE 当目标。
if printf '%s' "$createdb_calls" | grep -qw "autoflow_prod"; then
    fail "默认路径竟把生产库 PGDATABASE 当恢复目标（灾难）"
else
    pass "默认路径未触碰生产库 PGDATABASE"
fi
assert_contains "默认路径用 --single-transaction 灌入" "--single-transaction" "$(calls)"
assert_contains "默认路径用 ON_ERROR_STOP 灌入" "ON_ERROR_STOP=1" "$(calls)"
assert_contains "演练库用完即清理（dropdb 被调用）" "dropdb " "$(calls)"
assert_contains "汇总标明已清理" "已清理" "$out"

# --keep：必须保留现场（不 drop）。
reset_log
out="$(run_restore "$good_dump" --keep 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "--keep 演练 PASS（exit=0）"; else fail "--keep 演练应 exit=0（实际 ${rc}）"; fi
assert_contains "--keep 打印保留提示" "已保留" "$out"
if printf '%s' "$(calls)" | grep -qF "dropdb "; then
    fail "--keep 竟仍 dropdb 了演练库"
else
    pass "--keep 未删除演练库"
fi

# ── 8. 恢复后校验必须真的咬人 ────────────────────────────────────────────
printf '\n── 8. 恢复后校验有齿 ──\n'
reset_log
out="$(STUB_MISSING_TABLES=tasks run_restore "$good_dump" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "缺表时演练 FAIL（exit=${rc}）"; else fail "缺表竟仍报 PASS（假绿）"; fi
assert_contains "缺表报出表名" "表缺失: tasks" "$out"
assert_contains "汇总打印 FAIL" "RESTORE DRILL: FAIL" "$out"
# 失败路径也必须清理：半灌库不能留给下一个人。
assert_contains "失败路径仍清理演练库" "dropdb " "$(calls)"

reset_log
out="$(STUB_ZERO_TABLES=task_templates run_restore "$good_dump" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "seed 表为空时 FAIL（exit=${rc}）"; else fail "seed 表为空竟仍 PASS"; fi
assert_contains "seed 表为空报错可读" "应非空但为 0 行" "$out"

reset_log
out="$(STUB_ZERO_TABLES=migrations run_restore "$good_dump" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "migrations 为空时 FAIL（exit=${rc}）"; else fail "migrations 为空竟仍 PASS"; fi
assert_contains "migrations 为空说明原因" "不是本系统的库" "$out"

# 反证：--skip-row-checks 只关行数校验，不关表存在校验。
reset_log
out="$(STUB_ZERO_TABLES=task_templates run_restore "$good_dump" --skip-row-checks 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "--skip-row-checks 跳过行数校验（exit=0）"; else fail "--skip-row-checks 应 exit=0（实际 ${rc}）"; fi
reset_log
out="$(STUB_MISSING_TABLES=tasks run_restore "$good_dump" --skip-row-checks 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "--skip-row-checks 仍校验表存在（exit=${rc}）"; else fail "--skip-row-checks 竟连表存在都不校验"; fi

# psql 灌入失败：必须 FAIL 且清理，不能留半灌库。
reset_log
out="$(STUB_PSQL_FAIL=1 run_restore "$good_dump" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "psql 灌入失败时 FAIL（exit=${rc}）"; else fail "psql 灌入失败竟仍 PASS"; fi
assert_contains "灌入失败报错可读" "psql 恢复失败" "$out"
assert_contains "灌入失败仍清理演练库" "dropdb " "$(calls)"

# ── 9. --force-overwrite-production 才放行生产库 ─────────────────────────
printf '\n── 9. --force-overwrite-production 闸门 ──\n'
reset_log
out="$(run_restore "$good_dump" autoflow_prod --force-overwrite-production 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "显式 --force 后生产库目标被放行（exit=0）"; else fail "显式 --force 后仍被拒绝（实际 ${rc}）；输出: $(printf '%s' "$out" | tail -c 300)"; fi
assert_contains "强制路径确实以生产库为目标" "autoflow_prod" "$(calls | grep -F 'createdb ' || true)"

# 已存在的目标库（无 --force）必须被拦——典型是上次 --keep 的遗留。
reset_log
out="$(STUB_DB_EXISTS=1 run_restore "$good_dump" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "已存在的目标库无 --force 时被拒绝（exit=${rc}）"; else fail "已存在的目标库竟被静默覆盖"; fi
assert_contains "已存在库报错可读" "已存在" "$out"

# ── 汇总 ─────────────────────────────────────────────────────────────────
printf '\n=== 结果: %d 通过, %d 失败 ===\n\n' "$PASSES" "$FAILURES"
[ "$FAILURES" -eq 0 ] || exit 1
