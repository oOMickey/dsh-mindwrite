import { styleTokens } from '../../style-tokens.ts';
import React, { useLayoutEffect, useRef } from 'react';
import { editedTitle } from '../../numbering.ts';
import { composing } from '../keyboard.ts';
import type { WithEditor } from './toolbar.tsx';

export function InlineEditor({
  editor: c,
  heading,
}: WithEditor & { heading?: import('../../numbering.ts').NumberedTitle }) {
  const base = c.inlineEdit!;
  const resolved = heading ?? (!c.profile.legacy ? c.numbers.get(base.id) : undefined);
  const prefix = resolved?.sourcePrefix ?? '';
  const number = resolved?.prefix.trim();
  const original = base.title.startsWith(prefix) ? base.title.slice(prefix.length) : base.title;
  const title = base.draftTitle ?? original;
  const body = base.draftBody ?? base.body;
  function update(patch: { draftTitle?: string; draftBody?: string }) {
    c.setInlineEdit((active) =>
      active &&
      active.id === base.id &&
      active.path === base.path &&
      active.documentId === base.documentId
        ? { ...active, ...patch }
        : active,
    );
  }
  const stored = title === original ? base.title : editedTitle(title, resolved);
  const disabled = c.busy || c.locked || !!c.recovery || !title.trim() || stored.length > 500;
  const save = () => {
    if (!disabled) void c.perform(() => c.saveInline(stored, body));
  };
  return (
    <div
      className="mw-inline-editor"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing(e.nativeEvent)) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          c.setInlineEdit(undefined);
        }
        if (e.key === 'Enter' && !e.shiftKey && !(e.target as HTMLElement)?.closest?.('button')) {
          e.preventDefault();
          if (!e.repeat) save();
        }
      }}
    >
      {number && <strong className="mw-paper-number">{number}</strong>}
      <input
        autoFocus
        aria-label={c.t('nodeTitle')}
        value={title}
        onChange={(e) => update({ draftTitle: e.target.value })}
      />
      <textarea
        aria-label={c.t('body')}
        rows={4}
        value={body}
        onChange={(e) => update({ draftBody: e.target.value })}
      />
      <footer>
        <button className="mw-primary" disabled={disabled} onClick={save}>
          {c.t('saveEnter')}
        </button>
        <button onClick={() => c.setInlineEdit(undefined)}>{c.t('cancelEsc')}</button>
      </footer>
    </div>
  );
}

export function MapEditCard({ editor: c }: WithEditor) {
  const card = useRef<HTMLDivElement>(null);
  const id = c.inlineEdit!.id;
  useLayoutEffect(() => {
    const el = card.current,
      board = c.board.current,
      wrap = el?.parentElement;
    const node = board?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    if (!board || !el || !wrap || !node) return;
    function position() {
      const at = node!.getBoundingClientRect(),
        bounds = wrap!.getBoundingClientRect();
      const inset = styleTokens.space.small;
      el!.style.left =
        Math.max(inset, Math.min(at.left - bounds.left, bounds.width - el!.offsetWidth - inset)) +
        'px';
      el!.style.top =
        Math.max(inset, Math.min(at.top - bounds.top, bounds.height - el!.offsetHeight - inset)) +
        'px';
    }
    position();
    const observer = new ResizeObserver(position);
    observer.observe(wrap);
    observer.observe(el);
    board.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      board.removeEventListener('scroll', position);
    };
  }, [id, c.layout, c.zoom]);
  return (
    <div className="mw-map-edit-card" ref={card}>
      <InlineEditor editor={c} />
    </div>
  );
}
