import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import HighlightText from './HighlightText';
import FormattedLogText, { extractLineTrace } from './FormattedLogText';
import { createCfgTexts, resolveRendererLocale } from '../i18n';
import type { ViewerLine } from './LogViewer';

/** V4 后续优化（6）：行内工具文案入双语表（zh 值与原硬编码逐字一致）。 */
const t = createCfgTexts(resolveRendererLocale(() => navigator.language));

/**
 * 共享日志行渲染层（V4-2 日志管线归一，「同一对象一种渲染」）。
 *
 * LogViewer（全屏）与 StatusWindow（页内预览）的行渲染统一收口到本组件：
 * trace 块合并（块首 chip + 块内 hideTrace）、E-02 到达动效（首屏行不闪）、
 * 行号、搜索态命中高亮，以及行内工具（hover 浮现「复制此行」，warn/error 行
 * 另有「打开文件」入口）。
 *
 * 本组件只负责「行」——滚动容器、窗口化加载更早、搜索/级别过滤、跟随底部
 * 仍由调用方承接（LogViewer 内置，StatusWindow 预览自持）。
 *
 * 性能（V4 后续优化 4）：行渲染 memo 化——hover/复制反馈按行下标传递，受影响
 * 的行才重渲染（350 行窗口内 hover 不再整列表 diff）。trace 合并/块首判定
 * 与到达动效的判定语义自原 LogViewer 原样保留：
 *  - trace 块只在「展示窗口内」连续同 trace 行构成（无 trace 行打断）；
 *  - 搜索态走 HighlightText 原样渲染（匹配计数/高亮必须基于完整行文本）；
 *  - 首次拿到非空 lines 时记录已有 id 集合，之后新增的行才应用动画类。
 */

export interface LogLineListProps {
  /** 完整行缓冲：到达动效的「已有行」集合与行号偏移按它计算 */
  lines: ViewerLine[];
  /** 本次要渲染的窗口行（窗口化/过滤/搜索切片由调用方完成） */
  displayed: Array<{ line: ViewerLine; i: number }>;
  /** 搜索关键词；非空时走 HighlightText 且跳过 trace 合并（语义与迁移前一致） */
  query?: string;
  /** 当前命中行（搜索态上下跳转的行高亮） */
  currentIdx?: number | null;
  /** buffered = 行号 = 数据数组下标 + 1；hidden = 不渲染行号（预览区） */
  lineNumbers?: 'hidden' | 'buffered';
  /** 传入时行号 = lineNoOffset - lines.length + index + 1（全局行号） */
  lineNoOffset?: number | null;
  /** 新行到达 2s 绿底淡出（E-02） */
  arriveAnimation?: boolean;
  /** 行内「打开文件」入口：仅 warn/error 行 hover 浮现，打开逻辑由调用方注入 */
  onOpenFile?: () => void;
  /** 行内入口的 title 文案（应用查看器为「打开部署目录」等） */
  onOpenFileTitle?: string;
}

type CopyFeedback = 'none' | 'copied' | 'error';

interface LogRowProps {
  line: ViewerLine;
  i: number;
  /** 块内行（trace 合并：剥离正文 trace 段 + 左舷竖线） */
  inBlock: boolean;
  /** 块首（渲染 trace chip 的那一行） */
  isBlockHead: boolean;
  trace: string | null;
  isCurrent: boolean;
  isNew: boolean;
  lineNo: number;
  showLineNo: boolean;
  hovered: boolean;
  copyFeedback: CopyFeedback;
  searching: boolean;
  q: string;
  onOpenFile?: () => void;
  onOpenFileTitle: string;
  onHover: (i: number | null) => void;
  onCopy: (text: string, i: number) => void;
}

