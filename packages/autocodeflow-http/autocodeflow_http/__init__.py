"""AutoCodeFlow HTTP client library with retry, auth, and circuit breaker."""
from .client import (
    ApiHttpStatusError,
    AutoFlowHttpClient,
    CircuitBreaker,
    CircuitBreakerOpenError,
    DEFAULT_MAX_RESPONSE_BYTES,
    ResponseTooLargeError,
    RetryConfig,
    SAFE_METHODS,
)

__version__ = "0.3.1"  # x-release-please-version
__all__ = [
    "ApiHttpStatusError",
    "AutoFlowHttpClient",
    "CircuitBreaker",
    "CircuitBreakerOpenError",
    "DEFAULT_MAX_RESPONSE_BYTES",
    "ResponseTooLargeError",
    "RetryConfig",
    "SAFE_METHODS",
]
