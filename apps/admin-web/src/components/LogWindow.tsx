/**
 * LOG-WIN-01：轻量日志窗口化（虚拟滚动）。
 *
 * 背景：ExecutionDetailPage 此前把整份日志一次性渲染进 <pre>——流式追加每拍
 * 全量重排，上万行时页面直接卡死，只能靠 FULL_LOGS_MAX_LINES=20000 截断
 * 强引导下载，长日志排查体验断崖。
 *
 * 实现：零依赖的窗口化——外层滚动容器 + 撑高占位层，只渲染可视窗口
 * （±OVERSCAN 缓冲行）的行。每行固定行高（LOG_ROW_HEIGHT），行内 white-space:pre
 * + 横向滚动（日志查看器的常规形态：不折行）。
 *
 * 与既有 <pre> 渲染的分工（HYBRID）：行数 ≤ LOG_VIRTUAL_THRESHOLD 时仍走
 * 原渲染（保留 pre-wrap 折行、关键词分段高亮的完整形态，单测锚定也因此
 * 不受影响）；超过阈值才切换窗口化。
 *
 * ── LOG-JSON-01：JSON 载荷着色（窗口化安全的取舍）──────────────────────────
 * 本组件把「一个逻辑行」渲染成**恰好一个固定高 DOM 行**，撑高层高度恒为
 * `lines.length × LOG_ROW_HEIGHT`，可视窗口由 `scrollTop / LOG_ROW_HEIGHT`
 * 整除换算。因此 JSON **绝不能**在这里展开成多行——那会同时破坏撑高层高度、
 * 行号整除换算与常量行高三件事，等于重写这个虚拟滚动器。
 *
 * 故采用方案 (b)：行内**单行**着色（键/字符串/数字/字面量/标点五档，见
 * utils/logLevel.ts 的 jsonLineTokens）。完整缩进美化形态经**点击浮层**
 * （JsonPrettyPopover，挂到 body，不参与滚动容器布局）呈现——既保住
 * 「展开看美化」的价值，又对窗口化零影响。
 *
 * 关键词搜索生效时**不叠加** JSON 着色：搜索是临时模式，命中高亮（mark）必须
 * 整段包裹命中文本，与逐 token 着色在同一行内会互相切断；此时以命中高亮为
 * 唯一视觉层级（见下方渲染分支）。
 */
import { Popover } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../i18n';
import {
  jsonLineTokens,
  logLineHighlightClass,
  prettyJsonForLine,
  type JsonToken,
} from '../utils/logLevel';
import { buildLogSearchSegments } from '../utils/log-search';

/** 每行固定高度（px）——fontSize 12 × lineHeight 1.6 ≈ 19.2，取 20 便于整除 */
export const LOG_ROW_HEIGHT = 20;
/** 视口外上下各多渲染的缓冲行数（快速滚动时减少白屏） */
const OVERSCAN = 20;

/**
 * 单行 JSON 着色（LOG-JSON-01）。
 *
 * `tokens` 为 null（非 JSON 行）时返回 null——调用方直接渲染纯文本，而不是套
 * 一层空组件：万行日志里每行多一个 React 元素是实打实的渲染成本。
 *
 * 色板见 utils/logLevel.ts 的 JSON_KIND_TOKEN（纯数据，不在本组件导出以避开
 * react-refresh 的 only-export-components 告警）。
 */
