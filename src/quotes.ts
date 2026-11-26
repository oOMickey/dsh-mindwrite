import { reviewRange } from './continuation.ts';
import type { Suggestion } from './suggestions.ts';
import { parser } from '@lezer/markdown';
import { ancestors } from './client/navigation.ts';
import { find, type MindNode } from './model.ts';
import { numberedTitles, titleNumber } from './numbering.ts';
import type { Numbering } from './format.ts';
import type { profileFor } from './document-profile.ts';
import type { UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client';

export const QUOTE_NOTICE = 'plugin:mindwrite/quote-notice';

export interface BlockQuote {
  code: string;
  nodeId: string;
  paragraph?: number;
  reviewBatch?: string;
  text: string;
  summary: { label: string; body: string; title: string; detail?: string };
}

export type ResolvedQuote = Pick<
  BlockQuote,
  'code' | 'nodeId' | 'text' | 'paragraph' | 'reviewBatch'
> & {
  stale?: true | 'deleted';
};

type QuoteProfile =
  boolean | Pick<ReturnType<typeof profileFor>, 'legacy' | 'matchPosition' | 'prefixes'>;

function quoteSummary(root: MindNode, nodeId: string, scheme: Numbering, profile: QuoteProfile) {
  const node = find(root, nodeId);
  const legacy = typeof profile === 'boolean' ? profile : profile.legacy;
  const titles = numberedTitles(root, {
    ...(typeof profile === 'object' && { prefixes: profile.prefixes }),
    scheme,
    matchPosition: typeof profile === 'boolean' ? legacy : profile.matchPosition,
  });
  const entry = titles.get(nodeId)!;
  const chapter = ancestors(root, nodeId)[1];
  const embedded = legacy && scheme === 'none' ? titleNumber(node.title) : '';
  const label =
    nodeId === root.id
      ? '文稿'
      : node.kind === 'preamble'
        ? '序言'
        : entry.prefix.trim() || embedded;
  const retainSpacing =
    scheme === 'none' &&
    typeof profile === 'object' &&
    profile.prefixes &&
    Object.hasOwn(profile.prefixes, nodeId);
  const body = entry.title
    .slice(embedded.length)
    .replace(retainSpacing ? /[\r\n]+/gu : /\s+/gu, ' ')
    .replace(/[〔〕]/gu, '');
  return {
    label,
    body: retainSpacing ? body : body.trim(),
    title: root.title,
    ...(chapter ? { detail: titles.get(chapter.id)!.title } : {}),
  };
}

export function makeBlockQuote(
  root: MindNode,
  nodeId: string,
  code: string,
  scheme: Numbering = 'official',
  legacy: QuoteProfile = true,
  paragraph?: number,
): BlockQuote {
  const summary = quoteSummary(root, nodeId, scheme, legacy);
  if (paragraph !== undefined) summary.body += ` · 第${paragraph}段`;
  const heading = `${summary.label} ${summary.body}`.trimStart();
  return {
    code,
    nodeId,
    ...(paragraph !== undefined && { paragraph }),
    text: `${heading}〔导图·${code}〕`,
    summary,
  };
}

export function makeReviewQuote(
  root: MindNode,
  entry: Suggestion,
  batchId: string,
  code: string,
  scheme: Numbering,
  profile: QuoteProfile,
): BlockQuote {
  const summary = quoteSummary(root, entry.id, scheme, profile);
  summary.body = [summary.body, reviewRange(entry), '待审稿'].filter(Boolean).join(' · ');
  const heading = [summary.label, summary.body].filter(Boolean).join(' ');
  return {
    code,
    nodeId: entry.id,
    reviewBatch: batchId,
    text: `${heading}〔待审·${code}〕`,
    summary,
  };
}

export function makeReference(
  root: MindNode,
  nodeId: string,
  marker: string,
  scheme: Numbering = 'official',
  legacy: QuoteProfile = true,
  paragraph?: number,
): BlockQuote {
  const summary = quoteSummary(root, nodeId, scheme, legacy);
  if (paragraph !== undefined) summary.body += ` · 第${paragraph}段`;
  const label = ('? ' + summary.label).trimEnd();
  return {
    code: marker,
    ...(paragraph !== undefined && { paragraph }),
    nodeId,
    summary: { ...summary, label, body: summary.body + ' · 仅作参考' },
    text: `${label} · 仅作参考 ${summary.body}〔参考·${marker}〕`,
  };
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'mindwrite-quote': { text: string; review?: true };
  }
}

