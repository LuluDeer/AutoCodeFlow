/**
 * OBS-03: 执行日志行级别推断（前端侧）——与 admin-api
 * apps/admin-api/src/modules/task/log-level.util.ts 保持同一推断口径，
 * 用于日志详情页的行级高亮（.log-line-error / .log-line-warn）。
 *
 * 识别形态（大小写不敏感，与后端逐条对齐）：
 * - 行首直接标注：[ERROR] msg / ERROR: msg / INFO msg 等（括号可选）；
 * - 时间戳前缀后标注：2026-09-06 12:00:00 [WARN] ...、
 *   2026-09-06T12:00:00.123Z error ...、[2026/09/06 12:00:00] [INFO] ...、
 *   12:00:00,123 debug ...；
 * - WARNING 归一化为 WARN（值域四值：ERROR/WARN/INFO/DEBUG）；
 * - 只认"级别词 + 完整边界"——ERRORS、information、debugger 等非级别词
 *   一律推断不到；行中间的级别词 / 空行 / 只有时间戳的行 → null。
 */

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

/** 级别过滤下拉值域（与后端 log-level.util.ts LOG_LEVEL_VALUES 对齐） */
export const LOG_LEVEL_VALUES: readonly LogLevel[] = [
  'ERROR',
  'WARN',
  'INFO',
  'DEBUG',
];

/** 级别词 → 归一化级别；WARNING 折叠进 WARN */
const LEVEL_WORDS: Readonly<Record<string, LogLevel>> = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  WARNING: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
};

/**
 * 行首可剥离的时间戳前缀（剥离后剩余文本再做级别匹配）：
 * - `2026-09-06 12:00:00` / `2026-09-06T12:00:00.123Z` / `2026/09/06 12:00:00+08:00`；
 * - 方括号形式 `[2026-09-06 12:00:00]`；
 * - 纯时间 `12:00:00` / `12:00:00,123`。
 * 与后端 TIMESTAMP_PREFIX_RE 逐字符一致。
 */
const TIMESTAMP_PREFIX_RE =
  /^\s*(?:\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\[\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}:\d{2}\]|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s*/;

/**
 * 级别标记：[ERROR] / ERROR: / warn 等（括号可选，冒号或空白收尾）。
 * 大小写不敏感；要求级别词后有边界（冒号/空白）。
 * 与后端 LEVEL_MARKER_RE 逐字符一致。
 */
const LEVEL_MARKER_RE = /^\s*\[?(ERROR|WARN|WARNING|INFO|DEBUG)\]?[:\s]/i;

/**
 * 从一行日志文本推断级别；推断不到返回 null（= 未知级别，不做高亮、
 * 服务端 level 过滤时也不会命中——后端 level 列为 NULL 的行被排除）。
 */
export function levelOfLine(line: string | null | undefined): LogLevel | null {
  if (typeof line !== 'string' || line.length === 0) return null;
  const withoutTimestamp = line.replace(TIMESTAMP_PREFIX_RE, '');
  const m = LEVEL_MARKER_RE.exec(withoutTimestamp);
  if (!m) return null;
  return LEVEL_WORDS[m[1].toUpperCase()] ?? null;
}

/**
 * OBS-03: 行级高亮类名——ERROR 红 / WARN 黄，其余（INFO/DEBUG/未知）返回
 * 空串（渲染为纯文本节点，不为万行日志制造海量 React 元素）。
 */
export function logLineHighlightClass(line: string): string {
  const level = levelOfLine(line);
  if (level === 'ERROR') return 'log-line-error';
  if (level === 'WARN') return 'log-line-warn';
  return '';
}

