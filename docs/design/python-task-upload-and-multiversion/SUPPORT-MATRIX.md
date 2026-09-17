# 《支持矩阵确认单》—— Python 解释器可获取版本区间实测（T01 / D10）

> **状态**：已定稿（T01 阻塞性前置验收项产出物）
> **对应需求**：`docs/requirements/python-task-upload-and-multiversion/REQUIREMENTS.md` §9.1 D10、§9.2 支持版本矩阵、§10 OQ-6
> **对应设计**：`docs/design/python-task-upload-and-multiversion/DESIGN.md` §2.7.2「D10 前置验收项」
> **上游权威**：`docs/design/python-task-upload-and-multiversion/CONTRACT.md` §0（T01 实测结论）——本文件是其可复核的证据展开版，**语义以 CONTRACT.md §0 为准**。
> **实测日期**：2026-09-16
> **实测人**：WS7（部署/配置/运维文档工作流）
>
> ## ⚠️ 效力声明（取代关系）
>
> **本文件取代 `REQUIREMENTS.md` §9.2 中的「支持版本矩阵」**（即 Tier 2 = `3.6 / 3.7 / 3.8 / 3.9`、区间 `3.6~3.14` 的那张表）。
> 取代范围**仅限版本区间与获取方式**；需求文档其余章节（FR/NFR/D1~D14/NG/ASM/EG）的语义不变。
> 差异原因：需求文档 §3 事实 9 引用的是 uv 官方**支持政策**（Tier 1/Tier 2），而 §9.1 D10 要求的实测对象是**本仓库锁定的 uv 0.8.17 实际可下载列表**——两者不一致，按 D10 的分岔规则处置（见 §5）。

---

## 1. 实测环境

| 项 | 值 |
|---|---|
| 宿主平台 | Windows，`x86_64-pc-windows-msvc` |
| uv A（仓库锁定版本） | **uv 0.8.17**（`10960bc13 2025-09-10`）——按 `apps/executor-python/requirements.txt` 锁定值，从 GitHub Releases 取官方二进制隔离运行，未污染宿主安装 |
| uv B（宿主版本，交叉验证） | **uv 0.11.14**（`3fdfdc7d4 2026-05-12 x86_64-pc-windows-msvc`） |
| 隔离方式 | 每次实测独立设置 `UV_PYTHON_INSTALL_DIR` 指向临时目录，互不干扰；`uv python list` 只读探测不下载 |
| 网络 | 直连 Astral CDN / GitHub Releases 可达（在线主路径） |

> 说明：本单的**区间结论**（下界缺失 3.7）来自 uv 内嵌的「可下载版本冻结清单」，与宿主操作系统无关；**离线预填路径**的端到端验证在 Windows 上完成，其目录布局约定对 Linux 同构（见 §7）。

---

## 2. 实测命令与原始输出（证据块）

### 2.1 uv 0.8.17 —— 可下载 CPython 区间

```console
$ uv --version
uv 0.8.17 (10960bc13 2025-09-10)

$ uv python list --all-versions
# （截取：仅统计 "cpython-* <download available>" 行，共 99 条）
# 按主.次版本聚合后的最大补丁号：
3.8  -> max patch 20
3.9  -> max patch 23
3.10 -> max patch 18
3.11 -> max patch 13
3.12 -> max patch 11
3.13 -> max patch 7
3.14 -> max patch 0

$ uv python list --all-versions | Select-String 'cpython-3\.[67]\.'
# （无输出 —— 3.6 与 3.7 一个补丁号都没有）
```

**结论**：uv 0.8.17 的可下载 CPython 区间为 **3.8 ~ 3.14**（含上下界），共 7 个主.次版本。

### 2.2 uv 0.8.17 —— 3.7 声明路径的失败态（逐字输出）

```console
$ uv python install 3.7
error: No download found for request: cpython-3.7-windows-x86_64-none
$ echo $LASTEXITCODE
2

$ uv venv --python 3.7 <dir>
error: No interpreter found for Python 3.7 in managed installations, search path, or registry
$ echo $LASTEXITCODE
2
```

> `uv venv --python 3.7` 在 uv 0.11.x 上额外给出一条 hint（0.8.17 无此 hint）：
> `hint: uv embeds available Python downloads and may require an update to install new versions. Consider retrying on a newer version of uv.`
> ——该 hint 具有误导性：升级 uv 并不能解决 3.7 缺失，见 §2.4。

