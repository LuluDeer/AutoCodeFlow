# 解释器缓存离线预填运维手册（OFFLINE-PROVISIONING）

> **适用对象**：平台部署方 / 运维（Operator）
> **对应需求**：NFR-14c（可选·离线预填）、NFR-15（缓存池治理）、ASM-07（私有化可选模式）、D9③、D14（降级语义）
> **对应设计**：`DESIGN.md` §2.5「私有化可选模式」、`CONTRACT.md` §0 / §2.3
> **配套文件**：[`SUPPORT-MATRIX.md`](./SUPPORT-MATRIX.md)（支持矩阵定稿）
> **适用版本**：uv 0.8.17（仓库锁定值）；本手册步骤已在 uv 0.8.17 与 uv 0.11.14 上交叉实测

---

## 0. 这份手册解决什么问题

平台执行器默认走**在线动态下载**主路径（`uv python install <version>`）。以下场景需要**离线预填**：

| 场景 | 用哪种方式 |
|---|---|
| 执行器**无外网**且**无内网镜像**，但可把文件拷进目标机 | **本手册**（离线预填缓存卷） |
| 需要 **Python 3.7** | **本手册**——3.7 **不在 uv 的可下载清单内**，在线下载必然失败（见 §3） |
| 执行器有内网镜像可达 | 不需要本手册，配置 `UV_PYTHON_INSTALL_MIRROR` 即可（见 `docs/deployment.md`「解释器缓存与私有化模式」） |
| 执行器有外网 | 不需要本手册，**3.8~3.14** 首跑自动下载 |

> **一句话**：本手册覆盖 **3.7（唯一必须离线预填的版本）** 与 **任意 3.8~3.14 版本的离线兜底**。

---

## 1. 缓存池目录与布局约定

### 1.1 池根目录

池根目录由环境变量 **`UV_PYTHON_INSTALL_DIR`** 定位：

| 部署形态 | 默认值 |
|---|---|
| executor-python（compose） | **`/data/interpreters`**（compose 命名卷 `interpreter_cache`） |
| executor-python（裸机） | 由 `.env` 的 `UV_PYTHON_INSTALL_DIR` 指定；**代码缺省值即 `/data/interpreters`** |
| executor-node | 同名变量；**未设置时代码取 `WORK_DIR` 的兄弟目录 `interpreters`**（即 `path.resolve(WORK_DIR, '..', 'interpreters')`），**不是** uv 自身的 `~/.cache/uv/python` |
| executor-node（compose） | 显式设为 `/data/interpreters`，与 python 执行器**共享同一卷** |

> 两执行器默认值不同（python 是固定绝对路径，node 是相对 `WORK_DIR` 派生）。**若要让它们共享同一份解释器层，须显式把两边指向同一目录**——compose 已如此处理；裸机/桌面端混布时请自行对齐。

> **⚠️ 硬约束：池根目录必须位于 `WORK_DIR` 之外。**
> 任务工作目录（`WORK_DIR`，compose 为 `/data/tasks`）受**磁盘 TTL 清扫**管理（`DISK_CLEANUP_TTL_DAYS`，默认 7 天），清扫会删除过期目录。解释器是可复用资产，一旦被 TTL 误删就要重新下载（离线环境下则**永久不可恢复**）。设计上通过**物理隔离**（`/data/interpreters` 独立于 `/data/tasks`）+ **清扫豁免**（`maintenance.py` 的 `_protected_interpreter_root()` 会跳过池根）双保险。**不要**把池设成 `$WORK_DIR/interpreters` 之类的子目录——虽然代码有豁免兜底，但那是第二道防线；把池配成 `WORK_DIR` **本身**会被判为配置错误（记 error 且不保护，磁盘治理仍生效）。

### 1.2 目录命名约定（**最关键的一条**）

池内每个版本一个目录，名字必须严格是：

```
cpython-<完整版本>-<uv平台三元组>-none
```

- `<完整版本>`：三段式补丁版本，如 `3.7.9`（**不是** `3.7`）；
- `<uv平台三元组>`：**uv 自己的平台命名**（`<os>-<arch>-<libc>`），**不是** python-build-standalone 的三元组；
- 结尾恒为 `-none`（无 variant；freethreaded 才带 `+freethreaded`，本项目不使用）。

#### uv 平台三元组对照表（**必须逐字使用**）

| 目标平台 | **uv 池目录用的三元组** | python-build-standalone 资产名里的三元组（**易混点**） |
|---|---|---|
| Linux x86_64 glibc | **`linux-x86_64-gnu`** | `x86_64-unknown-linux-gnu` |
| Linux x86_64 musl（Alpine） | **`linux-x86_64-musl`** | `x86_64-unknown-linux-musl` |
| Linux aarch64 glibc | **`linux-aarch64-gnu`** | `aarch64-unknown-linux-gnu` |
| Linux aarch64 musl | **`linux-aarch64-musl`** | `aarch64-unknown-linux-musl` |
| Windows x86_64 | **`windows-x86_64-none`** | `x86_64-pc-windows-msvc` |
| macOS x86_64（Intel） | **`macos-x86_64-none`** | `x86_64-apple-darwin` |
| macOS aarch64（Apple Silicon） | **`macos-aarch64-none`** | `aarch64-apple-darwin` |

