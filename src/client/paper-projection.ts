import { isResearchType, type profileFor } from '../document-profile.ts';
import {
  paragraphText,
  referencesByNode,
  sectionParagraphs,
  type ArticleTitle,
  type DocumentParagraph,
  type TextSpan,
} from '../format.ts';
import { flatten, type MindNode, type NodeInput } from '../model.ts';
import { numberedTitles } from '../numbering.ts';
import { paragraphSelection, replaceParagraphs } from '../paragraphs.ts';
import { reviewDiff, type DiffSpan, type ResearchText } from '../review-diff.ts';
import type { ReviewPlace } from './review-selection.ts';

export type PaperMode = 'markup' | 'effect';
export type PaperSpan = TextSpan & { change?: 'added' | 'removed'; critical?: boolean };
export type PreviewParagraph = Omit<DocumentParagraph, 'spans'> & {
  paragraph: number;
  spans: PaperSpan[];
  review?: ReviewPlace;
  owner?: string;
  first?: boolean;
  badge?: 'newPaperText' | 'paperConflict';
  deleted?: boolean;
  joinsNext?: boolean;
  versions?: ReviewPlace['versions'];
};

function splitAt(spans: TextSpan[], at: number): [TextSpan[], TextSpan[]] {
  const head: TextSpan[] = [],
    tail: TextSpan[] = [];
  for (const span of spans) {
    if (at >= span.text.length) head.push(span);
    else if (at <= 0) tail.push(span);
    else {
      head.push({ ...span, text: span.text.slice(0, at) });
      tail.push({ ...span, text: span.text.slice(at) });
    }
    at -= span.text.length;
  }
  return [head, tail];
}

const bodyText = (p: DocumentParagraph) => paragraphText(p).slice(p.bodyOffset ?? 0);

/** Anchor unchanged natural paragraphs before pairing the changed runs between them. */
function align(before: DocumentParagraph[], after: DocumentParagraph[]) {
  const lines: [DocumentParagraph | undefined, DocumentParagraph | undefined][] = [];
  const positions = new Map<string, number[]>();
  after.forEach((p, i) => {
    const text = bodyText(p),
      list = positions.get(text) ?? [];
    list.push(i);
    positions.set(text, list);
  });
  let a = 0,
    b = 0;
  const gap = (endA: number, endB: number) => {
    while (a < endA || b < endB)
      lines.push([a < endA ? before[a++] : undefined, b < endB ? after[b++] : undefined]);
  };
  for (let i = 0; i < before.length; i++) {
    const list = positions.get(bodyText(before[i]));
    if (!list) continue;
    let lo = 0,
      hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid] < b) lo = mid + 1;
      else hi = mid;
    }
    if (lo < list.length) {
      gap(i, list[lo]);
      lines.push([before[a++], after[b++]]);
    }
  }
  gap(before.length, after.length);
  return lines;
}

export type PaperDiffCache = Map<string, { before: string; after: string; runs: DiffSpan[] }>;
interface MarkupJob {
  research?: ResearchText;
  target: PreviewParagraph;
  key: string;
  lead: TextSpan[];
  before: string;
  after: string;
  afterSpans: TextSpan[];
}

