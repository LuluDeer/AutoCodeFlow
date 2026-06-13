import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';

export const logsRouter = Router();

/** S-01: Express middleware — validates Bearer token from EXECUTOR_SHARED_TOKEN env. */
export function executorAuthMiddleware(req: Request, res: Response, next: () => void): void {
  // Read env at call time so tests can set/unset EXECUTOR_SHARED_TOKEN per-case;
  // fall back to the config value (populated from CLI --token or config file).
  const secret = process.env.EXECUTOR_SHARED_TOKEN || config.token;
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

logsRouter.get('/logs/:executionId', (req: Request, res: Response) => {
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

  const fromLine = parseInt(String(req.query.fromLine ?? '0'), 10) || 0;

  try {
    const raw = fs.readFileSync(logFile, 'utf-8');
    const allLines = raw.split('\n');
    // Remove trailing empty line from final newline
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    const total = allLines.length;
    const sliced = allLines.slice(fromLine);
    res.json({ lines: sliced, totalLines: total, hasMore: false });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to read log file ${logFile}: ${msg}`);
    res.status(500).json({ error: 'Failed to read log file' });
  }
});
