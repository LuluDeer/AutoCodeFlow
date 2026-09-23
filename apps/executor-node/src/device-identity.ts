/**
 * ARCH-36（ADR-017 阶段 2）：执行器的**稳定唯一身份** deviceFingerprint。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * `executors` 的唯一键建在 `address` 上，而 `address` 是执行器**自报**的
 * 局域网 IP + 端口（桌面端默认取首个非 internal 网卡 + 8002）。两台不同内网的
 * 机器只要网段相同（`192.168.1.100:8002` 极常见）就命中**同一行**：
 *   1. 注册互相覆盖（appName/capabilities/startupId 被改写，共享 id 与 tokenHash）；
 *   2. 共享同一条 pull 队列（`acf:pull:` / `acf:cmd:`）——谁先 RPOP 谁执行；
 *   3. `startupId` 抖动使双方互相把对方正在跑的任务判成 EXECUTOR_RESTART；
 *   4. 每次注册都 rotateToken，两台互相吊销令牌。
 * P0 已把「两个进程生命并存」变成一条可见的 ERROR 告警
 * （`executor-address-conflict.util.ts`）；本模块提供的是**判定依据**——一个
 * 跨重启稳定、且不同安装必然不同的标识。
 *
 * ── 判据为什么比 startupId 强 ─────────────────────────────────────────────
 * `startupId` 是**每进程**随机 UUID，只能在「被顶替者复活」这个时序上**间接**
 * 推断并存（见 P0 util 头注）。`deviceFingerprint` 跨重启**不变**，于是：
 *   - 「同一 address 上出现两个不同 fingerprint」= **直接证据**，不需时序，
 *     也不会把正常重启误判成冲突；
 *   - 「同一 fingerprint 换成另一个 address」= **地址漂移**（机器换网/换 IP），
 *     属正常现象，不是冲突。
 * 两者方向相反、各自零误报，这正是 identity 与 process-life 的分工。
 *
 * ── 组成 ──────────────────────────────────────────────────────────────────
 * `deviceFingerprint = sha256(deviceId + ":" + installSalt)`，64 位小写十六进制
 * （与 admin 侧 `executors.deviceFingerprint` varchar(64) 同源）。
 *
 * - `deviceId` 标识**这台机器**（跨重启稳定）：Windows 注册表 MachineGuid /
 *   Linux `/etc/machine-id`（回退 `/var/lib/dbus/machine-id`）/ macOS
 *   IOPlatformUUID；三者皆不可得（容器镜像常被清空）时回退「首个非 loopback
 *   网卡 MAC + 主机名」的哈希。见 `resolveDeviceId`。
 *
 * - `installSalt` 标识**这份安装**：首次启动生成随机 UUID 并持久化。它解决
 *   deviceId 解决不了的两件事——① 同机多实例（同 deviceId、不同安装）；
 *   ② 容器镜像克隆（多容器共享被复制的 machine-id）。
 *
 *   **盐的作用域含执行器 kind**（见 `deviceSaltPath`）。这是实现期对 ADR-017
 *   的一处收紧，理由是 ADR 阶段 3 的落地前提：同机同 workDir 上并存的 node 与
 *   python 执行器是**两个逻辑执行器**，若共用一个盐就会得出同一个指纹，阶段 3
 *   以指纹为定位键时它们会被折叠成一行——正是本 ADR 要消灭的那类故障。ADR 对
 *   installSalt 的定义本就是「标识**这份安装**」——也就是这个工作目录。两种执行器
 *   各自安装、各是一个实例，故按 kind 分域是忠于定义而非偏离。
 *
 * - **只上报哈希，绝不上报原始 machineId**：原始值属主机敏感信息，哈希已足够
 *   做唯一性与冲突检测，且不可反查（对齐 ADR-017 的 SEC-02 依据）。
 *
 * ── 边界（如实） ──────────────────────────────────────────────────────────
 * - 指纹**不是防伪造凭据**——执行器可自报任意指纹（与今日 `address` 同等可伪造）。
 *   它解决**唯一性与稳定性**，不解决**认证**；认证仍由 per-executor token 承担。
 * - 同一台机器上**同 kind 且共用同一个 workDir** 的两个实例会被视为同一安装
 *   实例（ADR 对盐的定义就是「这份安装/这个工作目录」）。要区分它们必须给不同的
 *   `WORK_DIR`，或用 `EXECUTOR_INSTANCE_KIND` 显式分域。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * - **fail-open**：采集失败（容器无 machine-id、注册表不可读、数据目录只读）
 *   一律 `null` 并**只 warn 一次**——绝不阻断启动/注册（对齐 AC-14b）。
 * - **零行为变更**：未上报（null）的执行器在中台侧列保持 NULL，行为与引入前
 *   逐字节一致（兼容性红线）。
 * - **零 IO 抖动、零定时器**：结果 memo 化（deviceId 与盐在进程生命周期内
 *   不变），register 与 heartbeat 共享一次计算。
 * - **工作目录清扫保护**：盐文件位于 workDir 顶层的 `.device-identity/`，
 *   该名字必须留在 `PROTECTED_WORKDIR_NAMES`（file-logger.ts）里——workDir
 *   顶层的一切（含文件）都会被 TTL 清扫按 mtime 删除，盐被删掉等于指纹每周
 *   （LOG_RETENTION_DAYS）静默漂移一次。
 */
