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
import { config } from '../config';
import { assertSafeHttpUrl, assertSafeDnsResolution } from './ssrf-guard';
import type { SsrfResolvedAddress } from './ssrf-guard';

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

export function downloadFile(url: string, dest: string, options: DownloadFileOptions = {}): Promise<number> {
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
    const requestOptions: Record<string, unknown> = { headers };
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
