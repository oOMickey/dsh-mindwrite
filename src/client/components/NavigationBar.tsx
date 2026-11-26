import React, { useEffect, useMemo, useRef, useState } from 'react';
import { searchTree } from '../navigation.ts';
import type { WithEditor } from './toolbar.tsx';
import { Icon } from './Icon.tsx';
export function NavigationBar({ editor: c }: WithEditor) {
  const searchInput = useRef<HTMLInputElement>(null);
  const [index, setIndex] = useState(0);
  const results = useMemo(
    () => (c.snapshot ? searchTree(c.snapshot.root, c.search) : []),
    [c.snapshot?.root, c.search],
  );
  useEffect(() => {
    if (c.searchOpen) searchInput.current?.focus();
  }, [c.searchOpen]);
  useEffect(() => setIndex(0), [c.search]);
  function jump(next: number) {
    if (!results.length) return;
    const value = (next + results.length) % results.length;
    setIndex(value);
    c.focusNode(results[value].node.id);
    c.setSearchOpen(false);
  }
  if (!c.snapshot) return null;
  return (
    <>
      {c.searchOpen && (
        <div className="mw-search" role="search">
          <div className="mw-search-input">
            <input
              ref={searchInput}
              aria-label={c.t('searchLabel')}
              placeholder={c.t('searchHint')}
              value={c.search}
              onChange={(e) => c.setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  jump(index);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  c.setSearchOpen(false);
                }
              }}
            />
            <span role="status">{results.length}</span>
            <button aria-label={c.t('close')} onClick={() => c.setSearchOpen(false)}>
              <Icon name="close" />
            </button>
          </div>
          {!!c.search.trim() && (
            <div className="mw-search-results">
              {results.length ? (
                results.slice(0, 50).map((row, at) => (
                  <button key={row.node.id} aria-current={index === at} onClick={() => jump(at)}>
                    {c.labels.get(row.node.id)}
                    <small>{row.node.body}</small>
                  </button>
                ))
              ) : (
                <p>{c.t('noSearchResults')}</p>
              )}
              {results.length > 50 && <p>{c.t('refineSearch')}</p>}
            </div>
          )}
        </div>
      )}
    </>
  );
}
