/**
 * WS5 —— `zip-safety.ts` 单元测试。
 *
 * 重点是**真的把字节写到临时目录再断言磁盘状态**，而不是只断言"抛了错"：
 * zip-slip 的失败模式是"文件落在了不该落的地方"，只有检查磁盘才能证明它
 * 没落下去。恶意样件用与 `zip-guard.spec.ts` 相同的 builder 程序化构造
 * （手写中央目录才能伪造 external attributes / 声明尺寸）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import { ZipSafetyError, safeExtractZip, vetZip } from './zip-safety';

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
  /** Unix 模式写进 external attributes 高 16 位（符号链接 = 0o120777）。 */
  unixMode?: number;
  declaredUncompressed?: number;
  declaredCompressed?: number;
}

/** 程序化构造 zip（含中央目录 external attributes，才能伪造符号链接条目）。 */
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
    // `>>> 0` 必需：0o100644 << 16 会溢出成负 int32，writeUInt32LE 直接抛
    // RangeError（这也是个提醒——external attributes 的高 16 位就是 unix mode）。
    cd.writeUInt32LE(((e.unixMode ?? 0o100644) << 16) >>> 0, 38);
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

const LIMITS = {
  maxRatio: 100,
  maxEntries: 1000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxNestingDepth: 1,
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acf-zipsafety-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** 把 zip 写到临时文件，返回其路径与解压目标目录。 */
function stage(entries: ZipEntryInput[], name = 'pkg.zip') {
  const zipPath = path.join(tmpRoot, name);
  fs.writeFileSync(zipPath, buildZip(entries));
  return { zipPath, destDir: path.join(tmpRoot, 'out') };
}

// ---------------------------------------------------------------------------

describe('zip-safety: happy path', () => {
  it('extracts files and nested directories', () => {
    const { zipPath, destDir } = stage([
      { name: 'main.py', data: Buffer.from('print("hi")\n') },
      { name: 'pkg/', data: Buffer.alloc(0) },
      { name: 'pkg/util.py', data: Buffer.from('X = 1\n') },
      { name: 'requirements.txt', data: Buffer.from('requests==2.31.0\n') },
    ]);

    const result = safeExtractZip(zipPath, destDir, { limits: LIMITS });

    expect(result.entries).toBe(3); // 目录条目不计入写入文件数
    expect(fs.readFileSync(path.join(destDir, 'main.py'), 'utf8')).toBe('print("hi")\n');
    expect(fs.readFileSync(path.join(destDir, 'pkg', 'util.py'), 'utf8')).toBe('X = 1\n');
    expect(fs.readFileSync(path.join(destDir, 'requirements.txt'), 'utf8')).toBe(
      'requests==2.31.0\n',
    );
  });

  it('handles stored (method 0) entries too', () => {
    const { zipPath, destDir } = stage([
      { name: 'a.txt', data: Buffer.from('stored'), method: 0 },
    ]);
    safeExtractZip(zipPath, destDir, { limits: LIMITS });
    expect(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8')).toBe('stored');
  });

  it('creates the destination directory when missing', () => {
    const { zipPath } = stage([{ name: 'a.txt', data: Buffer.from('x') }]);
    const destDir = path.join(tmpRoot, 'deep', 'nested', 'out');
    safeExtractZip(zipPath, destDir, { limits: LIMITS });
    expect(fs.existsSync(path.join(destDir, 'a.txt'))).toBe(true);
  });

  it('keeps the archive by default, removes it when asked', () => {
    const { zipPath, destDir } = stage([{ name: 'a.txt', data: Buffer.from('x') }]);
    safeExtractZip(zipPath, destDir, { limits: LIMITS });
    expect(fs.existsSync(zipPath)).toBe(true);

    const second = stage([{ name: 'b.txt', data: Buffer.from('y') }], 'pkg2.zip');
    safeExtractZip(second.zipPath, second.destDir, { limits: LIMITS, removeArchive: true });
    expect(fs.existsSync(second.zipPath)).toBe(false);
  });
});

describe('zip-safety: zip-slip / traversal (the core defence)', () => {
  it.each([
    '../evil.txt',
    '../../evil.txt',
    'a/../../evil.txt',
    'a/b/../../../evil.txt',
  ])('rejects ".." traversal: %s', (name) => {
    const { zipPath, destDir } = stage([{ name, data: Buffer.from('pwned') }]);

    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);
    // 关键断言：文件绝不能落在目标目录之外。
    expect(fs.existsSync(path.join(tmpRoot, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.resolve(destDir, '..', 'evil.txt'))).toBe(false);
  });

  it('rejects Windows-style backslash traversal (..\\..\\evil)', () => {
    // zip 规范要求 `/`，但 Windows 工具常产出 `\`。只按 `/` 切分会让整个
    // `..\..\evil.txt` 被当成一个无害的文件名。
    const { zipPath, destDir } = stage([{ name: '..\\..\\evil.txt', data: Buffer.from('pwned') }]);

    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);
    expect(fs.existsSync(path.resolve(tmpRoot, 'evil.txt'))).toBe(false);
  });

  it('rejects a mixed-separator traversal (a/..\\../evil)', () => {
    const { zipPath, destDir } = stage([{ name: 'a/..\\../evil.txt', data: Buffer.from('pwned') }]);
    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);
  });

  it('reports violation=zip_slip', () => {
    const { zipPath, destDir } = stage([{ name: '../evil.txt', data: Buffer.from('x') }]);
    try {
      safeExtractZip(zipPath, destDir, { limits: LIMITS });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipSafetyError);
      expect((err as ZipSafetyError).violation).toBe('zip_slip');
    }
  });
});

