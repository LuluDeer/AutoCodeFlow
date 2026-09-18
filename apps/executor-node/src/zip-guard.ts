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
 * O-12: streamed vetting of a zip on disk — reads only the EOCD trailer and
 * the Central Directory block (kilobytes), never the whole archive. Random-access
 * reads via fs.readSync at explicit offsets replace the old fs.readFileSync that
 * pulled the entire (up-to-2 GiB) file into a single Buffer.
 *
 * The EOCD lives at the very end of the file (≤ 22 bytes + 65536 comment). From
 * it we learn the CD offset/size/entry-count, then we read exactly the CD block.
 * Nested-zip probing seeks to each entry's local-header offset and reads only
 * that entry's compressed data (bounded by the declared compressed size from
 * the CD). The existing buffer-based assertZipSafe() is reused for the nested
 * member (already size-bounded by the parent).
 */
function readFullyAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const n = fs.readSync(fd, buf, filled, length - filled, position + filled);
    if (n === 0) {
      throw new ZipGuardError('unparseable', 'unexpected EOF while reading zip');
    }
    filled += n;
  }
  return buf;
}

/** Extract a nested member's bytes from disk via random-access reads. */
function extractNestedZipFromFile(
  fd: number,
  fileSize: number,
  cdBuf: Buffer,
  cdEntries: number,
  name: string,
): Buffer | null {
  let off = 0;
  for (let seen = 0; seen < cdEntries; seen++) {
    if (off + CD_HEADER_SIZE > cdBuf.length || U32(cdBuf, off) !== SIG_CD) return null;
    const method = U16(cdBuf, off + 10);
    const compressedSize = U32(cdBuf, off + 20);
    const uncompressedSize = U32(cdBuf, off + 24);
    const localOffset = U32(cdBuf, off + 42);
    const nameLen = U16(cdBuf, off + 28);
    const extraLen = U16(cdBuf, off + 30);
    const commentLen = U16(cdBuf, off + 32);
    const entryName = cdBuf.toString('utf8', off + CD_HEADER_SIZE, off + CD_HEADER_SIZE + nameLen);
    off += CD_HEADER_SIZE + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;

    if (localOffset + 30 > fileSize) return null;
    const localHdr = readFullyAt(fd, localOffset, 30);
    if (U32(localHdr, 0) !== SIG_LOCAL) return null;
    const localNameLen = U16(localHdr, 26);
    const localExtraLen = U16(localHdr, 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > fileSize) return null;
    const payload = readFullyAt(fd, dataStart, compressedSize);

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

export function assertZipFileSafe(
  filePath: string,
  limits: ZipGuardLimits = getZipGuardLimitsFromEnv(),
): ZipCentralDirectorySummary {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;

    // 1. Read the EOCD search window (last ≤ 64 KiB + 22 fixed bytes).
    const eocdSearchSize = Math.min(fileSize, 65_536 + EOCD_FIXED_SIZE + 1);
    const eocdBlockStart = fileSize - eocdSearchSize;
    const eocdBlock = readFullyAt(fd, eocdBlockStart, eocdSearchSize);

    const eocdRelOff = locateEocd(eocdBlock);
    const cdEntries = U16(eocdBlock, eocdRelOff + 10);
    const cdSize = U32(eocdBlock, eocdRelOff + 12);
    const cdOffset = U32(eocdBlock, eocdRelOff + 16);

    if (cdOffset === 0xffffffff || cdEntries === 0xffff || cdSize === 0xffffffff) {
      throw new ZipGuardError('unparseable', 'zip64 EOCD sentinels present — unsupported');
    }

    // 2. Read exactly the Central Directory block.
    //
    // Bound the read to the space actually available between cdOffset and the
    // EOCD: a malicious EOCD can declare cdSize in the gigabytes, and an
    // unbounded `Buffer.alloc(cdSize)` would re-introduce the very OOM this
    // streaming rewrite removes (the outer file is small, the CD is not). An
    // overstated cdSize still fails closed below — the walk overruns the
    // shorter buffer or trips the `off !== cdSize` size-mismatch check.
    const eocdAbsOff = eocdBlockStart + eocdRelOff;
    const realCdBytes = eocdAbsOff - cdOffset;
    if (cdOffset < 0 || realCdBytes <= 0) {
      throw new ZipGuardError('unparseable', 'central directory offset is out of range');
    }
    const cdReadBytes = Math.min(cdSize, realCdBytes);
    const cdBuf = readFullyAt(fd, cdOffset, cdReadBytes);

    // 3. Walk CD entries (offsets relative to cdBuf start).
    let totalCompressed = 0;
    let totalUncompressed = 0;
    let seen = 0;
    const nestedZipNames: string[] = [];
    let off = 0;

    for (; seen < cdEntries; seen++) {
      if (off + CD_HEADER_SIZE > cdBuf.length || U32(cdBuf, off) !== SIG_CD) {
        throw new ZipGuardError(
          'unparseable',
          `central directory record ${seen} missing or corrupted`,
        );
      }
      const compressedSize = U32(cdBuf, off + 20);
      const uncompressedSize = U32(cdBuf, off + 24);
      const nameLen = U16(cdBuf, off + 28);
      const extraLen = U16(cdBuf, off + 30);
      const commentLen = U16(cdBuf, off + 32);
      const nameStart = off + CD_HEADER_SIZE;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > cdBuf.length) {
        throw new ZipGuardError('unparseable', 'CD name overruns buffer');
      }
      const name = cdBuf.toString('utf8', nameStart, nameEnd);
      totalCompressed += compressedSize;
      totalUncompressed += uncompressedSize;
      if (name.toLowerCase().endsWith('.zip')) nestedZipNames.push(name);
      off = nameEnd + extraLen + commentLen;
    }

    if (off !== cdSize) {
      throw new ZipGuardError(
        'unparseable',
        'central directory size mismatch with EOCD record',
      );
    }

    const summary: ZipCentralDirectorySummary = {
      entries: seen,
      totalCompressed,
      totalUncompressed,
      nestedZipNames,
    };

    // 4. Aggregate limit checks.
    checkSummaryAgainstLimits(summary, limits);

    // 5. Per-file declared cap.
    off = 0;
    for (let i = 0; i < cdEntries; i++) {
      if (off + CD_HEADER_SIZE > cdBuf.length || U32(cdBuf, off) !== SIG_CD) break;
      const size = U32(cdBuf, off + 24);
      if (size > limits.maxFileBytes) {
        throw new ZipGuardError(
          'single_file_too_large',
          `zip declares an entry of ${size} uncompressed bytes (limit ${limits.maxFileBytes})`,
        );
      }
      const nameLen = U16(cdBuf, off + 28);
      const extraLen = U16(cdBuf, off + 30);
      const commentLen = U16(cdBuf, off + 32);
      off += CD_HEADER_SIZE + nameLen + extraLen + commentLen;
    }

    // 6. Nested-zip probing via random-access reads.
    //    At depth 0: eagerly probe only if maxNestingDepth >= 1. Each nested
    //    member is then fully vetted by assertZipSafe() (which tracks depth
    //    internally). The depth>=16 safety valve lives in assertZipSafe.
    if (summary.nestedZipNames.length > 0 && 0 < limits.maxNestingDepth) {
      for (const name of summary.nestedZipNames) {
        const inner = extractNestedZipFromFile(fd, fileSize, cdBuf, cdEntries, name);
        if (!inner) {
          throw new ZipGuardError(
            'unparseable',
            `nested zip "${name}" could not be located/extracted for vetting`,
          );
        }
        try {
          assertZipSafe(inner, limits, 1);
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
    }

    return summary;
  } finally {
    fs.closeSync(fd);
  }
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