export function projectPaper(
  root: MindNode,
  profile: ReturnType<typeof profileFor>,
  articleTitle: ArticleTitle,
  displayed: Map<string, ReviewPlace[]>,
  mode: PaperMode,
) {
  const virtual = new Map<string, ReviewPlace>();
  const occupied = new Set(flatten(root).map((r) => r.node.id));
  let sequence = 0;
  function addition(input: NodeInput, place: ReviewPlace): MindNode {
    let id: string;
    do {
      id = 'mw-preview-' + sequence++;
    } while (occupied.has(id));
    virtual.set(id, place);
    return {
      ...input,
      id,
      body: input.body ?? '',
      collapsed: false,
      children: (input.children ?? []).map((n) => addition(n, place)),
    };
  }
  // Both formatters see the same inserted structure and consequently the same numbering.
  // Only the second tree contains proposed field values. Neither tree enters an editor operation.
  const beforeNodes = new Map<string, MindNode>();
  function visit(node: MindNode): MindNode {
    const places = displayed.get(node.id) ?? [];
    let children = node.children;
    const structure = places.find((p) => p.item.entry.field === 'children' && !p.item.reason);
    if (structure && structure.item.entry.field === 'children') {
      const groups = new Map<string | undefined, MindNode[]>();
      for (const { beforeId, node: input } of structure.item.entry.additions) {
        const group = groups.get(beforeId) ?? [];
        group.push(addition(input, structure));
        groups.set(beforeId, group);
      }
      children = [
        ...children.flatMap((n) => [...(groups.get(n.id) ?? []), n]),
        ...(groups.get(undefined) ?? []),
      ];
    }
    let body = node.body,
      title = node.title;
    for (const { item, ordinals } of places) {
      const e = item.entry;
      if (item.reason) continue;
      if (e.field === 'title') title = e.after;
      if (e.field === 'body')
        body = e.paragraphs
          ? replaceParagraphs(
              body,
              ordinals ?? e.paragraphs,
              paragraphSelection(e.after, ordinals ?? e.paragraphs),
            )
          : e.after;
    }
    const after = children.map((n) => (virtual.has(n.id) ? n : visit(n)));
    const before = children.map((n) => beforeNodes.get(n.id) ?? n);
    beforeNodes.set(
      node.id,
      before.every((n, i) => n === node.children[i]) && before.length === node.children.length
        ? node
        : { ...node, children: before },
    );
    return body === node.body &&
      title === node.title &&
      after.every((n, i) => n === node.children[i]) &&
      after.length === node.children.length
      ? node
      : { ...node, body, title, children: after };
  }
  const afterRoot = displayed.size ? visit(root) : root;
  const beforeRoot = beforeNodes.get(root.id) ?? root;
  const numbers = numberedTitles(afterRoot, profile);
  const oldNumbers = beforeRoot === afterRoot ? numbers : numberedTitles(beforeRoot, profile);
  const refs = referencesByNode(afterRoot);
  const oldRefs = beforeRoot === afterRoot ? refs : referencesByNode(beforeRoot);
  const paragraphs: PreviewParagraph[] = [];
  const jobs: MarkupJob[] = [];
  const seen = new Set<string>();
  for (const { node, depth } of flatten(afterRoot)) {
    const id = node.id,
      places = displayed.get(id) ?? [],
      tree = virtual.get(id);
    const titlePlace = places.find((p) => p.item.entry.field === 'title');
    const bodyPlaces = places.filter((p) => p.item.entry.field === 'body');
    const whole = bodyPlaces.find((p) => p.item.entry.field === 'body' && !p.item.entry.paragraphs);
    const byOrdinal = new Map<number, ReviewPlace>();
    for (const place of bodyPlaces)
      if (place.item.entry.field === 'body')
        for (const n of place.ordinals ?? place.item.entry.paragraphs ?? [])
          byOrdinal.set(n, place);
    // A proposed article title has its own target, even when the print preference omits titles.
    const sharedTitle =
      depth >= 2 && profile.type === 'regulation' && profile.scheme === 'official';
    const displayTitle =
      titlePlace && sharedTitle
        ? 'separate'
        : tree && articleTitle === 'omit'
          ? 'bracket'
          : articleTitle;
    const format = (n: MindNode, old: boolean) =>
      sectionParagraphs(
        n,
        (old ? oldNumbers : numbers).get(id)!,
        (old ? oldRefs : refs).get(id) ?? [],
        profile,
        displayTitle,
        profile.type !== 'regulation',
      );
    const next = format(node, false);
    const base = beforeNodes.get(id) ?? node;
    const previous = base === node ? next : format(base, true);
    let paragraph = 0;
    const put = (p: DocumentParagraph, place?: ReviewPlace, badge?: PreviewParagraph['badge']) => {
      const first = place && !seen.has(place.item.key);
      if (place) seen.add(place.item.key);
      const out: PreviewParagraph = {
        ...p,
        paragraph: paragraph++,
        review: place,
        first,
        badge: first ? badge : undefined,
        owner: tree?.item.entry.id,
      };
      const preceding = paragraphs.at(-1);
      if (place && preceding?.review?.item.key === place.item.key) preceding.joinsNext = true;
      out.versions =
        place?.variantsByOrdinal?.get(p.bodyOrdinal ?? 0) ?? (first ? place?.versions : undefined);
      paragraphs.push(out);
      return out;
    };
    const change = (
      out: PreviewParagraph,
      place: ReviewPlace,
      original: DocumentParagraph | undefined,
      proposed: DocumentParagraph | undefined,
      heading = false,
    ) => {
      const leadLength = (p: DocumentParagraph) =>
        heading ? (p.numberPrefix?.length ?? 0) : (p.bodyOffset ?? 0);
      const printed = proposed ?? original!;
      const [lead] = splitAt(printed.spans, leadLength(printed));
      const old = original ? paragraphText(original).slice(leadLength(original)) : '';
      const afterSpans = proposed ? splitAt(proposed.spans, leadLength(proposed))[1] : [];
      const value = afterSpans.map((s) => s.text).join('');
      if (!proposed && !heading) {
        out.deleted = mode === 'effect';
        if (out.deleted) {
          out.spans = lead;
          return;
        }
      }
      if (
        mode === 'markup' &&
        old !== value &&
        !out.badge &&
        !(place.item.entry.field === 'body' && !place.item.entry.before.trim())
      ) {
        const research = isResearchType(profile.type) ? (heading ? 'title' : 'body') : undefined;
        jobs.push({
          research,
          target: out,
          lead,
          before: old,
          after: value,
          afterSpans,
          key: JSON.stringify([
            place.item.entry.digest,
            research,
            id,
            heading ? 'title' : (original?.bodyOrdinal ?? -paragraph),
          ]),
        });
      }
    };
    if (tree) {
      for (const p of next) {
        const out = put(p, tree, 'newPaperText');
        if (p.kind === 'item' && p.numberPrefix && p.bodyOrdinal === 1 && node.body.trim()) {
          const [prefix, body] = splitAt(p.spans, p.bodyOffset ?? 0);
          out.spans = [...prefix, { text: '【' + numbers.get(id)!.title + '】' }, ...body];
        }
        out.spans = out.spans.map(({ text, emphasis }) => ({ text, emphasis }));
      }
      continue;
    }
    if (!places.some((p) => p.item.entry.field !== 'note')) {
      next.forEach((p) => put(p));
      continue;
    }
    const isHead = (p: DocumentParagraph) => ['title', 'chapter', 'heading'].includes(p.kind);
    const heading = (p: DocumentParagraph) => {
      if (titlePlace && sharedTitle && depth === 2 && displayTitle === 'separate') {
        const prefix = numbers.get(id)!.prefix;
        return { ...p, spans: [{ text: prefix }, ...p.spans], numberPrefix: prefix };
      }
      return p;
    };
    const heads = next.filter(isHead);
    if (titlePlace && !heads.length)
      heads.push({
        id,
        depth,
        kind: 'heading',
        spans: [{ text: numbers.get(id)!.heading }],
        numberPrefix: numbers.get(id)!.prefix,
        centered: false,
        indent: false,
      });
    for (const p of heads) {
      const h = heading(p);
      const out = put(h, titlePlace, titlePlace?.item.reason ? 'paperConflict' : undefined);
      if (titlePlace && !titlePlace.item.reason) {
        const old = previous.find(isHead) ?? {
          ...p,
          spans: [{ text: oldNumbers.get(id)!.heading }],
        };
        change(out, titlePlace, heading(old), h, true);
      }
    }
    let after = next.filter((p) => !isHead(p)),
      before = previous.filter((p) => !isHead(p));
    if (bodyPlaces.length && !node.body.trim()) after = after.filter((p) => p.bodyOrdinal);
    if (bodyPlaces.length && !base.body.trim()) before = before.filter((p) => p.bodyOrdinal);
    const pairs =
      whole && !whole.item.reason
        ? align(before, after)
        : after.map((p, i) => [before[i], p] as const);
    for (const [old, p] of pairs) {
      const value = p ?? old!;
      // An empty nested item's printed text already consists entirely of its projected heading.
      if (titlePlace && sharedTitle && p?.kind === 'item' && !p.bodyOrdinal) continue;
      const place = byOrdinal.get(old?.bodyOrdinal ?? p?.bodyOrdinal ?? 0) ?? whole;
      const fresh = place?.item.entry.field === 'body' && !place.item.entry.before.trim();
      const out = put(
        value,
        place,
        place?.item.reason ? 'paperConflict' : fresh ? 'newPaperText' : undefined,
      );
      if (fresh) out.spans = out.spans.map(({ text, emphasis }) => ({ text, emphasis }));
      if (place && !place.item.reason) change(out, place, old, p);
      if (
        (titlePlace &&
          sharedTitle &&
          depth >= 2 &&
          (out.kind === 'item' || out.kind === 'article')) ||
        (!p && after.length && value.bodyOffset)
      ) {
        // The projected heading already carries the article number.
        out.spans = splitAt(out.spans, (p ? out.numberPrefix?.length : out.bodyOffset) ?? 0)[1];
        const job = jobs.at(-1);
        if (job?.target === out)
          job.lead = splitAt(job.lead, (p ? out.numberPrefix?.length : out.bodyOffset) ?? 0)[1];
      }
    }
    for (const place of places)
      if (place.item.reason && place.item.entry.field !== 'note' && !seen.has(place.item.key))
        put(
          { id, depth, kind: 'body', spans: [], centered: false, indent: false },
          place,
          'paperConflict',
        );
  }
  return { paragraphs, jobs };
}

