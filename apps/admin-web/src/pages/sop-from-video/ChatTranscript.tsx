/**
 * R139：会话气泡列表（纯展示）—— 从 `SopFromVideoPage` 外提。
 *
 * 为什么外提：该页体量已在 `scripts/source-size-baseline.json` 里顶格
 * （`ceiling.nonCommentLines=471` / `ceiling.functionLines=473`，只减不增），
 * 而 P2-1/P3-3 的修复必须在本组件函数体里加分支。把这段无状态 JSX
 * （40 余行的内联样式气泡）搬出来，是唯一不动业务语义的等价压缩。
 *
 * 渲染口径逐字节沿用原实现：用户气泡右对齐、`#e6f4ff`；模型气泡左对齐、
 * `#fafafa`；流式增量用 `#f6ffed` + 闪烁光标，且**只在 `sending` 为真时**出现。
 */
import type { CSSProperties } from 'react';
import type { SopSessionMessage } from '../../api/ai';

const ROW: CSSProperties = {
  display: 'flex',
  marginBottom: 10,
};

const BUBBLE: CSSProperties = {
  maxWidth: '86%',
  padding: '8px 12px',
  borderRadius: 10,
  border: '1px solid #f0f0f0',
  whiteSpace: 'pre-wrap',
};

export interface ChatTranscriptProps {
  messages: SopSessionMessage[];
  /** 是否正在等模型出字（流式气泡只在此时显示） */
  streaming: boolean;
  /** 流式增量文本 */
  streamingText: string;
}

export default function ChatTranscript({
  messages,
  streaming,
  streamingText,
}: ChatTranscriptProps) {
  return (
    <div style={{ maxHeight: 420, overflowY: 'auto' }}>
      {messages.map((m, i) => (
        <div
          key={`${m.at}-${i}`}
          style={{ ...ROW, justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}
        >
          <div style={{ ...BUBBLE, background: m.role === 'user' ? '#e6f4ff' : '#fafafa' }}>
            {m.text}
          </div>
        </div>
      ))}
      {streaming && streamingText ? (
        <div style={{ ...ROW, justifyContent: 'flex-start' }}>
          <div style={{ ...BUBBLE, background: '#f6ffed' }}>
            {streamingText}
            <span style={{ opacity: 0.45 }}>▍</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