/** Sent messages carry Markdown only. DSH's native quote rule otherwise shows the signed text. */
export const sentQuoteRule: UserTextRule<'mindwrite-quote'> = {
  id: 'mindwrite-quote',
  order: -11,
  match(text, from) {
    if (!hasQuoteMarker(text.slice(from))) return;
    for (const { raw, start, canonical, reference } of quoteLines(text)) {
      if (start < from || !canonical) continue;
      let display = canonical.slice(0, canonical.lastIndexOf('〔')).trimEnd();
      if (reference) display = display.replace(' · 仅作参考 ', ' ') + ' · 仅作参考';
      return {
        id: 'mindwrite-quote',
        start,
        end: start + raw.length,
        data: { text: display, ...(canonical.includes('〔待审·') && { review: true as const }) },
      };
    }
  },
};

export const hasQuoteMarker = (text: string) => /〔(?:导图|参考|待审)·/u.test(text);

/** DSH sends each native chip as a separate Markdown block. Keep offsets in the original draft. */
export function* quoteLines(text: string, blockBoundaries: readonly number[] = []) {
  let start = 0;
  const blocks = [];
  for (const end of [...blockBoundaries, text.length]) {
    const raw = text.slice(start, end);
    const normalized = raw.replace(/\r\n?/gu, '\n');
    blocks.push({
      raw,
      start,
      markdown: normalized.trim(),
      leading: normalized.length - normalized.trimStart().length,
    });
    start = end;
  }
  const fences: { from: number; to: number }[] = [];
  if (hasQuoteMarker(text) && (text.includes('```') || text.includes('~~~'))) {
    const prompt = blocks
      .map((b) => b.markdown)
      .filter(Boolean)
      .join('\n\n');
    parser.parse(prompt).iterate({
      enter(node) {
        if (node.name === 'FencedCode') {
          fences.push({ from: node.from, to: node.to });
          return false;
        }
      },
    });
  }
  let promptStart = 0,
    fence = 0;
  for (const block of blocks) {
    start = block.start;
    // Compare fence positions in the LF-normalized prompt, but return the original UTF-16 spans.
    let offset = promptStart - block.leading;
    const parts = block.raw.split(/(\r\n?|\n)/);
    for (let i = 0; i < parts.length; i += 2) {
      const raw = parts[i];
      let match = /^> ([^\s〔〕][^〔〕]*〔导图·([A-Z2-9]{8}|[a-f0-9]{32})〕)$/u.exec(raw.trim());
      match ??= /^> ([^\s〔〕][^〔〕]* · 待审稿〔待审·([a-f0-9]{32})〕)$/u.exec(raw.trim());
      let ref = /^> (\? [^〔〕]*〔参考·([a-f0-9]{24})〕)$/u.exec(raw.trim());
      if ((match || ref) && fences[fence]) {
        const marker = offset + raw.lastIndexOf('〔');
        while (fences[fence] && fences[fence].to <= marker) fence++;
        if (fences[fence] && fences[fence].from <= marker) {
          match = null;
          ref = null;
        }
      }
      yield {
        raw,
        start,
        canonical: match?.[1] ?? ref?.[1],
        code: match?.[2],
        reference: ref?.[2],
      };
      start += raw.length + (parts[i + 1]?.length ?? 0);
      offset += raw.length + 1;
    }
    if (block.markdown) promptStart += block.markdown.length + 2;
  }
}

export function parseQuoteRequest(text: string) {
  const codes: string[] = [],
    lines: string[] = [],
    references: string[] = [],
    instruction: string[] = [];
  for (const { raw, canonical, code, reference } of quoteLines(text)) {
    if (code && canonical) {
      codes.push(code);
      lines.push(canonical);
    } else if (reference) references.push(reference);
    else if (!raw.trimStart().startsWith('>')) instruction.push(raw);
  }
  return { codes, lines, references, instruction: instruction.join('\n').trim() };
}