### 2.3 uv 0.11.14 —— 可下载 CPython 区间

```console
$ uv --version
uv 0.11.14 (3fdfdc7d4 2026-05-12 x86_64-pc-windows-msvc)

$ uv python list --all-versions
# 按主.次版本聚合（cpython 下载可用项）：
3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15
# 其中 3.15 仅有一个预发布项：
cpython-3.15.0b1-windows-x86_64-none                 <download available>

$ uv python install 3.7
error: No download found for request: cpython-3.7-windows-x86_64-none
$ echo $LASTEXITCODE
2

$ uv venv --python 3.7 <dir>
error: No interpreter found for Python 3.7 in managed installations, search path, or registry
hint: uv embeds available Python downloads and may require an update to install new versions. Consider retrying on a newer version of uv.
$ echo $LASTEXITCODE
2
```

**结论**：**升级 uv 不能解决 3.7 缺失**。0.11.14 的下界同样是 3.8（上界多出一个 `3.15.0b1` 预发布项，与 3.7 无关）。

### 2.4 交叉验证汇总

| 观察项 | uv 0.8.17 | uv 0.11.14 |
|---|---|---|
| 可下载 CPython 下界 | **3.8** | **3.8** |
| 可下载 CPython 上界 | **3.14**（3.14.0） | 3.14（稳定）+ 3.15.0b1（预发布） |
| 3.7 可在线下载 | 否（exit 2） | **否（exit 2）** |
| 3.6 可在线下载 | 否 | 否 |
| `uv python install 3.7` 错误文本 | `No download found for request: cpython-3.7-<platform>` | 同 |

---

## 3. python-build-standalone 侧：3.7.9 构建仍然在架

uv 下载不到 3.7，**不代表 3.7 的 CPython 构建不存在**。python-build-standalone 的 `20200822` release 仍托管 3.7.9 资产（实测枚举 `releases/expanded_assets/20200822`，共 21 个资产，其中 3.7.9 与 3.8.5 各 10 个）：

```text
cpython-3.7.9-x86_64-unknown-linux-gnu-pgo-20200823T0036.tar.zst
cpython-3.7.9-x86_64-unknown-linux-gnu-debug-20200823T0036.tar.zst
cpython-3.7.9-x86_64-unknown-linux-musl-noopt-20200823T0036.tar.zst
cpython-3.7.9-x86_64-unknown-linux-musl-debug-20200823T0036.tar.zst
cpython-3.7.9-x86_64-pc-windows-msvc-shared-pgo-20200823T0118.tar.zst
cpython-3.7.9-x86_64-pc-windows-msvc-static-noopt-20200823T0153.tar.zst
cpython-3.7.9-i686-pc-windows-msvc-shared-pgo-20200823T0159.tar.zst
cpython-3.7.9-i686-pc-windows-msvc-static-noopt-20200823T0221.tar.zst
cpython-3.7.9-x86_64-apple-darwin-pgo-20200823T0123.tar.zst
cpython-3.7.9-x86_64-apple-darwin-debug-20200823T0123.tar.zst
```

实测体积（HTTP `HEAD`，`Content-Length`）：

| 资产 | 压缩包体积 |
|---|---|
| `...linux-gnu-pgo-20200823T0036.tar.zst` | 28 357 634 B ≈ **27.04 MiB** |
| `...linux-musl-noopt-20200823T0036.tar.zst` | 25 859 225 B ≈ **24.66 MiB** |
| `...windows-msvc-shared-pgo-20200823T0118.tar.zst` | 31 429 615 B ≈ **29.97 MiB** |
| `...apple-darwin-pgo-20200823T0123.tar.zst` | 23 766 243 B ≈ **22.67 MiB** |

> 这正是 CONTRACT.md §0 所述「tag `20200822` 含 10 个 3.7.9 资产」的完整枚举。

### 3.1 ⚠️ 架构限制：3.7.9 **只有 x86_64 / i686，没有 aarch64**

枚举 `20200822` 的全部 21 个资产，架构维度仅有 **`i686`** 与 **`x86_64`** 两种：

| 架构 | 3.7.9 产物 | 覆盖平台族 |
|---|---|---|
| `x86_64` | ✅ 6 个 | linux-gnu（pgo/debug）、linux-musl（noopt/debug）、windows-msvc（shared-pgo/static-noopt）、macos（pgo/debug） |
| `i686` | ⚠️ 2 个 | 仅 windows-msvc（32 位，非平台支持形态） |
| `aarch64` / `arm64` | ❌ **0 个** | — |