import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';

/** 指纹的十六进制长度（sha256），与 admin 侧 varchar(64) 同源。 */
export const DEVICE_FINGERPRINT_HEX_LENGTH = 64;

/** 安装实例盐所在目录名（workDir 顶层的受保护基础设施条目）。 */
export const DEVICE_IDENTITY_DIR_NAME = '.device-identity';

/** 探测命令的超时（防止某些环境里 `reg` / `ioreg` 挂死拖住启动）。 */
export const DEVICE_PROBE_TIMEOUT_MS = 2000;

/** deviceId 的来源，仅用于日志/测试断言（不是协议字段）。 */
export type DeviceIdSource =
  | 'windows-machine-guid'
  | 'linux-machine-id'
  | 'linux-dbus-machine-id'
  | 'darwin-platform-uuid'
  | 'mac-hostname-fallback';

export interface DeviceIdResult {
  id: string;
  source: DeviceIdSource;
}

/**
 * 采集面（可注入）。生产实现包在 `defaultProbe()`；测试传假实现即可覆盖
 * 三平台分支与全部失败分支，不需要真的读注册表/网卡。
 */
export interface DeviceIdentityProbe {
  platform: NodeJS.Platform;
  /** 读文本文件（不存在/不可读应抛错，由调用方捕获）。 */
  readTextFile: (filePath: string) => string;
  /** 执行命令并返回 stdout（失败应抛错，由调用方捕获）。 */
  runCommand: (file: string, args: string[]) => string;
  hostname: string;
  networkInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

/** 盐的持久化面（可注入）。 */
export interface DeviceSaltIo {
  readTextFile: (filePath: string) => string;
  writeTextFile: (filePath: string, content: string) => void;
  makeDir: (dirPath: string) => void;
  /** 生成一个新盐（生产用 randomUUID；测试注入确定值）。 */
  generateSalt: () => string;
}

/** 盐的持久化结果（`created` 供日志区分「复用既有安装身份」与「首次生成」）。 */
export interface DeviceSaltResult {
  salt: string;
  created: boolean;
}

export function defaultProbe(): DeviceIdentityProbe {
  return {
    platform: process.platform,
    readTextFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
    runCommand: (file, args) =>
      execFileSync(file, args, {
        encoding: 'utf8',
        timeout: DEVICE_PROBE_TIMEOUT_MS,
        windowsHide: true,
      }),
    hostname: os.hostname(),
    networkInterfaces: () => os.networkInterfaces(),
  };
}

export function defaultSaltIo(): DeviceSaltIo {
  return {
    readTextFile: (filePath) => fs.readFileSync(filePath, 'utf8'),
    writeTextFile: (filePath, content) =>
      fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 }),
    makeDir: (dirPath) => {
      fs.mkdirSync(dirPath, { recursive: true });
    },
    generateSalt: () => randomUUID(),
  };
}

/** 盐的合法形态：UUID（首次生成即 randomUUID，故此处严格匹配 UUID）。 */
const SALT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 解析**这台机器**的稳定 deviceId；全部手段失败返回 null（调用方 fail-open）。
 *
 * 顺序按「稳定性 × 可得性」排：注册表/文件优先（不含会变的网络信息），
 * MAC + 主机名兜底（最弱——网卡增减或宿主改名都会变，但总比没有强）。
 */
export function resolveDeviceId(probe: DeviceIdentityProbe): DeviceIdResult | null {
  if (probe.platform === 'win32') {
    const fromRegistry = tryRead(
      () =>
        probe.runCommand('reg', [
          'query',
          'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
          '/v',
          'MachineGuid',
        ]),
      'MachineGuid',
    );
    const m = fromRegistry && /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(fromRegistry);
    if (m && m[1]) return { id: m[1], source: 'windows-machine-guid' };
  }

  if (probe.platform === 'linux') {
    // systemd 的标准位置；容器里可能为空文件或不存在。
    const primary = tryRead(() => probe.readTextFile('/etc/machine-id'), '/etc/machine-id');
    if (primary && primary.trim()) {
      return { id: primary.trim(), source: 'linux-machine-id' };
    }
    const dbus = tryRead(
      () => probe.readTextFile('/var/lib/dbus/machine-id'),
      '/var/lib/dbus/machine-id',
    );
    if (dbus && dbus.trim()) {
      return { id: dbus.trim(), source: 'linux-dbus-machine-id' };
    }
  }

  if (probe.platform === 'darwin') {
    const out = tryRead(
      () => probe.runCommand('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']),
      'ioreg',
    );
    const m = out && /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
    if (m && m[1]) return { id: m[1], source: 'darwin-platform-uuid' };
  }

  const fallback = resolveMacHostnameId(probe);
  if (fallback) return { id: fallback, source: 'mac-hostname-fallback' };
  return null;
}

