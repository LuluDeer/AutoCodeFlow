"""Task execution context — passed to every task handler."""
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
import json
import os

from .callback import CallbackClient

# R9 (round-9): AUTOFLOW_* keys that carry callback credentials / routing
# info (N23/N27 parity with executor-node). They are exposed as dedicated
# TaskContext fields and deliberately EXCLUDED from `params` — folding a
# one-shot HMAC token or a deployment address into user task parameters
# would pollute the parameter view and leak the credential into any code
# that dumps ctx.params.
_CALLBACK_ENV_KEYS = {
    "AUTOFLOW_CALLBACK_TOKEN": "callback_token",
    "AUTOFLOW_ADMIN_API_URL": "admin_api_url",
    "AUTOFLOW_EXECUTOR_ADDRESS": "executor_address",
    # ADR-017 阶段 3 (protocol v6): the executor's stable install identity,
    # the callback face's row identity when a shared/legacy token is used.
    # Listed here for the same reason as the address — it is platform
    # plumbing, not user data, so it must not leak into `params`.
    "AUTOFLOW_DEVICE_FINGERPRINT": "device_fingerprint",
}

# A-11R: typed params channel injected by both executors since protocol v5 —
# the whole params object as one compact JSON document. It is the ONLY way to
# tell the string "true" apart from the boolean True, because every per-key
# AUTOFLOW_<KEY> value is a string by construction. Never surfaced as a param
# itself (it is platform plumbing, not user data).
_PARAMS_JSON_ENV_KEY = "AUTOFLOW_PARAMS_JSON"

# A-11R: platform plumbing that must never be mistaken for a user parameter.
# AUTOFLOW_ARTIFACTS_DIR / AUTOFLOW_TRACE_ID are injected by the executors for
# every task and are not params either, but they are deliberately LEFT in
# `params` for backward compatibility (tasks written against the old
# normalisation already read them from there) — only the typed channel, which
# the old normalisation can never have produced, is filtered out.
_NON_PARAM_ENV_KEYS = frozenset({_PARAMS_JSON_ENV_KEY})