// ── LOG-JSON-01：日志行内 JSON 载荷的识别 / 美化 / 着色 ─────────────────────
//
// ## 为什么是「单行着色」而不是「多行缩进」（窗口化安全，关键取舍）
//
// 日志查看器有**两条**渲染路径（见 ExecutionLogSection）：
//   ① ≤500 行：`<pre>` 折行形态；
//   ② >500 行：`LogWindow` 窗口化（固定行高 LOG_ROW_HEIGHT = 20px）。
// ② 的正确性完全建立在「一个逻辑行 === 一个固定高 DOM 行」之上：撑高层高度
// 恒为 `lines.length × LOG_ROW_HEIGHT`，可视窗口由 `scrollTop / LOG_ROW_HEIGHT`
// 直接换算成行号。把 JSON 展开成多行会**同时**破坏三件事：
//   · 撑高层高度与实际内容不符 → 滚动条长度错、末段滚不到；
//   · `scrollTop → 起始行号` 的整除换算失效 → 滚到任意位置都会错行/白屏；
//   · 行高不再常量 → 必须改成「实测行高 + 偏移量前缀和」，等于重写这个零依赖
//     虚拟滚动器。
//
// 因此这里采用**方案 (b)**：载荷在行内单行呈现（原始字节，不压缩），用「键 /
// 字符串 / 数字 / 字面量 / 标点」五档着色把结构显性化。完整缩进形态经
// `prettyJsonForLine` 提供给**浮层**（Popover）消费——浮层不参与滚动容器布局，
// 因此对窗口化零风险，同时保留了方案 (a)「展开看美化」的价值。
//
// 保真与降级：着色 token 的文本顺序拼接 === 该行原文（超长截断时除外）。
// 非法 JSON / 超长载荷 / 序列化异常（含循环引用）一律返回 null → 调用方回落
// 原始纯文本，**任何输入都不会抛错**。

/** 单行内允许尝试解析的载荷长度上限（超过直接放弃，按原始文本渲染） */
export const JSON_PAYLOAD_MAX_CHARS = 4096;
/** 行内着色形态的最大字符数（超出按压缩形态截断并加省略号） */
export const JSON_INLINE_MAX_CHARS = 2048;
/** 浮层美化形态的最大字符数（缩进会放大约 2-3 倍） */
export const JSON_PRETTY_MAX_CHARS = 6000;
/** 单行着色 token 数上限（防极端嵌套把一行炸成上万个 DOM 节点） */
export const JSON_TOKEN_MAX = 512;

/** 着色档位：渲染层按档位取色（键/字符串/数字/字面量/标点/普通文本） */
export type JsonTokenKind = 'plain' | 'key' | 'string' | 'number' | 'literal' | 'punct';

/**
 * 着色档位 → antd 语义色 token 名（LOG-JSON-01 渲染层消费）。
 *
 * 放在纯逻辑模块而不是组件文件里，有两个理由：
 *  ① 它是一张**语义映射表**（"键用信息色、字符串用成功色"），属可测的纯数据；
 *  ② 组件文件导出非组件常量会触发 react-refresh/only-export-components
 *     （本仓 lint 的既有告警类型，新增一条就是往噪音里加噪音）。
 *
 * 为什么用 `color*Text` 而不是 `color*`：前者是按「在容器底色上做前景文字」
 * 调校的档位（例如 colorSuccess 在亮面是 #52c41a，白底仅 2.6:1；
 * colorSuccessText 是 #389e0d，达到 4.5:1）。暗色主题下 antd 同步翻转这两组
 * 令牌，因此**不需要**像 index.css 的 `.log-line-*` 那样手写
 * `html[data-theme='dark']` 覆盖。
 *
 * `punct`（标点/空白）刻意退到 colorTextTertiary：括号逗号退进背景，
 * 键与值的结构反而更清楚。
 */
export const JSON_KIND_TOKEN: Readonly<Record<JsonTokenKind, string>> = {
  plain: 'colorText',
  key: 'colorInfoText',
  string: 'colorSuccessText',
  number: 'colorWarningText',
  literal: 'colorErrorText',
  punct: 'colorTextTertiary',
};

/** 行内片段：text 顺序拼接即该行原文（截断情形除外） */
export interface JsonToken {
  text: string;
  kind: JsonTokenKind;
}

