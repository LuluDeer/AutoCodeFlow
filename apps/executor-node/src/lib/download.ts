/** Bearer-authenticated download shared by the deploy and update-package
 *  paths. Carries the executor shared token to the first host, strips it on
 *  cross-host redirects (token must not leak to third-party domains), enforces
 *  an overall deadline (a slow-drip server cannot stall the caller forever)
 *  and a max size cap (a huge file cannot fill the disk).
 *
 *  E-04（DEEP_REVIEW 0ef3bbe）：首跳 Bearer token 是有意设计——packageUrl/
 *  downloadUrl 由 admin-api 下发，首跳指向 admin-api 本机（内网拉包），
 *  携带 EXECUTOR_SHARED_TOKEN 完成 admin-api 的 Bearer 校验。跨跳（redirect）
 *  已在下方 strip。SSRF 闸在入口处 fail-closed（assertSafeHttpUrl），
 *  EXECUTOR_ALLOW_PRIVATE_NETWORK=true（`1` 亦兼容）可显式逃生。 */

import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { config } from '../config';
import { assertSafeHttpUrl, assertSafeDnsResolution } from './ssrf-guard';
import type { SsrfResolvedAddress } from './ssrf-guard';

/**
 * 2026-10-30（生产故障：`package_fetch_failed: 压缩包下载失败：Client network
 * socket disconnected before secure TLS connection was established`）：
 *
 * 本文件此前用 `proto.get(url, opts)` **不带 agent**，即每次下载都是一条冷
 * TLS 连接、用完即弃、且**零重试**。而 packageUrl 在生产上是 `https://<域名>`
 * （经反代/frp 回源），跨境或经隧道链路的单次 TLS 握手中断观测概率约 4.5%
 * （同仓 admin-http-agent.ts 头注记录的心跳实测 80/1759），于是「偶发下载失败」
 * 被直接判成任务失败——同一个包手工重试往往就成功，这正是现场表现。
 *
 * 两处修：
 *   ① keepAlive agent（http/https 各一）：复用 TLS 会话，省掉每次握手的 RTT；
 *      这是 admin-http-agent.ts 已验证过的同款做法，只是下载路径此前没接。
 *   ② 握手期/连接期错误的有界重试（见下方 RETRYABLE_NET_CODES 与
 *      downloadFileWithRetry）。注意**只重试「还没开始写数据」的失败**——
 *      一旦响应体已开始落盘，重试会与半成品文件/字节计数纠缠，交给调用方。
 *
 * 为什么 agent 放在模块级：Node 的 Agent 本身持有 socket 池，每次 new 一个
 * 等于没有复用。maxSockets 与 admin-http-agent 对齐（32），避免并发下载打满。
 */
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  keepAliveMsecs: 10_000,
  // 池内空闲 socket 上限：略高于最长请求，让死连接被及时淘汰而不是复用时
  // 才以 socket hang up 暴露（与 admin-http-agent 的 45s 同源考量）。
  timeout: 45_000,
});

/**
 * 可在**同一 URL 上直接重试**的连接期错误码/文案。
 *
 * 收录依据（全部是「请求还没拿到响应」的阶段，重试无副作用）：
 *   - `Client network socket disconnected before secure TLS connection was
 *     established` —— 本次故障原文；TLS 握手被链路/中间设备掐断
 *   - `socket hang up` / `ECONNRESET` / `EPIPE` —— 对端静默关闭半开连接
 *   - `ETIMEDOUT` / `ECONNREFUSED` / `EAI_AGAIN` / `ENOTFOUND` —— 瞬时不可达
 *   - `EHOSTUNREACH` / `ENETUNREACH` —— 路由抖动
 *
 * 刻意**不收录**：HTTP 4xx/5xx（服务端语义，重试无益且可能放大故障）、
 * 体积超限、SSRF 拒绝（安全判定，重试等于绕过）、AbortSignal（调用方主动取消）。
 */
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const RETRYABLE_NET_MESSAGES = [
  'Client network socket disconnected before secure TLS connection was established',
  'socket hang up',
  'Client network socket disconnected',
];

/** 下载重试次数（含首次）：3 次与 admin-http-agent 的 MIN_ATTEMPTS 同值。 */
const DOWNLOAD_MAX_ATTEMPTS = 3;
/** 重试退避基数，第 n 次重试等待 n * 500ms。 */
const DOWNLOAD_RETRY_BACKOFF_MS = 500;

