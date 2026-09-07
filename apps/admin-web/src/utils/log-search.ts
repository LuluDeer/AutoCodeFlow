/**
 * UI-05: 日志关键词搜索高亮纯逻辑层。
 *
 * 既有行级高亮（OBS-03）是按整行级别分段的 span 流；关键词高亮需要在其
 * 之上再切分。本模块输出与行级分段同构的二维分段（行 → 文本块），渲染层
 * 将 log-line-* 类施加于行、log-search-hit 类施加于命中文本块。拼接保真
 * 契约与 OBS-03 相同：所有块文本顺序连接 === 原文。
 */

/** 日志搜索命中文本块：hit=true 时渲染为 <mark class="log-search-hit"> */
export interface LogSearchSegment {
  text: string;
  hit: boolean;
}

/** 与页面既有 logSegments 同构：行级分段（级别类可选）之上叠搜索分段 */
export interface LogLineSegments {
  /** OBS-03 行级高亮类（log-line-error / log-line-warn / ''） */
  lineClass: string;
  /** 该行内的搜索分段（无搜索词时恒为单块、hit=false） */
  segments: LogSearchSegment[];
  /** 是否最后一行（渲染层据此决定行间换行符） */
  isLast: boolean;
}

/** 默认防抖毫秒（大日志下逐键重切分代价高，输入停止 300ms 后生效） */
export const LOG_SEARCH_DEBOUNCE_MS = 300;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 单行内的关键词切分：大小写不敏感，重叠命中按最左优先取整词首段。
 * 空关键词返回整行单块（hit=false）。拼接结果 === line（保真契约）。
 */
export function splitLineByKeyword(line: string, keyword: string): LogSearchSegment[] {
  if (!keyword) return [{ text: line, hit: false }];
  const re = new RegExp(escapeRegExp(keyword), 'gi');
  const segments: LogSearchSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    // 零长匹配防御（理论上非空关键词不会出现，防手写异常输入死循环）
    if (m.index === re.lastIndex) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) segments.push({ text: line.slice(last, m.index), hit: false });
    segments.push({ text: line.slice(m.index, m.index + m[0].length), hit: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) segments.push({ text: line.slice(last), hit: false });
  return segments;
}

/**
 * 全量分段：行级高亮（logLineHighlightClass 注入，保持 OBS-03 口径）×
 * 关键词高亮两个正交维度。keyword 为空时每行退化为单块，不额外制造节点。
 */
export function buildLogSearchSegments(
  logs: string,
  keyword: string,
  lineClassOf: (line: string) => string = () => '',
): LogLineSegments[] {
  const lines = logs.split('\n');
  return lines.map((line, i) => ({
    lineClass: lineClassOf(line),
    segments: splitLineByKeyword(line, keyword),
    // 最后一行无尾随换行；其余行由渲染层在行间补 \n
    isLast: i === lines.length - 1,
  }));
}
