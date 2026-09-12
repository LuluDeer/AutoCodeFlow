# registry-pypi 内部实现
> 所属: docs/atlas/01-apps/registry-pypi · 最后核对: 2026-09-13 · 对应代码: apps/registry-pypi/main.py

## 存储布局

```
$PACKAGES_DIR/                        ← env 可配（缺省 apps/registry-pypi/packages，容器内 /data/packages）
├── autoflow-sdk/                     ← 目录名 = PEP 503 归一化包名（normalize()）
│   ├── autoflow_sdk-0.1.0-py3-none-any.whl
│   └── autoflow_sdk-0.1.0-py3-none-any.whl.sha256   ← N18 sidecar：上传时算一次的哈希
├── acfdemopkg/
│   └── acfdemopkg-0.1.0-py3-none-any.whl(.sha256)
└── <pkg>/xxx.upload                  ← 上传中的临时文件（mkstemp 同目录），永不进索引
```

- `normalize(name)`：`re.sub(r"[-_.]+", "-", name).lower()`（PEP 503），`pkg_dir()` 据此定位目录、不存在即创建。
- `is_meta_file()`：`.sha256` 与 `.upload` 后缀文件在根/包级索引与文件计数中恒被排除。
- 版本从**文件名**解析（`_version_from_filename()`）：wheel 取 `{dist}-{version}-…` 第 2 段；sdist 剥 `.tar.gz/.zip/.tar.bz2` 后取最后一个 `-` 段；解析失败显示 `-`。版本排序键 `_version_sort_key()` 对混合 int/str 段打标签，避免 `sorted()` TypeError（曾致索引页 500）。

## 上传管线（POST / 与 POST /upload 共用 `upload_package`）

```
multipart(content, name, version) → verify_auth
  ├─ 文件名：Path(filename).name 剥目录分量（N14）；后缀白名单 .whl/.tar.gz/.zip（忽略大小写）
  ├─ mkstemp(dir=包目录, suffix='.upload') 流式写入 + 同遍历算 sha256（1MiB 块，内存 O(chunk)）
  │    └─ 累计 > MAX_UPLOAD_BYTES(50MB) → 413（S10，与 admin-api 代理 multer 50MB 对齐）
  ├─ os.link(tmp, dest) 原子占位（N30，R8）
  │    ├─ FileExistsError → 比对 sidecar 哈希：
  │    │     相同 → 200 {"unchanged": true}   （twine 重试/CI 双跑幂等）
  │    │     不同 → 409 "already exists with a different sha256"（禁止覆盖已发布包）
  │    └─ 成功 → 写 <dest>.sha256 sidecar
  └─ finally: tmp.unlink(missing_ok=True)
```

- `artifact_sha256()`：读 sidecar（校验 64 位十六进制），缺失时流式现算并回填 sidecar——旧文件无需迁移即可获得 `#sha256=` 锚点。
- 索引页统一 `Cache-Control: no-cache`：CI 上传后 pip 必须立即可见（陈旧索引会让 pip 解析不到刚推的版本；页面 KB 级，回源代价可忽略）。

## 索引渲染（PEP 503 兼容性约束）

- 根索引 `/simple/` 与包索引 `/simple/<name>/` 的 HTML 中 **pip 与 admin-api `parsePypiIndex` 都只解析 `<a>` 锚点**；计数/版本/体积等附加信息均放在纯文本与 `<span class="muted">` 中，锚点 `href="/packages/<norm>/<file>#sha256=<hex>"` 语义不变。
- 包名/文件名/版本来自上传方，`normalize()` 不剥离 `<>&'"`——所有用户可控值经 `html.escape(..., quote=True)` 后进 href 与文本（`_render_*` 系列函数的注释约定）。
- 页面外壳 `_page()` + `_PAGE_STYLE`：内联 CSS、零 CDN/字体/JS，服务离线部署可用（FEAT-12）。

## 与 uv/pip 白名单的配合

registry-pypi 是**无凭据 URL** 的被动服务端；主动侧的约束在 executor-python（详见 [executor-python](../executor-python/README.md)）：

