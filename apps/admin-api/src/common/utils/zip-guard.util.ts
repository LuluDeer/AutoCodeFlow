import * as fs from "fs";
import { inflateRawSync } from "node:zlib";

/**
 * SEC-05: zip bomb guard — a structural (central-directory) analyzer that
 * runs on the admin-api upload path, before an attacker-supplied archive is
 * persisted / advertised to executors. Zero new dependencies: the ZIP
 * End of Central Directory (EOCD) + Central Directory (CD) records are
 * parsed directly from bytes with Node Buffer primitives.
 *
 * Why structural analysis (not full extraction): admin-api never extracts
 * uploaded packages itself (extraction happens on the executor during
 * deploy). Reading the CD gives the declared uncompressed/compressed sizes
 * for every entry without decompressing anything, so a 42 KB → 4 GB bomb
 * can be rejected by looking at ~metadata bytes. A lying CD (sizes
 * understated to sneak past this check) is still harmless here — the
 * executor-side guard (apps/executor-node zip-guard) re-validates from the
 * real local headers during extraction; the two layers are independent.
 *
 * Limits (all env-tunable via configuration.ts, sane security defaults):
 *  - ratio:    total uncompressed / total compressed ≤ ZIP_MAX_RATIO (100)
 *  - entries:  CD entry count            ≤ ZIP_MAX_ENTRIES (10_000)
 *  - file max: single uncompressed size  ≤ ZIP_MAX_FILE_BYTES (1 GiB)
 *  - nested:   at most one level of nested zip is evaluated eagerly; deeper
 *              archives are counted by their DECLARED (compressed) size
 *              inside the parent — capping recursive probing cost while
 *              still charging the outer ratio for the inner payload.
 *  - total:    declared uncompressed total ≤ 2 GiB (derived hard cap, ratio
 *              alone cannot bound a 500 MB upload's absolute expansion).
 *
 * Fail-closed: any parse anomaly (truncated CD, offset mismatch, unsupported
 * zip64 that we cannot fully resolve) rejects the archive — an unreadable
 * package cannot be vetted, so it is refused.
 */

/** Reason codes surfaced in the thrown error / logs for audit triage. */
export type ZipGuardViolation =
  | "too_many_entries"
  | "ratio_exceeded"
  | "single_file_too_large"
  | "total_uncompressed_exceeded"
  | "nested_zip_too_deep"
  | "unparseable";

export interface ZipGuardLimits {
  /** Max total-uncompressed / total-compressed ratio (default 100). */
  maxRatio: number;
  /** Max central-directory entry count (default 10 000). */
  maxEntries: number;
  /** Max declared uncompressed size of one entry (default 1 GiB). */
  maxFileBytes: number;
  /** Max declared uncompressed total across all entries (default 2 GiB). */
  maxTotalUncompressedBytes: number;
  /** Max nested-zip levels evaluated eagerly (default 1). */
  maxNestingDepth: number;
}

export const ZIP_GUARD_DEFAULT_LIMITS: ZipGuardLimits = {
  maxRatio: 100,
  maxEntries: 10_000,
  maxFileBytes: 1024 * 1024 * 1024, // 1 GiB
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  maxNestingDepth: 1,
};

/** Aggregate central-directory facts for one zip archive. */
export interface ZipCentralDirectorySummary {
  entries: number;
  totalCompressed: number;
  totalUncompressed: number;
  /** Entry names of nested zip members at depth ≤ maxNestingDepth. */
  nestedZipNames: string[];
}

export class ZipGuardError extends Error {
  constructor(
    public readonly violation: ZipGuardViolation,
    message: string,
  ) {
    super(message);
    this.name = "ZipGuardError";
  }
}

interface RawLimits {
  maxRatio?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalUncompressedBytes?: number;
  maxNestingDepth?: number;
}

/** Merge user-supplied limits over the defaults (tests inject small values). */
export function resolveZipGuardLimits(
  overrides?: RawLimits | null,
): ZipGuardLimits {
  return {
    maxRatio:
      overrides?.maxRatio && overrides.maxRatio > 0
        ? overrides.maxRatio
        : ZIP_GUARD_DEFAULT_LIMITS.maxRatio,
    maxEntries:
      overrides?.maxEntries && overrides.maxEntries > 0
        ? overrides.maxEntries
        : ZIP_GUARD_DEFAULT_LIMITS.maxEntries,
    maxFileBytes:
      overrides?.maxFileBytes && overrides.maxFileBytes > 0
        ? overrides.maxFileBytes
        : ZIP_GUARD_DEFAULT_LIMITS.maxFileBytes,
    maxTotalUncompressedBytes:
      overrides?.maxTotalUncompressedBytes &&
      overrides.maxTotalUncompressedBytes > 0
        ? overrides.maxTotalUncompressedBytes
        : ZIP_GUARD_DEFAULT_LIMITS.maxTotalUncompressedBytes,
    maxNestingDepth:
      overrides?.maxNestingDepth !== undefined &&
      overrides.maxNestingDepth !== null &&
      overrides.maxNestingDepth >= 0
        ? overrides.maxNestingDepth
        : ZIP_GUARD_DEFAULT_LIMITS.maxNestingDepth,
  };
}

const U16 = (b: Buffer, off: number) => b.readUInt16LE(off);
const U32 = (b: Buffer, off: number) => b.readUInt32LE(off);

/** 4-byte little-endian signature readers. */
const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
/** Size of the fixed part of the EOCD record (without the comment). */
const EOCD_FIXED_SIZE = 22;
/** Size of the fixed part of one central-directory file header. */
const CD_HEADER_SIZE = 46;
/** Size of the fixed part of one local file header (sig..filename len). */
const LOCAL_HEADER_FILENAME_LEN_OFFSET = 26;

/**
 * Locate the End of Central Directory record by scanning backwards for its
 * signature (the archive comment makes the EOCD offset variable, so a fixed
 * read is wrong for commented archives).
 */
export function locateEocd(buf: Buffer): number {
  const minStart = buf.length - EOCD_FIXED_SIZE;
  if (minStart < 0) {
    throw new ZipGuardError("unparseable", "file smaller than an EOCD record");
  }
  // Comments are usually tiny; cap the scan so a zip-prefixed polyglot can
  // never turn this into an O(n) scanning oracle over a 500 MB buffer.
  const MAX_COMMENT = 65_536 + EOCD_FIXED_SIZE;
  const scanStart = Math.max(0, buf.length - MAX_COMMENT);
  for (let off = minStart; off >= scanStart; off--) {
    if (U32(buf, off) === SIG_EOCD) return off;
  }
  throw new ZipGuardError("unparseable", "EOCD signature not found");
}

/**
 * Parse the central directory of a zip held in memory and aggregate declared
 * sizes. Throws ZipGuardError("unparseable") when the structure is corrupt.
 */
export function parseCentralDirectory(buf: Buffer): ZipCentralDirectorySummary {
  const eocdOff = locateEocd(buf);
  const cdEntries = U16(buf, eocdOff + 10);
  const cdSize = U32(buf, eocdOff + 12);
  const cdOffset = U32(buf, eocdOff + 16);

  // zip64 (0xffffffff sentinels) is not resolved here: admin-api upload caps
  // are 200 MB / 500 MB, and a >4 GB-CD archive cannot be legit for this
  // platform. Fail closed rather than trusting the truncated 32-bit fields.
  if (
    cdOffset === 0xffffffff ||
    cdEntries === 0xffff ||
    cdSize === 0xffffffff
  ) {
    throw new ZipGuardError(
      "unparseable",
      "zip64 EOCD sentinels present — unsupported for upload vetting",
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
        "unparseable",
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
      throw new ZipGuardError(
        "unparseable",
        "central directory name overruns buffer",
      );
    }
    const name = buf.toString("utf8", nameStart, nameEnd);
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (name.toLowerCase().endsWith(".zip")) {
      nestedZipNames.push(name);
    }
    off = nameEnd + extraLen + commentLen;
  }

  // The directory must end exactly where the EOCD says it does; padding or
  // appended data means we did not parse the real directory.
  if (off !== cdOffset + cdSize) {
    throw new ZipGuardError(
      "unparseable",
      "central directory size mismatch with EOCD record",
    );
  }

  return {
    entries: seen,
    totalCompressed,
    totalUncompressed,
    nestedZipNames,
  };
}

