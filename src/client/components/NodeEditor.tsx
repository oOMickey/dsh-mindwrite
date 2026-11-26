import React, { useLayoutEffect, useRef, useState } from 'react';
import type { MindNode } from '../../model.ts';
import { nodeTitleParts } from '../map-card.ts';
import { editedTitle } from '../../numbering.ts';
import type { EditorController } from '../hooks/useEditor.ts';
import { composing } from '../keyboard.ts';
import { Icon } from './Icon.tsx';
type Props = { editor: EditorController; node: MindNode };
export function AddNodeButton({ editor: c, node, child }: Props & { child: boolean }) {
  const label = c.t(child ? 'childShortcut' : 'siblingShortcut');
  return (
    <button
      type="button"
      className="mw-add-node"
      data-add={child ? 'child' : 'sibling'}
      title={label}
      aria-label={label}
      disabled={c.locked || c.busy || !!c.recovery}
      onClick={(e) => {
        e.stopPropagation();
        void c.perform(() => c.add(child, node, true));
      }}
    >
      <Icon name="plus" />
    </button>
  );
}

export function NewHeadingInput({ editor: c, node }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const ime = useRef(false);
  const blurred = useRef(false);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => {
      if (c.view === 'map') c.navigation.ensure(node.id);
      else el.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [node.id]);
  return (
    <input
      ref={input}
      className="mw-title-input"
      aria-label={c.t('nodeTitle')}
      placeholder={c.t('inputTitle')}
      readOnly={c.busy || c.locked || !!c.recovery}
      maxLength={500}
      defaultValue={c.headingText.current}
      onChange={(e) => {
        c.headingText.current = e.currentTarget.value;
      }}
      onClick={(e) => e.stopPropagation()}
      onCompositionStart={() => {
        ime.current = true;
      }}
      onCompositionEnd={(e) => {
        ime.current = false;
        if (blurred.current) {
          blurred.current = false;
          const title = e.currentTarget.value;
          void c.perform(() => c.finishHeading(title, 'blur'));
        }
      }}
      onBlur={(e) => {
        const title = e.currentTarget.value;
        if (ime.current && title.trim()) {
          blurred.current = true;
          return;
        }
        void c.perform(() => c.finishHeading(title, 'blur'));
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (ime.current || composing(e.nativeEvent) || !['Enter', 'Escape'].includes(e.key)) return;
        e.preventDefault();
        const title = e.currentTarget.value;
        if (!e.repeat && (title.trim() || e.key === 'Escape'))
          void c.perform(() => c.finishHeading(title, e.key === 'Enter' ? 'enter' : 'escape'));
      }}
    />
  );
}
const graphemes = new Intl.Segmenter();
function MapRootTitle({ text }: { text: string }) {
  const tail = [...graphemes.segment(text)].at(-2)?.index ?? 0;
  return (
    <>
      {text.slice(0, tail)}
      <span className="mw-root-title-end">{text.slice(tail)}</span>
    </>
  );
}
export function NodeTitle({ editor: c, node }: Props) {
  const heading = c.numbers.get(node.id);
  const raw = c.value(node, 'title');
  const editableHeading = c.profile.legacy ? undefined : heading;
  const { editable, text } = nodeTitleParts(node, raw, heading, c.profile.legacy);
  if (c.newHeading?.node.id === node.id)
    return (
      <>
        {heading?.prefix && <small className="mw-node-number">{heading.prefix.trim()}</small>}
        <NewHeadingInput editor={c} node={node} />
      </>
    );
  if (c.editing === node.id)
    return (
      <>
        {editableHeading?.prefix && (
          <small className="mw-node-number">{editableHeading.prefix.trim()}</small>
        )}
        <input
          className="mw-title-input"
          autoFocus
          aria-label={c.t('nodeTitle')}
          value={editable}
          disabled={c.locked || !!c.recovery}
          aria-invalid={!editable.trim() || raw.length > 500}
          title={c.t('titleLimit')}
          {...c.focusProps(node.id, false)}
          onChange={(e) => c.edit(node, 'title', editedTitle(e.target.value, editableHeading))}
          onCompositionStart={() => c.composition(node.id, true)}
          onCompositionEnd={() => c.composition(node.id, false)}
          onBlur={() => {
            if (c.composingNodes.current.has(node.id)) return;
            if (editable.trim() && raw.length <= 500) c.setEditing(undefined);
            void c.perform(c.flush);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (composing(e.nativeEvent) || c.composingNodes.current.has(node.id)) return;
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              void c.perform(async () => {
                await c.flush();
                c.setEditing(undefined);
                c.locateSelection(node.id);
              });
            }
          }}
        />
      </>
    );
  return (
    <span
      className="mw-node-title"
      tabIndex={0}
      title={c.labels.get(node.id) ?? c.value(node, 'title')}
      aria-label={c.labels.get(node.id) ?? c.value(node, 'title')}
      {...c.focusProps(node.id)}
      onClick={(event) => {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey)
          event.currentTarget.focus({ preventScroll: true });
        c.select(node.id, event);
        event.stopPropagation();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (c.view === 'map') c.beginInlineEdit(node);
        else if (!c.locked) c.setEditing(node.id);
      }}
    >
      {heading?.prefix && <small className="mw-node-number">{heading.prefix.trim()}</small>}
      <span className="mw-title-text">
        {c.view === 'map' && c.snapshot?.root.id === node.id ? <MapRootTitle text={text} /> : text}
      </span>
    </span>
  );
}
export function FoldButton({ editor: c, node, hasBody }: Props & { hasBody?: boolean }) {
  if (!node.children.length && !hasBody)
    return <span className="mw-fold-space" aria-hidden="true" />;
  const collapsed = node.collapsed;
  return (
    <button
      className="mw-fold"
      title={c.t('fold')}
      aria-label={c.t('fold')}
      aria-expanded={!collapsed}
      onClick={(e) => {
        e.stopPropagation();
        c.navigation.toggleFold(node.id);
      }}
    >
      <Icon name="right" />
    </button>
  );
}
const stateLabels = {
  processing: 'busyState',
  pending: 'reviewState',
  applied: 'appliedState',
  conflict: 'conflictState',
} as const;

