# registry 模块 — 私有仓库代理 / 集成面

> 所属: docs/atlas/01-apps/admin-api/modules · 最后核对: 2026-09-13 · 对应代码: apps/admin-api/src/modules/registry

## 职责

管理台对两个私有包仓库（Verdaccio npm 私服、自建 PyPI 私服）的**只读/转发代理**：列出包清单、代理 PyPI 包上传。本身无数据库表、不缓存——纯 HTTP 转发 + 解析，仓库的存储与索引完全由独立应用承载。

## 目录结构与关键文件

```
modules/registry/
├── registry.module.ts       仅注册 RegistryController（无 providers/imports）
└── registry.controller.ts   @Controller("registry") @UseGuards(JwtAuthGuard) 三个路由
                             （fetchText 小请求 8s 超时；upload 代理默认 60s）
```

## 路由（controller 前缀 `registry`，实际路径 `/api/registry`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/pypi/packages` | JWT | 拉 `<PYPI_REGISTRY_URL>/simple/`，正则解析 `<a>` 标签得到包名列表 |
| GET | `/npm/packages` | JWT | 拉 `<NPM_REGISTRY_URL>/-/verdaccio/packages`，JSON 直出 `{name,latest,description}[]` |
| POST | `/pypi/upload` | JWT | multipart `content`（上限 50MB），转发到 `<PYPI_REGISTRY_URL>/upload/` |

## 关键机制

### 凭据解析

- PyPI：Basic 认证，`REGISTRY_USER`（默认 `admin`）/ `REGISTRY_PASS`。
- npm（S5）：Verdaccio 的 `config.yaml` 把所有包 pattern 设为 `access: $authenticated`，匿名拉 `/-/verdaccio/packages` 必 401（清单恒空）。解决路径按优先级：
  1. `NPM_REGISTRY_TOKEN` 直接作 Bearer；
  2. `NPM_REGISTRY_USER`/`NPM_REGISTRY_PASS` → `PUT /-/user/login`（body 兼容 `name`/`username` 两种键）换 bearer token；
  3. 均未配置 → 匿名（401 → 空列表，debug 日志可发现）。
- 环境变量：`NPM_REGISTRY_URL`（默认 `http://localhost:4873`）、`PYPI_REGISTRY_URL`（默认 `http://localhost:8003`）、`REGISTRY_UPLOAD_TIMEOUT_MS`（默认 60000）。

### 上传代理守卫

- 扩展名白名单 `.whl` / `.tar.gz` / `.zip`，其余 400。
- 超时三重防线（S4）：socket inactivity timeout + 整体 deadline（默认 60s，远大于 fetchText 的 8s GET 预算）+ 连接未响应即关闭的 close 兜底——任一触发都以 504/502 结束，绝不悬挂请求。
- form-data 用 namespace import（项目未开 esModuleInterop，default import 运行时炸）。

## 与其他模块的关系（与 apps/registry-npm、apps/registry-pypi 的分工）

```
admin-web 包管理页 ──► /api/registry/*（JWT）──► 本模块（纯代理，无库表）
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                          ▼
   apps/registry-npm（Verdaccio，:4873）      apps/registry-pypi（自建，:8003）
   access: $authenticated                    /simple/ 索引 + /upload/ 发布
              ▲                                          ▲
              └── 执行器安装依赖时直连私服（不经 admin-api）──┘
```

- 本模块只是管理台的**观测/运维窗口**（看私有仓里有什么、代传一个 PyPI 包），不是执行任务的依赖解析路径——任务依赖安装（W-21 `uv pip install` / npm install）由执行器直连私服完成。
- 与 [executor-package](executor-package.md) 无关：后者分发的是执行器程序自身的安装包（admin 自托管），本模块面向的是任务依赖包仓库。
- 依赖 common：仅 `JwtAuthGuard`（@UseGuards 显式声明，非全局豁免场景）。

## 环境变量速查

| 变量 | 默认 | 用途 |
|---|---|---|
| `PYPI_REGISTRY_URL` | `http://localhost:8003` | 自建 PyPI 私服地址（清单 + 上传转发目标） |
| `REGISTRY_USER` / `REGISTRY_PASS` | `admin` / 空 | PyPI Basic 凭据（清单 GET 与上传 POST 共用） |
| `NPM_REGISTRY_URL` | `http://localhost:4873` | Verdaccio 私服地址 |
| `NPM_REGISTRY_TOKEN` | 空 | 直接使用的 Verdaccio bearer token（优先级最高） |
| `NPM_REGISTRY_USER` / `NPM_REGISTRY_PASS` | 空 | 服务账号，运行时经 `PUT /-/user/login` 换 token |
| `REGISTRY_UPLOAD_TIMEOUT_MS` | 60000 | 上传代理整体 deadline（socket 超时同值） |

清单请求（fetchText）固定 8s 超时，超时/失败一律返回空列表（HTTP 200 + `packages: []`），不向管理台抛错。

## 常见改动场景

- npm 清单恒空排查：先看 `NPM_REGISTRY_TOKEN`/`NPM_REGISTRY_USER`+`PASS` 是否配置，admin 日志有 `login failed` / `did not contain a token` 警告。
- 代理新仓库（如通用 Docker registry）：照 `fetchText` 模式加路由，凭据走 ConfigService；注意 8s/60s 两档超时语义。
- 私服地址变更：只改 env，代码默认值仅兜底。

## 相关文档

- [registry-npm（Verdaccio）](../../../01-apps/registry-npm.md) · [registry-pypi](../../../01-apps/registry-pypi/README.md)（规划路径）
- [executor-package](executor-package.md)（执行器程序包分发，区分场景）
- [task](task.md)（任务 requirements 字段 → 执行器侧依赖安装）