补充核查：后续 tag（`20201005` / `20201006` / `20210724` / `20220318` / `20221002` / `20230116`）**已不再提供 3.7.x 的任何构建**（3.7.x 资产数均为 0）。

**结论**：**3.7 仅在 `x86_64` 架构上可通过离线预填获得**（本平台 compose 默认镜像 `python:3.12-slim` 即 linux/amd64，命中此形态）。在 `aarch64` 执行器上，**3.7 无任何可用产物**，须按"该架构不支持 3.7"处置——或在 x86_64 执行器上承载 3.7 任务（经 group/tags 定向派发）。

> 该限制**只影响 3.7**。3.8~3.14 有完整 aarch64 产物（实测 `uv python list --all-platforms --all-arches --only-downloads` 含 `linux-aarch64-gnu` / `linux-aarch64-musl` / `macos-aarch64-none` / `windows-aarch64-none`），在线下载主路径不受影响。

---

## 4. 实测结论汇总

| 结论项 | 实测结果 |
|---|---|
| 需求文档假设区间（§9.2 / 事实 9） | `3.6 ~ 3.14`（Tier 1 = 3.10~3.14；Tier 2 = 3.6/3.7/3.8/3.9） |
| uv 0.8.17 **实际**在线可下载区间 | **`3.8 ~ 3.14`** |
| uv 0.11.14 实际在线可下载区间 | **`3.8 ~ 3.14`**（+ `3.15.0b1` 预发布） |
| 3.6 能否在线下载 | **否**（两个 uv 版本皆否） |
| 3.7 能否在线下载 | **否**（两个 uv 版本皆否） |
| 升级 uv 能否补上 3.7 | **否**（已交叉验证 0.11.14） |
| 3.7.9 的 python-build-standalone 构建是否存在 | **是**（tag `20200822`，四个平台族齐备） |
| 离线预填 3.7 能否被 uv 识别并可用 | **是（端到端实测打通，见 §7）** |
| **差异结论** | **需求假设区间（3.6~3.14）在线不可达** —— 下界差 2 个主.次版本（3.6、3.7） |

---

## 5. D10 分岔处置（DESIGN.md §2.7.2 第 4 步）

DESIGN.md §2.7.2 给出的分岔规则：

> - 一致 → 维持 uv 0.8.17，固化 `runtime-version.util.ts` 常量与产品文档；
> - 不一致 → 按 OQ-6 授权升级 uv / 配置镜像源并重新锁定 executor 依赖。

**实测结果与需求假设不一致**（见 §4）。经负责人确认，**不采用"升级 uv"分支**，理由与所选路径如下：

### 5.1 为什么"升级 uv"分支被否决

OQ-6 授权的前提是"升级 uv 可以补上缺失的下界版本"。实测证否：**uv 0.11.14（远高于锁定的 0.8.17）的可下载下界同样是 3.8**（§2.3）。升级 uv 只会引入执行器依赖基线变更（`requirements.txt` + Dockerfile 冒烟更新 + 重跑本清单），**换不来 3.7，也换不来 3.6**，属于纯风险无收益。uv 内嵌的下载清单受 Astral 上游对 python-build-standalone 的版本冻结策略约束，不是"新版本 uv 就会补老版本"。

### 5.2 为什么"配置镜像源"分支不足以覆盖 3.7

`UV_PYTHON_INSTALL_MIRROR` 的语义是**替换下载源**（镜像必须复刻 uv 期望的目录结构：`<mirror>/<tag>/cpython-<version>+<tag>-<platform>-install_only_stripped.tar.gz`，实测报错文本见 §6.2）。它**不改变 uv 内嵌的可下载版本清单**——3.7 在清单里就不存在，镜像放什么都不会被查询到。因此镜像可以解决"外网不可达"，但解决不了"版本不在冻结清单里"。

### 5.3 选定路径（最终）

1. **维持 uv 0.8.17**（`apps/executor-python/requirements.txt` 锁定值不变，CON-01 依赖基线不变）。
2. **3.7 走"离线预填缓存卷"通道**：把 python-build-standalone `20200822` 的 3.7.9 产物按 uv 的目录布局约定预置进 `<UV_PYTHON_INSTALL_DIR>/cpython-3.7.9-<uv平台三元组>-none/`。该路径已端到端实测打通（§7），并被 uv 的 `--only-installed` 探测与 `--python 3.7` 解析正常识别。
3. **3.6 及以下拒绝声明**（NG-09 修正：需求 §9.2 矩阵中的 `3.6` 应删除）。

