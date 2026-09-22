/**
 * P1-11（UX-AUDIT-2026-09-21）：从上传的应用 zip 中读取 `manifest.json`。
 *
 * 背景：git 路径的部署早就解析 manifest.json 并回填 app.manifest / entrypoint /
 * runtime（见 application.service.ts 的 deployFromGit）；但 zip 上传路径此前
 * 完全不解析 manifest——用户把 manifest 打进 zip，控制台却一无所知，entrypoint
 * 只能靠人填，填错就部署失败。
 *
 * 读取策略（对齐 zip-guard.util.ts 的"只读中央目录 + 目标条目"思路）：
 *   1. 从文件尾找 EOCD，拿到中央目录偏移/大小；
 *   2. 只读中央目录区，定位名为 `manifest.json`（或根目录下同名）的条目；
 *   3. 按该条目 local header 找到数据起点，只读它声明的压缩字节，按需 inflate。
 * 全程不把 up-to-200MB 的包读进内存。
 *
 * 容错：找不到条目 / 损坏 / 非法 JSON → 返回 null（调用方只 warn，不阻断上传）。
 */
import * as fs from "fs";
import { inflateRawSync } from "zlib";

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const CD_HEADER_SIZE = 46;
const LOCAL_HEADER_FILENAME_LEN_OFFSET = 26;
/** EOCD 最长可含 64KB 注释；先读尾部 64KB 足够定位。 */
const EOCD_SCAN_TAIL = 64 * 1024;

function u16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

function readRange(filePath: string, start: number, length: number): Buffer {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const n = fs.readSync(fd, buf, filled, length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    return filled === length ? buf : buf.subarray(0, filled);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 读取 zip 中名为 `manifest.json` 的条目文本（优先根目录条目；其次任意子目录同名）。
 * 返回 null 表示没有 manifest 或无法解析——调用方不应把它当错误。
 */
export function readManifestFromZip(zipPath: string): string | null {
  try {
    const stat = fs.statSync(zipPath);
    if (stat.size < 22) return null;

    // 1. 尾部找 EOCD
    const tailStart = Math.max(0, stat.size - EOCD_SCAN_TAIL);
    const tail = readRange(zipPath, tailStart, stat.size - tailStart);
    let eocdRel = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (u32(tail, i) === SIG_EOCD) {
        eocdRel = i;
        break;
      }
    }
    if (eocdRel < 0) return null;
    const cdCount = u16(tail, eocdRel + 10);
    const cdOffset = u32(tail, eocdRel + 16);
    const cdSize = u32(tail, eocdRel + 12);
    if (cdCount === 0 || cdSize === 0) return null;

    // 2. 读中央目录区
    const cd = readRange(zipPath, cdOffset, cdSize);

    let rootMatch: {
      localOffset: number;
      method: number;
      cSize: number;
      uSize: number;
    } | null = null;
    let nestedMatch = rootMatch;
    let off = 0;
    for (let seen = 0; seen < cdCount; seen++) {
      if (off + CD_HEADER_SIZE > cd.length || u32(cd, off) !== SIG_CD)
        return null;
      const method = u16(cd, off + 10);
      const cSize = u32(cd, off + 20);
      const uSize = u32(cd, off + 24);
      const localOffset = u32(cd, off + 42);
      const nameLen = u16(cd, off + 28);
      const extraLen = u16(cd, off + 30);
      const commentLen = u16(cd, off + 32);
      const name = cd.toString(
        "utf8",
        off + CD_HEADER_SIZE,
        off + CD_HEADER_SIZE + nameLen,
      );
      off += CD_HEADER_SIZE + nameLen + extraLen + commentLen;

      const isRoot = name === "manifest.json";
      const isNested = name.endsWith("/manifest.json");
      if (!isRoot && !isNested) continue;
      const entry = { localOffset, method, cSize, uSize };
      if (isRoot) {
        rootMatch = entry;
        break;
      }
      nestedMatch = nestedMatch ?? entry;
    }
    const chosen = rootMatch ?? nestedMatch;
    if (!chosen) return null;

    // 3. 读 local header，定位数据起点
    const localHead = readRange(zipPath, chosen.localOffset, 30);
    if (localHead.length < 30 || u32(localHead, 0) !== SIG_LOCAL) return null;
    const localNameLen = u16(localHead, LOCAL_HEADER_FILENAME_LEN_OFFSET);
    const localExtraLen = u16(localHead, LOCAL_HEADER_FILENAME_LEN_OFFSET + 2);
    const dataStart = chosen.localOffset + 30 + localNameLen + localExtraLen;
    // 防御：声明的压缩大小不能离谱（manifest 文本上限 1MiB）
    if (chosen.cSize <= 0 || chosen.cSize > 1024 * 1024) return null;
    const payload = readRange(zipPath, dataStart, chosen.cSize);
    if (payload.length < chosen.cSize) return null;

    if (chosen.method === 0) return payload.toString("utf8");
    if (chosen.method === 8) {
      try {
        return inflateRawSync(payload, {
          maxOutputLength: Math.max(chosen.uSize, 1024 * 1024),
        }).toString("utf8");
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
