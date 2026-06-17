"""Tests for autoflow_sdk.logger.get_logger."""
import logging
import pytest
from autoflow_sdk.logger import get_logger


class TestGetLogger:
    def test_returns_logger_instance(self):
        logger = get_logger("test_component")
        assert isinstance(logger, logging.Logger)

    def test_logger_name_prefixed(self):
        logger = get_logger("myname")
        assert logger.name == "autocodeflow.myname"

    def test_default_name(self):
        logger = get_logger()
        assert logger.name == "autocodeflow.autocodeflow"

    def test_logger_has_handlers(self):
        logger = get_logger("handler_check")
        assert len(logger.handlers) >= 1

    def test_logger_level_is_debug(self):
        logger = get_logger("level_check")
        assert logger.level == logging.DEBUG

    def test_same_name_returns_same_logger(self):
        a = get_logger("same")
        b = get_logger("same")
        assert a is b

    def test_has_info_method(self):
        logger = get_logger("methods")
        assert callable(logger.info)
        assert callable(logger.debug)
        assert callable(logger.error)
        assert callable(logger.warning)
