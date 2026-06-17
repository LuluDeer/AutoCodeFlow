"""Structured logger for AutoCodeFlow tasks."""
import logging
import sys


def get_logger(name: str = "autocodeflow") -> logging.Logger:
    """Return a logger with a consistent format."""
    logger = logging.getLogger(f"autocodeflow.{name}")
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        fmt = logging.Formatter(
            "%(asctime)s [%(levelname)s] %(name)s - %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
        handler.setFormatter(fmt)
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
    return logger
