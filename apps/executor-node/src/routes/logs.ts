import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';

export const logsRouter = Router();

/** S-01: Express middleware — validates Bearer token from EXECUTOR_SHARED_TOKEN env. */
export function executorAuthMiddleware(req: Request, res: Response, next: () => void): void {
  const secret = process.env.EXECUTOR_SHARED_TOKEN || process.env.EXECUTOR_SECRET || '';
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
  // Path traversal guard
  const base = path.resolve(config.workDir);
  const logFile = path.resolve(path.join(config.workDir, `${safeId}.log`));
  if (!logFile.startsWith(base + path.sep) && logFile !== base) {
    res.status(400).json({ error: 'Invalid executionId' });
    return;
  }

  if (!fs.existsSync(logFile)) {
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
  } catch (err: any) {
    logger.error(`Failed to read log file ${logFile}: ${err.message}`);
    res.status(500).json({ error: 'Failed to read log file' });
  }
});
