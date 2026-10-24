# P1 修复设计：executor → registry-pypi 凭据通道（netrc 子进程注入）

- 日期：2026-10-25
- 状态：已实施（executor-python 全量 + executor-node 对等 + compose/.env.example/deploy 文档）
- 关联：docs/archive/reports/deployment-model-review-2026-10-23.md（S9 断裂实证，44e0c394/188abaca 行 343）

## 0. 问题复述

registry-pypi 全端点 Basic 认证（`REGISTRY_USER/REGISTRY_PASS`，fail-closed）。executor-python 的
`uv pip install --index-url $PYPI_REGISTRY_URL` 子进程环境是白名单剥离后的最小集
（`_INSTALL_ENV_KEYS` / `_UV_ENV_KEYS` + `UV_NO_CONFIG=1` + `PIP_CONFIG_FILE=/dev/null`），
凭据没有任何合法入口——默认部署下安装私有源包必 401。config 校验红线（无 userinfo URL）与
执行器凭据禁入 argv 红线都正确，缺的是一条**受控凭据通道**。

## 1. 方案空间评估（含实测）

探查环境：uv **0.13.4**（= executor-python requirements.txt pin 版），真实 wheel + 401 Basic
stub 服务端，`env -i` 白名单环境（`UV_NO_CONFIG=1` + `PIP_CONFIG_FILE=/dev/null`）。

| 通道 | 实测结果 | 结论 |
|---|---|---|
| 裸 `--index-url`（现状） | 401 Unauthorized | 断裂复现 |
| `NETRC` env → per-machine netrc 文件 | **E2E 成功**（uv 自带 netrc 客户端，日志见 `Checking netrc for credentials`，Basic 头到达索引与 wheel URL） | ✅ 可行 |
| `UV_INDEX_URL_USERNAME/PASSWORD`（全局索引） | 401——该变量族只对 **UV_INDEX_<name>_** 命名索引生效，与 `--index-url` 并存时不消费 | ❌ 方案 b 全局形态证伪 |
| 方案 b 变体（迁移到 `[[index]]` + UV_INDEX_<name>_*） | 需放弃 argv `--index-url`，索引选择隐式化，失败提示（`_pypi_index_hint`）失真 | 成本高、回归面大 |

| 方案 | 安全 | 实现成本 | 协议影响 | 用户体验 |
|---|---|---|---|---|
| **a`. uv 子进程级 netrc（选定）** | 凭据只落在 0600 临时文件，只绑 install 子进程 env（`NETRC` 键），不进 argv/日志/URL，不污染全局环境；uv/pip 原生消费 | 低（两侧各一个 builder 钩子 + settings 键） | 零（不改派发协议、不加任务字段） | compose 同源注入即通；不配置 = 现状逐字节不变 |
| a. per-task 派发 netrc（admin 下发一次性凭据） | 最小权限（per-task 一次性） | 高：协议加字段、admin 加凭据派生/轮换、两侧解析 | 大（dispatch payload + protocol.json） | 需 admin/executor 同步升级 |
| b. UV_INDEX_*_USERNAME/PASSWORD | 变量只对命名索引生效，须重构索引声明 | 中 | 无 | 全局形态无效（实测），命名形态改动大 |
| c. 部署面绕行（EXTRA_INDEX 回落官方 + zip 打包） | 无新面 | 零代码 | 无 | 改变使用范式，私有源名存实亡，不解决根因 |

**选定 a`（部署级静态凭据 → uv 子进程 netrc）**：与 registry 单一 Basic 凭据集的信任模型一致
（admin-api 侧 `REGISTRY_USER/PASS` 同源复用的先例已在 compose），协议零影响，红线全保。
per-task 派发（方案 a 全形态）列为后续演进：当需要 per-task 凭据轮换时，在同一 `netrc` 注入点
替换凭据来源即可，注入机制不变。

## 2. 设计（executor-python）

### 2.1 配置面

`Settings` 新增（config.py）：

- `pypi_registry_username: str = ''`（env `PYPI_REGISTRY_USERNAME`）
- `pypi_registry_password: str = ''`（env `PYPI_REGISTRY_PASSWORD`，**密文类**：不回显、不日志）
- 约束：**凭据对非空 ⇔ 必须能对应到一个已配置的索引**（`pypi_registry_url` 或
  `pypi_extra_index_url` 至少其一非空），否则启动/reload 拒绝——防止凭据配了却永远用不上、
  或配错索引把凭据发给错误的 host。

### 2.2 注入点（routers/execute.py `_build_uv_env` → interpreters.build_uv_env）