export function StateBadges({ editor: c, node, part }: Props & { part?: 'heading' | number }) {
  const state = c.nodeStatus(node.id, part);
  return state ? (
    <span className="mw-state-word" data-badge={state}>
      {c.t(stateLabels[state])}
    </span>
  ) : null;
}
export function BodyNoteFields({ editor: c, node }: Props) {
  const [field, setField] = useState<'body' | 'title'>('body');
  function input(part: 'title' | 'body' | 'note') {
    return (
      <textarea
        key={node.id + part}
        aria-label={`${c.t(part === 'title' ? 'nodeTitle' : part)} ${node.title}`}
        {...c.focusProps(node.id)}
        value={c.value(node, part)}
        disabled={c.locked || !!c.recovery}
        placeholder={c.t(
          part === 'title' ? 'titleLimit' : part === 'body' ? 'bodyHint' : 'noteHint',
        )}
        aria-invalid={
          part === 'title' && (!c.value(node, part).trim() || c.value(node, part).length > 500)
        }
        onChange={(e) => c.edit(node, part, e.target.value)}
        onCompositionStart={() => c.composition(node.id, true)}
        onCompositionEnd={() => c.composition(node.id, false)}
        onBlur={() => {
          if (!c.composingNodes.current.has(node.id)) void c.perform(c.flush);
        }}
      />
    );
  }
  return (
    <div className="mw-body-fields" data-field={field} onClick={(e) => e.stopPropagation()}>
      <div className="mw-field-tabs">
        {(['title', 'body'] as const).map((part) => (
          <button key={part} aria-pressed={field === part} onClick={() => setField(part)}>
            {c.t(part === 'title' ? 'nodeTitle' : 'body')}
          </button>
        ))}
      </div>
      {input(field)}
      <details key={node.id} className="mw-writing-note">
        <summary>{c.t('noteExcluded')}</summary>
        {input('note')}
      </details>
    </div>
  );
}
export function NodeDetails({ editor: c }: { editor: EditorController }) {
  if (!c.selected || c.drawer !== 'edit') return null;
  return (
    <aside className="mw-drawer mw-node-details" aria-label={c.t('editBodyNote')}>
      <div className="mw-drawer-heading">
        <strong title={c.labels.get(c.selected.id)}>{c.labels.get(c.selected.id)}</strong>
        <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-drawer-content">
        <BodyNoteFields editor={c} node={c.selected} />
      </div>
    </aside>
  );
}
