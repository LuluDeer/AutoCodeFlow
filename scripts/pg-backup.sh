#!/bin/sh
# AutoCodeFlow PostgreSQL 定时备份脚本（M-1，供 compose pg-backup profile 服务调用）
# 由 busybox crond 按 BACKUP_SCHEDULE 触发；备份保留 BACKUP_RETENTION_DAYS 天。
# 手动验证：docker compose --profile backup exec pg-backup /usr/local/bin/pg-backup.sh
set -eu

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
    SIZE="$(wc -c < "${FILE}")"
    echo "$(date -Is) backup ok ${FILE} ${SIZE} bytes"
else
    rm -f "${FILE}"
    echo "$(date -Is) backup FAILED" >&2
    exit 1
fi

# 按保留天数清理旧备份
find "${BACKUP_DIR}" -name 'db_*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete
