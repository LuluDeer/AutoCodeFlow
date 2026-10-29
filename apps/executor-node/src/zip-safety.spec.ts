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

import {
  WINDOWS_RESERVED_DEVICE_NAMES,
  ZipSafetyError,
  normalizeEntryNameForWin32,
  safeExtractZip,
  vetZip,
} from './zip-safety';

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

  // Round6-P3-2（八域审计第 6 轮，执行器域 P3）：**驱动器相对**条目（`C:foo`，
  // 盘符后没有分隔符）两端结论必须一致。
  //
  // 旧行为分叉：python `zip_safety.py` 的 `_WINDOWS_DRIVE_RE = r'^[A-Za-z]:'` 判
  // `drive_letter_path` 拒绝；node 的 `/^[A-Za-z]:[\\/]/` 要求分隔符 → 漏过闸门，
  // POSIX 上静默落出 `C:foo` 这个文件名（名字里带冒号，Windows 客户端无法创建），
  // Windows 上则解析到「C 盘当前目录」——同一个包在两端/两机落点不同。
  //
  // 结论取**拒绝**（与 python 逐字同标签）：驱动器相对条目在 zip 里没有任何合法
  // 用例（zip 规范要求 `/` 分隔的相对路径），而它在 Windows 上的真实语义是
  // 「C 盘当前目录」，既不是解压目标目录、也不是包内声明的名字。
  // 反证：把正则改回 `^[A-Za-z]:[\\/]` → 本组用例转红（POSIX 上还会真的落出
  // 一个 `C:evil.txt` 文件，断言 `readdirSync` 为空的第二段也会红）。
  it.each(['C:evil.txt', 'C:foo', 'D:relative.txt', 'C:'])(
    'rejects DRIVE-RELATIVE path (no separator after the colon): %s',
    (name) => {
      const { zipPath, destDir } = stage([{ name, data: Buffer.from('x') }]);
      try {
        safeExtractZip(zipPath, destDir, { limits: LIMITS });
        throw new Error('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ZipSafetyError);
        // 与 python 同标签：`drive_letter_path`（不是 zip_slip —— 后者只覆盖
        // 「目标解析到 destDir 之外」这一种成因，驱动器相对的落点取决于盘符与
        // 进程当前目录，用 zip_slip 描述会让调用方误判根因）。
        expect((err as ZipSafetyError).violation).toBe('drive_letter_path');
      }
      // 关键反证：不得有任何文件按「条目原名」落盘（POSIX 上旧实现会落出
      // `C:evil.txt`）。
      expect(fs.existsSync(path.join(destDir, name))).toBe(false);
      expect(fs.existsSync(destDir) ? fs.readdirSync(destDir) : []).toEqual([]);
    },
  );

  // 注：`vetZip` 不做路径闸门（它只复用 zip-guard 的炸弹审查，见模块头注
  // §"两者是独立的两道闸门"），故 `C:evil.txt` 在审查阶段通过、只在
  // `safeExtractZip` 的逐条目闸门被拒。python 侧 `vet_zip` 会顺带做名称闸，
  // 那条差异属既有分工（node 的审查面不含落盘路径），不在本条改动面内。

  it('单字母 + 冒号的普通相对名同样被拒（与 python 一致：不猜用户意图）', () => {
    // `a:b.txt` 在 Windows 上是「A 盘当前目录下的 b.txt」，在 POSIX 上只是一个
    // 合法的怪名字。两端都按盘符处理（python 早已如此），不因宿主平台改变裁定。
    const { zipPath, destDir } = stage([{ name: 'a:b.txt', data: Buffer.from('x') }]);
    try {
      safeExtractZip(zipPath, destDir, { limits: LIMITS });
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as ZipSafetyError).violation).toBe('drive_letter_path');
    }
  });

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
      expect(safety.message).toContain(`压缩方法 ${method}`);
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

// ---------------------------------------------------------------------------

/**
 * R101：**生产默认路径**必须吃 `ZIP_MAX_*` 环境变量。
 *
 * 已有的 limits 用例一律**显式传 `limits`**，于是它们只证明了「参数生效」，没有证明
 * 「不传参时从 env 求值」。这与 `executor-python` 刚被修掉的那个缺口是同一个形状：
 * `get_zip_limits_from_env()` 存在、有单测、文档也写会生效，但**生产路径从不调用**它
 * （python 侧 `_extract_package` 就是这么躺着的）。
 *
 * node 侧目前接线是对的（`vetZip` / `safeExtractZip` 都 default 到
 * `getZipGuardLimitsFromEnv()`），但没有任何用例钉住它 —— 谁把这两处改成
 * `ZIP_GUARD_DEFAULT_LIMITS`，测试会全绿而部署方按 `ZIP_MAX_*` 收紧后**静默失效**。
 */
