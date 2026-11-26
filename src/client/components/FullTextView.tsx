import { breakpoints, printLayout, styleTokens } from '../../style-tokens.ts';
import { margins } from '../../document-profile.ts';
import React, { useMemo, useEffect, useLayoutEffect, useState, useRef } from 'react';
import { InlineEditor } from './InlineEditor.tsx';
import { numberedTitles } from '../../numbering.ts';
import { flatten, type MindNode } from '../../model.ts';
import { ancestors } from '../navigation.ts';
import {
  projectPaper,
  markPaper,
  type PreviewParagraph,
  type PaperDiffCache,
} from '../paper-projection.ts';
import { paperRun } from '../paper-run.ts';
import { usePageLayout } from '../hooks/usePageLayout.ts';
import type { useBlockQuotes } from '../hooks/useBlockQuotes.ts';
import { composing } from '../keyboard.ts';
import { Icon } from './Icon.tsx';
import { type WithEditor } from './toolbar.tsx';
function ParagraphHint({ value }: { value: string }) {
  const hint = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const chip = hint.current,
      paragraph = chip?.parentElement;
    if (!chip || !paragraph || !paragraph.closest('.mw-paper')) return;
    const ink = document.createRange();
    ink.selectNodeContents(paragraph);
    ink.setEndBefore(chip);
    const position = () => {
      chip.dataset.fits = '';
      const box = chip.getBoundingClientRect();
      if (
        Array.from(ink.getClientRects()).some(
          (line) =>
            line.left < box.right &&
            line.right > box.left &&
            line.top < box.bottom &&
            line.bottom > box.top,
        )
      )
        delete chip.dataset.fits;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(paragraph);
    return () => observer.disconnect();
  }, [value]);
  return <span ref={hint} className="mw-quote-hint" aria-hidden="true" data-hint={value} />;
}

