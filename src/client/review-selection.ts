import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { checkParagraphChange, naturalParagraphs } from '../paragraphs.ts';
import type { MindNode } from '../model.ts';
import type { ReviewedBatch, ReviewedSuggestion } from '../suggestions.ts';

export function conflictReason(entry: ReviewedSuggestion, current?: MindNode) {
  if (entry.field === 'body' && entry.paragraphs) {
    try {
      checkParagraphChange(entry.before, entry.after, entry.paragraphs);
    } catch {
      return 'invalidReviewRange';
    }
    if (current && entry.before !== current.body) {
      const count = naturalParagraphs(current.body).length;
      if (entry.paragraphs.some((n) => n > count)) return 'missingReviewParagraph';
    }
  }
  if (!current) return 'missingNode';
  if (entry.field === 'children') {
    return current.children.length !== entry.originalIds.length ||
      current.children.some((n, i) => n.id !== entry.originalIds[i]) ||
      entry.additions.some((a) => a.beforeId && !entry.originalIds.includes(a.beforeId))
      ? 'changedChildren'
      : undefined;
  }
  return (current[entry.field] ?? '') !== entry.before ? 'changedField' : undefined;
}

export interface ReviewItem {
  key: string;
  batch: ReviewedBatch;
  entry: ReviewedSuggestion;
  reason?: ReturnType<typeof conflictReason>;
}
export interface ReviewPlace {
  item: ReviewItem;
  versions: ReviewItem[];
  ordinals?: number[];
  variantsByOrdinal?: Map<number, ReviewItem[]>;
}

export function reviewIndex(batches: ReviewedBatch[], rows: { node: MindNode }[]) {
  const nodes = new Map(rows.map(({ node }, i) => [node.id, { node, i }]));
  const byKey = new Map<string, ReviewItem>();
  const places = new Map<string, ReviewItem[]>();
  const multiple = new Set<string>();
  const fields = { title: 0, body: 1, note: 2, children: 3 };
  for (const batch of batches)
    for (const entry of batch.entries) {
      const key = JSON.stringify([batch.id, entry.id]);
      const item: ReviewItem = {
        key,
        batch,
        entry,
        reason: conflictReason(entry, nodes.get(entry.id)?.node),
      };
      byKey.set(key, item);
      const field = JSON.stringify([entry.id, entry.field]);
      const group = places.get(field) ?? [];
      group.push(item);
      places.set(field, group);
    }
  for (const group of places.values()) {
    const all = group.some(({ entry: e }) => e.field !== 'body' || !e.paragraphs);
    const seen = new Map<number, ReviewItem>();
    for (const item of group) {
      if (all && group.length > 1) multiple.add(item.key);
      if (item.entry.field === 'body')
        for (const n of item.entry.paragraphs ?? []) {
          const other = seen.get(n);
          if (other) {
            multiple.add(other.key);
            multiple.add(item.key);
          }
          seen.set(n, item);
        }
    }
  }
  const ordinal = (e: ReviewedSuggestion) => (e.field === 'body' ? (e.paragraphs?.[0] ?? 0) : 0);
  const items = [...byKey.values()].sort(
    ({ entry: a }, { entry: b }) =>
      (nodes.get(a.id)?.i ?? Infinity) - (nodes.get(b.id)?.i ?? Infinity) ||
      fields[a.field] - fields[b.field] ||
      ordinal(a) - ordinal(b),
  );
  return { items, byKey, places, multiple };
}

/** Each original natural paragraph elects one version. A whole-field replacement is indivisible. */
export function displayedReviews(index: ReturnType<typeof reviewIndex>, priorities: string[]) {
  const rank = new Map(priorities.map((key, i) => [key, priorities.length - i]));
  const winner = (list: ReviewItem[]) =>
    list.reduce((a, b) => ((rank.get(a.key) ?? 0) > (rank.get(b.key) ?? 0) ? a : b));
  const byNode = new Map<string, ReviewPlace[]>();
  for (const group of index.places.values()) {
    const selected = winner(group),
      node = selected.entry.id;
    const result = byNode.get(node) ?? [];
    byNode.set(node, result);
    if (selected.entry.field !== 'body' || !selected.entry.paragraphs) {
      result.push({ item: selected, versions: group });
      continue;
    }
    const whole = group.filter(({ entry: e }) => e.field === 'body' && !e.paragraphs);
    const slots = new Map<number, ReviewItem[]>();
    for (const item of group)
      if (item.entry.field === 'body')
        for (const n of item.entry.paragraphs ?? []) {
          const slot = slots.get(n) ?? [];
          slot.push(item);
          slots.set(n, slot);
        }
    const selectedParts = new Map<string, ReviewPlace>();
    for (const ordinal of [...slots.keys()].sort((a, b) => a - b)) {
      const candidates = slots.get(ordinal)!;
      const item = winner(candidates);
      const place: ReviewPlace = selectedParts.get(item.key) ?? {
        item,
        versions: [],
        ordinals: [],
        variantsByOrdinal: new Map(),
      };
      place.ordinals!.push(ordinal);
      place.variantsByOrdinal!.set(ordinal, [...whole, ...candidates]);
      selectedParts.set(item.key, place);
    }
    result.push(...selectedParts.values());
  }
  return byNode;
}

export function useReviewSelection(
  batches: ReviewedBatch[],
  rows: { node: MindNode }[],
  documentId: string,
) {
  const index = useMemo(() => reviewIndex(batches, rows), [batches, rows]);
  const [choice, setChoice] = useState({ key: '', position: 0, locate: true });
  const [priorities, setPriorities] = useState<string[]>([]);
  const seen = useRef({ documentId, batches: new Set<string>() });
  const current =
    index.byKey.get(choice.key) ?? index.items[Math.min(choice.position, index.items.length - 1)];
  function select(key: string, locate = true) {
    const item = index.byKey.get(key);
    if (!item) return;
    setChoice({ key, position: index.items.indexOf(item), locate });
    if (index.multiple.has(key))
      setPriorities((old) =>
        old[0] === key ? old : [key, ...old.filter((k) => k !== key && index.byKey.has(k))],
      );
  }
  useLayoutEffect(() => {
    const changedDocument = documentId !== seen.current.documentId;
    const added = batches.filter((b) => changedDocument || !seen.current.batches.has(b.id)).at(-1);
    seen.current = { documentId, batches: new Set(batches.map((b) => b.id)) };
    if (changedDocument) {
      setPriorities([]);
      setChoice({ key: '', position: 0, locate: true });
    }
    if (added) select(JSON.stringify([added.id, added.entries[0].id]));
    else if (current && current.key !== choice.key) select(current.key);
  }, [batches, documentId]);
  const displayed = useMemo(() => displayedReviews(index, priorities), [index, priorities]);
  return {
    current,
    locate: choice.locate,
    items: index.items,
    byKey: index.byKey,
    displayed,
    select,
  };
}
