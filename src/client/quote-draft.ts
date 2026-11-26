import type {
  DraftSnapshot,
  InputActions,
  InputState,
} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { quoteLines, type ResolvedQuote } from '../quotes.ts';

export interface ComposerDraft {
  state: InputState;
  document: DraftSnapshot;
}

/** DSH publishes expanded clipboard text, but accepts caret positions in chip units. */
export function startInstructionLine(actions: InputActions, state: InputState) {
  const { end, draftRev } = actions.captureInsertion();
  if (state.phase !== 'plain' || state.draftRev !== draftRev) return;
  const place = (at: number, text = '') =>
    actions.insertText(text, { start: at, end: at, draftRev });
  let last = end;
  // Most inserts already leave the caret at the end. When focus restored an earlier
  // position, find the final valid collapsed span. Empty edits only move the selection.
  if (place(last + 1)) {
    last++;
    let upper = state.draft.length;
    while (last < upper) {
      const at = Math.ceil((last + upper) / 2);
      if (place(at)) last = at;
      else upper = at - 1;
    }
  }
  if (state.draft.endsWith('\n ')) {
    place(last - 1);
    return;
  }
  // Chromium paints the caret before a terminal LF in a pre-wrapped text node.
  // Keep a space on the new line and place the caret before it. DSH trims it on send.
  const suffix = state.draft.endsWith('\n') ? ' ' : '\n ';
  if (place(last, suffix)) {
    const at = last + suffix.length - 1;
    actions.insertText('', { start: at, end: at, draftRev: actions.captureInsertion().draftRev });
  }
}

export function draftQuotes(doc: DraftSnapshot) {
  const atoms = [
    ...(doc.quotes ?? []),
    ...doc.references,
    ...(doc.command ? [{ offset: 0, length: doc.command.token.trimEnd().length }] : []),
  ].sort((a, b) => a.offset - b.offset);
  const boundaries = (doc.quotes ?? []).flatMap((q) => [q.offset, q.offset + q.length]);
  const targets = [];
  for (const line of quoteLines(doc.text, boundaries)) {
    const { raw, start, canonical } = line;
    const code = line.code ?? line.reference;
    if (!canonical || !code) continue;
    const end = start + raw.length;
    const atom = atoms.find((a) => a.offset < end && a.offset + a.length > start);
    if (
      !atom ||
      ('text' in atom &&
        atom.text === canonical &&
        atom.offset === start &&
        atom.length === raw.length)
    )
      targets.push({ start, end, text: canonical, code, native: !!atom });
  }
  return { atoms, targets };
}

/** DSH TokenSpan counts each quote, reference or command chip as one character. */
function composerOffset(at: number, atoms: readonly { offset: number; length: number }[]) {
  return at - atoms.reduce((sum, a) => sum + (a.offset + a.length <= at ? a.length - 1 : 0), 0);
}

export function collapseToDraftEnd(actions: InputActions, draft: ComposerDraft) {
  const end = composerOffset(draft.document.text.length, draftQuotes(draft.document).atoms);
  return actions.insertText('', { start: end, end, draftRev: draft.state.draftRev });
}

export function removalRanges(doc: DraftSnapshot, quotes: ResolvedQuote[], nativeOnly = false) {
  const own = new Set(quotes.map((q) => q.text));
  const { atoms, targets } = draftQuotes(doc);
  return targets
    .filter((q) => own.has(q.text) && (!nativeOnly || q.native))
    .sort((a, b) => b.start - a.start)
    .map((r) => ({ start: composerOffset(r.start, atoms), end: composerOffset(r.end, atoms) }));
}

export function clearDraftQuotes(
  read: () => ComposerDraft | undefined,
  actions: InputActions,
  quotes: ResolvedQuote[],
  mode: 'all' | 'one' | 'keep-one' = 'all',
) {
  let lastCount = Infinity;
  for (;;) {
    const draft = read();
    if (!draft || draft.state.phase !== 'plain' || draft.document.text !== draft.state.draft)
      return false;
    const ranges = removalRanges(draft.document, quotes);
    if (mode === 'one' && lastCount !== Infinity) return ranges.length === lastCount - 1;
    if (!ranges.length) return mode === 'all';
    if (mode === 'keep-one' && ranges.length === 1) return true;
    if (ranges.length >= lastCount) return false;
    lastCount = ranges.length;
    const range =
      mode !== 'all' && ranges.length > 1
        ? removalRanges(draft.document, quotes, true)[0]
        : ranges[0];
    if (!range || !actions.insertText('', { ...range, draftRev: draft.state.draftRev }))
      return false;
  }
}
