import type { FallbackProps } from 'react-error-boundary';

// FE-02: global fallback — prevents a render error from leaving the user on a blank screen
export default function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div
      role="alert"
      style={{ padding: '32px', textAlign: 'center', fontFamily: 'sans-serif' }}
    >
      <h2>页面出错了</h2>
      <p style={{ color: '#888', marginBottom: '16px' }}>{(error as Error).message}</p>
      <button onClick={resetErrorBoundary}>重新加载</button>
    </div>
  );
}
