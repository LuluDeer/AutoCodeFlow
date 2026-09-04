from setuptools import setup

# 元数据（name/version/dependencies/...）统一维护在 pyproject.toml，
# 此处不再重复声明，避免与 pyproject 漂移（历史 bug：本文件曾写
# name="autocodeflow-sdk"，与 pyproject 的 "autoflow-sdk" 不一致）。
# 发布版本由 .github/workflows/release.yml 的版本一致性守卫校验，
# 必须与 git tag（vX.Y.Z）一致。
setup()