> 处置结论已获负责人确认，落点见 CONTRACT.md §0.1 与 §1.1（`RUNTIME_VERSION_MIN="3.7"` / `RUNTIME_VERSION_MAX="3.14"` / `ONLINE_DOWNLOAD_MIN="3.8"`）。
> 运维侧操作步骤见 [`OFFLINE-PROVISIONING.md`](./OFFLINE-PROVISIONING.md)。

---

## 6. 支持矩阵（定稿 —— 取代 REQUIREMENTS.md §9.2）

### 6.1 矩阵

| 层级 | 版本 | 获取方式 | 验收样本 |
|---|---|---|---|
| **Tier 1（完全支持）** | 3.10 / 3.11 / 3.12 / 3.13 / 3.14 | **在线动态下载**（主路径，必有） | **3.13**、**3.12** |
| **Tier 2（在线可用）** | 3.8 / 3.9 | **在线动态下载** | **3.9** |
| **Tier 2·扩展（仅离线预填）** | **3.7** | **仅离线预填缓存卷**（在线下载不可用） | **3.7**（限 x86_64 架构，见 §3.1） |
| **不支持** | < 3.7（含 **3.6**）、> 3.14 | 拒绝声明 | — |

### 6.2 语义定稿

| 语义 | 值 | 配置落点 |
|---|---|---|
| **可声明区间** | `3.7 ~ 3.14`（默认，可配置） | `PYTHON_RUNTIME_VERSION_MIN` / `PYTHON_RUNTIME_VERSION_MAX` |
| **在线可下载区间** | `3.8 ~ 3.14` | `ONLINE_DOWNLOAD_MIN = "3.8"`（执行器 + admin 共用） |
| **3.7 的定位** | "离线预填扩展"——在线下载**必然失败**，必须由部署方预填缓存卷；**且仅限 x86_64 架构**（aarch64 无 3.7.9 产物，见 §3.1） | 见 `OFFLINE-PROVISIONING.md` |
| **3.7 未预填时的行为** | 任务失败分因 `interpreter_unavailable`，错误消息**必须明确指引**："3.7 不支持在线下载，需部署方离线预填解释器缓存卷" | 执行器 `interpreters.py` + admin `inferFailureReason` |
| **版本格式** | `^\d+\.\d+$`（主.次，无补丁号） | DTO + 执行器双侧 |
| **匹配语义** | 前缀匹配（`3.7` 命中 `3.7.9`；`3.1` **不**命中 `3.13.0`） | D1 |
| **NG-09 修正** | 不支持区间外版本；**3.6 及以下拒绝**；不承诺验证每个补丁号 | — |

### 6.3 与需求文档的逐行差异

| 需求 §9.2 原文 | 本单定稿 | 差异性质 |
|---|---|---|
| Tier 2 = `3.6 / 3.7 / 3.8 / 3.9` | Tier 2 = `3.8 / 3.9`；3.7 单列为「Tier 2·扩展（仅离线预填）」 | **删除 3.6；3.7 降级为离线通道** |
| 区间 `3.6~3.14` | 区间 `3.7~3.14`（可声明）/ `3.8~3.14`（在线） | **下界上移** |
| 「3.6 为区间下界、属政策边缘」 | 3.6 **不支持**，声明即拒绝 | **NG-09 修正** |
| 「须 D10 实测确认可下载」 | 已实测：**3.6/3.7 不可在线下载** | **实测闭环** |

---

## 7. 离线预填路径的端到端实测（3.7.9 / Windows）

这是本单最关键的一条：**"3.7 只能离线预填"必须同时证明"离线预填确实能work"**，否则 3.7 就应当直接判为不支持。

### 7.1 实测步骤与输出