> **这是本手册最容易踩的坑**：把 pbs 的三元组（`x86_64-unknown-linux-gnu`）写进目录名，uv **完全看不见**这个解释器——不报错，只是不列出（实测见 §7.1）。
>
> 对照关系可直接问 uv 自己：
> ```bash
> uv python list --all-platforms --only-downloads | head -20
> # 输出中的 cpython-3.12.11-linux-x86_64-gnu 即 uv 命名
> ```
>
> #### 与 CONTRACT.md §0.2 勘误的关系
>
> `CONTRACT.md` 早期版本（v1.0）的 §0 括号注与 §2.2 示例曾把池目录名写成
> pbs 形式 `cpython-3.7.9-x86_64-unknown-linux-gnu-none`。**该问题已修复**：
> `CONTRACT.md` 现含 **§0.2 勘误（v1.1）**，给出 uv 三元组 ↔ pbs 三元组的完整
> 对照表、实测证据与运维自检提示，§2.2 示例路径亦已更正为
> `/data/interpreters/cpython-3.7.9-linux-x86_64-gnu/bin/python3`。
> 执行器侧 `interpreters.py` 的 `_not_downloadable_detail` 提示文案与测试夹具
> 也已同步更正。**本手册与 CONTRACT.md §0.2 现已一致**，可互为印证。
>
> #### ⚠ 第二层陷阱：三元组之后**不要再补 `-none`**
>
> 池目录名的全形是 **`cpython-<完整版本>-<uv三元组>`**，只此三段，**三元组后面
> 什么都没有**。`windows-x86_64-none` 里那个 `-none` 是**三元组自身的 libc 槽位**
> （Windows/macOS 的 libc 槽位取值就是 `none`），不是额外后缀；Linux 的 libc 槽位
> 是 `gnu`/`musl`，所以 **Linux 目录名不带 `-none`**。照抄三元组即可：
>
> | 池目录名 | 判定 | 实测 |
> |---|---|---|
> | `cpython-3.7.9-linux-x86_64-gnu` | ✅ 正确 | `uv python install cpython-3.12-linux-x86_64-gnu` → 落盘 `cpython-3.12.11-linux-x86_64-gnu` |
> | `cpython-3.7.9-linux-x86_64-musl` | ✅ 正确 | 同上（musl 槽位） |
> | `cpython-3.7.9-linux-x86_64-gnu-none` | ❌ **多了一个 `-none`** | `uv python install cpython-3.11-linux-x86_64-gnu-none` → `error: ... is not a valid Python download request`；手工放同名目录则被**静默忽略** |
> | `cpython-3.7.9-windows-x86_64-none` | ✅ 正确（`-none` 属于三元组） | `--only-installed` 正常列出 |
> | `cpython-3.7.9-windows-x86_64-none-none` | ❌ 多了一个 `-none` | **静默忽略**，列表里不出现 |
>
> 判据：**Linux 的三元组以 `gnu`/`musl` 结尾 → 目录名到此为止；Windows/macOS 的
> 三元组以 `none` 结尾 → 那个 `none` 保留，但也仅此一个。**
> 放好后务必用 `uv python list --only-installed` 自查（见 §3.5 三关验证）。
>
> 实测依据（Windows 上同构验证，两个 uv 版本均一致）：
>
> | 池目录名 | uv 0.8.17 | uv 0.11.14 |
> |---|---|---|
> | `cpython-3.7.9-x86_64-pc-windows-msvc-none`（pbs 三元组） | `--only-installed` **不列出**；`uv venv --python 3.7` **exit 2** | 同左 |
> | `cpython-3.7.9-windows-x86_64-none`（**uv 三元组**） | 列出；`uv venv --python 3.7` **exit 0** | 同左 |
>
> **未在本机 Linux 上端到端验证**（本机为 Windows）：Linux 一行由 uv 的平台词汇
> 推导（`uv python list --all-platforms --only-downloads` 实测输出
> `linux-x86_64-gnu` / `linux-x86_64-musl`），未实机执行。首次在生产 Linux 预填
> 时，请务必跑 §3.5 的三关验证。

#### 命名错位的两种失效形态（**排障必读**）

uv 对池条目的解析机制，实测结论如下——**版本分量取自目录名，可用性校验取自真实解释器**：

| 目录名状态 | 实际载荷 | `--only-installed` 列出？ | 请求 `--python <真实版本>` | 请求 `--python <目录名版本>` |
|---|---|---|---|---|
| 版本✓ 平台✗（pbs 三元组） | 与目录名一致 | **否**（整条被忽略） | 失败 | 失败 |
| 版本✗ 平台✓ | 与目录名**不一致** | **是**（但按**真实**版本列出） | **成功** | 失败 |

两点结论：

1. **平台分量错（pbs 三元组）→ 整条被静默忽略**：既不列出也不报错，`--python <版本>` 一律 `error: No interpreter found for Python <版本> in managed installations, search path, or registry`（exit 2）。这是最常见的踩坑形态。
2. **版本分量与真实解释器不一致 → uv 以真实版本为准**：`uv python list` 会把该目录按**真实版本**列出（实测：载荷 3.9.23、目录名 `cpython-3.7.9-...`，列表显示 `cpython-3.9.23-windows-x86_64-none`），因此**不会**产生"请求 3.7 却拿到 3.9"的静默错配——请求 3.7 会明确失败。**目录名的版本分量只是索引键，不是事实来源**；这也意味着手工预填时目录名版本写错不会被"将错就错"，而是表现为该版本不可用。

> 因此排障时请以 `uv python list --only-installed` 的**输出**为唯一事实来源，不要相信目录名。

### 1.3 目录内容（**第二个易踩的坑**）

pbs 压缩包解压后是 `python/install/...` 两层嵌套。**要放进池目录的是 `python/install/` 里面*内容***，不是压缩包根，也不是 `python/` 目录：

```
<UV_PYTHON_INSTALL_DIR>/
└── cpython-3.7.9-linux-x86_64-gnu/     ← 池目录（名字必须是 §1.2 的约定）
    ├── bin/                                  ← Linux：python3 等可执行文件
    ├── include/
    ├── lib/
    ├── share/
    └── ...
```

Windows 形态：

```
<UV_PYTHON_INSTALL_DIR>\
└── cpython-3.7.9-windows-x86_64-none\
    ├── DLLs\
    ├── Lib\
    ├── Scripts\
    ├── python.exe                            ← 解释器入口（uv 探测的目标）
    ├── python37.dll
    └── ...
```

