"""registry-pypi 测试的路径前置（R90-A1）。

仓库根的 pytest.ini 用 --import-mode=importlib，**不会**把被测目录塞进
sys.path，所以 `import main`（tests/test_registry.py 的 client fixture 依赖它）
只有在 cwd == apps/registry-pypi 时才成立；从仓库根跑
`python -m pytest apps/registry-pypi/tests` 会在 fixture 阶段
ModuleNotFoundError（基线即如此，非本轮引入）。

这里把被测目录显式前置，让文档里的两条命令（仓库根 / cd 进该目录）等价。
只影响 pytest 进程的 sys.path，不改变被测代码的任何行为。
"""
import sys
from pathlib import Path

_APP_DIR = str(Path(__file__).resolve().parents[1])
if _APP_DIR not in sys.path:
    sys.path.insert(0, _APP_DIR)
