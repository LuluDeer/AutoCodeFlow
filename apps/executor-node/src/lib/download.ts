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
 * Remove a partially-written download, RETRYING asynchronously on Windows
 * without gating the caller's promise on it.
 *
 * W-26 (windows-findings): `fs.unlink` fired right after `stream.destroy()`
 * races the fd close on Windows — the file is still open, unlink fails
 * EBUSY/EPERM, and the (previously error-swallowing) callback LEAKED the
 * partial file forever (the 404-cleanup test flaked under load; the product
 * impact is orphaned temp files filling the work dir on every failed package
 * download). EBUSY/EPERM now trigger a short bounded retry chain. The retry
 * deliberately does NOT gate resolve/reject: a caller awaiting cleanup would
 * deadlock wherever fs is stubbed (unit mocks) — the TTL workdir sweep remains
 * the backstop for a truly stuck file, and callers/tests can poll existence.
 */
function removePartialFile(dest: string, attemptsLeft = 12): void {
  try {
    fs.unlinkSync(dest);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if ((code === 'EBUSY' || code === 'EPERM') && attemptsLeft > 0) {
      setTimeout(() => removePartialFile(dest, attemptsLeft - 1), 40);
      return;
    }
    // Anything else (EROFS, mocked-fs stubs throwing, …): best effort only.
  }
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
      removePartialFile(dest);
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
            removePartialFile(dest);
            reject(new Error('Download failed: too many redirects'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch {
            file.destroy();
            removePartialFile(dest);
            reject(new Error('Download failed: invalid redirect location'));
            return;
          }
          const nextSendAuth = sendAuth && nextUrl.hostname === new URL(url).hostname;
          // W-26: destroy (NOT close): res.pipe(file) is still attached at
          // this point and close() would emit data-after-end → an 'error' that
          // re-enters fail() and double-follows the redirect. destroy() drops
          // the buffered body and releases the fd; removePartialFile retries
          // the fd-close race. Recursion is NOT gated on the unlink (mocked-fs
          // unit tests must not deadlock).
          file.destroy();
          removePartialFile(dest);
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
