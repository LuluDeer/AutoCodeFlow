/**
 * WS5（python_task_upload_and_multiversion）—— zip 整包安全解压。
 *
 * 与 `zip-guard.ts` 的分工（CONTRACT.md §3.3）：
 *   - `zip-guard.ts`（**不得修改**，`/api/deploy` 依赖其既有导出语义）回答
 *     "这个压缩包是不是炸弹"——按**中央目录声明的尺寸**在解压前拒绝
 *     ratio/条数/单文件/总量/嵌套超限。
 *   - 本模块回答"解压到哪里"——逐条目做路径逃逸（zip-slip）与符号链接拒绝，
 *     并在解压过程中按同一套上限做**实际字节**的二次校验。
 *
 * 两者是独立的两道闸门，都要过（`safeExtractZip` 内部会先跑 `assertZipFileSafe`）。
 * 中央目录是**攻击者可控的元数据**：它可以声明 1KB 而实际解出 10GB（声明与实际
 * 不符本身也是"不可 vet 即拒绝"的失败模式）。因此本模块的解压循环用
 * `maxOutputLength` 把实际输出钉在声明尺寸上——声明与实际不符时 zlib 直接抛错，
 * 而不是让我们把磁盘写满。
 *
 * 为什么不直接 `Expand-Archive` / `unzip`（deploy.ts 的做法）：那两个工具把
 * "条目名 → 落盘路径"的决策权交给了它们自己的实现，我们无法逐条目断言
 * "解析后的目标仍在 destDir 之内"。整包上传的 zip 来自用户，正是最需要这道
 * 断言的场景。代价是我们要自己解压——只支持 stored/deflate 两种方法，
 * 其余方法**fail closed**（与 zip-guard 的立场一致）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { logger } from './logger';
import {
  type ZipGuardLimits,
  type ZipGuardViolation,
  ZipGuardError,
  assertZipFileSafe,
  getZipGuardLimitsFromEnv,
} from './zip-guard';

/**
 * 违规分类。
 *
 * 前半段是 `zip-guard.ts` 的既有分类——`safeExtractZip` 会先跑一遍炸弹审查，
 * 因此这些 violation **会原样透传**到本模块的调用方（例如声明单文件超限时
 * 先命中 guard 的 `single_file_too_large`）。把它们纳入联合类型是诚实做法：
 * 调用方按 violation 分类时不会遇到类型里没写的值。
 *
 * 后半段是本模块新增的**路径**类违规（guard 不负责这些）。
 */
export type ZipSafetyViolation =
  | ZipGuardViolation
  | 'zip_slip'
  | 'absolute_path'
  | 'drive_letter_path'
  | 'symlink_entry'
  | 'entry_too_large'
  | 'total_too_large'
  | 'ratio_too_high'
  | 'bad_archive'
  | 'unsupported_method';

export class ZipSafetyError extends Error {
  constructor(
    public readonly violation: ZipSafetyViolation,
    message: string,
  ) {
    super(message);
    this.name = 'ZipSafetyError';
  }
}

const U16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const U32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_FIXED_SIZE = 22;
const CD_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;

/** Unix `S_IFLNK`：中央目录 external attributes 高 16 位里的文件类型。 */
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000;

export interface SafeExtractOptions {
  /** 上限；默认取 `getZipGuardLimitsFromEnv()`（与 deploy 路径同源）。 */
  limits?: ZipGuardLimits;
  /** 解压完成后删除 zip 文件（默认 false，调用方决定）。 */
  removeArchive?: boolean;
}

interface ParsedEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  isSymlink: boolean;
  isDirectory: boolean;
}

/**
 * 定位 EOCD。与 zip-guard 的同名逻辑等价，但这里**不导出、不复用**：
 * zip-guard 的 `locateEocd` 抛的是 `ZipGuardError`，而本模块的失败语义必须是
 * `ZipSafetyError`（调用方按 violation 分类）。复用会把两套错误类型搅在一起。
 */
