# 教程 02 · 私服依赖

> 重组自 [docs/tutorials/02-private-registry-deps.md](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/docs/tutorials/02-private-registry-deps.md)（DOC-06）。
> 目标：任务脚本 `import` 一个只存在于**私有包仓库**的依赖，由执行器在
> 任务执行前自动安装，全程不改执行器镜像。

## 0. 原理

```
admin 下发任务(requirements)
  → executor-python 建 per-task venv
  → uv pip install --index-url <PYPI_REGISTRY_URL> <requirements>
  → 任务代码 import 私有包
```

（node 侧等价：任务隔离目录生成 `.npmrc` 后 `npm install --prefix`。）

关键事实（源码证据见
[examples/private-registry-deps](https://github.com/LuluDeer/AutoCodeFlow/blob/develop/examples/private-registry-deps/README.md)）：

- **requirements 仅对 entrypoint（打包）任务**生效，glue 脚本任务忽略；
- requirements 只能写**包规格**（`name` / `name>=1.0`），以 `-` 开头的
  option 形条目会被拒绝（防任务作者劫持包索引）；
- 执行器侧 `PYPI_REGISTRY_URL` / `NPM_REGISTRY_URL` 未配置时走公共源。

## 1. 启动内置私服

```bash
# PyPI 私服（宿主 127.0.0.1:8003）
docker compose up -d registry-pypi
curl http://localhost:8003/health          # 期望 200

# npm 私服（宿主 127.0.0.1:4873，Verdaccio）
docker compose up -d registry-npm
curl http://localhost:4873/-/ping          # 期望 200 + {}
```

凭据来自 `.env`：`REGISTRY_USER`/`REGISTRY_PASS`（registry-pypi Basic
Auth，缺省 `admin`/`change_me`）、`NPM_REGISTRY_USER`/`NPM_REGISTRY_PASS`。

> 端口仅绑定 `127.0.0.1`；执行器走 compose 内部网络服务名
> （`http://registry-pypi:8003/simple/`、`http://registry-npm:4873`）。

## 2. 执行器侧私服地址

compose 已为两个执行器注入默认值指向内置私服，**无需额外配置**。
独立部署的执行器在 `.env` 配：

```bash
# executor-python
PYPI_REGISTRY_URL=http://<registry-host>:8003/simple/

# executor-node（私服 access=$authenticated 时必配 token）
NPM_REGISTRY_URL=http://<registry-host>:4873
NPM_REGISTRY_TOKEN=<verdaccio-token>
```

## 3. 往私服发一个测试包

### PyPI 侧（twine 兼容上传端点 `POST /`）

```bash
pip download --no-deps --dest /tmp/pkgs six
twine upload --repository-url http://localhost:8003/ \
  -u admin -p change_me /tmp/pkgs/six-*.whl
```

预期 `200`；`http://localhost:8003/simple/`（Basic Auth）能看到 `six`。

### npm 侧（Verdaccio）

```bash
npm adduser --registry http://localhost:4873/   # 首次创建用户
cd <你的包目录>
npm publish --registry http://localhost:4873/
```

## 4. 建一个引用私服依赖的任务

1. 新建 **Python entrypoint（打包）任务**，entrypoint 可直接用
   `examples/private-registry-deps/private_dep_task.py`；
2. **任务依赖（requirements）** 填：

   ```text
   six
   autoflow-sdk
   ```

3. 保存 → 「立即执行」。

**预期结果**：日志先出现 `Installing N packages into <venv>`，任务成功且
输出含 `source=private-package`——链路打通。node 版等价实验用
`examples/private-registry-deps-node/`。

## 5. 常见坑

| 现象 | 原因与解法 |
|------|-----------|
| 安装 401 | registry-pypi 索引与上传都要求 Basic Auth（S9）；npm 侧匿名安装必 401，需 `NPM_REGISTRY_TOKEN` |
| requirements 填 `--index-url` 被拒 | 设计如此（防索引劫持）；索引由执行器侧 env 统一指定 |
| glue 任务没走安装 | requirements 仅对 entrypoint 任务生效 |
| 自有 npm scope 装不到 | `.npmrc` scope 行只覆盖 `@autoflow`/`@autocodeflow`；自有 scope 依赖私服回源兜底 |

## 6. 下一步

[教程 03 · 多执行器扩容](./tutorial-03-multi-executor-scaling)。