export function JsonLine({ tokens }: { tokens: JsonToken[] | null }) {
  if (!tokens) return null;
  return (
    <>
      {tokens.map((tk, i) =>
        tk.kind === 'plain' ? (
          tk.text
        ) : (
          <span key={i} data-json-kind={tk.kind} className={`log-json-${tk.kind}`}>
            {tk.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * JSON 行的「点开看缩进美化」浮层（LOG-JSON-01）。
 *
 * 交互取舍：
 *  · 触发面是**行内文本本身**，不额外插按钮/图标——日志区几乎每行都可能是
 *    JSON，加图标会把日志流搅成控件堆；`cursor: zoom-in` 已足够表达可点。
 *  · `trigger="click"` 而非 hover：hover 浮层在滚动时反复弹出/消失，读日志
 *    时非常烦；click 是显式意图。
 *  · 浮层容器固定到 body：日志区在 overflow:auto 的虚拟滚动容器内，留在原地
 *    会被裁掉。
 *  · 超长载荷在浮层里同样截断并显式标注——绝不假装展示的是完整内容。
 */
export function JsonPrettyPopover({
  line,
  children,
}: {
  /** 原始日志行（浮层自行再解析一次，调用方不必传两份数据） */
  line: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const pretty = prettyJsonForLine(line);
  // 非 JSON / 序列化失败：原样返回子节点，不挂任何交互（零额外 DOM）
  if (!pretty) return <>{children}</>;
  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      getPopupContainer={() => document.body}
      title={
        <span style={{ fontSize: 12 }}>
          {pretty.truncated
            ? t('execDetail.log.json.prettyTruncated')
            : t('execDetail.log.json.prettyTitle')}
        </span>
      }
      content={
        <pre
          data-testid="log-json-pretty"
          style={{
            margin: 0,
            maxHeight: 360,
            maxWidth: 640,
            overflow: 'auto',
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {pretty.pretty}
        </pre>
      }
    >
      <span
        role="button"
        tabIndex={0}
        aria-label={t('execDetail.log.json.expandAria')}
        style={{ cursor: 'zoom-in' }}
      >
        {children}
      </span>
    </Popover>
  );
}

export interface LogWindowProps {
  /** 完整日志文本（\n 分行；调用方保证非空） */
  text: string;
  /** 当前关键词（行内命中高亮；空串不高亮） */
  keyword?: string;
  /** 视口高度（px），默认与原 <pre> 的 maxHeight 500 一致 */
  height?: number;
  testId?: string;
}

export default function LogWindow({ text, keyword = '', height = 500, testId }: LogWindowProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const lines = useMemo(() => text.split('\n'), [text]);

  // 流式追加/视图切换后自动吸底（与原 <pre> 的 logRef 行为一致）
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  const start = Math.max(0, Math.floor(scrollTop / LOG_ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(lines.length, Math.ceil((scrollTop + height) / LOG_ROW_HEIGHT) + OVERSCAN);
  const visible = lines.slice(start, end);

  return (
    <div
      ref={scrollRef}
      data-testid={testId}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{
        background: 'var(--log-bg)',
        color: 'var(--log-text)',
        padding: 16,
        borderRadius: 8,
        height,
        overflow: 'auto',
        fontSize: 12,
        // UI-01：MASTER.md §Typography——日志/等宽场景用 Fira Code
        fontFamily: 'var(--font-mono)',
        lineHeight: `${LOG_ROW_HEIGHT}px`,
      }}
    >
      {/* 撑高层：总高度 = 行数 × 行高，制造真实滚动条 */}
      <div style={{ height: lines.length * LOG_ROW_HEIGHT, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * LOG_ROW_HEIGHT, left: 0, right: 0 }}>
          {visible.map((line, i) => {
            const idx = start + i;
            // 单行输入 → buildLogSearchSegments 返回单元素；segments 为行内
            // 关键词命中分段（hit 命中渲染 <mark>），lineClass 为行级高亮类
            // （OBS-03 口径与页面 <pre> 渲染一致）
            const row = keyword
              ? buildLogSearchSegments(line, keyword, logLineHighlightClass)[0]
              : null;
            const cls = row?.lineClass || logLineHighlightClass(line);
            // LOG-JSON-01：JSON 着色只在**无关键词**时生效——搜索模式下行内已被
            // <mark> 整段切分，再叠逐 token 着色会互相切断（mark 必须整段包裹）。
            const jsonTokens = keyword ? null : jsonLineTokens(line);
            return (
              <div
                key={idx}
                style={{
                  height: LOG_ROW_HEIGHT,
                  whiteSpace: 'pre',
                  // 窗口化行不折行（固定行高前提），长行横向滚动
                  overflow: 'visible',
                }}
                className={cls || undefined}
              >
                {row ? (
                  row.segments.map((piece, j) =>
                    piece.hit ? (
                      <mark key={j} className="log-search-hit">{piece.text}</mark>
                    ) : (
                      piece.text
                    ),
                  )
                ) : jsonTokens ? (
                  <JsonPrettyPopover line={line}>
                    <JsonLine tokens={jsonTokens} />
                  </JsonPrettyPopover>
                ) : (
                  line
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
