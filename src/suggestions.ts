import { checkParagraphChange, paragraphSelection, replaceParagraphs } from './paragraphs.ts';
import { z } from 'zod';
import {
  find,
  flatten,
  MindError,
  nodeInputSchema,
  toInput,
  type MindNode,
  type NodeInput,
  type Operation,
  type Scope,
} from './model.ts';

const addition = z.object({ node: nodeInputSchema, beforeId: z.string().optional() });
export const suggestionSchema = z.discriminatedUnion('field', [
  z.object({
    id: z.string(),
    title: z.string(),
    field: z.enum(['title', 'body', 'note']),
    version: z.number().int().positive().optional(),
    paragraphs: z.array(z.number().int().positive()).min(1).optional(),
    before: z.string(),
    after: z.string(),
  }),
  z.object({
    id: z.string(),
    title: z.string(),
    field: z.literal('children'),
    version: z.number().int().positive().optional(),
    expansion: z.enum(['one', 'articles', 'unlimited']).optional(),
    originalIds: z.array(z.string()),
    additions: z.array(addition).min(1),
  }),
]);
function uniqueIds(items: { id: string }[]) {
  return new Set(items.map((item) => item.id)).size === items.length;
}
export const batchesSchema = z
  .array(
    z.object({
      id: z.string(),
      time: z.string(),
      entries: z.array(suggestionSchema).min(1).max(3000).refine(uniqueIds, '建议条目 ID 重复'),
    }),
  )
  .refine(uniqueIds, '建议批次 ID 重复');
export type SuggestionBatch = z.infer<typeof batchesSchema>[number];
export type Suggestion = SuggestionBatch['entries'][number];
export type ReviewedSuggestion = Suggestion & { digest: string };
export type ReviewedBatch = Omit<SuggestionBatch, 'entries'> & { entries: ReviewedSuggestion[] };
export type ReviewReceipt = Pick<ReviewedSuggestion, 'id' | 'digest'>;
export const editsSchema = z.union([
  z.string().max(200000),
  z.array(nodeInputSchema).min(1).max(1000),
]);
export type SuggestionEdit = z.infer<typeof editsSchema>;
export const reviewDraftSchema = z.object({
  batchId: z.string(),
  id: z.string(),
  digest: z.string(),
  stamp: z.string(),
  value: editsSchema.optional(),
});
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;
export type RevisionPin = ReviewReceipt & { batchId: string; draftStamp?: string };
export interface RevisionTarget extends RevisionPin {
  entry: ReviewedSuggestion;
  edit?: SuggestionEdit;
}
export const reviewKey = (batchId: string, id: string) => JSON.stringify([batchId, id]);

export interface Adoption {
  batchId: string;
  ids: string[];
}

export function suggestedEntries(
  scope: Scope,
  original: MindNode,
  preview: MindNode,
): Suggestion[] {
  const before = new Map(flatten(original).map(({ node }) => [node.id, node]));
  const after = new Map(flatten(preview).map(({ node }) => [node.id, node]));
  const entries: Suggestion[] = [];
  for (const id of scope.ids) {
    const node = before.get(id)!,
      next = after.get(id)!;
    if (scope.mode === 'expand') {
      const originalIds = node.children.map((n) => n.id);
      const additions = next.children.flatMap((child, i) =>
        before.has(child.id)
          ? []
          : [
              {
                node: toInput(child),
                beforeId: next.children.slice(i + 1).find((n) => before.has(n.id))?.id,
              },
            ],
      );
      if (additions.length)
        entries.push({
          id,
          title: node.title,
          field: 'children',
          ...(scope.expansion && scope.expansion !== 'one' && { expansion: scope.expansion }),
          originalIds,
          additions,
        });
    } else {
      const field = scope.mode === 'polish' ? 'body' : scope.mode;
      const paragraphs = scope.paragraphs?.filter((p) => p.nodeId === id).map((p) => p.ordinal);
      if (paragraphs?.length) checkParagraphChange(node.body, next.body, paragraphs);
      if (node[field] !== next[field])
        entries.push({
          id,
          title: node.title,
          field,
          ...(paragraphs?.length ? { paragraphs } : {}),
          before: node[field] ?? '',
          after: next[field] ?? '',
        });
    }
  }
  return entries;
}
export function mergeBatches(queues: SuggestionBatch[][]) {
  const merged = new Map<string, SuggestionBatch>();
  const conflicts = new Set<string>();
  for (const batches of queues) {
    for (const batch of batches) {
      const existing = merged.get(batch.id);
      if (!existing) {
        merged.set(batch.id, batch);
        continue;
      }
      const unique = new Map(existing.entries.map((e) => [e.id, e]));
      for (const entry of batch.entries) {
        const prior = unique.get(entry.id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) conflicts.add(batch.id);
        else unique.set(entry.id, entry);
      }
      merged.set(batch.id, { ...existing, entries: [...unique.values()] });
    }
  }
  for (const id of conflicts) merged.delete(id);
  return { batches: [...merged.values()], conflicts };
}