function isRetryableDownloadError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  if (!e) return false;
  if (e.code && RETRYABLE_NET_CODES.has(e.code)) return true;
  const msg = String(e.message ?? '');
  return RETRYABLE_NET_MESSAGES.some((m) => msg.includes(m));
}

export interface DownloadFileOptions {
  maxRedirects?: number;
  sendAuth?: boolean;
  /** Overall time budget for the whole download in ms. */
  timeoutMs?: number;
  /** Reject when more than this many bytes are received. */
  maxBytes?: number;
  /** Abort signal: when fired the in-flight request is destroyed and the
   *  promise rejects with 'Download aborted'. Used by the execution kill /
   *  shutdown path so a stalled package download cannot hold its prepare slot
   *  until the overall deadline (120s+) expires. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * Remove a partially-written download AFTER the write stream releases its fd,
 * without ever gating the caller's promise on completion.
 *
 * W-26 (windows-findings), two races both observed in the field/CI:
 *  - Windows: unlink right after destroy() hits the still-closing fd —
 *    EBUSY/EPERM — and the original error-swallowing callback leaked the
 *    partial file forever (404-cleanup test flaked under load).
 *  - Linux CI: createWriteStream opens lazily, so an IMMEDIATE unlink can run
 *    before the file exists (ENOENT → "done") and the pending write then
 *    CREATES it afterwards — byte-cap-abort test failed exactly this way.
 * Both are closed by the same contract: unlink on the stream's 'close' event
 * (fd released, file definitely materialised if it ever will be) plus a short
 * bounded poll as a fallback when 'close' never arrives (pre-open destroy on
 * some platforms, stubbed streams in unit tests). Callers/tests may poll
 * existence; the TTL workdir sweep stays the last-resort backstop.
 *
 * `expectFile` distinguishes the two callers' futures: fail-path callers may
 * legitimately see the file appear late (lazy open) → keep polling on ENOENT;
 * the redirect-continue path is about to re-create the SAME dest via its
 * recursive download, so ENOENT must STOP immediately — and EBUSY/EPERM may
 * NOT retry (a retried unlink could delete the fresh recursion's partial
 * file). For that caller even the 'close' hook must not resurrect polling.
 */
function removePartialFile(file: fs.WriteStream | undefined, dest: string, expectFile = true, left = 30): void {
  const unlinkOnce = (): boolean => {
    try {
      fs.unlinkSync(dest);
      return true; // removed
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM') return false;
      if (code === 'ENOENT') return !expectFile;
      return true; // EROFS / stub-throws etc.: best effort, stop quietly
    }
  };
  const retry = (attemptsLeft: number): void => {
    if (unlinkOnce() || attemptsLeft <= 0) return;
    // Windows 在 stream destroy 后可能延迟释放句柄（EBUSY/EPERM），
    // 40ms×10 的预算在 CI 上实测不够；放宽到 100ms×30（最多 3s），
    // 仅影响“清理失败”路径，正常 unlink 一次即返回。
    const timer = setTimeout(() => retry(attemptsLeft - 1), 100);
    timer.unref?.();
  };
  file?.once?.('close', () => retry(expectFile ? left : 0));
  retry(left);
}

/**
 * R74-A1（安全面四轴审计·轴 1）：把 ssrf-guard 校验过的地址表变成
 * `http.request` 的 `lookup` 实现。
 *
 * 背景：`assertSafeDnsResolution` 只证明「校验那一刻」解析出的地址安全；而
 * `http.get` 在真正建连时会**再解析一次**。攻击者控制的域名把 TTL 压到 0，
 * 第一次返回公网 IP 过闸、第二次返回 127.0.0.1 / 169.254.169.254，就是教科书
 * 的 DNS rebinding；两个"安全"检查之间那条缝正是缺口。
 *
 * 修法：建连时只从这张已校验的表里取地址，**绝不触发第二次 DNS 查询**。表里
 * 的每个地址在建连前都过了 assertSafeDnsResolution 的逐地址受限判定，所以
 * "校验的目标"与"连接的目标"是同一张表，缝隙消失。
 *
 * Node 的 lookup 契约：`(hostname, options, callback)`，`options.all === true`
 * 时回调 `(null, [{address, family}])`，否则 `(null, address, family)`。
 * 这里忽略 hostname——表本来就是按 URL 主机名解析并校验的。
 */
type PinnedLookupCallback = (err: unknown, address: unknown, family?: unknown) => void;

function createPinnedLookup(pinned: SsrfResolvedAddress[]): (
  hostname: string,
  options: unknown,
  callback: PinnedLookupCallback,
) => void {
  const familyOf = (entry: SsrfResolvedAddress): number =>
    entry.address.includes(':') ? 6 : entry.family || 4;
  return (hostname, options, callback) => {
    const opts = (typeof options === 'function' ? {} : options ?? {}) as {
      family?: number;
      all?: boolean;
    };
    const cb = (typeof options === 'function' ? options : callback) as PinnedLookupCallback;
    // family 只是提示（0/4/6）：优先给同族，取不到就回退到整张表——
    // 宁可连一个已校验的地址，也不要因为族不匹配去解析第二次。
    const wanted = opts.family === 4 ? 4 : opts.family === 6 ? 6 : 0;
    const sameFamily = wanted ? pinned.filter((entry) => familyOf(entry) === wanted) : pinned;
    const chosen = sameFamily.length > 0 ? sameFamily : pinned;
    if (opts.all) {
      cb(null, chosen.map((entry) => ({ address: entry.address, family: familyOf(entry) })));
      return;
    }
    const first = chosen[0];
    cb(null, first.address, familyOf(first));
  };
}

/**
 * 带重试的下载入口（对外导出的仍是 downloadFile 这个名字，调用方零改动）。
 *
 * 只对**连接期**失败重试（见 isRetryableDownloadError）：这类失败发生在响应体
 * 开始落盘之前，同一 URL 重试没有副作用。响应体写到一半失败（体积超限、写盘
 * 失败、调用方 abort）一律直接抛给调用方，不重试。
 */
export async function downloadFile(
  url: string,
  dest: string,
  options: DownloadFileOptions = {},
): Promise<number> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    try {
      return await downloadFileOnce(url, dest, options);
    } catch (err) {
      lastErr = err;
      // 调用方取消 / 最后一次尝试 → 不再重试
      if (options.signal?.aborted) throw err;
      if (attempt >= DOWNLOAD_MAX_ATTEMPTS) throw err;
      if (!isRetryableDownloadError(err)) throw err;
      // 退避后重试；等待期间若被取消则立刻退出（不吞掉 abort 语义）
      await new Promise<void>((resolve) => setTimeout(resolve, attempt * DOWNLOAD_RETRY_BACKOFF_MS));
      if (options.signal?.aborted) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function downloadFileOnce(url: string, dest: string, options: DownloadFileOptions = {}): Promise<number> {
  const {
    maxRedirects = 5,
    sendAuth = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options;
  return new Promise((resolve, reject) => {
    // E-04（DEEP_REVIEW 0ef3bbe）：SSRF 闸——fail-closed，拒绝 loopback/私网/
    // link-local（含云元数据）。redirect 递归也经过同一闸（nextUrl 传入时
    // 同样被校验）。EXECUTOR_ALLOW_PRIVATE_NETWORK=true（`1` 亦兼容）可显式逃生。
    try {
      assertSafeHttpUrl(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    // S-1（audit-r4）：DNS re-resolution 二次闸——语法级检查不解析域名，攻击者
    // 可注册域名做 DNS rebinding（首次解析公网 IP 过闸、连接时二次解析到内网）。
    // 这里在**发起连接前**解析主机名并对全部 A/AAAA 逐一复核受限判定，任一受限
    // 即 fail-closed；解析失败同样拒绝（无法证明目标安全就不连）。残余 TOCTOU
    // 窗口（resolve-then-connect 之间）已在 ssrf-guard 注释中文档化，生产建议
    // 叠加容器/网络层 egress 策略。
    //
    // R74-A1：闸把**已校验的地址表**交回来，startDownload 用它做连接期钉扎
    // （http.request 的 lookup），把上面注释里残留的 resolve-then-connect
    // TOCTOU 窗口真正关掉——否则 rebinding 只需要把 TTL 压到 0 就能二段解析。
    assertSafeDnsResolution(url)
      .then((pinned) => {
        startDownload(pinned);
      })
      .catch((err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });

    function startDownload(pinned: SsrfResolvedAddress[]): void {
    // Overall deadline: req.setTimeout is a socket-idle timeout and a
    // slow-drip server resets it forever, so run an absolute timer too.
    const deadline = setTimeout(() => {
      fail(new Error('下载超时'));
    }, timeoutMs);

    let settled = false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic protocol selection, ESM import cannot be conditional
    const proto = url.startsWith('https') ? require('https') : require('http');
    const file = fs.createWriteStream(dest);
    // 类型上不声明 undefined 联合：proto.get 同步返回 ClientRequest，回调与
    // 同步续段（req.on/setTimeout）执行时必已赋值；`| undefined` 会让 strict
    // 下所有闭包引用报 TS18048（批次 D 全量编译暴露的真实构建阻断）。
    let req: import('http').ClientRequest;
    const onAbort = () => {
      req?.destroy();
      fail(new Error('下载已中止'));
    };
    const cleanup = () => {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      file?.destroy?.();
      // W-26: Windows fd-close race makes a single unlink fail EBUSY — the
      // bounded retry chain inside removePartialFile guarantees eventual
      // removal without gating the reject on it (see its doc comment).
      removePartialFile(file, dest);
      reject(err);
    };
    // The stream can already fail on OPEN (ENOENT: parent dir vanished under
    // us, EACCES/EDQUOT…). The response-callback registration of this same
    // handler below is too late for that early error — with no listener, the
    // 'error' event escapes as an unhandled exception (observed: an
    // update-package test whose temp dir was cleaned while a follow-up
    // download's createWriteStream was still opening, crashing whatever test
    // shared the worker next). fail() is settled-guarded, so the second
    // registration stays harmless.
    file.on('error', fail);

    const headers: Record<string, string> = {};
    if (sendAuth && config.token) {
      headers['Authorization'] = `Bearer ${config.token}`;
    }

    // R74-A1：钉扎表非空时给请求挂上自定义 lookup——建连只从闸校验过的地址里
    // 取，**连接期不再解析 DNS**。字面 IP / localhost / 逃生阀路径的表是空的，
    // 挂与不挂等价（那几条路径本来就没有可被 rebinding 的域名解析）。
    //
    // 2026-10-30：挂 keepAlive agent（见文件头注）。http/https 是两个独立模块，
    // 必须按目标协议挂对应的那个——给 https 目标挂 httpAgent 会被完全忽略，
    // 这正是本路径此前"以为有复用、实际每次冷握手"的原因。
    const requestOptions: Record<string, unknown> = {
      headers,
      agent: url.startsWith('https') ? keepAliveHttpsAgent : keepAliveHttpAgent,
    };
    if (pinned.length > 0) {
      requestOptions.lookup = createPinnedLookup(pinned);
    }

    try {
      if (options.signal) {
        if (options.signal.aborted) {
          fail(new Error('下载已中止'));
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      req = proto.get(url, requestOptions, (res: import('http').IncomingMessage) => {
        if (settled) { res.resume(); return; }
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          cleanup();
          res.resume(); // drain the redirect body; nothing is piped to the (destroyed) file
          settled = true; // resolution continues in the recursive call below
          if (maxRedirects <= 0) {
            file.destroy();
            removePartialFile(file, dest);
            reject(new Error('下载失败：重定向次数过多'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch {
            file.destroy();
            removePartialFile(file, dest);
            reject(new Error('下载失败：重定向地址不合法'));
            return;
          }
          const nextSendAuth = sendAuth && nextUrl.hostname === new URL(url).hostname;
          // W-26: destroy (NOT close): res.pipe(file) is still attached at
          // this point and close() would emit data-after-end → an 'error' that
          // re-enters fail() and double-follows the redirect. destroy() drops
          // the buffered body and releases the fd. removePartialFile runs with
          // expectFile=false: nothing was written through this stream (the
          // 302 body is drained by res.resume()), and the recursion below
          // re-uses dest — a late poll MUST NOT delete the fresh download.
          file.destroy();
          removePartialFile(file, dest, false);
          downloadFile(nextUrl.href, dest, { maxRedirects: maxRedirects - 1, sendAuth: nextSendAuth, timeoutMs, maxBytes, signal: options.signal })
            .then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          fail(new Error(`下载失败，HTTP 状态码 ${res.statusCode}`));
          return;
        }
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy();
            fail(new Error(`下载体积超过上限（${maxBytes} 字节）`));
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          if (settled) return;
          settled = true;
          cleanup();
          file.close();
          resolve(bytes);
        });
        file.on('error', fail);
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    req.on('error', fail);
    // Socket-idle timeout keeps a fully-stalled connection from waiting out
    // the whole deadline before failing.
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      fail(new Error('下载超时'));
    });
    } // end startDownload()
  });
}
