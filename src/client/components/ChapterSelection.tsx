import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { flatten, type MindNode } from '../../model.ts';
import { composing } from '../keyboard.ts';
import { Icon } from './Icon.tsx';
import type { WithEditor } from './toolbar.tsx';

function SelectionChoices({ editor: c }: WithEditor) {
  const [expanded, setExpanded] = useState(new Set<string>());
  const visible = useMemo(() => new Set(c.visible.map(({ node }) => node.id)), [c.visible]);
  const selected = new Set(c.selection);
  const root = c.snapshot!.root;
  function choice(node: MindNode, onHeading = false) {
    const checked = selected.has(node.id);
    return (
      <label className="mw-pick-row" key={node.id}>
        <span className="mw-pick-mark">
          <input
            type="checkbox"
            aria-label={onHeading ? c.targetName(node.id) : undefined}
            value={node.id}
            checked={checked}
            onChange={() =>
              c.replaceSelection(
                checked ? c.selection.filter((id) => id !== node.id) : [...c.selection, node.id],
                true,
              )
            }
          />
          <Icon name="check" />
        </span>
        {!onHeading && <span>{c.targetName(node.id)}</span>}
        {!visible.has(node.id) && <small>{c.t('hiddenByFold')}</small>}
      </label>
    );
  }
  return (
    <div className="mw-pick-choices">
      <section>
        {choice(root)}
        {root.children.filter((n) => n.kind === 'preamble').map((node) => choice(node))}
      </section>
      {root.children
        .filter((n) => n.kind !== 'preamble')
        .map((chapter) => {
          const open = expanded.has(chapter.id);
          return (
            <section key={chapter.id}>
              <div className="mw-pick-chapter-line">
                <button
                  className="mw-pick-chapter"
                  aria-expanded={open}
                  onClick={() => {
                    const next = new Set(expanded);
                    if (open) next.delete(chapter.id);
                    else next.add(chapter.id);
                    setExpanded(next);
                  }}
                >
                  <Icon name={open ? 'down' : 'right'} />
                  {c.targetName(chapter.id)}
                </button>
                {open && choice(chapter, true)}
              </div>
              {open && (
                <div className="mw-pick-children">
                  {flatten(chapter)
                    .slice(1)
                    .map(({ node }) => choice(node))}
                </div>
              )}
            </section>
          );
        })}
    </div>
  );
}

export function ChapterSelection({ editor: c }: WithEditor) {
  const open = c.drawer === 'chapter-selection';
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restore = useRef<() => void>();
  const id = useId();
  function close() {
    c.openDrawer(null);
    trigger.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!open) return;
    function outside(e: PointerEvent) {
      if (!holder.current?.contains(e.target as Node)) close();
    }
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  return (
    <div
      ref={holder}
      onBlur={(event) => {
        if (open && event.relatedTarget && !holder.current?.contains(event.relatedTarget))
          c.openDrawer(null);
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        className="mw-ghost mw-pick-trigger"
        ref={trigger}
        aria-label={c.t('pickByChapter')}
        title={c.t('pickByChapter')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={!!c.newHeading}
        onClick={() => {
          if (open) return close();
          restore.current = c.rememberSelection();
          c.openDrawer('chapter-selection');
        }}
      >
        {c.t('pickByChapterShort')}
      </Button>
      {open && (
        <div
          className="mw-pick-popover"
          role="dialog"
          id={id}
          aria-label={c.t('pickByChapter')}
          onKeyDown={(e) => {
            if (composing(e.nativeEvent) || e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
            e.stopPropagation();
          }}
        >
          <div className="mw-pick-heading">
            <strong>{c.t('pickByChapter')}</strong>
            <span role="status">
              {c.t('selectionCount').replace('{n}', String(c.targets.ids.length))}
            </span>
            <button autoFocus aria-label={c.t('close')} onClick={close}>
              <Icon name="close" />
            </button>
          </div>
          <SelectionChoices editor={c} />
          <div className="mw-pick-actions">
            <button
              aria-disabled={!c.targets.ids.length}
              onClick={() => {
                if (c.targets.ids.length) c.clearSelection();
              }}
            >
              {c.t('clearTreeSelection')}
            </button>
            <button
              onClick={() => {
                restore.current?.();
                close();
              }}
            >
              {c.t('cancel')}
            </button>
            <button className="mw-primary" onClick={close}>
              {c.t('donePicking')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