/**
 * 兜底 deviceId：首个「非 loopback 且 MAC 非全零」网卡的 MAC + 主机名。
 *
 * 为什么带上主机名：容器/虚机常把 MAC 设成同一批固定值，单靠 MAC 会把不同
 * 宿主判成同一设备；主机名提供第二个维度。仍然很弱（网卡增减/改名即变），
 * 故它是**最后**一个候选，且在日志里会被标为 fallback 以便运维觉察。
 */
export function resolveMacHostnameId(
  probe: DeviceIdentityProbe,
): string | null {
  let mac: string | null = null;
  try {
    const ifaces = probe.networkInterfaces() ?? {};
    for (const name of Object.keys(ifaces).sort()) {
      for (const info of ifaces[name] ?? []) {
        if (info.internal) continue;
        const candidate = (info.mac || '').trim().toLowerCase();
        if (!candidate || candidate === '00:00:00:00:00:00') continue;
        mac = candidate;
        break;
      }
      if (mac) break;
    }
  } catch {
    mac = null;
  }
  const hostname = (probe.hostname || '').trim();
  if (!mac && !hostname) return null;
  // 与 deviceFingerprint 同款哈希：避免把 MAC/主机名原样带出机器。
  return createHash('sha256')
    .update(`fallback:${mac ?? ''}:${hostname}`, 'utf8')
    .digest('hex');
}

/**
 * `deviceFingerprint = sha256(deviceId + ":" + installSalt)`（小写十六进制）。
 *
 * 分隔符用 `':'` 是安全的（不是任意可替换字符）：两个组成成分的形态都不含
 * `':'` —— deviceId 是 UUID / 32 位十六进制 machine-id / 十六进制哈希，
 * installSalt 是 UUID。故本拼接**在实践中**不存在歧义，无需长度前缀或转义。
 * 新增 deviceId 来源（例如某平台返回带冒号的串）时必须复核这条前提，否则
 * `("a:b","c")` 与 `("a","b:c")` 会碰撞成同一指纹——那会让两台不同机器被
 * 判成同一安装，正是本模块要消灭的故障。
 */
export function computeDeviceFingerprint(
  deviceId: string,
  installSalt: string,
): string {
  return createHash('sha256')
    .update(`${deviceId}:${installSalt}`, 'utf8')
    .digest('hex');
}

/**
 * 盐文件路径：`<workDir>/.device-identity/<kind>.salt`。
 *
 * 放在**子目录**而非 workDir 顶层裸文件：清扫只遍历 workDir 的顶层条目，
 * 保护一个目录名即可护住其中所有 kind —— 若按 kind 平铺成多个顶层文件，
 * 保护名单就要随 kind 数量增长，漏加一个就是「指纹每周漂移」的静默故障。
 */
export function deviceSaltPath(workDir: string, kind: string): string {
  return path.join(workDir, DEVICE_IDENTITY_DIR_NAME, `${kind}.salt`);
}

/**
 * 读取或首次生成安装实例盐。文件缺失/为空/形态非法（被截断、被别的程序写过）
 * 一律**重新生成**——盐的唯一要求是「本实例内稳定」，无法校验来源时重建比
 * 采信垃圾值安全。
 */
export function loadOrCreateInstallSalt(
  saltPath: string,
  io: DeviceSaltIo,
): DeviceSaltResult {
  const existing = tryRead(() => io.readTextFile(saltPath), saltPath);
  const trimmed = existing?.trim();
  if (trimmed && SALT_RE.test(trimmed)) {
    return { salt: trimmed, created: false };
  }
  const salt = io.generateSalt();
  io.makeDir(path.dirname(saltPath));
  io.writeTextFile(saltPath, salt);
  return { salt, created: true };
}

/**
 * 解析本执行器实例的执行器种类（盐的分域键）。
 *
 * 默认从进程形态推断：desktop 把 executor-node 以 bundle 形式嵌进 Electron，
 * 故 `process.versions.electron` 有值即 desktop；裸机服务为 node。这条判据
 * 不需要 desktop 侧任何代码改动或额外 plumbing。
 * `EXECUTOR_INSTANCE_KIND` 可显式覆盖（运维在同一 workDir 上跑多实例时用它分域；
 * python 侧同名变量，保持两端一致）。
 */
