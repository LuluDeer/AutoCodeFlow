import * as os from 'os';

/**
 * 虚拟/隧道网卡的接口名前缀与子串（小写匹配）。
 *
 * 为什么要有这层（生产实证 2026-10-22）：执行器把"第一个非 internal IPv4"当作
 * 对外地址上报，而装了 Clash / WSL / Hyper-V / Docker 的办公机上，枚举顺序里
 * 靠前的常常是**虚拟网卡**——最典型的是 Clash/Meta TUN 的 198.18.0.1：**每台**
 * 装了 Clash 的机器都是这个字面地址，于是中台侧看到"多份安装共享同一个
 * address"，冲突观测被点亮、告警外发，而实际机队完全健康（全 pull）。
 */
const VIRTUAL_IFACE_PATTERNS = [
  'tun',
  'tap',
  'utun',
  'tailscale',
  'zt',
  'wg',
  'ipsec',
  'ppp',
  'docker',
  'br-',
  'veth',
  'virbr',
  'vmnet',
  'vboxnet',
  'vethernet',
  'hyper-v',
  'loopback',
  'dummy',
  'bridge',
];

/**
 * 绝对不能作为对外地址的 IPv4 段。与 admin-api 的 assertSafeExecutorUrl 保留段
 * 口径、以及本仓 docs/SECURITY-REDLINE-CHECKLIST.md 的 deny 段对齐：
 *
 * - 127.0.0.0/8、0.0.0.0/8        loopback / unspecified（0.0.0.0 是监听地址）
 * - 169.254.0.0/16               link-local（APIPA，取不到 DHCP 时的自配地址）
 * - 198.18.0.0/15                Clash/Meta TUN 的 fake-ip 段（**跨机器相同**）
 * - 172.17.0.0/16                docker 默认桥（宿主机与容器内都可能出现在枚举里）
 * - 224.0.0.0/4、255.255.255.255  多播 / 广播
 * - 文档保留段                    192.0.2/24、198.51.100/24、203.0.113/24
 *
 * 注意 100.64.0.0/10（CGNAT / Tailscale）**不在此列**：它是真实的、可路由的
 * VPN 地址，Tailscale 组网下中台正是靠它连执行器。它只是在**排序**上靠后
 * （见 {@link ipv4Rank}）。
 */
