"""executor-python 的**内部**共享库。

分层纪律（仓内既有范式，见
``apps/executor-python/tests/test_interpreters.py`` 的
``test_module_never_imports_routers_execute``）：``lib/`` **不得** import
``routers/`` —— 底层库不认识上层路由，反向依赖会让「库可独立测试」这条性质
失效（测试必须先起一整个 FastAPI 应用才能碰锁）。

本包只依赖标准库（D-6：executor-python 不允许新增 PyPI 依赖）。
"""

__all__ = ['file_lock']
