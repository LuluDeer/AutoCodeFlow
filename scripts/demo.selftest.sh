#!/usr/bin/env bash
#
# Static self-check for the demo tooling. No Docker required, safe for CI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "✗ $1" >&2; exit 1; }
pass() { echo "✓ $1"; }

bash -n scripts/demo.sh || fail "scripts/demo.sh syntax"
bash -n scripts/reset-admin-password.sh || fail "scripts/reset-admin-password.sh syntax"
bash -n scripts/demo-desktop-gui.sh || fail "scripts/demo-desktop-gui.sh syntax"
bash -n scripts/demo-desktop-agent.sh || fail "scripts/demo-desktop-agent.sh syntax"
bash -n scripts/demo-desktop-agent-diagnose.sh || fail "scripts/demo-desktop-agent-diagnose.sh syntax"
node --check scripts/demo-headless-agent.mjs || fail "scripts/demo-headless-agent.mjs syntax"
node --check scripts/demo-ops-agent.mjs || fail "scripts/demo-ops-agent.mjs syntax"

HELP="$(./scripts/demo.sh --help)"
grep -q 'One-command demo for AutoCodeFlow' <<<"$HELP" || fail "demo --help is missing the description"
grep -q -- '--reset' <<<"$HELP" || fail "demo --help is missing --reset"
grep -q -- '--build' <<<"$HELP" || fail "demo --help is missing --build"
pass "demo --help documents the supported flags"

# The demo compose override must keep the UI off :80 and replace .env with
# .env.demo. These are the two properties that make the demo safe to run next
# to an existing deployment.
grep -q 'ACF_DEMO_WEB_PORT' docker-compose.demo.yml || fail "demo compose has no configurable web port"
grep -q 'env_file: !override' docker-compose.demo.yml || fail "demo compose does not isolate env_file"
grep -q '.env.demo' .gitignore || fail ".env.demo is not gitignored"
pass "demo compose isolates ports/env and .env.demo is ignored"

bash scripts/reset-admin-password.selftest.sh

echo "demo selftest: all checks passed"