/**
 * Check aggregate declared sizes against limits. Pure function over the
 * summary so tests can drive violations without building archives.
 */
export function checkSummaryAgainstLimits(
  summary: ZipCentralDirectorySummary,
  limits: ZipGuardLimits,
): void {
  if (summary.entries > limits.maxEntries) {
    throw new ZipGuardError(
      "too_many_entries",
      `zip declares ${summary.entries} entries (limit ${limits.maxEntries})`,
    );
  }
  if (summary.totalUncompressed > limits.maxTotalUncompressedBytes) {
    throw new ZipGuardError(
      "total_uncompressed_exceeded",
      `zip declares ${summary.totalUncompressed} uncompressed bytes (limit ${limits.maxTotalUncompressedBytes})`,
    );
  }
  // Ratio only makes sense with a non-empty compressed payload; an empty
  // archive (0/0) is degenerate but not a bomb.
  if (
    summary.totalCompressed > 0 &&
    summary.totalUncompressed / summary.totalCompressed > limits.maxRatio
  ) {
    throw new ZipGuardError(
      "ratio_exceeded",
      `zip compression ratio ${(
        summary.totalUncompressed / summary.totalCompressed
      ).toFixed(1)} exceeds limit ${limits.maxRatio}`,
    );
  }
}

/**
 * Full vetting of one in-memory zip buffer:
 * parse the central directory → enforce aggregate limits → (bounded) nested
 * zip recursion → per-file uncompressed size cap. Throws ZipGuardError with
 * the first violated rule; returns the aggregate summary on success.
 *
 * Nested policy (per plan): one level is probed eagerly against the same
 * limits; archives nested deeper than maxNestingDepth are only charged by
 * their declared (compressed) size inside the parent — capping recursive
 * parse cost without giving deeply-stacked bombs a free pass (the declared
 * size still feeds the parent ratio/total, and the executor-side extraction
 * guard re-checks at deploy time).
 */
export function assertZipSafe(
  buf: Buffer,
  limits: ZipGuardLimits = ZIP_GUARD_DEFAULT_LIMITS,
  depth = 0,
): ZipCentralDirectorySummary {
  const summary = parseCentralDirectory(buf);
  checkSummaryAgainstLimits(summary, limits);

  for (const size of perEntryUncompressedSizes(buf)) {
    if (size > limits.maxFileBytes) {
      throw new ZipGuardError(
        "single_file_too_large",
        `zip declares an entry of ${size} uncompressed bytes (limit ${limits.maxFileBytes})`,
      );
    }
  }

  if (depth < limits.maxNestingDepth) {
    for (const name of summary.nestedZipNames) {
      const inner = extractNestedZipBytes(buf, name);
      if (inner) {
        try {
          assertZipSafe(inner, limits, depth + 1);
        } catch (err: unknown) {
          if (err instanceof ZipGuardError && err.violation === "unparseable") {
            // An unreadable nested member cannot be vetted — treat like any
            // other unparseable payload (fail closed), tagged as nested.
            throw new ZipGuardError(
              "unparseable",
              `nested zip "${name}" is corrupt or unreadable`,
            );
          }
          throw err;
        }
      } else {
        // Missing/corrupt nested member bytes — the outer archive passed CD
        // parsing, but we refuse packages we cannot fully vet.
        throw new ZipGuardError(
          "unparseable",
          `nested zip "${name}" could not be located for vetting`,
        );
      }
    }
  } else if (summary.nestedZipNames.length > 0 && depth >= 16) {
    // Depth guard only triggers under direct recursion; the upload path uses
    // depth 0/1. Kept as a hard backstop against unbounded nesting.
    throw new ZipGuardError(
      "nested_zip_too_deep",
      `zip nesting exceeds ${limits.maxNestingDepth} eagerly-vetted level(s)`,
    );
  }
  return summary;
}

