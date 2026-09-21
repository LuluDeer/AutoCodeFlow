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

  it('rejects a NUL name that would TRUNCATE into a different file (never truncates)', () => {
    // 与 python 对齐的安全语义（`zip_safety._reject_nul_in_name`）：包内名字是
    // `evil.py\0.txt`，按扩展名做的检查看到的是 `.txt`，而"在第一个 NUL 处截断"
    // 的实现会把它落成 `evil.py` —— 名字与扩展名错配，检查被绕过。
    // node 侧一直是拒绝；本用例把"绝不截断落盘"钉死，防止有人为了与（改动前的）
    // python 对齐而把 node 改成截断（那是把安全行为改成不安全行为）。
    const { zipPath, destDir } = stage([
      { name: 'evil.py\u0000.txt', data: Buffer.from('print("pwned")') },
    ]);

    try {
      safeExtractZip(zipPath, destDir, { limits: LIMITS });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipSafetyError);
      expect((err as ZipSafetyError).violation).toBe('bad_archive');
    }

    // 目录本身会被预先建出来（safeExtractZip 在条目循环前 mkdir destDir），
    // 关键是**没有任何文件**按截断名或原名落盘。
    expect(fs.existsSync(path.join(destDir, 'evil.py'))).toBe(false);
    expect(fs.existsSync(path.join(destDir, 'evil.py\u0000.txt'))).toBe(false);
    expect(fs.readdirSync(destDir)).toEqual([]);
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

describe('zip-safety: compression ratio is whole-archive and order-independent', () => {
  // 高压缩比的小条目：1000 个 0 字节 deflate 后 11 字节 → 单条目比 ≈90.9。
  const hot = Buffer.alloc(1000, 0);
  // 几乎不可压缩的大条目：xorshift 伪随机字节（周期远大于 100KB），deflate 后
  // 100035 字节 > 原文 → 比值 ≈1。**不能用周期性数据**（如 `(i*7919)%251`）：
  // 那种"看着随机"的序列能被 deflate 压到几百字节，整个用例的前提就不成立了。
  const cold = (() => {
    const b = Buffer.alloc(100_000);
    let s = 0x2545f491;
    for (let i = 0; i < b.length; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      b[i] = s & 0xff;
    }
    return b;
  })();

  it('accepts the same entry set in BOTH orders when the whole-archive ratio is fine', () => {
    // 失败模式（改动前）：压缩比是按**已遍历前缀**即时比较的，于是
    // [hot, cold] 在第二个条目上算的是 hot 单条目的比值（≈90.9 > 5）而被判成
    // 炸弹，[cold, hot] 却因为前缀已被 cold 摊薄（整包比 ≈1.01）而通过——
    // 同一个包换个条目顺序结论相反。整包比值 = 101000/100046 ≈ 1.01，两个顺序
    // 都必须通过。
    const limits = { ...LIMITS, maxRatio: 5 };

    const hotFirst = stage(
      [{ name: 'a.bin', data: hot }, { name: 'b.bin', data: cold }],
      'hot-first.zip',
    );
    expect(() => safeExtractZip(hotFirst.zipPath, hotFirst.destDir, { limits })).not.toThrow();
    // 用 Buffer.equals 而不是 toEqual：Jest 的深比较对 100KB Buffer 是逐元素
    // 走一遍，单次断言就要秒级；equals 是原生字节比较。
    expect(fs.readFileSync(path.join(hotFirst.destDir, 'a.bin')).equals(hot)).toBe(true);
    expect(fs.readFileSync(path.join(hotFirst.destDir, 'b.bin')).equals(cold)).toBe(true);

    const coldFirst = stage(
      [{ name: 'b.bin', data: cold }, { name: 'a.bin', data: hot }],
      'cold-first.zip',
    );
    expect(() => safeExtractZip(coldFirst.zipPath, coldFirst.destDir, { limits })).not.toThrow();
    expect(fs.readFileSync(path.join(coldFirst.destDir, 'b.bin')).equals(cold)).toBe(true);
    expect(fs.readFileSync(path.join(coldFirst.destDir, 'a.bin')).equals(hot)).toBe(true);
  });

  it('still rejects a genuine bomb (whole-archive ratio over the limit)', () => {
    // 收紧检查不能变成"删掉检查"：整包比值真的超限时两个顺序都必须拒绝。
    // 1MiB 全零 + cold：整包比 ≈11.4 > 5。
    const limits = { ...LIMITS, maxRatio: 5 };
    const bomb = Buffer.alloc(1024 * 1024, 0);

    const cases: Array<[string, ZipEntryInput[]]> = [
      ['bomb-first', [{ name: 'bomb.bin', data: bomb }, { name: 'b.bin', data: cold }]],
      ['bomb-last', [{ name: 'b.bin', data: cold }, { name: 'bomb.bin', data: bomb }]],
    ];
    for (const [label, entries] of cases) {
      const { zipPath, destDir } = stage(entries, `${label}.zip`);
      try {
        safeExtractZip(zipPath, destDir, { limits });
        throw new Error('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZipSafetyError);
        // guard 用同一套整包比值且先跑，命中时透传 ratio_exceeded —— 两者都表示
        // "按整包比值拒绝"，这正是要与 python 对齐的语义。
        expect(['ratio_too_high', 'ratio_exceeded']).toContain(
          (err as ZipSafetyError).violation,
        );
      }
      expect(fs.existsSync(path.join(destDir, 'bomb.bin'))).toBe(false);
    }
  });

  it('vetZip and safeExtractZip agree on the ratio verdict for one archive', () => {
    // 同一份"整包比值正常"的包：两道闸门必须给出同一个结论（改动前 vetZip 走
    // zip-guard 的整包汇总而通过，safeExtractZip 的前缀比较却拒绝）。
    const { zipPath, destDir } = stage(
      [{ name: 'a.bin', data: hot }, { name: 'b.bin', data: cold }],
      'agree.zip',
    );
    const limits = { ...LIMITS, maxRatio: 5 };
    expect(() => vetZip(zipPath, limits)).not.toThrow();
    expect(() => safeExtractZip(zipPath, destDir, { limits })).not.toThrow();
  });
});

describe('zip-safety: unsupported compression methods fail closed with an explicit message', () => {
  // 12=bzip2、14=lzma：node 只用 zlib（仅 stored(0)/deflate(8)），解不开它们，
  // 因此解压时必须**明确**拒绝（点名方法 + 说明只支持 0/8），而不是含糊的
  // bad_archive。python 的 zipfile 原生支持 12/14，已同步改为拒绝以对齐强度
  // （见 zip_safety.py `_reject_unsupported_method`）。
  it.each([12, 14])('rejects method %i with an explicit unsupported_method message', (method) => {
    // 字节原样存放即可：拒绝发生在解压前，不会真的去解码。
    const { zipPath, destDir } = stage(
      [{ name: 'a.txt', data: Buffer.from('hello'), method }],
      `method-${method}.zip`,
    );

    try {
      safeExtractZip(zipPath, destDir, { limits: LIMITS });
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipSafetyError);
      const safety = err as ZipSafetyError;
      expect(safety.violation).toBe('unsupported_method');
      // 错误信息必须可操作：点名方法号与"只支持 0/8"，否则上传者不知道该怎么重打包。
      expect(safety.message).toContain(`method ${method}`);
      expect(safety.message).toContain('stored(0)');
      expect(safety.message).toContain('deflate(8)');
    }
    expect(fs.existsSync(path.join(destDir, 'a.txt'))).toBe(false);
  });

  it('still accepts stored(0) and deflate(8)', () => {
    const { zipPath, destDir } = stage([
      { name: 'stored.txt', data: Buffer.from('s'), method: 0 },
      { name: 'deflated.txt', data: Buffer.from('d'), method: 8 },
    ]);
    safeExtractZip(zipPath, destDir, { limits: LIMITS });
    expect(fs.readFileSync(path.join(destDir, 'stored.txt'), 'utf8')).toBe('s');
    expect(fs.readFileSync(path.join(destDir, 'deflated.txt'), 'utf8')).toBe('d');
  });
});

describe('zip-safety: /api/deploy 必须走本模块（生产故障回归）', () => {
  /**
   * 故障现场（生产实证）：
   *
   *   Expand-Archive : 无法对参数"LiteralPath"执行操作，因为该参数为 Null 或空。
   *
   * 根因不是包有问题，而是 `/api/deploy` 的 Windows 解压分支用
   * `powershell.exe -Command '<脚本>' <arg1> <arg2>` + `$args[0]` 取参——
   * **该形态不填充 `$args`**：`-Command` 已消费掉脚本字符串，后续 token 成为
   * 脚本的独立输出而非参数。实测：
   *
   *   powershell -Command 'Write-Output "COUNT=$($args.Count)"' a b
   *   → COUNT=0        （且 `a b` 被原样打印）
   *
   * 同一个坏模式还在 `assertSafeZipEntries` 里，且后果**更严重**：那里的
   * `ZipFile::OpenRead($args[0])` 拿到空串后抛 "Empty path name is not legal."，
   * 但 PowerShell 把该异常记为 **non-terminating error、退出码仍为 0**，于是
   * 调用方的 `status !== 0` 检查不触发、`entries` 变成空数组、
   * `findUnsafeZipEntries([])` 返回空 —— **zip-slip 路径闸门被静默跳过**。
   *
   * 即：Windows 上这道 SEC 闸门从未真正生效，且因为退出码是 0 而毫无迹象。
   * 修法是让 deploy 与 execute 走同一条 `safeExtractZip`（本模块），
   * 路径判定在**进程内**完成，不把决策权交给任何外部工具的取参形态。
   */
  it('源码守卫：deploy.ts 不得再用 $args 取参，且必须调用 safeExtractZip', () => {
    // 这是"防止回退到坏形态"的静态闸——deploy.spec.ts 把 fs/child_process
    // 全部 mock 掉了，功能性断言在那里必然是空转，拦不住这类回归。
    const deploySrc = fs.readFileSync(
      path.join(__dirname, 'routes', 'deploy.ts'),
      'utf-8',
    );

    // 只在**代码行**上判定，先剥掉注释行：故障复盘的长注释里必然要引用这些
    // 字面量来说明问题（本文件的 describe 头注也引用了），把注释一并扫红会
    // 逼着人把注释写成不可读的绕口令——那是让守卫反过来伤害可维护性。
    const codeLines = deploySrc
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

    // 1) 不得再出现 PowerShell 自动变量取参。`-Command` 形态不填充它，
    //    任何用法都是错的（Expand-Archive 直接报错，.NET 调用则静默失败）。
    expect(codeLines).not.toMatch(/\$args\[/);

    // 2) 不得再直接调 Expand-Archive 解压：它把"条目名 → 落盘路径"的决策权
    //    交给了自己的实现，我们无法逐条目断言目标仍在 destDir 内。
    expect(codeLines).not.toMatch(/Expand-Archive/);

    // 3) packageUrl 分支必须调用 safeExtractZip。
    expect(codeLines).toMatch(/safeExtractZip\(/);
  });

  it('回归本体：safeExtractZip 能解开真实 zip 并逐条目落盘', () => {
    // 直接证明"换成 safeExtractZip 后解压这条路是通的"——即上面那个
    // Expand-Archive 报错的场景已不复存在。
    const { zipPath, destDir } = stage([
      { name: 'index.js', data: Buffer.from('console.log(1)') },
      { name: 'src/app.js', data: Buffer.from('export default 1') },
      { name: 'nested/deep/file.txt', data: Buffer.from('deep') },
    ]);

    const result = safeExtractZip(zipPath, destDir, { limits: LIMITS });

    expect(result.entries).toBe(3);
    expect(fs.readFileSync(path.join(destDir, 'index.js'), 'utf8')).toBe('console.log(1)');
    expect(fs.readFileSync(path.join(destDir, 'src', 'app.js'), 'utf8')).toBe('export default 1');
    expect(fs.readFileSync(path.join(destDir, 'nested', 'deep', 'file.txt'), 'utf8')).toBe('deep');
  });

  it('回归本体：路径遍历条目被拒且不落盘（闸门真的在工作）', () => {
    // 这条是上面"静默跳过"缺陷的反向证明：闸门在进程内判定，绕不过去。
    const { zipPath, destDir } = stage([
      { name: '../escape.txt', data: Buffer.from('pwned') },
    ]);

    expect(() => safeExtractZip(zipPath, destDir, { limits: LIMITS })).toThrow(ZipSafetyError);
    // 关键：文件**没有**落在 destDir 的父目录里。
    expect(fs.existsSync(path.join(tmpRoot, 'escape.txt'))).toBe(false);
  });

  it('回归本体：removeArchive 在解压后删掉 zip（deploy 依赖该语义）', () => {
    // 旧实现是 `fs.unlinkSync(zipPath)`，新实现把删除交给 safeExtractZip 的
    // removeArchive 选项——行为必须等价，否则临时 zip 会残留在 tmpDir。
    const { zipPath, destDir } = stage([{ name: 'a.txt', data: Buffer.from('x') }]);
    expect(fs.existsSync(zipPath)).toBe(true);

    safeExtractZip(zipPath, destDir, { limits: LIMITS, removeArchive: true });

    expect(fs.existsSync(zipPath)).toBe(false);
    expect(fs.readFileSync(path.join(destDir, 'a.txt'), 'utf8')).toBe('x');
  });
});