function findEocd(buf: Buffer): number {
  const minStart = buf.length - EOCD_FIXED_SIZE;
  if (minStart < 0) {
    throw new ZipSafetyError('bad_archive', 'file smaller than an EOCD record');
  }
  const scanStart = Math.max(0, buf.length - (65_536 + EOCD_FIXED_SIZE));
  for (let off = minStart; off >= scanStart; off--) {
    if (U32(buf, off) === SIG_EOCD) return off;
  }
  throw new ZipSafetyError('bad_archive', 'EOCD signature not found');
}

/** 解析中央目录，逐条目取出解压所需字段。 */
function parseEntries(buf: Buffer): ParsedEntry[] {
  const eocdOff = findEocd(buf);
  const cdEntries = U16(buf, eocdOff + 10);
  const cdSize = U32(buf, eocdOff + 12);
  const cdOffset = U32(buf, eocdOff + 16);

  if (cdOffset === 0xffffffff || cdEntries === 0xffff || cdSize === 0xffffffff) {
    throw new ZipSafetyError('bad_archive', 'zip64 archives are not supported');
  }

  const entries: ParsedEntry[] = [];
  let off = cdOffset;
  for (let seen = 0; seen < cdEntries; seen++) {
    if (off + CD_HEADER_SIZE > buf.length || U32(buf, off) !== SIG_CD) {
      throw new ZipSafetyError(
        'bad_archive',
        `central directory record ${seen} is missing or corrupt`,
      );
    }
    const method = U16(buf, off + 10);
    const compressedSize = U32(buf, off + 20);
    const uncompressedSize = U32(buf, off + 24);
    const nameLen = U16(buf, off + 28);
    const extraLen = U16(buf, off + 30);
    const commentLen = U16(buf, off + 32);
    const externalAttrs = U32(buf, off + 38);
    const localOffset = U32(buf, off + 42);
    const nameStart = off + CD_HEADER_SIZE;
    if (nameStart + nameLen > buf.length) {
      throw new ZipSafetyError('bad_archive', 'central directory name overruns buffer');
    }
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      isSymlink: (unixMode & S_IFMT) === S_IFLNK,
      isDirectory: name.endsWith('/') || name.endsWith('\\'),
    });
    off = nameStart + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 条目名 → 安全的相对落盘路径；任何逃逸形态直接抛 `ZipSafetyError`。
 *
 * 逐条拒绝（CONTRACT.md §3.2 `safe_extract` 必须项）：
 *   - 绝对路径（`/etc/passwd`、`\\server\share`）；
 *   - 盘符路径（`C:\Windows\...`）——POSIX 上 `path.isAbsolute('C:\\x')` 是
 *     false，只靠 isAbsolute 会漏，必须显式匹配盘符；
 *   - `..` 片段（zip-slip）；
 *   - 解析后不在 destDir 之内（最后一道兜底，覆盖上面没枚举到的形态）。
 *
 * 注意 `entry.startsWith('/')` 这类判断**先于**任何 path.join：一旦让
 * `path.join(dest, '/etc/passwd')` 参与运算，就等于把决策权交给了平台语义。
 */