export function isUnusableIPv4(ip: string): boolean {
  const octets = ip.split('.').map((x) => Number(x));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = octets;
  if (a === 0 || a === 127) return true; // unspecified / loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 198 && (b === 18 || b === 19)) return true; // Clash/Meta fake-ip
  if (a === 172 && b === 17 && c === 0) return true; // docker0
  if (a === 224 || a >= 240) return true; // multicast / reserved / broadcast
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

/**
 * 排序权重（越小越优先）：局域网私网地址 > VPN/CGNAT > 其余。
 *
 * 局域网私网优先的理由：执行器的 address 只用于"中台能否连到它"，
 * 同网/同办公网的 192.168.x 通常才是那条可达路径；公网地址往往来自
 * 虚拟网卡或历史配置。
 */
export function ipv4Rank(ip: string): number {
  const [a, b] = ip.split('.').map((x) => Number(x));
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  if (a === 100 && b >= 64 && b <= 127) return 3; // CGNAT / Tailscale
  return 4;
}

/** 接口名是否像虚拟/隧道网卡。 */
function isVirtualIface(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return VIRTUAL_IFACE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * 列出本机**可作对外地址**的 IPv4（排除 loopback/internal、虚拟网卡与保留段）。
 *
 * 纯 Node、无 Electron 依赖——主进程 IPC（network:local-ips）与子进程 env
 * 构造（buildExecutorChildEnv 的对外地址兜底）**同源**使用，避免两处各写
 * 一份网卡遍历逻辑导致行为漂移。
 *
 * 顺序**不是** os.networkInterfaces() 的枚举顺序：按 {@link ipv4Rank} 稳定排序，
 * 让调用方的 [0] 落到最可能可达的局域网地址（P1-1：旧实现直接透传枚举顺序，
 * TUN/VPN/docker 网卡经常排在真实网卡前面）。
 *
 * 全部被过滤时返回空数组（调用方须容忍——它不是"必须非空"的契约）。
 */
export function listLocalIPv4s(): string[] {
  const interfaces = os.networkInterfaces();
  const seen = new Set<string>();
  const ips: string[] = [];
  for (const [name, iface] of Object.entries(interfaces)) {
    if (!iface) continue;
    if (isVirtualIface(name)) continue;
    for (const addr of iface) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (isUnusableIPv4(addr.address)) continue;
      if (seen.has(addr.address)) continue;
      seen.add(addr.address);
      ips.push(addr.address);
    }
  }
  // 稳定排序：同权重保持枚举顺序（Array.prototype.sort 在 ES2019+ 是稳定的）。
  return ips.sort((x, y) => ipv4Rank(x) - ipv4Rank(y));
}

/**
 * B-8：端口可用性检测的监听 host 归一化。
 *
 * 背景：config:check-port 此前把检测 socket 固定绑在 0.0.0.0，而执行器实际
 * 按 config.executorHost 绑（可配 127.0.0.1）——两者在特定环境（其它进程已
 * 独占 127.0.0.1 的该端口、或组策略限制通配绑定）下判定会相反，「检测可用、
 * 启动绑不上」或反之。修法：检测 host 必须与**将要 bind 的 host**同源（由
 * 调用方传入其表单值），本函数只做兜底归一化：空/非字符串一律回落 0.0.0.0
 * （与 config-store 的 executorHost 缺省一致），绝不抛（在 IPC 热路径上）。
 */
export function normalizeListenHost(host: unknown): string {
  const h = typeof host === 'string' ? host.trim() : '';
  return h || '0.0.0.0';
}

/**
 * R89：把 `http(s).get` 的错误**归一成稳定文案**，且**不回显解析结果**。
 *
 * 由来（R86-A1 遗留②）：`config:test-connection` 直接把 `err.message` 回给渲染层，而 Node 的
 * 网络错误消息里带着**解析后的地址**：
 *
 *   `getaddrinfo ENOTFOUND <hostname>`
 *   `connect ECONNREFUSED 192.168.1.5:3105`   ← 渲染层本来不知道这个名字解析到哪
 *
 * 也就是说：一个被注入的渲染层可以拿这个通道当 **DNS/内网端口探测器**（发起 + 读回解析结果），
 * 而它在浏览器沙箱里做不到（CORS 挡住读、只剩很弱的时序信号）。
 *
 * 但**不能**照 admin-api 的 SSRF 姿态直接禁私网：桌面端连的就是用户自己的 admin-api，
 * `http://192.168.x.x:3105` / `http://localhost:3105` 是**主要部署形态**，禁了等于废掉这个功能。
 * 折中：**保留发起能力，去掉回显**——用户仍然知道「被拒绝 / 解析不了 / 超时 / 不可达」，
 * 但拿不到解析后的地址。
 *
 * 输入只取 `code`（不读 `message`），因此**结构上不可能**把地址带出去。
 */
/** errno 码的形状：大写字母/数字/下划线（`ECONNREFUSED` / `EAI_AGAIN` / `ERR_TLS_…`）。 */
const ERRNO_CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function describeConnectionError(code: unknown): string {
  // 只认**码的形状**：把 `err.message` 误传进来时（`getaddrinfo ENOTFOUND internal.corp.example`）
  // 会落到“未知错误”，而不是把整条消息原样回显 —— 否则这个函数就成了新的泄漏点。
  // 归一后的值：只有**长得像 errno 码**的输入才会被继续使用（message/地址一律变成空串）。
  const safeCode = typeof code === 'string' && ERRNO_CODE_RE.test(code) ? code : '';
  switch (safeCode) {
    case 'ECONNREFUSED':
      return '连接被拒绝：目标端口没有服务在监听（地址或端口可能不对）';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名无法解析：请检查地址拼写与本机 DNS/网络';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return '目标不可达：本机到该网段没有路由';
    case 'ETIMEDOUT':
      return '连接超时：目标无响应（防火墙或服务未启动）';
    case 'ECONNRESET':
      return '连接被重置：目标端口不是 HTTP 服务，或中间设备拦截';
    case 'EPROTO':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS 校验失败：证书与地址不匹配或为自签名';
    default:
      return '连接失败（' + (safeCode || '未知错误') + '）';
  }
}
