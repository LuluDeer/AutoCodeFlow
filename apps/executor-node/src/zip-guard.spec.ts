/**
 * SEC-05: executor-side zip-guard spec — mirrors the admin-api sample set.
 * All archives are built programmatically (zip-samples-equivalent builder
 * inlined to keep the executor bundle self-contained).
 */
import * as zlib from 'zlib';
import {
  ZIP_GUARD_DEFAULT_LIMITS,
  ZipGuardError,
  assertZipSafe,
  checkSummaryAgainstLimits,
  getZipGuardLimitsFromEnv,
  locateEocd,
  parseCentralDirectory,
} from './zip-guard';

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
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

interface ZipEntryInput {
  name: string;
  data?: Buffer;
  method?: number;
  declaredUncompressed?: number;
  declaredCompressed?: number;
}

function buildZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? (e.data ? 8 : 0);
    const stored = method === 8 ? zlib.deflateRawSync(data) : Buffer.from(data);
    const crc = crc32(data);
    const declaredComp = e.declaredCompressed ?? stored.length;
    const declaredUncomp = e.declaredUncompressed ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(declaredComp, 18);
    local.writeUInt32LE(declaredUncomp, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, stored);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(declaredComp, 20);
    cd.writeUInt32LE(declaredUncomp, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);

    offset += local.length + nameBuf.length + stored.length;
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

const SMALL = {
  maxRatio: 100,
  maxEntries: 10000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxNestingDepth: 1,
};

describe('zip-guard (SEC-05) — 恶意样件测试集', () => {
  it('样件1：高压缩比炸弹（42 MiB 零 → 数 KB zip）按 ratio_exceeded 拒绝', () => {
    const zip = buildZip([{ name: 'bomb.bin', data: Buffer.alloc(42 * 1024 * 1024) }]);
    expect(() => assertZipSafe(zip, SMALL)).toThrow(ZipGuardError);
    try {
      assertZipSafe(zip, SMALL);
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe('ratio_exceeded');
    }
  });

  it('样件2：条目数洪泛（10001 条）按 too_many_entries 拒绝', () => {
    const entries: ZipEntryInput[] = [];
    for (let i = 0; i < 10001; i++) entries.push({ name: `e${i}.txt`, data: Buffer.from('x') });
    const zip = buildZip(entries);
    try {
      assertZipSafe(zip, SMALL);
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe('too_many_entries');
    }
  });

  it('样件3：单文件 1 GiB+1 超上限，按 single_file_too_large 拒绝', () => {
    const zip = buildZip([
      { name: 'huge.bin', data: Buffer.alloc(1024 * 1024 * 1024 + 1) },
    ]);
    const fileOnly = { ...SMALL, maxRatio: 100000, maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024 };
    try {
      assertZipSafe(zip, fileOnly);
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe('single_file_too_large');
    }
  });

  it('样件4：嵌套 zip（内层为高比炸弹）一层探测内被拒绝', () => {
    const inner = buildZip([{ name: 'bomb.bin', data: Buffer.alloc(42 * 1024 * 1024) }]);
    const zip = buildZip([{ name: 'inner.zip', data: inner }]);
    try {
      assertZipSafe(zip, SMALL);
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe('ratio_exceeded');
    }
  });

  it('样件5：双层嵌套——maxNestingDepth=2 时最内层计入总量；缺省探测 1 层放行', () => {
    const innermost = buildZip([{ name: 'core.txt', data: Buffer.alloc(5 * 1024 * 1024) }]);
    const middle = buildZip([{ name: 'inner.zip', data: innermost }]);
    const zip = buildZip([{ name: 'outer.zip', data: middle }]);
    const depth2 = { ...SMALL, maxRatio: 100000, maxTotalUncompressedBytes: 4 * 1024 * 1024, maxNestingDepth: 2 };
    try {
      assertZipSafe(zip, depth2);
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe('total_uncompressed_exceeded');
    }
    expect(() => assertZipSafe(zip, SMALL)).not.toThrow();
  });

  it('样件6：正常小包（对照样件）放行并返回正确汇总', () => {
    const zip = buildZip([
      { name: 'main.py', data: Buffer.from("print('hi')\n") },
      { name: 'manifest.json', data: Buffer.from('{"runtime":"python"}') },
    ]);
    const summary = assertZipSafe(zip, SMALL);
    expect(summary.entries).toBe(2);
    expect(summary.nestedZipNames).toEqual([]);
  });

  it('样件7：截断 zip（CD 缺失）fail-closed 按 unparseable 拒绝', () => {
    const full = buildZip([{ name: 'a.txt', data: Buffer.from('hi') }]);
    const truncated = full.subarray(0, 30);
    try {
      assertZipSafe(truncated, SMALL);
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe('unparseable');
    }
  });

  it('样件8：EOCD CD 尺寸被篡改 → unparseable 拒绝', () => {
    const full = buildZip([{ name: 'a.txt', data: Buffer.from('hi') }]);
    const out = Buffer.from(full);
    out.writeUInt32LE(999999, out.length - 22 + 12);
    try {
      assertZipSafe(out, SMALL);
    } catch (err) {
      expect((err as ZipGuardError).violation).toBe('unparseable');
    }
  });

  it('样件9：非 zip 输入（纯文本/空缓冲）按 unparseable 拒绝', () => {
    expect(() => assertZipSafe(Buffer.from('not a zip'), SMALL)).toThrow(ZipGuardError);
    expect(() => assertZipSafe(Buffer.alloc(0), SMALL)).toThrow(ZipGuardError);
  });

  it('样件10：EOCD 注释（定位扫描路径）正确处理', () => {
    const base = buildZip([{ name: 'a.txt', data: Buffer.from('hi') }]);
    const comment = Buffer.from('built by CI');
    const out = Buffer.concat([base, comment]);
    out.writeUInt16LE(comment.length, base.length - 2);
    const summary = assertZipSafe(out, SMALL);
    expect(summary.entries).toBe(1);
  });
});

describe('zip-guard 规则细节', () => {
  it('zip64 哨兵 fail-closed', () => {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 10);
    expect(() => parseCentralDirectory(eocd)).toThrow(ZipGuardError);
  });

  it('0/0 压缩比不触发除零拒绝', () => {
    expect(() =>
      checkSummaryAgainstLimits(
        { entries: 1, totalCompressed: 0, totalUncompressed: 0, nestedZipNames: [] },
        ZIP_GUARD_DEFAULT_LIMITS,
      ),
    ).not.toThrow();
  });

  it('getZipGuardLimitsFromEnv：env 覆盖与缺省回退', () => {
    const d = getZipGuardLimitsFromEnv({});
    expect(d.maxRatio).toBe(100);
    const o = getZipGuardLimitsFromEnv({ ZIP_MAX_RATIO: '50', ZIP_MAX_ENTRIES: '7' });
    expect(o.maxRatio).toBe(50);
    expect(o.maxEntries).toBe(7);
    const bad = getZipGuardLimitsFromEnv({ ZIP_MAX_RATIO: 'bogus' });
    expect(bad.maxRatio).toBe(100);
  });

  it('locateEocd 找不到签名时抛错', () => {
    expect(() => locateEocd(Buffer.alloc(30))).toThrow(ZipGuardError);
  });
});
