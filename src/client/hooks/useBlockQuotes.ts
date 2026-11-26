import { hasQuoteMarker } from '../../quotes.ts';
import type { RevisionPin } from '../../suggestions.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { BlockQuote, ResolvedQuote } from '../../quotes.ts';
import { documentKey, type EditorProps } from '../types.ts';
import type { EditorController } from './useEditor.ts';
import {
  clearDraftQuotes,
  collapseToDraftEnd,
  draftQuotes,
  removalRanges,
  startInstructionLine,
  type ComposerDraft,
} from '../quote-draft.ts';

const noInput = () => '';
const selectDraft = (s: InputState) => s.draft;
type QuoteKind = 'reference' | 'quote' | 'review-quote';
type QuoteRequest = {
  original?: string;
  paragraph?: number;
  kind?: QuoteKind;
  pin?: RevisionPin;
  cancelled: boolean;
};
type Targets = ReturnType<typeof draftQuotes>['targets'];

export function useBlockQuotes(c: EditorController, composer: EditorProps) {
  const useDraft = composer.useInput ?? noInput;
  const draft = useDraft(selectDraft);
  const read = () => composer.readComposer?.(composer.sessionId);
  const snapshot = hasQuoteMarker(draft) ? read() : undefined;
  const document = snapshot?.document.text === draft ? snapshot.document : undefined;
  const { targets } = draftQuotes(document ?? { text: draft, references: [] });
  const texts = new Set(targets.map((q) => q.text));
  const signature = [...new Set(targets.map((q) => q.code))].join(',');
  // The native Lexical quote keeps its rendering and remove control. Decorate only atoms
  // whose signed text belongs to a pending card in this composer's semantic snapshot.
  useLayoutEffect(() => {
    if (!draft.includes('〔待审·') || typeof MutationObserver === 'undefined') return;
    const input = globalThis.document.querySelector('[data-composer-input=true]');
    if (!input) return;
    const mark = () => {
      const atoms = read()?.document.quotes ?? [];
      const chips = input.querySelectorAll('[data-composer-quote]');
      if (chips.length === atoms.length)
        chips.forEach((chip, i) =>
          chip.toggleAttribute('data-mw-review-quote', atoms[i].text.includes('〔待审·')),
        );
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(input, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      input
        .querySelectorAll('[data-mw-review-quote]')
        .forEach((chip) => chip.removeAttribute('data-mw-review-quote'));
    };
  }, [draft, composer.sessionId]);
  const [resolved, setResolved] = useState<ResolvedQuote[]>([]);
  const [fallback, setFallback] = useState<BlockQuote>();
  const queue = useRef(Promise.resolve());
  const pending = useRef(new Map<string, QuoteRequest>());
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const token = c.snapshot?.token;
  const owner = documentKey(c.snapshot);
  const generation = c.documentGeneration;
  useLayoutEffect(() => {
    setFallback(undefined);
    setResolved([]);
  }, [owner, token, generation]);
  useEffect(() => {
    if (!signature || !c.snapshot) return;
    let current = true;
    c.call<ResolvedQuote[]>('quote-state', { path: c.snapshot?.path, codes: signature.split(',') })
      .then((result) => {
        if (!current || !c.currentDocument(token)) return;
        setResolved(result);
        const fresh = new Set(result.filter((q) => !q.stale).map((q) => q.code));
        const expired = targets.filter((q) => q.code.length === 32 && !fresh.has(q.code));
        if (
          expired.length &&
          composer.inputActions &&
          read()?.state.draft === draft &&
          clearDraftQuotes(
            read,
            composer.inputActions,
            expired.map((q) => ({ ...q, nodeId: '' })),
          )
        )
          c.setNotice(
            c.t(
              result.some((q) => q.stale === 'deleted')
                ? 'reviewTargetDeleted'
                : 'reviewCardExpired',
            ),
          );
      })
      .catch((e) => {
        if (current && c.currentDocument(token)) c.setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [c.call, signature, owner, token, generation, c.suggestions, c.reviewDrafts]);
  const quotes = resolved.filter((q) => texts.has(q.text));
  const canClear = !!composer.inputActions && !!document;
  async function resolveCurrent(codes: string[]) {
    const current = await c.call<ResolvedQuote[]>('quote-state', {
      path: c.snapshot?.path,
      codes,
    });
    if (!alive.current || !c.currentDocument(token)) return;
    setResolved(current);
    return current;
  }
  function remove(initial: ComposerDraft | undefined, current: ResolvedQuote[], single: boolean) {
    if (
      composer.inputActions &&
      initial &&
      initial.document.text === initial.state.draft &&
      read()?.state.draftRev === initial.state.draftRev &&
      clearDraftQuotes(read, composer.inputActions, current, single ? 'one' : 'all')
    )
      return true;
    c.setNotice(c.t(single ? 'removeQuoteHint' : 'clearQuoteHint'));
    return false;
  }
  function targetsOf(live: ComposerDraft | undefined) {
    return draftQuotes(
      live?.document ?? {
        text: composer.readInput?.(composer.sessionId)?.draft ?? draft,
        references: [],
      },
    ).targets;
  }
  async function update(id: string, request: QuoteRequest, clicked: Targets) {
    const sameTarget = (q: ResolvedQuote) =>
      q.nodeId === id &&
      q.paragraph === request.paragraph &&
      q.reviewBatch === request.pin?.batchId;
    const actions = composer.inputActions;
    const initial = read();
    let current = quotes;
    let checked = new Set<string>();
    let quote: BlockQuote | undefined;
    // Each await can change the composer. Reconcile the clicked node again just before mutating it.
    while (alive.current && c.currentDocument() && !request.cancelled) {
      const live = read();
      const now = targetsOf(live);
      const codes = new Set([...clicked, ...now].map((t) => t.code));
      if (actions && [...codes].some((code) => !checked.has(code))) {
        const result = await resolveCurrent([...codes]);
        if (!result) return;
        current = result;
        checked = codes;
        continue;
      }
      const owned = current.filter((q) => sameTarget(q) && codes.has(q.code));
      const byCode = new Map(owned.map((q) => [q.code, q]));
      const before = clicked.filter((t) => byCode.has(t.code));
      const present = now.filter((t) => byCode.has(t.code));
      // A removed card cancels its replacement. A newly added card already fulfils an insertion.
      if (before.length !== present.length || before.some((t, i) => t.text !== present[i].text))
        return;
      const existing = owned[0];
      if (
        present.some((t) => t.text !== byCode.get(t.code)!.text) ||
        (!existing && quotes.some((q) => sameTarget(q) && clicked.some((t) => t.code === q.code)))
      ) {
        c.setNotice(c.t('removeQuoteHint'));
        return;
      }
      const kind = request.kind ?? (existing?.text.startsWith('? ') ? 'reference' : 'quote');
      const sameKind = (q: ResolvedQuote) => (kind === 'reference') === q.text.startsWith('? ');
      const refresh = owned.some((q) => q.stale);
      if (existing && !refresh && (!request.kind || owned.every(sameKind))) {
        if (!request.pin) remove(initial, [existing], true);
        return;
      }
      if (live && live.document.text !== live.state.draft) {
        c.setNotice(c.t(existing ? 'removeQuoteHint' : 'quoteDraftChanged'));
        return;
      }
      if (existing) {
        const ranges = live && removalRanges(live.document, owned);
        if (
          !actions ||
          !live ||
          live.state.phase !== 'plain' ||
          !ranges?.length ||
          (ranges.length > 1 && removalRanges(live.document, owned, true).length !== ranges.length)
        ) {
          c.setNotice(c.t('removeQuoteHint'));
          return;
        }
        // A restored 0.8.1 draft may already contain cards of both kinds.
        const keep = owned.find((q) => !q.stale && sameKind(q));
        if (keep) {
          if (
            !clearDraftQuotes(
              read,
              actions,
              owned.filter((q) => q !== keep),
            ) ||
            !clearDraftQuotes(read, actions, [keep], 'keep-one')
          )
            c.setNotice(c.t('removeQuoteHint'));
          else {
            setResolved(current.filter((q) => !sameTarget(q) || q.code === keep.code));
            if (refresh) c.setNotice(c.t('quoteUpdated'));
          }
          return;
        }
      }
      if (!quote) {
        quote = await c.issueQuote(id, kind, request.paragraph, request.pin, request.original);
        continue;
      }
      const state = live?.state ?? composer.readInput?.(composer.sessionId);
      if (existing && actions && live) {
        if (!collapseToDraftEnd(actions, live)) {
          c.setNotice(c.t('replaceQuoteRefused'));
          return;
        }
      } else if (actions && state?.draft && !state.draft.trim())
        actions.insertText('', { start: 0, end: 0, draftRev: state.draftRev });
      if (actions?.insertQuote(quote.text, quote.summary)) {
        // insertQuote can refuse even a plain draft. Keep the old card until DSH
        // accepts the new one, then finish the swap in the same synchronous turn.
        if (existing && !clearDraftQuotes(read, actions, owned)) {
          clearDraftQuotes(read, actions, [quote], 'one');
          c.setNotice(c.t('removeQuoteHint'));
          return;
        }
        const after = composer.readInput?.(composer.sessionId);
        if (after) startInstructionLine(actions, after);
        setFallback(undefined);
        setResolved([...current.filter((q) => !sameTarget(q)), quote]);
        if (refresh) c.setNotice(c.t('quoteUpdated'));
      } else if (existing) c.setNotice(c.t('replaceQuoteRefused'));
      else setFallback(quote);
      return;
    }
  }
  async function add(
    id: string,
    kind?: QuoteKind,
    paragraph?: number,
    pin?: RevisionPin,
    original = paragraph === undefined ? undefined : c.paragraphOriginal(id, paragraph),
  ) {
    const key = JSON.stringify([
      composer.sessionId,
      owner,
      generation,
      id,
      paragraph,
      pin?.batchId,
    ]);
    const previous = pending.current.get(key);
    if (previous) {
      if (previous.kind === kind && !pin) {
        previous.cancelled = true;
        pending.current.delete(key);
      }
      return;
    }
    const request = { kind, paragraph, original, pin, cancelled: false };
    const clicked = targetsOf(read());
    pending.current.set(key, request);
    const work = queue.current
      .then(() => update(id, request, clicked))
      .finally(() => {
        if (pending.current.get(key) === request) pending.current.delete(key);
      });
    queue.current = work.catch(() => {});
    return work;
  }
  const clear = () =>
    c.perform(async () => {
      const initial = read();
      const current = await resolveCurrent(signature.split(','));
      if (current) remove(initial, current, false);
    });
  const addReview = (pin: RevisionPin) => add(pin.id, 'review-quote', undefined, pin);
  return { quotes, add, addReview, clear, canClear, fallback, setFallback };
}
