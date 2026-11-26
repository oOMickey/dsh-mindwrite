import { numberedTitles } from '../numbering.ts';
import { profileFor } from '../document-profile.ts';
import { pendingSummary } from '../continuation.ts';
import { readableError } from './errors.ts';
import type { Session } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { MindError, operationSchema, outline, flatten } from '../model.ts';
import { snapshotView, type Files } from './files.ts';
import { taskContext } from './scope-lock.ts';
import { SUGGESTION_REPLY_HINT, WRITING_FIELDS, writingGuidanceFor } from './prompt.ts';
import { ProgressiveGeneration } from '../progressive.ts';

export const versionFields = {
  revision: z.number().int().nonnegative(),
  token: z.string().length(64),
};
const readSchema = z.object({ path: z.string().optional() }).strict();
const writeSchema = readSchema.extend({
  ...versionFields,
  operations: z.array(operationSchema).min(1).max(1000),
});
// The schema can describe nested children for explicit article/unlimited grants.
const nodeRef = { $ref: '#/$defs/node' };
const nodeDefinitions = {
  node: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      note: { type: 'string' },
      children: { type: 'array', items: nodeRef },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

function sessionOf(exec: ToolRunContext) {
  if (!exec.agent) throw new MindError('SESSION', '工具需要当前会话');
  return exec.agent.id;
}
const output: ToolDefinition['output'] = {
  schema: {},
  render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

export function registerTools(
  ctx: Context,
  files: Files,
  isReadOnly: (s: Session) => Promise<boolean>,
) {
  const { store, keyOf } = files;
  const generation = new ProgressiveGeneration();
  const tools: ToolDefinition[] = [
    {
      name: 'mindwrite_read',
      description:
        '读取导图及乐观锁。选区任务先调用本工具：activeTask 包含任务要求、选中节点及允许字段。',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      async execute(args, exec) {
        const a = readSchema.parse(args);
        const sessionId = sessionOf(exec);
        const scope = store.scopes.get(sessionId);
        const path = scope?.documentPath ?? a.path ?? (await files.currentPath(sessionId));
        if (!path) return { files: await files.files(sessionId), current: null };
        const { key } = await keyOf(sessionId, path);
        const s = scope?.revisions
          ? await store.serial(key, async () => {
              const current = await store.read(key);
              await store.prepareScope(scope, current, scope.revisions, true);
              return current;
            })
          : await store.read(key);
        const depth = generation.expansion(sessionId, s.document.expansionDefault, scope);
        const view = snapshotView(s, path, false);
        const titles = numberedTitles(s.document.root, profileFor(s.document));
        const locations = new Map<string, string>();
        for (const { node, parent } of flatten(s.document.root)) {
          const name = titles.get(node.id)!;
          locations.set(
            node.id,
            [parent && locations.get(parent.id), name.prefix + name.title]
              .filter(Boolean)
              .join(' / '),
          );
        }
        const batches = await store.suggestions(key, sessionId, s);
        const readOnly = await isReadOnly(exec.agent!.session);
        const locked = !readOnly && scope && store.lockedSnapshot(scope);
        return {
          ...view,
          token: scope?.revisionToken ?? s.token,
          outline: outline(s.document.root),
          ...(readOnly && {
            access:
              '本轮普通对话只读。若要更新待审稿，请提示作者点一下全文里的待审稿（或抽屉里的“继续改”），再告诉我怎么改。',
          }),
          pendingSuggestions: batches.flatMap((b) =>
            b.entries.map((e) => ({
              location: locations.get(e.id) ?? e.title,
              ...pendingSummary(e),
            })),
          ),
          activeTask: locked
            ? taskContext(
                scope,
                locked.document.root,
                locked.document.sourceRoot,
                writingGuidanceFor(profileFor(locked.document).type),
              )
            : null,
          expansion: {
            confirmationRequired: false,
            allowedParentIds: readOnly
              ? []
              : (generation.permit(sessionId, key, s.document.root, scope, depth)?.parentIds ?? []),
            maximumNewLevels: depth === 'one' ? 1 : depth,
          },
        };
      },
      output,
    },
    {
      name: 'mindwrite_create',
      description:
        '新建导图由作者从右栏发起。普通对话和选区任务都不能用此工具建稿。' + WRITING_FIELDS,
      parameters: {
        $defs: nodeDefinitions,
        type: 'object',
        properties: {
          title: { type: 'string' },
          filename: { type: 'string' },
          children: { type: 'array', items: nodeRef },
        },
        required: ['title'],
      },
      async execute() {
        throw new MindError('SELECTION', '请从右栏新建文稿或搭建结构。');
      },
      output,
    },
    {
      name: 'mindwrite_write',
      description: [
        '选区改写只提交预览建议，请一次提交全部选中条目。无卡普通对话只读。先 read 取得 revision/token。update(id,title/body/note/collapsed)、',
        'add(parentId,nodes,index)、move(id,parentId,index)、delete(id)。',
        'index 为移除移动项后的零基位置。选区完善仅 body，标题模式仅 title，修改说明模式仅 note，扩写仅 add。',
        WRITING_FIELDS +
          '越界整批拒绝。选区任务按返回状态作答，staged 后只用两到四句话合并说明改动、依据和待补事实。指出依据的位置，不复述修改前后的正文。',
      ].join(''),
      parameters: {
        $defs: nodeDefinitions,
        type: 'object',
        properties: {
          path: { type: 'string' },
          revision: { type: 'integer' },
          token: { type: 'string' },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['update', 'add', 'move', 'delete'] },
                id: { type: 'string' },
                parentId: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
                note: { type: 'string' },
                collapsed: { type: 'boolean' },
                index: { type: 'integer' },
                nodes: { type: 'array', items: nodeRef },
              },
              required: ['type'],
            },
          },
        },
        required: ['revision', 'token', 'operations'],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const a = writeSchema.parse(args);
        const sessionId = sessionOf(exec);
        const scope = store.scopes.get(sessionId);
        const { key } = await keyOf(sessionId, a.path);
        if (scope) {
          try {
            const result = await store.submitSuggestions(key, a, sessionId, a.operations, {
              scope,
              signal: exec.signal,
            });
            return result.missing.length
              ? {
                  ...result,
                  status: 'incomplete',
                  replyInstruction: result.suggested.length
                    ? '已收到部分改动，尚未暂存。只补交 missing 中的选中项。若就此结束，只说明已提交的范围和缺项。'
                    : '尚无实际改动，没有待审建议。确有必要时只提交选中项的改动。',
                }
              : { ...result, status: 'staged', replyInstruction: SUGGESTION_REPLY_HINT };
          } catch (error) {
            if (store.publicationStatus(sessionId) === 'failed')
              throw new MindError(
                'STAGING',
                `建议暂存失败。修复后可在面板重试暂存，也可以取消本批。\n${readableError(error).message}`,
              );
            throw error;
          }
        }
        throw new MindError('REFERENCE_ONLY', '本轮对话只读，请先点选要改的待审稿。');
      },
      output,
    },
  ];
  tools.forEach((tool) => {
    const execute = tool.execute;
    ctx.effect(() =>
      ctx.tools.register({
        ...tool,
        execute: (args, exec) => {
          if (!exec.agent) throw new MindError('SESSION', '工具需要当前会话');
          return files.withSession(exec.agent.session, async () => {
            try {
              if (tool.name !== 'mindwrite_read' && (await isReadOnly(exec.agent!.session)))
                throw new MindError(
                  'REFERENCE_ONLY',
                  '本轮仅作参考，不能写入文稿。点一下全文里的这段待审稿（或抽屉里的“继续改”），再告诉我怎么改。',
                );
              return await execute(args, exec);
            } catch (error) {
              const readable = readableError(error);
              throw new MindError(readable.code, readable.message);
            }
          });
        },
      }),
    );
  });
}