export function resolveInstanceKind(): string {
  const override = process.env.EXECUTOR_INSTANCE_KIND?.trim();
  if (override) return override;
  return process.versions.electron ? 'desktop' : 'node';
}

export interface DeviceIdentityResolverOptions {
  /** workDir（getter 传入，热重载一致）。 */
  workDir: () => string;
  /** 盐的分域键，缺省 `resolveInstanceKind()`。 */
  kind?: string;
  probe?: DeviceIdentityProbe;
  saltIo?: DeviceSaltIo;
}

/**
 * 指纹解析器（**实例**，非模块级单例）。
 *
 * 这样测试可直接 `new DeviceIdentityResolver({...})` 注入假探测面，天然不共享
 * 状态——对齐 `ExecutorAddressConflictTracker` 的取舍（模块级可变状态会跨测试
 * 文件泄漏，仓库已有 `__resetTruncationWarnStateForTest` 的前科）。
 */
export class DeviceIdentityResolver {
  private readonly workDir: () => string;
  private readonly kind: string;
  private readonly probe: DeviceIdentityProbe;
  private readonly saltIo: DeviceSaltIo;
  /** 采集结果 memo（`undefined` = 未采集；`null` = 采集失败，同样只算一次）。 */
  private cached: string | null | undefined = undefined;
  /** fail-open 的 warn 只打一次，避免每次 register/心跳重试都刷屏。 */
  private warned = false;

  constructor(options: DeviceIdentityResolverOptions) {
    this.workDir = options.workDir;
    this.kind = options.kind?.trim() || resolveInstanceKind();
    this.probe = options.probe ?? defaultProbe();
    this.saltIo = options.saltIo ?? defaultSaltIo();
  }

  /**
   * 解析本实例的 deviceFingerprint；**任何**失败都返回 null 且不抛。
   *
   * 同步实现：探测只有一次进程级系统调用（注册表/ioreg/读文件），memo 之后
   * register 与心跳都是纯内存读取。注册载荷里同步取值不会带来心跳路径抖动。
   */
  resolve(): string | null {
    if (this.cached !== undefined) return this.cached;
    try {
      const deviceId = resolveDeviceId(this.probe);
      if (!deviceId) {
        this.warnOnce(
          'device identity unavailable: no MachineGuid / machine-id / IOPlatformUUID and no usable NIC MAC — ' +
            'deviceFingerprint will be reported as absent (executor still registers normally)',
        );
        this.cached = null;
        return null;
      }
      const saltPath = deviceSaltPath(this.workDir(), this.kind);
      const { salt, created } = loadOrCreateInstallSalt(saltPath, this.saltIo);
      if (created) {
        logger.info(
          `Generated install salt for device identity (kind=${this.kind}): ${saltPath}`,
        );
      }
      this.cached = computeDeviceFingerprint(deviceId.id, salt);
      logger.info(
        `Device identity resolved (deviceId source: ${deviceId.source}, kind: ${this.kind})`,
      );
      return this.cached;
    } catch (err: unknown) {
      this.warnOnce(
        `device identity probe failed, reporting no deviceFingerprint: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.cached = null;
      return null;
    }
  }

  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    logger.warn(message);
  }
}

/** 进程级默认解析器（register / heartbeat 共用，一次采集）。 */
let defaultResolver: DeviceIdentityResolver | null = null;

/**
 * 本进程的 deviceFingerprint；未采集则采集一次并记住。
 *
 * 为什么允许模块级惰性单例：缓存的是**安装事实**（deviceId 与盐在进程生命周期
 * 内不变），不含任何会跨测试污染行为的可变语义——与 P0 跟踪器（累积观察状态）
 * 性质不同。测试若需要不同输入，直接 `new DeviceIdentityResolver({...})`，
 * 或调 `__resetDefaultDeviceIdentityForTest()`。
 */
export function getDeviceFingerprint(): string | null {
  defaultResolver ??= new DeviceIdentityResolver({ workDir: () => config.workDir });
  return defaultResolver.resolve();
}

/** 测试出口：丢弃进程级默认解析器（含 memo 与 warn-once 状态）。 */
export function __resetDefaultDeviceIdentityForTest(): void {
  defaultResolver = null;
}

/** 包一层 try/catch 的窄工具：探测失败返回 null 而不是把异常抛给调用方。 */
function tryRead(fn: () => string, label: string): string | null {
  try {
    return fn();
  } catch (err: unknown) {
    logger.debug(
      `device identity probe step "${label}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
