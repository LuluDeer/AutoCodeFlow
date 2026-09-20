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
function removePartialFile(file: fs.WriteStream | undefined, dest: string, expectFile = true, left = 10): void {
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
    setTimeout(() => retry(attemptsLeft - 1), 40);
  };
  file?.once?.('close', () => retry(expectFile ? left : 0));
  retry(left);
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
    assertSafeDnsResolution(url)
      .then(() => {
        startDownload();
      })
      .catch((err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });

    function startDownload(): void {
    // Overall deadline: req.setTimeout is a socket-idle timeout and a
    // slow-drip server resets it forever, so run an absolute timer too.
    const deadline = setTimeout(() => {
      fail(new Error('Download timed out'));
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
      fail(new Error('Download aborted'));
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

    try {
      if (options.signal) {
        if (options.signal.aborted) {
          fail(new Error('Download aborted'));
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      req = proto.get(url, { headers }, (res: import('http').IncomingMessage) => {
        if (settled) { res.resume(); return; }
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          cleanup();
          res.resume(); // drain the redirect body; nothing is piped to the (destroyed) file
          settled = true; // resolution continues in the recursive call below
          if (maxRedirects <= 0) {
            file.destroy();
            removePartialFile(file, dest);
            reject(new Error('Download failed: too many redirects'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch {
            file.destroy();
            removePartialFile(file, dest);
            reject(new Error('Download failed: invalid redirect location'));
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
          fail(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy();
            fail(new Error(`Download exceeded size limit (${maxBytes} bytes)`));
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
      fail(new Error('Download timed out'));
    });
    } // end startDownload()
  });
}
