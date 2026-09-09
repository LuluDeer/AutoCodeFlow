# ADR-012: executorToken safeStorage 加密——三平台差异、basic_text 降级姿态与存量迁移

状态：Accepted（P0-4 拍板，SEC-NEW-1 实施依据；2026-09-09）

## 背景

executor-desktop 的 `executorToken`（与 admin `EXECUTOR_SECRET` 同值的共享凭据，SEC-01 面）此前经 electron-store **明文落盘**（`config.json` 内 JSON 字段）。磁盘读取者（其他本机用户、备份同步、恶意软件）可直接获得执行器本体权限。任务书要求改走 Electron `safeStorage` 加密，但 safeStorage 在三平台的底层机制与可用性差异显著，且存量用户配置里已有明文 token——选型与迁移策略必须先拍板再动代码（SEC-NEW-1 前置）。

## 三平台差异（决策依据）

| 平台 | 后端 | 可用性前提 | 失败/降级形态 |
|---|---|---|---|
| macOS | Keychain | 系统内置，实质总可用 | 罕见（钥匙串锁定时 API 返回不可用） |
| Windows | DPAPI（用户作用域） | 系统内置，实质总可用 | 罕见（用户配置损坏） |
| Linux | libsecret / kwallet / gnome-libsecret | **依赖桌面 keyring 守护进程** | **常态性不可用**：无头服务器、最小 WM、SSH 会话、容器内运行时 `isEncryptionAvailable()` 为 false；可用时若 OS 为 basic_text（未检测到 keyring）则加密强度退化为“混淆” |

结论：**“加密不可用”不是异常路径，而是 Linux 上的常态路径**。因此降级姿态必须是明确裁定而非边角处理。

## 决策

1. **信封格式**：`executorToken` 落盘值统一带 `enc:ss:<base64>` 前缀信封（`ss` = safeStorage）。读面见前缀则 `decryptString` 还原；无前缀视为明文（存量或降级写入）。前缀使密文/明文可无损判别，迁移与降级逻辑不需要额外元数据字段。
2. **降级姿态：明文 + 启动 warn 一次（非拒绝启动）**。与 SEC-02 先例同姿态（`SEC_SECRETS_KEY` 未配置时 secrets 明文落库 + 启动 warn 一次的零破坏升级路径）：
   - 拒绝明文降级（fail-closed）会要求所有 Linux 无头用户手工改造成 keyring 环境才能用桌面端——executor-desktop 明确支持无头/最小环境（托盘常驻 + 自启 executor-node），裁定为不可接受；
   - warn 仅启动时记一次（模块级去重），错误信息含平台与补救指引，不逐条刷屏。
3. **加密写入范围**：仅 `executorToken`。`adminApiUrl`/地址/端口等配置非凭据（泄露仅暴露拓扑，不授予权限），保持明文可读——多写一份密文只会让用户手工修配置更困难而无安全增益。
4. **存量迁移：首启惰性迁移，一次写穿**。启动构造 ConfigStore 时检测旧明文 token → 尝试加密回写同一字段（`enc:ss:` 信封）→ 密文写入成功即完成（明文被原子覆盖，无旧字段残留、无需只读兼容轮）；加密不可用或加密失败 → **保留明文继续可用 + warn**（fail-safe，绝不因迁移失败丢弃可用凭据——否则静默破坏全部存量用户）。下次启动重试。
5. **解密失败 fail-safe**：`decryptString` 抛错（典型：keyring 密钥因重装/换机丢失、basic_text 盐变化）→ 返回空串 + warn，不做任何“猜测明文”的回退——信封前缀明确表示该值是密文，回读明文只会掩盖密钥丢失问题。用户在配置页重填 token 即恢复。
6. **多用户边界**：DPAPI/Keychain/libsecret 加密的密文**绑定本机当前 OS 用户**，换用户/换机/直接拷贝 config.json 均不可解——这是特性不是缺陷（凭据不应随配置文件旅行）。但换机迁移场景下用户必须重填 token（解密失败 → 空串 + warn 的 UX 已覆盖）。
7. **主进程独占**：加密/解密只发生在 main 进程。renderer 全程不接触密文形态以外的 token（IPC 面见 SEC-NEW-1 核对记录），safeStorage 也不经 preload 暴露。

## 后果

- config.json 中 token 字段：macOS/Windows/正常 Linux 桌面 = safeStorage 密文；无 keyring Linux = 明文 + 启动 warn（能力边界如实暴露，不假装安全）。
- electron-store schema 不变（仍为 string 字段），信封前缀承担形态判别；无新字段、无 schema 破坏。
- 测试面：safeStorage 在纯 Node 测试环境不存在，selftest 以可注入的 `SafeStorageAdapter` mock 三态（可用/不可用/解密失败）+ 存量迁移/降级/往返。
- 打包面：`npm run build:main` 产物随 src 变更需重打包（bundle 同 commit 纪律的 desktop 侧常规姿态，本次仅 src 不涉 resources/executor-node bundle）。

## 替代方案（被否）

- **加密不可用即拒绝启动/拒绝保存**：Linux 无头常态路径直接不可用，与桌面端产品定位冲突；
- **electron-store `encryptionKey` 选项（AES-256-CBC 全文件加密）**：密钥同样要落在 main 进程代码/配置里，防本机同用户读取的增益为零，反而使 config.json 整体不可手工编辑；
- **独立 `executorTokenEncrypted` 新字段 + 旧字段只读兼容一轮**：双字段长期并存引入“两处真相”风险（ADR-007 教训），同字段覆盖写更简单且迁移即收敛；
- **自管加密（Argon2 派生 + 本机指纹）**：重新发明 safeStorage 已解决的 OS 集成问题，且跨平台指纹（机器 ID）读取本身又是三平台差异坑。