**正确**：`池目录/` 下**直接**是 `bin/`（Linux）或 `python.exe`（Windows）。
**错误**：`池目录/python/install/bin/...` 或 `池目录/python/...` —— uv 会报 `Failed to inspect Python interpreter ... Python interpreter not found at <池目录>/python.exe`（实测见 §7.2）。

### 1.4 池根目录下的其他文件（**不要手工动**）

uv 在池根目录还会放置：

| 条目 | 作用 |
|---|---|
| `.temp/` | 下载临时目录 |
| `.lock` | uv 的池级文件锁 |
| `.gitignore`（内容为 `*`） | 防止误提交 |
| `cpython-<主.次>-<平台>-none`（**别名条目**，如 `cpython-3.8-windows-x86_64-none`） | uv 在部分版本/配置下为"主.次"请求建的**别名**（实测 uv 0.11.14 会建，uv 0.8.17 未建）。**离线预填不要自己造别名**——uv 会按 §1.2 的完整版本目录名自行解析前缀匹配（`--python 3.7` 命中 `cpython-3.7.9-...`），别名是 uv 的产物而非前提。 |

> 实测两版本的池根内容（`uv python install 3.8` 后）：
>
> | uv | 池内条目 |
> |---|---|
> | 0.8.17 | `.temp/`、`.lock`、`.gitignore`、`cpython-3.8.20-windows-x86_64-none/` |
> | 0.11.14 | 同上 + `cpython-3.8-windows-x86_64-none`（别名） |
>
> 结论：**别名条目不是预填的必要条件**，两版本都能仅凭完整版本目录完成前缀匹配（§3.5 第 ② 关实测）。手工预填时只放完整版本目录即可。

---

## 2. 平台三元组速查（复制即用）

| 场景 | 池目录名（3.7.9） | 3.7.9 产物是否存在 |
|---|---|---|
| 本平台 compose 默认（linux/amd64, Debian slim） | `cpython-3.7.9-linux-x86_64-gnu` | ✅ |
| Alpine / musl | `cpython-3.7.9-linux-x86_64-musl` | ✅ |
| Linux arm64 服务器 | `cpython-3.7.9-linux-aarch64-gnu` | ❌ **不存在**（见 §3.2 注） |
| Windows | `cpython-3.7.9-windows-x86_64-none` | ✅ |
| macOS Intel | `cpython-3.7.9-macos-x86_64-none` | ✅ |
| macOS Apple Silicon | `cpython-3.7.9-macos-aarch64-none` | ❌ **不存在**（见 §3.2 注） |

> 右侧一列的判定依据：枚举 pbs `20200822` 全部 21 个资产，**架构只有 `i686` 与 `x86_64`**，无 `aarch64`。详见 §3.2。

---

## 3. Python 3.7 预填（主用例）

### 3.1 为什么 3.7 必须离线预填

| 事实 | 实测证据 |
|---|---|
| uv 0.8.17 的可下载区间是 **3.8 ~ 3.14**，**不含 3.7** | `OFFLINE-PROVISIONING` 配套的 `SUPPORT-MATRIX.md` §2.1 |
| `uv python install 3.7` → `error: No download found for request: cpython-3.7-<platform>`（exit 2） | 同上 §2.2 |
| **升级 uv 也没用**：0.11.14 同样不含 3.7 | 同上 §2.3 |
| 但 pbs `20200822` **仍托管** 3.7.9 构建 | 同上 §3 |

所以 3.7 走"下载 pbs 产物 → 手工摆进池"的通道。**该通道已端到端实测打通。**

### 3.2 资产对照表（pbs release tag `20200822`）

下载基址：`https://github.com/astral-sh/python-build-standalone/releases/download/20200822/`

| 目标平台 | 资产文件名 | 体积（实测） |
|---|---|---|
| Linux x86_64 glibc | `cpython-3.7.9-x86_64-unknown-linux-gnu-pgo-20200823T0036.tar.zst` | 27.04 MiB |
| Linux x86_64 musl | `cpython-3.7.9-x86_64-unknown-linux-musl-noopt-20200823T0036.tar.zst` | 24.66 MiB |
| Windows x86_64 | `cpython-3.7.9-x86_64-pc-windows-msvc-shared-pgo-20200823T0118.tar.zst` | 29.97 MiB |
| macOS x86_64 | `cpython-3.7.9-x86_64-apple-darwin-pgo-20200823T0123.tar.zst` | 22.67 MiB |
| Linux x86_64 glibc（调试变体，**不推荐**） | `cpython-3.7.9-x86_64-unknown-linux-gnu-debug-20200823T0036.tar.zst` | — |
| Linux x86_64 musl（调试变体，**不推荐**） | `cpython-3.7.9-x86_64-unknown-linux-musl-debug-20200823T0036.tar.zst` | — |
| Windows x86_64（静态变体，**不推荐**） | `cpython-3.7.9-x86_64-pc-windows-msvc-static-noopt-20200823T0153.tar.zst` | — |
| macOS x86_64（调试变体，**不推荐**） | `cpython-3.7.9-x86_64-apple-darwin-debug-20200823T0123.tar.zst` | — |
| Windows **i686**（32 位） | `cpython-3.7.9-i686-pc-windows-msvc-shared-pgo-20200823T0159.tar.zst` | — |
| Windows **i686**（32 位，静态变体） | `cpython-3.7.9-i686-pc-windows-msvc-static-noopt-20200823T0221.tar.zst` | — |

**⚠️ 重要限制：`20200822` 的 3.7.9 只覆盖 `x86_64` 与 `i686`，没有 `aarch64`（ARM64）产物。**

实测枚举该 release 的全部 21 个资产，架构仅有 `i686` 与 `x86_64`；3.7.9 的 10 个资产完整清单即上表全部 10 行。后续 tag（`20201005` / `20201006` / `20210724` / `20220318` / `20221002` / `20230116`）已不再提供 3.7.x 的任何构建。**因此**：