/** Iterate declared uncompressed sizes from the central directory. */
function perEntryUncompressedSizes(buf: Buffer): number[] {
  const eocdOff = locateEocd(buf);
  const cdEntries = U16(buf, eocdOff + 10);
  const cdOffset = U32(buf, eocdOff + 16);
  const sizes: number[] = [];
  let off = cdOffset;
  for (let seen = 0; seen < cdEntries; seen++) {
    if (off + CD_HEADER_SIZE > buf.length || U32(buf, off) !== SIG_CD) break;
    sizes.push(U32(buf, off + 24));
    const nameLen = U16(buf, off + 28);
    const extraLen = U16(buf, off + 30);
    const commentLen = U16(buf, off + 32);
    off += CD_HEADER_SIZE + nameLen + extraLen + commentLen;
  }
  return sizes;
}

/**
 * Extract the raw (stored or deflated) bytes of a nested zip member so it
 * can be vetted recursively. Inflates via node:zlib with the declared sizes
 * as bounds (a lying CD that claims "stored 10 bytes" cannot make us inflate
 * gigabytes — output is capped at the declared uncompressed size + slack).
 * Returns null when the entry cannot be located/validated.
 */
function extractNestedZipBytes(buf: Buffer, name: string): Buffer | null {
  const eocdOff = locateEocd(buf);
  const cdEntries = U16(buf, eocdOff + 10);
  const cdOffset = U32(buf, eocdOff + 16);
  let off = cdOffset;
  for (let seen = 0; seen < cdEntries; seen++) {
    if (off + CD_HEADER_SIZE > buf.length || U32(buf, off) !== SIG_CD)
      return null;
    const method = U16(buf, off + 10);
    const compressedSize = U32(buf, off + 20);
    const uncompressedSize = U32(buf, off + 24);
    const localOffset = U32(buf, off + 42);
    const nameLen = U16(buf, off + 28);
    const extraLen = U16(buf, off + 30);
    const commentLen = U16(buf, off + 32);
    const entryName = buf.toString(
      "utf8",
      off + CD_HEADER_SIZE,
      off + CD_HEADER_SIZE + nameLen,
    );
    off += CD_HEADER_SIZE + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;

    // Read the local file header to find the true data start (its name/extra
    // lengths may differ from the CD record).
    if (localOffset + LOCAL_HEADER_FILENAME_LEN_OFFSET + 4 > buf.length)
      return null;
    if (U32(buf, localOffset) !== SIG_LOCAL) return null;
    const localNameLen = U16(
      buf,
      localOffset + LOCAL_HEADER_FILENAME_LEN_OFFSET,
    );
    const localExtraLen = U16(
      buf,
      localOffset + LOCAL_HEADER_FILENAME_LEN_OFFSET + 2,
    );
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) return null;
    const payload = buf.subarray(dataStart, dataEnd);

    if (method === 0) {
      // Stored — the payload IS the content; return it.
      return Buffer.from(payload);
    }
    if (method === 8) {
      // Deflate — ZIP method 8 is RAW deflate (no zlib header). Inflate with
      // the declared size as an absolute output cap (a lying CD cannot make
      // us materialize gigabytes from a small member; maxOutputLength
      // throws when the cap would be exceeded).
      try {
        return inflateRawSync(payload, {
          maxOutputLength: uncompressedSize,
        });
      } catch {
        return null;
      }
    }
    // bzip2/lzma/encryption methods — cannot vet cheaply, fail closed.
    return null;
  }
  return null;
}

/**
 * Read exactly `length` bytes from an open file at `start` using synchronous,
 * bounded reads — the on-disk analogue of `buf.subarray(start, start+length)`.
 * Used so assertZipFileSafe never has to read the whole archive into one
 * Buffer: only the EOCD tail, the central-directory region, and the bounded
 * compressed slice of a nested member are touched. Returns fewer bytes only
 * when the file ends early (callers treat that as unparseable).
 */
