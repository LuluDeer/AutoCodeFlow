import * as fs from 'fs';
import * as path from 'path';

/**
 * R13: main-process-side path-domain validation for renderer-supplied paths.
 *
 * Renderer IPC payloads (logPath / filePath) must never be used raw: an
 * arbitrary absolute path would let a compromised renderer read any file
 * (apps:log:read) or, worse, execute one via shell.openPath (log:open-file).
 *
 * Policy: a path is accepted only if it lives under one of the allowed
 * domain roots — `workDir/logs`, `workDir/apps` (task logs / deployed app
 * logs, see executor-node file-logger.ts & routes/deploy.ts) and
 * `userData/logs` (electron-log main.log, see logger.ts). The caller builds
 * the root list from config; this module stays pure (fs/path only) so it is
 * directly testable without Electron.
 */

/** Same charset whitelist as admin-api heartbeat id sanitization
 *  (apps/admin-api/src/modules/executor/executor.service.ts): blocks `../`,
 *  separators and any other traversal payload in executionId. */
export const EXECUTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidExecutionId(id: unknown): id is string {
  return typeof id === 'string' && EXECUTION_ID_PATTERN.test(id);
}

export interface DomainCheckResult {
  ok: boolean;
  /** realpath-resolved absolute path; only present when ok. Read/open THIS,
   *  never the raw renderer input. */
  resolvedPath?: string;
  error?: string;
}

/**
 * Resolve `target` through symlinks as far as the filesystem allows:
 * realpath the nearest existing ancestor, then re-join the non-existent
 * tail components. This lets us validate paths whose final file may not
 * exist yet (e.g. a log for a date that has not happened).
 */
function resolveExistingAncestor(target: string): string | null {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null; // reached filesystem root, nothing exists
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function normalizeForCompare(p: string): string {
  // Windows paths are case-insensitive; compare case-folded there.
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isWithin(candidate: string, root: string): boolean {
  const c = normalizeForCompare(candidate);
  const r = normalizeForCompare(root);
  // Proper containment: equal to root or below it (not a prefix like "logsX").
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * Check that `candidatePath` resolves (via realpath of the nearest existing
 * ancestor) to a location under one of `allowedRoots`.
 *
 * TOCTOU note: between this check and the caller's readFile/openPath, the
 * renderer could in theory swap a component for a symlink. We mitigate by
 * validating and returning a realpath-resolved path (so symlinked ancestors
 * are already collapsed at check time) and by having callers use
 * `resolvedPath` — not the raw input — for the actual I/O. A fully
 * race-free design would require opening a handle and fstat-ing it before
 * each read; that is deliberately out of scope here (kept simple).
 */
export function checkPathWithinDomains(
  candidatePath: unknown,
  allowedRoots: readonly string[],
): DomainCheckResult {
  if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
    return { ok: false, error: 'invalid path argument' };
  }
  if (allowedRoots.length === 0) {
    return { ok: false, error: 'no allowed path domains configured' };
  }
  const real = resolveExistingAncestor(candidatePath);
  if (real === null) {
    return { ok: false, error: 'path could not be resolved' };
  }
  for (const root of allowedRoots) {
    const realRoot = resolveExistingAncestor(root);
    if (realRoot !== null && isWithin(real, realRoot)) {
      return { ok: true, resolvedPath: real };
    }
  }
  return { ok: false, error: 'path is outside the allowed log/app domains' };
}

/** R13: log:open-file must never hand executables/shortcuts to shell.openPath. */
const OPENABLE_LOG_EXTENSIONS = ['.log', '.txt'];

export function hasAllowedLogExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return OPENABLE_LOG_EXTENSIONS.includes(ext);
}