| 目标架构 | 3.7 可用性 | 处置 |
|---|---|---|
| `x86_64`（amd64，**本平台 compose 默认**） | ✅ 可用 | 按本手册预填 |
| `i686`（32 位 x86） | ⚠️ 有产物但非平台支持形态 | 不建议 |
| `aarch64` / `arm64`（含 Apple Silicon、ARM 服务器） | ❌ **无任何 3.7.9 产物** | **3.7 在该架构上不可用**；须在支持矩阵中按"该架构不支持 3.7"处理，或改用 x86_64 执行器承载 3.7 任务 |

> 该限制**只影响 3.7**。3.8~3.14 有完整的 aarch64 产物（`uv python list --all-platforms --all-arches --only-downloads` 实测含 `linux-aarch64-gnu` / `linux-aarch64-musl` / `macos-aarch64-none` / `windows-aarch64-none`），走在线下载不受影响。

> **变体说明**：pbs 资产名里的 `pgo` / `noopt` / `lto` / `debug` 是构建变体。**优先选 `pgo`**（性能最好）；`pgo` 不可用时 `noopt`/`lto` 亦可（功能等价，仅性能差异）。**不要选 `debug`**（体积大、性能差，且 `-debug` 后缀与 uv 的 variant 语义不符）。

### 3.3 Linux（bash / sh）

```bash
#!/usr/bin/env bash
# ── 离线预填 Python 3.7.9 到 uv 解释器缓存池（Linux x86_64 glibc）──
set -euo pipefail

# 0) 参数：池根目录（与执行器 UV_PYTHON_INSTALL_DIR 必须一致）
POOL_DIR="${UV_PYTHON_INSTALL_DIR:-/data/interpreters}"

# 1) 资产名与下载地址（如需确认可用资产，先枚举 release 资产清单）
TAG="20200822"
ASSET="cpython-3.7.9-x86_64-unknown-linux-gnu-pgo-20200823T0036.tar.zst"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${TAG}/${ASSET}"
# 资产枚举（可选，确认资产名是否存在）：
#   curl -fsSL "https://github.com/astral-sh/python-build-standalone/releases/expanded_assets/${TAG}" \
#     | grep -o 'cpython-3\.7\.9-[^"]*\.tar\.zst' | sort -u

# 2) 池目录名（⚠ 必须用 uv 的三元组，不是 pbs 的）
POOL_ENTRY="${POOL_DIR}/cpython-3.7.9-linux-x86_64-gnu"

# 3) 下载并解压到临时目录
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
echo "==> downloading ${ASSET}"
curl -fL --retry 3 -o "${WORK}/pbs.tar.zst" "${URL}"
echo "==> extracting"
tar -xf "${WORK}/pbs.tar.zst" -C "${WORK}"

# 4) 摆放：把 python/install/ 的【内容】拷进池目录
mkdir -p "${POOL_ENTRY}"
cp -a "${WORK}/python/install/." "${POOL_ENTRY}/"

# 5) Linux 必须补可执行位（tar 解压后经 U 盘/共享盘/Windows 中转常丢权限位）
chmod +x "${POOL_ENTRY}/bin/python3"
chmod -R a+rX "${POOL_ENTRY}"

# 6) 可选：剔除 .pdb 调试符号（仅 Windows 产物有；Linux 无此问题，此步为幂等）
find "${POOL_ENTRY}" -name '*.pdb' -delete 2>/dev/null || true

# 7) 验证
echo "==> verifying"
uv python list --only-installed | grep '3\.7' || { echo "ERROR: uv 未识别 3.7.9"; exit 1; }
"${POOL_ENTRY}/bin/python3" --version
echo "==> OK: ${POOL_ENTRY}"
```

### 3.4 Windows（PowerShell）

```powershell
# ── 离线预填 Python 3.7.9 到 uv 解释器缓存池（Windows x86_64）──
$ErrorActionPreference = 'Stop'

# 0) 池根目录（与执行器 UV_PYTHON_INSTALL_DIR 必须一致）
$PoolDir = if ($env:UV_PYTHON_INSTALL_DIR) { $env:UV_PYTHON_INSTALL_DIR } else { 'C:\autocodeflow\interpreters' }

# 1) 资产名与下载地址
$Tag   = '20200822'
$Asset = 'cpython-3.7.9-x86_64-pc-windows-msvc-shared-pgo-20200823T0118.tar.zst'
$Url   = "https://github.com/astral-sh/python-build-standalone/releases/download/$Tag/$Asset"

# 2) 池目录名（⚠ 必须用 uv 的三元组 windows-x86_64-none，不是 pbs 的 x86_64-pc-windows-msvc）
$PoolEntry = Join-Path $PoolDir 'cpython-3.7.9-windows-x86_64-none'

# 3) 下载并解压（Windows 10+ 自带 bsdtar，原生支持 .tar.zst）
$Work = Join-Path $env:TEMP ("pbs-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
try {
    Write-Host "==> downloading $Asset"
    Invoke-WebRequest -Uri $Url -OutFile (Join-Path $Work 'pbs.tar.zst') -UseBasicParsing -TimeoutSec 600
    Write-Host "==> extracting"
    tar -xf (Join-Path $Work 'pbs.tar.zst') -C $Work
    if ($LASTEXITCODE -ne 0) { throw "tar 解压失败（exit $LASTEXITCODE）" }

    # 4) 摆放：把 python\install\ 的【内容】拷进池目录
    New-Item -ItemType Directory -Force -Path $PoolEntry | Out-Null
    Copy-Item -Recurse -Force (Join-Path $Work 'python\install\*') $PoolEntry

    # 5) 可选：剔除 .pdb 调试符号（本产物含 51.3 MB pdb，剔除后 121.9MB → 70.6MB，
    #    实测不影响 uv 识别与 venv 创建）
    Get-ChildItem -Recurse -Force -File $PoolEntry -Filter *.pdb | Remove-Item -Force

    # 6) 验证
    Write-Host "==> verifying"
    $found = uv python list --only-installed | Select-String '3\.7'
    if (-not $found) { throw "uv 未识别 3.7.9（检查目录名与摆放层级，见手册 §7）" }
    & (Join-Path $PoolEntry 'python.exe') --version
    Write-Host "==> OK: $PoolEntry"
}
finally {
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
```