function readFileSyncRange(
  filePath: string,
  start: number,
  length: number,
): Buffer {
  if (start < 0 || length < 0) {
    throw new ZipGuardError("unparseable", "invalid file range requested");
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const bytesRead = fs.readSync(
        fd,
        buf,
        filled,
        length - filled,
        start + filled,
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === length ? buf : buf.subarray(0, filled);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Locate a nested zip member's raw (stored/deflated) compressed slice on disk
 * and inflate it (bounded by the declared uncompressed size) so it can be
 * vetted recursively. Mirrors extractNestedZipBytes but reads targeted file
 * ranges instead of slicing an in-memory buffer. Returns null when the entry
 * cannot be located/validated (caller fails closed).
 */
function readNestedZipSliceFromFile(
  filePath: string,
  fileSize: number,
  cd: Buffer,
  cdEntries: number,
  name: string,
): Buffer | null {
  let off = 0;
  for (let seen = 0; seen < cdEntries; seen++) {
    if (off + CD_HEADER_SIZE > cd.length || U32(cd, off) !== SIG_CD)
      return null;
    const method = U16(cd, off + 10);
    const compressedSize = U32(cd, off + 20);
    const uncompressedSize = U32(cd, off + 24);
    const localOffset = U32(cd, off + 42);
    const nameLen = U16(cd, off + 28);
    const extraLen = U16(cd, off + 30);
    const commentLen = U16(cd, off + 32);
    const entryName = cd.toString(
      "utf8",
      off + CD_HEADER_SIZE,
      off + CD_HEADER_SIZE + nameLen,
    );
    off += CD_HEADER_SIZE + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;

    // Local file header: 30 fixed bytes, then name/extra lengths at +26/+28.
    if (localOffset + LOCAL_HEADER_FILENAME_LEN_OFFSET + 4 > fileSize) {
      return null;
    }
    const localHeader = readFileSyncRange(
      filePath,
      localOffset,
      LOCAL_HEADER_FILENAME_LEN_OFFSET + 4,
    );
    if (localHeader.length < LOCAL_HEADER_FILENAME_LEN_OFFSET + 4) return null;
    if (U32(localHeader, 0) !== SIG_LOCAL) return null;
    const localNameLen = U16(localHeader, LOCAL_HEADER_FILENAME_LEN_OFFSET);
    const localExtraLen = U16(
      localHeader,
      LOCAL_HEADER_FILENAME_LEN_OFFSET + 2,
    );
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > fileSize || dataStart < localOffset) return null;
    const payload = readFileSyncRange(filePath, dataStart, compressedSize);
    if (payload.length !== compressedSize) return null;

    if (method === 0) {
      return Buffer.from(payload);
    }
    if (method === 8) {
      try {
        return inflateRawSync(payload, { maxOutputLength: uncompressedSize });
      } catch {
        return null;
      }
    }
    // bzip2/lzma/encryption methods — cannot vet cheaply, fail closed.
    return null;
  }
  return null;
}

/**
 * Convenience wrapper for the upload path: vet a zip file ON DISK by parsing
 * only the EOCD + central directory (plus the bounded compressed slice of any
 * nested zip member). This NEVER reads / decompresses the whole archive —
 * the upload arrives via multer diskStorage, so reading it fully into a Buffer
 * would defeat the streaming change.
 *
 * Signature and fail-closed throw semantics are identical to the previous
 * readFileSync implementation: same violation codes, same message prefixes,
 * same aggregate limits (entries / ratio / per-file / total) and the same
 * one-level nested-zip recursion. Pure structural metadata — no extraction.
 */
export function assertZipFileSafe(
  filePath: string,
  limits: ZipGuardLimits = ZIP_GUARD_DEFAULT_LIMITS,
): ZipCentralDirectorySummary {
  const fileSize = fs.statSync(filePath).size;

  // --- 1. Locate the EOCD in the file tail (comment may shift its offset). ---
  // The EOCD record is at most 22 bytes; the zip comment is <= 64 KiB.
  const maxComment = 65_536 + EOCD_FIXED_SIZE;
  const tailLen = Math.min(fileSize, maxComment);
  if (tailLen < EOCD_FIXED_SIZE) {
    throw new ZipGuardError("unparseable", "file smaller than an EOCD record");
  }
  const tailStart = fileSize - tailLen;
  const tail = readFileSyncRange(filePath, tailStart, tailLen);

  let relEocd = -1;
  for (let off = tailLen - EOCD_FIXED_SIZE; off >= 0; off--) {
    if (U32(tail, off) === SIG_EOCD) {
      relEocd = off;
      break;
    }
  }
  if (relEocd < 0) {
    throw new ZipGuardError("unparseable", "EOCD signature not found");
  }

  const cdEntries = U16(tail, relEocd + 10);
  const cdSize = U32(tail, relEocd + 12);
  const cdOffset = U32(tail, relEocd + 16);

  // zip64 (0xffffffff sentinels) is not resolved here — fail closed, same as
  // the in-memory parser (upload caps are 200 MB / 500 MB).
  if (
    cdOffset === 0xffffffff ||
    cdEntries === 0xffff ||
    cdSize === 0xffffffff
  ) {
    throw new ZipGuardError(
      "unparseable",
      "zip64 EOCD sentinels present — unsupported for upload vetting",
    );
  }
  if (cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > fileSize) {
    throw new ZipGuardError(
      "unparseable",
      "central directory overruns the file",
    );
  }

  // --- 2. Read ONLY the central-directory region. ---
  const cd = readFileSyncRange(filePath, cdOffset, cdSize);
  if (cd.length !== cdSize) {
    throw new ZipGuardError("unparseable", "central directory truncated");
  }

  // --- 3. Walk the CD entries (declared sizes / names only). ---
  let totalCompressed = 0;
  let totalUncompressed = 0;
  const perFileSizes: number[] = [];
  const nestedZipNames: string[] = [];
  let off = 0;
  for (let seen = 0; seen < cdEntries; seen++) {
    if (off + CD_HEADER_SIZE > cd.length || U32(cd, off) !== SIG_CD) {
      throw new ZipGuardError(
        "unparseable",
        `central directory record ${seen} missing or corrupted`,
      );
    }
    const compressedSize = U32(cd, off + 20);
    const uncompressedSize = U32(cd, off + 24);
    const nameLen = U16(cd, off + 28);
    const extraLen = U16(cd, off + 30);
    const commentLen = U16(cd, off + 32);
    const nameStart = off + CD_HEADER_SIZE;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > cd.length) {
      throw new ZipGuardError(
        "unparseable",
        "central directory name overruns buffer",
      );
    }
    const name = cd.toString("utf8", nameStart, nameEnd);
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    perFileSizes.push(uncompressedSize);
    if (name.toLowerCase().endsWith(".zip")) {
      nestedZipNames.push(name);
    }
    off = nameEnd + extraLen + commentLen;
  }
  // The directory must end exactly where the EOCD says it does.
  if (off !== cdSize) {
    throw new ZipGuardError(
      "unparseable",
      "central directory size mismatch with EOCD record",
    );
  }

  const summary: ZipCentralDirectorySummary = {
    entries: cdEntries,
    totalCompressed,
    totalUncompressed,
    nestedZipNames,
  };

  // --- 4. Aggregate limits (pure checks, identical to assertZipSafe). ---
  checkSummaryAgainstLimits(summary, limits);

  for (const size of perFileSizes) {
    if (size > limits.maxFileBytes) {
      throw new ZipGuardError(
        "single_file_too_large",
        `zip declares an entry of ${size} uncompressed bytes (limit ${limits.maxFileBytes})`,
      );
    }
  }

  // --- 5. Bounded nested-zip recursion (reads only the nested member bytes). ---
  if (limits.maxNestingDepth > 0) {
    for (const name of nestedZipNames) {
      const inner = readNestedZipSliceFromFile(
        filePath,
        fileSize,
        cd,
        cdEntries,
        name,
      );
      if (inner) {
        try {
          // depth=1: same one-level eager probe as assertZipSafe(buf) does.
          assertZipSafe(inner, limits, 1);
        } catch (err: unknown) {
          if (err instanceof ZipGuardError && err.violation === "unparseable") {
            throw new ZipGuardError(
              "unparseable",
              `nested zip "${name}" is corrupt or unreadable`,
            );
          }
          throw err;
        }
      } else {
        throw new ZipGuardError(
          "unparseable",
          `nested zip "${name}" could not be located for vetting`,
        );
      }
    }
  }

  return summary;
}