/** 行内 JSON 载荷在原文中的位置（start 含、end 不含） */
export interface JsonPayloadSlice {
  start: number;
  end: number;
  /** JSON.parse 的结果（对象/数组） */
  value: unknown;
}

/** 单行 JSON 载荷的两种呈现形态 */
export interface FormattedJsonPayload {
  /** 压缩单行形态（窗口化行内着色用；超过 inlineMax 截断） */
  inline: string;
  /** 缩进美化形态（浮层用；超过 prettyMax 截断） */
  pretty: string;
  /** 是否发生截断（任一形态超限） */
  truncated: boolean;
}

/**
 * 在 `start` 处扫描一个 JSON 值的**结束括号下标**（含）。
 * 只做括号配平，感知字符串与反斜杠转义；不校验内容合法性（交给 JSON.parse）。
 * 找不到配平返回 -1。
 */
function scanJsonValueEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 定位一行日志里的第一个**合法** JSON 载荷（对象/数组）。
 *
 * 覆盖真实日志形态：`[INFO] {"a":1}`、`12:00:00,123 INFO {"a":1}`、
 * `... result={"a":1} done`（前缀/后缀任意文本）。行首/行尾的时间戳与级别标注
 * 天然被当作前后缀保留，因此**不需要**再走 TIMESTAMP_PREFIX_RE。
 *
 * 非法/超长/无载荷 → null。**不抛错**（JSON.parse 已 try 包裹）。
 */
