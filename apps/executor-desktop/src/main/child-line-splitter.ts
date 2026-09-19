/**
 * NETOPT-2⑦：子进程输出的按行缓冲拆分器。
 *
 * 背景：executor-process.ts 此前把 stdout/stderr 的每个 data chunk 当作一行
 * 直接送进 handleChildOutput——一个 chunk ≠ 一行。executor-node 在
 * LOG_FORMAT=json 高频输出下，多行 chunk（合法 JSON 行挤在同一块）与跨块
 * 半行（JSON 行被 TCP/pipe 边界截断）都会让 JSON.parse 失败，合法日志行整体
 * 进不了结构化通道（executor:log-structured），渲染层静默退化成纯文本渲染。
 *
 * feed() 按 \n 拆分并保留尾部半行缓冲（同 packages/acf-cli createSseParser
 * 思路）；flush() 在进程退出时冲洗残留半行（未以换行结束的最后一行也算一行）。
 * \r\n 行尾统一剥离，与 Windows 子进程输出兼容。
 *
 * 防失控：无换行的超长输出（异常刷屏/二进制误入 stdout）会让半行缓冲无限
 * 增长——超过 MAX_PENDING_LINE_BYTES 时把缓冲整体当作一行发出（语义对齐旧
 * 实现「整块直送」，只是有上限）。
 *
 * 纯 Node 模块、无 electron 依赖：自检（child-line-splitter.selftest.ts）
 * 可直接 import 验证行为，无需 SYNC 副本。
 */

/** 半行缓冲上限（字节）。超出即整体冲出为一行。 */
export const MAX_PENDING_LINE_BYTES = 1_000_000;

export class LineSplitter {
  private buffer = '';

  constructor(private readonly onLine: (line: string) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.onLine(line);
    }
    // 防失控：无换行的超长输出不让缓冲无限增长。
    if (this.buffer.length > MAX_PENDING_LINE_BYTES) {
      const rest = this.buffer;
      this.buffer = '';
      this.onLine(rest);
    }
  }

  /** 进程退出/流结束时调用：冲洗残留半行（纯空白不产出）。 */
  flush(): void {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim()) {
      this.onLine(rest);
    }
  }
}