describe('zip-safety: absolute / drive-letter paths', () => {
  it.each(['/etc/passwd', '/tmp/pwned'])('rejects POSIX absolute path: %s', (name) => {
    const { zipPath, destDir } = stage([{ name, data: Buffer.from('x') }]);
    try {
      safeExtractZip(zipPath, destDir, { limits: LIMITS });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ZipSafetyError).violation).toBe('absolute_path');
    }
  });

  it.each(['C:\\Windows\\evil.txt', 'C:/Windows/evil.txt', 'D:\\evil.txt'])(
    'rejects drive-letter path: %s',
    (name) => {
      const { zipPath, destDir } = stage([{ name, data: Buffer.from('x') }]);
      try {
        safeExtractZip(zipPath, destDir, { limits: LIMITS });
        throw new Error('expected a throw');
      } catch (err) {
        // 关键：在 POSIX 上 path.isAbsolute('C:\\x') 是 false，只靠 isAbsolute
        // 会漏 —— 必须显式匹配盘符。
        expect((err as ZipSafetyError).violation).toBe('drive_letter_path');
      }
    },
  );

  it('rejects a UNC path', () => {
    const { zipPath, destDir } = stage([{ name: '\\\\server\\share\\evil.txt', data: Buffer.from('x') }]);
    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);
  });

  it('rejects an entry name containing a NUL byte', () => {
    const { zipPath, destDir } = stage([{ name: 'ok.txt\u0000../../evil.txt', data: Buffer.from('x') }]);
    try {
      safeExtractZip(zipPath, destDir, { limits: LIMITS });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ZipSafetyError).violation).toBe('bad_archive');
    }
  });
});

describe('zip-safety: symlink entries', () => {
  it('rejects a symbolic-link entry (0o120777)', () => {
    const { zipPath, destDir } = stage([
      { name: 'link', data: Buffer.from('/etc/passwd'), unixMode: 0o120777 },
    ]);

    try {
      safeExtractZip(zipPath, destDir, { limits: LIMITS });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipSafetyError);
      expect((err as ZipSafetyError).violation).toBe('symlink_entry');
    }
    expect(fs.existsSync(path.join(destDir, 'link'))).toBe(false);
  });

  it('still accepts regular files (0o100644) and directories (0o040755)', () => {
    const { zipPath, destDir } = stage([
      { name: 'dir/', data: Buffer.alloc(0), unixMode: 0o040755 },
      { name: 'dir/f.txt', data: Buffer.from('ok'), unixMode: 0o100644 },
    ]);
    safeExtractZip(zipPath, destDir, { limits: LIMITS });
    expect(fs.readFileSync(path.join(destDir, 'dir', 'f.txt'), 'utf8')).toBe('ok');
  });
});