### 3.5 验证（两个平台通用，必做）

```bash
# ① uv 能列出该解释器
uv python list --only-installed | grep '3\.7'
# 期望：cpython-3.7.9-<uv平台三元组>-none    <池目录>/bin/python3   （Windows 为 python.exe）

# ② uv 能用它建 venv（这才是任务真正走的路径）
uv venv --python 3.7 /tmp/probe-37
# 期望：Using CPython 3.7.9
#       Creating virtual environment at: /tmp/probe-37
#       （exit 0）

# ③ venv 内解释器版本确实对
/tmp/probe-37/bin/python --version      # Linux
# \tmp\probe-37\Scripts\python.exe --version   # Windows
# 期望：Python 3.7.9

# ④ 清理探针
rm -rf /tmp/probe-37
```

> **三关全过才算预填成功**。只过第 ① 关不够——第 ② 关才是执行器实际调用的路径（`uv venv --python <path>`）。
>
> 用 `UV_OFFLINE=1` 可以**强制断网复现**离线环境（实测：未预填 → `error: No interpreter found for Python 3.7 ...` exit 2；已预填 → `Using CPython 3.7.9` exit 0）。建议在预填验证时带上它，确保结果不依赖网络。

---

## 4. 预填其他版本（3.8 ~ 3.14）

### 4.1 首选：直接用 uv（有外网时）

**3.8 ~ 3.14 请优先用 uv 在线安装，不要手工摆目录**：

```bash
# 单版本
uv python install 3.9
uv python install 3.13

# 一次多个
uv python install 3.9 3.12 3.13
```

理由：uv 会自行处理**平台三元组命名、variant、可执行位、注册（Windows registry）**，并校验下载产物完整性。手工摆目录是**只有 uv 下不到时**才用的兜底通道。

实测参考：`uv python install 3.9` → 下载 21.7 MiB，**16.2 s** 完成（正常公网）。D11 默认超时 300 s 余量充裕。

### 4.2 兜底：手工预填（同 §3 方法）

若目标机无外网但**有内网镜像**，优先配 `UV_PYTHON_INSTALL_MIRROR`（见 `docs/deployment.md`）。
若两者都无，则对 3.8~3.14 也用 §3 的方法手工预填：从 python-build-standalone 找一个**包含该版本的 release tag**，按 §1.2/§1.3 的命名与层级摆进池。

```bash
# 找出某版本所在的 pbs release tag（在能联网的机器上执行）
# 例：找 3.9.x 的 tag —— 从 pbs releases 列表挑一个日期晚于该版本发布的 tag，
#     再枚举其资产确认存在对应平台产物：
curl -fsSL "https://github.com/astral-sh/python-build-standalone/releases/expanded_assets/<TAG>" \
  | grep -o 'cpython-3\.9\.[0-9]*-[^"]*\.tar\.zst' | sort -u
```

> **注意**：手工预填的 3.8~3.14 与 uv 在线安装的产物**必须版本一致**才能被同一目录名复用；若池内已有 uv 装的 `cpython-3.9.23-...`，再手工放一个 `cpython-3.9.20-...` 会**共存两个目录**（uv 前缀匹配 `3.9` 时取其一，行为不确定）。**建议：同一主.次版本只保留一个补丁号。**

### 4.3 容量核算（预填前必做）

```
缓存池总占用 = Σ(预填版本数 × 单版本解压后体积)
约束：版本数 × 单版本体积(≤ INTERPRETER_SINGLE_VERSION_MB = 250MB) ≤ INTERPRETER_TOTAL_GB = 4GB
```

| 项 | 实测值 |
|---|---|
| 单版本解压后（Linux/Windows 常态） | **≈ 57 MB** |
| 3.7.9 Windows（**含 .pdb**） | 121.9 MB（剔除 .pdb 后 **70.6 MB**） |
| 典型 4 版本（3.7 + 3.9 + 3.12 + 3.13） | **≈ 230 MB**（3.7 剪枝后） |
| 全区间 7 版本（3.8 ~ 3.14） | ≈ 400 MB |

> 容量规划完整公式与工作示例见 `docs/deployment.md`「解释器缓存与私有化模式」段。

---

## 5. 在 docker compose 中挂载缓存池卷

### 5.1 基线 compose 已内置

根 `docker-compose.yml` 已为 `executor-python` 声明命名卷并挂载到池目录：

```yaml
services:
  executor-python:
    environment:
      UV_PYTHON_INSTALL_DIR: /data/interpreters   # 独立于 WORK_DIR(/data/tasks)
    volumes:
      - executor_python_data:/data/tasks          # 任务工作目录（受 TTL 清扫）
      - interpreter_cache:/data/interpreters      # 解释器缓存池（豁免 TTL，体积红线治理）

volumes:
  interpreter_cache:
```

`executor-node` 同样挂载了该卷（同名变量，node 侧客户端执行器同构消费）。

### 5.2 预填已运行的部署（推荐流程）

```bash
# 1) 确认卷名（compose 会给卷加项目名前缀，如 autocodeflow_interpreter_cache）
docker volume ls | grep interpreter_cache

# 2) 在能联网的机器上按 §3 备好池目录（假设在 ./seed/interpreters/）

# 3) 用一次性容器把预填内容拷进卷（卷名按上一步实际值替换）
docker run --rm \
  -v autocodeflow_interpreter_cache:/pool \
  -v "$PWD/seed/interpreters:/seed:ro" \
  alpine sh -c 'cp -a /seed/. /pool/ && ls -la /pool/'

# 4) 重启执行器，确认探测到新解释器
docker compose restart executor-python
docker compose logs --tail=50 executor-python | grep -i interpreter

# 5) 进入容器验证（容器内 uv 是 0.8.17）
docker compose exec executor-python uv python list --only-installed
docker compose exec executor-python sh -c 'uv venv --python 3.7 /tmp/probe && /tmp/probe/bin/python --version'
```

