#!/usr/bin/env bash
# deploy/frp/set-domain.sh — 把中台对外地址统一切到 https://<域名>
#
# 改哪四个键（admin-api 全部从 env_file 读，改完必须重建容器）：
#   CORS_ORIGINS     浏览器跨域白名单（保留原有 http:// 局域网来源）
#   ADMIN_WEB_ORIGIN 登录跳转/邮件链接的基地址
#   ADMIN_API_URL    安装命令里给执行器用的地址
#   API_BASE_URL     应用包 packageUrl 的下载基地址（执行器侧 SSRF 白名单靠它）
#
# 用法：deploy/frp/set-domain.sh acf.example.com
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DOMAIN="${1:?用法: deploy/frp/set-domain.sh <域名>}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || {
  echo "域名格式不对: $DOMAIN" >&2; exit 2;
}
ORIGIN="https://${DOMAIN}"

cp -a .env ".env.bak-$(date +%Y%m%d-%H%M%S)"

python3 - "$DOMAIN" "$ORIGIN" <<'PY'
import sys, re, pathlib
domain, origin = sys.argv[1], sys.argv[2]
p = pathlib.Path('.env')
lines = p.read_text().splitlines()

def current(key):
    for ln in lines:
        m = re.match(rf'^{key}=(.*)$', ln)
        if m:
            return m.group(1)
    return ''

# 保留既有 http:// 局域网来源，避免把直连入口从 CORS 里挤掉
lan = [o for o in current('CORS_ORIGINS').split(',') if o.startswith('http://')]
cors = ','.join([origin] + [o for o in lan if o not in {origin}])

updates = {
    'CORS_ORIGINS': cors,
    'ADMIN_WEB_ORIGIN': origin,
    'ADMIN_API_URL': origin,
    'API_BASE_URL': origin,
}
seen = set()
for i, ln in enumerate(lines):
    m = re.match(r'^([A-Z0-9_]+)=', ln)
    if m and m.group(1) in updates:
        lines[i] = f'{m.group(1)}={updates[m.group(1)]}'
        seen.add(m.group(1))
for k, v in updates.items():
    if k not in seen:
        lines.append(f'{k}={v}')
p.write_text('\n'.join(lines) + '\n')
print('updated:', ', '.join(f'{k}={v}' for k, v in updates.items()))
PY

echo "==> 重建 admin-api 使新地址生效"
docker compose -p acf --env-file .env \
  -f docker-compose.yml -f docker-compose.local.yml \
  -f docker-compose.no-executor.yml up -d admin-api >/dev/null
for _ in $(seq 1 30); do
  s="$(docker inspect -f '{{.State.Health.Status}}' acf-admin-api-1 2>/dev/null || echo starting)"
  [[ "$s" == "healthy" ]] && break
  sleep 2
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' acf-admin-api-1)" == "healthy" ]] || {
  echo "✘ admin-api 未恢复 healthy，看日志：docker logs acf-admin-api-1" >&2; exit 3;
}
# admin-web 内置 nginx 在**启动期**解析 admin-api 的 IP（apps/admin-web/nginx.conf
# 是静态 proxy_pass），admin-api 容器重建后 IP 变化会让 /api 全部 502 直到
# admin-web 重启。这里顺手重启它，避免换域名后站点白屏。
echo "==> 重启 admin-web 以刷新 admin-api 上游 IP"
docker restart acf-admin-web-1 >/dev/null
for _ in $(seq 1 30); do
  ws="$(docker inspect -f '{{.State.Health.Status}}' acf-admin-web-1 2>/dev/null || echo starting)"
  [[ "$ws" == "healthy" ]] && break
  sleep 2
done
if [[ "$(docker inspect -f '{{.State.Health.Status}}' acf-admin-web-1)" != "healthy" ]]; then
  echo "⚠ admin-web 未恢复 healthy（docker logs acf-admin-web-1）" >&2
  exit 4
fi
echo "✔ 对外地址已切换为 ${ORIGIN}（admin-api / admin-web 均 healthy）"
