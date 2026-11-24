import React, { useEffect, useId, useRef, useState } from 'react';
import Icon from '../../components/Icon';
import { nextSearchIndex, type SearchHit } from './search-index';

type Translate = (key: string, ...args: (string | number | boolean)[]) => string;

interface ConfigSearchBoxProps<Id extends string> {
  query: string;
  term: string;
  results: SearchHit<Id>[];
  sectionLabelOf: (section: Id) => string;
  onQueryChange: (value: string) => void;
  onPick: (result: SearchHit<Id>) => void;
  t: Translate;
}

/**
 * 设置页左栏搜索框：独立承载点击外部关闭下拉的监听，不改变 ConfigPage 的
 * 9 条 useEffect 声明序列。
 */
export default function ConfigSearchBox<Id extends string>({
  query,
  term,
  results,
  sectionLabelOf,
  onQueryChange,
  onPick,
  t,
}: ConfigSearchBoxProps<Id>) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // useId：同一页面可能有多个搜索框（向导重开/未来扩展），option id 不得撞名。
  const idBase = useId();
  const listboxId = `${idBase}-results`;
  const optionIdOf = (index: number) => `${idBase}-result-${index}`;
  // 结果集缩减时只做显示层 clamp，不写入 state：避免 effects 互相打架时把
  // 用户刚按下的方向键索引又弹回去。下一次方向键从安全索引继续。
  const safeIndex = results.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), results.length - 1);

  useEffect(() => {
    // 换词即回到首条；空词时 safeIndex 归 -1，Enter/aria 自动失效。
    setActiveIndex(0);
  }, [term]);

  useEffect(() => {
    if (term === '') return;
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) {
        onQueryChange('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [term, onQueryChange]);

  return (
    <div className="cfgx-search-wrap" ref={wrapRef}>
      <div className="cfgx-search">
        <Icon name="search" className="cfgx-search-icon icon-xs" />
        <input
          type="search"
          className="cfgx-search-input"
          value={query}
          placeholder={t('cfgx.search.placeholder')}
          aria-label={t('cfgx.search.placeholder')}
          role="combobox"
          aria-expanded={term !== ''}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={safeIndex >= 0 ? optionIdOf(safeIndex) : undefined}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onQueryChange('');
              setActiveIndex(0);
              return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (results.length === 0) return;
              e.preventDefault();
              setActiveIndex(nextSearchIndex(e.key === 'ArrowDown' ? 'down' : 'up', safeIndex, results.length));
              return;
            }
            if (e.key === 'Enter' && safeIndex >= 0) {
              e.preventDefault();
              onPick(results[safeIndex]);
            }
          }}
        />
      </div>
      {term !== '' && (
        <div className="cfgx-search-results" id={listboxId} role="listbox" aria-label={t('cfgx.search.placeholder')}>
          {results.length === 0 ? (
            <div className="cfgx-search-empty">{t('cfgx.search.empty')}</div>
          ) : (
            results.map((result, index) => (
              <button
                type="button"
                key={`${result.kind}:${result.id}`}
                id={optionIdOf(index)}
                className={`cfgx-search-result${index === safeIndex ? ' is-active' : ''}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === safeIndex}
                title={result.label}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => onPick(result)}
              >
                <span className="cfgx-search-result-main">
                  <Icon name={result.kind === 'section' ? 'chevron-right' : 'pin'} className="icon-xs" />
                  <span className="cfgx-search-result-label">{result.label}</span>
                </span>
                {result.kind === 'field' && (
                  <span className="cfgx-search-result-section">
                    {sectionLabelOf(result.section)}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
