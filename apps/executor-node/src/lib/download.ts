/** Bearer-authenticated download shared by the deploy and update-package
 *  paths. Carries the executor shared token to the first host, strips it on
 *  cross-host redirects (token must not leak to third-party domains), enforces
 *  an overall deadline (a slow-drip server cannot stall the caller forever)
 *  and a max size cap (a huge file cannot fill the disk). */

import * as fs from 'fs';
import { config } from '../config';

export interface DownloadFileOptions {
  maxRedirects?: number;
  sendAuth?: boolean;
  /** Overall time budget for the whole download in ms. */
  timeoutMs?: number;
  /** Reject when more than this many bytes are received. */
  maxBytes?: number;
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
    // Overall deadline: req.setTimeout is a socket-idle timeout and a
    // slow-drip server resets it forever, so run an absolute timer too.
    const deadline = setTimeout(() => {
      fail(new Error('Download timed out'));
    }, timeoutMs);

    let settled = false;
    const proto = url.startsWith('https') ? require('https') : require('http');
    const file = fs.createWriteStream(dest);
    const cleanup = () => {
      clearTimeout(deadline);
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

    const headers: Record<string, string> = {};
    if (sendAuth && config.token) {
      headers['Authorization'] = `Bearer ${config.token}`;
    }

    let req: import('http').ClientRequest;
    try {
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
          downloadFile(nextUrl.href, dest, { maxRedirects: maxRedirects - 1, sendAuth: nextSendAuth, timeoutMs, maxBytes })
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
  });
}