describe('zip-safety: 生产默认路径吃 ZIP_MAX_* 环境变量（R101）', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['ZIP_MAX_ENTRIES', 'ZIP_MAX_FILE_BYTES'];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('safeExtractZip 不传 limits 时按 ZIP_MAX_ENTRIES 拒绝', () => {
    const entries: ZipEntryInput[] = [];
    for (let i = 0; i < 20; i++) entries.push({ name: `e${i}.txt`, data: Buffer.from('x') });
    const { zipPath, destDir } = stage(entries);

    // 默认 10 000 条：不设 env 时这个包是合法的 —— 先证明这一点，
    // 否则下面的「拒绝」可能来自与 env 无关的原因（假绿）。
    safeExtractZip(zipPath, destDir);

    process.env.ZIP_MAX_ENTRIES = '10';
    try {
      safeExtractZip(zipPath, destDir);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ZipSafetyError);
      expect((err as ZipSafetyError).violation).toBe('too_many_entries');
    }
  });

  it('vetZip 不传 limits 时按 ZIP_MAX_FILE_BYTES 拒绝', () => {
    const { zipPath } = stage([{ name: 'big.bin', data: Buffer.alloc(4096, 1), method: 0 }]);

    expect(() => vetZip(zipPath)).not.toThrow();

    process.env.ZIP_MAX_FILE_BYTES = String(1024);
    expect(() => vetZip(zipPath)).toThrow(ZipSafetyError);
  });
});

/**
 * EXEC-03（第 3 轮并行审计，P2）：条目名的 **Windows 归一化**校验。
 *
 * 失败模式：同一个 zip 在 Linux 上解出 `A.txt` + `a.txt` 两个文件，在 Windows 上
 * 解成同一个文件（后写覆盖先写）；`CON.txt` / `a.` / `a ` 在 Windows 上要么根本
 * 建不出来（保留设备名），要么被静默裁剪成另一个名字——"写入成功但文件不存在"。
 *
 * 归一化规则必须与 `apps/executor-python/zip_safety.py` **逐条一致**（见
 * `normalizeEntryNameForWin32` / `normalize_entry_name_for_win32`）：
 *   ① 分隔符归一：`\` → `/`，丢弃空段与 `.` 段；
 *   ② 每段裁掉尾随点与空格（`..` 段除外，它归 zip_slip 管）；
 *   ③ 大小写折叠（`toLowerCase`）；
 *   ④ 键相同即"同一目标"→ 整包拒绝。
 */
