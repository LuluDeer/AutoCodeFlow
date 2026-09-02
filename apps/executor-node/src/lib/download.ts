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
      fs.unlink(dest, () => {});
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
          file.close();
          fs.unlink(dest, () => {});
          settled = true; // resolution continues in the recursive call below
          if (maxRedirects <= 0) {
            reject(new Error('Download failed: too many redirects'));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch {
            reject(new Error('Download failed: invalid redirect location'));
            return;
          }
          const nextSendAuth = sendAuth && nextUrl.hostname === new URL(url).hostname;
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