> **权限提示**：执行器容器以非 root 的 `appuser` 运行（见 `apps/executor-python/Dockerfile`）。拷贝进卷的文件需 `appuser` **可读可执行**。若步骤 5 报 `Permission denied`，在步骤 3 的容器里补 `chmod -R a+rX /pool`，并确认 `bin/python3` 有可执行位（§7.3）。

### 5.3 用 bind mount 替代命名卷（可选）

若运维习惯用宿主目录直接管理：

```yaml
# docker-compose.override.yml（运维自建，不进仓库）
services:
  executor-python:
    volumes:
      - /srv/autocodeflow/interpreters:/data/interpreters
  executor-node:
    volumes:
      - /srv/autocodeflow/interpreters:/data/interpreters
```

此时预填就是直接在 `/srv/autocodeflow/interpreters/` 下按 §1.2/§1.3 摆放，无需 §5.2 的拷贝步骤。

### 5.4 ⚠️ 两个执行器共享一卷时：libc 必须各放一份

compose 基线把 `interpreter_cache` 卷同时挂给 `executor-python` 与 `executor-node`，但**两者的基底镜像 libc 不同**：

| 服务 | 基底镜像 | libc | 需要的池目录平台分量 |
|---|---|---|---|
| `executor-python` | `python:3.12-slim`（Debian） | **glibc** | `linux-x86_64-**gnu**` |
| `executor-node` | `node:22-alpine` | **musl** | `linux-x86_64-**musl**` |

**共卷是安全的**（实测：池内混放非本平台命名的条目时，`uv python list --only-installed` 仍 **exit 0**，本平台条目正常列出——uv 按平台分量过滤并**安全跳过**外来条目）。但**产物不能互相顶替**：glibc 构建在 musl 上无法运行，反之亦然（症状见 §7.4）。

因此**离线预填时须按 libc 各放一份**，池内形如：

```
<UV_PYTHON_INSTALL_DIR>/
├── cpython-3.7.9-linux-x86_64-gnu/     ← executor-python 用（Debian/glibc）
└── cpython-3.7.9-linux-x86_64-musl/    ← executor-node 用（Alpine/musl）
```

> 只给一个 libc 预填的后果：另一个执行器**探测不到该版本**，声明它的任务在该执行器上失败 `interpreter_unavailable`（reason=`not_downloadable`）——这属于"配置不完整"而非缺陷。若某执行器本就不承载多版本任务，只填它需要的那个即可。
>
> 若不想共卷，也可给 `executor-node` 单独挂一个卷（语义等价）；compose 基线选择共卷是为了减少卷数量，不影响正确性。

### 5.5 ⚠️ 池内**同平台**损坏条目会拖垮整份清单（重要）

实测发现的一个反直觉行为，排障时必须知道：

| 池内情况 | `uv python list --only-installed` 结果 |
|---|---|
| 只有正常条目 | exit 0，正常列出 |
| + **非本平台**命名的条目（如 linux 名放在 Windows 池） | **exit 0**，正常条目照常列出（安全跳过） |
| + 本平台命名但**载荷不可执行/损坏**的条目 | **exit 2 整条失败**，且**正常条目也一并消失** |

即：一个"名字看着对、但 uv 无法查询其版本"的条目，会让**整个清单探测失败**。

**执行器侧的后果**：`discover_installed()` 对 `uv python list` 非零退出采取 **fail-safe 返回空清单**（不抛异常、执行器仍能启动，见 `interpreters.py` 的 AC-14b 注释）。因此现象是：

- 执行器**不会崩**，日志出现 `interpreters: uv python list --only-installed exited 2: ... — empty pool`；
- 但**所有**解释器都从上报清单消失 → 管理台该执行器 `interpreters` 列为空 → 声明版本的调度被拦；
- 关键点：**池里正常的版本仍然可用**（`uv venv --python 3.8` 实测仍 exit 0），只是**上报**被拖垮了。

**诊断与修复**：

```bash
# 直接跑 uv 看它到底卡在哪一条（错误文本里会给出具体路径）
docker compose exec executor-python uv python list --only-installed

# 按错误信息里的路径删掉/替换那条损坏条目
docker compose exec executor-python sh -c 'ls -la "$UV_PYTHON_INSTALL_DIR"'

# 验证恢复
docker compose exec executor-python uv python list --only-installed   # 期望 exit 0 且列出条目
docker compose restart executor-python
```

**预防**：每次预填后**务必**跑 §3.5 三关验证——第 ① 关（`--only-installed` 能列出）正是拦截此类损坏条目的关卡。**只把校验通过的解释器放进生产池**；不要用未经 `--version` 验证的二手拷贝。

---

## 6. 让新预填的版本被平台感知

预填完成后，**执行器重启即可**（启动时 `discover_installed` 探测一次并随注册上报）：

```bash
docker compose restart executor-python
```

| 步骤 | 观察点 |
|---|---|
| 1 | 执行器启动日志出现解释器探测结果（含新版本） |
| 2 | 管理台「执行器」列表中该执行器的 `interpreters` 列出现新版本（如 `3.7.9`） |
| 3 | 调度侧此后可把声明该版本的任务派发到这台执行器 |

> 运行中新增版本**不必重启**也可被心跳刷新（执行器心跳携带 `interpreters`，缓存池变化时刷新，30 s 周期）。但**重启是最可靠的确认手段**，且能立刻在注册 payload 中看到结果。

---

## 7. 常见故障与诊断

> 以下每条都给出**实测复现的症状原文**，便于运维直接对照日志。

### 7.1 目录名写错（uv 看不见，且不报错）

