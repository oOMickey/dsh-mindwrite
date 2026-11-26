import {
  changedDraft,
  processedSuggestion,
  updatedSuggestion,
  verifyOriginal,
  revisionBase,
} from '../continuation.ts';
import type { RevisionPin, ReviewedSuggestion } from '../suggestions.ts';
import type { Scope } from '../model.ts';
import { numberingSchemes, profileFor } from '../document-profile.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { paragraphSelection } from '../paragraphs.ts';
import { find, flatten, MindError, type MindDocument } from '../model.ts';
import type { Numbering } from '../format.ts';
import {
  makeBlockQuote,
  hasQuoteMarker,
  makeReviewQuote,
  makeReference,
  parseQuoteRequest,
  quoteLines,
  QUOTE_NOTICE,
  type BlockQuote,
  type ResolvedQuote,
} from '../quotes.ts';
import type { Files } from './files.ts';
import type { Version } from '../store.ts';
import type { createScopeLock } from './scope-lock.ts';

export const quoteScheme = z.enum(numberingSchemes);
const binding = z.object({
  code: z.string().regex(/^(?:[A-Z2-9]{8}|[a-f0-9]{24})$/),
  sessionId: z.string(),
  key: z.string(),
  path: z.string(),
  documentId: z.string(),
  nodeId: z.string(),
  token: z.string(),
  revision: z.number().int(),
  mode: z.enum(['polish', 'reference']),
  paragraph: z.number().int().positive().optional(),
  original: z.string().optional(),
  scheme: quoteScheme.optional(),
  text: z.string(),
  claim: z.object({ messageId: z.string(), turn: z.number().int() }).optional(),
});
type Binding = z.infer<typeof binding> & {
  pins?: RevisionPin[];
  review?: { entry: ReviewedSuggestion; card: BlockQuote };
};
// rc.3 pins its own Zod patch release. Only parse() crosses the domain boundary.
type HostSchema = Parameters<typeof domainTable<string, Binding[]>>[0];
const sessionRows = domainTable<string, Binding[]>(z.array(binding) as unknown as HostSchema);
const spec = defineDomain({
  name: 'mindwrite_quotes',
  version: 1,
  layout: 'per-record',
  tables: { sessions: sessionRows },
});
const paragraphSpec = defineDomain({ ...spec, name: 'mindwrite_paragraph_quotes' });

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    [QUOTE_NOTICE]: { message: string };
  }
}
const directText = (m: UserMessage) =>
  m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
const freshQuote = '请在当前文稿的全文中重新引用，再单独发送。';
const marked = (m: UserMessage) => {
  const text = directText(m);
  return (
    hasQuoteMarker(text) && [...quoteLines(text)].some((line) => line.canonical || line.reference)
  );
};

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mindwrite-reference': { kind: 'mindwrite-reference'; form: 'instructions'; scoped?: true };
  }
}
const queueSchema = z.object({
  pending: z.array(z.string()),
  claimed: z.string().nullable(),
  quoted: z.boolean(),
  failedQuote: z.object({ turn: z.number().int(), staged: z.boolean() }).nullable(),
  reading: z.boolean(),
});
type QuoteQueue = z.infer<typeof queueSchema>;

