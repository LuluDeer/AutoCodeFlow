/**
 * SEC-IPC-TYPE（R86-A1 轴 1）：`config:check-port` 的**参数闸 + 探测实现**。
 *
 * ## 为什么需要（实证，不是猜测）
 *
 * 原实现（ipc-handlers.ts 的 checkPortAvailable）把渲染层送来的 `port`/`host`
 * 原样交给 `net.createServer().listen(port, host)`。Node 的 listen 参数归一化对
 * **任意字符串**走「IPC 路径」分支（`isPipeName(s) = typeof s === 'string'`），
 * 于是渲染层可以直接决定主进程去 listen 什么：
 *
 *   · `listen('abc', '0.0.0.0')` → 报 `EACCES: permission denied abc`
 *     ——即主进程去建了一个名为 abc 的管道（Windows \\.\pipe\\abc）/
 *     POSIX 上的 unix socket 路径。渲染层不该有能力让主进程创建管道/socket 文件；
 *   · `listen(null, '0.0.0.0')` → **绑定 0 号临时端口并成功** → handler 回报
 *     「端口可用」。而 IPC 会把 NaN 序列化成 null（Number input 清空即 NaN，
 *     见 config-sanitize.ts 的 UX-DSK-NUM 注释），即用户清空端口输入框后
 *     预检**永远显示可用**——真正的目标端口被占也照样放行；
 *   · `listen(8002, 'a b')` → 主进程做一次 getaddrinfo（`ENOTFOUND`），
 *     即渲染层能驱动主进程的 DNS 解析。
 *
 * 三条都不是「会不会崩」的问题，而是**渲染层决定主进程网络原语参数**的授权
 * 缺口。修法：在入口把参数收成"整数端口 + IP 字面量/localhost"，其余一律
 * 早退，绝不进入 net。
 *
 * ## 与既有实现的关系
 *
 * · normalizeListenHost（network-util.ts）仍负责"空值回落 0.0.0.0"，本模块
 *   在其之上再加"只接受 IP 字面量 / localhost"；
 * · 探测语义（bind 试探、EADDRINUSE 文案）逐字保持原实现，避免行为回归；
 * · 纯 Node、无 electron 依赖 → selftest 直接驱动真实实现（不起 Electron）。
 */

import * as net from 'net';

/** 端口非法时的统一文案（渲染层直接展示）。 */
export const INVALID_PORT_MESSAGE = '端口号非法：必须是 1-65535 之间的整数';

/** 允许 bind 的 host：IP 字面量或 localhost；其余一律回落 0.0.0.0。 */
export const DEFAULT_LISTEN_HOST = '0.0.0.0';

/**
 * 把任意输入收成合法端口号；非法返回 null。
 *
 * 只接受 **number 类型**的整数：字符串 "8002" 也必须被拒——Node 对字符串有
 * 管道语义，收下字符串就等于把"端口"和"管道名"混成一件事（见文件头实证）。
 */
export function sanitizePortArgument(port: unknown): number | null {
  if (typeof port !== 'number') return null;
  if (!Number.isInteger(port)) return null;
  if (port < 1 || port > 65535) return null;
  return port;
}

/**
 * 把任意输入收成可 bind 的 host。
 *
 * 接受：IP 字面量（IPv4/IPv6，node:net.isIP 判定）、'localhost'。
 * 其余（空/非字符串/任意主机名/含空白/含分隔符）回落 0.0.0.0——与 B-8 之前
 * 的固定行为一致，因此**不会**比旧实现更不能用；同时切断了渲染层驱动主进程
 * getaddrinfo 的路径（允许主机名就等于允许任意 DNS 查询）。
 */
export function sanitizeListenHost(host: unknown): string {
  if (typeof host !== 'string') return DEFAULT_LISTEN_HOST;
  const h = host.trim();
  if (h === '') return DEFAULT_LISTEN_HOST;
  if (net.isIP(h) !== 0) return h;
  if (h.toLowerCase() === 'localhost') return 'localhost';
  return DEFAULT_LISTEN_HOST;
}

/**
 * 端口可用性探测（bind 试探）。
 *
 * 返回 `{ available, message }`，**绝不抛**（IPC 热路径）。参数非法时直接返回
 * available:false（fail-closed：宁可让用户看到"端口非法"，也不让主进程按渲染层
 * 给的怪参数去 bind/listen）。
 */
export function checkPortAvailable(
  port: unknown,
  host?: unknown,
): Promise<{ available: boolean; message: string }> {
  const safePort = sanitizePortArgument(port);
  if (safePort === null) {
    return Promise.resolve({ available: false, message: INVALID_PORT_MESSAGE });
  }
  const safeHost = sanitizeListenHost(host);
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: any) => {
      if (err?.code === 'EADDRINUSE') {
        resolve({ available: false, message: `端口 ${safePort} 已被占用，请换一个端口` });
      } else {
        resolve({ available: false, message: `端口检测失败: ${err?.message ?? err}` });
      }
    });
    server.once('listening', () => {
      server.close();
      resolve({ available: true, message: `端口 ${safePort} 可用` });
    });
    // B-8：按调用方的表单 executorHost 监听检测（不再固定 0.0.0.0）。
    server.listen(safePort, safeHost);
  });
}