```console
# 1) 下载 python-build-standalone 20200822 的 3.7.9（windows-msvc x86_64）
#    29.97 MiB，实测 15.6s
$ curl -L -o pbs-3.7.9-win.tar.zst \
    https://github.com/astral-sh/python-build-standalone/releases/download/20200822/cpython-3.7.9-x86_64-pc-windows-msvc-shared-pgo-20200823T0118.tar.zst

# 2) 解压（bsdtar 3.8.4，libzstd 1.5.7 —— 原生支持 .tar.zst）
$ tar -xf pbs-3.7.9-win.tar.zst -C x
$ ls x
python
$ ls x/python/install
DLLs  include  Lib  libs  Scripts  tcl  LICENSE.txt
python.exe  python3.dll  python37.dll  pythonw.exe  vcruntime140.dll  (*.pdb)

# 3) 把 python/install/* 的内容（不是 archive 根，不是 python/ 目录）放进池目录
$ mkdir -p "$UV_PYTHON_INSTALL_DIR/cpython-3.7.9-windows-x86_64-none"
$ cp -r x/python/install/* "$UV_PYTHON_INSTALL_DIR/cpython-3.7.9-windows-x86_64-none/"

# 4) uv 0.8.17 探测识别
$ uv python list --only-installed
cpython-3.14.6-windows-x86_64-none   C:\Python314\python.exe
...
cpython-3.7.9-windows-x86_64-none    <UV_PYTHON_INSTALL_DIR>\cpython-3.7.9-windows-x86_64-none\python.exe
#                                    ^^^^^^^^^^^^^^^^^^^^^^ 出现在清单中

# 5) uv 0.8.17 建 venv
$ uv venv --python 3.7 <venv-dir>
Using CPython 3.7.9
Creating virtual environment at: <venv-dir>
Activate with: <venv-dir>\Scripts\activate
$ echo $LASTEXITCODE
0

# 6) venv 内解释器版本核验
$ <venv-dir>/Scripts/python.exe --version
Python 3.7.9
```

### 7.2 实测要点

- **uv 版本无关性**：同一布局在 uv 0.8.17 与 uv 0.11.14 下**均被识别**（两个版本都做过步骤 4/5/6）。
- **`<platform>` 必须用 uv 自己的平台三元组**，**不是** python-build-standalone 的平台三元组（见 §8.1 与 `OFFLINE-PROVISIONING.md` §2 对照表）。
  > 该命名陷阱已在 **`CONTRACT.md` §0.2 勘误（v1.1）** 中正式记录（含 uv↔pbs 三元组对照表与实测证据）。正确形式：`cpython-3.7.9-linux-x86_64-gnu`（而非 pbs 形式的 `cpython-3.7.9-x86_64-unknown-linux-gnu-none`）。执行器侧提示文案与测试夹具已同步更正。
  >
  > ⚠ **另注意不要多补 `-none`**：目录名全形是 `cpython-<完整版本>-<uv三元组>`，三元组之后没有东西。`windows-x86_64-none` 里的 `-none` 是三元组**自身的 libc 槽位**；Linux 的 libc 槽位是 `gnu`/`musl`，故 **Linux 目录名不带 `-none`**。实测 `cpython-3.7.9-linux-x86_64-gnu-none` 会被 uv 判为非法请求 / 静默忽略（详见 `OFFLINE-PROVISIONING.md` §1.2 陷阱二）。
- 预填完成后，`uv venv --python 3.7` 走的是**纯本地解析**，不触网。

---

## 8. 容量规划输入（NFR-12 / NFR-15）

### 8.1 实测体积与耗时

| 项 | 实测值 | 说明 |
|---|---|---|
| 单版本**压缩包**体积 | 21 ~ 30 MiB | 3.7.9 linux-gnu 27.04 MiB / linux-musl 24.66 MiB / windows-msvc 29.97 MiB / macos 22.67 MiB |
| 单版本**解压后**体积 | **≈ 57 MB**（linux/windows 常态） | CONTRACT.md §0 记录 3.8.20 ≈ 57.4 MB；本单实测 3.9.25（uv 下载）**59.3 MB** |
| 3.7.9 解压后（windows-msvc **带 .pdb 调试符号**） | **121.9 MB** | 其中 **51.3 MB 是 `.pdb` 调试符号**；剔除后 **70.6 MB**（剔除后 uv 仍正常识别、venv 仍可创建，已实测） |
| **首次下载耗时** | **≈ 13 s**（3.8.20，20.6 MiB + 安装） | 本单复测同量级：3.9.25（21.7 MiB）**16.2 s**；3.7.9 压缩包 29.97 MiB **15.6 s** |
| D11 默认超时余量 | 300 s ÷ ≈13~17 s ≈ **18~23 倍余量** | 300 s 默认值充裕，弱网现场可下调 |

