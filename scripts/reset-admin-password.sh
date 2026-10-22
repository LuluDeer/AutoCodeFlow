#!/usr/bin/env bash
#
# Reset an AutoCodeFlow local admin password without deleting the account.
#
# Why this exists: the old docs told people to UPDATE users SET
# password_hash='$2b$10$placeholder' — the column is actually "password", the
# value is not a valid bcrypt hash, and following it locks the account forever.
# This script uses Postgres' pgcrypto (`crypt` + `gen_salt('bf')`) so it works
# even when no Node/Python toolchain is available, and bumps "sessionVersion" so
# every existing access/refresh token for that user is revoked.
#
# Usage:
#   ./scripts/reset-admin-password.sh                 # production .env, prompt
#   ./scripts/reset-admin-password.sh --demo          # local demo stack
#   ./scripts/reset-admin-password.sh --user alice --password 'NewPass123!'
#   ./scripts/reset-admin-password.sh --dry-run       # print SQL, no DB writes
#
# It must run on the Docker host (it uses `docker compose exec postgres psql`).
# For a non-Docker deployment, copy the SQL printed by --dry-run and run it with
# psql against your database.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

USERNAME="admin"
PASSWORD=""
PROJECT=""
ENV_FILE=".env"
DEMO=0
DRY_RUN=0
COMPOSE_FILES=(-f "$ROOT/docker-compose.yml")

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) [[ $# -ge 2 ]] || { echo "--user needs a value" >&2; exit 2; }; USERNAME="$2"; shift ;;
    --password) [[ $# -ge 2 ]] || { echo "--password needs a value" >&2; exit 2; }; PASSWORD="$2"; shift ;;
    --project) [[ $# -ge 2 ]] || { echo "--project needs a value" >&2; exit 2; }; PROJECT="$2"; shift ;;
    --env-file) [[ $# -ge 2 ]] || { echo "--env-file needs a value" >&2; exit 2; }; ENV_FILE="$2"; shift ;;
    --demo) DEMO=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

if (( DEMO )); then
  ENV_FILE=".env.demo"
  PROJECT="${PROJECT:-acf-demo}"
  COMPOSE_FILES=(-f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.demo.yml")
fi

if [[ ! -f "$ROOT/$ENV_FILE" ]]; then
  echo "✗ $ENV_FILE not found in $ROOT" >&2
  echo "  For the local demo use --demo; for production create .env first." >&2
  exit 1
fi

# Read POSTGRES_USER / DB_DATABASE from the env file without sourcing it.
read_env() { sed -n "s/^$1=//p" "$ROOT/$ENV_FILE" | tail -1; }
PG_USER="$(read_env POSTGRES_USER)"; PG_USER="${PG_USER:-autoflow}"
DB_NAME="$(read_env DB_DATABASE)"; DB_NAME="${DB_NAME:-autoflow}"

if [[ -z "$PASSWORD" ]]; then
  if (( DRY_RUN )); then
    PASSWORD="<redacted>"
  elif [[ ! -t 0 ]]; then
    echo "✗ no TTY for a password prompt; pass --password for automation" >&2
    exit 1
  else
    read -r -s -p "New password for '$USERNAME': " PASSWORD; echo
    read -r -s -p "Repeat: " PASSWORD2; echo
    [[ "$PASSWORD" == "$PASSWORD2" ]] || { echo "✗ passwords do not match" >&2; exit 1; }
  fi
fi

if (( ! DRY_RUN )); then
  if (( ${#PASSWORD} < 8 )); then
    echo "✗ password must be at least 8 characters" >&2
    exit 1
  fi
  if [[ "$PASSWORD" == *"'"* || "$PASSWORD" == *"\\"* ]]; then
    echo "✗ password contains a quote or backslash; psql variable binding gets fragile." >&2
    echo "  Choose a password without ' or \\ (or reset it through the UI)." >&2
    exit 1
  fi
fi

SQL="$(cat <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
WITH updated AS (
  UPDATE "users"
     SET "password" = crypt(:'pw', gen_salt('bf', 10)),
         "sessionVersion" = "sessionVersion" + 1,
         "loginFailCount" = 0,
         "lockedUntil" = NULL,
         "updatedAt" = now()
   WHERE "username" = :'uname'
   RETURNING 1
)
SELECT count(*) AS updated FROM updated;
SQL
)"

if (( DRY_RUN )); then
  echo "── SQL (dry-run, not executed) ──────────────────────────────"
  echo "$SQL"
  echo "── psql invocation ─────────────────────────────────────────"
  echo "docker compose ${COMPOSE_FILES[*]} exec -T postgres psql -U $PG_USER -d $DB_NAME -v pw='<redacted>' -v uname='$USERNAME'"
  exit 0
fi

# Compose detection (same policy as scripts/demo.sh / Makefile).
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "✗ docker compose not found; run the SQL from --dry-run manually" >&2
  exit 1
fi

compose() {
  local args=(--env-file "$ROOT/$ENV_FILE")
  [[ -n "$PROJECT" ]] && args+=(-p "$PROJECT")
  args+=("${COMPOSE_FILES[@]}")
  "${DC[@]}" "${args[@]}" "$@"
}

if [[ -z "$(compose ps -q postgres 2>/dev/null || true)" ]]; then
  echo "✗ postgres container is not running for this compose project." >&2
  echo "  Start the stack first, or run with --dry-run and apply the SQL manually." >&2
  exit 1
fi

set +e
OUTPUT="$(printf '%s\n' "$SQL" | compose exec -T postgres \
  psql -U "$PG_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
       -v pw="$PASSWORD" -v uname="$USERNAME" 2>&1)"
STATUS=$?
set -e

if (( STATUS != 0 )); then
  echo "✗ password reset failed:" >&2
  echo "$OUTPUT" >&2
  exit "$STATUS"
fi

UPDATED="$(printf '%s\n' "$OUTPUT" | sed -n 's/^ *\([0-9][0-9]*\) *$/\1/p' | tail -1)"
if [[ "${UPDATED:-0}" == "0" ]]; then
  echo "✗ no user named '$USERNAME' was updated (0 rows)." >&2
  echo "  Check the username; the account still has its old password." >&2
  exit 1
fi

echo "✓ password updated for '$USERNAME' (${UPDATED} row); existing sessions revoked."
echo "  Log in again at the admin UI with the new password."
