import * as os from 'os';

/**
 * 列出本机所有对外可用的 IPv4 地址（排除 loopback 等 internal 地址）。
 *
 * 纯 Node、无 Electron 依赖——主进程 IPC（network:local-ips）与子进程 env
 * 构造（buildExecutorChildEnv 的对外地址兜底）**同源**使用，避免两处各写
 * 一份网卡遍历逻辑导致行为漂移。顺序与 os.networkInterfaces() 枚举顺序一致，
 * 调用方约定取 [0] 作为"默认对外地址"（与向导/设置页的自动选择一致）。
 */
export function listLocalIPv4s(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
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
