import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles/app.css';

const container = document.getElementById('root')!;
// NETOPT-6⑥：渲染树最外层包全局 ErrorBoundary——任一组件渲染期抛错时
// 展示错误摘要 + 「重载渲染层」，而不是整树卸载白屏。
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
