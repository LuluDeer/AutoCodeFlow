"""Task execution result contract."""
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass
class TaskResult:
    """Standardized return value for task handlers."""

    success: bool
    message: str = ""
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    exit_code: int = 0

    @classmethod
    def ok(cls, message: str = "OK", data: Optional[Dict[str, Any]] = None) -> "TaskResult":
        return cls(success=True, message=message, data=data)

    @classmethod
    def fail(cls, error: str, exit_code: int = 1) -> "TaskResult":
        return cls(success=False, error=error, exit_code=exit_code)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "message": self.message,
            "data": self.data,
            "error": self.error,
            "exit_code": self.exit_code,
        }