export function findJsonPayload(line: string | null | undefined): JsonPayloadSlice | null {
  if (typeof line !== 'string' || line.length === 0) return null;
  if (line.length > JSON_PAYLOAD_MAX_CHARS) return null;
  // 最多尝试 8 个起点：形如 `a={b} {"real":1}` 时第一个 `{` 可能不是载荷。
  let from = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const rel = line.slice(from).search(/[[{]/);
    if (rel === -1) return null;
    const abs = from + rel;
    const endBracket = scanJsonValueEnd(line, abs);
    if (endBracket !== -1) {
      try {
        const value: unknown = JSON.parse(line.slice(abs, endBracket + 1));
        if (value !== null && typeof value === 'object') {
          return { start: abs, end: endBracket + 1, value };
        }
      } catch {
        /* 该起点不是合法载荷，继续找下一个 */
      }
    }
    from = abs + 1;
    if (from >= line.length) return null;
  }
  return null;
}

/**
 * 安全序列化：循环引用替换为 `"[Circular]"`，任何异常（BigInt / getter 抛错 /
 * 深度超限）返回 null。`indent` 缺省 = 压缩形态。
 *
 * 注意：本函数的入参来自 `JSON.parse`，天然无环；WeakSet 守卫是为**直接传入
 * 构造对象**的调用方（测试/未来的 SSE 结构化载荷）兜底——需求明确要求
 * 「循环结构 → 回落原始文本，绝不抛错」。
 */
function safeStringify(value: unknown, indent?: number): string | null {
  const seen = new WeakSet<object>();
  try {
    const out = JSON.stringify(
      value,
      function replacer(this: unknown, _key: string, val: unknown) {
        if (val !== null && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      },
      indent,
    );
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * 把任意值格式化为「压缩单行 + 缩进美化」两形态；任一形态超限即截断并置
 * `truncated`。序列化失败（循环引用以外的异常）返回 null。
 */
export function formatJsonValue(
  value: unknown,
  options: { inlineMax?: number; prettyMax?: number } = {},
): FormattedJsonPayload | null {
  const inlineMax = options.inlineMax ?? JSON_INLINE_MAX_CHARS;
  const prettyMax = options.prettyMax ?? JSON_PRETTY_MAX_CHARS;
  const compact = safeStringify(value);
  if (compact === null) return null;
  const pretty = safeStringify(value, 2);
  if (pretty === null) return null;
  return {
    inline: compact.length > inlineMax ? `${compact.slice(0, inlineMax)}…` : compact,
    pretty: pretty.length > prettyMax ? `${pretty.slice(0, prettyMax)}\n…` : pretty,
    truncated: compact.length > inlineMax || pretty.length > prettyMax,
  };
}

/**
 * 把一段（可能是截断的）JSON 文本切成着色 token。
 *
 * 状态机**不校验合法性**、对任意输入都能消费完并终止（截断文本同样能着色）；
 * token 数超过 JSON_TOKEN_MAX 时剩余部分合并为一个 plain token，避免超长行
 * 制造海量 DOM 节点。
 */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const push = (value: string, kind: JsonTokenKind) => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    // 同档相邻 token 合并，减少节点数
    if (last && last.kind === kind) {
      last.text += value;
      return;
    }
    tokens.push({ text: value, kind });
  };
  const len = text.length;
  let i = 0;
  while (i < len) {
    if (tokens.length >= JSON_TOKEN_MAX) {
      push(text.slice(i), 'plain');
      break;
    }
    const ch = text[i];
    if (ch === '"') {
      // 字符串字面量：扫到未转义的收尾引号
      let j = i + 1;
      let escaped = false;
      while (j < len) {
        const c = text[j];
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      // 向后看第一个非空白字符：是 ':' 则本串是**键**
      let k = j;
      while (k < len && /\s/.test(text[k])) k += 1;
      push(text.slice(i, j), k < len && text[k] === ':' ? 'key' : 'string');
      i = j;
      continue;
    }
    if (ch === '-' || ch === '+' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < len && /[0-9eE+\-.]/.test(text[j])) j += 1;
      push(text.slice(i, j), 'number');
      i = j;
      continue;
    }
    const word = text.startsWith('true', i)
      ? 'true'
      : text.startsWith('false', i)
        ? 'false'
        : text.startsWith('null', i)
          ? 'null'
          : null;
    if (word) {
      push(word, 'literal');
      i += word.length;
      continue;
    }
    // 标点 + 空白 + 任何无法识别的字符：归入 punct（文本保真）
    let j = i + 1;
    while (j < len) {
      const c = text[j];
      if (c === '"' || c === '-' || c === '+' || (c >= '0' && c <= '9')) break;
      if (text.startsWith('true', j) || text.startsWith('false', j) || text.startsWith('null', j)) break;
      j += 1;
    }
    push(text.slice(i, j), 'punct');
    i = j;
  }
  return tokens;
}

/**
 * 一行的着色 token 序列；非 JSON 行返回 null（调用方回落纯文本渲染）。
 *
 * 前缀（时间戳/级别标注）与后缀原样保留为 plain token，因此
 * `tokens.map(t => t.text).join('')` 在未截断时 === 原文行。
 */
export function jsonLineTokens(line: string | null | undefined): JsonToken[] | null {
  if (typeof line !== 'string') return null;
  const payload = findJsonPayload(line);
  if (!payload) return null;
  const raw = line.slice(payload.start, payload.end);
  let body = raw;
  if (raw.length > JSON_INLINE_MAX_CHARS) {
    const formatted = formatJsonValue(payload.value);
    if (!formatted) return null;
    body = formatted.inline;
  }
  const tokens: JsonToken[] = [];
  if (payload.start > 0) tokens.push({ text: line.slice(0, payload.start), kind: 'plain' });
  tokens.push(...tokenizeJson(body));
  if (payload.end < line.length) tokens.push({ text: line.slice(payload.end), kind: 'plain' });
  return tokens;
}

/**
 * 一行的**缩进美化**形态（供浮层展示）。非 JSON 行 / 序列化失败返回 null。
 * 与 `jsonLineTokens` 共用同一份载荷定位与截断策略。
 */
export function prettyJsonForLine(
  line: string | null | undefined,
): { pretty: string; truncated: boolean } | null {
  const payload = findJsonPayload(line);
  if (!payload) return null;
  const formatted = formatJsonValue(payload.value);
  if (!formatted) return null;
  return { pretty: formatted.pretty, truncated: formatted.truncated };
}