describe('zip-safety: EXEC-03 Windows 归一化（保留设备名 / 尾随点空格 / 折叠碰撞）', () => {
  /** 断言整包被拒 + violation 精确匹配 + **目标目录零产物**。 */
  function expectRejected(
    entries: ZipEntryInput[],
    violation: string,
    destDir?: string,
  ): ZipSafetyError {
    const staged = stage(entries);
    const out = destDir ?? staged.destDir;
    try {
      safeExtractZip(staged.zipPath, out, { limits: LIMITS });
    } catch (err) {
      expect(err).toBeInstanceOf(ZipSafetyError);
      expect((err as ZipSafetyError).violation).toBe(violation);
      // 拒绝必须发生在写出任何字节之前/之时的整体回滚：不留半个产物。
      expect(listFiles(out)).toEqual([]);
      return err as ZipSafetyError;
    }
    throw new Error(`expected a throw for ${JSON.stringify(entries.map((e) => e.name))}`);
  }

  function listFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else out.push(path.relative(dir, p));
      }
    };
    walk(dir);
    return out.sort();
  }

  it.each([
    'CON',
    'con',
    'CON.txt',
    'nul.log',
    'Aux',
    'aux.txt',
    'PRN',
    'com1',
    'COM9.bin',
    'lpt1',
    'LPT9.dat',
    'pkg/CON.txt',
    'deep/nested/COM3.log',
  ])('拒绝 Windows 保留设备名：%s', (name) => {
    const err = expectRejected([{ name, data: Buffer.from('x') }], 'windows_reserved_name');
    expect(err.message).toContain('zip 条目使用了 Windows 保留设备名');
    expect(err.message).toContain(name);
  });

  it.each([
    'a.txt.',
    'a.txt ',
    'a.txt. ',
    'dir./a.txt',
    'dir /a.txt',
    'trailing.',
  ])('拒绝尾随点/空格条目名：%s', (name) => {
    const err = expectRejected([{ name, data: Buffer.from('x') }], 'windows_trailing_dot_space');
    expect(err.message).toContain('Windows 会静默裁剪');
  });

  it('前缀相似的非保留名不得被误伤（aux-data.txt / console.txt / nullable.txt）', () => {
    const { zipPath, destDir } = stage([
      { name: 'aux-data.txt', data: Buffer.from('a') },
      { name: 'console.txt', data: Buffer.from('b') },
      { name: 'nullable.txt', data: Buffer.from('c') },
      { name: 'auxiliary/notes.txt', data: Buffer.from('d') },
      { name: 'com10.txt', data: Buffer.from('e') },
      { name: 'lpt0.txt', data: Buffer.from('f') },
      // 主干（第一个 `.` 之前）不等于设备名：`aux.txt` 会中招（主干 aux），
      // `my.con` 不会（主干 my）。另注：`nul.logs.txt` 的主干仍是 `nul`，
      // 属于**应当**被拒的保留名——Windows 建不出该文件名。
      { name: 'my.con', data: Buffer.from('g') },
    ]);

    safeExtractZip(zipPath, destDir, { limits: LIMITS });

    expect(fs.readFileSync(path.join(destDir, 'aux-data.txt'), 'utf8')).toBe('a');
    expect(fs.readFileSync(path.join(destDir, 'console.txt'), 'utf8')).toBe('b');
    expect(fs.readFileSync(path.join(destDir, 'com10.txt'), 'utf8')).toBe('e');
    expect(fs.readFileSync(path.join(destDir, 'lpt0.txt'), 'utf8')).toBe('f');
    expect(fs.readFileSync(path.join(destDir, 'my.con'), 'utf8')).toBe('g');
    expect(fs.readFileSync(path.join(destDir, 'auxiliary', 'notes.txt'), 'utf8')).toBe('d');
  });

  it.each([
    [['A.txt', 'a.txt']],
    [['README.md', 'readme.md']],
    [['pkg/Main.py', 'PKG/main.py']],
    [['a/b/c.txt', 'A/B/C.TXT']],
    // 分隔符差异折叠到同一目标（`a\b` 与 `a/b`）
    [['dir\\x.txt', 'dir/x.txt']],
  ])('大小写折叠加目标碰撞 → duplicate_entry：%j', (names) => {
    const err = expectRejected(
      names.map((name) => ({ name, data: Buffer.from(name) })),
      'duplicate_entry',
    );
    expect(err.message).toContain('归一化后均为');
  });

  it('完全重复的同名条目 → duplicate_entry（后者会静默覆盖前者）', () => {
    const err = expectRejected(
      [
        { name: 'same.txt', data: Buffer.from('first') },
        { name: 'same.txt', data: Buffer.from('second') },
      ],
      'duplicate_entry',
    );
    expect(err.message).toContain('same.txt');
  });

  it('目录条目与同名文件条目也算同一目标（Windows/Linux 都建不出来）', () => {
    expectRejected(
      [
        { name: 'thing/', data: Buffer.alloc(0) },
        { name: 'thing', data: Buffer.from('x') },
      ],
      'duplicate_entry',
    );
  });

  it('合法包不受影响：Unicode / 深层目录 / 显式目录条目 / 大小写不同的不同名字', () => {
    const { zipPath, destDir } = stage([
      { name: 'pkg/', data: Buffer.alloc(0) },
      { name: 'pkg/主程序.py', data: Buffer.from('print(1)\n') },
      { name: 'pkg/deep/nested/dir/data.json', data: Buffer.from('{"a":1}') },
      { name: 'pkg/naïve-Ünïcode.txt', data: Buffer.from('u') },
      { name: 'Makefile', data: Buffer.from('all:') },
      { name: 'makefile.inc', data: Buffer.from('x') }, // 不同名字，不折叠碰撞
      { name: 'a-b.txt', data: Buffer.from('1') },
      { name: 'a_b.txt', data: Buffer.from('2') },
    ]);

    const result = safeExtractZip(zipPath, destDir, { limits: LIMITS });

    expect(result.entries).toBe(7);
    expect(fs.readFileSync(path.join(destDir, 'pkg', '主程序.py'), 'utf8')).toBe('print(1)\n');
    expect(fs.existsSync(path.join(destDir, 'pkg', 'deep', 'nested', 'dir', 'data.json'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(destDir, 'pkg', 'naïve-Ünïcode.txt'))).toBe(true);
  });

  it('归一化键：分隔符归一 + 尾随点空格裁剪 + 大小写折叠（与 python 同算法）', () => {
    expect(normalizeEntryNameForWin32('Pkg\\Sub\\File.TXT')).toBe('pkg/sub/file.txt');
    expect(normalizeEntryNameForWin32('a.txt.')).toBe('a.txt');
    expect(normalizeEntryNameForWin32('a.txt ')).toBe('a.txt');
    expect(normalizeEntryNameForWin32('a.txt. . ')).toBe('a.txt');
    expect(normalizeEntryNameForWin32('./a//b.txt')).toBe('a/b.txt');
    // `..` 段不被裁剪（它归 zip_slip 闸门，归一化不得把它变成 `a`）
    expect(normalizeEntryNameForWin32('a/../b')).toBe('a/../b');
    // 非 ASCII 不做 locale 特化折叠（两端都只用语言内置的小写映射）
    expect(normalizeEntryNameForWin32('Ä.txt')).toBe(normalizeEntryNameForWin32('Ä.txt'));
  });

  it('保留设备名表与 python 侧逐字一致（改表必须两端同批）', () => {
    expect([...WINDOWS_RESERVED_DEVICE_NAMES].sort()).toEqual(
      [
        'aux',
        'com1',
        'com2',
        'com3',
        'com4',
        'com5',
        'com6',
        'com7',
        'com8',
        'com9',
        'con',
        'lpt1',
        'lpt2',
        'lpt3',
        'lpt4',
        'lpt5',
        'lpt6',
        'lpt7',
        'lpt8',
        'lpt9',
        'nul',
        'prn',
      ].sort(),
    );
  });
});
