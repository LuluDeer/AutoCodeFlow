"""R9 (round-9, parity with executor-node startup-identity.ts): the
executor's process-life identity.

``startupId`` is the idempotency key admin-api uses to tell "same process
re-fetching its token" apart from "a restarted executor" (N4 register
semantics, extended to POST /api/executors/token in round 8). It lives in
its own module because auth.py needs it for the token request body, and
importing it from scheduler.py would create a cycle:
    auth -> scheduler -> auth
scheduler.py re-exports both constants so existing importers (main.py,
tests) keep working unchanged.
"""
import uuid
from datetime import datetime, timezone

executor_started_at = datetime.now(timezone.utc).isoformat()
executor_startup_id = str(uuid.uuid4())
