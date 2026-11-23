import React, { useEffect, useRef } from 'react';
import Icon from '../../components/Icon';
import type { SearchHit } from './search-index';

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
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onQueryChange('');
              return;
            }
            if (e.key === 'Enter' && results.length > 0) {
              e.preventDefault();
              onPick(results[0]);
            }
          }}
        />
      </div>
      {term !== '' && (
        <div className="cfgx-search-results" role="listbox" aria-label={t('cfgx.search.placeholder')}>
          {results.length === 0 ? (
            <div className="cfgx-search-empty">{t('cfgx.search.empty')}</div>
          ) : (
            results.map((result) => (
              <button
                type="button"
                key={`${result.kind}:${result.id}`}
                className="cfgx-search-result"
                role="option"
                aria-selected="false"
                title={result.label}
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
