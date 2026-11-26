import type { Expansion } from '../../model.ts';
import { Icon } from './Icon.tsx';
import React from 'react';
import { ActionButton, EditToolbar, TargetNames, type WithEditor } from './toolbar.tsx';
export function ActionDrawer({ editor: c }: WithEditor) {
  if (c.drawer !== 'actions') return null;
  return (
    <aside className="mw-drawer mw-actions-drawer" aria-label={c.t('actions')}>
      <div className="mw-drawer-heading">
        <strong>{c.t('actions')}</strong>
        <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-drawer-content">
        <EditToolbar editor={c} />
        <TargetNames editor={c} />
        <input
          aria-label={c.t('instruction')}
          placeholder={c.t('instructionHint')}
          value={c.instruction}
          onChange={(event) => c.setInstruction(event.target.value)}
        />
        <p className="mw-instruction-preview">
          {c.t('usingInstruction')}：{c.instruction || c.t('defaultInstruction')}
        </p>
        <div className="mw-drawer-actions">
          <ActionButton
            editor={c}
            label="runInstruction"
            disabled={c.locked || !c.targets.ids.length}
            action={() => c.ai('polish')}
          />
          <ActionButton
            editor={c}
            label="rename"
            disabled={c.locked || !c.targets.ids.length}
            action={() => c.ai('title')}
          />
          <label className="mw-expand-choice">
            {c.t('expandDepth')}
            <select
              aria-label={c.t('expandDepth')}
              value={c.expansion}
              onChange={(e) => c.setExpansion(e.target.value as Expansion)}
            >
              {(
                [
                  'one',
                  'articles',
                  ...(c.snapshot?.expansionDefault === 'unlimited' ? ['unlimited' as const] : []),
                ] as const
              ).map((depth) => (
                <option value={depth} key={depth}>
                  {c.t(depth === 'articles' ? 'toArticles' : depth)}
                </option>
              ))}
            </select>
          </label>
          <ActionButton
            editor={c}
            label="confirmExpand"
            disabled={c.locked || !c.targets.ids.length}
            action={() => c.ai('expand')}
          />
          <ActionButton
            editor={c}
            label={c.selected?.id === c.snapshot?.root.id ? 'selectRoot' : 'selectChapter'}
            disabled={!c.selected}
            action={c.selectChapter}
          />
          <ActionButton editor={c} label="selectLevel" action={c.selectLevel} />
          <ActionButton
            editor={c}
            label="draftReason"
            disabled={c.locked || !c.targets.ids.length}
            action={() => c.ai('note')}
          />
          <ActionButton
            editor={c}
            label="mergeSelected"
            disabled={c.locked || c.selection.length < 2}
            action={() => c.change([{ type: 'merge', ids: c.selection, targetId: c.selection[0] }])}
          />
          <ActionButton
            editor={c}
            label="pasteTree"
            disabled={c.locked}
            action={() => c.openDrawer('paste')}
          />
        </div>
      </div>
    </aside>
  );
}
