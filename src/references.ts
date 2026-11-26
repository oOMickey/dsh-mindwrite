import { flatten, MindError, type MindNode } from './model.ts';
import { equalRanges, type EqualRange } from './text-diff.ts';
import type { BoundReference } from './metadata.ts';
import { chinese, numeral, numbering, parseNumber } from './numbering.ts';

export type ReferenceStatus =
  'resolved' | 'ambiguous' | 'dangling' | 'deleted' | 'edited' | 'level-changed';
export interface ReferenceCheck {
  reference: BoundReference;
  sourceId: string;
  sourceTitle: string;
  targetTitles: string[];
  current: string;
  status: ReferenceStatus;
  changed: boolean;
  start: number;
  end: number;
}
export function scanReferences(body: string): Omit<BoundReference, 'targets'>[] {
  const expression = new RegExp(
    `(?:本办法第(${numeral})(章|条)(?:第[（(]?(${numeral})[）)]?项)?|第(${numeral})条第[（(]?(${numeral})[）)]?项)`,
    'g',
  );
  return [...body.matchAll(expression)].map((m, i) => ({
    id: `ref-${i}`,
    start: m.index!,
    end: m.index! + m[0].length,
    text: m[0],
    unit: m[2] === '章' ? 'chapter' : 'article',
    number: parseNumber(m[1] ?? m[4]),
    ...((m[3] ?? m[5]) ? { item: parseNumber(m[3] ?? m[5]) } : {}),
  }));
}
/** Bind once against original numbers, never against a later visual order. */
export function bindReferences(root: MindNode): void {
  const rows = flatten(root);
  for (const { node } of rows) {
    const references = scanReferences(node.body).map((reference): BoundReference => {
      const candidates = rows.filter(
        ({ node: target }) =>
          target.sourceNumber?.unit === reference.unit &&
          target.sourceNumber.number === reference.number,
      );
      const targets = candidates.flatMap(({ node: target }) => {
        if (reference.item === undefined) return [{ id: target.id }];
        const items = target.children.filter(
          (child) =>
            child.sourceNumber?.unit === 'item' && child.sourceNumber.number === reference.item,
        );
        // A duplicated article number remains ambiguous even when only one
        // candidate currently contains the named item. Never infer author intent.
        return items.length
          ? items.map((child) => ({ id: target.id, itemId: child.id }))
          : candidates.length > 1
            ? [{ id: target.id }]
            : [];
      });
      return { ...reference, id: `${node.id}:${reference.id}`, targets };
    });
    if (references.length) {
      node.references = references;
      node.referenceText = node.body;
    }
  }
}
function location(
  node: MindNode,
  reference: BoundReference,
  ranges: EqualRange[],
): [number, number] | undefined {
  const before = node.referenceText ?? node.body,
    after = node.body;
  if (before === after) return [reference.start, reference.end];
  const count = (text: string) => text.split(reference.text).length - 1;
  if (count(before) > 1 && count(before) !== count(after)) return;
  const equal = ranges.find(
    (range) => reference.start >= range.before && reference.end <= range.before + range.length,
  );
  if (equal) {
    const shift = equal.after - equal.before;
    return [reference.start + shift, reference.end + shift];
  }
  return undefined;
}
export function checkReferences(root: MindNode): ReferenceCheck[] {
  const rows = flatten(root),
    nodes = new Map(rows.map(({ node }) => [node.id, node]));
  const numbers = numbering(root),
    result: ReferenceCheck[] = [];
  for (const { node } of rows) {
    const covered: [number, number][] = [];
    const ranges = equalRanges(node.referenceText ?? node.body, node.body);
    const unlocated: BoundReference[] = [];
    for (const reference of node.references ?? []) {
      const position = location(node, reference, ranges);
      if (!position) {
        unlocated.push(reference);
        continue;
      }
      if (position) covered.push(position);
      let status: ReferenceStatus = reference.needsReview
        ? 'edited'
        : reference.targets.length > 1
          ? 'ambiguous'
          : reference.targets.length === 0
            ? 'dangling'
            : 'resolved';
      let current = reference.text;
      const target = reference.targets[0];
      if (status === 'resolved') {
        const number = numbers.get(target.id),
          item = target.itemId ? numbers.get(target.itemId) : undefined;
        if (!nodes.has(target.id) || (target.itemId && !nodes.has(target.itemId)))
          status = 'deleted';
        else if (
          !number ||
          number.unit !== reference.unit ||
          (target.itemId && item?.unit !== 'item') ||
          (target.itemId && !nodes.get(target.id)!.children.some((n) => n.id === target.itemId))
        )
          status = 'level-changed';
        else {
          current = reference.text.replace(
            new RegExp(`第${numeral}(章|条)`),
            `第${chinese(number.number)}$1`,
          );
          if (item)
            current = current.replace(
              new RegExp(`第([（(]?)${numeral}([）)]?)项`),
              `第$1${chinese(item.number)}$2项`,
            );
        }
      }
      result.push({
        reference,
        sourceId: node.id,
        sourceTitle: node.title,
        targetTitles: reference.targets.map((t) =>
          [
            nodes.get(t.id)?.title ?? '（已删除）',
            t.itemId ? (nodes.get(t.itemId)?.title ?? '（已删除）') : '',
          ]
            .filter(Boolean)
            .join(' / '),
        ),
        current,
        status,
        changed: status === 'resolved' && current !== reference.text,
        start: position?.[0] ?? -1,
        end: position?.[1] ?? -1,
      });
    }
    // New or edited reference text requires review rather than silently binding to current ordinals.
    for (const reference of scanReferences(node.body)) {
      if (covered.some(([start, end]) => start === reference.start && end === reference.end))
        continue;
      const oldIndex = unlocated.findIndex((old) => old.text === reference.text);
      const old = oldIndex >= 0 ? unlocated.splice(oldIndex, 1)[0] : unlocated.shift();
      result.push({
        reference: {
          ...reference,
          id: old?.id ?? `${node.id}:new:${reference.start}`,
          targets: old?.targets ?? [],
          needsReview: true,
        },
        sourceId: node.id,
        sourceTitle: node.title,
        targetTitles: [],
        current: reference.text,
        status: 'edited',
        changed: false,
        start: reference.start,
        end: reference.end,
      });
    }
  }
  return result;
}

