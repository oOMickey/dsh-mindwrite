import type { ParagraphGrant } from './paragraphs.ts';
import type { ProfileFields } from './document-profile.ts';
import { z } from 'zod';
import { validatePatch, type TreePatch } from './history.ts';
import type { Adoption, RevisionTarget } from './suggestions.ts';
import { confirmReference, type ReferenceConfirmation } from './references.ts';
import {
  importReportSchema,
  importNumberingSchema,
  type ImportNumbering,
  referenceSchema,
  sourceNumberSchema,
  type ImportReport,
  type BoundReference,
  type SourceNumber,
} from './metadata.ts';

export interface MindNode {
  id: string;
  title: string;
  body: string;
  note?: string;
  kind?: 'preamble';
  titleSource?: 'auto';
  sourceNumber?: SourceNumber;
  references?: BoundReference[];
  referenceText?: string;
  sourceIds?: string[];
  sourceText?: string;
  /** Prefix verified against the Word heading's position at import, including an empty literal prefix. */
  wordTitlePrefix?: string;
  /** Where Word supplied the leading number: a separate heading run or a retained literal clause. */
  wordNumber?: { field: 'title' | 'body'; text: string };
  collapsed: boolean;
  children: MindNode[];
}
export interface NodeInput {
  title: string;
  body?: string;
  note?: string;
  kind?: 'preamble';
  titleSource?: 'auto';
  sourceNumber?: SourceNumber;
  children?: NodeInput[];
}
export type Operation =
  | {
      type: 'update';
      id: string;
      title?: string;
      body?: string;
      note?: string;
      collapsed?: boolean;
    }
  | { type: 'add'; parentId: string; index?: number; nodes: NodeInput[] }
  | { type: 'move'; id: string; parentId: string; index?: number }
  | ({ type: 'confirm-reference' } & ReferenceConfirmation)
  | { type: 'delete'; id: string }
  | { type: 'merge'; ids: string[]; targetId: string };
