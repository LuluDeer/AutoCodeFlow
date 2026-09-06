import { useEffect, useState } from 'react';

/** 输入防抖：返回延迟同步的值。列表查询应把 debounced 值放进 refreshDeps，
 *  输入框本身仍绑定原始值以保证即时回显。 */
export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