// Only next-turn removals without a cancellation outcome are claims. The host
// replays the same fold on resume, including edits and transfers to next-step.
function foldQueue(state: QuoteQueue, e: SessionEvent): QuoteQueue {
  if (e.type === 'agent/inbox/spliced' && e.data.target === 'next-turn') {
    const { start, inserted, removedCount = 0, outcome } = e.data;
    const pending = [...state.pending];
    const removed = pending.splice(start, removedCount, ...inserted.map((m) => m.id));
    return { ...state, pending, claimed: (!outcome && removed[0]) || state.claimed };
  }
  if (e.type === 'turn/start') return { ...state, quoted: false, claimed: null, reading: false };
  if (
    e.type === 'user/message' &&
    e.surfaceOp === 'append' &&
    e.data.source.kind === 'mindwrite-reference' &&
    !e.data.source.scoped
  )
    return { ...state, reading: true };
  if (e.type === 'step/start' && state.failedQuote) return { ...state, failedQuote: null };
  if (
    e.type === 'user/message' &&
    e.surfaceOp === 'append' &&
    e.data.source.kind === 'mindwrite-suggestions' &&
    state.failedQuote?.turn === e.data.source.turn
  )
    return { ...state, failedQuote: { turn: e.data.source.turn, staged: true } };
  if (
    e.type === 'user/message' &&
    e.surfaceOp === 'append' &&
    e.data.source.kind === 'user' &&
    !state.quoted &&
    marked(e.data)
  )
    return { ...state, quoted: true };
  if (e.type === 'turn/end' && state.quoted)
    return {
      ...state,
      quoted: false,
      failedQuote: e.data.reason.kind === 'error' ? { turn: e.data.turn, staged: false } : null,
    };
  return state;
}