export type History = {
  id: string;
  label: string;
  time: string;
} & (
  | { patch: TreePatch; before?: never; after?: never }
  | { before: MindNode; after: MindNode; patch?: never }
);
export interface BackupCopy {
  fileKey: string;
  sha256: string;
}
export interface BackupReceipt extends BackupCopy {
  version: '0.7.2' | '0.7.3';
  adoptionPair?: { document: BackupCopy; suggestions: BackupCopy & { path?: string } };
  adoptionQueues?: (BackupCopy & { path: string })[];
}
export interface MindDocument extends ProfileFields {
  format: 1;
  id: string;
  revision: number;
  root: MindNode;
  history: History[];
  cursor: number;
  importReport?: ImportReport;
  importNumbering?: ImportNumbering;
  historyLimited?: boolean;
  sourceRoot?: MindNode;
  lastAdoption?: Adoption;
  backupReceipt?: BackupReceipt;
  backupReceipt073?: BackupReceipt;
  backupReceiptHistory073?: BackupReceipt[];
  expansionDefault?: Expansion;
}
export type Expansion = 'one' | 'articles' | 'unlimited';
export interface Scope {
  revisions?: RevisionTarget[];
  revisionToken?: string;
  quoteMessage?: string;
  paragraphs?: ParagraphGrant[];
  expansion?: Expansion;
  sessionId: string;
  key: string;
  ids: string[];
  mode: 'polish' | 'expand' | 'title' | 'note';
  batch: string;
  cancelled?: boolean;
  breached?: boolean;
  instruction?: string;
  documentPath?: string;
}
export class MindError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MindError';
  }
}
export const nodeInputSchema: z.ZodType<NodeInput> = z.lazy(() =>
  z
    .object({
      title: z.string().min(1).max(500),
      body: z.string().max(200000).optional(),
      note: z.string().max(200000).optional(),
      kind: z.literal('preamble').optional(),
      titleSource: z.literal('auto').optional(),
      sourceNumber: sourceNumberSchema.optional(),
      children: z.array(nodeInputSchema).max(1000).optional(),
    })
    .strict(),
);
export const operationSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('update'),
      id: z.string(),
      title: z.string().min(1).max(500).optional(),
      body: z.string().max(200000).optional(),
      note: z.string().max(200000).optional(),
      collapsed: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('add'),
      parentId: z.string(),
      index: z.number().int().nonnegative().optional(),
      nodes: z.array(nodeInputSchema).min(1).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal('move'),
      id: z.string(),
      parentId: z.string(),
      index: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal('delete'), id: z.string() }).strict(),
  z
    .object({
      type: z.literal('merge'),
      ids: z.array(z.string()).min(2).max(1000),
      targetId: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('confirm-reference'),
      id: z.string(),
      referenceId: z.string(),
      targetId: z.string(),
      itemId: z.string().optional(),
    })
    .strict(),
]);
export function makeNode(input: NodeInput): MindNode {
  return {
    id: crypto.randomUUID(),
    title: input.title,
    body: input.body ?? '',
    note: input.note ?? '',
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.titleSource ? { titleSource: input.titleSource } : {}),
    ...(input.sourceNumber ? { sourceNumber: input.sourceNumber } : {}),
    collapsed: false,
    children: (input.children ?? []).map(makeNode),
  };
}
export function newDocument(title: string, children: NodeInput[] = []): MindDocument {
  return {
    format: 1,
    id: crypto.randomUUID(),
    revision: 0,
    root: makeNode(nodeInputSchema.parse({ title, children })),
    history: [],
    cursor: 0,
  };
}
export function flatten(
  root: MindNode,
  visible = false,
): { node: MindNode; parent?: MindNode; depth: number; path: string }[] {
  const rows: ReturnType<typeof flatten> = [];
  function walk(node: MindNode, depth: number, path: string, parent?: MindNode) {
    rows.push({ node, depth, parent, path });
    if (!visible || !node.collapsed)
      node.children.forEach((c, i) => walk(c, depth + 1, `${path}/${i + 1}`, node));
  }
  walk(root, 0, '0');
  return rows;
}
export function find(root: MindNode, id: string): MindNode {
  const row = flatten(root).find((r) => r.node.id === id);
  if (!row) throw new MindError('NOT_FOUND', `找不到节点 ${id}`);
  return row.node;
}
export function validateRoot(root: MindNode): void {
  const ids = new Set<string>();
  let count = 0;
  let chars = 0;
  function visit(n: MindNode, depth: number) {
    if (depth > 20 || ++count > 3000) throw new MindError('LIMIT', '文档最多 3000 节点、20 层');
    if (
      !n ||
      typeof n.id !== 'string' ||
      !n.id ||
      ids.has(n.id) ||
      typeof n.title !== 'string' ||
      !n.title ||
      n.title.length > 500 ||
      typeof n.body !== 'string' ||
      (n.note !== undefined && typeof n.note !== 'string') ||
      typeof n.collapsed !== 'boolean' ||
      !Array.isArray(n.children)
    )
      throw new MindError('INVALID_DOCUMENT', '节点格式错误或 id 重复');
    ids.add(n.id);
    if (n.kind !== undefined && (n.kind !== 'preamble' || depth !== 1 || n.children.length))
      throw new MindError('PREAMBLE', '序言须位于文稿一级，且不包含下级节点');
    if (n.titleSource !== undefined && n.titleSource !== 'auto')
      throw new MindError('INVALID_DOCUMENT', '标题来源格式错误');
    if (n.sourceNumber) sourceNumberSchema.parse(n.sourceNumber);
    if (n.references) z.array(referenceSchema).max(10000).parse(n.references);
    if (n.referenceText !== undefined && typeof n.referenceText !== 'string')
      throw new MindError('INVALID_DOCUMENT', '引用原文格式错误');
    if (n.sourceIds) z.array(z.string().min(1)).max(3000).parse(n.sourceIds);
    if (n.sourceText !== undefined) z.string().max(200000).parse(n.sourceText);
    if (n.wordNumber !== undefined)
      z.object({ field: z.enum(['title', 'body']), text: z.string().min(1).max(500) }).parse(
        n.wordNumber,
      );
    if (n.wordTitlePrefix !== undefined) z.string().max(500).parse(n.wordTitlePrefix);
    chars += n.body.length + n.title.length + (n.note?.length ?? 0);
    n.children.forEach((c) => visit(c, depth + 1));
  }
  visit(root, 0);
  if (chars > 2000000) throw new MindError('LIMIT', '文档总字数超过 200 万');
}
export function parseDocument(text: string): MindDocument {
  const d: MindDocument = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (
    d.format !== 1 ||
    typeof d.id !== 'string' ||
    !Number.isInteger(d.revision) ||
    d.revision < 0 ||
    !Array.isArray(d.history) ||
    !Number.isInteger(d.cursor) ||
    d.cursor < 0 ||
    d.cursor > d.history.length ||
    d.history.length > 40
  )
    throw new MindError('INVALID_DOCUMENT', '不支持的导图文档格式');
  validateRoot(d.root);
  if (d.sourceRoot) validateRoot(d.sourceRoot);
  // 0.6 review entries describe edits already in the tree. Keep that tree and its
  // undo history, retire only the post-write bookkeeping on the next real save.
  delete (d as MindDocument & { aiReviews?: unknown }).aiReviews;
  if (d.lastAdoption)
    z.object({ batchId: z.string(), ids: z.array(z.string()).max(3000) }).parse(d.lastAdoption);
  if (d.expansionDefault) z.enum(['one', 'articles', 'unlimited']).parse(d.expansionDefault);
  if (d.importReport) importReportSchema.parse(d.importReport);
  if (d.importNumbering !== undefined) importNumberingSchema.parse(d.importNumbering);
  d.history.forEach((h) => {
    if (typeof h.id !== 'string' || typeof h.label !== 'string')
      throw new MindError('INVALID_DOCUMENT', '历史格式错误');
    if (h.patch) validatePatch(h.patch);
    else {
      validateRoot(h.before);
      validateRoot(h.after);
    }
  });
  return d;
}
export function checkScope(scope: Scope, operations: Operation[]): void {
  if (scope.cancelled) throw new MindError('CANCELLED', '本次 AI 操作已取消');
  for (const op of operations) {
    const allowed =
      scope.mode === 'expand'
        ? op.type === 'add' && scope.ids.includes(op.parentId)
        : op.type === 'update' &&
          scope.ids.includes(op.id) &&
          op.collapsed === undefined &&
          (scope.mode === 'note'
            ? op.body === undefined && op.title === undefined && op.note !== undefined
            : op.note === undefined &&
              (scope.mode === 'title'
                ? op.body === undefined && op.title !== undefined
                : op.title === undefined && op.body !== undefined));
    if (!allowed)
      throw new MindError(
        'SCOPE_VIOLATION',
        '越界：本次只允许修改选中的节点与获准字段，整批未保存',
      );
  }
}
/** Apply a complete batch to a copy, so any rejection leaves the source unchanged. */
export function applyOperations(root: MindNode, input: Operation[], scope?: Scope): MindNode {
  const operations = z.array(operationSchema).min(1).max(1000).parse(input);
  if (scope) checkScope(scope, operations);
  const next = structuredClone(root);
  for (const op of operations) {
    if (op.type === 'update') {
      const n = find(next, op.id);
      if (op.title !== undefined && op.title !== n.title) {
        n.title = op.title;
        delete n.wordTitlePrefix;
        if (n.wordNumber?.field === 'title' && !n.title.startsWith(n.wordNumber.text))
          delete n.wordNumber;
      }
      if (op.body !== undefined) {
        n.body = op.body;
        if (n.wordNumber?.field === 'body' && !n.body.startsWith(n.wordNumber.text))
          delete n.wordNumber;
      }
      if (op.note !== undefined) n.note = op.note;
      if (op.collapsed !== undefined) n.collapsed = op.collapsed;
    } else if (op.type === 'confirm-reference') {
      confirmReference(next, op);
    } else if (op.type === 'add') {
      const p = find(next, op.parentId);
      p.children.splice(
        Math.min(op.index ?? p.children.length, p.children.length),
        0,
        ...op.nodes.map(makeNode),
      );
      p.collapsed = false;
    } else if (op.type === 'merge') {
      const ids = [...new Set(op.ids)],
        rows = flatten(next),
        target = rows.find((r) => r.node.id === op.targetId);
      const selected = ids.map((id) => rows.find((r) => r.node.id === id));
      if (
        ids.length < 2 ||
        !ids.includes(op.targetId) ||
        !target?.parent ||
        selected.some(
          (r) => !r?.parent || r.depth !== target.depth || r.node.kind === 'preamble',
        ) ||
        selected.some((r) =>
          selected.some(
            (other) =>
              other !== r && flatten(r!.node).some((child) => child.node.id === other!.node.id),
          ),
        )
      )
        throw new MindError('MERGE', '请选中至少两个同级条款，并以选中的第一条作为合并目标');
      const ordered = rows.filter((r) => ids.includes(r.node.id));
      target.node.body = ordered
        .map((r) => r.node.body)
        .filter(Boolean)
        .join('\n');
      target.node.note = ordered
        .map((r) => r.node.note)
        .filter(Boolean)
        .join('\n');
      target.node.sourceIds = [...new Set(ordered.flatMap((r) => r.node.sourceIds ?? [r.node.id]))];
      const mergedChildren = ordered.flatMap((r) => r.node.children);
      for (const row of ordered)
        if (row !== target) row.parent!.children.splice(row.parent!.children.indexOf(row.node), 1);
      target.node.children = mergedChildren;
    } else {
      const row = flatten(next).find((r) => r.node.id === op.id);
      if (!row) throw new MindError('NOT_FOUND', '找不到节点');
      if (!row.parent) throw new MindError('ROOT', '不能移动或删除文档根节点');
      if (op.type === 'move') {
        const parent = find(next, op.parentId);
        if (flatten(row.node).some((r) => r.node.id === parent.id))
          throw new MindError('CYCLE', '不能移动到自己或后代中');
        row.parent.children.splice(row.parent.children.indexOf(row.node), 1);
        parent.children.splice(
          Math.min(op.index ?? parent.children.length, parent.children.length),
          0,
          row.node,
        );
        parent.collapsed = false;
      } else row.parent.children.splice(row.parent.children.indexOf(row.node), 1);
    }
  }
  validateRoot(next);
  return next;
}
export function outline(root: MindNode) {
  return flatten(root).map(({ node, depth, path }) => ({
    id: node.id,
    title: node.title,
    depth,
    path,
    bodySummary: node.body.slice(0, 160),
    note: node.note ?? '',
    ...(node.kind ? { kind: node.kind } : {}),
    ...(node.titleSource ? { titleSource: node.titleSource } : {}),
    ...(node.sourceNumber ? { sourceNumber: node.sourceNumber } : {}),
  }));
}

export function toInput(node: MindNode): NodeInput {
  return {
    title: node.title,
    body: node.body,
    note: node.note ?? '',
    children: node.children.map(toInput),
  };
}
