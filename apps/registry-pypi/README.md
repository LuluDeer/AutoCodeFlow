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

- **E-10**：弱口令/空密码/非 ASCII 凭据 fail-closed（拒绝启动）
- **E-09**：容器以非 root 用户运行
- **E-39**：CORS 收紧为显式白名单（非 `*`）
- **A7**：上传面收敛——仅认证用户可写
- **P1-1（2026-10-26）**：上传路由（`POST /` 与 `/upload`）在认证/读 body 之前
  预检 Content-Length——缺失（chunked）411、超限（> 50 MiB + 64 KiB 余量）413，
  不把无界请求体收进 /tmp tmpfs；twine/pip/admin-api 代理恒带 Content-Length
  （代理侧已同步显式设置，见 `apps/admin-api` registry.controller.ts）。
  compose 侧 tmpfs `/tmp` 另有 `size=1g` 兜底。根治方案（handler 自读
  request.stream() 的 raw-body 流式上传）已登记未实施（main.py B-6/P1-1 注释）。
- **P2-1/P2-2（2026-10-26）**：上传/删除/下载三面都落审计行
  （`registry.pypi.upload` / `.delete` / `.download`，一行一条 JSON 到
  stderr）——直连 8003 的 twine/pip 流量不再只靠 admin-api 侧留痕。
- **P2-3（2026-10-26）**：Basic 凭据防爆破——同一对端 IP 连续失败 5 次后按
  2^n 秒拒答（429 + Retry-After，封顶 300s），成功认证清零。**残余风险**：
  计数是进程内存态，多 worker/多副本部署不共享；同一 NAT 出口后的多用户会
  互相连坐（任何一次成功登录即清零，部分缓解）。中期方向：per-identity
  token（每个调用方独立凭据，可单独吊销/限速），共享 Basic 口令只作过渡。
- **P2-4（2026-10-26）**：sha256 sidecar 与制品同为「包目录内 tmp → os.link
  原子到位」，sidecar 落位失败即回滚刚发布的制品——保证「500 必然未发布」。

## 故障恢复（P2-4）

sidecar 落位失败（磁盘写满/权限）时服务会自动 unlink 刚发布的制品再返回
500（`storage_error` 审计留痕），不需要人工恢复。两个极小概率的残留形态：

1. **回滚 unlink 本身也失败**：制品存在但无 sidecar——下次索引访问时
   `artifact_sha256` 懒回填补上正确哈希，一致性自愈；
2. **包目录残留 `.upload` 临时文件**（进程被 kill -9 等）：服务启动时与
   上传路径会自动清扫 mtime 超过 24h 的残留（P3-1），无需人工干预。

若 `/data` 卷真的写满：清理空间后重传即可，409/幂等语义保证不会出现半个包。

## 开发

```bash
# 启动（需先设置 REGISTRY_PASS；生产形态见 docker-compose.yml 的 registry-pypi 服务）
REGISTRY_PASS=your-secret uvicorn main:app --host 127.0.0.1 --port 8003

# 上传包
twine upload --repository-url http://localhost:8003/ -u autoflow -p your-secret dist/*

# 安装包
# ⚠️ 索引/下载面 S9 起要求 Basic 认证——URL 内嵌凭据（user:pass@host）只适用于
# 一次性手动命令；执行器侧 PYPI_REGISTRY_URL 必须无凭据（见 .env.example
# 与 docs/tutorials/02-private-registry-deps.md「常见坑」）。
pip install --index-url http://autoflow:your-secret@localhost:8003/simple/ your-package
```

## 测试

```bash
cd apps/registry-pypi && python -m pytest -q
```