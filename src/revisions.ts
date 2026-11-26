import { flatten, type MindDocument, type MindNode } from './model.ts';
import { numbering, numberLabel } from './numbering.ts';
import { referenceSpans, checkReferences } from './references.ts';

export interface RevisionRow {
  id: string;
  nodeId?: string;
  original: string;
  current: string;
  note: string;
  flags: ('新增' | '删除' | '合并' | '移动' | '文字修改' | '未改动')[];
  sourceIds: string[];
}
export function revisionRows(document: Pick<MindDocument, 'root' | 'sourceRoot'>): RevisionRow[] {
  const currentRows = flatten(document.root),
    oldRows = document.sourceRoot ? flatten(document.sourceRoot) : [];
  const current = currentRows.filter((r) => r.depth === 2),
    old = oldRows.filter((r) => r.depth === 2),
    oldIds = new Set(old.map((r) => r.node.id));
  const currentNumbers = numbering(document.root),
    oldNumbers = document.sourceRoot ? numbering(document.sourceRoot) : new Map();
  const checks = checkReferences(document.root);
  function text(node: MindNode, original: boolean): string {
    const nums = original ? oldNumbers : currentNumbers;
    return flatten(node)
      .map(({ node: n }) => {
        if (original && n.sourceText !== undefined) return n.sourceText;
        const number = original ? (n.sourceNumber ?? nums.get(n.id)) : nums.get(n.id);
        const body = original
          ? n.body
          : referenceSpans(n, checks)
              .map((s) => s.text)
              .join('');
        return (
          (number ? numberLabel(number) + '　' : '') +
          (body || (n.titleSource === 'auto' ? '' : n.title))
        );
      })
      .join('\n');
  }
  const out: RevisionRow[] = [],
    used = new Set<string>();
  for (const row of current) {
    const sources = old.filter((o) => (row.node.sourceIds ?? [row.node.id]).includes(o.node.id));
    sources.forEach((o) => used.add(o.node.id));
    const flags: RevisionRow['flags'] = [];
    if (!sources.length) flags.push('新增');
    if (sources.length > 1) flags.push('合并');
    if (
      sources.some((o) => {
        if (o.parent?.id !== row.parent?.id) return true;
        if (o.node.id !== row.node.id) return false;
        const originals = o
          .parent!.children.filter((n) =>
            current.some((c) => c.node.id === n.id && c.parent?.id === o.parent!.id),
          )
          .map((n) => n.id);
        const now = row
          .parent!.children.filter(
            (n) =>
              oldIds.has(n.id) &&
              old.some((x) => x.node.id === n.id && x.parent?.id === row.parent!.id),
          )
          .map((n) => n.id);
        return originals.indexOf(o.node.id) !== now.indexOf(row.node.id);
      })
    )
      flags.push('移动');
    const original = sources.map((o) => text(o.node, true)).join('\n\n'),
      after = text(row.node, false);
    if (
      sources.length === 1 &&
      JSON.stringify(
        flatten(sources[0].node).map((r) => [r.node.titleSource ? '' : r.node.title, r.node.body]),
      ) !==
        JSON.stringify(
          flatten(row.node).map((r) => [r.node.titleSource ? '' : r.node.title, r.node.body]),
        )
    )
      flags.push('文字修改');
    if (!flags.length) flags.push('未改动');
    out.push({
      id: row.node.id,
      nodeId: row.node.id,
      original: original || '（新增条款）',
      current: after,
      note: row.node.note ?? '',
      flags,
      sourceIds: sources.map((o) => o.node.id),
    });
  }
  for (const row of old)
    if (!used.has(row.node.id))
      out.push({
        id: 'deleted:' + row.node.id,
        original: text(row.node, true),
        current: '（删除）',
        note: row.node.note ?? '',
        flags: ['删除'],
        sourceIds: [row.node.id],
      });
  return out;
}
