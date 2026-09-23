# ADR-017: 执行器唯一标识——设备指纹 + 安装实例盐（`address` 降级为可达性元数据）

状态：Accepted（阶段 1 + 阶段 2 已落地并验收；阶段 3 待实施）

> 落地进度见文末「实施记录」。本 ADR 的决策已定，分阶段执行中——
> `deviceFingerprint` 目前在库中**只被采集与观测，不参与任何定位**。

## 背景

### 触发事故（2026-09-23 生产反馈）

中台上传的应用只部署到执行器 A，但创建任务下发时却是执行器 B 在运行；B 的客户端「本地已部署应用」列表为空，A 的列表有该应用。排查报告见
[`docs/reviews/executor-identity-and-dispatch-mismatch-2026-09-23.md`](../reviews/executor-identity-and-dispatch-mismatch-2026-09-23.md)。

排查定位到**两个独立缺陷**：

1. **部署位置未传递到任务派发**（无条件复现，本次现象主因）——应用清单注册任务时只传 `applicationId`、不传 `executorId`，`dispatch()` 全机队分支的过滤链中没有任何一环检查「该执行器是否部署了这个应用」。
2. **`address` 被当作执行器唯一身份**（条件性，NAT 下碰撞即触发）——本 ADR 要解决的问题。

### 为什么这是架构决策而非普通代码改动

`address` 目前同时承担**四种互不相容的职责**：

| 职责 | 锚点 | 对 `address` 的要求 |
|---|---|---|
| 数据库唯一键 / 注册幂等键 | `executor.entity.ts:38`（`uq_executors_address`）、`executor.service.ts:965` | **不可变**、全局唯一 |
| 出站路由目标（push 模式 HTTP） | `executor.service.ts:2297` `getExecutorUrl(address, ...)` | **可变**（机器换网即变） |
| pull 队列分片键 | `executor-pull.service.ts:86-93`（`acf:pull:{executorId}`） | 全局唯一、**不可猜测** |
| 用户可见身份（UI 展示） | `AppDeploymentPage.tsx:401`、`ApplicationDetailPage.tsx:537` | **人类可读**、稳定 |

而 `address` 实际的性质是：**执行器自报**（`config.ts:84-85` → `EXECUTOR_ADDRESS_PUBLIC || EXECUTOR_ADDRESS`）、
桌面端默认取局域网 IP + 8002（`uv-paths.ts:275,282-287` + `network-util.ts:11-23`）。

即：**一个自报、可变、NAT 下可碰撞、且不保证可读的网络定位符，被当成了全局唯一身份。**

仓库自身已承认此矛盾 —— `ExecutorInstallWizardPage.tsx:73-74` 注释原文：

> 唯一键是 address，appName 不唯一

### 现存候选标识无一可用

| 字段 | 位置 | 性质 | 为何不可用 |
|---|---|---|---|
| `executors.id` | `executor.entity.ts:40` | 中台生成 UUID | 唯一且稳定，但**注册时不用它定位行**（用 address），故「哪台机器对应此 id」无保证 |
| `executorStartupId` | `executor.entity.ts:97` | 每进程随机 UUID（`startup-identity.ts:17-18`） | **每次重启即变**，仅做幂等/重启检测 |
| `appName` | `executor.entity.ts:41` | `APP_NAME` env，默认 `executor-node-1` / `os.hostname()` / `executor-node-$(hostname)` | 非唯一、无约束 |
| `EXECUTOR_ID` | `config.ts:86` | env，默认空串 | **全仓唯一用处**是 `update-package.ts:160,180` 上报，注册身份完全不用它 |

### 碰撞后果（已确认的四条，均为静默故障）

两台不同内网机器只要网段相同（`192.168.1.100:8002` 极常见）即命中**同一行**：

1. **注册互相覆盖**：B 注册改写 A 行的 `appName`/`capabilities`/`startupId`（`executor.service.ts:1047-1074`），两台共享一个 `id`、一份 `tokenHash`、一个 `runningTaskCount`。
2. **pull 队列被抢**（本事故的另一条独立通路）：`executor.controller.ts:407,437` 两台解析到同一 `executor.id`，长轮询同一条 Redis 队列，谁先 `RPOP` 谁执行 —— 部署命令与任务载荷都会串台。
3. **重启恢复互相误杀**：`hasExecutorRestarted`（`executor.service.ts:504-524`）比对 `startupId`，交替上报使 `didRestart` 反复为真，`failRunningExecutionsAfterRestart` 按 `executorAddress` 把**对方正在跑的任务**判成 `EXECUTOR_RESTART`（`executor.service.ts:708-726`）。
4. **token 轮换战**：`sameProcess=false` → 每次注册都 `rotateToken()`（`executor.service.ts:1190-1199`），两台互相吊销对方的 per-executor token。

