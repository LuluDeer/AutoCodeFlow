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