def _load_typed_params(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    """Parse the typed ``AUTOFLOW_PARAMS_JSON`` channel.

    Returns ``None`` when the channel is absent (executor < protocol v5) or
    unusable, in which case the caller falls back to the per-key variables.
    A malformed payload must never raise inside ``from_env()``: a task that
    cannot even build its context reports nothing useful, whereas degrading
    to the per-key channel loses only type fidelity.
    """
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    # Keys are lower-cased to match the documented normalisation of the
    # per-key channel ("AUTOFLOW_<KEY> → ctx.params 小写键"). Keeping the typed
    # channel's original casing instead would silently change the lookup key
    # for every task that configured an upper/mixed-case param and reads it
    # from `ctx.params` — a migration hazard with no upside, since the two
    # channels must agree on what the key is.
    return {
        (k.lower() if isinstance(k, str) else k): v for k, v in parsed.items()
    }


def _coerce_param(value: str) -> Any:
    """Best-effort type recovery for the per-key fallback channel.

    The executor renders strings **bare** (``AUTOFLOW_REGION=欧盟``) and
    non-strings as JSON (``AUTOFLOW_DRY_RUN=true``, ``AUTOFLOW_TAGS=["a",2]``).
    JSON-parsing every value would therefore be wrong for the common case: a
    user who typed ``3`` or ``true`` in the UI meant the *string* ``"3"``, and
    turning it into an int/bool changes behaviour (and breaks
    ``f"{v:>10}"``-style formatting). Bare ``欧盟`` is not valid JSON at all,
    so the discriminating rule is: **decode only the shapes JSON produces for
    a non-string** — containers, the three literals, and numbers that carry a
    JSON-only marker (exponent or decimal point). Everything else stays a
    string. Note this is inherently lossy; the typed channel exists precisely
    so tasks that care can avoid guessing.
    """
    if not value:
        return value
    if value[0] in "[{":
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value
    if value[0] == '"':
        # A-11 legacy form (executors < protocol v5): strings were injected
        # JSON-quoted, so `"欧盟"` is the user's string 欧盟 carrying a pair of
        # stray quotes. Recovering it here repairs the fallback path for the
        # whole pre-v5 fleet — the exact regression that silently broke tasks
        # for 12 days in production.
        #
        # Why this cannot corrupt a v5 task: on v5 every user param arrives via
        # the typed channel above and is skipped by the `key in params` guard,
        # so this branch only ever sees non-param platform variables (paths,
        # trace ids) whose values do not begin with a quote. A user string that
        # genuinely starts with `"` is indistinguishable on a *pre-v5*
        # executor, but that shape is vanishingly rare and stripping is the
        # strictly better guess there.
        try:
            decoded = json.loads(value)
        except (ValueError, TypeError):
            return value
        return decoded if isinstance(decoded, str) else value
    if value in ("true", "false", "null"):
        return json.loads(value)
    # A number only when it could not have been typed as plain text: JSON
    # renders 1e-7 / 1.5 with an explicit marker, whereas "3" or "2024-06-01"
    # are indistinguishable from user text and must stay strings.
    first = value[0]
    if first == "-" or first.isdigit():
        if "." in value or "e" in value or "E" in value:
            try:
                return json.loads(value)
            except (ValueError, TypeError):
                return value
    return value


@dataclass
class TaskContext:
    """Provides runtime metadata and helpers to a running task."""

    task_id: str
    execution_id: str
    task_name: str
    params: Dict[str, Any] = field(default_factory=dict)
    env: Dict[str, str] = field(default_factory=dict)

    # Callback credentials injected by the executor (N23/N27). All optional:
    # older executors never inject them, in which case `ctx.callback` (and
    # the `ctx.report_success` / `ctx.report_failure` shorthands) stay
    # disabled and raise a descriptive error when used.
    # N40 (round-10): repr=False — the dataclass __repr__ is a leak surface
    # the same as to_dict (N27): a task's `print(ctx)` / f-string debug log
    # would otherwise carry the one-shot HMAC token into the executor's
    # captured stdout → admin DB (execution logs), where any JWT user who
    # can read the execution could replay it within its TTL window.
    callback_token: Optional[str] = field(default=None, repr=False)
    admin_api_url: Optional[str] = field(default=None, repr=False)
    executor_address: Optional[str] = field(default=None, repr=False)
    # ADR-017 阶段 3 (protocol v6): stable install identity of the executor
    # row. repr=False for parity with the fields above — non-secret, but
    # still routing plumbing that has no place in a debug repr.
    device_fingerprint: Optional[str] = field(default=None, repr=False)

    # Runtime helpers — populated lazily
    _logger: Optional[Any] = field(default=None, repr=False)
    _callback_client: Optional[CallbackClient] = field(default=None, repr=False)

    def get_param(self, key: str, default: Any = None) -> Any:
        """Retrieve a task parameter by key (case-insensitive, SDK-DX-09).

        与 node SDK 的 `ctx.getParam()` 对齐：两侧都按大小写不敏感匹配。
        为什么需要：执行器过去把逐键参数写成 `AUTOFLOW_<KEY 大写>`，任务代码
        习惯写 `get_param("limit")` 去读配置成 `LIMIT` 的参数；node 侧一直
        不敏感，python 侧敏感——同一份任务代码跨语言移植会**静默拿到 None**。
        精确命中优先；否则按大写比较取第一个匹配。
        """
        if not isinstance(key, str):
            return default
        if key in self.params:
            return self.params[key]
        upper = key.upper()
        for k, v in self.params.items():
            if isinstance(k, str) and k.upper() == upper:
                return v
        return default

    def get_env(self, key: str, default: str = "") -> str:
        """Retrieve an environment variable (task env first, then OS env)."""
        return self.env.get(key, os.environ.get(key, default))

    @property
    def log(self):
        if self._logger is None:
            from .logger import get_logger
            object.__setattr__(self, "_logger", get_logger(self.task_name))
        return self._logger

    @property
    def callback(self) -> CallbackClient:
        """Per-execution Admin API callback client (N23/N27 parity).

        Lazily built from the injected credentials; check
        ``ctx.callback.enabled`` before reporting (older executors do not
        inject the credentials). See :class:`autoflow_sdk.callback.CallbackClient`.
        """
        if self._callback_client is None:
            object.__setattr__(
                self,
                "_callback_client",
                CallbackClient(
                    admin_api_url=self.admin_api_url,
                    token=self.callback_token,
                    executor_address=self.executor_address,
                    execution_id=self.execution_id,
                    device_fingerprint=self.device_fingerprint,
                ),
            )
        return self._callback_client

    def report_success(self, summary: Optional[str] = None, duration_ms: Optional[int] = None) -> Any:
        """Report this execution's success to the Admin API.

        Shorthand for ``ctx.callback.report_success(...)``; raises
        ``CallbackDisabledError`` when callback credentials are absent.
        """
        return self.callback.report_success(summary=summary, duration_ms=duration_ms)

    def report_failure(
        self,
        error: Any,
        summary: Optional[str] = None,
        duration_ms: Optional[int] = None,
        failure_reason: str = "script_error",
    ) -> Any:
        """Report this execution's failure to the Admin API.

        ``error`` is mapped to the callback item's ``errorMessage`` and
        ``failure_reason`` (default ``script_error``) to its structured
        ``failureReason``. Raises ``CallbackDisabledError`` when callback
        credentials are absent.
        """
        return self.callback.report_failure(
            error, summary=summary, duration_ms=duration_ms, failure_reason=failure_reason
        )

    @classmethod
    def from_env(cls) -> "TaskContext":
        """
        Create TaskContext from environment variables injected by the executor.

        Reads EXECUTION_ID, TASK_ID, TASK_NAME, and all AUTOFLOW_* vars as
        params — except the callback credential / routing keys
        (``AUTOFLOW_CALLBACK_TOKEN``, ``AUTOFLOW_ADMIN_API_URL``,
        ``AUTOFLOW_EXECUTOR_ADDRESS``, ``AUTOFLOW_DEVICE_FINGERPRINT``),
        which are exposed as dedicated fields and never leak into ``params``.

        **Param types (A-11R).** Since executor protocol v5 both executors
        inject ``AUTOFLOW_PARAMS_JSON`` — the whole params object as one JSON
        document — and this method prefers it, so ``ctx.params`` carries the
        task's *real* types (``True`` stays a bool, ``3`` stays an int, nested
        dicts/lists stay structured) instead of everything being a string.

        On older executors that variable is absent and the method falls back
        to the per-key ``AUTOFLOW_<KEY>`` variables. Those are always strings:
        the executor injects strings bare (``AUTOFLOW_REGION=欧盟``) and
        non-strings as JSON (``AUTOFLOW_DRY_RUN=true``). The fallback
        therefore parses each value as JSON **when it cleanly parses** and
        otherwise keeps the raw string — a bare ``欧盟``, ``3`` or ``true``
        typed by a user as a *string* must not silently become a number or a
        boolean. Note this is best-effort by nature; code that needs
        guaranteed types on an old executor should read the env var directly
        or pin the executor version.

        Usage::

            from autoflow_sdk import TaskContext

            ctx = TaskContext.from_env()
            ctx.log.info(f"Task {ctx.task_id} started")
            date = ctx.get_param("date")
        """
        params: dict[str, Any] = {}
        callback_fields: dict[str, str] = {}

        # Prefer the typed channel: it is the only lossless source.
        typed = _load_typed_params(os.environ.get(_PARAMS_JSON_ENV_KEY))
        if typed is not None:
            params.update(typed)

        for k, v in os.environ.items():
            if not k.startswith("AUTOFLOW_") or not v:
                continue
            if k in _CALLBACK_ENV_KEYS:
                callback_fields[_CALLBACK_ENV_KEYS[k]] = v
                continue
            if k in _NON_PARAM_ENV_KEYS:
                continue
            key = k[len("AUTOFLOW_"):].lower()
            if typed is not None:
                # Typed channel already supplied this param with a real type;
                # the per-key copy is the same value rendered as a string and
                # must not overwrite it. (Vacuous today because executors
                # uppercase keys, but it keeps the invariant true if that ever
                # changes — silently downgrading a bool to "true" is exactly
                # the class of bug this channel exists to remove.)
                if key in params:
                    continue
            params[key] = _coerce_param(v)

        return cls(
            task_id=os.environ.get("TASK_ID", "unknown"),
            execution_id=os.environ.get("EXECUTION_ID", "unknown"),
            task_name=os.environ.get("TASK_NAME", "unknown"),
            params=params,
            **callback_fields,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "execution_id": self.execution_id,
            "task_name": self.task_name,
            "params": self.params,
        }
