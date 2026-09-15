# AutoFlow 私有 PyPI Registry

轻量 PEP 503 兼容私有 PyPI 服务，供执行器安装私有依赖包。

## 服务定位

- **协议**：兼容 `pip install --index-url http://host:8003/simple/`
- **功能**：包上传（twine upload）、简单索引（PEP 503 `/simple/`）、包下载、基本认证
- **运行形态**：容器镜像（`docker-compose.yml` 中 `registry-pypi` 服务，端口 8003）
- **与 admin-api 的关系**：admin-api 代理上传路由（`/api/registry/`），admin-web 经 nginx 同源或 admin-api 代理访问，不直连

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `REGISTRY_USER` | `autoflow` | 基本认证用户名 |
| `REGISTRY_PASS` | （空） | 基本认证密码。**空值时拒绝启动**（E-10 fail-closed） |
| `PACKAGES_DIR` | `./packages` | 包存储目录 |
| `REGISTRY_CORS_ORIGINS` | （空） | CORS 白名单（逗号分隔），未配置不挂 CORS 中间件 |

## 安全基线

- **E-10**：弱口令/空密码 fail-closed（拒绝启动）
- **E-09**：容器以非 root 用户运行
- **E-39**：CORS 收紧为显式白名单（非 `*`）
- **A7**：上传面收敛——仅认证用户可写

## 开发

```bash
# 启动（需先设置 REGISTRY_PASS）
REGISTRY_PASS=your-secret python main.py

# 上传包
twine upload --repository-url http://localhost:8003/ dist/*

# 安装包
pip install --index-url http://autoflow:your-secret@localhost:8003/simple/ your-package
```

## 测试

```bash
cd apps/registry-pypi && python -m pytest -q
```