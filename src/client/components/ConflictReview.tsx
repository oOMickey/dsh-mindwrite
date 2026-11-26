import { Icon } from './Icon.tsx';
import React, { useEffect, useState } from 'react';
import { textDifferences } from '../drafts.ts';
import type { WithEditor } from './toolbar.tsx';

export function ConflictReview({ editor: c }: WithEditor) {
  const [choices, setChoices] = useState<Record<string, 'mine' | 'latest'>>({});
  useEffect(() => setChoices({}), [c.conflictToken]);
  if (c.drawer !== 'conflicts' || !c.conflicts.length) return null;
  return (
    <aside className="mw-drawer mw-conflict-review" aria-label={c.t('chooseConflicts')}>
      <div className="mw-drawer-heading">
        <strong>
          {c.t('retryDraft')} ({c.conflicts.length})
        </strong>
        <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-drawer-content">
        <p>{c.t('chooseConflicts')}</p>
        {c.conflicts.map((conflict, index) => {
          const key = `${conflict.id}:${conflict.field}`;
          return (
            <fieldset key={key}>
              <legend title={conflict.title}>
                <span className="mw-two-lines">
                  {index + 1}/{c.conflicts.length} · {conflict.title}
                </span>
                {c.t(conflict.field === 'title' ? 'nodeTitle' : conflict.field)}
              </legend>
              {conflict.latest === undefined && <p>{c.t('deletedDraftNode')}</p>}
              <div className="mw-conflict-columns">
                {(['mine', 'latest'] as const).map((side) => {
                  const value = side === 'mine' ? conflict.mine : (conflict.latest ?? '');
                  const other = side === 'mine' ? (conflict.latest ?? '') : conflict.mine;
                  return (
                    <label key={side} data-chosen={choices[key] === side}>
                      <span>
                        <input
                          type="radio"
                          name={key}
                          value={side}
                          checked={choices[key] === side}
                          disabled={side === 'mine' && conflict.latest === undefined}
                          onChange={() => setChoices((current) => ({ ...current, [key]: side }))}
                        />
                        {c.t(side === 'mine' ? 'myVersion' : 'latestVersion')}
                      </span>
                      <div className="mw-conflict-text">
                        {textDifferences(value, other).map((part, index) =>
                          part.changed ? (
                            <mark key={index}>{part.text}</mark>
                          ) : (
                            <span key={index}>{part.text}</span>
                          ),
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
      </div>
      <div className="mw-drawer-footer">
        <button
          className="mw-primary"
          disabled={c.busy || c.conflicts.some((row) => !choices[`${row.id}:${row.field}`])}
          onClick={() => void c.perform(() => c.resolveConflicts(choices))}
        >
          {c.t('applyMerge')}
        </button>
      </div>
    </aside>
  );
}