describe('zip-safety: limits', () => {
  it('rejects too many entries', () => {
    const entries: ZipEntryInput[] = [];
    for (let i = 0; i < 20; i++) entries.push({ name: `e${i}.txt`, data: Buffer.from('x') });
    const { zipPath, destDir } = stage(entries);

    try {
      safeExtractZip(zipPath, destDir, { limits: { ...LIMITS, maxEntries: 10 } });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ZipSafetyError).violation).toBe('too_many_entries');
    }
  });

  it('rejects an oversized single entry (guard classifies it first)', () => {
    const { zipPath, destDir } = stage([
      { name: 'big.bin', data: Buffer.alloc(2048, 1), method: 0 },
    ]);

    try {
      safeExtractZip(zipPath, destDir, { limits: { ...LIMITS, maxFileBytes: 1024 } });
      throw new Error('expected a throw');
    } catch (err) {
      // safeExtractZip 先跑 zip-guard 的炸弹审查，声明尺寸超限在那里就被拦下，
      // 因此 violation 是 guard 的分类而非本模块的 entry_too_large。
      // ZipSafetyViolation 把 ZipGuardViolation 纳入联合类型正是为了这个。
      expect(err).toBeInstanceOf(ZipSafetyError);
      expect(['single_file_too_large', 'entry_too_large']).toContain(
        (err as ZipSafetyError).violation,
      );
    }
  });

  it('rejects an over-ratio archive (zip bomb)', () => {
    const { zipPath, destDir } = stage([{ name: 'bomb.bin', data: Buffer.alloc(4 * 1024 * 1024) }]);

    try {
      safeExtractZip(zipPath, destDir, { limits: { ...LIMITS, maxRatio: 2 } });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ZipSafetyError).violation).toBe('ratio_exceeded');
    }
  });

  it('rejects an archive exceeding the total uncompressed limit', () => {
    const { zipPath, destDir } = stage([
      { name: 'a.bin', data: Buffer.alloc(1024, 1), method: 0 },
      { name: 'b.bin', data: Buffer.alloc(1024, 2), method: 0 },
    ]);

    try {
      safeExtractZip(zipPath, destDir, { limits: { ...LIMITS, maxTotalUncompressedBytes: 1500 } });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ZipSafetyError).violation).toBe('total_uncompressed_exceeded');
    }
  });

  it('rejects a corrupt archive (unparseable)', () => {
    const zipPath = path.join(tmpRoot, 'corrupt.zip');
    fs.writeFileSync(zipPath, Buffer.from('this is definitely not a zip file'));
    const destDir = path.join(tmpRoot, 'out');

    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);
  });

  it('rejects a missing archive file', () => {
    expect(() =>
      safeExtractZip(path.join(tmpRoot, 'nope.zip'), path.join(tmpRoot, 'out'), { limits: LIMITS }),
    ).toThrow(ZipSafetyError);
  });
});

describe('zip-safety: declared-size lies are caught (metadata is attacker-controlled)', () => {
  it('an entry declaring a small size but holding a large payload is rejected', () => {
    // 中央目录声明 10 字节，实际 deflate 流解出 1MB —— maxOutputLength 让 zlib
    // 直接抛错，而不是让我们把磁盘写满。
    const payload = Buffer.alloc(1024 * 1024, 7);
    const { zipPath, destDir } = stage([
      { name: 'liar.bin', data: payload, declaredUncompressed: 10 },
    ]);

    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);
    expect(fs.existsSync(path.join(destDir, 'liar.bin'))).toBe(false);
  });

  it('a stored entry whose declared size disagrees with reality is rejected', () => {
    const { zipPath, destDir } = stage([
      { name: 'liar.txt', data: Buffer.from('abc'), method: 0, declaredUncompressed: 999 },
    ]);
    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);
  });
});

describe('zip-safety: partial output cleanup on violation', () => {
  it('removes files written before a later entry violated a rule', () => {
    // 顺序很重要：好文件在前（会被写出），恶意条目在后。违规后必须清理，
    // 否则一个"部分解压"的目录会被当成成功的包继续使用。
    const { zipPath, destDir } = stage([
      { name: 'good1.txt', data: Buffer.from('ok1') },
      { name: 'good2.txt', data: Buffer.from('ok2') },
      { name: '../evil.txt', data: Buffer.from('pwned') },
    ]);

    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);

    expect(fs.existsSync(path.join(destDir, 'good1.txt'))).toBe(false);
    expect(fs.existsSync(path.join(destDir, 'good2.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmpRoot, 'evil.txt'))).toBe(false);
  });

  it('does not delete pre-existing content in destDir (e.g. a prior git clone)', () => {
    const { zipPath, destDir } = stage([
      { name: 'new.txt', data: Buffer.from('new') },
      { name: '../evil.txt', data: Buffer.from('pwned') },
    ]);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'cloned.py'), 'from git');

    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);

    // 本次解压写出的东西被清掉，但前序阶段的产物必须保留。
    expect(fs.existsSync(path.join(destDir, 'new.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(destDir, 'cloned.py'), 'utf8')).toBe('from git');
  });
});

describe('zip-safety: vetZip', () => {
  it('accepts a benign archive', () => {
    const { zipPath } = stage([{ name: 'main.py', data: Buffer.from('print(1)') }]);
    expect(() => vetZip(zipPath, LIMITS)).not.toThrow();
  });

  it('rejects a bomb without extracting anything', () => {
    const { zipPath, destDir } = stage([{ name: 'bomb.bin', data: Buffer.alloc(4 * 1024 * 1024) }]);
    expect(() => vetZip(zipPath, { ...LIMITS, maxRatio: 2 })).toThrow(ZipSafetyError);
    expect(fs.existsSync(destDir)).toBe(false);
  });
});
