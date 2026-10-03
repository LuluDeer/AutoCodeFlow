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
