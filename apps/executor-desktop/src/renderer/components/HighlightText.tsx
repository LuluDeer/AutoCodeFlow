import React from 'react';

// 日志搜索关键词高亮：大小写不敏感地切分文本，命中片段包 <mark class="log-mark">。
// StatusWindow 全屏查看器与 AppsPage 应用日志查看器共用，避免两处各写一份。
export default function HighlightText({ text, query }: { text: string; query: string }) {
  const q = query.toLowerCase();
  if (!q) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let last = 0;
  let idx = lower.indexOf(q, last);
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push(<mark key={idx} className="log-mark">{text.slice(idx, idx + q.length)}</mark>);
    last = idx + q.length;
    idx = lower.indexOf(q, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
