import { flatten, type MindNode } from '../model.ts';
import { equalRanges } from '../text-diff.ts';
import type { Snapshot } from './types.ts';

export const draftFields = ['title', 'body', 'note'] as const;
export type DraftField = (typeof draftFields)[number];
export type Fields = Partial<Record<DraftField, string>>;
export interface LocalDraft {
  documentId: string;
  path: string;
  revision: number;
  token: string;
  changes: Record<string, Fields>;
  base: Record<string, Fields>;
}
export interface FieldConflict {
  id: string;
  title: string;
  field: DraftField;
  base: string;
  mine: string;
  latest?: string;
}
export type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const prefix = (id: string) => `mindwrite:draft:v1:${encodeURIComponent(id)}:`;

/** Every keystroke is written synchronously, before any debounce or network request. */
export class DraftRepository {
  constructor(private storage: StoragePort) {}
  private keys(documentId: string) {
    return Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i)).filter(
      (key): key is string => !!key?.startsWith(prefix(documentId)),
    );
  }
  save(documentId: string, draft: LocalDraft | null, path = draft?.path) {
    const keep = new Set<string>();
    for (const [id, changes] of Object.entries(draft?.changes ?? {})) {
      if (!Object.keys(changes).length) continue;
      const key =
        prefix(documentId) + encodeURIComponent(draft!.path) + ':' + encodeURIComponent(id);
      keep.add(key);
      this.storage.setItem(
        key,
        JSON.stringify({
          version: 1,
          documentId,
          path: draft!.path,
          revision: draft!.revision,
          token: draft!.token,
          nodeId: id,
          changes,
          base: draft!.base[id],
        }),
      );
    }
    for (const key of this.keys(documentId))
      if (!keep.has(key) && (!path || JSON.parse(this.storage.getItem(key)!).path === path))
        this.storage.removeItem(key);
  }
  load(documentId: string, path?: string): LocalDraft | null {
    let draft: LocalDraft | null = null;
    for (const key of this.keys(documentId)) {
      const value = JSON.parse(this.storage.getItem(key)!);
      if (path !== undefined && value.path !== path) continue;
      if (
        value.version !== 1 ||
        value.documentId !== documentId ||
        typeof value.nodeId !== 'string' ||
        typeof value.path !== 'string' ||
        typeof value.token !== 'string' ||
        !Number.isInteger(value.revision)
      )
        throw new Error('LOCAL_DRAFT_INVALID');
      for (const [field, text] of Object.entries(value.changes ?? {}))
        if (
          !draftFields.includes(field as DraftField) ||
          typeof text !== 'string' ||
          typeof value.base?.[field] !== 'string'
        )
          throw new Error('LOCAL_DRAFT_INVALID');
      draft ??= {
        documentId,
        path: value.path,
        revision: value.revision,
        token: value.token,
        changes: {},
        base: {},
      };
      draft.changes[value.nodeId] = value.changes;
      draft.base[value.nodeId] = value.base;
    }
    return draft;
  }
  acknowledge(sent: LocalDraft, saved: Snapshot) {
    // A closed tab's late response must not erase keystrokes from a reopened tab.
    const current = this.load(sent.documentId, sent.path);
    this.save(sent.documentId, acknowledgeDraft(current, sent, saved), sent.path);
  }
}
export function editDraft(
  snapshot: Snapshot,
  pending: LocalDraft | null,
  node: MindNode,
  field: DraftField,
  value: string,
) {
  const draft: LocalDraft = pending ?? {
    documentId: snapshot.id,
    path: snapshot.path,
    revision: snapshot.revision,
    token: snapshot.token,
    changes: {},
    base: {},
  };
  draft.base[node.id] ??= {};
  draft.base[node.id][field] ??= node[field] ?? '';
  draft.changes[node.id] = { ...draft.changes[node.id], [field]: value };
  return draft;
}
export function mergeDraft(draft: LocalDraft, latest: Snapshot) {
  const nodes = new Map(flatten(latest.root).map(({ node }) => [node.id, node]));
  const merged: LocalDraft = {
    ...draft,
    revision: latest.revision,
    token: latest.token,
    changes: {},
    base: {},
  };
  const conflicts: FieldConflict[] = [];
  for (const [id, fields] of Object.entries(draft.changes)) {
    for (const field of draftFields) {
      const mine = fields[field];
      if (mine === undefined) continue;
      const node = nodes.get(id),
        base = draft.base[id]?.[field] ?? '';
      const current = node ? (node[field] ?? '') : undefined;
      if (mine === base || mine === current) continue;
      merged.changes[id] ??= {};
      merged.base[id] ??= {};
      merged.changes[id][field] = mine;
      merged.base[id][field] = base;
      if (current !== base)
        conflicts.push({ id, field, title: node?.title ?? id, base, mine, latest: current });
      else merged.base[id][field] = current;
    }
  }
  return { draft: Object.keys(merged.changes).length ? merged : null, conflicts };
}
export function acknowledgeDraft(
  pending: LocalDraft | null,
  sent: LocalDraft,
  saved: Snapshot,
): LocalDraft | null {
  if (!pending) return null;
  const next = structuredClone(pending),
    nodes = new Map(flatten(saved.root).map(({ node }) => [node.id, node]));
  next.revision = saved.revision;
  next.token = saved.token;
  for (const [id, fields] of Object.entries(sent.changes)) {
    for (const field of draftFields) {
      if (fields[field] === undefined) continue;
      if (next.changes[id]?.[field] === fields[field]) {
        delete next.changes[id][field];
        delete next.base[id]?.[field];
      } else if (next.changes[id]?.[field] !== undefined)
        next.base[id][field] = nodes.get(id)?.[field] ?? '';
    }
    if (!Object.keys(next.changes[id] ?? {}).length) {
      delete next.changes[id];
      delete next.base[id];
    }
  }
  return Object.keys(next.changes).length ? next : null;
}
/** The conflict UI highlights only differences; it never silently combines the same field. */
export function textDifferences(text: string, other: string) {
  const ranges = equalRanges(text, other),
    parts: { text: string; changed: boolean }[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.before > offset)
      parts.push({ text: text.slice(offset, range.before), changed: true });
    parts.push({ text: text.slice(range.before, range.before + range.length), changed: false });
    offset = range.before + range.length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), changed: true });
  return parts;
}