**症状**：`uv python list --only-installed` **根本不列出**该版本；`uv venv --python 3.7` 报：

```text
error: No interpreter found for Python 3.7 in managed installations, search path, or registry
exit 2
```

**原因**：用了 python-build-standalone 的三元组（`x86_64-pc-windows-msvc` / `x86_64-unknown-linux-gnu`）而不是 **uv 的三元组**（`windows-x86_64-none` / `linux-x86_64-gnu`）。

**诊断**：

```bash
ls -1 "$UV_PYTHON_INSTALL_DIR"          # 看目录名
uv python list --all-platforms --only-downloads | head   # 看 uv 的命名风格
```

**修复**：按 §1.2 对照表重命名目录。这是**最隐蔽**的故障——uv 静默忽略，没有任何"目录名非法"的提示。

### 7.2 摆放层级错（放了压缩包根或 `python/` 目录）

**症状**：`uv python list --only-installed` 不列出；`uv venv --python 3.7` 报：

```text
error: Failed to inspect Python interpreter from managed installations at `<池目录>/python.exe`
  Caused by: Python interpreter not found at `<池目录>/python.exe`
exit 2
```

**原因**：目录名对了（uv 找过来了），但解释器入口不在期望位置——把 `python/` 整层（或压缩包根）拷进去了，实际入口在 `<池目录>/python/install/python.exe`。

**诊断**：

```bash
ls -1 "$UV_PYTHON_INSTALL_DIR/cpython-3.7.9-<平台>-none"
# 正确：直接看到 bin/ include/ lib/ share/      （Linux）
#       直接看到 python.exe DLLs/ Lib/ Scripts/ （Windows）
# 错误：看到 python/ 或 install/
```

**修复**：把 `python/install/` 的**内容**重新拷进池目录（见 §1.3）。

### 7.3 Linux 缺可执行位

**症状**：`uv python list --only-installed` 可能列出该版本，但 `uv venv --python 3.7` 失败，报权限类错误：

```text
error: Failed to query Python interpreter at `.../bin/python3`
  Caused by: Permission denied (os error 13)
```

**原因**：`tar` 解压后经 **U 盘 / SMB 共享 / Windows 中转 / `unzip` 类工具** 传递时丢失权限位。

**诊断**：

```bash
ls -l "$UV_PYTHON_INSTALL_DIR/cpython-3.7.9-<平台>-none/bin/python3"
# 期望：-rwxr-xr-x （必须有 x）
```

**修复**：

```bash
chmod +x "$UV_PYTHON_INSTALL_DIR"/cpython-3.7.9-*/bin/python3
chmod -R a+rX "$UV_PYTHON_INSTALL_DIR"/cpython-3.7.9-*/
```

### 7.4 架构不匹配

**症状**：解释器被 uv 找到，但执行时报"无法执行二进制"：

```text
error: Failed to query Python interpreter at `.../python.exe`
  Caused by: 该版本的 %1 与你运行的 Windows 版本不兼容。 (os error 216)   # Windows
```
```text
cannot execute binary file: Exec format error                            # Linux
```

**原因**：把 x86_64 产物放到了 aarch64 机器（或反之）；或把 musl 产物放到了 glibc 机器。

**诊断**：

```bash
uname -m                        # x86_64 / aarch64
ldd --version | head -1         # glibc；Alpine 上会报 not found → musl
file "$UV_PYTHON_INSTALL_DIR"/cpython-3.7.9-*/bin/python3   # 看架构
```

**修复**：换成匹配架构/ libc 的资产（§3.2）。**musl 与 glibc 产物不可互换**（compose 默认镜像是 `python:3.12-slim` = Debian = **glibc**，用 `linux-x86_64-gnu`；Alpine 基底才用 `linux-x86_64-musl`）。

> **两个执行器共享一卷时**：`executor-node` 是 Alpine/musl，`executor-python` 是 Debian/glibc，**两个 libc 都要各放一份**，否则其中一个探测不到（见 §5.4）。注意"放错 libc"的症状在本节（无法执行）与 §7.1（平台分量不匹配 → 静默忽略）之间取决于**目录名写的是哪个平台**：
> - 目录名写了**本平台**、载荷是**外来平台** → uv 会尝试查询并**失败** → 整份清单 exit 2（见 §5.5，危害最大）；
> - 目录名写了**外来平台**、载荷也是外来平台 → uv 按平台分量**安全跳过**，本平台条目不受影响。

### 7.5 池内同平台损坏条目拖垮整份清单

**症状**：执行器日志出现 `interpreters: uv python list --only-installed exited 2: ... — empty pool`；管理台该执行器 `interpreters` 列为**空**（连原本正常的版本也不见了）；但该执行器上声明版本的调度全被拦。

**原因**：池内存在一个"目录名看着对、但 uv 查询其版本失败"的条目（载荷损坏、被截断、外来平台载荷顶着本平台目录名）。uv 遇到这类条目会**整条命令 exit 2**，而非跳过它。执行器对非零退出 fail-safe 返回空清单，于是**上报被拖垮**（正常版本其实仍可用）。

**诊断**：

```bash
# uv 的错误文本会直接给出出问题的路径
docker compose exec executor-python uv python list --only-installed
```

**修复**：按错误信息里的路径定位并删除/替换该条目，再重启执行器。完整分析与预防见 **§5.5**。

> **这是本手册里危害最大的一类故障**：单条坏数据会让整个执行器"看起来一个解释器都没有"。预防手段就是 §3.5 三关验证——**只把验证通过的解释器放进生产池**。

### 7.6 缓存在池内但被误删 / 池设在 WORK_DIR 内

**症状**：预填成功、任务跑过一次后，某天任务又开始失败 `interpreter_unavailable`。

**原因**：池目录被放在 `WORK_DIR` 之下，被磁盘 TTL 清扫（`DISK_CLEANUP_TTL_DAYS`，默认 7 天）删掉了。

