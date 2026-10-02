/**
 * B-1②/B-8/B-9：本机端口与 executor-node 健康面的**探测原语**（纯 Node、
 * 无 electron 依赖——可被 port-probe.selftest.ts 用真实 http server 逐条驱动，
 * 形态对齐 app-uninstall.ts 的"可裸测"先例）。
 *
 * 覆盖四个消费方：
 *  - ExecutorProcess.start() 的启动期孤儿处理（B-1②）：spawn 前先探测目标
 *    端口，free → 正常 spawn；healthy → 复用既有监听者（不制造第二个绑不上
 *    端口的子进程）；occupied 且不健康 → 仅当 /api/shutdown（带共享令牌）
 *    被受理才视为"我们自己的执行器"并请它退出，其余一律不杀、报告调用方；
 *  - config:save-and-close-wizard 的启动结果反馈（B-9/B-11）：启动后等待首个
 *    健康信号 + 注册预检，失败把错误带回向导页内；
 *  - ExecutorProcess.stop() 的 attach 模式停机：复用 requestExecutorShutdown；
 *  - config:check-port 的监听 host（B-8 由调用方传入，不在本模块）。
 *
 * 所有函数**绝不抛**：任何失败都收敛为 false / 'unknown'，让调用方走保守分支。
 */
import * as http from 'http';
import * as net from 'net';

/** 端口占用三态：free = 无监听者；healthy = 有 HTTP 服务且 /health/live 可用；occupied = 有监听者但不是健康的 executor。 */
export type PortOccupancy = 'free' | 'healthy' | 'occupied';

/** GET http://host:port/health/live —— 2xx/3xx 视为健康（与既有 healthPoll 的 <400 判定同口径）。 */
export function probeHealthLive(port: number, timeoutMs: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }
    const req = http.get({ host, port, path: '/health/live', timeout: timeoutMs }, (res) => {
      res.resume(); // 消耗响应体，避免内存泄漏
      // 响应头一到即可判定（与既有 healthPoll 同口径：<400 为健康），不等 body。
      resolve((res.statusCode ?? 0) > 0 && (res.statusCode ?? 0) < 400);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** TCP 可达性探测（比 bind 试探轻，且不会短暂抢占端口）。 */
export function isPortReachable(port: number, timeoutMs: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** 轮询等待端口**不再可达**（停机请求被受理后等它真正退出）。 */
export function waitForPortFree(
  port: number,
  timeoutMs: number,
  intervalMs = 250,
  host = '127.0.0.1',
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      void isPortReachable(port, 1_000, host).then((reachable) => {
        if (!reachable) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, intervalMs).unref?.();
      });
    };
    attempt();
  });
}

/** 轮询等待 /health/live 变健康（B-9：向导完成后的"首个健康信号"）。 */
export function waitForExecutorHealthy(
  port: number,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      void probeHealthLive(port, 2_000).then((healthy) => {
        if (healthy) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, intervalMs).unref?.();
      });
    };
    attempt();
  });
}

/**
 * 请求 executor-node 的 POST /api/shutdown（与 ExecutorProcess.requestGracefulHttpShutdown
 * 同一端点、同一鉴权）。**只有持同一共享令牌的本执行器才会 2xx 受理**——这正是
 * B-1② "仅当监听者是我们已知的 executor-node 才允许终止"的特征标识判定：
 * 外部进程（无令牌/无该端点）会 401/404/503，返回 false，调用方绝不杀。
 */
export function requestExecutorShutdown(port: number, token: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isFinite(port) || port < 1 || port > 65535 || !token) {
      // 与 executor-process 同口径：未配置令牌时 /api/* fail-closed（503），不必发起。
      resolve(false);
      return;
    }
    const payload = Buffer.from('{}', 'utf-8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/shutdown',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 读 /health/admin-status 的注册判定（B-11 注册预检）。语义与
 * ExecutorProcess.applyAdminStatus 同源：
 *   heartbeatStatus==='ok'（或 registration==='registered'）→ 'registered'；
 *   heartbeatStatus==='failed' 或 registration==='failed' → 'failed'；
 *   端点 404（旧 bundle）/超时/解析失败 → 'unknown'（不得据此断言失败）。
 */
export function fetchAdminRegistration(
  port: number,
  timeoutMs: number,
): Promise<'registered' | 'failed' | 'unknown'> {
  return new Promise((resolve) => {
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      resolve('unknown');
      return;
    }
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health/admin-status', timeout: timeoutMs },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          resolve('unknown');
          return;
        }
        let raw = '';
        res.on('data', (c: Buffer) => {
          if (raw.length < 64 * 1024) raw += c.toString();
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw) as { registration?: string; heartbeatStatus?: string };
            if (parsed && typeof parsed === 'object') {
              if (parsed.heartbeatStatus === 'ok' || parsed.registration === 'registered') {
                resolve('registered');
                return;
              }
              if (parsed.heartbeatStatus === 'failed' || parsed.registration === 'failed') {
                resolve('failed');
                return;
              }
            }
            resolve('unknown');
          } catch {
            resolve('unknown');
          }
        });
        res.on('error', () => resolve('unknown'));
      },
    );
    req.on('error', () => resolve('unknown'));
    req.on('timeout', () => {
      req.destroy();
      resolve('unknown');
    });
  });
}
