import { useReviewDrafts } from '../hooks/useReviewDrafts.ts';
import { breakpoints } from '../../style-tokens.ts';
import React, { useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { paragraphSelection } from '../../paragraphs.ts';
import { stripNumber } from '../../numbering.ts';
import { composing } from '../keyboard.ts';
import { isResearchType } from '../../document-profile.ts';
import {
  editSummary,
  reviewDiff,
  sourceChecks,
  type DiffSpan,
  type ResearchText,
} from '../../review-diff.ts';
import {
  proposalValue,
  reviewKey,
  type RevisionPin,
  outlineText,
  type ReviewedSuggestion,
  type SuggestionEdit,
} from '../../suggestions.ts';
import type { AppliedChangeBatch } from '../types.ts';
import type { NodeInput } from '../../model.ts';
import { ActionButton, type WithEditor } from './toolbar.tsx';
import { Icon } from './Icon.tsx';

function DiffText({ spans, editor: c }: WithEditor & { spans: DiffSpan[] }) {
  return (
    <pre>
      {spans.map((span, i) => {
        const Tag = span.kind === 'same' ? 'span' : span.kind === 'added' ? 'ins' : 'del';
        return (
          <Tag
            key={i}
            data-critical={span.critical}
            data-change={span.kind}
            data-long-term={(!!span.term && span.text.length > 16) || undefined}
            data-term={span.term && c.t(span.term === 'number' ? 'numberTerm' : span.term)}
          >
            {span.text}
          </Tag>
        );
      })}
    </pre>
  );
}
function TreeEdit({
  editor: c,
  nodes,
  onChange,
  disabled,
  readOnly,
}: WithEditor & {
  readOnly?: boolean;
  nodes: NodeInput[];
  onChange: (next: NodeInput[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="mw-tree-edit">
      {nodes.map((node, i) => {
        const update = (patch: Partial<NodeInput>) =>
          onChange(nodes.map((n, j) => (i === j ? { ...n, ...patch } : n)));
        return (
          <fieldset key={i}>
            {(['title', 'body', 'note'] as const).map((field) => (
              <label key={field}>
                {c.t(field === 'title' ? 'nodeTitle' : field)}
                <textarea
                  disabled={disabled}
                  readOnly={readOnly}
                  value={node[field] ?? ''}
                  onChange={(e) => update({ [field]: e.target.value })}
                />
              </label>
            ))}
            {node.children?.length ? (
              <TreeEdit
                editor={c}
                nodes={node.children}
                readOnly={readOnly}
                disabled={disabled}
                onChange={(children) => update({ children })}
              />
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}
function OriginalChildren({
  editor: c,
  entry,
}: WithEditor & { entry: Extract<ReviewedSuggestion, { field: 'children' }> }) {
  const counts = new Map<string | undefined, number>();
  for (const a of entry.additions) counts.set(a.beforeId, (counts.get(a.beforeId) ?? 0) + 1);
  return (
    <ul className="mw-original-children">
      {!entry.originalIds.length && <li>{c.t('noChildren')}</li>}
      {[...entry.originalIds, undefined].map((id) => (
        <React.Fragment key={id ?? 'end'}>
          {counts.has(id) && (
            <li className="mw-insertion">
              {c.t('insertHere').replace('{n}', String(counts.get(id)))}
            </li>
          )}
          {id && <li>{c.labels.get(id) ?? c.t('deletedNode')}</li>}
        </React.Fragment>
      ))}
    </ul>
  );
}
function AddedTree({ editor: c, nodes }: WithEditor & { nodes: NodeInput[] }) {
  return (
    <ul className="mw-added-tree">
      {nodes.map((n, i) => (
        <li key={i}>
          <small>{c.t('addedLabel')}</small> <ins>{n.title}</ins>
          {n.body && <p>{n.body}</p>}
          {n.note && (
            <p>
              {c.t('note')} · {n.note}
            </p>
          )}
          {!!n.children?.length && <AddedTree editor={c} nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}
function compareProposal(
  entry: ReviewedSuggestion,
  edit: SuggestionEdit | undefined,
  invalidRange: boolean,
  research?: ResearchText,
) {
  const proposed = invalidRange ? '' : proposalValue(entry, edit);
  const before =
    invalidRange || entry.field === 'children'
      ? ''
      : entry.field === 'body' && entry.paragraphs
        ? paragraphSelection(entry.before, entry.paragraphs)
        : entry.before;
  const after = typeof proposed === 'string' ? proposed : outlineText(proposed);
  const diff = reviewDiff(before, after, research, entry.field === 'body' && !!entry.paragraphs);
  return {
    proposed,
    before,
    after,
    diff,
    research,
    checks: research ? sourceChecks(diff.merged) : [],
  };
}
function SourceChecks({
  editor: c,
  checks,
  compact,
  handDraft,
}: WithEditor & {
  checks: ReturnType<typeof sourceChecks>;
  compact?: boolean;
  handDraft: boolean;
}) {
  if (!checks.length) return null;
  const label = (v: (typeof checks)[number]) =>
    c
      .t(v.citation ? 'checkSourceCitation' : 'checkSourceValue')
      .replace('{before}', () => v.before || '∅')
      .replace('{after}', () => v.after || '∅');
  const list = (items: typeof checks) => (
    <ul className="mw-key-changes" aria-label={c.t('sourceCheckList')}>
      {items.map((v, i) => (
        <li key={i}>{label(v)}</li>
      ))}
    </ul>
  );
  return (
    <div className="mw-source-checks">
      {handDraft && <small className="mw-legacy-hint">{c.t('checkHandDraft')}</small>}
      {compact && checks.length > 1 ? (
        <details>
          <summary>
            <span>{label(checks[0])}</span>
            <span className="mw-check-count">
              {checks.length}
              <Icon name="down" />
            </span>
          </summary>
          {list(checks.slice(1))}
        </details>
      ) : (
        list(checks)
      )}
    </div>
  );
}
function Proposal({
  editor: c,
  entry,
  location,
  comparison,
  edit,
  setEdit,
  submitting,
  revising,
  staleDraft,
  merged,
}: WithEditor & {
  entry: ReviewedSuggestion;
  location: string;
  comparison: ReturnType<typeof compareProposal>;
  merged: boolean;
  edit?: SuggestionEdit;
  setEdit: (value?: SuggestionEdit) => void;
  submitting: boolean;
  revising: boolean;
  staleDraft: boolean;
}) {
  const reason = c.review.current?.reason;
  const invalidRange = reason === 'invalidReviewRange';
  const { before, after, proposed, diff, research, checks } = comparison;
  const ordinals = entry.field === 'body' ? entry.paragraphs : undefined;
  const row = c.rows.find((r) => r.node.id === entry.id);
  const current = row?.node;

  const title = current?.title.trim() ?? '';
  const body = current?.body.trim() ?? '';
  const legacyTitle =
    entry.field === 'body' &&
    row?.depth === 2 &&
    current?.titleSource !== 'auto' &&
    (/[。.]$/u.test(title) || /[，,；;]/u.test(title)) &&
    (!body ||
      (/^[^。！？.!?\n]+[。！？.!?]?$/u.test(body) && !body.startsWith(stripNumber(title))));
  const empty = entry.field !== 'children' && !entry.before.length;
  const original =
    entry.field === 'children' ? (
      <OriginalChildren editor={c} entry={entry} />
    ) : empty ? (
      <p className="mw-empty-original">{c.t('emptyOriginal')}</p>
    ) : (
      <DiffText editor={c} spans={diff.before} />
    );
  const aiText = useMemo(
    () =>
      invalidRange
        ? ''
        : entry.field === 'children'
          ? outlineText(entry.additions.map((a) => a.node))
          : ordinals
            ? paragraphSelection(entry.after, ordinals)
            : entry.after,
    [entry, invalidRange],
  );
  const summary = useMemo(
    () =>
      edit === undefined ? undefined : editSummary(reviewDiff(aiText, after, research).merged),
    [aiText, after, edit, research],
  );
  const editing = edit !== undefined;
  const editPane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (editing) editPane.current?.querySelector('textarea')?.focus();
  }, [editing]);
  const suggested =
    editing && summary ? (
      <div className="mw-proposal-edit" ref={editPane}>
        <header>
          <strong>{c.t('editingProposal')}</strong>
          <small>{c.t('changedPlaces').replace('{n}', String(summary.count))}</small>
        </header>
        {staleDraft && (
          <div role="status">
            <p>{c.t('handDraftChanged')}</p>
            <details open>
              <summary>{c.t('afterAi')}</summary>
              <pre>{aiText}</pre>
            </details>
          </div>
        )}
        {typeof edit === 'string' ? (
          <textarea
            autoFocus
            rows={2}
            aria-label={c.t('editSuggestion')}
            disabled={submitting}
            readOnly={revising}
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
          />
        ) : (
          <TreeEdit
            editor={c}
            nodes={edit}
            onChange={setEdit}
            disabled={submitting}
            readOnly={revising}
          />
        )}
        {summary.terms.length > 0 && (
          <ul className="mw-key-changes">
            {summary.terms.map((v, i) => (
              <li key={i}>
                {c.t(v.term === 'number' ? 'numberTerm' : v.term)}{' '}
                {[v.before || '∅', v.after || '∅'].join(' → ')}
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : Array.isArray(proposed) ? (
      <AddedTree editor={c} nodes={proposed} />
    ) : (
      <DiffText editor={c} spans={diff.after} />
    );
  return (
    <>
      {reason && (
        <div className="mw-review-warning" role="alert">
          <strong>{c.t(reason)}</strong>
          {current && entry.field !== 'children' && !current[entry.field] && (
            <span>{c.t('emptyCurrent')}</span>
          )}
        </div>
      )}
      <div className="mw-drawer-content">
        <article className="mw-node-diff" data-review-node={entry.id}>
          <h3 className="mw-sr-only">
            {location} {empty && <small>{c.t('newText')}</small>}
          </h3>
          <div className="mw-review-context">
            {empty && <small>{c.t('newText')}</small>}
            {ordinals && <p className="mw-paragraph-scope">{c.t('paragraphScope')}</p>}
            {legacyTitle && !ordinals && (
              <p className="mw-legacy-hint">{c.t('legacyImportHint')}</p>
            )}
            <div className="mw-diff-legend" aria-hidden="true">
              <del>{c.t('removedText')}</del>
              <ins>{c.t('insertedText')}</ins>
              <mark>{c.t('keyTerm')}</mark>
            </div>
          </div>
          <SourceChecks editor={c} checks={checks} handDraft={editing} />
          {merged ? (
            <div className="mw-diff-merged" aria-label={c.t('inlineDiff')}>
              {editing ? (
                <>
                  <details className="mw-original-summary">
                    <summary>
                      {c.t('beforeAi')} ·{' '}
                      {before.slice(0, 48) ||
                        c.t(entry.field === 'children' ? 'menuChild' : 'newText')}
                    </summary>
                    {original}
                  </details>
                  {suggested}
                </>
              ) : (
                <>
                  {(empty || entry.field === 'children') && original}
                  {entry.field === 'children' ? (
                    suggested
                  ) : (
                    <DiffText editor={c} spans={diff.merged} />
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="mw-diff-columns">
              <div>
                <strong>{c.t('beforeAi')}</strong>
                {original}
              </div>
              <div>
                {!editing && <strong>{c.t('afterAi')}</strong>}
                {suggested}
              </div>
            </div>
          )}
          {editing && (
            <details className="mw-live-diff">
              <summary>{c.t('liveDiff')}</summary>
              <DiffText editor={c} spans={diff.merged} />
            </details>
          )}
          {entry.field !== 'children' &&
            !ordinals &&
            current &&
            (current[entry.field] ?? '') !== entry.before && (
              <p>
                {c.t('currentVersion')} · {current[entry.field]}
              </p>
            )}
        </article>
      </div>
    </>
  );
}
function AppliedHistory({ editor: c }: WithEditor) {
  const [batches, setBatches] = useState<AppliedChangeBatch[]>();
  useEffect(() => {
    let alive = true;
    void c.perform(async () => {
      const history = await c.call<AppliedChangeBatch[]>('ai-history');
      if (alive) setBatches(history);
    });
    return () => {
      alive = false;
    };
  }, [c.call, c.snapshot?.token]);
  return (
    <aside className="mw-drawer mw-ai-review">
      <div className="mw-drawer-heading">
        <strong>{c.t('aiReviewHistory')}</strong>
        <button aria-label={c.t('close')} onClick={() => c.openDrawer(null)}>
          <Icon name="close" />
        </button>
      </div>
      <div className="mw-drawer-content">
        {!!c.aiReviewCount && (
          <button onClick={() => c.openDrawer('ai-review')}>
            {c.t('reviewState')} · {c.aiReviewCount}
          </button>
        )}
        {batches?.length === 0 && <p>{c.t('noAdoptions')}</p>}
        {batches?.map((b) => (
          <section key={b.id}>
            <small>{new Date(b.time).toLocaleString()}</small>
            {b.changes.map((n) => (
              <details key={n.id}>
                <summary>{n.title}</summary>
                {n.fields.map((f) => (
                  <div key={f.field}>
                    <strong>{c.t(f.field === 'title' ? 'nodeTitle' : f.field)}</strong>
                    <DiffText editor={c} spans={reviewDiff(f.before, f.after).merged} />
                  </div>
                ))}
              </details>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
export function AiReview({
  editor: c,
  addReview,
}: WithEditor & { addReview?: (pin: RevisionPin) => Promise<void> }) {
  const hand = useReviewDrafts(c);
  const [choosing, setChoosing] = useState<{ key: string; digest: string }>();

  const [submittingKey, setSubmittingKey] = useState<string>();
  const { current, items, select } = c.review;
  const batch = current?.batch,
    entry = current?.entry;

  const [emptyLayout, setEmptyLayout] = useState<{ key: string; merged: boolean }>();
  const entryKey = current?.key ?? '';
  const draft = hand.drafts.get(entryKey);
  const edit = draft?.value;
  const revising = c.revising.includes(entryKey);
  const submitting = submittingKey === entryKey;
  function setEdit(value?: SuggestionEdit) {
    if (!submitting && !revising && batch && entry) void hand.change(batch.id, entry, value);
  }
  async function quote(discard = false) {
    if (!batch || !entry || !addReview) return;
    const saved = discard
      ? await hand.change(batch.id, entry, undefined)
      : await hand.saved(batch.id, entry.id);
    await addReview({
      batchId: batch.id,
      id: entry.id,
      digest: entry.digest,
      draftStamp: saved?.stamp,
    });
  }
  useEffect(() => {
    const request = c.reviewRequest;
    if (!request) return;
    c.setReviewRequest(undefined);
    if (!current || current.key !== request.key || current.entry.digest !== request.digest) return;
    if (edit !== undefined) {
      setChoosing(request);
      c.openDrawer('ai-review');
    } else void c.perform(() => quote());
  }, [c.reviewRequest]);
  const choosingHere = choosing?.key === entryKey && choosing.digest === entry?.digest;
  const empty = entry && entry.field !== 'children' && !entry.before.length;
  const layoutKey = 'mindwrite:review-layout:' + JSON.stringify([c.snapshot?.path, c.snapshot?.id]);
  const [preference, setPreference] = useState<{ key: string; merged: boolean }>();
  let preferred = preference?.key === layoutKey ? preference.merged : undefined;
  if (preferred === undefined) {
    try {
      preferred =
        (localStorage.getItem(layoutKey) ??
          localStorage.getItem('mindwrite:review-layout:' + c.snapshot?.id)) !== 'columns';
    } catch {
      preferred = true;
    }
  }
  if (empty) preferred = emptyLayout?.key === entryKey ? emptyLayout.merged : true;
  const narrow = c.navigation.editorWidth < breakpoints.narrow;
  function switchLayout() {
    if (empty) {
      setEmptyLayout({ key: entryKey, merged: !preferred });
      return;
    }
    setPreference({ key: layoutKey, merged: !preferred });
    try {
      localStorage.setItem(layoutKey, preferred ? 'columns' : 'inline');
    } catch {
      /* Keep the session preference. */
    }
  }
  const paper = c.view === 'preview';
  const bar = paper && !c.drawer && !!current;
  const showLocations = !!entry && (bar || c.drawer === 'ai-review');
  const chapterPaths = useMemo(() => {
    const paths = new Map<string, string>();
    if (!showLocations) return paths;
    const counts = new Map<string, number>();
    for (const { node } of c.rows) {
      const label = c.labels.get(node.id)!;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    // The full manuscript rows are in document order, including collapsed chapters.
    let chapter = '';
    for (const { node, depth } of c.rows) {
      const label = c.labels.get(node.id)!;
      if (depth === 1) chapter = label;
      else if (depth > 1 && chapter && counts.get(label)! > 1)
        paths.set(node.id, chapter + ' › ' + label);
    }
    return paths;
  }, [showLocations, c.rows, c.labels]);
  function reviewLocation(item: ReviewedSuggestion) {
    const heading = chapterPaths.get(item.id) ?? c.labels.get(item.id) ?? item.title;
    return item.field === 'body' && item.paragraphs
      ? [
          heading,
          ...item.paragraphs.map((n) => c.t('paragraphNumber').replace('{n}', String(n))),
        ].join(' · ')
      : heading;
  }
  const research =
    entry && isResearchType(c.profile.type)
      ? entry.field === 'title'
        ? 'title'
        : 'body'
      : undefined;
  const compare = (c.drawer === 'ai-review' && (!c.locked || revising)) || (bar && !!research);
  const invalidRange = current?.reason === 'invalidReviewRange';
  const comparison = useMemo(
    () => (entry && compare ? compareProposal(entry, edit, invalidRange, research) : undefined),
    [entry, compare, edit, invalidRange, research],
  );
  if (c.drawer === 'ai-history') return <AppliedHistory editor={c} />;
  if (!bar && c.drawer !== 'ai-review') return null;
  async function adoptEdit() {
    if (submittingKey || !batch || !entry || edit === undefined) return;
    setSubmittingKey(entryKey);
    try {
      const saved = hand.saved(batch.id, entry.id);
      if (saved instanceof Promise) await saved;
      await c.decideAi(batch.id, [entry], true, edit);
    } finally {
      setSubmittingKey(undefined);
    }
  }
  const index = current ? items.indexOf(current) : -1;
  const progress = (
    <span aria-live="polite" aria-atomic="true">
      {c
        .t('paperProgress')
        .replace('{n}', String(index + 1))
        .replace('{m}', String(items.length))}
    </span>
  );
  const step = (by: number) => select(items[(index + by + items.length) % items.length].key);
  const openEdit = () => {
    if (!entry) return;
    if (edit === undefined) setEdit(proposalValue(entry));
    if (bar) c.openDrawer('ai-review');
  };
  const editing = !bar && edit !== undefined;
  const reason = current?.reason;
  const buttons = batch && entry && (
    <>
      <ActionButton
        editor={c}
        label={editing ? 'acceptEdited' : 'acceptNode'}
        className="mw-primary"
        disabled={c.locked || revising || !!reason || submitting || (bar && edit !== undefined)}
        action={editing ? adoptEdit : () => c.decideAi(batch.id, [entry], true)}
      />
      {editing ? (
        <button disabled={submitting || revising} onClick={() => setEdit(undefined)}>
          {c.t('abandonEdited')}
        </button>
      ) : (
        <>
          <button disabled={c.busy || c.locked || revising || !!reason} onClick={openEdit}>
            {c.t('editAdopt')}
          </button>
          <ActionButton
            editor={c}
            label="rejectNode"
            disabled={c.locked || revising || (bar && edit !== undefined)}
            action={() => c.decideAi(batch.id, [entry], false)}
          />
        </>
      )}
    </>
  );
  if (bar && current && entry) {
    const chapterPath = chapterPaths.get(entry.id);
    const location = current.reason
      ? [c.t(current.reason), chapterPath].filter(Boolean).join(' · ')
      : entry.field === 'note'
        ? [chapterPath, c.t('paperNote')].filter(Boolean).join(' · ')
        : reviewLocation(entry) +
          (entry.field === 'body' && !entry.paragraphs ? ' · ' + c.t('body') : '');
    return (
      <aside className="mw-ai-review mw-paper-bar" aria-label={c.t('aiReview')}>
        <div className="mw-drawer-footer mw-review-node-actions">
          <div className="mw-paper-decisions">{buttons}</div>
          {comparison && (
            <SourceChecks
              key={entry.id + current.key}
              editor={c}
              checks={comparison.checks}
              compact
              handDraft={edit !== undefined}
            />
          )}
          <div className="mw-paper-nav">
            <strong>{progress}</strong>
            <span aria-hidden="true">·</span>
            <span className="mw-paper-location" title={location}>
              {location}
            </span>
            <button
              disabled={items.length < 2}
              aria-label={c.t('previousProposal')}
              onClick={() => step(-1)}
            >
              <Icon name="left" />
            </button>
            <button
              disabled={items.length < 2}
              aria-label={c.t('nextProposal')}
              onClick={() => step(1)}
            >
              <Icon name="right" />
            </button>
            <span className="mw-paper-modes mw-segments">
              {(['markup', 'effect'] as const).map((m) => (
                <button key={m} aria-pressed={c.paperMode === m} onClick={() => c.setPaperMode(m)}>
                  {c.t(m)}
                </button>
              ))}
            </span>
          </div>
          <button className="mw-paper-expand" onClick={() => c.openDrawer('ai-review')}>
            {c.t('expandReview')}
          </button>
        </div>
      </aside>
    );
  }
  return (
    <aside
      className="mw-drawer mw-ai-review"
      aria-label={c.t('aiReview')}
      data-editing={edit !== undefined}
      onKeyDown={(e) => {
        if (edit === undefined || submitting || revising || composing(e.nativeEvent)) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setEdit(undefined);
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          if (!c.busy && !c.locked && !e.repeat && batch && entry && !reason)
            void c.perform(adoptEdit);
        }
      }}
    >
      <div className="mw-drawer-heading">
        <strong>
          {c.t('aiReview')}
          {batch && !c.locked && <> · {progress}</>}
        </strong>
        {!narrow && batch && !c.locked && (
          <button className="mw-diff-toggle" aria-pressed={preferred} onClick={switchLayout}>
            {c.t(preferred ? 'columnsDiff' : 'inlineDiff')}
          </button>
        )}
        <button
          className={paper ? 'mw-review-collapse' : undefined}
          aria-label={c.t(paper ? 'collapseReview' : 'close')}
          onClick={() => c.openDrawer(null)}
        >
          {paper ? c.t('collapseReview') : <Icon name="close" />}
        </button>
        {batch && entry && !c.locked && (
          <div className="mw-review-picker">
            {c.suggestions.length > 1 && (
              <select
                aria-label={c.language.startsWith('zh') ? '建议批次' : 'Suggestion batch'}
                value={batch.id}
                onChange={(e) => {
                  const b = c.suggestions.find((b) => b.id === e.target.value)!;
                  select(JSON.stringify([b.id, b.entries[0].id]));
                }}
              >
                {c.suggestions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {new Date(b.time).toLocaleString()}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label={c.t('reviewAiChanges')}
              title={reviewLocation(entry)}
              value={entry.id}
              onChange={(e) => select(JSON.stringify([batch.id, e.target.value]))}
            >
              {batch.entries.map((e) => (
                <option value={e.id} key={e.id}>
                  {e.field === 'body' && e.paragraphs
                    ? reviewLocation(e)
                    : [
                        reviewLocation(e),
                        c.t(
                          e.field === 'children'
                            ? 'menuExpand'
                            : e.field === 'title'
                              ? 'nodeTitle'
                              : e.field,
                        ),
                      ].join(' · ')}
                </option>
              ))}
            </select>
            <ActionButton
              editor={c}
              label="acceptAll"
              disabled={
                batch.entries.some(
                  (e) =>
                    hand.drafts.get(reviewKey(batch.id, e.id))?.value !== undefined ||
                    c.revising.includes(reviewKey(batch.id, e.id)) ||
                    c.review.byKey.get(JSON.stringify([batch.id, e.id]))?.reason,
                ) || c.locked
              }
              action={() => c.decideAi(batch.id, batch.entries, true, undefined, true)}
            />
          </div>
        )}
      </div>
      {c.locked && !revising ? (
        <p className="mw-drawer-content" role="status">
          {c.t('generating')}
        </p>
      ) : batch && entry ? (
        <>
          {revising && <p role="status">{c.t('revisingEntry')}</p>}
          {choosingHere && (
            <div className="mw-review-choice" role="group" aria-label={c.t('handDraftChoice')}>
              <p>{c.t('handDraftChoice')}</p>
              <ActionButton
                editor={c}
                label="useHandDraft"
                action={async () => {
                  await quote();
                  setChoosing(undefined);
                }}
              />
              <ActionButton
                editor={c}
                label="discardHandDraft"
                action={async () => {
                  await quote(true);
                  setChoosing(undefined);
                }}
              />
              <button onClick={() => setChoosing(undefined)}>{c.t('cancel')}</button>
            </div>
          )}
          <Proposal
            key={batch.id + entry.id}
            editor={c}
            entry={entry}
            location={reviewLocation(entry)}
            comparison={comparison!}
            merged={narrow || preferred}
            edit={edit}
            setEdit={setEdit}
            submitting={submitting}
            revising={revising}
            staleDraft={edit !== undefined && draft?.digest !== entry.digest}
          />
          <div className="mw-drawer-footer mw-review-node-actions">
            {buttons}
            <button
              disabled={c.locked || revising || c.busy || !!reason || submitting}
              onClick={() => c.activatePaperSuggestion(entryKey)}
            >
              {c.t('continueReview')}
            </button>
            {!editing && batch.entries.length > 1 && (
              <button
                disabled={c.locked}
                onClick={() =>
                  select(
                    JSON.stringify([
                      batch.id,
                      batch.entries[(batch.entries.indexOf(entry) + 1) % batch.entries.length].id,
                    ]),
                  )
                }
              >
                {c.t('nextProposal')}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="mw-drawer-content" role="status">
          {c.t('noAiReviews')}
        </p>
      )}
    </aside>
  );
}