const LogRow = memo(function LogRow({
  line,
  i,
  inBlock,
  isBlockHead,
  trace,
  isCurrent,
  isNew,
  lineNo,
  showLineNo,
  hovered,
  copyFeedback,
  searching,
  q,
  onOpenFile,
  onOpenFileTitle,
  onHover,
  onCopy,
}: LogRowProps) {
  return (
    <div
      data-logidx={i}
      className={`log-line ${line.level}${isCurrent ? ' log-highlight' : ''}${inBlock ? ' log-trace-block' : ''}${isNew ? ' log-line-arrive' : ''}`}
      onMouseEnter={() => onHover(i)}
      onMouseLeave={() => onHover(null)}
    >
      {showLineNo && <span className="log-line-no">{lineNo}</span>}
      {isBlockHead && trace !== null && <span className="ll-trace-chip">trace {trace}</span>}
      {searching ? <HighlightText text={line.text} query={q} /> : <FormattedLogText text={line.text} hideTrace={inBlock} />}
      {hovered && (
        <span className="log-line-tools">
          {onOpenFile && line.level !== '' && (
            <button
              type="button"
              className="log-line-tool"
              title={onOpenFileTitle}
              aria-label={onOpenFileTitle}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onOpenFile}
            >
              <Icon name="external" className="icon-xs" />
            </button>
          )}
          <button
            type="button"
            className={`log-line-tool${copyFeedback === 'copied' ? ' is-ok' : copyFeedback === 'error' ? ' is-err' : ''}`}
            title={copyFeedback === 'error' ? t('logviewer.copyFail') : t('logviewer.copyLine')}
            aria-label={t('logviewer.copyLine')}
            onClick={() => onCopy(line.text, i)}
          >
            <Icon name={copyFeedback === 'copied' ? 'check' : copyFeedback === 'error' ? 'close' : 'copy'} className="icon-xs" />
          </button>
        </span>
      )}
    </div>
  );
});

export default function LogLineList({
  lines,
  displayed,
  query = '',
  currentIdx = null,
  lineNumbers = 'buffered',
  lineNoOffset = null,
  arriveAnimation = false,
  onOpenFile,
  onOpenFileTitle = t('logviewer.openFile'),
}: LogLineListProps) {
  // ── E-02 到达动效：首次拿到非空 lines 时记录已有 id 集合（effect 置 ref），
  // 之后新增的行才应用动画类——打开时刻已存在的行（首屏）不加动画类。
  const arrivalIdsRef = useRef<Set<string | number> | null>(null);
  useEffect(() => {
    if (!arriveAnimation || arrivalIdsRef.current || lines.length === 0) return;
    arrivalIdsRef.current = new Set(lines.map((line) => line.id));
  }, [arriveAnimation, lines]);

  // ── 行内工具状态：hover/复制反馈都按「展示行下标」记录——memo 行组件下，
  // 一次 hover 只重渲染进出的两行，而不是整个窗口。
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [copyIdx, setCopyIdx] = useState<number | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>('none');
  useEffect(() => {
    if (copyFeedback === 'none') return;
    const t = setTimeout(() => {
      setCopyFeedback('none');
      setCopyIdx(null);
    }, 1200);
    return () => clearTimeout(t);
  }, [copyFeedback]);

  const handleHover = useCallback((i: number | null) => setHoverIdx(i), []);
  const handleCopy = useCallback((text: string, i: number) => {
    const api = (window as unknown as {
      electronAPI?: { writeClipboardText?: (t: string) => Promise<{ ok: boolean }> };
    }).electronAPI;
    setCopyIdx(i);
    if (typeof api?.writeClipboardText !== 'function') {
      setCopyFeedback('error');
      return;
    }
    api.writeClipboardText(text)
      .then((r) => setCopyFeedback(r?.ok === false ? 'error' : 'copied'))
      .catch(() => setCopyFeedback('error'));
  }, []);

  // ── trace 合并：对展示行抽取 trace 段（渲染层能力，不改行文本）──
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const displayedTraces = displayed.map(({ line }) => extractLineTrace(line.text));
  const arrivalIds = arrivalIdsRef.current;
  const showLineNo = lineNumbers !== 'hidden';

  return (
    <>
      {displayed.map(({ line, i }, di) => {
        const trace = displayedTraces[di];
        const inBlock = !searching && trace !== null;
        const isBlockHead = inBlock && (di === 0 || displayedTraces[di - 1] !== trace);
        const isNew = Boolean(
          arriveAnimation
          && arrivalIds !== null
          && !arrivalIds.has(line.id),
        );
        const lineNo = lineNoOffset !== null ? lineNoOffset - lines.length + i + 1 : i + 1;
        return (
          <LogRow
            key={line.id}
            line={line}
            i={i}
            inBlock={inBlock}
            isBlockHead={isBlockHead}
            trace={trace}
            isCurrent={currentIdx !== null && currentIdx === i}
            isNew={isNew}
            lineNo={lineNo}
            showLineNo={showLineNo}
            hovered={hoverIdx === i}
            copyFeedback={copyIdx === i ? copyFeedback : 'none'}
            searching={searching}
            q={q}
            onOpenFile={onOpenFile}
            onOpenFileTitle={onOpenFileTitle}
            onHover={handleHover}
            onCopy={handleCopy}
          />
        );
      })}
    </>
  );
}
