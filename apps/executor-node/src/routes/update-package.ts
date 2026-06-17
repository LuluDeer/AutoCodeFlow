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
import * as https from 'https';
import * as http from 'http';
import { logger } from '../logger';
import { post } from '../admin-client';
import { config } from '../config';

export const updatePackageRouter = Router();

interface UpdatePackagePayload {
  packageId: string;
  name: string;
  version: string;
  type: string;
  downloadUrl: string;
  checksum: string; // SHA-256 hex
}

/** Download file to local path, return actual bytes written */
function downloadFile(url: string, dest: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // simple redirect follow
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`Download failed with status ${res.statusCode}`));
        return;
      }
      let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(bytes); });
    });
    req.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error('Download timed out')); });
  });
}

/** Calculate file SHA-256 */
function fileChecksum(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

let updateInProgress = false;

updatePackageRouter.post('/update-package', async (req: Request, res: Response) => {
  const body = req.body as UpdatePackagePayload;

  if (!body.packageId || !body.downloadUrl || !body.version) {
    res.status(400).json({ error: 'Missing required fields: packageId, downloadUrl, version' });
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

    try {
      // 1. Download
      logger.info(`[update-package] Downloading to ${tmpFile}`);
      await downloadFile(body.downloadUrl, tmpFile);

      // 2. Verify checksum if provided
      if (body.checksum) {
        const actual = fileChecksum(tmpFile);
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

      logger.info(`[update-package] Package ${body.name}@${body.version} downloaded successfully to ${tmpFile}`);
      logger.info(`[update-package] Package is available at ${tmpFile} — apply it manually or via your deployment pipeline.`);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[update-package] Update failed: ${msg}`);
      // Clean up partial download
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

      await post('/api/executor-packages/push-result', {
        packageId: body.packageId,
        executorId: config.executorId || undefined,
        status: 'failed',
        error: msg,
      }).catch(() => {});
    } finally {
      updateInProgress = false;
    }
  });
});

/** GET /api/update-package/status -- current update status */
updatePackageRouter.get('/update-package/status', (_req: Request, res: Response) => {
  res.json({ inProgress: updateInProgress });
});
