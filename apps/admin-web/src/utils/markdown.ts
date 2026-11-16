/**
 * 轻量安全 Markdown 解析（受限子集）。
 *
 * 背景：任务详情 Runbook 此前以 `whiteSpace: pre-wrap` 纯文本直出，`## 标题`、
 * 有序/无序列表、代码围栏全部裸露成等宽长文（P2-06）。本模块只把 Markdown
 * 解析成**结构化 AST**，由 `components/MarkdownView` 渲染成 React 元素——
 * 全程不使用 `dangerouslySetInnerHTML`，原始 HTML 串交给 React 默认转义，
 * 从构造上避免脚本注入；不引入 marked/dompurify 直连依赖（二者当前仅为
 * monaco-editor 传递依赖，不能在业务代码里直接 import）。
 *
 * 支持子集（排障手册足够，超出子集原样保留为段落文本，不丢内容）：
 *  - 围栏代码块 ```lang ... ```
 *  - 标题 # / ## / ### / ####
 *  - 无序列表 `- ` / `* `；有序列表 `1. ` / `1) `
 *  - 行内：`行内代码`、**加粗**、*斜体*
 *  - 其余按段落合并换行
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] };

export type MarkdownBlock =
  | { type: 'code'; lang: string; text: string }
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'ul'; items: InlineNode[][] }
  | { type: 'ol'; items: InlineNode[][] }
  | { type: 'para'; children: InlineNode[] };

const INLINE_TOKEN_RE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;

/** 行内解析：按代码/加粗/斜体标记切分，未命中的片段作为纯文本（React 转义）。 */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push({ type: 'text', text: text.slice(last, idx) });
    const token = m[0];
    if (token.startsWith('`')) {
      nodes.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      nodes.push({ type: 'bold', children: parseInline(token.slice(2, -2)) });
    } else {
      nodes.push({ type: 'italic', children: parseInline(token.slice(1, -1)) });
    }
    last = idx + token.length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}

const FENCE_RE = /^\s*```/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const UL_RE = /^\s*[-*]\s+/;
const OL_RE = /^\s*\d+[.)]\s+/;

/** 块级解析：围栏代码块 / 标题 / 列表 / 段落，按空行与标记切分。 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    if (FENCE_RE.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾围栏（缺失也不回退死循环）
      blocks.push({ type: 'code', lang, text: buf.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2].trim()) });
      i++;
      continue;
    }

    if (UL_RE.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && UL_RE.test(lines[i])) {
        items.push(parseInline(lines[i].replace(UL_RE, '').trim()));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (OL_RE.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && OL_RE.test(lines[i])) {
        items.push(parseInline(lines[i].replace(OL_RE, '').trim()));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // 段落：聚合到空行 / 标题 / 列表 / 围栏为止
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !UL_RE.test(lines[i]) &&
      !OL_RE.test(lines[i]) &&
      !FENCE_RE.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'para', children: parseInline(para.join(' ')) });
  }

  return blocks;
}
