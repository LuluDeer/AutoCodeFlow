#!/bin/sh
# AutoCodeFlow PostgreSQL 定时备份脚本（M-1，供 compose pg-backup profile 服务调用）
# 由 busybox crond 按 BACKUP_SCHEDULE 触发；备份保留 BACKUP_RETENTION_DAYS 天。
# 手动验证：docker compose --profile backup exec pg-backup /usr/local/bin/pg-backup.sh
# NETOPT-4：必须 -o pipefail——裸 set -eu 时管道退出值取 gzip，pg_dump（认证
# 失败/连接中断）的失败被掩盖成「backup ok」的空备份假成功。postgres:16-alpine
# 的 /bin/sh 是 busybox ash，自 1.26 起支持 pipefail，可用。
set -eu -o pipefail

: "${PGHOST:?PGHOST required}"
: "${PGUSER:?PGUSER required}"
: "${PGPASSWORD:?PGPASSWORD required}"
: "${PGDATABASE:?PGDATABASE required}"

BACKUP_DIR="${BACKUP_DIR:-/backup}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "${BACKUP_DIR}"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="${BACKUP_DIR}/db_${STAMP}.sql.gz"

if pg_dump -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" | gzip > "${FILE}"; then
    # NETOPT-4：最小尺寸校验——pg_dump 自身「成功」但产出空/近空流（半写、
    # 管道截断）时同样判失败，空 gzip 流也有 ~20 字节头，1KB 阈值足够安全。
    SIZE="$(wc -c < "${FILE}" | tr -d '[:space:]')"
    if [ "${SIZE}" -lt 1024 ]; then
        rm -f "${FILE}"
        echo "$(date -Is) backup FAILED (suspiciously small: ${SIZE} bytes)" >&2
        exit 1
    fi
    echo "$(date -Is) backup ok ${FILE} ${SIZE} bytes"
else
    # pipefail 后 pg_dump 失败（半写 .gz）走既有失败分支：清掉残件不留坏备份
    rm -f "${FILE}"
    echo "$(date -Is) backup FAILED" >&2
    exit 1
fi

# 按保留天数清理旧备份
find "${BACKUP_DIR}" -name 'db_*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete
