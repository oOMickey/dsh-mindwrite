import { z } from 'zod';
import {
  changedDraft,
  processedSuggestion,
  overlapError,
  revisionBase,
  scopeMatches,
  updatedSuggestion,
  verifyOriginal,
} from './continuation.ts';
import { checkParagraphChange, paragraphSelection } from './paragraphs.ts';
import { planPaste, type PasteCommand, type PasteTarget, type PasteReceipt } from './paste-tree.ts';
import type { ProfileFields, DocumentType, Numbering } from './document-profile.ts';
import { ProgressiveGeneration } from './progressive.ts';
import { importNumberingSchema, type ImportNumbering, type ImportReport } from './metadata.ts';
import { createHash } from 'node:crypto';
import { applyPatch, treePatch, compactHistory, trimHistory } from './history.ts';
import {
  adoptionOperations,
  batchesSchema,
  mergeBatches,
  reviewDraftSchema,
  reviewKey,
  suggestionSchema,
  type ReviewDraft,
  type RevisionPin,
  type RevisionTarget,
  type Suggestion,
  pendingBatches,
  suggestedEntries,
  type ReviewReceipt,
  type ReviewedBatch,
  type SuggestionBatch,
  type SuggestionEdit,
} from './suggestions.ts';
import {
  applyOperations,
  checkScope,
  find,
  MindError,
  newDocument,
  parseDocument,
  type BackupCopy,
  type BackupReceipt,
  type MindDocument,
  type MindNode,
  validateRoot,
  type NodeInput,
  type Operation,
  type Scope,
} from './model.ts';

export type Commit = (text: string, check?: () => void, signal?: AbortSignal) => Promise<void>;
export type ReviewFileKind =
  'review-state' | 'withheld' | 'deferred' | 'paragraph-suggestions' | 'paragraph-deferred';
export interface BackupDisk {
  workspacePath?(key: string, sessionId: string): Promise<string>;
  identity?(name: string, sessionId: string): Promise<string | undefined>;
  fileKey(key: string, sessionId: string, documentId: string): Promise<string>;
  read(name: string, sessionId: string): Promise<string | undefined>;
  write(name: string, text: string, previous: string | undefined, sessionId: string): Promise<void>;
}
export interface Disk {
  backups?: BackupDisk;
  prepare?(key: string, previous: string | undefined, sessionId: string): Promise<Commit>;
  read(key: string): Promise<string | undefined>;
  reviewKey?(
    key: string,
    sessionId: string,
    documentId: string,
    kind: ReviewFileKind,
  ): Promise<string>;
  suggestionKeys?(key: string, sessionId: string, documentId: string): Promise<string[]>;
  version?(key: string): Promise<string | undefined>;
  write(key: string, text: string, previous: string | undefined, sessionId?: string): Promise<void>;
}
export interface Version {
  revision: number;
  token: string;
}
export interface Snapshot extends Version {
  document: MindDocument;
  text: string;
}
export function token(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}
export interface IntegrityAlert {
  id: string;
  kind: 'restored' | 'failed' | 'staging' | 'external';
  message: string;
  /** Original turn for the receipt if the user retries a failed publication. */
  turn?: number;
}
interface SuggestionFile {
  documentId: string;
  path: string;
  text?: string;
  stored: SuggestionBatch[];
  batches: SuggestionBatch[];
  corrupt?: boolean;
}
interface Protection {
  scope: Scope;
  snapshot: Snapshot;
  controller: AbortController;
  journal?: string;
  publishedAt?: string;
  finishing?: boolean;
  batch?: SuggestionBatch;
  publication?: { status: 'staged' } | { status: 'failed'; error: unknown };
  addedRequests?: Set<string>;
  revised?: Map<string, Suggestion>;
  replaced?: Map<string, { old: Suggestion; version: number; hash: string }>;
}
// Archived readers reserialize entries without optional fields. Bind each reserved version
// to its actual queue contents on either side of the conditional sidecar replacement.
const edition = z.object({
  version: z.number().int().nonnegative(),
  hash: z.string(),
  expansion: z.enum(['one', 'articles', 'unlimited']).optional(),
});
const reviewMetadata = z.object({
  drafts: z.array(reviewDraftSchema),
  editions: z.record(z.string(), z.array(edition).max(2)),
});
type Editions = z.infer<typeof reviewMetadata>['editions'];
function editionOf(entry: Suggestion) {
  const { version = 0, ...fields } = entry;
  const expansion = fields.field === 'children' ? fields.expansion : undefined;
  if (fields.field === 'children') delete fields.expansion;
  return { version, hash: token(JSON.stringify(fields)), expansion };
}
export interface ToolWriteReceipt {
  scope: Scope;
  before: string;
  after: string;
  version: string;
}
export class DocumentStore {
  readonly scopes = new Map<string, Scope>();
  readonly alerts = new Map<string, IntegrityAlert>();
  onIntegrityAlert?: (sessionId: string, alert: IntegrityAlert) => void;
  private protections = new Map<string, Protection>();
  private previews = new Map<string, MindNode>();
  private queues = new Map<string, Promise<unknown>>();
  private cache = new Map<string, { version?: string; snapshot: Snapshot }>();
  private verifiedCopies = new Map<string, string>();
  constructor(private disk: Disk) {}
  async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(work);
    this.queues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(key) === pending) this.queues.delete(key);
    }
  }
  private prepare(key: string, previous: string | undefined, sessionId: string): Promise<Commit> {
    if (this.disk.prepare) return this.disk.prepare(key, previous, sessionId);
    return Promise.resolve(async (text, check) => {
      check?.();
      await this.disk.write(key, text, previous, sessionId);
    });
  }
  private copyName(copy: BackupCopy) {
    return `0.7.3-${copy.fileKey}-${copy.sha256}.json`;
  }
  private async hasCopy(copy: BackupCopy, sessionId: string) {
    const disk = this.disk.backups!,
      name = this.copyName(copy);
    let identity = await disk.identity?.(name, sessionId);
    if (identity && this.verifiedCopies.get(identity) === copy.sha256) return true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await disk.read(name, sessionId);
      if (raw === undefined) return false;
      if (disk.identity) {
        const after = await disk.identity(name, sessionId);
        if (!after || after !== identity) {
          identity = after;
          continue;
        }
      }
      if (token(raw) !== copy.sha256) throw new MindError('BACKUP', '备份校验失败，原件未覆盖');
      if (identity) {
        this.verifiedCopies.set(identity, copy.sha256);
        if (this.verifiedCopies.size > 100)
          this.verifiedCopies.delete(this.verifiedCopies.keys().next().value!);
      }
      return true;
    }
    throw new MindError('BACKUP', '备份在校验期间持续变化，原件未覆盖');
  }
  private async copy(fileKey: string, raw: string, sessionId: string): Promise<BackupCopy> {
    const copy = { fileKey, sha256: token(raw) };
    if (!(await this.hasCopy(copy, sessionId))) {
      try {
        await this.disk.backups!.write(this.copyName(copy), raw, undefined, sessionId);
      } catch (error) {
        // A second session may have created exactly the same immutable copy.
        if (!(await this.hasCopy(copy, sessionId))) throw error;
      }
      if (!(await this.hasCopy(copy, sessionId))) throw new MindError('BACKUP', '无法读回原件备份');
    }
    return copy;
  }
  private async protectOriginals(
    key: string,
    sessionId: string,
    original: string,
    d: MindDocument,
    sides: SuggestionFile[] = [],
  ) {
    if (!this.disk.backups) return;
    const fileKey = await this.disk.backups.fileKey(key, sessionId, d.id);
    const receipt = d.backupReceipt073;
    const sameFile = receipt?.fileKey === fileKey;
    const hasMain =
      receipt?.version === '0.7.3' &&
      sameFile &&
      /^[a-f0-9]{64}$/.test(receipt.sha256) &&
      (await this.hasCopy(receipt, sessionId));
    if (hasMain && !sides.length) return;
    let local = sameFile ? receipt : undefined;
    const pair = local?.adoptionPair;
    if (pair) {
      try {
        if (pair.document?.fileKey !== fileKey || !pair.suggestions)
          throw new MindError('BACKUP', '首次采用的配对回执无效，请核对备份目录');
        const hasDocument = await this.hasCopy(pair.document, sessionId);
        const hasSuggestions = await this.hasCopy(pair.suggestions, sessionId);
        if (!hasDocument || !hasSuggestions) local = undefined;
      } catch (error) {
        // An ordinary edit needs only the main backup. Leave an unreadable pair for adoption to verify.
        if (sides.length) throw error;
      }
    }
    // A copied manuscript can have the same file key but no local adoption backups.
    if (receipt?.adoptionPair && !local) (d.backupReceiptHistory073 ??= []).push(receipt);
    const main = hasMain ? receipt : await this.copy(fileKey, original, sessionId);
    d.backupReceipt073 = {
      ...local,
      version: '0.7.3',
      fileKey,
      sha256: main.sha256,
    };
    for (const side of sides) await this.protectPair(d.backupReceipt073, original, side, sessionId);
  }
  private async protectPair(
    receipt: BackupReceipt,
    original: string,
    side: SuggestionFile,
    sessionId: string,
  ) {
    const backups = this.disk.backups;
    if (!backups || side.text === undefined) return;
    const sideKey = await backups.fileKey(side.path, sessionId, side.documentId);
    const existing = receipt.adoptionPair;
    if (existing) {
      if (existing.suggestions.fileKey === sideKey) return;
      const saved = receipt.adoptionQueues?.find((copy) => copy.fileKey === sideKey);
      if (saved) {
        if (!(await this.hasCopy(saved, sessionId)))
          throw new MindError('BACKUP', `建议队列 ${saved.path} 的备份缺失，请核对备份目录`);
        return;
      }
    }
    const suggestions = {
      ...(await this.copy(sideKey, side.text, sessionId)),
      path: (await backups.workspacePath?.(side.path, sessionId)) ?? side.path,
    };
    if (existing) {
      (receipt.adoptionQueues ??= []).push(suggestions);
      return;
    }
    const pair = {
      document: await this.copy(receipt.fileKey, original, sessionId),
      suggestions,
    };
    // Copy names identify the pair even if the main commit is interrupted.
    const record = JSON.stringify(pair);
    const pairName = `0.7.3-${pair.document.fileKey}-pair-${token(record)}.json`;
    const old = await backups.read(pairName, sessionId);
    if (old === undefined) await backups.write(pairName, record, undefined, sessionId);
    if ((await backups.read(pairName, sessionId)) !== record)
      throw new MindError('BACKUP', '采用前的配对备份校验失败');
    receipt.adoptionPair = pair;
  }
  async read(key: string): Promise<Snapshot> {
    const version = await this.disk.version?.(key);
    const cached = this.cache.get(key);
    if (version !== undefined && cached?.version === version) return cached.snapshot;
    const text = await this.disk.read(key);
    if (text === undefined) throw new MindError('NOT_FOUND', '导图文件不存在');
    const document = parseDocument(text);
    const snapshot = { document, revision: document.revision, token: token(text), text };
    this.cache.set(key, { version, snapshot });
    if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
    return snapshot;
  }
  async create(
    key: string,
    title: string,
    children: NodeInput[] = [],
    sessionId?: string,
    profile?: ProfileFields,
  ): Promise<Snapshot> {
    return this.createDocument(key, { ...newDocument(title, children), ...profile }, sessionId);
  }
  async import(
    key: string,
    root: MindNode,
    importReport: ImportReport,
    sessionId: string,
    profile?: ProfileFields,
    importNumbering?: ImportNumbering,
  ): Promise<Snapshot> {
    validateRoot(root);
    if (importNumbering) importNumberingSchema.parse(importNumbering);
    const document = {
      ...newDocument(root.title),
      ...profile,
      root,
      sourceRoot: structuredClone(root),
      importReport,
      ...(importNumbering && { importNumbering }),
    };
    return this.createDocument(key, document, sessionId);
  }
  private async createDocument(
    key: string,
    document: MindDocument,
    sessionId?: string,
  ): Promise<Snapshot> {
    return this.serial(key, async () => {
      if ((await this.disk.read(key)) !== undefined)
        throw new MindError('EXISTS', '同名文件已存在，请换一个文件名');
      const text = JSON.stringify(document, null, 2) + '\n';
      await this.disk.write(key, text, undefined, sessionId);
      return { document, revision: 0, token: token(text), text };
    });
  }
  lock(scope: Scope, snapshot: Snapshot) {
    if (
      this.protections.has(scope.sessionId) ||
      [...this.scopes.values()].some((s) => s.key === scope.key)
    )
      throw new MindError('LOCKED', '已有 AI 操作正在进行');
    if (!scope.ids.length) throw new MindError('SELECTION', '请先选择节点');
    scope.ids.forEach((id) => find(snapshot.document.root, id));
    for (const p of scope.paragraphs ?? []) {
      if (
        scope.mode !== 'polish' ||
        !scope.ids.includes(p.nodeId) ||
        paragraphSelection(find(snapshot.document.root, p.nodeId).body, [p.ordinal]) !== p.original
      )
        throw new MindError('SCOPE_VIOLATION', '引用段落的原文已改变。');
    }
    this.alerts.delete(scope.sessionId);
    this.protections.set(scope.sessionId, {
      scope,
      snapshot,
      controller: new AbortController(),
    });
    this.scopes.set(scope.sessionId, scope);
  }
  lockedSnapshot(scope: Scope) {
    const active = this.protections.get(scope.sessionId);
    return active?.scope === scope ? active.snapshot : undefined;
  }
  cancelScope(sessionId: string) {
    const active = this.protections.get(sessionId);
    if (active) {
      active.scope.cancelled = true;
      active.controller.abort();
    }
  }
  async verifyScope(
    sessionId: string,
    write?: ToolWriteReceipt,
  ): Promise<IntegrityAlert | undefined> {
    const protectedFile = this.protections.get(sessionId);
    if (!protectedFile || !this.scopes.has(sessionId)) return;
    return this.serial(protectedFile.scope.key, async () => {
      if (this.protections.get(sessionId) !== protectedFile) return;
      return this.verifyProtected(protectedFile, undefined, write);
    });
  }
  private async verifyProtected(
    protectedFile: Protection,
    observed?: { text: string | undefined },
    write?: ToolWriteReceipt,
  ): Promise<IntegrityAlert | undefined> {
    const {
      scope,
      snapshot: { text: before, token: expected },
    } = protectedFile;
    if (this.scopes.get(scope.sessionId) !== scope) return;
    const prior = this.alerts.get(scope.sessionId);
    if (scope.breached && prior?.kind === 'external') return prior;
    let alert: IntegrityAlert;
    let recovery: string | undefined;
    try {
      let current: string | undefined;
      let unreadable = false;
      try {
        current = observed ? observed.text : await this.disk.read(scope.key);
      } catch {
        unreadable = true;
      }
      if (
        current !== undefined &&
        token(current) === expected &&
        this.alerts.get(scope.sessionId)?.kind !== 'failed'
      )
        return;
      this.cancelScope(scope.sessionId);
      scope.breached = true;
      if (this.disk.backups) {
        const trusted = parseDocument(before);
        const fileKey = await this.disk.backups.fileKey(scope.key, scope.sessionId, trusted.id);
        recovery = this.copyName(await this.copy(fileKey, before, scope.sessionId));
      }
      // Never treat a failed decode, size check or read as an absent file.
      if (unreadable) throw new MindError('FILE', '无法核实受保护文件的原始内容');
      let restored = false;
      if (
        current !== before &&
        write?.scope === scope &&
        write.before === before &&
        write.after === current &&
        (await this.disk.version?.(scope.key)) === write.version
      ) {
        const commit = await this.prepare(scope.key, current, scope.sessionId);
        // prepare binds the replacement to its observed version. A fresh save,
        // even with identical bytes, invalidates the tool's publication receipt.
        if ((await this.disk.version?.(scope.key)) === write.version) {
          await commit(before);
          restored = true;
        }
      }
      this.cache.delete(scope.key);
      if (current !== before && !restored) {
        alert = {
          id: crypto.randomUUID(),
          kind: 'external',
          message:
            '主稿写入来源未能确认，已保留磁盘现场并取消本批建议。' +
            (recovery ? `任务开始时的快照已另存于 .mindwrite/backups/${recovery}。` : '') +
            '请核对主稿后重新生成建议。',
        };
      } else {
        alert = {
          id: crypto.randomUUID(),
          kind: 'restored',
          message: restored
            ? '检测到本次工具越权写入，已恢复任务开始前的主稿，并取消本批建议。'
            : '主稿已可读取，内容与任务快照一致。本批建议已取消。',
        };
      }
    } catch {
      this.cancelScope(scope.sessionId);
      scope.breached = true;
      alert = {
        id: crypto.randomUUID(),
        kind: 'failed',
        message:
          '安全告警：无法安全恢复当前文件，文稿已锁定。' +
          (recovery
            ? `任务开始时的原件已保存于 .mindwrite/backups/${recovery}。`
            : '请保留现场并检查备份目录及写入权限。'),
      };
    }
    if (alert.kind === 'failed' && this.alerts.get(scope.sessionId)?.kind === 'failed')
      return this.alerts.get(scope.sessionId);
    this.alerts.set(scope.sessionId, alert);
    this.onIntegrityAlert?.(scope.sessionId, alert);
    return alert;
  }
  isRevision(sessionId: string) {
    return !!this.protections.get(sessionId)?.scope.revisions;
  }
  publicationStatus(sessionId: string) {
    return this.protections.get(sessionId)?.publication?.status;
  }
  /** Called under the document lock. Only the journal release makes the batch reviewable. */
  private async publishBatch(active: Protection, entries: SuggestionBatch['entries']) {
    const { scope } = active;
    if (active.publication?.status === 'staged' || scope.cancelled || !entries.length) return;
    active.finishing = true;
    active.batch ??= { id: scope.batch, time: new Date().toISOString(), entries };
    try {
      if (scope.revisions) await this.publishRevisions(active, entries);
      else await this.stageBatch(active);
      await this.verifyProtected(active);
      if (!scope.cancelled && active.journal)
        await this.withhold(active.journal, scope.batch, false, scope.sessionId);
    } catch (error) {
      if (
        error instanceof MindError &&
        (error.code === 'REVIEW_OVERLAP' ||
          (scope.revisions &&
            ['REVIEW_CHANGED', 'REVIEW_DRAFT', 'REVIEW_GONE', 'REVIEW_QUEUE', 'CONFLICT'].includes(
              error.code,
            )))
      ) {
        this.cancelScope(scope.sessionId);
        throw error;
      }
      active.publication = { status: 'failed', error };
      throw error;
    } finally {
      // A writer or cancellation can race even the journal release.
      await this.verifyProtected(active);
    }
    if (!scope.cancelled) active.publication = { status: 'staged' };
  }
  async finishScope(sessionId: string) {
    const active = this.protections.get(sessionId);
    if (!active) return;
    return this.serial(active.scope.key, async () => {
      if (active !== this.protections.get(sessionId)) return;
      const { scope, snapshot } = active;
      active.finishing = true;
      const retry = !this.scopes.has(sessionId);
      if (retry && !scope.cancelled) {
        const current = await this.read(scope.key);
        if (current.document.id !== snapshot.document.id)
          throw new MindError('CONFLICT', '主稿已被另一份文稿替换，请恢复对应文稿后重试');
        if (current.token !== snapshot.token)
          this.alerts.set(sessionId, {
            id: crypto.randomUUID(),
            kind: 'external',
            message: '等待暂存期间主稿已有修改。已保留现稿，请重新核对本批建议与原文。',
          });
      }
      await this.verifyProtected(active);
      let failure: unknown;
      try {
        if (!scope.cancelled && active.publication?.status !== 'staged') {
          if (active.publication?.status === 'failed' && !retry) throw active.publication.error;
          const preview = this.previews.get(sessionId);
          if (preview) {
            const entries =
              active.batch?.entries ??
              (scope.revisions
                ? [...(active.revised?.values() ?? [])]
                : suggestedEntries(scope, snapshot.document.root, preview));
            await this.publishBatch(active, entries);
          }
        }
      } catch (error) {
        failure = error;
      }
      if (scope.cancelled && active.replaced?.size) {
        try {
          await this.restoreRevisions(active);
        } catch (error) {
          this.alerts.set(sessionId, {
            id: crypto.randomUUID(),
            kind: 'staging',
            message: '未能撤回本次续改，请重试或核对待审稿。',
          });
          this.scopes.delete(sessionId);
          throw error;
        }
      }
      if (scope.cancelled && active.journal) {
        // The exclusion precedes publication, so even a full disk during withdrawal
        // cannot resurrect this batch in a newly opened store.
        await this.withhold(active.journal, scope.batch, true, sessionId);
        try {
          const side = await this.readQueue(active.publishedAt!, snapshot, new Set());
          if (side.corrupt) throw new MindError('SUGGESTION', '暂存文件损坏');
          const own = side.stored.find((b) => b.id === scope.batch);
          if (own && JSON.stringify(own) !== JSON.stringify(active.batch))
            throw new MindError('CONFLICT', '待撤回的批次已经改变');
          if (own)
            await this.saveSuggestions(
              side,
              side.stored.filter((b) => b !== own),
              sessionId,
            );
          await this.withhold(active.journal, scope.batch, false, sessionId);
        } catch {
          if (!scope.breached)
            this.alerts.set(sessionId, {
              id: crypto.randomUUID(),
              kind: 'external',
              message: '本批建议已取消。未能清理旁文件，重启后仍会隐藏该批。',
            });
        } finally {
          await this.verifyProtected(active);
        }
      }
      if (this.alerts.get(sessionId)?.kind === 'failed' && scope.breached) return;
      if (failure && !scope.cancelled) {
        // Only the generated batch survives the turn. Polling and retry cannot restore the main file.
        this.scopes.delete(sessionId);
        throw failure;
      }
      const count =
        !scope.cancelled && active.publication?.status === 'staged'
          ? active.batch?.entries.length
          : undefined;
      this.cancelScope(sessionId);
      this.previews.delete(sessionId);
      this.scopes.delete(sessionId);
      this.protections.delete(sessionId);
      if (this.alerts.get(sessionId)?.kind === 'staging') this.alerts.delete(sessionId);
      return count;
    });
  }
  preview(sessionId: string) {
    return this.previews.get(sessionId);
  }
  private reviewKey(key: string, sessionId: string, documentId: string, kind: ReviewFileKind) {
    return (
      this.disk.reviewKey?.(key, sessionId, documentId, kind) ?? key + '.' + documentId + '.' + kind
    );
  }
  private async withheld(path: string) {
    try {
      const text = await this.disk.read(path);
      const ids: unknown = text === undefined ? [] : JSON.parse(text.replace(/^\uFEFF/, ''));
      if (Array.isArray(ids) && ids.every((id) => typeof id === 'string'))
        return { text, ids: new Set<string>(ids) };
    } catch (error) {
      if (!(
        error instanceof SyntaxError ||
        (error instanceof MindError && error.code === 'FILE') ||
        (error as NodeJS.ErrnoException)?.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
      ))
        throw error;
    }
    throw new MindError(
      'WITHHELD_CORRUPT',
      `请修复批次撤回记录 ${path}。核对完成前已隐藏待审建议。`,
    );
  }
  private async withhold(path: string, batch: string, exclude: boolean, sessionId: string) {
    const { text, ids } = await this.withheld(path);
    if (ids.has(batch) === exclude) return;
    if (exclude) ids.add(batch);
    else ids.delete(batch);
    await this.disk.write(path, JSON.stringify([...ids]), text, sessionId);
  }
  private async queuePaths(key: string, sessionId: string, snapshot: Snapshot) {
    const [primary, paragraphs, deferred, paragraphDeferred, journal] = await Promise.all([
      this.disk.suggestionKeys?.(key, sessionId, snapshot.document.id) ?? [
        key + '.' + snapshot.document.id + '.suggestions',
      ],
      this.reviewKey(key, sessionId, snapshot.document.id, 'paragraph-suggestions'),
      this.reviewKey(key, sessionId, snapshot.document.id, 'deferred'),
      this.reviewKey(key, sessionId, snapshot.document.id, 'paragraph-deferred'),
      this.reviewKey(key, sessionId, snapshot.document.id, 'withheld'),
    ]);
    return { primary, paragraphs, deferred, paragraphDeferred, journal };
  }
  private async readQueue(
    path: string,
    snapshot: Snapshot,
    withheld: Set<string>,
    editions: Editions = {},
  ): Promise<SuggestionFile> {
    const file: SuggestionFile = {
      path,
      documentId: snapshot.document.id,
      stored: [],
      batches: [],
    };
    try {
      file.text = await this.disk.read(path);
    } catch (error) {
      if (
        !(error instanceof MindError && error.code === 'FILE') &&
        (error as NodeJS.ErrnoException)?.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA'
      )
        throw error;
      return { ...file, corrupt: true };
    }
    if (file.text !== undefined) {
      try {
        file.stored = batchesSchema.parse(JSON.parse(file.text.replace(/^\uFEFF/, '')));
      } catch {
        return { ...file, corrupt: true };
      }
      for (const batch of file.stored) {
        batch.entries = batch.entries.map((entry) => {
          const known = editions[reviewKey(batch.id, entry.id)];
          if (!known || entry.version) return entry;
          const hash = editionOf(entry).hash;
          const saved = known.findLast((v) => v.hash === hash);
          return saved?.version
            ? suggestionSchema.parse({
                ...entry,
                version: saved.version,
                expansion: saved.expansion,
              })
            : entry;
        });
      }
      file.batches = pendingBatches(
        file.stored.filter((b) => !withheld.has(b.id)),
        snapshot.document.lastAdoption,
      );
    }
    return file;
  }
  private async reviewFiles(key: string, sessionId: string, snapshot: Snapshot) {
    const paths = await this.queuePaths(key, sessionId, snapshot);
    const [{ ids }, metadata] = await Promise.all([
      this.withheld(paths.journal),
      this.draftFile(key, sessionId, snapshot),
    ]);
    const read = (path: string) => this.readQueue(path, snapshot, ids, metadata.editions);
    const [originals, paragraphs, deferred, paragraphDeferred] = await Promise.all([
      Promise.all(paths.primary.map(read)),
      read(paths.paragraphs),
      read(paths.deferred),
      read(paths.paragraphDeferred),
    ]);
    const files = [...originals, paragraphs, deferred, paragraphDeferred];
    const primary = originals.find((file) => file.text !== undefined) ?? originals[0];
    const merged = mergeBatches([...originals, paragraphs].map((file) => file.batches));
    const overflow = mergeBatches([deferred.batches, paragraphDeferred.batches]);
    const damaged = files.find((file) => file.corrupt);
    const waiting = deferred.batches.length
      ? deferred.path
      : paragraphDeferred.batches.length
        ? paragraphDeferred.path
        : undefined;
    const showDeferred = waiting && !damaged && !merged.batches.length && !merged.conflicts.size;
    const batches = (showDeferred ? overflow : merged).batches;
    const conflicts = new Set([...merged.conflicts, ...overflow.conflicts]);
    const all = mergeBatches(files.map((f) => f.batches));
    const queueNotice = damaged
      ? `请先处理损坏的建议文件 ${damaged.path}，可从备份恢复。${waiting ? '新批建议已单独保存于 ' + waiting : ''}`
      : conflicts.size
        ? `两份队列中的同一建议内容不同，请先核对批次 ${[...conflicts].join('、')}。`
        : waiting && !showDeferred
          ? `新批建议已单独保存于 ${waiting}。请先处理旧批次，随后可核对新批。`
          : null;
    return {
      files,
      allBatches: all.batches,
      ambiguous: all.conflicts,
      metadata,
      primary,
      paragraphs,
      deferred,
      paragraphDeferred,
      waiting,
      journal: paths.journal,
      batches,
      damaged,
      queueNotice,
    };
  }
  private async draftFile(key: string, sessionId: string, snapshot: Snapshot) {
    const path = await this.reviewKey(key, sessionId, snapshot.document.id, 'review-state');
    const raw = await this.disk.read(path);
    const meta =
      raw === undefined ? { drafts: [], editions: {} } : reviewMetadata.parse(JSON.parse(raw));
    return { path, raw, ...meta };
  }
  async draftState(key: string, sessionId: string, snapshot: Snapshot, known?: string) {
    const path = await this.reviewKey(key, sessionId, snapshot.document.id, 'review-state');
    const version = await this.disk.version?.(path);
    if (this.disk.version && (version ?? '') === known) return {};
    const { drafts } = await this.draftFile(key, sessionId, snapshot);
    return {
      draftToken: this.disk.version ? (version ?? '') : token(JSON.stringify(drafts)),
      reviewDrafts: drafts,
    };
  }
  revising(key: string) {
    return [...this.scopes.values()].find((s) => s.key === key)?.revisions ?? [];
  }
  async setReviewDraft(
    key: string,
    sessionId: string,
    version: Version,
    pin: RevisionPin,
    value?: SuggestionEdit,
    baseDigest?: string,
  ) {
    return this.serial(key, async () => {
      const s = await this.read(key);
      this.checkVersion(s, version);
      if (this.revising(key).some((r) => r.id === pin.id && r.batchId === pin.batchId))
        throw new MindError('LOCKED', 'AI 正在改这条');
      const queues = await this.reviewFiles(key, sessionId, s);
      const batches = this.reviewed(queues.batches);
      const entry = batches.find((b) => b.id === pin.batchId)?.entries.find((e) => e.id === pin.id);
      if (!entry) throw processedSuggestion();
      const file = queues.metadata;
      const prior = file.drafts.find((r) => r.batchId === pin.batchId && r.id === pin.id);
      if (prior?.stamp !== pin.draftStamp) throw changedDraft();
      if (entry.digest !== pin.digest) throw updatedSuggestion();
      const draft: ReviewDraft = {
        batchId: pin.batchId,
        id: pin.id,
        digest: prior?.value !== undefined ? prior.digest : (baseDigest ?? entry.digest),
        stamp: crypto.randomUUID(),
        value,
      };
      const records = file.drafts.filter((r) => r !== prior);
      await this.disk.write(
        file.path,
        JSON.stringify({ drafts: [...records, draft], editions: file.editions }),
        file.raw,
        sessionId,
      );
      return draft;
    });
  }
  async quoteOverlaps(
    key: string,
    sessionId: string,
    snapshot: Snapshot,
    nodeId: string,
    paragraph?: number,
  ) {
    const { allBatches, metadata } = await this.reviewFiles(key, sessionId, snapshot);
    const scope = {
      mode: 'polish' as const,
      ids: [nodeId],
      paragraphs: paragraph === undefined ? [] : [{ nodeId, ordinal: paragraph, original: '' }],
    };
    const matches = scopeMatches(scope, allBatches);
    if (!matches.length) return [];
    const { drafts } = metadata;
    return matches.map(({ batchId, entry }) => ({
      batchId,
      id: entry.id,
      digest: token(JSON.stringify(entry)),
      draftStamp: drafts.find((d) => d.batchId === batchId && d.id === entry.id)?.stamp,
    }));
  }
  /** The caller holds the canonical manuscript's serial queue. */
  async prepareScope(scope: Scope, snapshot: Snapshot, pins?: RevisionPin[], explicit = false) {
    const queues = await this.reviewFiles(scope.key, scope.sessionId, snapshot);
    const matches = scopeMatches(scope, queues.allBatches);
    const ambiguous = scopeMatches(
      scope,
      queues.files.flatMap((f) => f.batches.filter((b) => queues.ambiguous.has(b.id))),
    );
    if (ambiguous.length) throw overlapError(ambiguous, snapshot.document.root);
    if (!matches.length && !pins?.length) return;
    if (
      !explicit &&
      matches.length &&
      (!matches.every((m) => m.exact) ||
        new Set(matches.map((m) => m.entry.id)).size !== scope.ids.length ||
        matches.length !== scope.ids.length ||
        pins === undefined)
    )
      throw overlapError(matches, snapshot.document.root);
    const candidates = explicit
      ? matches.filter((m) => pins?.some((p) => p.batchId === m.batchId && p.id === m.entry.id))
      : matches;
    if (pins?.some((p) => !candidates.some((m) => p.batchId === m.batchId && p.id === m.entry.id)))
      throw processedSuggestion();
    if (candidates.length !== scope.ids.length || !pins?.length) throw updatedSuggestion();
    const { drafts } = queues.metadata;
    const targets: RevisionTarget[] = candidates.map(({ entry, batchId, exact }) => {
      const pin = pins.find((p) => p.batchId === batchId && p.id === entry.id);
      const digest = token(JSON.stringify(entry));
      if (!exact || pin?.digest !== digest) throw updatedSuggestion();
      verifyOriginal(snapshot.document.root, entry);
      const draft = drafts.find((d) => d.batchId === batchId && d.id === entry.id);
      if (draft?.stamp !== pin.draftStamp || (draft?.value !== undefined && !explicit))
        throw changedDraft();
      revisionBase(entry, draft?.value);
      return { ...pin, entry: { ...entry, digest }, edit: draft?.value };
    });
    // One conditional file replacement publishes the entire revision, including multi-node selections.
    const sources = queues.files.filter((f) =>
      targets.some((r) =>
        f.batches.some((b) => b.id === r.batchId && b.entries.some((e) => e.id === r.id)),
      ),
    );
    if (
      sources.length !== 1 ||
      !targets.every((r) =>
        queues.batches.some((b) => b.id === r.batchId && b.entries.some((e) => e.id === r.id)),
      )
    )
      throw new MindError('REVIEW_QUEUE', '这些建议分布在不同的待审队列，请在抽屉中逐条核对。');
    scope.revisions = targets;
    scope.batch = targets[0].batchId;
    const side = sources[0];
    return {
      side,
      metadata: queues.metadata,
      deferred: side === queues.deferred || side === queues.paragraphDeferred,
    };
  }
  private async publishRevisions(active: Protection, entries: Suggestion[]) {
    const { scope } = active;
    const snapshot = await this.read(scope.key);
    this.checkVersion(snapshot, active.snapshot);
    const source = await this.prepareScope(scope, snapshot, scope.revisions, true);
    if (!source) throw processedSuggestion();
    const { side, metadata } = source;
    const updates = new Map<string, Suggestion>();
    for (const entry of entries) {
      const target = scope.revisions!.find((r) => r.id === entry.id)!;
      updates.set(reviewKey(target.batchId, target.id), entry);
    }
    const changed = await this.replaceRevisions(
      side,
      metadata,
      scope.sessionId,
      updates,
      source.deferred,
      active.controller.signal,
    );
    active.replaced = changed;
  }
  private async replaceRevisions(
    side: SuggestionFile,
    metadata: Awaited<ReturnType<DocumentStore['draftFile']>>,
    sessionId: string,
    updates: Map<string, Suggestion>,
    deferred: boolean,
    signal?: AbortSignal,
  ) {
    const editions = { ...metadata.editions };
    const changed = new Map<string, { old: Suggestion; version: number; hash: string }>();
    // readQueue already validated the same bytes. Preserve even unrecognized sibling fields
    // and the representation an older host used when it last saved this queue.
    const original: SuggestionBatch[] = JSON.parse(side.text!.replace(/^\uFEFF/, ''));
    const updated = side.stored.map((batch, i) => ({
      ...original[i],
      entries: batch.entries.map((old, j) => {
        const stored = original[i].entries[j];
        const key = reviewKey(batch.id, old.id);
        const next = updates.get(key);
        if (!next) return stored;
        const version =
          Math.max(old.version ?? 0, ...(editions[key] ?? []).map((v) => v.version)) + 1;
        const replacement =
          old.field === 'children' && next.field === 'children'
            ? { ...old, additions: next.additions, version }
            : old.field !== 'children' && next.field === old.field
              ? { ...old, after: next.after, version }
              : undefined;
        if (!replacement) throw updatedSuggestion();
        const edition = editionOf(replacement);
        editions[key] = [editionOf(old), edition];
        changed.set(key, { old, version, hash: edition.hash });
        return { ...stored, ...replacement };
      }),
    }));
    const meta = JSON.stringify({ drafts: metadata.drafts, editions });
    signal?.throwIfAborted();
    await this.disk.write(metadata.path, meta, metadata.raw, sessionId);
    await this.saveSuggestions(
      side,
      updated,
      sessionId,
      () => signal?.throwIfAborted(),
      signal,
      async () => {
        if ((await this.disk.read(metadata.path)) !== meta) throw changedDraft();
      },
      deferred,
    );
    return changed;
  }
  private async restoreRevisions(active: Protection) {
    const { scope, replaced } = active;
    const current = await this.read(scope.key);
    if (current.document.id !== active.snapshot.document.id) throw updatedSuggestion();
    const queues = await this.reviewFiles(scope.key, scope.sessionId, current);
    for (const side of queues.files) {
      const restore = new Map<string, Suggestion>();
      for (const batch of side.batches)
        for (const e of batch.entries) {
          const key = reviewKey(batch.id, e.id);
          const change = replaced!.get(key);
          if (change && e.version === change.version && editionOf(e).hash === change.hash)
            restore.set(key, change.old);
        }
      if (restore.size)
        await this.replaceRevisions(
          side,
          queues.metadata,
          scope.sessionId,
          restore,
          side === queues.deferred || side === queues.paragraphDeferred,
        );
    }
    active.replaced = undefined;
  }
  private async stageBatch(active: Protection) {
    const { scope, snapshot, batch } = active;
    const queues = await this.reviewFiles(scope.key, scope.sessionId, snapshot);
    const overlap = scopeMatches(
      scope,
      queues.files.flatMap((f) => f.batches.filter((b) => b.id !== scope.batch)),
    );
    if (overlap.length) throw overlapError(overlap, snapshot.document.root);
    // Keep the entire batch together, including when a mixed selection overflows.
    const primary = scope.paragraphs?.length ? queues.paragraphs : queues.primary;
    const deferred = scope.paragraphs?.length ? queues.paragraphDeferred : queues.deferred;
    const append = async (side: SuggestionFile) => {
      if (side.corrupt) throw new MindError('SUGGESTION_CORRUPT', '待审文件损坏，请先处理旧批次');
      const own = side.stored.find((b) => b.id === scope.batch);
      if (own) {
        if (JSON.stringify(own) !== JSON.stringify(batch))
          throw new MindError('CONFLICT', '本批建议已经改变，请核对暂存区');
        return;
      }
      const check = () => {
        if (scope.cancelled) throw new MindError('CANCELLED', '本次建议已取消');
      };
      await this.saveSuggestions(
        side,
        [...pendingBatches(side.stored, snapshot.document.lastAdoption), batch!],
        scope.sessionId,
        check,
        active.controller.signal,
        async () => {
          await this.withhold(queues.journal, scope.batch, true, scope.sessionId);
          active.journal = queues.journal;
          active.publishedAt = side.path;
        },
        side === deferred,
      );
    };
    // The queue write can succeed and the journal release fail. Even if the
    // queue filled in the meantime, release that same copy on retry.
    if (active.publishedAt === primary.path && primary.stored.some((b) => b.id === scope.batch))
      return append(primary);
    if (
      queues.damaged ||
      queues.batches.length >= 40 ||
      queues.waiting ||
      active.publishedAt === deferred.path
    ) {
      await append(deferred);
      return;
    }
    try {
      await append(primary);
    } catch (error) {
      if (!(error instanceof MindError && error.code === 'SUGGESTION_LIMIT')) throw error;
      await append(deferred);
    }
  }
  private async saveSuggestions(
    side: { path: string; text?: string; documentId: string },
    batches: SuggestionBatch[],
    sessionId: string,
    check?: () => void,
    signal?: AbortSignal,
    beforePublish?: () => Promise<void>,
    deferred = false,
  ) {
    const text = JSON.stringify(batches);
    if (
      beforePublish &&
      !deferred &&
      (batches.length > 40 || Buffer.byteLength(text) > 24 * 1024 * 1024)
    )
      throw new MindError('SUGGESTION_LIMIT', '暂存区已满，请先处理已有建议');
    check?.();
    if (side.text === text) return;
    const commit = await this.prepare(side.path, side.text, sessionId);
    const backups = this.disk.backups;
    if (backups && side.text !== undefined) {
      // Keep the sidecar itself a plain array for both archived readers. A
      // prepared receipt can be recognized on either side of an interrupted write.
      const fileKey = await backups.fileKey(side.path, sessionId, side.documentId);
      const name = `0.7.3-${fileKey}-suggestions.json`;
      const raw = await backups.read(name, sessionId);
      const marker = raw && JSON.parse(raw);
      const from = token(side.text);
      const valid =
        marker?.fileKey === fileKey &&
        /^[a-f0-9]{64}$/.test(marker.sha256) &&
        (await this.hasCopy(marker, sessionId));
      if (!valid || !marker.confirmed) {
        const observedCommit = valid && from === marker.to;
        const first =
          observedCommit || (valid && from === marker.from)
            ? { fileKey, sha256: marker.sha256 }
            : await this.copy(fileKey, side.text, sessionId);
        const next = JSON.stringify({
          ...first,
          from,
          to: token(text),
          confirmed: !!observedCommit,
        });
        if (next !== raw) await backups.write(name, next, raw, sessionId);
      }
    }
    check?.();
    await beforePublish?.();
    await commit(text, check, signal);
  }
  async suggestionState(key: string, sessionId: string, snapshot: Snapshot, known?: string) {
    let suggestionToken;
    if (this.disk.version) {
      const paths = await this.queuePaths(key, sessionId, snapshot);
      const keys = [
        ...paths.primary,
        paths.paragraphs,
        paths.deferred,
        paths.paragraphDeferred,
        paths.journal,
      ];
      const versions = await Promise.all(keys.map((path) => this.disk.version!(path)));
      suggestionToken = token(JSON.stringify([keys, versions, snapshot.document.lastAdoption]));
      if (known === suggestionToken) return { suggestionToken };
    }
    const { suggestions, queueNotice } = await this.reviewList(key, sessionId, snapshot);
    return {
      suggestions,
      queueNotice,
      suggestionToken: suggestionToken ?? token(JSON.stringify([suggestions, queueNotice])),
    };
  }
  private reviewed(batches: SuggestionBatch[]) {
    return batches.map((batch) => ({
      ...batch,
      entries: batch.entries.map((entry) => ({ ...entry, digest: token(JSON.stringify(entry)) })),
    }));
  }
  private async reviewList(key: string, sessionId: string, snapshot: Snapshot) {
    try {
      const { batches, queueNotice } = await this.reviewFiles(key, sessionId, snapshot);
      return { suggestions: this.reviewed(batches), queueNotice };
    } catch (error) {
      if (!(error instanceof MindError && error.code === 'WITHHELD_CORRUPT')) throw error;
      return { suggestions: [], queueNotice: error.message };
    }
  }
  async suggestions(key: string, sessionId: string, snapshot: Snapshot) {
    return (await this.reviewList(key, sessionId, snapshot)).suggestions;
  }
  assertWrite(key: string, sessionId: string, actor: 'human' | 'ai') {
    const own = this.scopes.get(sessionId);
    const owner = [...this.scopes.values()].find((s) => s.key === key);
    if (own?.cancelled) throw new MindError('CANCELLED', '本次 AI 操作已取消，未执行后续写入');
    if (own && own.key !== key) throw new MindError('SCOPE_VIOLATION', '不能改写其他导图');
    if (owner && (owner.sessionId !== sessionId || actor !== 'ai'))
      throw new MindError('LOCKED', 'AI 操作期间文档暂时锁定');
    return own;
  }
  private async changePreview(
    key: string,
    expected: Version,
    sessionId: string,
    scope: Scope,
    operations: Operation[],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (scope.cancelled || this.scopes.get(sessionId) !== scope)
      throw new MindError('CANCELLED', '本次选区任务已结束');
    this.assertWrite(key, sessionId, 'ai');
    const protection = this.protections.get(sessionId)!;
    if (protection.finishing) throw new MindError('LOCKED', '本批已停止接收写入。');
    if (await this.verifyProtected(protection))
      throw new MindError('INTEGRITY', this.alerts.get(sessionId)!.message);
    const snapshot = await this.read(key);
    // Each revision turn has a fresh write token even when the manuscript and after are identical.
    if (scope.revisionToken && expected.token !== scope.revisionToken) throw updatedSuggestion();
    this.checkVersion(
      scope.revisionToken ? { ...snapshot, token: scope.revisionToken } : snapshot,
      expected,
    );
    // Enforce selected fields before depth normalization so a mixed invalid
    // batch cannot stage even its otherwise permitted prefix.
    checkScope(scope, operations);
    for (const op of operations) {
      if (op.type !== 'update' || op.body === undefined) continue;
      const ordinals = scope.paragraphs?.filter((p) => p.nodeId === op.id).map((p) => p.ordinal);
      if (ordinals?.length)
        checkParagraphChange(find(snapshot.document.root, op.id).body, op.body, ordinals);
    }
    if (scope.revisions) await this.prepareScope(scope, snapshot, scope.revisions, true);
    if (scope.mode === 'expand' && scope.revisions) {
      for (const op of operations) {
        if (op.type !== 'add') continue;
        const original = scope.revisions.find((r) => r.id === op.parentId)?.entry;
        if (original?.field !== 'children') throw updatedSuggestion();
        const limited = new ProgressiveGeneration().authorize(
          sessionId,
          key,
          snapshot.document.root,
          [op],
          { ...scope, expansion: original.expansion ?? 'one' },
        );
        if (limited.demoted)
          throw new MindError('ONE_LEVEL', '新增结构超出了这条建议原有的深度授权。');
      }
    }
    const authorized =
      scope.mode === 'expand' && !scope.revisions
        ? new ProgressiveGeneration().authorize(
            sessionId,
            key,
            snapshot.document.root,
            operations,
            scope,
          ).operations
        : operations;
    // Replaying a partial structural submission must not append the same children twice.
    const request =
      !scope.revisions && scope.mode === 'expand' ? token(JSON.stringify(authorized)) : undefined;
    if (request && protection.addedRequests?.has(request)) return snapshot;
    const next = applyOperations(
      (!scope.revisions && this.previews.get(sessionId)) || snapshot.document.root,
      authorized,
      scope,
    );
    signal?.throwIfAborted();
    if (scope.cancelled) throw new MindError('CANCELLED', '本次选区任务已取消');
    if (scope.revisions) {
      const revised = (protection.revised ??= new Map());
      const structural = suggestedEntries(scope, snapshot.document.root, next);
      for (const id of new Set(
        operations.flatMap((op) =>
          op.type === 'add' ? [op.parentId] : op.type === 'update' ? [op.id] : [],
        ),
      )) {
        const target = scope.revisions.find((r) => r.id === id)!;
        const { digest: _, ...old } = target.entry;
        if (old.field === 'children') {
          const entry = structural.find((e) => e.id === id);
          if (
            entry?.field === 'children' &&
            JSON.stringify(old.additions) !== JSON.stringify(entry.additions)
          )
            revised.set(id, entry);
          else revised.delete(id);
        } else {
          const after = find(next, id)[old.field] ?? '';
          if (after !== old.after) revised.set(id, { ...old, after });
          else revised.delete(id);
        }
      }
    }
    this.previews.set(sessionId, next);
    if (request) (protection.addedRequests ??= new Set()).add(request);
    return snapshot;
  }
  async submitSuggestions(
    key: string,
    expected: Version,
    sessionId: string,
    operations: Operation[],
    { scope, signal }: { scope: Scope; signal: AbortSignal },
  ) {
    return this.serial(key, async () => {
      const snapshot = await this.changePreview(
        key,
        expected,
        sessionId,
        scope,
        operations,
        signal,
      );
      if (signal.aborted) this.cancelScope(sessionId);
      signal.throwIfAborted();
      const entries = scope.revisions
        ? [...(this.protections.get(sessionId)!.revised?.values() ?? [])]
        : suggestedEntries(scope, snapshot.document.root, this.previews.get(sessionId)!);
      const suggested = new Set(entries.map((entry) => entry.id));
      const missing = scope.ids.filter((id) => !suggested.has(id));
      if (!missing.length) {
        const active = this.protections.get(sessionId)!;
        const cancel = () => {
          if (active.publication?.status !== 'staged') this.cancelScope(sessionId);
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          await this.publishBatch(active, entries);
        } finally {
          signal.removeEventListener('abort', cancel);
        }
        if (scope.cancelled) throw new MindError('CANCELLED', '本次选区任务已取消。');
      }
      return {
        revision: snapshot.revision,
        token: scope.revisionToken ?? snapshot.token,
        suggested: [...suggested],
        missing,
      };
    });
  }
  async change(
    key: string,
    expected: Version,
    sessionId: string,
    actor: 'human' | 'ai',
    operations: Operation[],
    batch: string = crypto.randomUUID(),
    authorization?: { scope?: Scope; signal: AbortSignal },
  ): Promise<Snapshot> {
    const scope = authorization ? authorization.scope : this.scopes.get(sessionId);
    if (actor === 'ai' && scope) {
      return this.serial(key, () =>
        this.changePreview(key, expected, sessionId, scope, operations, authorization?.signal),
      );
    }
    return this.transaction(
      key,
      expected,
      sessionId,
      actor,
      (d) =>
        this.recordChange(
          d,
          applyOperations(d.root, operations),
          batch,
          actor === 'ai' ? 'AI' : '编辑 / Edit',
        ),
      authorization,
    );
  }
  async paste(
    key: string,
    expected: Version,
    sessionId: string,
    target: PasteTarget,
    command: PasteCommand,
    replace?: string,
    consent?: string,
  ) {
    let pending:
      { suggestions: ReviewedBatch[]; key: string; consent: string; count: number } | undefined;
    let receipt: PasteReceipt | undefined;
    const snapshot = await this.transaction(
      key,
      expected,
      sessionId,
      'human',
      async (d, source) => {
        let root = d.root;
        if (replace) {
          const entry = d.history[d.cursor - 1];
          if (
            d.cursor !== d.history.length ||
            !replace.startsWith('paste:') ||
            entry?.id !== replace ||
            !entry.patch
          )
            throw new MindError('CONFLICT', '粘贴之后文稿已改变，请重新粘贴');
          // Rebuild on the tree before this paste. No intermediate undo is published.
          root = applyPatch(root, entry.patch, false);
        }
        function retract() {
          d.root = root;
          d.history.pop();
          d.cursor--;
        }
        if (command.mode === 'retract') {
          if (!replace) return false;
          retract();
          return;
        }
        const node = find(root, target.id);
        const plan = planPaste(node, target.after, command);
        const fields = new Set(
          plan.operations.map((op) => (op.type === 'add' ? 'children' : 'body')),
        );
        // A suggestion can arrive between two client polls without changing the manuscript token.
        const suggestions = await this.suggestions(key, sessionId, source);
        const affected = suggestions.flatMap((b) =>
          b.entries
            .filter(
              (e) =>
                e.id === target.id &&
                (e.field === 'body' || e.field === 'children') &&
                fields.has(e.field),
            )
            .map((e) => [reviewKey(b.id, e.id), e.digest]),
        );
        if (affected.length) {
          const stamp = token(JSON.stringify(affected));
          if (consent !== stamp) {
            pending = { suggestions, key: affected[0][0], consent: stamp, count: affected.length };
            return false;
          }
        }
        const group = replace ?? 'paste:' + crypto.randomUUID();
        const next = applyOperations(root, plan.operations);
        if (replace) retract();
        this.recordChange(d, next, group, '编辑 / Edit');
        receipt = { group, ...plan.receipt };
      },
    );
    return pending ? { pending } : { snapshot, receipt };
  }
  private checkVersion(s: Version, expected: Version) {
    if (s.token !== expected.token || s.revision !== expected.revision)
      throw new MindError('CONFLICT', '文稿已被其他操作更新，请载入最新版本后重试');
  }
  private editableDocument(text: string) {
    const document = parseDocument(text);
    document.history = compactHistory(document.history);
    return document;
  }
  private recordChange(d: MindDocument, next: MindNode, group: string, label: string) {
    const patch = treePatch(d.root, next);
    if (!patch.changes.length) return false;
    const prior = d.history[d.cursor - 1];
    d.history = d.history.slice(0, d.cursor);
    if (prior?.id === group) {
      const before = prior.patch ? applyPatch(d.root, prior.patch, false) : prior.before;
      const combined = treePatch(before, next);
      if (combined.changes.length)
        d.history[d.cursor - 1] = { id: group, label, time: prior.time, patch: combined };
      else d.history.pop();
    } else d.history.push({ id: group, label, time: new Date().toISOString(), patch });
    d.cursor = d.history.length;
    d.root = next;
    return true;
  }
  async undo(
    key: string,
    expected: Version,
    sessionId: string,
    redo = false,
    aiOnly = false,
  ): Promise<Snapshot> {
    return this.transaction(key, expected, sessionId, 'human', (d) => {
      const h = d.history[redo ? d.cursor : d.cursor - 1];
      if (!h || (aiOnly && h.label !== 'AI'))
        throw new MindError('HISTORY', '没有可撤销的对应修改');
      d.root = h.patch
        ? applyPatch(d.root, h.patch, redo)
        : structuredClone(redo ? h.after : h.before);
      d.cursor += redo ? 1 : -1;
    });
  }
  async decide(
    key: string,
    expected: Version,
    sessionId: string,
    batchId: string,
    reviewed: ReviewReceipt[],
    adopt: boolean,
    edit?: SuggestionEdit,
    entireBatch = false,
  ) {
    return this.serial(key, async () => {
      this.assertWrite(key, sessionId, 'human');
      const snapshot = await this.read(key);
      this.checkVersion(snapshot, expected);
      const queues = await this.reviewFiles(key, sessionId, snapshot);
      const batch = queues.batches.find((b) => b.id === batchId);
      const receipts = new Map(reviewed.map((r) => [r.id, r.digest]));
      const ids = [...receipts.keys()];
      const entries = batch?.entries.filter((e) => receipts.has(e.id)) ?? [];
      if (
        !entries.length ||
        (entireBatch && entries.length !== batch?.entries.length) ||
        new Set(entries.map((e) => e.id)).size !== receipts.size ||
        receipts.size !== reviewed.length
      )
        throw new MindError('SUGGESTION', '该条建议已处理，请刷新建议列表');
      if (entries.some((entry) => token(JSON.stringify(entry)) !== receipts.get(entry.id)))
        throw new MindError('CONFLICT', '待审建议的内容已经改变，请重新核对后再处理');
      const handFile = queues.metadata;
      const hand = handFile.drafts.filter((r) => r.batchId === batchId && receipts.has(r.id));
      if (
        hand.some(
          (r) =>
            r.value !== undefined && (!adopt || JSON.stringify(edit) !== JSON.stringify(r.value)),
        )
      )
        throw changedDraft();
      const receipt = { batchId, ids };
      const sources = queues.files.filter((file) =>
        file.batches.some((b) => b.id === batchId && b.entries.some((e) => receipts.has(e.id))),
      );
      const dismiss = async () => {
        for (const file of sources)
          await this.saveSuggestions(file, pendingBatches(file.stored, receipt), sessionId);
      };
      const clearDrafts = async () => {
        const editions = { ...handFile.editions };
        const keys = ids.map((id) => reviewKey(batchId, id));
        if (!hand.length && !keys.some((k) => editions[k])) return;
        keys.forEach((k) => delete editions[k]);
        try {
          await this.disk.write(
            handFile.path,
            JSON.stringify({ drafts: handFile.drafts.filter((r) => !hand.includes(r)), editions }),
            handFile.raw,
            sessionId,
          );
        } catch {
          // The queue decision already committed. Orphan metadata grants no access.
        }
      };
      if (!adopt) {
        await dismiss();
        await clearDrafts();
        return snapshot;
      }
      const operations = adoptionOperations(snapshot.document.root, entries, edit);
      let next = snapshot.document.root;
      // A saved batch can span several tool calls. All chunks are applied to
      // an in-memory tree and share one guarded save and one undo entry.
      for (let start = 0; start < operations.length; start += 1000)
        next = applyOperations(next, operations.slice(start, start + 1000));
      const d = this.editableDocument(snapshot.text);
      if (!this.recordChange(d, next, crypto.randomUUID(), 'AI')) {
        await dismiss();
        await clearDrafts();
        return snapshot;
      }
      const commit = await this.prepare(key, snapshot.text, sessionId);
      // Capture BOTH originals before compacting the preceding adoption receipt.
      await this.protectOriginals(key, sessionId, snapshot.text, d, sources);
      for (const file of queues.files) {
        if (file.corrupt) continue;
        const pending = pendingBatches(file.stored, snapshot.document.lastAdoption);
        if (pending !== file.stored) await this.saveSuggestions(file, pending, sessionId);
        else if (file.text !== (await this.disk.read(file.path)))
          throw new MindError('CONFLICT', '待审建议已被其他程序修改');
      }
      d.lastAdoption = receipt;
      const saved = await this.save(key, sessionId, commit, d);
      await clearDrafts();
      return saved;
    });
  }
  async setProfile(
    key: string,
    expected: Version,
    sessionId: string,
    documentType: DocumentType,
    numberingScheme: Numbering,
  ) {
    return this.transaction(key, expected, sessionId, 'human', (d) => {
      if (d.documentType === documentType && d.numberingScheme === numberingScheme) return false;
      d.documentType = documentType;
      d.numberingScheme = numberingScheme;
    });
  }
  async setExpansion(
    key: string,
    expected: Version,
    sessionId: string,
    expansion: MindDocument['expansionDefault'],
  ) {
    return this.transaction(key, expected, sessionId, 'human', (d) => {
      if ((d.expansionDefault ?? 'one') === expansion) return false;
      d.expansionDefault = expansion;
    });
  }
  private async transaction(
    key: string,
    expected: Version,
    sessionId: string,
    actor: 'human' | 'ai',
    mutate: (d: MindDocument, source: Snapshot) => boolean | void | Promise<boolean | void>,
    authorization?: { scope?: Scope; signal: AbortSignal },
  ): Promise<Snapshot> {
    return this.serial(key, async () => {
      const check = () => {
        authorization?.signal.throwIfAborted();
        if (authorization?.scope?.cancelled)
          throw new MindError('CANCELLED', '本次 AI 操作已取消，未执行后续写入');
        if (this.assertWrite(key, sessionId, actor) && actor === 'ai')
          throw new MindError('LOCKED', '选区任务只允许暂存建议');
      };
      check();
      const previous = await this.disk.read(key);
      const protection = this.protections.get(sessionId);
      if (protection && (await this.verifyProtected(protection, { text: previous })))
        throw new MindError('INTEGRITY', this.alerts.get(sessionId)!.message);
      if (previous === undefined) throw new MindError('NOT_FOUND', '导图不存在');
      const d = this.editableDocument(previous);
      this.checkVersion({ revision: d.revision, token: token(previous) }, expected);
      const source = { document: d, revision: d.revision, token: expected.token, text: previous };
      if ((await mutate(d, source)) === false) return source;
      check();
      const commit = await this.prepare(key, previous, sessionId);
      await this.protectOriginals(key, sessionId, previous, d);
      return this.save(key, sessionId, commit, d, check, authorization?.signal);
    });
  }
  private async save(
    key: string,
    sessionId: string,
    commit: Commit,
    d: MindDocument,
    check?: () => void,
    signal?: AbortSignal,
  ) {
    const last = d.history.at(-1);
    const removed = trimHistory(
      d.history,
      !!last?.id.startsWith('paste:') || (!!d.lastAdoption && last?.label === 'AI'),
    );
    d.cursor = Math.max(0, d.cursor - removed);
    if (removed) d.historyLimited = true;
    d.revision++;
    const text = JSON.stringify(d, null, 2) + '\n';
    this.cache.delete(key);
    try {
      await commit(text, check, signal);
    } catch (error) {
      if (!(error instanceof MindError && error.code === 'WRITE_UNVERIFIED')) throw error;
      let recovery = '请保留本地草稿，并检查首次覆盖备份。';
      if (this.disk.backups && d.backupReceipt073) {
        try {
          const copy = await this.copy(d.backupReceipt073.fileKey, text, sessionId);
          recovery = `本次待保存的完整文稿已恢复到 .mindwrite/backups/${this.copyName(copy)}。`;
        } catch {
          // Do not report a recovery file unless it was verified.
        }
      }
      const message = '保存告警：' + error.message + ' 已保留磁盘现场。' + recovery;
      const alert = { id: crypto.randomUUID(), kind: 'failed' as const, message };
      this.alerts.set(sessionId, alert);
      this.onIntegrityAlert?.(sessionId, alert);
      throw new MindError('WRITE_UNVERIFIED', message);
    }
    return { document: d, revision: d.revision, token: token(text), text };
  }
}