**诊断**：

```bash
docker compose exec executor-python sh -c 'echo "WORK_DIR=$WORK_DIR UV_PYTHON_INSTALL_DIR=$UV_PYTHON_INSTALL_DIR"'
# 确认两者不是包含关系
docker compose logs executor-python | grep -i 'cleanup\|removed'
```

**修复**：把 `UV_PYTHON_INSTALL_DIR` 改为 `WORK_DIR` **之外**的独立路径（默认 `/data/interpreters`）并重新预填。

### 7.7 任务侧看到的现象（`interpreter_unavailable`）

预填缺失/失败最终会以**任务失败**的形式暴露。运维在管理台执行详情看到：

| 项 | 内容 |
|---|---|
| **失败分因** | `interpreter_unavailable` |
| **错误消息**（模板，AC-12a） | `解释器 <X.Y> 无法获取（缓存缺失 + 下载失败：<原因>）；候选执行器: <appName>[已缓存: 3.12.3]` |
| **3.7 专属指引** | 声明 3.7 而缓存缺失时，消息**必须明确指引**："3.7 不支持在线下载，需部署方离线预填解释器缓存卷" |
| **执行记录留痕** | `result.interpreter = {requested, resolved, pool, reason, candidates?}`（FR-12） |

**reason 取值与对应处置**：

| `reason` | 含义 | 运维动作 |
|---|---|---|
| `not_downloadable` | 版本 < 3.8，uv 无法在线下载 | 走本手册离线预填（§3） |
| `download_failed` | 下载源不可达 / 镜像不可达 | 检查外网或配 `UV_PYTHON_INSTALL_MIRROR` |
| `download_timeout` | 超过 `INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS`（默认 300） | 查网络带宽；或调大该值 |
| `mirror_unreachable` | 配了镜像但连不上 | 检查镜像地址与网络策略 |
| `corrupt` | 池内产物损坏（不可执行 / 版本输出异常） | 删除该版本目录后重新预填 |
| `uv_missing` | 找不到 uv 可执行文件（node 侧） | 安装 uv 或确认 `UV_BIN` 指向 |

> **注意 D14**：这些失败是**明确失败**，平台**不会**回退到宿主解释器。理由：静默的版本不匹配比明确失败更危险——任务"看起来跑成功了"但用的是错误版本，问题会推迟到生产环境才暴露。

### 7.8 快速自检清单

```bash
# 一条命令打包全部关键检查（Linux 容器内）
docker compose exec executor-python sh -c '
  echo "--- uv 版本 ---";            uv --version
  echo "--- 池目录 ---";             echo "$UV_PYTHON_INSTALL_DIR"; ls -1 "$UV_PYTHON_INSTALL_DIR"
  echo "--- 池内 3.7 入口 ---";      ls -l "$UV_PYTHON_INSTALL_DIR"/cpython-3.7.9-*/bin/python3 2>/dev/null || echo "缺失"
  echo "--- uv 探测结果 ---";        uv python list --only-installed
  echo "--- venv 探针 ---";          uv venv --python 3.7 /tmp/probe && /tmp/probe/bin/python --version && rm -rf /tmp/probe
'
```

---

## 8. 相关配置项速查

| 变量 | 默认 | 作用 | 文档位置 |
|---|---|---|---|
| `UV_PYTHON_INSTALL_DIR` | `/data/interpreters` | 解释器缓存池根目录（**必须独立于 `WORK_DIR`**） | `apps/executor-python/.env.example` |
| `UV_PYTHON_INSTALL_MIRROR` | （空） | 内网镜像（可选模式 A）；http(s)、无凭据/query/fragment。镜像须复刻 uv 布局 `<mirror>/<tag>/cpython-<版本>%2B<tag>-<pbs三元组>-install_only_stripped.tar.gz`（实测）；**镜像不能提供 3.7**（不在 uv 清单内） | 同上 |
| `INTERPRETER_DOWNLOAD_TIMEOUT_SECONDS` | `300` | 单次下载独立超时（D11） | 同上 |
| `INTERPRETER_SINGLE_VERSION_MB` | `250` | 单版本体积红线（D12） | 同上 |
| `INTERPRETER_TOTAL_GB` | `4` | 缓存池总容量红线（D12） | 同上 |
| `PYTHON_RUNTIME_VERSION_MIN` | `3.7` | 可声明版本下界 | 同上 |
| `PYTHON_RUNTIME_VERSION_MAX` | `3.14` | 可声明版本上界 | 同上 |
| `UV_BIN` | （自动解析） | uv 可执行文件路径（node 侧；desktop 注入内置 uv） | `apps/executor-node/.env.example` |
| `UV_OFFLINE` | （未设） | uv 原生开关：`1` = 禁用一切网络访问。**仅用于排障复现**，不要在部署中常开 | uv 官方 |

---

## 附录 A：本手册命令的实测环境

| 项 | 值 |
|---|---|
| uv A | **0.8.17**（`10960bc13 2025-09-10`，仓库锁定版本） |
| uv B | 0.11.14（`3fdfdc7d4 2026-05-12`，交叉验证） |
| 实测平台 | Windows x86_64（目录命名约定、预填流程、全部故障模式） |
| 资产 | pbs tag `20200822`，3.7.9（linux-gnu / linux-musl / windows-msvc / macos 均已 `HEAD` 验证可达） |
| 已验证结论 | 预填后 `uv python list --only-installed` 列出；`uv venv --python 3.7` exit 0；venv 内 `python --version` = `Python 3.7.9` |

> Linux 侧命令（`chmod`、`cp -a`、bind mount）按 POSIX 语义编写，**未在本机 Linux 上端到端执行**；Linux 产物的内部层级（`python/install/bin/python3`）已通过解压 `cpython-3.7.9-x86_64-unknown-linux-gnu-pgo` 资产实际核对。首次在生产 Linux 执行时请完整跑 §3.5 三关验证。
