"""AutoCodeFlow HTTP client library with retry, auth, and circuit breaker."""
from .client import AutoFlowHttpClient, CircuitBreaker, RetryConfig, SAFE_METHODS

__version__ = "0.1.0"
__all__ = ["AutoFlowHttpClient", "CircuitBreaker", "RetryConfig", "SAFE_METHODS"]