1. `PYPI_REGISTRY_URL` 在 config.py 与 execute.py 双重校验：仅 http(s)、必须有 netloc、**禁止 userinfo / query / fragment**——凭据不允许进 argv（会出现在 `/proc` 与日志），未来凭据走受控机制（如挂载 uv keyring/config）。
2. uv 子进程环境经 `_build_install_env()` 最小化：仅平台路径/home/temp 白名单 + `UV_CACHE_DIR`（指向 `.venvs/.uv-cache`）+ `UV_NO_CONFIG=1` + `PIP_CONFIG_FILE=/dev/null`——宿主的 `PIP_*`/`UV_*` 配置与用户 .pip 配置文件无法劫持包下载。
3. 安装环境 denylist 显式剔除 `PIP_INDEX_URL`、`UV_INDEX`、`UV_EXTRA_INDEX_URL`、`UV_DEFAULT_INDEX`、`UV_CONFIG_FILE` 等（`_INSTALL_ENV_DENYLIST`）——私服选择只能来自 executor 显式传入的 `--index-url`，注入面收敛为单一参数。
4. 执行器侧对私服**匿名访问**：registry-pypi 的 Basic 用户是"上传者/管理台"身份；executor 侧若无凭据需求，可在部署时把索引账号配成只读用途（当前单用户模型下即共用同一对 env）。

## 测试（tests/test_registry.py 摘要）

- fixture `tmp_packages_dir` + 重建 `main` 模块：每个用例拿到隔离的 PACKAGES_DIR 与 `testuser/testpass`。
- 用例组：`TestHealth`（health 免认证）、`TestAuth`（索引/下载必须 401 未认证）以及上传/下载/重复上传等行为用例——修改鉴权或路由后以 `pytest` 全量回归。

## 常见改动场景

- **改上传格式白名单**：`upload_package` 的扩展名正则 + 测试同步。
- **改索引页字段**：只动 `_render_package_index` 的 muted span；锚点 href 结构是 pip/admin 双端契约，勿改。
- **加删除端点**：当前无删除/下线路由（只能删卷内文件）；新增时须过 `verify_auth` 并补 `is_meta_file` 排除逻辑。

## 下载与索引生成细节

- `GET /simple/{name}/` 每次请求实时扫描 `PACKAGES_DIR/<norm>/`（`sorted(d.glob("*"))`），无内存缓存——`no-cache` 语义下这是有意为之；包目录不存在返回 404 `Package not found`。
- `GET /packages/{name}/{filename}` 直接 `FileResponse`（FastAPI 流式）；`safe_filename = Path(filename).name` 剥掉任何目录分量（S9 防穿越），包名先 normalize 再拼路径。
- 索引 HTML 中 sha256 来自 sidecar（`artifact_sha256()`），pip 可据此校验完整性；admin 侧 `parsePypiIndex` 只取锚点文本，故"版本 N · 体积 · 时间"等 muted 信息不参与解析。
- 并发上传安全：`os.link` 是 POSIX 硬链接原子操作，依赖"临时文件与目标同目录（同一文件系统）"——部署目标是 Linux；无硬链接语义的客户端（Windows 直连）不在支持面内（main.py N30 注释）。

## 设计决策索引（main.py 内注释编号）

| 编号 | 决策 | 位置 |
|---|---|---|
| S9 | 索引/下载也纳入 Basic 认证（不可匿名枚举） | 各路由 `Depends(verify_auth)` |
| S10 | 上传上限 50MB 与 admin-api 代理 multer 对齐 | `MAX_UPLOAD_BYTES` |
| N14 | 上传文件名剥目录分量 | `upload_package` |
| N18 | sha256 上传时一次计算 + sidecar 缺失时懒回填 | `artifact_sha256()` |
| N21/N30 | 流式上传 O(chunk) 内存 + `os.link` 原子占位防并发覆盖 | `upload_package` |
| FEAT-12 | 内联样式 HTML 索引页（离线可用、no-cache） | `_page()` / `_CACHE_HEADERS` |

## 相关文档

- [registry-pypi 总览](README.md) —— 路由/鉴权/部署
- [Verdaccio 私服](../registry-npm.md) —— npm 侧对照
- [executor-python 总览](../executor-python/README.md) —— uv 消费侧（本页 §与 uv/pip 白名单的配合）