type PaperInteraction = React.HTMLAttributes<HTMLParagraphElement> & {
  'data-quote-hint': string;
  'data-state'?: string;
};
function PageParagraph({
  paragraph: p,
  interaction,
  editor: c,
}: WithEditor & { paragraph: PreviewParagraph; interaction?: PaperInteraction }) {
  const [hover, setHover] = useState(false),
    [focus, setFocus] = useState(false);
  const hovered = !!interaction && (hover || focus);
  const place = p.review,
    versions = p.versions ?? [];
  const ink = p.spans.map((span, i) => {
    const { tag, attrs } = paperRun(span);
    return tag ? React.createElement(tag, { key: i, ...attrs }, span.text) : span.text;
  });
  const tools = versions.length > 1;
  return (
    <p
      data-node-id={p.id}
      data-paragraph={p.paragraph}
      data-reading-body={!!p.bodyOrdinal || undefined}
      {...interaction}
      data-hovered={interaction ? hovered : undefined}
      onPointerEnter={interaction ? () => setHover(true) : undefined}
      onPointerLeave={interaction ? () => setHover(false) : undefined}
      onFocus={interaction ? () => setFocus(true) : undefined}
      onBlur={interaction ? () => setFocus(false) : undefined}
      data-review-key={place?.item.key}
      data-kind={p.kind}
      data-depth={p.depth}
      data-indent={p.indent}
      data-centered={p.centered}
      data-deleted={p.deleted || undefined}
      data-joins-next={p.joinsNext || undefined}
    >
      {(p.badge || tools) && (
        <span className="mw-paper-caption">
          {p.badge && (
            <span className="mw-paper-badge" data-conflict={!!place?.item.reason}>
              {c.t(p.badge)}
            </span>
          )}
          {tools && (
            <span className="mw-paper-versions">
              {c.t('paperVersions').replace('{n}', String(versions.length))}
              {([-1, 1] as const).map((step) => (
                <button
                  key={step}
                  tabIndex={interaction ? 0 : -1}
                  aria-label={c.t(step < 0 ? 'previousVersion' : 'nextVersion')}
                  onClick={(e) => {
                    e.stopPropagation();
                    c.review.select(
                      versions[
                        (versions.indexOf(place!.item) + step + versions.length) % versions.length
                      ].key,
                    );
                  }}
                >
                  {step < 0 ? '‹' : '›'}
                </button>
              ))}
            </span>
          )}
        </span>
      )}
      {place ? (
        <span className="mw-paper-ink">
          {ink}
          {p.deleted && <span className="mw-deleted-word">{c.t('deletedPaperText')}</span>}
        </span>
      ) : (
        ink
      )}
      {hovered && interaction && <ParagraphHint value={interaction['data-quote-hint']} />}
    </p>
  );
}
const emptyPaper: PreviewParagraph[] = [];
const quoteKey = (id: string, paragraph?: number) => JSON.stringify([id, paragraph]);
type QuoteProps = WithEditor & { quotes: ReturnType<typeof useBlockQuotes> };
export function FullTextView({ editor: c, quotes }: QuoteProps) {
  const pointerStart = useRef<{ x: number; y: number }>();
  const live = useRef({ c, quotes });
  live.current = { c, quotes };
  const quoted = new Set(
    quotes.quotes.filter((q) => !q.reviewBatch).map((q) => quoteKey(q.nodeId, q.paragraph)),
  );
  const stale = new Set(
    quotes.quotes
      .filter((q) => !q.reviewBatch && q.stale)
      .map((q) => quoteKey(q.nodeId, q.paragraph)),
  );
  const stops = new Set<string>();
  function interact(p: PreviewParagraph, fragment: string) {
    const id = p.id;
    const paragraph = c.profile.legacy ? undefined : p.bodyOrdinal;
    const place = p.review;
    const key = place?.item.key ?? quoteKey(id, paragraph);
    const stop = place?.item.key ?? quoteKey(id, p.bodyOrdinal);
    const first = !stops.has(stop);
    stops.add(stop);
    const active = !place && quoted.has(key);
    const hint = c.t(
      place
        ? 'pendingPaperHint'
        : stale.has(key)
          ? 'refreshQuoteHint'
          : active
            ? 'unquoteHint'
            : 'quoteHint',
    );
    const savedState = c.nodeStatus(id, p.bodyOrdinal ?? 'heading');
    const state = place
      ? place.item.reason
        ? 'conflict'
        : 'pending'
      : savedState === 'pending'
        ? undefined
        : savedState;
    function activate() {
      const { c, quotes } = live.current;
      if (place) return c.activatePaperSuggestion(place.item.key);
      c.navigation.markReading(id);
      void c.perform(() => quotes.add(id, undefined, paragraph));
    }
    return {
      'data-fragment': fragment,
      'data-body-ordinal': place ? undefined : paragraph,
      'data-paste-after': place ? undefined : (p.bodyOrdinal ?? 0),
      role: 'button',
      tabIndex: first ? 0 : -1,
      'aria-label': `${c.labels.get(id) ?? place?.item.entry.title ?? id}${paragraph ? ' · ' + c.t('paragraphNumber').replace('{n}', String(paragraph)) : ''}${state === 'pending' ? ' · ' + c.t('reviewState') : ''} · ${hint}`,
      'aria-pressed': place ? undefined : active,
      title: place ? hint : undefined,
      'data-quote-hint': hint,
      'data-quoted': active,
      'data-state': state,
      onPointerDown: (e: React.PointerEvent) => {
        pointerStart.current = { x: e.clientX, y: e.clientY };
      },
      onClick: (e: React.MouseEvent) => {
        const start = pointerStart.current;
        pointerStart.current = undefined;
        if (
          (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) ||
          window.getSelection()?.isCollapsed === false
        )
          return;
        activate();
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (composing(e.nativeEvent) || (e.target as HTMLElement | undefined)?.closest?.('button'))
          return;
        if (e.key === 'F2') {
          e.preventDefault();
          e.stopPropagation();
          if (place) return;
          const { c } = live.current;
          const node = c.rows.find((row) => row.node.id === id)?.node;
          if (node) c.beginInlineEdit(node, fragment);
          return;
        }
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) {
          activate();
        }
      },
    };
  }
  const cache = useMemo<PaperDiffCache>(() => new Map(), [c.snapshot?.token]);
  const work = useMemo(() => {
    if (!c.snapshot) return;
    const plan = projectPaper(
      c.snapshot.root,
      c.profile,
      c.articleTitle,
      c.review.displayed,
      c.paperMode,
    );
    const iterator = markPaper(plan, cache);
    const initial = iterator.next();
    return { iterator, initial };
  }, [
    c.snapshot?.root,
    c.scheme,
    c.articleTitle,
    c.profile.type,
    c.profile.matchPosition,
    c.profile.prefixes,
    c.review.displayed,
    c.paperMode,
    cache,
  ]);
  const [finished, setFinished] = useState<{ work: typeof work; paragraphs: PreviewParagraph[] }>();
  useEffect(() => {
    if (!work || work.initial.done) return;
    let timer: ReturnType<typeof setTimeout>;
    const run = () => {
      const batch = work.iterator.next();
      if (batch.done) setFinished({ work, paragraphs: batch.value });
      else timer = setTimeout(run, 0);
    };
    timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }, [work]);
  const paragraphs = work?.initial.done
    ? work.initial.value
    : finished && finished.work === work
      ? finished.paragraphs
      : emptyPaper;
  const visibleNodes = useMemo(
    () => new Map(c.visible.map((r) => [r.node.id, r.node])),
    [c.visible],
  );
  const current = c.review.current;
  const reveal =
    current &&
    (!visibleNodes.has(current.entry.id) ||
      (current.entry.field === 'children' && visibleNodes.get(current.entry.id)?.collapsed))
      ? current.entry.id
      : undefined;
  const revealChildren = !!reveal && current?.entry.field === 'children';
  const visibleParagraphs = useMemo(() => {
    let nodes = visibleNodes;
    if (reveal && c.navigation.projected) {
      const path = ancestors(c.navigation.projected, reveal);
      const opened = new Set((revealChildren ? path : path.slice(0, -1)).map((n) => n.id));
      const visit = (n: MindNode): MindNode =>
        opened.has(n.id) ? { ...n, collapsed: false, children: n.children.map(visit) } : n;
      nodes = new Map(flatten(visit(c.navigation.projected), true).map((r) => [r.node.id, r.node]));
    }
    return paragraphs.filter((p) =>
      p.owner ? nodes.has(p.owner) && !nodes.get(p.owner)!.collapsed : nodes.has(p.id),
    );
  }, [paragraphs, visibleNodes, reveal, revealChildren, c.navigation.projected]);
  const reflow = c.navigation.editorWidth < breakpoints.panel;
  const layout = usePageLayout(visibleParagraphs, c.fontSize, !reflow, c.pageStyle);
  const { left, right, top, bottom, footer } = margins[c.pageStyle];
  const font = {
    '--mw-print-size': `${c.pageStyle === 'standard' ? printLayout.standard.bodyPt : c.fontSize}pt`,
    '--mw-print-right': `${right}mm`,
    '--mw-print-padding': `${top}mm ${right}mm ${bottom}mm ${left}mm`,
    '--mw-measure-width': `${printLayout.widthMm - left - right}mm`,
    '--mw-footer-bottom': `${footer}mm`,
  } as React.CSSProperties;
  useLayoutEffect(() => {
    c.navigation.previewReady();
  }, [
    visibleParagraphs,
    layout.pages,
    layout.scale,
    reflow,
    c.navigation.editorWidth,
    c.navigation.editorHeight,
  ]);
  const number = useMemo(
    () =>
      c.inlineEdit && c.snapshot
        ? numberedTitles(c.snapshot.root, c.profile).get(c.inlineEdit.id)
        : undefined,
    [c.inlineEdit?.id, c.snapshot?.root, c.scheme, c.profile.matchPosition, c.profile.prefixes],
  );
  let placed = false;
  const pages =
    reflow || (c.inlineEdit && !layout.pages.length) ? [visibleParagraphs] : layout.pages;
  const anchor = c.inlineEdit?.fragment;
  const hasAnchor =
    anchor &&
    pages.some((pp, page) =>
      pp.some((p, i) => p.id === c.inlineEdit?.id && anchor === page + '/' + i),
    );
  function render(p: PreviewParagraph, i: number, page: number) {
    const fragment = page + '/' + i;
    if (!placed && !p.review && p.id === c.inlineEdit?.id && (!hasAnchor || anchor === fragment)) {
      placed = true;
      return (
        <div className="mw-paper-edit" data-node-id={p.id} data-kind={p.kind} key={p.id}>
          <InlineEditor editor={c} heading={number} />
        </div>
      );
    }
    const interaction = interact(p, fragment);
    return <PageParagraph key={i} paragraph={p} interaction={interaction} editor={c} />;
  }
  // Navigation to an ordinary pending item changes only its fragments' selected state.
  // All handlers on retained pages read the current editor/quote controller through live.
  const quoteState = JSON.stringify(quotes.quotes.map((q) => [q.nodeId, q.paragraph, q.stale]));
  const painted = useMemo(
    () => pages.map((pp, page) => pp.map((p, i) => render(p, i, page))),
    [
      visibleParagraphs,
      layout.pages,
      reflow,
      quoteState,
      c.inlineEdit,
      c.language,
      c.labels,
      c.locked,
      c.activeIds,
      c.nodeStatusKey,
      c.conflicts,
    ],
  );
  const templates = useMemo(
    () => visibleParagraphs.map((p, i) => <PageParagraph key={i} paragraph={p} editor={c} />),
    [visibleParagraphs, c.language],
  );
  useLayoutEffect(() => {
    const port = layout.viewport.current;
    if (!port || !current) return;
    const parts = Array.from(
      port.querySelectorAll<HTMLElement>('article p[data-review-key]'),
    ).filter((p) => p.dataset.reviewKey === current.key);
    parts.forEach((p) => p.setAttribute('aria-current', 'true'));
    if (c.review.locate && !c.inlineEdit) {
      const box = port.getBoundingClientRect();
      let anchor: HTMLElement | undefined = parts[0];
      if (!anchor && (current.entry.field === 'note' || current.reason)) {
        const paper = Array.from(port.querySelectorAll<HTMLElement>('article p[data-node-id]'));
        anchor = paper.find((p) => p.dataset.nodeId === current.entry.id);
        const last = paper.at(-1);
        // Folding the previous item's path may leave the viewport in the navigation end padding.
        if (!anchor && last && last.getBoundingClientRect().bottom <= box.top) anchor = last;
      }
      if (anchor) {
        const top = anchor.getBoundingClientRect().top;
        if (top < box.top || top >= box.bottom)
          port.scrollTop += top - box.top - port.clientHeight * 0.12;
      }
    }
    return () => parts.forEach((p) => p.removeAttribute('aria-current'));
  }, [
    current?.key,
    c.review.locate,
    layout.pages,
    visibleParagraphs,
    reflow,
    layout.scale,
    c.drawer,
  ]);
  if (!c.snapshot) return null;
  return (
    <>
      <small className="mw-quote-usage" data-reviewing={!!current}>
        {c.t(current ? 'paperQuoteUsage' : 'previewQuoteUsage')}
      </small>
      {work && !work.initial.done && finished?.work !== work && (
        <small role="status">{c.t('layingOutReview')}</small>
      )}
      <div
        className="mw-preview"
        data-layout={c.pageStyle}
        data-editing={!!c.inlineEdit}
        aria-label={c.t('exportTitle')}
        onScroll={c.navigation.onScroll}
        ref={(element) => {
          (layout.viewport as React.MutableRefObject<HTMLDivElement | null>).current = element;
          c.navigation.preview.current = element;
        }}
      >
        {reflow ? (
          <article
            className="mw-reflow"
            style={{
              fontSize:
                c.pageStyle === 'official' && c.fontSize === printLayout.official.bodyPt
                  ? styleTokens.type.doc.size
                  : styleTokens.type.chapter.size,
            }}
          >
            {painted[0]}
          </article>
        ) : (
          <>
            <div
              className="mw-paper mw-measure"
              ref={layout.measurement}
              aria-hidden="true"
              {...{ inert: '' }}
              style={font}
            >
              {templates}
            </div>
            {pages.map((paragraphs, page) => (
              <article
                className="mw-paper"
                key={page}
                style={{ ...font, zoom: layout.scale }}
                aria-label={`${c.t('pageNumber')} ${page + 1}`}
              >
                {painted[page]}
                <footer className="mw-paper-footer">
                  {c.pageStyle === 'standard' ? page + 1 : `— ${page + 1} —`}
                </footer>
              </article>
            ))}
          </>
        )}
      </div>
    </>
  );
}

export function QuoteFeedback({ editor: c, quotes }: QuoteProps) {
  const fallbackLine = quotes.fallback && '> ' + quotes.fallback.text;
  const quoted = new Set(quotes.quotes.map((q) => q.code));
  return (
    <>
      {fallbackLine && (
        <div className="mw-quote-fallback">
          <label>
            {c.t('copyQuoteHint')}
            <input readOnly value={fallbackLine} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <button
            onClick={async (e) => {
              const field = e.currentTarget.parentElement?.querySelector('input');
              try {
                await navigator.clipboard.writeText(fallbackLine);
                c.setNotice(c.t('copied'));
              } catch {
                field?.focus();
                field?.select();
              }
            }}
          >
            {c.t('copyQuote')}
          </button>
          <button aria-label={c.t('close')} onClick={() => quotes.setFallback(undefined)}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {c.view === 'preview' && quoted.size > 0 && (
        <div className="mw-quote-bar">
          <span role="status">{c.t('quoteCount').replace('{n}', String(quoted.size))}</span>
          {quotes.canClear ? (
            <button onClick={quotes.clear}>{c.t('clearQuotes')}</button>
          ) : (
            <small>{c.t('clearQuoteHint')}</small>
          )}
        </div>
      )}
    </>
  );
}
