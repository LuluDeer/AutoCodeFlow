/**
 * POST /api/update-package
 *
 * Receive package push instructions from admin-api, download the new executor package, and trigger self-update.
 * Update strategy: download to temp dir -> verify SHA-256 -> extract and replace -> send confirmation callback
 */
import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { logger } from '../logger';
import { post } from '../admin-client';
import { config } from '../config';
import { downloadFile } from '../lib/download';
import { isSafePathSegment } from '../safe-path';

export const updatePackageRouter = Router();

interface UpdatePackagePayload {
  packageId: string;
  name: string;
  version: string;
  type: string;
  downloadUrl: string;
  checksum: string; // SHA-256 hex
}

/** Overall download budget — an absolute deadline, so a slow-drip server
 *  cannot hold updateInProgress forever (it used to get stuck permanently). */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Belt-and-suspenders watchdog: force-release updateInProgress if the
 *  download+verify flow somehow never settles. */
const UPDATE_WATCHDOG_MS = 15 * 60_000;

/** Calculate file SHA-256 (streamed — package files can be large) */
function fileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

let updateInProgress = false;

updatePackageRouter.post('/update-package', async (req: Request, res: Response) => {
  const body = req.body as UpdatePackagePayload;

  if (!body.packageId || !body.downloadUrl || !body.version) {
    res.status(400).json({ error: 'Missing required fields: packageId, downloadUrl, version' });
    return;
  }
  // The temp filename is derived from packageId — an unvalidated value with
  // '/' or '..' could write the download outside .pkg-updates.
  if (!isSafePathSegment(body.packageId)) {
    res.status(400).json({ error: 'packageId contains unsupported characters' });
    return;
  }
  // An unverified package update is an unacceptable risk — admin-api always
  // sends the SHA-256, so a missing checksum means a malformed request.
  if (!body.checksum) {
    res.status(400).json({ error: 'checksum is required for package updates' });
    return;
  }

  // Only allow http(s) schemes to prevent SSRF via file://, ftp://, etc.
  try {
    const parsedUrl = new URL(body.downloadUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      res.status(400).json({ error: `downloadUrl scheme not allowed: ${parsedUrl.protocol}. Only http and https are permitted.` });
      return;
    }
  } catch {
    res.status(400).json({ error: 'downloadUrl is not a valid URL' });
    return;
  }

  if (updateInProgress) {
    res.status(409).json({ error: 'An update is already in progress' });
    return;
  }

  updateInProgress = true;
  logger.info(`[update-package] Received update request: ${body.name}@${body.version} from ${body.downloadUrl}`);

  // Respond immediately — the actual update runs async
  res.json({ accepted: true, message: `Update to ${body.name}@${body.version} accepted, downloading...` });

  // Run async so the HTTP response is sent before we potentially restart
  setImmediate(async () => {
    const tmpDir = path.join(process.cwd(), '.pkg-updates');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const ext = body.downloadUrl.includes('.tar') ? '.tar.gz' : '.zip';
    const tmpFile = path.join(tmpDir, `${body.packageId}${ext}`);

    // Force-release the in-progress flag even if the flow deadlocks below —
    // otherwise every future package push is rejected with 409 until restart.
    const watchdog = setTimeout(() => {
      if (updateInProgress) {
        updateInProgress = false;
        logger.error(`[update-package] Watchdog fired after ${UPDATE_WATCHDOG_MS}ms — force-releasing updateInProgress`);
      }
    }, UPDATE_WATCHDOG_MS);
    watchdog.unref?.();

    try {
      // 1. Download (shared downloader: Bearer token + absolute deadline + size cap)
      logger.info(`[update-package] Downloading to ${tmpFile}`);
      const bytes = await downloadFile(body.downloadUrl, tmpFile, {
        sendAuth: true,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBytes: DOWNLOAD_MAX_BYTES,
      });

      // 2. Verify checksum if provided
      if (body.checksum) {
        const actual = await fileChecksum(tmpFile);
        if (actual !== body.checksum) {
          throw new Error(`Checksum mismatch: expected ${body.checksum}, got ${actual}`);
        }
        logger.info(`[update-package] Checksum verified OK`);
      }

      // 3. Report success back to admin-api
      await post('/api/executor-packages/push-result', {
        packageId: body.packageId,
        executorId: config.executorId || undefined,
        status: 'downloaded',
        version: body.version,
      }).catch((e) => logger.warn(`[update-package] Failed to report push result: ${e.message}`));

      logger.info(`[update-package] Package ${body.name}@${body.version} downloaded successfully to ${tmpFile} (${bytes} bytes)`);
      logger.info(`[update-package] Package is available at ${tmpFile} — apply it manually or via your deployment pipeline.`);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[update-package] Update failed: ${msg}`);
      // Clean up partial download — 清理本身不得再抛（tmpFile 可能与外部清理
      // 竞态：unlinkSync 的 ENOENT 在 setImmediate 异步回调里无人接住，会以
      // unhandledRejection 归因到同 worker 的下一个无关测试）。
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch (_) { /* already gone */ }

      await post('/api/executor-packages/push-result', {
        packageId: body.packageId,
        executorId: config.executorId || undefined,
        status: 'failed',
        error: msg,
      }).catch(() => {});
    } finally {
      clearTimeout(watchdog);
      updateInProgress = false;
    }
  });
});

/** GET /api/update-package/status -- current update status */
updatePackageRouter.get('/update-package/status', (_req: Request, res: Response) => {
  res.json({ inProgress: updateInProgress });
});
