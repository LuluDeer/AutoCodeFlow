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

export default function FormattedLogText({ text }: { text: string }) {
  const m = STRUCTURED_LINE_RE.exec(text);
  if (!m) return <>{text}</>;
  const [, clock, level, rest] = m;
  return (
    <>
      <span className="ll-time">{clock}</span>
      {level && <span className={`ll-level ll-${level.toLowerCase()}`}>{level}</span>}
      <span className="ll-msg">{rest}</span>
    </>
  );
}
