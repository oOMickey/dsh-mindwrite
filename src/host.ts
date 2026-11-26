import { documentTypes, numberingSchemes, profileFor } from './document-profile.ts';
import { importMarkdownDetailed } from './import.ts';
import { readableError } from './host/errors.ts';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { z } from 'zod';
import { MindError, operationSchema } from './model.ts';
import { fullText, markdown } from './format.ts';
import { exportDocx, exportRevisionDocx, importDocxDetailed } from './office.ts';
import { createFiles, snapshotView as view } from './host/files.ts';
import { registerTools, versionFields } from './host/tools.ts';
import { quoteScheme, registerQuotes } from './host/quotes.ts';
import { createScopeLock } from './host/scope-lock.ts';
import { WRITING_PROMPT } from './host/prompt.ts';
import { editsSchema } from './suggestions.ts';
import { exportCheck } from './export-check.ts';
import { documentHealth, healthFixes } from './health.ts';
import { treePatch } from './history.ts';
import { pasteTextLimit } from './paste-tree.ts';
import { revisionRows } from './revisions.ts';

export const name = 'mindwrite';
export const inject = [
  'loader',
  'tools',
  'systemPrompt',
  'agents',
  'sessions',
  'sessionProjections',
  'storageDomain',
  'sessionPersistence',
  'sessionQuery',
  'fs',
  'sandboxPolicy',
  'connection',
  'webServer',
];
const common = z.object({
  sessionId: z.string().min(1).max(160),
  path: z.string().max(1000).optional(),
});
const reviewPin = common.extend({
  ...versionFields,
  batchId: z.string(),
  id: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  draftStamp: z.string().optional(),
});
const expansion = z.enum(['one', 'articles', 'unlimited']);
const modes = z.enum(numberingSchemes);

