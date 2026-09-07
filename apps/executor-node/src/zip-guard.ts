import * as fs from 'fs';
import * as zlib from 'zlib';
import { logger } from './logger';

/**
 * SEC-05: zip-bomb guard for the executor-side EXTRACTION surface
 * (routes/deploy.ts package deploys and routes/update-package.ts package
 * downloads). admin-api never extracts uploads — this executor is the point
 * where an archive's declared sizes become real disk bytes, so the defense
 * lives here too. Complements (does not replace) the traversal check in
 * findUnsafeZipEntries.
 *
 * Zero new dependencies: the End of Central Directory (EOCD) and Central
 * Directory (CD) records are parsed directly with Buffer reads. Declared
 * sizes are metadata — reading them costs kilobytes regardless of the
 * eventual extraction size, so bombs are refused before Expand-Archive /
 * unzip ever run.
 *
 * Limits (env-tunable, security defaults):
 *  - ZIP_MAX_RATIO       uncompressed/compressed total ratio ≤ 100
 *  - ZIP_MAX_ENTRIES     CD entry count ≤ 10 000
 *  - ZIP_MAX_FILE_BYTES  single declared uncompressed size ≤ 1 GiB
 *  - ZIP_MAX_TOTAL_BYTES declared uncompressed total ≤ 2 GiB
 *  - ZIP_MAX_NESTING_DEPTH eagerly-probed nested zip levels (default 1;
 *    deeper members are charged by their declared compressed size in the
 *    parent and re-checked by these same rules at their own extraction)
 *
 * Fail-closed: malformed central directory / zip64 sentinels / unreadable
 * nested members all reject the package — an archive we cannot vet is an
 * archive we do not extract.
 */

export interface ZipGuardLimits {
  maxRatio: number;
  maxEntries: number;
  maxFileBytes: number;
  maxTotalUncompressedBytes: number;
  maxNestingDepth: number;
}

export type ZipGuardViolation =
  | 'too_many_entries'
  | 'ratio_exceeded'
  | 'single_file_too_large'
  | 'total_uncompressed_exceeded'
  | 'nested_zip_too_deep'
  | 'unparseable';

export const ZIP_GUARD_DEFAULT_LIMITS: ZipGuardLimits = {
  maxRatio: 100,
  maxEntries: 10_000,
  maxFileBytes: 1024 * 1024 * 1024, // 1 GiB
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  maxNestingDepth: 1,
};

