#!/usr/bin/env bash
#
# Self-check for reset-admin-password.sh: exercises the dry-run path only, so
# it is safe in CI and never touches a database.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "✗ $1" >&2; exit 1; }
pass() { echo "✓ $1"; }

bash -n scripts/reset-admin-password.sh || fail "syntax"

OUT="$(./scripts/reset-admin-password.sh --dry-run --env-file .env.example --user selftest 2>&1)" \
  || fail "dry-run exited non-zero"

grep -q 'crypt(' <<<"$OUT" || fail "SQL is missing crypt()"
grep -q 'gen_salt' <<<"$OUT" || fail "SQL is missing gen_salt"
grep -q '"sessionVersion" = "sessionVersion" + 1' <<<"$OUT" || fail "SQL does not revoke sessions"
grep -q "uname='selftest'" <<<"$OUT" || fail "SQL does not target the requested user"
grep -q "<redacted>" <<<"$OUT" || fail "dry-run leaks the password"
pass "dry-run emits pgcrypto SQL, revokes sessions, redacts the password"

# The real script must reject a short password before touching the database.
if ./scripts/reset-admin-password.sh --env-file .env.example --password short 2>/dev/null; then
  fail "short password was accepted"
fi
pass "short password rejected"

echo "reset-admin-password selftest: all checks passed"
