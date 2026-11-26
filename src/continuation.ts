import { flatten, MindError, type MindNode, type Scope } from './model.ts';
import { zh } from './locales.ts';
import { checkParagraphChange, paragraphSelection, replaceParagraphs } from './paragraphs.ts';
import {
  outlineText,
  type ReviewedSuggestion,
  type Suggestion,
  type SuggestionBatch,
  type SuggestionEdit,
} from './suggestions.ts';

export function reviewRange(entry: Suggestion) {
  if (entry.field === 'body' && entry.paragraphs)
    return entry.paragraphs.map((n) => `第 ${n} 段`).join('、');
  return { body: '正文', title: '标题', note: '写作说明', children: '新增下级' }[entry.field];
}

export function scopeMatches(
  scope: Pick<Scope, 'mode' | 'ids' | 'paragraphs'>,
  batches: SuggestionBatch[],
) {
  const field = { polish: 'body', expand: 'children', title: 'title', note: 'note' }[scope.mode];
  const ids = new Set(scope.ids);
  return batches.flatMap((b) =>
    b.entries.flatMap((entry) => {
      if (!ids.has(entry.id) || entry.field !== field) return [];
      const requested =
        scope.paragraphs?.filter((p) => p.nodeId === entry.id).map((p) => p.ordinal) ?? [];
      const existing = entry.field === 'body' ? (entry.paragraphs ?? []) : [];
      if (requested.length && existing.length && !requested.some((n) => existing.includes(n)))
        return [];
      return [
        {
          batchId: b.id,
          entry,
          exact:
            existing.length === requested.length && existing.every((n) => requested.includes(n)),
        },
      ];
    }),
  );
}

export function overlapError(matches: ReturnType<typeof scopeMatches>, root: MindNode) {
  const paths = new Map(
    flatten(root).map(({ node, path }) => [node.id, path.slice(2).replaceAll('/', '.')]),
  );
  const unique = new Map(matches.map((m) => [JSON.stringify([m.batchId, m.entry.id]), m.entry]));
  const locations = [...unique.values()].map((entry) =>
    [paths.get(entry.id), entry.title, reviewRange(entry) + '已有待审稿']
      .filter(Boolean)
      .join(' · '),
  );
  return new MindError('REVIEW_OVERLAP', locations.join('；') + '：先采用或不要，或点它继续改');
}

export const updatedSuggestion = () =>
  new MindError('REVIEW_CHANGED', '这条建议已更新，请重新点选。');
export const processedSuggestion = () =>
  new MindError('REVIEW_GONE', '这条建议已处理，请重新点选。');
export const changedDraft = () =>
  new MindError('REVIEW_DRAFT', '这条建议的手改稿已变化，请点待审稿或“继续改”重新选择。');

export function verifyOriginal(root: MindNode, entry: Suggestion) {
  const node = flatten(root).find(({ node }) => node.id === entry.id)?.node;
  if (!node) throw new MindError('REVIEW_GONE', zh.reviewTargetDeleted);
  if (entry.field === 'children') {
    if (
      JSON.stringify(node.children.map((c) => c.id)) !== JSON.stringify(entry.originalIds) ||
      entry.additions.some(
        (a) => a.beforeId !== undefined && !entry.originalIds.includes(a.beforeId),
      )
    )
      throw updatedSuggestion();
  } else {
    if ((node[entry.field] ?? '') !== entry.before) throw updatedSuggestion();
    if (entry.field === 'body' && entry.paragraphs)
      checkParagraphChange(entry.before, entry.after, entry.paragraphs);
  }
}

export function revisionBase(entry: Suggestion, edited?: SuggestionEdit) {
  if (edited === undefined)
    return entry.field === 'children' ? entry.additions.map((a) => a.node) : entry.after;
  if (entry.field === 'children') {
    if (!Array.isArray(edited) || edited.length !== entry.additions.length) throw changedDraft();
    return edited;
  }
  if (typeof edited !== 'string') throw changedDraft();
  return entry.field === 'body' && entry.paragraphs
    ? replaceParagraphs(entry.before, entry.paragraphs, edited)
    : edited;
}

export function pendingSummary(entry: ReviewedSuggestion) {
  const preview = (text: string) => Array.from(text).slice(0, 100).join('');
  const excerpt = (text: string) => {
    try {
      return preview(
        entry.field === 'body' && entry.paragraphs
          ? paragraphSelection(text, entry.paragraphs)
          : text,
      );
    } catch {
      return '原段落范围已变化，请在抽屉中核对';
    }
  };
  return {
    title: entry.title,
    range: reviewRange(entry),
    field: entry.field,
    before:
      entry.field === 'children'
        ? `原有 ${entry.originalIds.length} 个下级`
        : excerpt(entry.before),
    after:
      entry.field === 'children'
        ? preview(outlineText(entry.additions.map((a) => a.node)))
        : excerpt(entry.after),
  };
}