这解释了事故「偶发、难复现、时好时坏」的特征 —— 取决于哪台先轮询、哪台先注册。

### 约束

- **兼容性红线**：存量执行器（含未上报 `startupId` 的旧版本）不得因缺新字段被拒注册或改变现有行为。
- **多平台**：executor-node / executor-python / executor-desktop 三端必须同源实现（对齐 ADR-005 的「同 commit」纪律）。
- **不可破坏现有唯一索引语义**：`uq_executors_address` 在迁移期必须仍能约束存量行。
- **失败姿态**：标识采集失败（如容器无 `/etc/machine-id`）不得阻断执行器启动。

## 决策

1. **引入 `deviceFingerprint` 作为执行器的稳定唯一身份**，由**设备指纹**与**安装实例盐**两段拼接：

   - 设备指纹（跨重启稳定，标识「这台机器」）：
     - Windows：注册表 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`
     - Linux：`/etc/machine-id`，回退 `/var/lib/dbus/machine-id`
     - macOS：`ioreg -rd1 -c IOPlatformExpertDevice` 的 `IOPlatformUUID`
     - 容器/兜底：以上均不可得时，回退「首个非 loopback 网卡 MAC + 主机名」的哈希
   - 安装实例盐（标识「这份安装/这个工作目录」，解决同机多实例与克隆镜像）：
     首次启动生成随机 UUID，持久化于**可写数据目录**
     （桌面端 `app.getPath('userData')`，裸机 `WORK_DIR`），随执行器数据一起备份/迁移。
   - `deviceFingerprint = sha256(deviceId + ":" + installSalt)`，**只上报哈希，绝不上报原始 machine-id**
     （原始值属主机敏感信息；哈希足以做唯一性与冲突检测，且不可反查）。

2. **注册与心跳幂等键由 `address` 改为 `deviceFingerprint`**：
   - 注册先按 `deviceFingerprint` 定位行；命中则**更新其 `address`**（机器换网 = 同一台机器的地址变更，而非新执行器）。
   - `address` **降级为纯可达性元数据**，不再参与身份判定；保留 `uq_executors_address` 唯一约束但语义改为
     「同一时刻一个地址只能被一台执行器占用」，冲突时按第 4 条处置。

3. **`executors.id`（UUID）成为唯一的对外身份**，`deviceFingerprint` 仅作内部幂等/冲突检测键：
   - UI 展示、API 引用、审计、通知一律使用 `id`（配 `appName` 供人读）。
   - pull 队列键 `acf:pull:{id}` / `acf:cmd:{id}` 天然获得不可猜测性与全局唯一性（UUID 由中台生成，执行器无法自选）。

4. **地址冲突的处置姿态**（承接已落地的 P0 检测）：
   - 同一 `address` 上检出两个并存进程生命（判据见 `executor-address-conflict.util.ts`）→
     **保留先注册者**，后到者注册被拒（`409`），并在响应中明确告知其 `deviceFingerprint` 与已占用该地址的执行器 `id`。
   - 被拒执行器以退避重试注册，运维需为其配置唯一的 `EXECUTOR_ADDRESS_PUBLIC`（或启用 pull 模式）。
   - **不静默覆盖**：这是本 ADR 与现状最关键的差异 —— 宁可让第二台机器注册失败并可见，也不让它悄悄顶掉第一台。

5. **`address` 可重复的新语义**：pull 模式下 `address` 对路由无意义（执行器零入站），
   故 pull 执行器**允许** `address` 不唯一，冲突检测对其降级为 warn（不影响功能，仅提示运维）。
   push 执行器仍强制唯一（否则无法路由）。

6. **迁移分阶段，且必须可回滚**：
   - 阶段 1（已落地）：`address` 冲突检测 + ERROR 告警（本 ADR 的 P0 切片，零行为变更）。
   - 阶段 2：执行器上报 `deviceFingerprint`，中台落列（可空）+ 双写；**不改变**定位逻辑，仅采集与观测冲突率。
   - 阶段 3：注册定位切换为 `deviceFingerprint`，`address` 降级；`deviceFingerprint` 列加非空约束（存量行回填为 `legacy:${address}` 并标记待升级）。
   - 每阶段独立可发布、可回滚；阶段 3 需在灰度环境验证存量执行器（未上报指纹）不被拒。

7. **读面富化**：`app_deployments` / `task_executions` 读面返回 `executorId` + `executorAppName`，
   前端展示「`appName`（`id` 前 8 位）」，地址折叠进 tooltip。存量行 `executorId` 可空 → 回落显示地址并标注「历史记录」。

## 后果

### 正向收益

- 消除「同一 address 两台机器共享一行」引发的四类静默故障（注册覆盖、队列被抢、重启误杀、token 轮换战）。
- `address` 换网/换 IP 不再产生「新执行器」幽灵行与历史断裂。
- pull 队列键获得不可猜测性（消除「猜 executorId 抢任务」的越权面）。
- UI 有稳定、可读、唯一的展示身份，回答「部署到哪台机器」不再依赖会变的网络地址。
- 冲突从静默变为**可见且被拒绝**，运维有明确处置路径。

### 代价与边界

- **需要三端同批发布**（node/python/desktop），否则旧端不上报指纹，阶段 3 无法启用。这是 ADR-005「同 commit」纪律的又一次适用。
- **容器场景指纹可能重复**：同一镜像克隆出的多容器若 `/etc/machine-id` 相同，会被判为同一设备 —— 安装实例盐正是为此设计（每实例首次启动生成独立盐），但**要求可写数据目录不被多实例共享**。
- **设备指纹不是防伪造凭据**：执行器可自报任意指纹（与今日 `address` 同等可伪造）。它解决的是**唯一性与稳定性**，不是**认证**。认证仍由 per-executor token 承担（ADR-003 / ADR-012）。
- 存量行需要一次回填（`legacy:${address}`），期间新旧语义并存，读面必须容忍两种形态。
- 冲突拒绝会让「配错地址」的第二台机器**注册失败**（现状是静默顶替）—— 这是刻意的姿态转变，需要在部署文档与安装向导中明确提示。

### 可执行验收项

阶段 1、2 已完成的项标注 ✅ 并注明落地位置；其余为阶段 3 的验收项。

- [x] ✅ **阶段 2** 单测：`deviceFingerprint` 三平台取值（Windows/Linux/macOS）+ 全部不可得时的 MAC 兜底。
      `apps/executor-node/src/device-identity.spec.ts`（30 例）+ `apps/executor-python/tests/test_device_identity.py`（52 例）。
- [x] ✅ **阶段 2** 单测：安装盐持久化 —— 重启不变、删盐后重新生成、盐与设备 ID 不同组合产生不同指纹。
      同上两文件；另含「kind 分域 → 不同盐文件」的断言。
- [x] ✅ **阶段 2** 单测：四类 fail-open（无 machine-id / 注册表不可读 / 数据目录只读 / 探测抛错）一律 `null` 且不阻断注册。
      同上；`getDeviceFingerprint()` 永不抛。
- [x] ✅ **阶段 2** 单测：中台三态双写（首注册落列 / 重注册采纳 / 心跳采纳）+ **缺省/非法一律不动 DB**。
      `apps/admin-api/src/modules/executor/__tests__/executor.service.spec.ts` 的 ARCH-36 接线块（16 例）。
- [x] ✅ **阶段 2** 单测：观测判据两类分向、各自零误报（同址双指纹 = 硬冲突；同指纹换址 = 漂移非冲突）+ 节流。
      `apps/admin-api/src/modules/executor/__tests__/executor-fingerprint.util.spec.ts`（31 例）。
- [x] ✅ **阶段 2** 单测：**存量执行器（无 fingerprint）行为与引入前逐字节一致** —— 不登记、不告警、不写库。
      接线块「未上报指纹的旧执行器不触发任何告警」+ util「存量执行器（指纹缺省/非法）…」两例。
- [x] ✅ **阶段 2** CI：`check-index-drift` 覆盖新增索引（28 个命名 `@Index`，无漂移）；
      三端指纹算法一致性由 **`packages/executor-protocol/device-identity.vectors.json` 金向量**保证
      —— node spec 与 python test **共读同一份向量文件**，任一端算法漂移即双端测试同时失败
      （阶段 3 后该一致性是硬前提，故提前以共享金向量锁死）。
- [ ] **阶段 3** 单测：**同一 address 不同 fingerprint → 后到者 409**；同一 fingerprint 不同 address → **更新地址而非新建行**。
- [ ] **阶段 3** 单测：存量执行器（无 fingerprint）走 `legacy:${address}` 路径，行为与引入前逐字节一致。
- [ ] **阶段 3** 迁移测试：`deviceFingerprint` 加列 → 回填 → 加非空约束的三步可回滚（对齐 `check-migrations.mjs`）。
      （阶段 2 只做了第一步加列 + 非唯一索引：`1790000000038-AddExecutorDeviceFingerprint`。）
- [ ] **阶段 3** 真机冒烟（ADR-008）：两台同网段机器（模拟地址碰撞）→ 第二台注册被拒且日志/告警可见。
      （阶段 2 的观测面已能让该场景**可见**并发出 ERROR 告警 + 列出并存指纹，但尚不拒绝。）
- [ ] **阶段 3** 真机冒烟：pull 执行器换 IP 后不产生新行，历史执行记录连续。
- [ ] 文档：`docs/atlas/04-flows/executor-registration.md` 的「注册幂等键」一行改述；
      安装向导提示唯一地址要求。（阶段 2 已在 atlas 增补 `deviceFingerprint` 采集说明；
      幂等键改述属阶段 3——现在改会与实现不符。）

## 实施记录

### 阶段 1 —— `address` 冲突检测（ARCH-34，已落地）

`executor-address-conflict.util.ts` + `executor.service.ts` 接线（register/heartbeat 两入口共用
一个跟踪器，命中 ERROR 级通知 + 10min 节流 + fail-open）。判据是「**被顶替的**进程生命重新
上报」而非「同 address 出现不同 startupId」——后者是正常重启的形状，会致每次重启误报。

### 阶段 2 —— 指纹采集与观测（ARCH-36，已落地）

零定位变更；可独立发布与回滚。落地内容与**对本文档的两处收紧**如下。

**A. 三端采集（协议 v2 → v3）**

- `packages/executor-protocol/protocol.json`：`currentProtocolVersion` 2 → 3，矩阵新增条目，
  `deviceFingerprint` 定义为 **executor → admin 可选字段**。
- 构成：`deviceFingerprint = sha256(deviceId + ":" + installSalt)`，64 位小写十六进制。
  `deviceId` 见决策第 1 条；探测用 `execFileSync` **argv 式调用（不经 shell）** + 2s 超时，
  防某些环境下 `reg`/`ioreg` 挂死拖住启动。
- 实现位置：`apps/executor-node/src/device-identity.ts`、`apps/executor-python/device_identity.py`。
  desktop 端**无需改代码**——它以 bundle 形式内嵌 executor-node，`process.versions.electron`
  有值即判定为 `desktop` 分域。
- **desktop bundle 已按 ADR-005 同 commit 重打**（`executor-node-bundle.sha256`：
  `56e16540…` → `f528b16c…`）。漏打的话 CI 的 `desktop-bundle-drift` 会红，而且
  **发布物**里桌面端内嵌执行器仍是旧行为——桌面端不上报指纹，本阶段的冲突观测在桌面端
  整片缺失，阶段 3 的前置条件也不成立。该清单历史上已因同一原因报红三次。

**B. 收紧 1：安装盐按执行器 `kind` 分域（ADR 未写明，实现期补充）**

盐文件路径为 `<workDir>/.device-identity/<kind>.salt`。理由：同一台机器、同一个 `workDir` 上
并存的 node 与 python 执行器是**两个逻辑执行器**；若共用一个盐，二者指纹相同 → 阶段 3 以指纹
为定位键时会被折叠成**同一行**，正是本 ADR 要消灭的那类故障。ADR 对 `installSalt` 的定义本就是
「标识**这份安装**」= 这个工作目录，两种执行器各自安装、各是一个实例，故按 kind 分域是**忠于
定义**而非偏离。`EXECUTOR_INSTANCE_KIND` 可显式覆盖（运维在同一 workDir 跑多实例时用它分域）。

> 目录形态（而非顶层多文件）是刻意的：workDir 清扫只遍历**顶层**条目，保护一个目录名即可护住
> 所有 kind；平铺成顶层裸文件会让保护名单随 kind 数量增长，漏加一个就是「指纹每周漂移」的静默故障。

**C. 收紧 2：观测面区分「硬冲突」与「地址漂移」（ADR 只说冲突率）**

`executor-fingerprint.util.ts` 同时输出两个方向，各自零误报：

| 方向 | 判据 | 语义 | 处置 |
|---|---|---|---|
| 硬冲突 | 同一 `address` 上出现第二个不同指纹 | 两台机器/两份安装共用一行 | ERROR 日志 + 通知（同 P0 级别） |
| 地址漂移 | 同一指纹上报了一个**新**地址 | 机器换网/换 IP，**正常** | 仅 info 日志，不告警 |

把漂移报成冲突会让每次换网都告警（狼来了），故必须分开。

**D. 落地中发现并修掉的静默故障：workDir TTL 清扫会删掉盐**

workDir **顶层的一切（含文件）**都会被 TTL 清扫按 mtime 删除，盐若放在顶层会被 weekly
（`LOG_RETENTION_DAYS`）清掉 → **每周静默漂移一次指纹**（而漂移会伪装成「换网」，被上面的
漂移分支静默放行，极难察觉）。两端同批把 `.device-identity` 加入保护名单：
`apps/executor-node/src/file-logger.ts` 的 `PROTECTED_WORKDIR_NAMES`、
`apps/executor-python/maintenance.py` 的 `_PROTECTED_WORKDIR_NAMES`。

**E. 中台：落列 + 双写 + 观测**

- 迁移 `1790000000038-AddExecutorDeviceFingerprint`：`varchar(64)` 可空 + **非唯一**索引
  `idx_executors_device_fingerprint`（唯一性留阶段 3 回填后单独加）。`ADD COLUMN IF NOT EXISTS`
  / `CREATE INDEX IF NOT EXISTS`，down 逆序 DROP。
- 三态采纳与 `interpreters` 同款：**缺省/非法一律不动 DB**。这是本阶段最关键的兼容性红线——
  旧执行器（v1/v2）或采集失败的 v3 执行器每 30s 一次心跳，若「缺省即置 NULL」会把已存指纹
  擦光，而那份历史正是本阶段唯一的产出。非法形态在心跳路径只留 `debug`（30s/台，`warn` 会刷屏）。
- 告警载荷列出**全部**并存指纹（`distinctFingerprintsOnAddress`）：只报「有几个」而不报
  「是哪几个」，运维仍要手工翻日志关联，而处置动作（给每台机器唯一 `EXECUTOR_ADDRESS_PUBLIC`）
  需要的正是这份清单。与阶段 1 的告警同时给出被顶替者/顶替者两个 `startupId` 对称。
- **两个跟踪器独立外发、刻意不去重**：一台机器同时具备两个信号特征时收到两条告警——两条判据
  的证据面不同（进程并存 vs 安装身份冲突），合并会丢失「哪条通路成立」的区分度；运营侧用
  **同一条**处置动作即可收敛两者。
- **迁移期两者并存**：阶段 1 的判据不依赖新字段，对存量执行器依然有效；且它覆盖一种指纹判不出
  的形态——**同机同 kind 同 workDir 的两个实例会共享指纹**，那时阶段 1 是唯一判据。

**F. 本阶段明确不做的事**

不按指纹定位行、不改 `address` 语义、不加唯一约束、不拒绝任何注册。存量为 NULL 的行与未上报
该字段的执行器，行为与引入本特性前**逐字节一致**。

### 阶段 3（待实施）

注册以 `deviceFingerprint` 定位行、`address` 降级为可达性元数据、列加非空约束 +
存量行回填 `legacy:${address}` 并标记待升级、冲突时后到者 `409` 拒绝。**前置条件**：存量机队
基本升到协议 v3（否则旧端不上报指纹，定位会退化）。需灰度验证存量执行器不被拒。

**相关轨道**（与本 ADR 独立，可先行）：
- **读面富化**（决策第 7 条）：`app_deployments` / `task_executions` 读面返回 `executorId` +
  `executorAppName`，前端展示执行器名而非地址（用户明确指出 NAT 内地址可重复）。
- **pull 队列键解耦**：`acf:pull:` / `acf:cmd:` 由 `address` 派生改为由 `id` 派生，
  使队列键获得不可猜测性（决策第 3 条的收益，不必等阶段 3）。

## 替代方案（被否）

- **方案 A：直接用 `executors.id`（UUID）当身份，执行器首次注册后持久化该 id 并在后续上报中携带。**
  否决理由：首次注册仍须有一个**无歧义**的定位键，否则「同一台机器重装后注册」与「两台机器抢同一地址」无法区分 —— 正是当前缺陷的形态。UUID 是解决方案的**结果**（第 3 条）而非输入；身份必须来自执行器侧可稳定复现的事实。另：若让执行器自报 UUID，则它同样可伪造/复用，退化为与 `address` 同级的问题。

- **方案 B：把 `appName` 提升为唯一键（要求运维保证唯一）。**
  否决理由：`appName` 默认取 `os.hostname()` 或 `executor-node-1`，重名极常见且**无技术手段强制**；容器化部署下 hostname 常为随机串、重建即变。把唯一性责任推给运维，等于把静默故障保留下来。仓库已有注释明确 `appName 不唯一`。

- **方案 C：仅用设备指纹（不含安装实例盐）。**
  否决理由：无法区分「同一台机器上的两个执行器实例」（如桌面端与裸机服务并存、或用户复制了工作目录）。两实例指纹相同会重演当前的「共享一行」故障。且容器/镜像克隆场景下 `/etc/machine-id` 常被复制，必须有实例级区分。

- **方案 D：保持 `address` 为身份，仅增加冲突拒绝（不做指纹）。**
  否决理由：能止血（正是已落地的 P0），但**不能解决根本问题**：执行器换 IP 仍会产生新行并丢失历史，用户仍无法获得稳定可读的身份，pull 队列键仍可被猜测。可作为阶段 1 的过渡，不能作为终态。

- **方案 E：让执行器上报原始 machine-id 并在中台明文存储。**
  否决理由：原始 machine-id 属主机敏感信息，明文落库扩大了数据泄露面，且对唯一性判定毫无额外价值 —— 哈希已足够，且不可反查（对齐 SEC-02 的密钥最小暴露原则）。

## 关联

- 计划项：**ARCH-34**（执行器唯一标识）；配套缺陷 **BUG-EXEC-DISPATCH-MISMATCH**（部署位置未传递到任务派发，见排查报告 §2）
- **不受本 ADR 阻塞的已落地切片**：部署归属偏好（**ARCH-35 P1**，
  `executor-deployment-affinity.util.ts` + `dispatch()` 接线）已实现并默认开启——
  它在 `address` 仍是身份的前提下也能正确工作（判据 `app_deployments.executorId`
  优先、`executorAddress` 兜底），因此**不必等本 ADR 落地**。本 ADR 落地后会
  顺带消除该切片在 address 碰撞下的残余误判（两机共享一行 → 偏好可能指错）。
- 相关 ADR：[ADR-003](./adr-003-idempotent-token-issuance.md)（幂等签发，本 ADR 改其幂等键）、
  [ADR-005](./adr-005-bundle-same-commit.md)（三端同批发布）、
  [ADR-008](./adr-008-mock-vs-reality.md)（真机冒烟）、
  [ADR-012](./adr-012-executor-token-safestorage.md)（token 存储姿态，本 ADR 不改认证面）、
  [ADR-015](./adr-015-executor-pull-dispatch.md) / [ADR-016](./adr-016-executor-control-plane-pull.md)（pull 通道，队列键受益方）
- 排查报告：[`docs/reviews/executor-identity-and-dispatch-mismatch-2026-09-23.md`](../reviews/executor-identity-and-dispatch-mismatch-2026-09-23.md)
- **验收记录**：[`docs/VERIFY-2026-09-23-executor-identity.md`](../VERIFY-2026-09-23-executor-identity.md)
  —— 按 `VERIFY-MATRIX` 逐项交代 CI/本机证据，并**如实列出未执行的真机项**
  （executor-node 真机全链、调度真机冒烟、以及本 ADR 的「两台同网段机器 → 冲突告警」
  真机冒烟；后者只有用户侧的两台机器能复现）。
- 已落地 P0 切片：`apps/admin-api/src/modules/executor/executor-address-conflict.util.ts` + service 接线（检测与告警，零行为变更）
- 相关文档：`docs/atlas/04-flows/executor-registration.md`、`docs/atlas/01-apps/admin-api/modules/executor.md`、`docs/atlas/03-data/entities/executor.md`
