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
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { logLineHighlightClass } from '../utils/logLevel';
import { buildLogSearchSegments } from '../utils/log-search';

/** 每行固定高度（px）——fontSize 12 × lineHeight 1.6 ≈ 19.2，取 20 便于整除 */
export const LOG_ROW_HEIGHT = 20;
/** 视口外上下各多渲染的缓冲行数（快速滚动时减少白屏） */
const OVERSCAN = 20;

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
                {row
                  ? row.segments.map((piece, j) =>
                      piece.hit ? (
                        <mark key={j} className="log-search-hit">{piece.text}</mark>
                      ) : (
                        piece.text
                      ),
                    )
                  : line}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