export function registerQuotes(
  ctx: Context,
  files: Files,
  lock: ReturnType<typeof createScopeLock>,
) {
  // A profile package can have its own copy of dsh-session. Plugin records
  // must be appended by the module that constructed the host's Session.
  const runtime: Promise<typeof import('@deepseek-ai/dsh-session')> = ctx.loader.import(
    '@deepseek-ai/dsh-session',
  );
  const queue = ctx.sessionProjections.register({
    key: 'mindwriteQuoteQueue',
    stateVersion: 3,
    stateSchema: queueSchema as unknown as ProjectionDefinition<
      'mindwriteQuoteQueue',
      QuoteQueue
    >['stateSchema'],
    init: (): QuoteQueue => ({
      pending: [],
      claimed: null,
      quoted: false,
      failedQuote: null,
      reading: false,
    }),
    apply: foldQueue,
  });
  const domains = new Map<boolean, Promise<Domain<typeof spec>>>();
  async function table(isolated: boolean) {
    let storage = domains.get(isolated);
    if (!storage) {
      storage = ctx.storageDomain.open(isolated ? paragraphSpec : spec).catch((error) => {
        domains.delete(isolated);
        throw error;
      });
      domains.set(isolated, storage);
    }
    return (await storage).table('sessions');
  }
  ctx.effect(() => async () => {
    for (const storage of domains.values()) await (await storage).close();
  });
  // A restored composer must explicitly pick the current suggestion after a host restart.
  // Older hosts cannot load these grants as ordinary whole-node quotes.
  const reviewRows = new Map<string, Binding[]>();
  const reviewTable = {
    put: async (id: string, rows: Binding[]) => {
      reviewRows.set(id, rows);
    },
  };
  const forget = (sessionId: string) => {
    reviewRows.delete(sessionId);
  };
  ctx.on('session/disposed', (s) => forget(s.id));
  async function registries(sessionId: string) {
    const ordinary = await Promise.all(
      [false, true].map(async (isolated) => {
        const registry = await table(isolated);
        return { isolated, registry, records: registry.get(sessionId) ?? [] };
      }),
    );
    return [
      ...ordinary,
      { isolated: null, registry: reviewTable, records: reviewRows.get(sessionId) ?? [] },
    ];
  }
  const serialize = <T>(id: string, work: () => Promise<T>) =>
    files.store.serial('quote-registry:' + id, work);
  async function issue(
    sessionId: string,
    key: string,
    path: string,
    version: Version,
    nodeId: string,
    scheme: Numbering = 'official',
    paragraph?: number,
    readOnly = false,
  ) {
    return serialize(sessionId, async () => {
      const s = await files.store.read(key);
      if (
        s.token !== version.token ||
        s.revision !== version.revision ||
        (await files.keyOf(sessionId)).key !== key
      )
        throw new MindError('CONFLICT', '文稿已更新，请重新引用。');
      const profile = profileFor(s.document, scheme);
      scheme = profile.scheme;
      const original =
        paragraph === undefined
          ? undefined
          : paragraphSelection(find(s.document.root, nodeId).body, [paragraph]);
      const pins = readOnly
        ? []
        : await files.store.quoteOverlaps(key, sessionId, s, nodeId, paragraph);
      const mode = readOnly ? 'reference' : 'polish';
      const make = readOnly ? makeReference : makeBlockQuote;
      // 0.8.2 only understands whole-node grants and cannot parse decimal schemes.
      const queues = await registries(sessionId);
      const { registry: t, records } = queues.find(
        (q) =>
          q.isolated === (pins.length ? null : paragraph !== undefined || scheme === 'decimal'),
      )!;
      const existing = records.findLast(
        (row) =>
          !row.review &&
          JSON.stringify(row.pins ?? []) === JSON.stringify(pins) &&
          row.key === key &&
          row.token === s.token &&
          row.nodeId === nodeId &&
          row.mode === mode &&
          row.paragraph === paragraph &&
          !row.claim &&
          (row.scheme ?? 'official') === scheme,
      );
      if (existing) {
        const card = make(s.document.root, nodeId, existing.code, scheme, profile, paragraph);
        // A different app version can display the same unchanged file differently.
        // Each signed line must continue to match its own stored grant.
        if (card.text === existing.text) return card;
      }
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code: string;
      do {
        code = pins.length
          ? randomBytes(16).toString('hex')
          : readOnly
            ? randomBytes(12).toString('hex')
            : Array.from(randomBytes(8), (byte) => alphabet[byte & 31]).join('');
      } while (queues.some((q) => q.records.some((r) => r.code === code)));
      const quote = make(s.document.root, nodeId, code, scheme, profile, paragraph);
      await t.put(sessionId, [
        // An unsent card can survive a save or a restored draft. Keep its signed line for replacement.
        ...records.filter((r) => !r.claim || r.key !== key || r.token === s.token),
        {
          code,
          sessionId,
          key,
          path,
          documentId: s.document.id,
          nodeId,
          revision: s.revision,
          token: s.token,
          mode,
          paragraph,
          ...(pins.length && { pins }),
          original,
          scheme,
          text: quote.text,
        },
      ]);
      return quote;
    });
  }

  async function issueReview(
    sessionId: string,
    key: string,
    path: string,
    version: Version,
    pin: RevisionPin,
    scheme: Numbering = 'official',
  ) {
    return serialize(sessionId, () =>
      files.store.serial(key, async () => {
        const s = await files.store.read(key);
        if (
          (await files.keyOf(sessionId)).key !== key ||
          s.token !== version.token ||
          s.revision !== version.revision
        )
          throw updatedSuggestion();
        const batches = await files.store.suggestions(key, sessionId, s);
        const entry = batches
          .find((b) => b.id === pin.batchId)
          ?.entries.find((e) => e.id === pin.id);
        if (!entry) throw processedSuggestion();
        if (entry.digest !== pin.digest) throw updatedSuggestion();
        verifyOriginal(s.document.root, entry);
        const { reviewDrafts } = await files.store.draftState(key, sessionId, s);
        const draft = reviewDrafts?.find((d) => d.batchId === pin.batchId && d.id === pin.id);
        if (draft?.stamp !== pin.draftStamp) throw changedDraft();
        revisionBase(entry, draft?.value);
        const rows = reviewRows.get(sessionId) ?? [];
        const prior = rows.find(
          (r) =>
            !r.claim &&
            r.review &&
            r.key === key &&
            r.token === s.token &&
            r.pins?.[0].batchId === pin.batchId &&
            r.pins[0].id === pin.id &&
            r.pins[0].digest === pin.digest &&
            r.pins[0].draftStamp === pin.draftStamp,
        );
        if (prior?.review) return prior.review.card;
        const code = randomBytes(16).toString('hex');
        const profile = profileFor(s.document, scheme);
        const card = makeReviewQuote(
          s.document.root,
          entry,
          pin.batchId,
          code,
          profile.scheme,
          profile,
        );
        reviewRows.set(sessionId, [
          ...rows.filter(
            (r) =>
              !(
                r.key === key &&
                r.pins?.some((p) => p.id === pin.id && p.batchId === pin.batchId) &&
                r.review
              ),
          ),
          {
            code,
            sessionId,
            key,
            path,
            token: s.token,
            revision: s.revision,
            documentId: s.document.id,
            nodeId: entry.id,
            mode: 'polish',
            pins: [pin],
            review: { entry, card },
            text: card.text,
          },
        ]);
        return card;
      }),
    );
  }
  // This address can only resolve a node in the session's current file. It is never
  // registered in the write-grant table, including when the user copies its text.
  function marker(
    sessionId: string,
    key: string,
    docId: string,
    nodeId: string,
    scheme: Numbering,
  ) {
    const address = [sessionId, key, docId, nodeId];
    if (scheme !== 'official') address.push(scheme);
    return createHash('sha256').update(JSON.stringify(address)).digest('hex').slice(0, 24);
  }
  async function reference(
    sessionId: string,
    key: string,
    version: Version,
    id: string,
    scheme: Numbering = 'official',
    paragraph?: number,
  ) {
    if (paragraph !== undefined)
      return issue(
        sessionId,
        key,
        (await files.keyOf(sessionId)).path,
        version,
        id,
        scheme,
        paragraph,
        true,
      );
    const s = await files.store.read(key);
    if (s.token !== version.token || (await files.keyOf(sessionId)).key !== key)
      throw new MindError('CONFLICT', '文稿已切换，请重新选择参考条款。');
    const profile = profileFor(s.document, scheme);
    scheme = profile.scheme;
    return makeReference(
      s.document.root,
      id,
      marker(sessionId, key, s.document.id, id, scheme),
      scheme,
      profile,
    );
  }
  function* referenceNodes(sessionId: string, key: string, doc: MindDocument, codes: string[]) {
    const wanted = new Set(codes.filter((code) => code.length === 24));
    if (!wanted.size) return;
    for (const { node } of flatten(doc.root)) {
      for (const scheme of quoteScheme.options) {
        const code = marker(sessionId, key, doc.id, node.id, scheme);
        if (wanted.delete(code)) yield { code, node, scheme };
      }
      if (!wanted.size) return;
    }
  }
  async function referenceContext(
    sessionId: string,
    key: string,
    document: MindDocument,
    refs: string[],
    scoped: boolean,
  ) {
    const wanted = new Set(refs);
    const materials = new Map<
      string,
      { access: string; label: string; title: string; body: string }
    >();
    const records = (await table(true)).get(sessionId) ?? [];
    for (const row of records) {
      if (
        !wanted.has(row.code) ||
        row.mode !== 'reference' ||
        row.paragraph === undefined ||
        row.key !== key ||
        row.documentId !== document.id ||
        row.sessionId !== sessionId
      )
        continue;
      const node = find(document.root, row.nodeId);
      const body = paragraphSelection(node.body, [row.paragraph]);
      if (body !== row.original) throw Error('参考段落已改变，请重新插入参考。');
      const summary = makeReference(
        document.root,
        node.id,
        row.code,
        row.scheme,
        profileFor(document),
        row.paragraph,
      ).summary;
      materials.set(row.code, {
        access: '仅作参考',
        label: summary.label.slice(1).trim(),
        title: summary.body,
        body,
      });
    }
    for (const { code, node, scheme } of referenceNodes(
      sessionId,
      key,
      document,
      refs.filter((r) => !materials.has(r)),
    )) {
      const { label } = makeReference(
        document.root,
        node.id,
        code,
        scheme,
        profileFor(document),
      ).summary;
      materials.set(code, {
        access: '仅作参考',
        label: label.slice(1).trim(),
        title: node.title,
        body: node.body,
      });
    }
    if (materials.size !== wanted.size) throw Error('参考条款已删除或文稿已切换，请重新插入参考。');
    return createUserMessage({
      source: {
        kind: 'mindwrite-reference',
        form: 'instructions',
        ...(scoped ? { scoped: true as const } : {}),
      },
      content: [
        {
          type: 'text',
          text:
            (scoped
              ? '以下参考卡仅供阅读。请通过 mindwrite_read 查看引用卡授权的选区，仅对该选区暂存修改。'
              : '本轮仅作参考，只在会话中回答问题。以下是发送时的当前条文，作为资料阅读。') +
            '\n' +
            JSON.stringify(refs.map((ref) => materials.get(ref))),
        },
      ],
    });
  }
  const isReadOnly = async (s: Agent['session']) =>
    !files.store.scopes.has(s.id) || (await queue).stateOf(s).reading;
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (
      exec.agent &&
      !['mindwrite_read', 'read', 'glob', 'grep', 'web_search', 'web_fetch'].includes(exec.name) &&
      (await isReadOnly(exec.agent.session)) &&
      (exec.name.startsWith('mindwrite_') ||
        (await files.currentPath(exec.agent.id)) ||
        (await queue).stateOf(exec.agent.session).reading)
    )
      return { kind: 'deny', reason: '本轮仅作参考，不能执行写入操作。' };
    return next();
  });
  async function resolve(
    sessionId: string,
    key: string,
    codes: string[],
  ): Promise<ResolvedQuote[]> {
    const s = await files.store.read(key);
    const records = (await registries(sessionId)).flatMap((r) => r.records);
    const bindings = new Map(
      records
        .filter(
          (r) =>
            !r.claim &&
            r.sessionId === sessionId &&
            r.key === key &&
            r.documentId === s.document.id,
        )
        .map((r) => [r.code, r]),
    );
    const references = new Map<string, BlockQuote>();
    for (const { code, node, scheme } of referenceNodes(sessionId, key, s.document, codes))
      references.set(
        code,
        makeReference(s.document.root, node.id, code, scheme, profileFor(s.document)),
      );
    const checkPins = codes.some((code) => bindings.get(code)?.pins?.length);
    const pending = checkPins ? await files.store.suggestions(key, sessionId, s) : [];
    const drafts = checkPins ? (await files.store.draftState(key, sessionId, s)).reviewDrafts : [];
    let nodeIds: Set<string> | undefined;
    return codes.flatMap<ResolvedQuote>((code) => {
      const ref = references.get(code);
      if (ref) return [ref];
      const row = bindings.get(code);
      if (!row) return [];
      const invalid = row.pins?.some((pin) => {
        const e = pending.find((b) => b.id === pin.batchId)?.entries.find((e) => e.id === pin.id);
        const d = drafts?.find((d) => d.batchId === pin.batchId && d.id === pin.id);
        return e?.digest !== pin.digest || d?.stamp !== pin.draftStamp;
      });
      if (invalid || row.token !== s.token || row.revision !== s.revision) {
        if (row.review) nodeIds ??= new Set(flatten(s.document.root).map(({ node }) => node.id));
        return [
          {
            code,
            nodeId: row.nodeId,
            ...(row.paragraph && { paragraph: row.paragraph }),
            text: row.text,
            ...(row.review && { reviewBatch: row.review.card.reviewBatch }),
            stale: row.review && !nodeIds!.has(row.nodeId) ? 'deleted' : true,
          },
        ];
      }
      if (row.review) return [row.review.card];
      const make = row.mode === 'reference' ? makeReference : makeBlockQuote;
      return [
        {
          ...make(
            s.document.root,
            row.nodeId,
            code,
            row.scheme,
            profileFor(s.document),
            row.paragraph,
          ),
          text: row.text,
        },
      ];
    });
  }

  async function claim(
    agent: Agent,
    message: UserMessage,
    turn: number,
    signal: AbortSignal,
    request: ReturnType<typeof parseQuoteRequest>,
    { key, path }: Awaited<ReturnType<Files['keyOf']>>,
    s: Awaited<ReturnType<Files['store']['read']>>,
  ) {
    const { codes, lines, instruction } = request;
    const queues = await registries(agent.id);
    const records = queues.flatMap((q) => q.records);
    const rows = codes.map((code, i) => {
      const row = records.find((r) => r.code === code && r.sessionId === agent.id);
      if (!row || row.mode !== 'polish' || row.text !== lines[i])
        throw new Error('编号不属于本会话，或引用文字已经改变。');
      return row;
    });
    const first = rows[0];
    const previous = first.claim;
    if (
      previous &&
      rows.every((r) => r.claim?.messageId === message.id) &&
      previous.turn === turn &&
      files.store.scopes.get(agent.id)?.quoteMessage === message.id
    )
      return;
    if (rows.some((r) => r.claim)) throw new Error('此引用已经发送。');
    if (rows.some((r) => r.key !== key || r.documentId !== s.document.id || r.mode !== first.mode))
      throw new Error('当前文稿或引用版本已经改变。');
    const ids = [...new Set(rows.map((r) => r.nodeId))];
    const entryMode = (r: Binding): Scope['mode'] => {
      const field = r.review?.entry.field ?? 'body';
      return field === 'body' ? 'polish' : field === 'children' ? 'expand' : field;
    };
    if (rows.some((r) => entryMode(r) !== entryMode(first)))
      throw Error('请分别发送不同字段的待审稿。');
    const ordinals = (r: Binding) =>
      r.review?.entry.field === 'body'
        ? r.review.entry.paragraphs
        : r.paragraph
          ? [r.paragraph]
          : undefined;
    const whole = new Set(rows.filter((r) => !ordinals(r)).map((r) => r.nodeId));
    const paragraphs = rows
      .filter((r) => !whole.has(r.nodeId))
      .flatMap((r) =>
        (ordinals(r) ?? []).map((ordinal) => ({
          nodeId: r.nodeId,
          ordinal,
          original:
            r.review?.entry.field === 'body'
              ? paragraphSelection(r.review.entry.before, [ordinal])
              : r.original!,
        })),
      )
      .filter(
        (p, i, all) =>
          all.findIndex((other) => other.nodeId === p.nodeId && other.ordinal === p.ordinal) === i,
      )
      .sort((a, b) => a.ordinal - b.ordinal);
    if (rows.some((r) => r.token !== first.token || r.revision !== first.revision))
      throw updatedSuggestion();
    const pins = rows.flatMap((r) => r.pins ?? []);
    if (
      pins.some((p) =>
        pins.some(
          (q) =>
            p.id === q.id &&
            p.batchId === q.batchId &&
            (p.digest !== q.digest || p.draftStamp !== q.draftStamp),
        ),
      )
    )
      throw updatedSuggestion();
    const { scope } = await lock.acquire(
      agent,
      key,
      path,
      {
        ids,
        mode: entryMode(first),
        pins,
        explicitReview: rows.every((r) => !!r.review),
        expansion:
          first.review?.entry.field === 'children' ? first.review.entry.expansion : undefined,
        ...(paragraphs.length && { paragraphs }),
        instruction,
        revision: first.revision,
        token: first.token,
      },
      turn,
      signal,
    );
    try {
      signal.throwIfAborted();
      scope.quoteMessage = message.id;
      const accepted = new Set(codes);
      for (const queue of queues) {
        if (queue.records.some((r) => accepted.has(r.code)))
          await queue.registry.put(
            agent.id,
            queue.records.map((r) =>
              accepted.has(r.code) ? { ...r, claim: { messageId: message.id, turn } } : r,
            ),
          );
      }
    } catch (error) {
      files.store.cancelScope(agent.id);
      await lock.finish(agent.id, turn);
      throw error;
    }
  }

  ctx.on(
    'agent/pre-step',
    async ({ agent, messages, turn, step, signal }, next) => {
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      const state = (await queue).stateOf(agent.session);
      if (
        state.failedQuote &&
        [...messages, ...decision.messages].some(
          (m) => m.source.kind === 'retry' && !m.content.length,
        )
      ) {
        (await runtime).appendPluginRecord(agent.session, QUOTE_NOTICE, {
          message: state.failedQuote.staged
            ? '上轮的建议已暂存，收尾说明未完成。请在右栏审阅，需要补充时可选择“修改后采用”。'
            : '上轮引用改写失败。' + freshQuote,
        });
        return { kind: 'reject' };
      }
      const direct = messages.filter((m) => m.source.kind === 'user');
      const final = decision.messages.filter((m) => m.source.kind === 'user');
      const markedIds = new Set([...direct, ...final].filter(marked).map((m) => m.id));
      const requests = decision.messages.filter((m) => markedIds.has(m.id));
      if (!requests.length) {
        if (step > 1 && direct.length && files.store.scopes.has(agent.id)) {
          (await runtime).appendPluginRecord(agent.session, QUOTE_NOTICE, {
            message: '请在当前改写结束后单独发送问题，或选择排队发送。',
          });
          const steered = new Set(direct.map((m) => m.id));
          return { ...decision, messages: decision.messages.filter((m) => !steered.has(m.id)) };
        }
        return decision;
      }
      const original = direct[0];
      const independent = step === 1 && direct.length === 1 && state.claimed === original.id;
      try {
        if (!independent || final.length !== 1 || requests.length !== 1 || requests[0] !== final[0])
          throw new Error('请单独发送引用改写请求。请等待当前回复结束，或选择排队发送。');
        const delivered = final[0];
        if (
          delivered.id !== original.id ||
          !('rpcId' in original.source) ||
          !('rpcId' in delivered.source) ||
          original.source.rpcId !== delivered.source.rpcId
        )
          throw new Error('无法确认这条引用来自会话输入框。');
        const sent = parseQuoteRequest(directText(original));
        const issued = new Set([...sent.lines, ...sent.references]);
        const request = parseQuoteRequest(directText(delivered));
        const received = new Set([...request.lines, ...request.references]);
        if (
          !issued.size ||
          issued.size !== received.size ||
          [...issued].some((line) => !received.has(line))
        )
          throw new Error('发送时引用范围已经改变。');
        return await serialize(agent.id, async () => {
          const file = await files.keyOf(agent.id);
          const snapshot = await files.store.read(file.key);
          const scoped = request.codes.length > 0;
          if (!scoped && files.store.scopes.has(agent.id))
            throw Error('请在当前改写结束后发送只读提问。');
          const context = sent.references.length
            ? await referenceContext(agent.id, file.key, snapshot.document, sent.references, scoped)
            : undefined;
          if (scoped) await claim(agent, delivered, turn, signal, request, file, snapshot);
          return context ? { ...decision, messages: [...decision.messages, context] } : decision;
        });
      } catch (error) {
        signal.throwIfAborted();
        const summary = error instanceof Error ? error.message : '引用未生效。';
        const originalText = direct
          .filter((m) => markedIds.has(m.id))
          .map(directText)
          .join('\n')
          .slice(0, 5000);
        (await runtime).appendPluginRecord(agent.session, QUOTE_NOTICE, {
          message: `${summary}${freshQuote}\n原要求：\n${originalText}`,
        });
        // Reject a standalone invalid request before the model runs. A steer must not
        // cancel existing work or authorize another operation in the ongoing turn.
        return independent
          ? { kind: 'reject' }
          : {
              ...decision,
              messages: decision.messages.filter((m) => !requests.some((q) => q.id === m.id)),
            };
      }
    },
    { prepend: true },
  );
  return {
    issue,
    issueReview,
    forget,
    resolve,
    reference,
    isReadOnly,
    ready: Promise.all([queue, runtime]).then(() => {}),
  };
}