- 新增模块级 `_pypi_netrc_target()`：读 settings 凭据对；**任一字段为空 → 返回 None（零行为变化）**。
- netrc 文件：**每次 install 阶段按需生成**，路径在 uv cache 目录旁
  （`<venvs-root>/.uv-netrc`，与 `settings.work_dir` 同卷、executor 属主），内容一行 per host：

  ```
  machine <host-of-pypi_registry_url>
  login <username>
  password <password>
  ```

  若 `pypi_extra_index_url` 的 host 与主索引不同，追加第二条 machine 记录（同一凭据集，
  registry-pypi 单一 Basic 域的既定信任模型）。
- 权限 0o600，写前 `os.open(..., O_WRONLY|O_CREAT|O_TRUNC, 0o600)`；**绝不删除重建既有文件**
  （并发 install 竞态删除对 方的 fd）：内容幂等，直接覆写。
- 注入：`build_uv_env()` 返回的 dict 里加 `NETRC=<该文件路径>`——**只存在于 install/venv
  子进程 env**，executor 主进程 `os.environ` 不动（任务运行时环境 `_ENV_WHITELIST` 也不含
  `NETRC`，任务代码不可见凭据）。
- **缓存安全**：uv cache (`.uv-cache`) 与 netrc 同属 executor 属主可写目录；netrc 权限 0600，
  同 UID 进程本就可读（既有威胁模型内，见 execute.py S6 注释——同 UID 不构成隔离边界）。

### 2.3 错误面

- 凭据对非空但索引未配置 → 启动/reload 校验失败（fail-fast，消息不回显凭据值）。
- netrc 写失败 → `build_uv_env` 记 warning 并**不注入 NETRC**（安装会 401，但错误路径与
  现状一致，不引入新失败模式）；不抛异常（venv 创建不因凭据文件失败而阻断）。

### 2.4 兼容红线

- 未配置凭据：argv、env、行为**逐字节不变**（现有测试 `test_build_uv_env_drops_host_secrets`
  等继续原样通过）。
- host 环境 `NETRC` 键本就不在 `_UV_ENV_KEYS`/`_INSTALL_ENV_KEYS` 白名单内——宿主 netrc
  不可能穿透，只有显式生成文件才生效（新增测试钉住）。

## 3. 设计（executor-node 对等）

`python-venv.ts` 的 `defaultUvEnv()` 同法：读 `config.pypiRegistryUsername/Password`
（env `PYPI_REGISTRY_USERNAME/PASSWORD`，config.ts 惰性 getter，逐字校验规则同 python 侧：
非空时要求 `pypiRegistryUrl`/`pypiExtraIndexUrl` 至少一非空），netrc 写
`path.join(os.tmpdir?` ——不，与 python 侧对齐写在解释器池/cache 同卷：
`path.join(config.workDir, '..', '.uv-netrc')`？部署形态不同，node 侧统一写在
`UV cache 同级目录`：`path.join(path.dirname(cacheDir), '.uv-netrc')`；`defaultUvEnv` 无
cacheDir 参数时退化用 `os.tmpdir()`。0o600、幂等覆写、`NETRC` 只进该子进程 env。
未配置 → 逐字节不变。

## 4. 部署面（compose / .env.example / deploy.sh 文档）

- executor-python 与 executor-node 服务块新增：
  `PYPI_REGISTRY_USERNAME: ${PYPI_REGISTRY_USERNAME:-}`、
  `PYPI_REGISTRY_PASSWORD: ${PYPI_REGISTRY_PASSWORD:-}`。
- `.env.example`：REGISTRY_USER/PASS 段更新——移除"执行器侧没有该凭据的传输通道…必 401"
  的失实表述，改为指向本机制（与 REGISTRY_USER/PASS 同值即可）。
- 默认不设 = 现状（compose 默认仍 401，显式配置才启用凭据通道）——保持"私有源匿名只读"
  部署的可选性，不改变默认安全姿态。

## 5. 测试（先红后绿）

1. `test_execute.py`：`_build_install_env`/`_build_uv_env` 配置凭据后 NETRC 键存在、
   文件 0600、内容含 machine/login/password 且 host 正确；未配置时无 NETRC 键（现状钉住）。
2. `test_interpreters.py`：`build_uv_env` 同上 + 宿主 `NETRC` 环境变量不穿透。
3. config 校验：凭据对非空 + 无索引 → ValueError；消息不含凭据值。
4. node 侧 `python-venv.spec.ts`：`defaultUvEnv` 注入 NETRC / 未配置不变。
5. 既有 401-相关回归全绿。

## 6. 残差与后续

- per-task 一次性凭据（admin 派发、任务结束吊销）= 演进方向，注入点不变。
- node 侧非 uv 分支（venv 自带 pip）同样消费 NETRC（pip 原生支持），对等生效。
- netrc 明文落在执行器磁盘（0600 + executor 属主）：与 registry 单一静态凭据集同信任级；
  需要更强隔离时演进 per-task 派发。
