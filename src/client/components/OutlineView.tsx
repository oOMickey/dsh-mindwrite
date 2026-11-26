import { childCountLabel } from '../map-card.ts';
import { styleTokens } from '../../style-tokens.ts';
import React, { useState, useLayoutEffect } from 'react';
import { naturalParagraphs } from '../../paragraphs.ts';
import { type MindNode } from '../../model.ts';
import {
  AddNodeButton,
  NodeTitle,
  FoldButton,
  BodyNoteFields,
  StateBadges,
} from './NodeEditor.tsx';
import type { WithEditor } from './toolbar.tsx';
import { Icon } from './Icon.tsx';
import { useListMotion } from '../hooks/useListMotion.ts';
import { documentKey } from '../types.ts';
function firstSentence(body: string, title: string) {
  const lines = body.trim().split(/\r?\n/);
  const start = lines.length > 1 && lines[0].trim() === title.trim() ? 1 : 0;
  return lines
    .slice(start)
    .join(' ')
    .trim()
    .match(/^[^。！？.!?]*[。！？.!?]?/)?.[0];
}
function OutlineRow({ editor: c, node, depth }: WithEditor & { node: MindNode; depth: number }) {
  const body = c.value(node, 'body');
  const paragraphs = naturalParagraphs(body);
  const compact = c.profile.type === 'regulation';
  const [bodyOpen, setBodyOpen] = useState<boolean>();
  const selected = c.selection.length === 1 && c.selection[0] === node.id;
  const expanded = compact ? (bodyOpen ?? (selected && !node.collapsed)) : !node.collapsed;
  const showParagraphs = !!paragraphs.length && expanded && c.outlineEditing !== node.id;
  const rowState = c.nodeStatus(node.id, 'heading');
  const bodyToggle = compact && !!paragraphs.length && c.outlineEditing !== node.id && (
    <button
      className={node.children.length ? 'mw-body-toggle' : 'mw-fold'}
      aria-label={c.t(expanded ? 'collapseBody' : 'expandBody')}
      title={c.t(expanded ? 'collapseBody' : 'expandBody')}
      aria-expanded={expanded}
      onClick={(e) => {
        e.stopPropagation();
        setBodyOpen(!expanded);
      }}
    >
      {node.children.length ? c.t('body') : <Icon name="right" />}
    </button>
  );
  const details = (showParagraphs ||
    c.outlineEditing === node.id ||
    c.nodeStatus(node.id) === 'conflict') && (
    <>
      {showParagraphs && (
        <div className="mw-paragraphs">
          {paragraphs.map((p) => {
            const label = c.t('paragraphNumber').replace('{n}', String(p.ordinal));
            const pending = !rowState && c.nodeStatus(node.id, p.ordinal) === 'pending';
            return (
              <p
                key={p.ordinal}
                tabIndex={0}
                aria-label={[label, pending && c.t('reviewState'), p.text]
                  .filter(Boolean)
                  .join(' ')}
                data-state={pending ? 'pending' : undefined}
                data-node-id={node.id}
                data-body-ordinal={c.profile.legacy ? undefined : p.ordinal}
                data-reading-body="true"
              >
                <span className="mw-paragraph-ordinal" aria-hidden="true">
                  {label}
                </span>
                <span>{p.text}</span>
                {pending && <StateBadges editor={c} node={node} part={p.ordinal} />}
              </p>
            );
          })}
        </div>
      )}
      {c.nodeStatus(node.id) === 'conflict' && (
        <p className="mw-conflict-hint">{c.t('conflictRowHint')}</p>
      )}
      {c.outlineEditing === node.id && <BodyNoteFields editor={c} node={node} />}
    </>
  );
  const row = (
    <article
      className="mw-block"
      {...c.nodeProps(node)}
      role="treeitem"
      aria-selected={c.selection.includes(node.id)}
      aria-level={depth + 1}
      data-reading-body={(!!paragraphs.length && !showParagraphs) || undefined}
      data-depth={Math.min(depth, 3)}
    >
      <div
        className="mw-outline-row"
        style={
          {
            '--mw-indent':
              Math.max(
                0,
                Math.min(depth - styleTokens.outline.indentStart, styleTokens.outline.maxIndent),
              ) *
                styleTokens.space.medium +
              'px',
          } as React.CSSProperties
        }
      >
        {(node.children.length > 0 || (!compact && paragraphs.length > 0)) && (
          <FoldButton editor={c} node={node} hasBody={!!paragraphs.length} />
        )}
        {!node.children.length && bodyToggle}
        <NodeTitle editor={c} node={node} />
        <StateBadges editor={c} node={node} part="heading" />
        {!showParagraphs && !!body.trim() && (
          <span className="mw-outline-summary" title={body}>
            {firstSentence(body, c.value(node, 'title'))}
          </span>
        )}
        {!!node.collapsed && node.children.length > 0 && (
          <small className="mw-paragraph-count">
            {childCountLabel(node.children, c.numbers, c.language)}
          </small>
        )}
        {!!node.children.length && bodyToggle}
        {c.outlineEditing === node.id && (
          <button
            aria-label={c.t('collapseEditor')}
            onClick={(e) => {
              e.stopPropagation();
              c.setOutlineEditing(undefined);
            }}
          >
            <Icon name="close" />
          </button>
        )}
        {selected && !c.newHeading && (
          <AddNodeButton
            editor={c}
            node={node}
            child={depth === 0 || (depth === 1 && node.kind !== 'preamble')}
          />
        )}
        {c.selection.includes(node.id) && (
          <span className="mw-selection-check" aria-hidden="true">
            <Icon name="check" />
          </span>
        )}
      </div>
      {depth !== 1 && details}
    </article>
  );
  // The chapter header stays pinned while its own paragraphs and its children scroll.
  if (depth === 1 && details)
    return (
      <>
        {row}
        <div className="mw-chapter-body" {...c.nodeInteraction(node)}>
          {details}
        </div>
      </>
    );
  return row;
}
function OutlineBranch({ editor: c, node, depth }: WithEditor & { node: MindNode; depth: number }) {
  const closed = !!node.collapsed;
  const [retain, setRetain] = useState(!closed);
  useLayoutEffect(() => {
    if (!node.children.length) return;
    if (!closed) {
      setRetain(true);
      return;
    }
    if (!retain) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRetain(false);
      return;
    }
    // Also release on interrupted transitions (e.g. switching motion preference).
    const timer = setTimeout(() => setRetain(false), 200);
    return () => clearTimeout(timer);
  }, [closed, retain, node.children.length]);
  const showRow =
    depth ||
    c.value(node, 'body').trim() ||
    closed ||
    c.selection.includes(node.id) ||
    c.editing === node.id ||
    c.outlineEditing === node.id;
  const branch = (
    <>
      {!!showRow && <OutlineRow editor={c} node={node} depth={depth} />}
      {!!node.children.length && (
        <div
          className="mw-fold-group"
          role="group"
          aria-hidden={closed}
          data-children-of={node.id}
          ref={(el) => {
            if (el) el.inert = closed;
          }}
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && e.propertyName === 'grid-template-rows' && closed)
              setRetain(false);
          }}
        >
          <div className="mw-fold-clip">
            {(!closed || retain) &&
              node.children.map((child) => (
                <OutlineBranch key={child.id} editor={c} node={child} depth={depth + 1} />
              ))}
          </div>
        </div>
      )}
    </>
  );
  return depth === 1 ? <div className="mw-chapter-section">{branch}</div> : branch;
}
export function OutlineView({ editor: c }: WithEditor) {
  const motionLayer = useListMotion(c.navigation.outline, c.snapshot?.root);
  const root = c.visible[0]?.node;
  return (
    <>
      <div
        className="mw-outline"
        ref={c.navigation.outline}
        onScroll={c.navigation.onScroll}
        role="tree"
        aria-multiselectable="true"
      >
        {root && <OutlineBranch key={documentKey(c.snapshot)} editor={c} node={root} depth={0} />}
        <div className="mw-motion-layer" ref={motionLayer} aria-hidden="true" />
      </div>
      <div className="mw-new-chapter-band">
        <button
          type="button"
          className="mw-new-chapter"
          disabled={c.locked || c.busy || !!c.recovery}
          onClick={() => void c.perform(() => c.add(true, c.snapshot?.root, true))}
        >
          <Icon name="plus" /> {c.t('newChapter')}
        </button>
      </div>
    </>
  );
}