> **⚠️ 3.7.9 的体积提示**：python-build-standalone 2020 年的 windows 产物内嵌 `.pdb` 调试符号，解压后 121.9 MB —— 仍**低于 D12 的 250 MB 单版本红线**，但余量（约 128 MB）小于其他版本（约 190 MB）。若需压缩占用，可在预填时剔除 `*.pdb`（实测不影响 uv 识别与 venv 创建）。Linux 产物无此问题。

### 8.2 容量公式（与部署文档同源）

```
缓存池总占用 = Σ(已预填/已下载版本数 × 单版本解压后体积)
约束：版本数 × 单版本体积(≤ 250MB) ≤ 缓存池总上限(默认 INTERPRETER_TOTAL_GB = 4GB)
```

| 场景 | 版本数 | 估算占用 | 占 4 GB 比例 |
|---|---|---|---|
| 最小（仅宿主 3.12） | 1 | ≈ 57 MB | 1.4% |
| 典型（3.9 + 3.12 + 3.13） | 3 | ≈ 172 MB | 4.3% |
| 验收矩阵全量（3.7 + 3.9 + 3.12 + 3.13） | 4 | **≈ 230 MB**（含 3.7.9 未剪枝时 ≈ 290 MB） | 5.6% ~ 7.1% |
| 全区间（3.8 ~ 3.14） | 7 | ≈ 400 MB | 10% |
| 红线触发 | 17 | 17 × 250 MB ≈ 4.25 GB > 4 GB | **触发最久未使用回收** |

### 8.3 uv 0.8.17 冻结清单的最大补丁号（容量测算的下界锚点）

| 主.次 | 最大可下载补丁号 | 主.次 | 最大可下载补丁号 |
|---|---|---|---|
| 3.8 | 3.8.20 | 3.12 | 3.12.11 |
| 3.9 | 3.9.23 | 3.13 | 3.13.7 |
| 3.10 | 3.10.18 | 3.14 | 3.14.0 |
| 3.11 | 3.11.13 | 3.7 | **（不在清单内）**——离线预填固定 **3.7.9** |

---

## 9. 后续动作与回归触发条件

| # | 动作 | 责任面 | 状态 |
|---|---|---|---|
| 1 | `runtime-version.util.ts` 常量固化：`MIN="3.7"` / `MAX="3.14"` / `ONLINE_MIN="3.8"` | admin-api（T02） | 由代码工作流落地 |
| 2 | 执行器 `ONLINE_DOWNLOAD_MIN="3.8"`：`< 3.8` 直接给"需离线预填"提示，不发起必然失败的下载 | executor-python（T11） | 由代码工作流落地 |
| 3 | admin-web 版本选择器按 Tier 1 / Tier 2 / Tier 2·扩展（离线）三层展示 | admin-web（T21） | 由代码工作流落地 |
| 4 | 部署文档增「解释器缓存与私有化模式」段 + 运维 runbook | 本文档工作流（WS7） | ✅ 见 `docs/deployment.md` / `docs/operations.md` / `OFFLINE-PROVISIONING.md` |
| 5 | `PYTHON_RUNTIME_VERSION_MIN` / `_MAX` 配置项文档化 | 本文档工作流（WS7） | ✅ 见 `apps/executor-python/.env.example` |

**重跑本单的触发条件**（任一满足即须重跑并回写本文件）：

1. 执行器 uv 版本变更（`apps/executor-python/requirements.txt` 的 `uv==` 锁定值变化）；
2. Astral 上游变更 python-build-standalone 的托管 release（`20200822` 下架或 3.7.9 资产移除）→ 3.7 的离线通道随之失效，须重新评估 3.7 是否降级为"不支持"；
3. 需求方要求支持 3.6 或 > 3.14 的版本；
4. 出现自建镜像/自定义 `--python-downloads-json-url` 方案（会改变"可下载清单"的语义边界）。

---

## 附录 A：本单与 CONTRACT.md §0 的对应关系

| CONTRACT.md §0 结论项 | 本单证据位置 |
|---|---|
| 0.8.17 区间 3.8~3.14 | §2.1、§2.4 |
| 3.6/3.7 不可在线下载 | §2.2、§2.4 |
| uv 0.11.14 同样不含 3.7 | §2.3、§2.4 |
| pbs `20200822` 含 3.7.9 的 10 个资产 | §3 |
| 离线预填被 uv 识别（已实测打通） | §7 |
| 单版本 ≈57MB、首次下载 ≈13s | §8.1 |
| 支持矩阵 Tier 1 / Tier 2 / Tier 2·扩展 | §6.1 |