/** Read limits from env with safe defaults (lazy — test-friendly). */
export function getZipGuardLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ZipGuardLimits {
  const num = (v: string | undefined, d: number): number => {
    const n = parseInt(v || '', 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const depth = parseInt(env.ZIP_MAX_NESTING_DEPTH || '', 10);
  return {
    maxRatio: num(env.ZIP_MAX_RATIO, ZIP_GUARD_DEFAULT_LIMITS.maxRatio),
    maxEntries: num(env.ZIP_MAX_ENTRIES, ZIP_GUARD_DEFAULT_LIMITS.maxEntries),
    maxFileBytes: num(env.ZIP_MAX_FILE_BYTES, ZIP_GUARD_DEFAULT_LIMITS.maxFileBytes),
    maxTotalUncompressedBytes: num(
      env.ZIP_MAX_TOTAL_BYTES,
      ZIP_GUARD_DEFAULT_LIMITS.maxTotalUncompressedBytes,
    ),
    maxNestingDepth: Number.isFinite(depth) && depth >= 0
      ? depth
      : ZIP_GUARD_DEFAULT_LIMITS.maxNestingDepth,
  };
}

export class ZipGuardError extends Error {
  constructor(public readonly violation: ZipGuardViolation, message: string) {
    super(message);
    this.name = 'ZipGuardError';
  }
}

const U16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const U32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_FIXED_SIZE = 22;
const CD_HEADER_SIZE = 46;

/** Locate the EOCD record (comment makes the offset variable). */
export function locateEocd(buf: Buffer): number {
  const minStart = buf.length - EOCD_FIXED_SIZE;
  if (minStart < 0) {
    throw new ZipGuardError('unparseable', 'file smaller than an EOCD record');
  }
  const MAX_COMMENT = 65_536 + EOCD_FIXED_SIZE;
  const scanStart = Math.max(0, buf.length - MAX_COMMENT);
  for (let off = minStart; off >= scanStart; off--) {
    if (U32(buf, off) === SIG_EOCD) return off;
  }
  throw new ZipGuardError('unparseable', 'EOCD signature not found');
}

export interface ZipCentralDirectorySummary {
  entries: number;
  totalCompressed: number;
  totalUncompressed: number;
  nestedZipNames: string[];
}

/** Parse the central directory and aggregate declared sizes. */
export function parseCentralDirectory(buf: Buffer): ZipCentralDirectorySummary {
  const eocdOff = locateEocd(buf);
  const cdEntries = U16(buf, eocdOff + 10);
  const cdSize = U32(buf, eocdOff + 12);
  const cdOffset = U32(buf, eocdOff + 16);

  if (cdOffset === 0xffffffff || cdEntries === 0xffff || cdSize === 0xffffffff) {
    throw new ZipGuardError(
      'unparseable',
      'zip64 EOCD sentinels present — unsupported',
    );
  }

  let totalCompressed = 0;
  let totalUncompressed = 0;
  let seen = 0;
  const nestedZipNames: string[] = [];
  let off = cdOffset;

  for (; seen < cdEntries; seen++) {
    if (off + CD_HEADER_SIZE > buf.length || U32(buf, off) !== SIG_CD) {
      throw new ZipGuardError(
        'unparseable',
        `central directory record ${seen} missing or corrupted`,
      );
    }
    const compressedSize = U32(buf, off + 20);
    const uncompressedSize = U32(buf, off + 24);
    const nameLen = U16(buf, off + 28);
    const extraLen = U16(buf, off + 30);
    const commentLen = U16(buf, off + 32);
    const nameStart = off + CD_HEADER_SIZE;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buf.length) {
      throw new ZipGuardError('unparseable', 'CD name overruns buffer');
    }
    const name = buf.toString('utf8', nameStart, nameEnd);
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (name.toLowerCase().endsWith('.zip')) nestedZipNames.push(name);
    off = nameEnd + extraLen + commentLen;
  }

  if (off !== cdOffset + cdSize) {
    throw new ZipGuardError(
      'unparseable',
      'central directory size mismatch with EOCD record',
    );
  }

  return { entries: seen, totalCompressed, totalUncompressed, nestedZipNames };
}

/** Pure rule check over an aggregate summary. */
export function checkSummaryAgainstLimits(
  summary: ZipCentralDirectorySummary,
  limits: ZipGuardLimits,
): void {
  if (summary.entries > limits.maxEntries) {
    throw new ZipGuardError(
      'too_many_entries',
      `zip declares ${summary.entries} entries (limit ${limits.maxEntries})`,
    );
  }
  if (summary.totalUncompressed > limits.maxTotalUncompressedBytes) {
    throw new ZipGuardError(
      'total_uncompressed_exceeded',
      `zip declares ${summary.totalUncompressed} uncompressed bytes (limit ${limits.maxTotalUncompressedBytes})`,
    );
  }
  if (
    summary.totalCompressed > 0 &&
    summary.totalUncompressed / summary.totalCompressed > limits.maxRatio
  ) {
    throw new ZipGuardError(
      'ratio_exceeded',
      `compression ratio ${(summary.totalUncompressed / summary.totalCompressed).toFixed(1)} exceeds limit ${limits.maxRatio}`,
    );
  }
}

/**
 * Full vetting of one in-memory zip buffer. Bounded nested-zip probing with
 * raw-deflate inflation capped at declared sizes. Throws ZipGuardError.
 */
export function assertZipSafe(
  buf: Buffer,
  limits: ZipGuardLimits = ZIP_GUARD_DEFAULT_LIMITS,
  depth = 0,
): ZipCentralDirectorySummary {
  const summary = parseCentralDirectory(buf);
  checkSummaryAgainstLimits(summary, limits);

  // Per-file declared cap.
  {
    const eocdOff = locateEocd(buf);
    const cdEntries = U16(buf, eocdOff + 10);
    const cdOffset = U32(buf, eocdOff + 16);
    let off = cdOffset;
    for (let seen = 0; seen < cdEntries; seen++) {
      if (off + CD_HEADER_SIZE > buf.length || U32(buf, off) !== SIG_CD) break;
      const size = U32(buf, off + 24);
      if (size > limits.maxFileBytes) {
        throw new ZipGuardError(
          'single_file_too_large',
          `zip declares an entry of ${size} uncompressed bytes (limit ${limits.maxFileBytes})`,
        );
      }
      const nameLen = U16(buf, off + 28);
      const extraLen = U16(buf, off + 30);
      const commentLen = U16(buf, off + 32);
      off += CD_HEADER_SIZE + nameLen + extraLen + commentLen;
    }
  }

  if (depth < limits.maxNestingDepth) {
    for (const name of summary.nestedZipNames) {
      const inner = extractNestedZipBytes(buf, name);
      if (!inner) {
        throw new ZipGuardError(
          'unparseable',
          `nested zip "${name}" could not be located/extracted for vetting`,
        );
      }
      try {
        assertZipSafe(inner, limits, depth + 1);
      } catch (err: any) {
        if (err instanceof ZipGuardError && err.violation === 'unparseable') {
          throw new ZipGuardError(
            'unparseable',
            `nested zip "${name}" is corrupt or unreadable`,
          );
        }
        throw err;
      }
    }
  } else if (summary.nestedZipNames.length > 0 && depth >= 16) {
    throw new ZipGuardError(
      'nested_zip_too_deep',
      `zip nesting exceeds ${limits.maxNestingDepth} eagerly-vetted level(s)`,
    );
  }
  return summary;
}

/** Pull a nested member's bytes (stored or raw-deflate), size-capped. */
function extractNestedZipBytes(buf: Buffer, name: string): Buffer | null {
  const eocdOff = locateEocd(buf);
  const cdEntries = U16(buf, eocdOff + 10);
  const cdOffset = U32(buf, eocdOff + 16);
  let off = cdOffset;
  for (let seen = 0; seen < cdEntries; seen++) {
    if (off + CD_HEADER_SIZE > buf.length || U32(buf, off) !== SIG_CD) return null;
    const method = U16(buf, off + 10);
    const compressedSize = U32(buf, off + 20);
    const uncompressedSize = U32(buf, off + 24);
    const localOffset = U32(buf, off + 42);
    const nameLen = U16(buf, off + 28);
    const extraLen = U16(buf, off + 30);
    const commentLen = U16(buf, off + 32);
    const entryName = buf.toString('utf8', off + CD_HEADER_SIZE, off + CD_HEADER_SIZE + nameLen);
    off += CD_HEADER_SIZE + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;

    if (localOffset + 30 > buf.length) return null;
    if (U32(buf, localOffset) !== SIG_LOCAL) return null;
    const localNameLen = U16(buf, localOffset + 26);
    const localExtraLen = U16(buf, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) return null;
    const payload = buf.subarray(dataStart, dataEnd);

    if (method === 0) return Buffer.from(payload);
    if (method === 8) {
      try {
        return zlib.inflateRawSync(payload, { maxOutputLength: uncompressedSize });
      } catch {
        return null;
      }
    }
    return null; // bzip2/lzma/encrypted — cannot vet, fail closed
  }
  return null;
}

/**
 * Vet a zip on disk (streamed read of the whole file into memory — the
 * download cap bounds this at 2 GiB; typical packages are far smaller).
 * Called by deploy/update-package before extraction.
 */
export function assertZipFileSafe(
  filePath: string,
  limits: ZipGuardLimits = getZipGuardLimitsFromEnv(),
): ZipCentralDirectorySummary {
  const buf = fs.readFileSync(filePath);
  return assertZipSafe(buf, limits);
}

/** Convenience wrapper: log the violation and convert to a plain Error with
 *  a `[violation]` prefix so existing catch-and-report paths stay unchanged. */
export function guardZipOrThrow(filePath: string): void {
  try {
    assertZipFileSafe(filePath);
  } catch (err: any) {
    if (err instanceof ZipGuardError) {
      logger.warn(
        `[zip-guard] Package rejected [${err.violation}]: ${err.message} (${filePath})`,
      );
      throw new Error(`Unsafe package rejected by zip-guard [${err.violation}]`);
    }
    throw err;
  }
}