/** Complete small changes in the first render. Bound each batch of uncached Myers searches. */
export function* markPaper(plan: ReturnType<typeof projectPaper>, cache: PaperDiffCache) {
  let start = performance.now();
  for (const job of plan.jobs) {
    let saved = cache.get(job.key);
    if (!saved || saved.before !== job.before || saved.after !== job.after) {
      saved = {
        before: job.before,
        after: job.after,
        runs: reviewDiff(job.before, job.after, job.research).merged,
      };
      cache.set(job.key, saved);
    }
    const spans: PaperSpan[] = [...job.lead];
    let i = 0,
      offset = 0;
    for (const run of saved.runs) {
      if (run.kind !== 'same')
        spans.push({ text: run.text, change: run.kind, critical: run.critical });
      if (run.kind === 'removed') continue;
      let left = run.text.length;
      while (left > 0) {
        const source = job.afterSpans[i],
          take = Math.min(left, source.text.length - offset);
        if (run.kind === 'same' && take)
          spans.push({ ...source, text: source.text.slice(offset, offset + take) });
        left -= take;
        offset += take;
        if (offset === source.text.length) {
          i++;
          offset = 0;
        }
      }
    }
    job.target.spans = spans;
    if (performance.now() - start >= 8) {
      yield;
      start = performance.now();
    }
  }
  return plan.paragraphs;
}