export function pendingBatches(batches: SuggestionBatch[], done?: Adoption) {
  if (!done) return batches;
  const batch = batches.find((b) => b.id === done.batchId);
  if (!batch) return batches;
  const ids = new Set(done.ids);
  const entries = batch.entries.filter((entry) => !ids.has(entry.id));
  if (entries.length === batch.entries.length) return batches;
  return entries.length
    ? batches.map((b) => (b === batch ? { ...b, entries } : b))
    : batches.filter((b) => b !== batch);
}
export function proposalValue(entry: Suggestion, edit?: SuggestionEdit): SuggestionEdit {
  if (entry.field === 'body' && entry.paragraphs)
    return edit ?? paragraphSelection(entry.after, entry.paragraphs);
  return edit ?? (entry.field === 'children' ? entry.additions.map((a) => a.node) : entry.after);
}
export function adoptionOperations(
  root: MindNode,
  entries: Suggestion[],
  edit?: SuggestionEdit,
): Operation[] {
  if (edit !== undefined && entries.length !== 1)
    throw new MindError('SUGGESTION', '请逐条修改建议');
  const conflict = () =>
    new MindError('CONFLICT', '生成建议后，该处原文已有修改。请保留现稿并重新生成建议。');
  return entries.flatMap<Operation>((e) => {
    const current = find(root, e.id);
    const value = proposalValue(e, edit);
    if (e.field !== 'children') {
      if ((current[e.field] ?? '') !== e.before) throw conflict();
      if (typeof value !== 'string') throw new MindError('SUGGESTION', '请输入建议文字');
      if (e.field === 'body' && e.paragraphs) {
        checkParagraphChange(e.before, e.after, e.paragraphs);
        return [
          { type: 'update', id: e.id, body: replaceParagraphs(current.body, e.paragraphs, value) },
        ];
      }
      return [{ type: 'update', id: e.id, [e.field]: value }];
    }
    const ids = current.children.map((n) => n.id);
    if (JSON.stringify(ids) !== JSON.stringify(e.originalIds)) throw conflict();
    if (!Array.isArray(value) || value.length !== e.additions.length)
      throw new MindError('SUGGESTION', '请逐项核对新增结构');
    return e.additions.map(({ beforeId }, i) => {
      const index = beforeId ? ids.indexOf(beforeId) : ids.length;
      if (index < 0) throw conflict();
      ids.splice(index, 0, '');
      return { type: 'add', parentId: e.id, index, nodes: [value[i]] };
    });
  });
}
export function outlineText(nodes: NodeInput[], depth = 0): string {
  return nodes
    .map((node) =>
      [
        `${'　'.repeat(depth)}${node.title}`,
        node.body,
        node.note && `（${node.note}）`,
        outlineText(node.children ?? [], depth + 1),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
}
