# registry-pypi — 自建 PyPI 私服
> 所属: docs/atlas/01-apps/registry-pypi · 最后核对: 2026-09-13 · 对应代码: apps/registry-pypi/main.py、apps/registry-pypi/Dockerfile

## 一句话定位

自研的 **FastAPI 单文件 PyPI 私服**（约 440 行 `main.py`）：实现 PEP 503 simple 索引 + twine 兼容上传 + 文件下载，Basic 认证单用户；executor-python 的 uv 与管理台的包管理页都以此为包源。

## 技术栈与部署

| 项 | 值 | 出处 |
|---|---|---|
| 框架 | fastapi 0.136.3 + uvicorn[standard] 0.48.0 + python-multipart 0.0.32 | requirements.txt |
| 运行 | `uvicorn main:app --host 0.0.0.0 --port 8003` | Dockerfile CMD |
| 基础镜像 | `python:3.12-slim` | Dockerfile |
| 存储 | `PACKAGES_DIR` env（缺省 `<repo>/apps/registry-pypi/packages`；容器内 `VOLUME /data/packages`） | main.py |
| 凭据 | `REGISTRY_USER` / `REGISTRY_PASS`（缺省 `autoflow`/`autoflow123`，启动时打 stderr 告警不退出） | main.py |
| compose | 服务名 `registry-pypi`，端口默认 `127.0.0.1:8003:8003`（loopback-only，executor 走内网服务名） | docker-compose.yml |
| 测试 | `pytest`（tests/test_registry.py，TestClient + 每用例隔离 PACKAGES_DIR） | requirements-dev.txt |

## 路由清单（main.py 核实）

| 方法与路径 | 认证 | 功能 |
|---|---|---|
| `GET /health` | 免认证 | 存活探针 `{"status":"ok","service":"pypi-registry"}` |
| `GET /` | Basic | 人类可读落地页（包名列表 + pip 用法示例，FEAT-12） |
| `GET /simple/` | Basic | PEP 503 根索引（pip 消费入口；锚点 href/文本均 escape） |
| `GET /simple/{package_name}/` | Basic | PEP 503 包级索引：按版本排序的 `<a href="/packages/<norm>/<file>#sha256=<hex>">` 锚点，sha256 来自上传时 sidecar（N18） |
| `GET /packages/{package_name}/{filename}` | Basic | 文件下载（S9：`Path(filename).name` 剥目录分量防穿越） |
| `POST /` | Basic | twine 兼容上传（multipart：`content` + `name` + `version`） |
| `POST /upload` | Basic | 上传别名端点（行为同上） |

注意：**索引与下载也要求 Basic 认证**（S9），未认证客户端既不能枚举也不能下载私有包。

## 鉴权（verify_auth）

- HTTP Basic；用户名/密码与 `REGISTRY_USER`/`REGISTRY_PASS` 用 `secrets.compare_digest` 常量时间比对；畸形 Authorization 头统一返回 `401 + WWW-Authenticate: Basic`。
- 单用户模型：没有角色/多租户；轮换凭据 = 改 env 重启。S9 边界由测试 `TestAuth` 固化。

## 使用方式

```bash
# 上传（twine / curl 均可，走 POST /）
twine upload --repository-url http://<host>:8003/ dist/*

# 安装（executor-python 内部即 uv pip install --index-url <URL>）
pip install --index-url http://<host>:8003/simple/ <package>
```

compose 默认注入：executor-python `PYPI_REGISTRY_URL=http://registry-pypi:8003/simple/`；executor-node `PYTHON_REGISTRY_URL` 同值（其 pip 面仅用于应用部署）。

## 与其他组件的关系

- **被 executor-python 依赖**：uv 安装任务依赖（`ensure_venv()` 传 `--index-url`，URL 禁止携带 userinfo/query/fragment——凭据必须走受控机制而非 URL，见 config.py 校验器）。
- **被 admin-api registry 模块依赖**：管理台"PyPI 包管理"页面经 `GET /api/registry/pypi/packages`（列表）与 `POST /api/registry/pypi/upload`（50MB FileInterceptor 上限，S4）代理访问本服务；admin-api 解析索引时只取锚点文本（`parsePypiIndex`），故附加 span 不破坏兼容。
- **预置示例包**：`packages/autoflow-sdk/`、`packages/acfdemopkg/`（`autoflow_sdk-0.1.0` 等 wheel，供任务 requirements 演示）。

## 常见改动场景

- **多用户/更细权限**：`verify_auth` 是唯一鉴权点，替换为 token/多用户表即可全局生效；改完跑 `pytest tests/test_registry.py`。
- **放开匿名下载**：去掉对应路由的 `Depends(verify_auth)`——需同时评审 S9 决策注释与 admin 代理的行为。
- **调上传上限**：`MAX_UPLOAD_BYTES = 50MB` 刻意与 admin-api 代理 multer 上限对齐（S10），单侧调大无意义，需两侧同步。
- **索引页样式**：`_PAGE_STYLE` 内联 CSS（零外部资源，离线部署约束 FEAT-12）；注意保持 PEP 503 锚点结构不变。
- **新包发布流程**：本地 `python -m build` 出 wheel → `twine upload --repository-url http://<host>:8003/ dist/*`（Basic 用 `REGISTRY_USER/PASS`）→ 索引 `no-cache` 立即可见 → 任务 `requirements` 引用。

## 已知边界

- **单用户 Basic 认证**：无角色/多租户/审计；凭据轮换 = 改 env 重启容器（上传中的请求会 401 一次）。
- **无删除/下线 API**：撤包只能进容器/卷删文件后重启（或直接删，索引实时扫描会立即反映）。
- **版本号取自文件名**：上传表单的 `version` 字段仅回显用，索引排序以文件名解析结果为准（见 [internals](internals.md)）。

## 健康检查与本地开发

- 健康端点：`GET /health`（免认证）→ `{"status":"ok","service":"pypi-registry"}`；compose 侧服务名 `registry-pypi`。
- 本地开发：`pip install -r requirements.txt && uvicorn main:app --port 8003`（`PACKAGES_DIR` 不设时用仓库内 `apps/registry-pypi/packages`，缺省凭据会打 stderr 告警）。
- 数据备份：备份 `PACKAGES_DIR` 目录即可（wheel 与 `.sha256` sidecar 同目录存放，无数据库）。
- 常见故障：
  - **pip/uv 安装 401** → 索引与下载也要求 Basic（S9），客户端需带 `REGISTRY_USER/PASS` 或改部署姿态；
  - **上传 413** → 超 50MB 上限（S10，与 admin-api 代理对齐）；
  - **上传 409** → 同名文件已存在且 sha256 不同（禁止覆盖已发布包）。

## 相关文档

- [registry-pypi 内部实现](internals.md) —— 存储布局 / 原子上传 / 与 uv 白名单的配合
- [Verdaccio 私服](../registry-npm.md)（对照：npm 生态为何不自研）
- [executor-python](../executor-python/README.md) —— 消费方与 uv 安装管线
- [admin-api registry 模块](../admin-api/modules/registry.md) —— 管理台代理面
