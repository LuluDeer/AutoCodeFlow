import React from 'react';

/**
 * 结构化日志行着色（时间 / 级别 / 正文 三段分色）。
 *
 * 规范化的日志行形如 `[HH:mm:ss.SSS] [LEVEL] 正文`。渲染时把时间戳与级别
 * 从正文里剥离并分别着色：时间戳与级别不再和正文抢视觉权重，扫读时一眼
 * 定位级别。StatusWindow 预览与全屏查看器、AppsPage 应用日志查看器共用。
 * 非结构化行（纯文本输出）原样返回，不强行加壳。
 */
const STRUCTURED_LINE_RE =
  /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\](?: \[(DEBUG|INFO|WARN|ERROR)\])? (.*)$/s;

// trace 段位于拆出的 msg 起始处：`[23fb6898] Sending heartbeat`（normalizeLogLine
// 已把完整 UUID 截短为 8 位短 id）。非结构化行没有 msg 段，不参与 trace 合并。
const TRACE_PREFIX_RE = /^\[([0-9a-f]{8})\] /i;

/**
 * 抽取规范化日志行的 trace 短 id（如 `23fb6898`）。
 * 仅结构化行参与（A-03 trace 合并是渲染层能力，不改写入 state 的行文本）；
 * 非结构化行 / 无 trace 行返回 null，渲染保持原样。
 */
export function extractLineTrace(text: string): string | null {
  const m = STRUCTURED_LINE_RE.exec(text);
  if (!m) return null;
  const t = TRACE_PREFIX_RE.exec(m[3]);
  return t ? t[1] : null;
}

export default function FormattedLogText({ text, hideTrace }: { text: string; hideTrace?: boolean }) {
  const m = STRUCTURED_LINE_RE.exec(text);
  if (!m) return <>{text}</>;
  const [, clock, level, rest] = m;
  // hideTrace（trace 合并块内行）：剥离 msg 开头的 trace 段再渲染；
  // 无 trace 前缀时 replace 原样返回，行为与不加 prop 完全一致。
  const msg = hideTrace ? rest.replace(TRACE_PREFIX_RE, '') : rest;
  return (
    <>
      <span className="ll-time">{clock}</span>
      {level && <span className={`ll-level ll-${level.toLowerCase()}`}>{level}</span>}
      <span className="ll-msg">{msg}</span>
    </>
  );
}
