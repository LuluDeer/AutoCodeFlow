import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import { config } from '../config';
import { logger } from '../logger';

export const logsRouter = Router();

/** LOG-02: stream `logFile` line by line and return the requested page plus
 *  totals. Response semantics match the previous readFileSync implementation
 *  exactly (lines split on '\n', trailing empty piece dropped, `totalLines`
 *  counts every line, `hasMore` flags a further page) — but the file is never
 *  held in memory: admin backfill and the UI page through here repeatedly and
 *  a long-running task's log can reach hundreds of MB, which used to spike
 *  memory per request and block the event loop (heartbeats and /health share
 *  it). The whole file is always walked so `totalLines` stays correct for
 *  backfill paging. */
export async function pageLogLines(
  logFile: string,
  fromLine: number,
  limit: number,
): Promise<{ lines: string[]; totalLines: number; hasMore: boolean }> {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(logFile, { encoding: 'utf-8' });
    const rl = createInterface({ input });
    const lines: string[] = [];
    let index = 0;
    rl.on('line', (line: string) => {
      if (index >= fromLine && lines.length < limit) {
        lines.push(line);
      }
      index++;
    });
    rl.on('close', () => {
      resolve({
        lines,
        totalLines: index,
        hasMore: fromLine + lines.length < index,
      });
    });
    rl.on('error', reject);
    input.on('error', reject);
  });
}

/** S-01: Express middleware — validates Bearer token from EXECUTOR_SHARED_TOKEN env. */
export function getExecutorAuthToken(): string {
  return process.env.EXECUTOR_SHARED_TOKEN || process.env.EXECUTOR_SECRET || config.token || '';
}

export function executorAuthMiddleware(req: Request, res: Response, next: () => void): void {
  // Read env at call time so tests can set/unset tokens per-case;
  // fall back to the config value (populated from CLI --token or config file).
  const secret = getExecutorAuthToken();
  if (!secret) {
    next(); // dev mode: no secret configured
    return;
  }
  const auth = req.headers.authorization || '';
  const [scheme, token] = auth.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || token !== secret) {
    res.status(401).json({ error: 'Invalid or missing executor token' });
    return;
  }
  next();
}

logsRouter.get('/logs/:executionId', async (req: Request, res: Response) => {
  const { executionId } = req.params;
  // N4: basename guard — reject if executionId contains path separators or is modified by basename
  const safeId = path.basename(executionId);
  if (safeId !== executionId || safeId === '' || safeId === '.' || safeId === '..') {
    res.status(400).json({ error: 'Invalid executionId' });
    return;
  }

  // B-05: file-logger writes to logs/{date}/{executionId}.log
  // Scan dated subdirectories most-recent first to find the log file.
  const logsBase = path.resolve(path.join(config.workDir, 'logs'));
  let logFile: string | undefined;
  if (fs.existsSync(logsBase)) {
    // Scan dated subdirectories most-recent first
    let dateDirs: string[] = [];
    try {
      dateDirs = (fs.readdirSync(logsBase) as string[]).sort().reverse();
    } catch {
      // readdirSync may fail (e.g. in test environments); fall through to direct-path check
    }
    for (const dateDir of dateDirs) {
      const candidate = path.resolve(path.join(logsBase, dateDir, `${safeId}.log`));
      // Path traversal guard: candidate must stay inside logsBase
      if (candidate.startsWith(logsBase + path.sep) && fs.existsSync(candidate)) {
        logFile = candidate;
        break;
      }
    }
    // Fallback: check flat path logs/{executionId}.log (supports simple layouts and tests)
    if (!logFile) {
      const directPath = path.resolve(path.join(logsBase, `${safeId}.log`));
      if (directPath.startsWith(logsBase + path.sep) && fs.existsSync(directPath)) {
        logFile = directPath;
      }
    }
  }

  if (!logFile) {
    res.status(404).json({ error: 'Log file not found' });
    return;
  }

  // Clamp negatives — slice(-1) would silently return just the last line.
  const fromLine = Math.max(0, parseInt(String(req.query.fromLine ?? '0'), 10) || 0);
  // LOG-01 admin backfill pages with limit=2000 and relies on hasMore to
  // advance; returning the entire tail at once used to blow up both ends'
  // memory on large logs. Clamp to the admin-side page size.
  const MAX_LIMIT = 2000;
  const requestedLimit = parseInt(String(req.query.limit ?? '500'), 10) || 500;
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);

  try {
    res.json(await pageLogLines(logFile, fromLine, limit));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to read log file ${logFile}: ${msg}`);
    res.status(500).json({ error: 'Failed to read log file' });
  }
});
