import { flatten, MindError, validateRoot, type MindNode, type History } from './model.ts';

export type NodeRecord = Omit<MindNode, 'children'> & { children: string[] };
export interface TreePatch {
  rootId: string;
  changes: { id: string; before: NodeRecord | null; after: NodeRecord | null }[];
}
export const HISTORY_BYTES = 600_000;
export const HISTORY_BATCHES = 40;

function records(root: MindNode): Map<string, NodeRecord> {
  return new Map(
    flatten(root).map(({ node }) => [
      node.id,
      { ...node, children: node.children.map((child) => child.id) },
    ]),
  );
}

/** Stable IDs keep moves small: only the two parents' child lists change. */
export function treePatch(before: MindNode, after: MindNode): TreePatch {
  const old = records(before),
    next = records(after);
  return {
    rootId: before.id,
    changes: [...new Set([...old.keys(), ...next.keys()])].flatMap((id) => {
      const a = old.get(id) ?? null,
        b = next.get(id) ?? null;
      return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ id, before: a, after: b }];
    }),
  };
}

export function validatePatch(patch: TreePatch): void {
  if (
    !patch ||
    typeof patch.rootId !== 'string' ||
    !Array.isArray(patch.changes) ||
    patch.changes.length > 6000
  )
    throw new MindError('INVALID_DOCUMENT', '历史补丁格式错误');
  const ids = new Set<string>();
  for (const change of patch.changes) {
    if (typeof change.id !== 'string' || ids.has(change.id) || (!change.before && !change.after))
      throw new MindError('INVALID_DOCUMENT', '历史补丁节点错误');
    ids.add(change.id);
    for (const record of [change.before, change.after]) {
      if (record === null) continue;
      if (
        !record ||
        record.id !== change.id ||
        !Array.isArray(record.children) ||
        record.children.length > 3000 ||
        record.children.some((id) => typeof id !== 'string') ||
        (record.kind !== undefined && record.kind !== 'preamble')
      )
        throw new MindError('INVALID_DOCUMENT', '历史补丁内容错误');
      const node = { ...record, children: [] } as MindNode;
      delete node.kind;
      validateRoot(node);
    }
  }
}

export function applyPatch(root: MindNode, patch: TreePatch, forward: boolean): MindNode {
  validatePatch(patch);
  const map = records(root);
  for (const change of patch.changes) {
    const expected = forward ? change.before : change.after;
    if (JSON.stringify(map.get(change.id) ?? null) !== JSON.stringify(expected))
      throw new MindError('HISTORY_CONFLICT', '撤销历史与当前节点不一致，本次未修改文稿');
    const next = forward ? change.after : change.before;
    if (next) map.set(change.id, next);
    else map.delete(change.id);
  }
  const seen = new Set<string>();
  function build(id: string): MindNode {
    const record = map.get(id);
    if (!record || seen.has(id)) throw new MindError('INVALID_DOCUMENT', '历史补丁结构错误');
    seen.add(id);
    return { ...structuredClone(record), children: record.children.map(build) };
  }
  const next = build(patch.rootId);
  if (seen.size !== map.size) throw new MindError('INVALID_DOCUMENT', '历史补丁含孤立节点');
  validateRoot(next);
  return next;
}

export function compactHistory(history: History[]): History[] {
  return history.map((entry) =>
    entry.patch
      ? entry
      : {
          id: entry.id,
          label: entry.label,
          time: entry.time,
          patch: treePatch(entry.before, entry.after),
        },
  );
}

/** Bound bytes as well as count; callers adjust their cursor by the removed prefix. */
export function trimHistory(history: History[], keepLatest = false): number {
  let removed = 0;
  while (
    history.length > HISTORY_BATCHES ||
    (history.length > (keepLatest ? 1 : 0) &&
      new TextEncoder().encode(JSON.stringify(history, null, 2)).length > HISTORY_BYTES)
  ) {
    history.shift();
    removed++;
  }
  return removed;
}

/** Derive badges from applied history; no state is persisted on manuscript nodes. */
export function appliedNodeIds(history: History[], cursor: number) {
  const ids = new Set<string>();
  for (const entry of history.slice(0, cursor)) {
    if (!ids.size && entry.label !== 'AI') continue;
    const patch = entry.patch ?? treePatch(entry.before, entry.after);
    for (const change of patch.changes) {
      if (entry.label === 'AI' && change.after) ids.add(change.id);
      else ids.delete(change.id);
    }
  }
  return [...ids];
}