export function apply(ctx: Context) {
  const files = createFiles(ctx);
  ctx.on('session/disposed', (session) => files.forgetWorkspace(session.id));
  const { store, workspace, keyOf, currentPath, setCurrent, create } = files;
  const scopeLock = createScopeLock(ctx, files);
  const quotes = registerQuotes(ctx, files, scopeLock);
  registerTools(ctx, files, quotes.isReadOnly);
  ctx.effect(() =>
    ctx.systemPrompt.section({ name: 'mindwrite', order: 3100, text: WRITING_PROMPT }),
  );
  async function rpc(endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const a = common.parse(payload);
    const { sessionId } = a;
    await workspace(sessionId);
    signal.throwIfAborted();
    if (endpoint === 'state') {
      const q = common
        .extend({
          known: z.string().optional(),
          knownPath: z.string().optional(),
          knownSuggestions: z.string().optional(),
          knownDrafts: z.string().optional(),
        })
        .parse(payload);
      const path = q.path ?? (await currentPath(sessionId));
      const integrity = await store.verifyScope(sessionId);
      const scope = store.scopes.get(sessionId);
      const available = await files.files(sessionId);
      if (!path) return { files: available, snapshot: null, locked: false };
      const { key } = await keyOf(sessionId, path);
      if (scope?.key === key && integrity?.kind === 'failed')
        return {
          files: available,
          locked: true,
          scope: { mode: scope.mode, ids: scope.ids },
          alert: integrity,
        };
      const s = await store.read(key);
      return {
        ...(await store.suggestionState(key, sessionId, s, q.knownSuggestions)),
        ...(await store.draftState(key, sessionId, s, q.knownDrafts)),
        revising: store.revising(key).map(({ batchId, id }) => ({ batchId, id })),
        files: available,
        snapshot:
          q.known === s.token && (!q.knownPath || q.knownPath === path) ? undefined : view(s, path),
        locked: !!scope,
        scope: scope ? { mode: scope.mode, ids: scope.ids } : null,
        alert: store.alerts.get(sessionId) ?? null,
      };
    }
    if (endpoint === 'create') {
      const q = common
        .extend({ title: z.string().min(1), filename: z.string().optional() })
        .parse(payload);
      const result = await create(sessionId, q.title, q.filename, []);
      quotes.forget(sessionId);
      return result;
    }
    if (endpoint === 'select') {
      const { key, path } = await keyOf(sessionId, a.path);
      const s = await store.read(key);
      const changed = (await currentPath(sessionId)) !== path;
      if (changed && store.scopes.has(sessionId))
        throw new MindError('LOCKED', '请先结束当前选区任务再切换文稿。');
      await setCurrent(sessionId, path);
      if (changed) quotes.forget(sessionId);
      return view(s, path);
    }
    if (endpoint === 'import') {
      const q = common
        .extend({ filename: z.string().min(1).max(1000), content: z.string().max(28000000) })
        .parse(payload);
      const title = q.filename.replace(/\.(md|docx)$/i, '');
      const imported = /\.docx$/i.test(q.filename)
        ? await importDocxDetailed(Buffer.from(q.content, 'base64'), title)
        : importMarkdownDetailed(q.content, title);
      const result = await files.importFile(sessionId, imported.root.title, imported);
      quotes.forget(sessionId);
      return result;
    }
    const { key, path } = await keyOf(sessionId, a.path);
    if (endpoint === 'review-quote') {
      const q = reviewPin.extend({ scheme: quoteScheme.optional() }).parse(payload);
      return quotes.issueReview(sessionId, key, path, q, q, q.scheme);
    }
    if (endpoint === 'review-draft') {
      const q = reviewPin
        .extend({ value: editsSchema.optional(), baseDigest: reviewPin.shape.digest.optional() })
        .parse(payload);
      return store.setReviewDraft(key, sessionId, q, q, q.value, q.baseDigest);
    }
    if (endpoint === 'quote' || endpoint === 'reference') {
      const q = common
        .extend({
          ...versionFields,
          nodeId: z.string().min(1),
          scheme: quoteScheme.optional(),
          paragraph: z.number().int().positive().optional(),
        })
        .parse(payload);
      if (endpoint === 'reference')
        return quotes.reference(sessionId, key, q, q.nodeId, q.scheme, q.paragraph);
      return quotes.issue(sessionId, key, path, q, q.nodeId, q.scheme, q.paragraph);
    }
    if (endpoint === 'quote-state') {
      const q = common
        .extend({
          codes: z.array(z.string().regex(/^(?:[A-Z2-9]{8}|[a-f0-9]{24}|[a-f0-9]{32})$/)).max(3000),
        })
        .parse(payload);
      return quotes.resolve(sessionId, key, q.codes);
    }
    if (endpoint === 'ai-history') {
      const { document } = await store.read(key);
      return document.history
        .slice(0, document.cursor)
        .filter((entry) => entry.label === 'AI')
        .reverse()
        .map((entry) => ({
          id: entry.id,
          time: entry.time,
          changes: (entry.patch ?? treePatch(entry.before, entry.after)).changes
            .filter((change) => change.after)
            .map(({ id, before, after }) => ({
              id,
              title: after!.title,
              fields: (['title', 'body', 'note'] as const)
                .filter((field) => (before?.[field] ?? '') !== (after![field] ?? ''))
                .map((field) => ({
                  field,
                  before: before?.[field] ?? '',
                  after: after![field] ?? '',
                })),
            }))
            .filter((change) => change.fields.length),
        }));
    }
    if (endpoint === 'manuscript') {
      const version = common.extend(versionFields).parse(payload);
      const s = await store.read(key);
      if (s.token !== version.token || s.revision !== version.revision)
        throw new MindError('CONFLICT', '文稿已更新，请重新另存');
      return { text: s.text };
    }
    if (endpoint === 'change') {
      const q = common
        .extend({ ...versionFields, operations: z.array(operationSchema) })
        .parse(payload);
      return view(await store.change(key, q, sessionId, 'human', q.operations), path);
    }
    if (endpoint === 'paste') {
      const text = z.string().max(pasteTextLimit),
        title = z.string().min(1).max(500);
      const q = common
        .extend({
          ...versionFields,
          id: z.string(),
          after: z.number().int().nonnegative().optional(),
          replace: z.string().optional(),
          consent: z.string().optional(),
          command: z.discriminatedUnion('mode', [
            z.object({ mode: z.literal('auto'), text, copiedTitle: title.optional() }),
            z.object({ mode: z.literal('body'), text }),
            z.object({ mode: z.literal('section'), title, text }),
            z.object({ mode: z.literal('retract') }),
          ]),
        })
        .parse(payload);
      const result = await store.paste(key, q, sessionId, q, q.command, q.replace, q.consent);
      return result.pending
        ? { pending: result.pending }
        : { snapshot: view(result.snapshot!, path), receipt: result.receipt };
    }
    if (endpoint === 'undo') {
      const q = common
        .extend({ ...versionFields, redo: z.boolean().optional(), aiOnly: z.boolean().optional() })
        .parse(payload);
      return view(await store.undo(key, q, sessionId, q.redo, q.aiOnly), path);
    }
    if (endpoint === 'suggestion') {
      const q = common
        .extend({
          ...versionFields,
          batchId: z.string(),
          reviewed: z
            .array(z.object({ id: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }))
            .min(1)
            .max(3000),
          adopt: z.boolean(),
          edit: editsSchema.optional(),
          entireBatch: z.boolean().optional(),
        })
        .parse(payload);
      const s = await store.decide(
        key,
        q,
        sessionId,
        q.batchId,
        q.reviewed,
        q.adopt,
        q.edit,
        q.entireBatch,
      );
      return { snapshot: view(s, path), ...(await store.suggestionState(key, sessionId, s)) };
    }
    if (endpoint === 'profile') {
      const q = common
        .extend({ ...versionFields, documentType: z.enum(documentTypes), numberingScheme: modes })
        .parse(payload);
      return view(
        await store.setProfile(key, q, sessionId, q.documentType, q.numberingScheme),
        path,
      );
    }
    if (endpoint === 'expansion-default') {
      const q = common.extend({ ...versionFields, expansion }).parse(payload);
      return view(await store.setExpansion(key, q, sessionId, q.expansion), path);
    }
    if (endpoint === 'health' || endpoint === 'health-fix') {
      const s = await store.read(key);
      const { scheme } = common.extend({ scheme: modes.optional() }).parse(payload);
      const profile = profileFor(s.document, scheme);
      if (endpoint === 'health')
        return {
          issues: documentHealth(s.document.root, s.document.importReport, profile),
          token: s.token,
        };
      const q = common.extend(versionFields).parse(payload),
        operations = healthFixes(s.document.root, profile);
      return operations.length
        ? view(await store.change(key, q, sessionId, 'human', operations), path)
        : view(s, path);
    }
    if (endpoint === 'revisions' || endpoint === 'export-revisions') {
      const s = await store.read(key);
      if (endpoint === 'revisions')
        return {
          rows: revisionRows(s.document),
          token: s.token,
          hasSource: !!s.document.sourceRoot,
        };
      const q = common
        .extend({
          ...versionFields,
          onlyChanges: z.boolean().default(false),
          filename: z.string().min(1).max(1000).optional(),
        })
        .parse(payload);
      if (q.token !== s.token || q.revision !== s.revision)
        throw new MindError('CONFLICT', '文稿已更新，请刷新修订对照表后重新导出');
      const bytes = await exportRevisionDocx(s.document, q.onlyChanges),
        filename = await files.exportFile(
          sessionId,
          q.filename ?? s.document.root.title + '-修订对照表',
          'docx',
          bytes,
        );
      return {
        filename,
        base64: bytes.toString('base64'),
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
    }
    if (endpoint === 'ai') {
      const q = common
        .extend({
          ...versionFields,
          ids: z.array(z.string()).min(1),
          mode: z.enum(['polish', 'expand', 'title', 'note']),
          instruction: z.string().max(5000),
          expansion: expansion.optional(),
        })
        .parse(payload);
      return scopeLock.start(sessionId, key, path, {
        ...q,
        expansion: q.expansion ?? (await store.read(key)).document.expansionDefault,
      });
    }
    if (endpoint === 'retry-staging') return scopeLock.retry(sessionId);
    if (endpoint === 'cancel') return scopeLock.cancel(sessionId);
    if (endpoint === 'export' || endpoint === 'export-check') {
      const q = common
        .extend({
          scheme: modes.optional(),
          layout: z.enum(['standard', 'official']).optional(),
          format: z.enum(['docx', 'md', 'text']).default('text'),
          acknowledged: z.string().optional(),
          suggestionToken: z.string().optional(),
          fontSize: z.union([z.literal(14), z.literal(16)]).default(16),
          articleTitle: z.enum(['omit', 'bracket', 'separate']).default('omit'),
          filename: z.string().min(1).max(1000).optional(),
        })
        .parse(payload);
      const s = await store.read(key);
      const root = s.document.root;
      const profile = profileFor(s.document, q.scheme);
      const sectionHeadings = profile.type !== 'regulation';
      const check = exportCheck(root, profile, q.articleTitle, s.document.importReport);
      const queue = await store.suggestionState(
        key,
        sessionId,
        s,
        endpoint === 'export' ? q.suggestionToken : undefined,
      );
      const pendingCount = queue.suggestions?.reduce((sum, b) => sum + b.entries.length, 0) ?? 0;
      if (endpoint === 'export-check')
        return { ...check, token: s.token, suggestionToken: queue.suggestionToken, pendingCount };
      const recheck = () =>
        new MindError('EXPORT_RECHECK', '文稿或待审队列已更新，请重新核对导出检查');
      if (
        (q.acknowledged && q.acknowledged !== s.token) ||
        ((q.suggestionToken || pendingCount) && q.suggestionToken !== queue.suggestionToken) ||
        ((pendingCount || q.suggestionToken) && q.acknowledged !== s.token)
      )
        throw recheck();
      if ((check.unresolved.length || check.health.length) && q.acknowledged !== s.token)
        throw new MindError(
          'EXPORT_REVIEW',
          '请先核对导出检查中的不导出内容和未解决引用，再确认导出',
        );
      if (q.format === 'text')
        return { text: fullText(root, profile, q.articleTitle, sectionHeadings) };
      const bytes =
        q.format === 'docx'
          ? await exportDocx(
              root,
              profile,
              q.fontSize,
              q.articleTitle,
              q.layout ?? profile.layout,
              sectionHeadings,
            )
          : Buffer.from(markdown(root, profile, q.articleTitle, sectionHeadings), 'utf8');
      // Word packing is asynchronous. Check the exact snapshot and queue again before publishing.
      const latest = await store.read(key);
      if (
        latest.token !== s.token ||
        (await store.suggestionState(key, sessionId, latest, queue.suggestionToken))
          .suggestionToken !== queue.suggestionToken
      )
        throw recheck();
      const filename = await files.exportFile(sessionId, q.filename ?? root.title, q.format, bytes);
      return {
        filename,
        base64: bytes.toString('base64'),
        mime:
          q.format === 'md'
            ? 'text/markdown;charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
    }
    throw new MindError('ENDPOINT', '未知操作');
  }
  for (const endpoint of [
    'state',
    'create',
    'select',
    'import',
    'change',
    'paste',
    'undo',
    'ai',
    'cancel',
    'retry-staging',
    'export',
    'export-check',
    'manuscript',
    'ai-history',
    'quote',
    'reference',
    'quote-state',
    'review-quote',
    'review-draft',
    'suggestion',
    'profile',
    'expansion-default',
    'health',
    'health-fix',
    'revisions',
    'export-revisions',
  ]) {
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: `/api/mindwrite/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          const started = performance.now();
          const message = z
            .object({
              type: z.literal('client-request'),
              rpcId: z.string(),
              method: z.literal(`mindwrite/${endpoint}`),
              payload: z.unknown(),
            })
            .parse(await request.json());
          let result;
          try {
            result = {
              ok: true,
              value: await files.withRequest(() => rpc(endpoint, message.payload, request.signal)),
            };
          } catch (error) {
            result = {
              ok: false,
              error: readableError(error),
            };
          }
          const response = Response.json({ type: 'server-response', rpcId: message.rpcId, result });
          response.headers.set(
            'Server-Timing',
            `mindwrite;dur=${(performance.now() - started).toFixed(3)}`,
          );
          return response;
        },
      }),
    );
  }
  return quotes.ready;
}