export interface ReferenceConfirmation {
  id: string;
  referenceId: string;
  targetId: string;
  itemId?: string;
}
export function confirmReference(root: MindNode, choice: ReferenceConfirmation): void {
  const rows = flatten(root),
    node = rows.find((row) => row.node.id === choice.id)?.node;
  const checks = checkReferences(root).filter((row) => row.sourceId === choice.id);
  const selected = checks.find((row) => row.reference.id === choice.referenceId);
  const number = numbering(root).get(choice.targetId);
  const target = rows.find((row) => row.node.id === choice.targetId)?.node;
  if (
    !node ||
    !selected ||
    selected.start < 0 ||
    !number ||
    number.unit !== selected.reference.unit ||
    !!choice.itemId !== (selected.reference.item !== undefined) ||
    (choice.itemId && !target?.children.some((child) => child.id === choice.itemId))
  )
    throw new MindError('REFERENCE_TARGET', '引用目标不匹配，请选择相应章、条或项');
  node.references = checks.map((row) => ({
    ...row.reference,
    start: row.start,
    end: row.end,
    text: node.body.slice(row.start, row.end),
    targets:
      row === selected
        ? [{ id: choice.targetId, ...(choice.itemId ? { itemId: choice.itemId } : {}) }]
        : row.reference.targets,
    needsReview: row !== selected && row.status === 'edited',
  }));
  node.referenceText = node.body;
}
export interface ReferenceSpan {
  text: string;
  referenceBound?: boolean;
  referenceChanged?: boolean;
  referenceWarning?: boolean;
  original?: string;
}
export function referenceSpans(node: MindNode, checks: ReferenceCheck[]): ReferenceSpan[] {
  const references = checks
    .filter((r) => r.sourceId === node.id && r.start >= 0)
    .sort((a, b) => a.start - b.start);
  const spans: ReferenceSpan[] = [];
  let offset = 0;
  for (const check of references) {
    if (check.start < offset) continue;
    if (check.start > offset) spans.push({ text: node.body.slice(offset, check.start) });
    spans.push(
      check.changed
        ? {
            text: check.current,
            referenceBound: true,
            referenceChanged: true,
            original: check.reference.text,
          }
        : check.status !== 'resolved'
          ? { text: node.body.slice(check.start, check.end), referenceWarning: true }
          : { text: node.body.slice(check.start, check.end), referenceBound: true },
    );
    offset = check.end;
  }
  if (offset < node.body.length) spans.push({ text: node.body.slice(offset) });
  return spans;
}
