#!/bin/sh
# AutoCodeFlow pg-backup 容器入口（M-1）
# 把 BACKUP_SCHEDULE 写入 busybox crontab 后前台运行 crond；日志进 stdout
# （docker compose logs pg-backup 可直接查看每次备份结果）。
set -eu

SCHEDULE="${BACKUP_SCHEDULE:-0 2 * * *}"
echo "${SCHEDULE} /usr/local/bin/pg-backup.sh >> /var/log/pg-backup.log 2>&1" > /etc/crontabs/root

exec crond -f -l 6
