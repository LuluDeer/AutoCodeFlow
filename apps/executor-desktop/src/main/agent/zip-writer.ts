/**
 * P7d 前半（agent-and-deployment）：零依赖 ZIP 写入器（store-only）。
 *
 * ## 为什么不用压缩、不引依赖
 * ① desktop 的 selftest 树是零外部依赖纪律（tsc 直编 node 直跑），引
 * adm-zip/jszip 会破坏它；② 候选应用是小体量源码（上限 10MB），store-only
 * 的体积代价可忽略；③ ZIP 的「本地头 + 中央目录 + EOCD」三段格式手写
 * ~120 行，比一个新依赖的供应链面更小、且完全可自测。
 *
 * ## 正确性锚点
 * · CRC32 对照经典校验向量（'123456789' → 0xCBF43926）；
 * · 自解析回读（中央目录 → 名单/字节/CRC 逐项断言）；
 * · selftest 里若环境有 `unzip`，追加 `unzip -t` 完整性校验（条件执行，
 *   如实跳过——同 browser 真浏览器节的姿态）。
 * 管理端入包闸（PK 魔数 + 后缀白名单 + zip bomb 检查 SEC-05）是第二道
 * 独立验证——本模块的输出必须能过它。
 */

/** 单文件上限（与 workspace 写入上限 1MB 对齐）。 */
export const ZIP_MEMBER_MAX = 1024 * 1024;
/** 整包上限（候选应用源码包的合理上界）。 */
export const ZIP_TOTAL_MAX = 10 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32（IEEE 802.3，ZIP 规范算法）。 */
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** 归档内路径（正斜杠；不含前导 ./ 或 ../——写入前逐条校验）。 */
  name: string;
  data: Buffer;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

function assertSafeName(name: string): void {
  if (!name || name.length > 255) throw new Error(`zip member name 非法: ${JSON.stringify(name.slice(0, 64))}`);
  if (name.includes('\\') || name.startsWith('/')) throw new Error(`zip member name 含路径分隔符/绝对路径: ${name.slice(0, 64)}`);
  if (name.startsWith('../') || name.includes('/../') || name === '..') throw new Error(`zip member name 含穿越: ${name.slice(0, 64)}`);
}

/**
 * 构建一个 store-only（不压缩）ZIP 归档。
 * @throws 名单为空 / 名字非法 / 单文件或整包超限——调用方（打包器）负责
 * 先做业务侧过滤，这里只做格式侧防线。
 */
export function buildZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  if (entries.length === 0) throw new Error('zip 至少需要一个成员');
  if (entries.length > 500) throw new Error(`zip 成员数 ${entries.length} 超上限 500`);
  const { time, date } = dosDateTime(now);

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  let total = 0;

  for (const e of entries) {
    assertSafeName(e.name);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    if (e.data.length > ZIP_MEMBER_MAX) {
      throw new Error(`zip 成员 ${e.name.slice(0, 64)} 超过单文件上限 ${ZIP_MEMBER_MAX}`);
    }
    total += e.data.length;
    if (total > ZIP_TOTAL_MAX) throw new Error(`zip 总量超过 ${ZIP_TOTAL_MAX} 上限`);

    // Local file header（PK\x03\x04；method 0 = stored；bit 11 = UTF-8 名）
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18); // csize
    local.writeUInt32LE(e.data.length, 22); // usize
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localParts.push(local, nameBuf, e.data);

    // Central directory header（PK\x01\x02）
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + e.data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // cd offset（= local 部分总长）
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/** 自解析回读（selftest 用）：从中央目录提取 {name, data}，逐项校验 CRC。 */
export function parseZip(buf: Buffer): Array<{ name: string; data: Buffer }> {
  // EOCD 固定 22 字节（无注释），从尾部定位
  const eocdSig = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdSig < 0) throw new Error('EOCD not found');
  const count = buf.readUInt16LE(eocdSig + 10);
  const cdOffset = buf.readUInt32LE(eocdSig + 16);
  const out: Array<{ name: string; data: Buffer }> = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (method !== 0) throw new Error(`member ${name}: non-stored method ${method}`);
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const data = buf.slice(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`member ${name}: CRC mismatch`);
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}
