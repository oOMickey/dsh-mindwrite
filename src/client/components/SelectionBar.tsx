import React from 'react';
import { actionTargetIds } from '../instruction.ts';
import { Icon } from './Icon.tsx';
import { SelectionChips, type WithEditor } from './toolbar.tsx';

export function SelectionBar({ editor: c }: WithEditor) {
  const { ids, leadId, key } = c.targets;
  return (
    <>
      {ids.length > 0 && (
        <details className="mw-selection-names" key={key}>
          <summary title={c.t('toggleTargetNames')}>
            <Icon name="right" />
            <span aria-live="polite" aria-atomic="true">
              <SelectionChips editor={c} />
              {leadId && ' · ' + c.targetLine('leadNames', actionTargetIds(c.targets, 'polish'))}
            </span>
          </summary>
        </details>
      )}
      {c.locked && (
        <span
          className="mw-active-targets"
          role="status"
          title={c.targetLine('activeNames', c.activeIds)}
        >
          <span className="mw-spinner" /> {c.targetLine('activeNames', c.activeIds)}
        </span>
      )}
      {ids.length > 0 && <button onClick={c.clearSelection}>{c.t('clearTreeSelection')}</button>}
    </>
  );
}
