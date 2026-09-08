# 教程 02 · 私服依赖

> 目标：任务脚本 `import` 一个只存在于**私有包仓库**的依赖，由执行器在
> 任务执行前自动安装。全程不修改执行器镜像。
> 前提：已完成[教程 01](./01-first-scheduled-task)，平台全栈在线。

## 0. 原理一图流

```
admin 下发任务(requirements)
  → executor-python 建 per-task venv
  → uv pip install --index-url <PYPI_REGISTRY_URL> <requirements>
  → 任务代码 import 私有包
```

（node 侧等价链路：executor-node 在任务隔离目录生成 `.npmrc` 后
`npm install --prefix <隔离目录>`，`NODE_PATH` 指向隔离目录。）

关键事实（源码证据见
[examples/private-registry-deps](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/examples/private-registry-deps/README.md)）：

- 任务表单的 **requirements** 字段仅对 **entrypoint（打包）任务**生效，
  glue 脚本任务忽略；
- python 侧 requirements 只能写**包规格**（`name` / `name>=1.0`），以 `-`
  开头的 option 形条目（如 `--index-url`）会被 `_validate_requirements()`
  拒绝——防止任务作者劫持包索引；
- 执行器侧 `PYPI_REGISTRY_URL` / `NPM_REGISTRY_URL` 未配置时走公共源。

## 1. 启动内置私服

平台自带两个私服服务（`apps/registry-pypi` 自研 FastAPI、
`apps/registry-npm` Verdaccio），已在 `docker-compose.yml` 定义：

```bash
# PyPI 私服（宿主 127.0.0.1:8003）
docker compose up -d registry-pypi
curl http://localhost:8003/health          # 期望 200

# npm 私服（宿主 127.0.0.1:4873，Verdaccio）
docker compose up -d registry-npm
curl http://localhost:4873/-/ping          # 期望 200 + {}
```

凭据来自 `.env`（见 `.env.example`）：

| 变量 | 缺省 | 用途 |
|------|------|------|
| `REGISTRY_USER` / `REGISTRY_PASS` | `admin` / `change_me` | registry-pypi 的 Basic Auth（简单索引 `/simple/` 也要求鉴权，S9） |
| `PYPI_API_KEY` | 空 | 预留 |
| `NPM_REGISTRY_USER` / `NPM_REGISTRY_PASS` | 空 | verdaccio 用户 |

> 端口仅绑定 `127.0.0.1`：执行器走 compose 内部网络（`http://registry-pypi:8003`
> / `http://registry-npm:4873`），宿主机发布包用回环地址。对外发布需自行
> 显式覆盖端口映射（部署加固见[部署指南](../deployment.md)）。

## 2. 准备 executor-python 的私服地址

compose 已为 executor-python 注入
`PYPI_REGISTRY_URL=${PYPI_REGISTRY_URL:-http://registry-pypi:8003/simple/}`，
executor-node 注入
`NPM_REGISTRY_URL=${NPM_REGISTRY_URL:-http://registry-npm:4873}`——
默认值即指向内置私服，**无需额外配置**。

若你的执行器是独立部署（非 compose），在执行器 `.env` 里配：

```bash
# executor-python
PYPI_REGISTRY_URL=http://<registry-host>:8003/simple/

# executor-node（私服 access=$authenticated 时必配 token）
NPM_REGISTRY_URL=http://<registry-host>:4873
NPM_REGISTRY_TOKEN=<verdaccio-token>
```

改完重启执行器进程生效。

## 3. 往私服发一个测试包

### PyPI 侧（twine 兼容上传端点 `POST /`）

```bash
# 用任意一个现成的 wheel 演示；生产请替换为你们真实的私有包
pip download --no-deps --dest /tmp/pkgs six
twine upload --repository-url http://localhost:8003/ \
  -u admin -p change_me /tmp/pkgs/six-*.whl
```

预期输出 `200`；打开 `http://localhost:8003/simple/`（Basic Auth 登录）
应能看到 `six`。

### npm 侧（Verdaccio）

```bash
npm adduser --registry http://localhost:4873/   # 首次创建用户
cd <你的包目录>
npm publish --registry http://localhost:4873/
```

## 4. 建一个引用私服依赖的任务

1. 新建任务（参照[教程 01](./01-first-scheduled-task)），脚本类型
   **Python**，执行方式选 **entrypoint（打包任务）**——requirements 只对
   这类任务生效；
2. entrypoint 可直接用官方示例脚本
   `examples/private-registry-deps/private_dep_task.py`（读取
   `pkg_name` 参数并 import 后打印 `source=private-package`）；
3. **任务依赖（requirements）** 填：

   ```text
   six
   autoflow-sdk
   ```

4. 保存 → 「立即执行」。

**预期结果**：执行日志先出现 `Installing N packages into <venv>`
（安装阶段），随后任务成功、输出含 `source=private-package`——
包来自私服而非公共 PyPI，链路打通。

node 版等价实验：entrypoint 用
`examples/private-registry-deps-node/private_dep_task.js`，
requirements 填你的私有 npm 包名，完整说明见
[examples/private-registry-deps-node/README.md](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/examples/private-registry-deps-node/README.md)。

## 5. 常见坑

| 现象 | 原因与解法 |
|------|-----------|
| 安装 401 | registry-pypi 简单索引与上传都要求 Basic Auth（S9）；确认 `REGISTRY_PASS` 与执行器侧 `PYPI_REGISTRY_URL` 可达。npm 侧 access=`$authenticated`，匿名安装必 401，需 `NPM_REGISTRY_TOKEN` |
| requirements 填了 `--index-url …` 被拒 | 设计如此（防索引劫持）；索引由执行器侧 env 统一指定，requirements 只写包规格 |
| glue 脚本任务没走安装 | requirements 仅对 entrypoint（打包）任务生效 |
| 自己的 npm scope 装不到 | `.npmrc` 的 scope 行只覆盖 `@autoflow`/`@autocodeflow` 两个平台 scope；自有 scope 依赖私服回源兜底，或让 `NPM_REGISTRY_URL` 指向能解析该 scope 的私服 |
| 私服里有包但版本不对 | registry-pypi 同名同版本重复上传幂等返回（twine 重试安全）；确认任务 requirements 里的版本约束 |

## 6. 下一步

依赖问题解决后，任务量大了单执行器扛不住？→
[教程 03 · 多执行器扩容](./03-multi-executor-scaling)。
