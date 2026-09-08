import * as zlib from "node:zlib";

/**
 * SEC-05 test fixtures: malicious / benign sample archives, constructed
 * programmatically (no binary fixtures in the repo, no new deps). Every
 * builder emits real, structurally-valid zip bytes so the guard is exercised
 * against the same record layouts clamd/extractors would see.
 *
 * Layout constants (little-endian per the ZIP APPNOTE):
 *   Local file header  PK\x03\x04, central dir PK\x01\x02, EOCD PK\x05\x06.
 *   Deflate (method 8) payloads are wrapped in a zlib raw-deflate container
 *   built by zlib.deflateRawSync.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++)
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

interface ZipEntryInput {
  name: string;
  /** Content bytes (the real data). */
  data?: Buffer;
  /** Method 0 (stored) or 8 (deflate). Default 8 when data provided. */
  method?: number;
  /**
   * Override the DECLARED sizes in local header + central directory. Used to
   * forge bombs whose declared sizes differ from reality (ratio bombs).
   */
  declaredUncompressed?: number;
  declaredCompressed?: number;
}

/** Build a minimal structurally-valid zip from entries. */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? (e.data ? 8 : 0);
    const stored = method === 8 ? zlib.deflateRawSync(data) : Buffer.from(data);
    const crc = crc32(data);

    const declaredComp = e.declaredCompressed ?? stored.length;
    const declaredUncomp = e.declaredUncompressed ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(declaredComp, 18);
    local.writeUInt32LE(declaredUncomp, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(declaredComp, 20);
    cd.writeUInt32LE(declaredUncomp, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    centrals.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** 42 MB of highly compressible zeros → declared 42 MiB, compressed ~KB. */
export function buildHighRatioBomb(): Buffer {
  return buildZip([{ name: "bomb.bin", data: Buffer.alloc(42 * 1024 * 1024) }]);
}

/** Max-size single file: 1 GiB of zeros — real deflation keeps it tiny. */
export function buildSingleFileOversizeBomb(): Buffer {
  return buildZip([
    { name: "huge.bin", data: Buffer.alloc(1024 * 1024 * 1024 + 1) },
  ]);
}

/** Entry-count flood: many tiny entries (default: 10_001 > limit). */
export function buildTooManyEntriesBomb(count = 10_001): Buffer {
  const entries: ZipEntryInput[] = [];
  for (let i = 0; i < count; i++)
    entries.push({ name: `e${i}.txt`, data: Buffer.from("x") });
  return buildZip(entries);
}

/** Zip-in-zip: inner archive is itself a high-ratio bomb. */
export function buildNestedZipBomb(): Buffer {
  const inner = buildHighRatioBomb();
  return buildZip([{ name: "inner.zip", data: inner }]);
}

/** Two nesting levels — outer charge must come from declared sizes. */
export function buildDoubleNestedZip(): Buffer {
  const innermost = buildZip([
    { name: "core.txt", data: Buffer.alloc(5 * 1024 * 1024) },
  ]);
  const middle = buildZip([{ name: "inner.zip", data: innermost }]);
  return buildZip([{ name: "outer.zip", data: middle }]);
}

/** EICAR standard antivirus test string (harmless by design). */
export const EICAR_STRING =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export function buildEicarZip(): Buffer {
  return buildZip([
    { name: "eicar.com", data: Buffer.from(EICAR_STRING, "ascii") },
  ]);
}

/** Benign control: a small, honestly-declared archive. */
export function buildBenignZip(): Buffer {
  return buildZip([
    { name: "main.py", data: Buffer.from("print('hello')\n") },
    { name: "manifest.json", data: Buffer.from('{"runtime":"python"}') },
  ]);
}

/** Corrupt structure: EOCD says there are entries but CD is missing. */
export function buildTruncatedZip(): Buffer {
  const full = buildBenignZip();
  // Chop the whole central directory + EOCD (locals are 0..cdStart).
  return full.subarray(0, 60);
}

/** EOCD with mismatched CD size (parser must reject the mismatch). */
export function buildBadCdSizeZip(): Buffer {
  const full = buildBenignZip();
  const out = Buffer.from(full);
  const eocdOff = out.length - 22;
  out.writeUInt32LE(999999, eocdOff + 12); // cd size lies
  return out;
}

/** A lying local header offset (points into the void). */
export function buildBadLocalOffsetZip(): Buffer {
  const full = buildBenignZip();
  const out = Buffer.from(full);
  const eocdOff = out.length - 22;
  const cdStart = out.readUInt32LE(eocdOff + 16);
  out.writeUInt32LE(cdStart + 5000, cdStart + 42); // local header offset
  return out;
}

/** Valid zip whose EOCD was appended a (short) comment. */
export function buildCommentedZip(): Buffer {
  const base = buildBenignZip();
  const comment = Buffer.from("packaged by CI");
  const withComment = Buffer.concat([base, comment]);
  withComment.writeUInt16LE(comment.length, base.length - 2);
  return withComment;
}
