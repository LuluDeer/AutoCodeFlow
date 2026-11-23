import React from 'react';
import { formatRunningTaskTitle } from './status-helpers';

/**
 * 活动条运行中任务芯片：
 * 把任务名包进独立内层 span 做单行省略（CSS 规范中 flex 容器本身不触发 text-overflow），
 * 同时保留右侧 `flex: none` 运行时长不被硬裁切。
 */
export default function RunningTaskChip({
  name,
  duration,
}: {
  name: string;
  duration: string | null;
}) {
  return (
    <span className="today-summary-task" title={formatRunningTaskTitle(name, duration)}>
      <span className="today-summary-task-name">{name}</span>
      {duration && <b className="today-summary-task-dur">{duration}</b>}
    </span>
  );
}