function resolveEntryTarget(destDir: string, entryName: string): string {
  if (!entryName) {
    throw new ZipSafetyError('bad_archive', 'zip contains an entry with an empty name');
  }
  if (entryName.includes('\0')) {
    // NUL 截断：`safe.txt\0../../evil` 在不同 API 下可能被截成不同名字。
    throw new ZipSafetyError('bad_archive', `zip entry name contains a NUL byte: ${entryName}`);
  }
  if (entryName.startsWith('/') || entryName.startsWith('\\')) {
    throw new ZipSafetyError('absolute_path', `zip entry uses an absolute path: ${entryName}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(entryName)) {
    throw new ZipSafetyError('drive_letter_path', `zip entry uses a drive-letter path: ${entryName}`);
  }

  // 统一按 `/` 与 `\` 双分隔符切分：zip 规范要求 `/`，但 Windows 产出的包
  // 常混用 `\`，只按 `/` 切会让 `..\..\evil` 整个变成一个无害的"文件名"。
  const segments = entryName.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new ZipSafetyError('zip_slip', `zip entry escapes the destination via "..": ${entryName}`);
  }

  const target = path.resolve(destDir, ...segments.filter((s) => s !== '' && s !== '.'));
  const rel = path.relative(path.resolve(destDir), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ZipSafetyError(
      'zip_slip',
      `zip entry resolves outside the destination directory: ${entryName}`,
    );
  }
  return target;
}

/** 取出某条目的原始（仍压缩的）字节。 */
function entryPayload(buf: Buffer, entry: ParsedEntry): Buffer {
  const lo = entry.localOffset;
  if (lo + LOCAL_HEADER_SIZE > buf.length || U32(buf, lo) !== SIG_LOCAL) {
    throw new ZipSafetyError('bad_archive', `local header missing for entry ${entry.name}`);
  }
  // 本地头里的 name/extra 长度可能与中央目录不同（zip 允许），必须读本地头。
  const nameLen = U16(buf, lo + 26);
  const extraLen = U16(buf, lo + 28);
  const dataStart = lo + LOCAL_HEADER_SIZE + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new ZipSafetyError('bad_archive', `entry data overruns the archive: ${entry.name}`);
  }
  return buf.subarray(dataStart, dataEnd);
}

/**
 * 解出条目的内容。
 *
 * `maxOutputLength` 钉在**声明**的未压缩尺寸上：一个声明 1KB 实际 10GB 的
 * 条目会让 zlib 抛错而不是把磁盘写满。这是"中央目录是攻击者可控元数据"这一
 * 事实的直接对策。
 */
function inflateEntry(payload: Buffer, entry: ParsedEntry): Buffer {
  if (entry.method === 0) {
    if (payload.length !== entry.uncompressedSize) {
      throw new ZipSafetyError(
        'bad_archive',
        `stored entry size mismatch for ${entry.name} (declared ${entry.uncompressedSize}, actual ${payload.length})`,
      );
    }
    return Buffer.from(payload);
  }
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(payload, {
        maxOutputLength: Math.max(entry.uncompressedSize, 1),
      });
    } catch (err) {
      // 声明与实际不符 / 数据损坏 —— 都归为不可信归档，fail closed。
      throw new ZipSafetyError(
        'bad_archive',
        `entry ${entry.name} does not match its declared size or is corrupt: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // bzip2(12)/lzma(14)/deflate64(9)/加密等：本模块的解压只用 zlib，**没有**
  // 能解开它们的解码器，因此无法在解压时校验声明尺寸（zip-guard 的
  // `extractNestedZipBytes` 同样只认 0/8）——拒绝而不是盲解。
  //
  // 为什么不改成"接受"：node 标准库只有 zlib（raw deflate），没有 bzip2/lzma
  // 解码器；接受就等于要么把未校验的字节落盘，要么落一个空的/损坏的文件——
  // 前者破坏"声明与实际必须一致"的整条防线，后者让任务在解释器里以另一种
  // 面目失败。python 侧 `zipfile` 原生支持 12/14，所以它接受；两侧的**强度**
  // 差异（谁能解压）无法用"改 node 代码"消除，只能靠 python 侧同样拒绝来对齐
  // ——见 zip_safety.py `_reject_unsupported_method`（两侧现均为 fail-closed）。
  //
  // 错误信息必须点名方法与"不支持"这一事实：调用方（execute.ts）会把它拼进
  // "Unsafe or invalid package archive: ..." 回给用户，只说 "bad_archive" 会让
  // 上传者无从知道该把包改成 deflate/stored 重传。
  throw new ZipSafetyError(
    'unsupported_method',
    `entry ${entry.name} uses compression method ${entry.method}, which this executor cannot ` +
      'decompress (only stored(0) and deflate(8) are supported; re-pack the archive with deflate)',
  );
}

/**
 * 安全解压 `zipPath` 到 `destDir`。
 *
 * 流程：zip-guard 炸弹审查 → 逐条目路径断言 → 逐条目落盘（过程中累计实际
 * 字节并对照上限）→ 任何违规即清理**本次已写出的**内容再抛出。
 *
 * 失败清理只删本次解压产生的文件，不做整目录递归删除：`destDir` 可能已经
 * 含有前序阶段（git clone 等）的产物，一次失败的 zip 解压不该把它们一起抹掉。
 */
export function safeExtractZip(
  zipPath: string,
  destDir: string,
  opts: SafeExtractOptions = {},
): { entries: number; bytes: number } {
  const limits = opts.limits ?? getZipGuardLimitsFromEnv();

  // 第一道闸门：炸弹审查。ZipGuardError 转成我们的错误类型，让调用方只需
  // 处理一种错误形态（violation 原样透传，保持可分类）。
  try {
    assertZipFileSafe(zipPath, limits);
  } catch (err) {
    if (err instanceof ZipGuardError) {
      throw new ZipSafetyError(err.violation, err.message);
    }
    // 归档不可读（不存在/权限/IO）也必须是 ZipSafetyError：调用方按一种错误
    // 类型分类，不该在这里漏出一个裸 Error（例如 ENOENT）。
    throw new ZipSafetyError(
      'bad_archive',
      `cannot read archive ${zipPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let buf: Buffer;
  try {
    buf = fs.readFileSync(zipPath);
  } catch (err) {
    throw new ZipSafetyError(
      'bad_archive',
      `cannot read archive ${zipPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const entries = parseEntries(buf);
  if (entries.length > limits.maxEntries) {
    throw new ZipSafetyError(
      'too_many_entries',
      `zip declares ${entries.length} entries (limit ${limits.maxEntries})`,
    );
  }

  const destRoot = path.resolve(destDir);
  fs.mkdirSync(destRoot, { recursive: true });

  // 总量与压缩比按**整包**汇总，且在写出任何字节之前判定——与 python
  // `_vet_open_archive` 的 `total_uncompressed` / `total_compressed` 同语义。
  //
  // 失败模式（改动前）：这两个量是在下面的写入循环里逐条目累加并**即时**比较的，
  // 于是压缩比实际算的是"已遍历前缀"的比值而不是整包的比值。一个高压缩比的小
  // 条目排在前面就会单独把前缀比值顶过红线而被判成炸弹，哪怕后面跟着一个几乎
  // 不可压缩的大文件、整包比值其实完全正常；同一批条目换个顺序又能通过。
  // 这既误杀正常包，又让判定可被条目顺序操纵（把高压缩比条目排到后面即可绕过
  // 前缀判定），而 zip-guard 的 `checkSummaryAgainstLimits` 用的是整包总量——
  // 两者对同一个包给出相反结论，正是"两侧全对等"要求下必须消除的分歧。
  let declaredUncompressed = 0;
  let declaredCompressed = 0;
  for (const entry of entries) {
    declaredUncompressed += entry.uncompressedSize;
    declaredCompressed += entry.compressedSize;
  }
  if (declaredUncompressed > limits.maxTotalUncompressedBytes) {
    throw new ZipSafetyError(
      'total_too_large',
      `archive declares ${declaredUncompressed} uncompressed bytes (limit ${limits.maxTotalUncompressedBytes})`,
    );
  }
  if (
    declaredCompressed > 0 &&
    declaredUncompressed / declaredCompressed > limits.maxRatio
  ) {
    throw new ZipSafetyError(
      'ratio_too_high',
      `compression ratio ${(declaredUncompressed / declaredCompressed).toFixed(1)} exceeds limit ${limits.maxRatio}`,
    );
  }

  const written: string[] = [];
  let totalBytes = 0;

  const cleanup = () => {
    for (const file of written.reverse()) {
      try {
        fs.rmSync(file, { force: true, recursive: true });
      } catch {
        /* best effort — 清理失败不应掩盖原始违规 */
      }
    }
  };

  try {
    for (const entry of entries) {
      if (entry.isSymlink) {
        // 符号链接条目：即便目标看似在目录内，落盘后也会成为一条"指向任意
        // 路径"的通道（后续读写跟随链接即逃逸）。直接拒绝。
        throw new ZipSafetyError(
          'symlink_entry',
          `zip contains a symbolic-link entry: ${entry.name}`,
        );
      }

      const target = resolveEntryTarget(destRoot, entry.name);
      if (entry.isDirectory) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }

      if (entry.uncompressedSize > limits.maxFileBytes) {
        throw new ZipSafetyError(
          'entry_too_large',
          `entry ${entry.name} declares ${entry.uncompressedSize} bytes (limit ${limits.maxFileBytes})`,
        );
      }
      // 总量/压缩比已在循环前按**声明值**整包判定（见上，与 zip-guard 的
      // checkSummaryAgainstLimits 同源）；单文件的**实际**解压字节在 inflate
      // 之后立即按 maxFileBytes 再卡一次（声明可以撒谎）。这里累计声明字节数
      // 仅供返回值与日志使用，不承担闸门职责。
      totalBytes += entry.uncompressedSize;

      const content = inflateEntry(entryPayload(buf, entry), entry);
      if (content.length > limits.maxFileBytes) {
        // 实际解出的字节再查一次：声明可以撒谎，实际写入的字节不会。
        throw new ZipSafetyError(
          'entry_too_large',
          `entry ${entry.name} inflated to ${content.length} bytes (limit ${limits.maxFileBytes})`,
        );
      }

      // 父目录可能是符号链接（TOCTOU：断言通过后被替换）。落盘前复查一次
      // 目标仍解析在 destRoot 之内。用 realpathSync 解析符号链接（path.resolve
      // 是纯字符串操作，不接触文件系统，对符号链接替换零防护）。
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let resolvedDir: string;
      try {
        resolvedDir = fs.realpathSync(path.dirname(target));
      } catch (err) {
        throw new ZipSafetyError(
          'zip_slip',
          `entry ${entry.name}: cannot resolve parent directory ${path.dirname(target)}: ${err}`,
        );
      }
      const rel = path.relative(
        fs.realpathSync(destRoot),
        resolvedDir,
      );
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new ZipSafetyError(
          'zip_slip',
          `entry ${entry.name} would be written outside the destination`,
        );
      }

      fs.writeFileSync(target, content);
      written.push(target);
    }
  } catch (err) {
    cleanup();
    throw err;
  }

  if (opts.removeArchive) {
    try {
      fs.rmSync(zipPath, { force: true });
    } catch {
      /* best effort */
    }
  }

  logger.debug(
    `safeExtractZip: extracted ${written.length} file(s), ${totalBytes} bytes into ${destRoot}`,
  );
  return { entries: written.length, bytes: totalBytes };
}

/**
 * 只做审查、不解压（供需要在解压前单独把关的调用方使用）。
 * 复用 zip-guard 的 `assertZipFileSafe`，仅把错误类型归一。
 */
export function vetZip(zipPath: string, limits?: ZipGuardLimits): void {
  try {
    assertZipFileSafe(zipPath, limits ?? getZipGuardLimitsFromEnv());
  } catch (err) {
    if (err instanceof ZipGuardError) {
      throw new ZipSafetyError(err.violation, err.message);
    }
    throw new ZipSafetyError(
      'bad_archive',
      `cannot read archive ${zipPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
