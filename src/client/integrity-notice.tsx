import React from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client';
import { QUOTE_NOTICE } from '../quotes.ts';

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'mindwrite-integrity': { message: string };
    'mindwrite-suggestions': { count: number; turn: number; summary?: string };
  }
}

// rc.3 folds ordinary context notices into "context injected" in compact Chat.
// A dedicated input-level row keeps the security warning visible after a turn
// ends, and reconstructs it from the durable event when the session is reopened.
export const integrityNotice: ConversationNodeDefinition<{ message: string }> = {
  kind: 'mindwrite-integrity',
  target: 'chat',
  match: (event) => {
    if (
      String(event.type) === QUOTE_NOTICE &&
      typeof (event.data as { message?: unknown })?.message === 'string'
    )
      return { id: String(event.seq), role: 'start' };
    return event.type === 'user/message' &&
      (event.data.source as { kind: string }).kind === 'mindwrite-integrity' &&
      event.surfaceOp === 'append'
      ? { id: String(event.data.id), role: 'start' }
      : null;
  },
  start: (_context, match) => {
    const event = match.event;
    if (String(event.type) === QUOTE_NOTICE)
      return { message: (event.data as { message: string }).message };
    if (event.type !== 'user/message') throw new Error('Expected integrity notice');
    return {
      message: event.data.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n'),
    };
  },
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state && context.start
      ? {
          key: context.key,
          id: context.id,
          kind: 'mindwrite-integrity',
          target: 'chat',
          anchorSeq: context.start.event.seq + 0.01,
          location: context.start.location,
          visibility: 'visible',
          groupTree: 'input',
          data: context.state,
        }
      : null,
};

function IntegrityNotice({ node }: ChatNodeViewProps<'mindwrite-integrity'>) {
  return (
    <div className="mw-chat-integrity" role="alert" data-mindwrite-integrity>
      {node.data.message}
    </div>
  );
}

type Summary = { count: number; turn: number; summary?: string };

const summaryNotice: ConversationNodeDefinition<Summary> = {
  kind: 'mindwrite-suggestions',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message' || event.surfaceOp !== 'append') return null;
    const source = event.data.source as { kind: string; count?: number; turn?: number };
    return source.kind === 'mindwrite-suggestions' &&
      Number.isSafeInteger(source.count) &&
      Number.isSafeInteger(source.turn) &&
      source.count! > 0 &&
      source.turn! > 0
      ? { id: String(event.data.id), role: 'start' }
      : null;
  },
  start: (_context, match) => {
    if (match.event.type !== 'user/message') throw Error('Expected a suggestion receipt');
    const { count, turn, summary } = match.event.data.source as unknown as Summary;
    return { count, turn, summary };
  },
  update: (context) => context.state,
  buildViewNode: (context) =>
    context.state && context.start
      ? {
          key: context.key,
          id: context.id,
          kind: 'mindwrite-suggestions',
          target: 'chat',
          anchorSeq: context.start.event.seq + 0.01,
          location: context.start.location,
          visibility: 'visible',
          groupTree: 'input',
          data: context.state,
        }
      : null,
};

function SuggestionSummary({ node }: ChatNodeViewProps<'mindwrite-suggestions'>) {
  const { turn, count, summary } = node.data;
  // rc.3 also renders its trigger and progress seats for a follow-up. Compact
  // only the completed panel turn in the Chat column containing its receipt.
  // Tool events remain inspectable in Trajectory. Errors keep their own seats.
  const column = `[data-chat-flow]:has([data-mindwrite-summary="${turn}"])`;
  const seats = `${column} [data-chat-turn="${turn}"]`;
  const context = `${column} [data-chat-flow-kind="context"][data-chat-node-key$="${CSS.escape(node.id)}"]`;
  return (
    <>
      <style>{`${context}, ${seats}:is([data-chat-flow-kind="turn-trigger"],[data-chat-flow-kind="turn-process"],[data-step-process]) { display: none; }`}</style>
      <span role="status" data-mindwrite-summary={turn}>
        {summary ?? `已对 ${count} 条给出改写建议`}
      </span>
    </>
  );
}

export function registerIntegrityNotice(ctx: Context) {
  ctx.effect(() => ctx.uiConversation.events.register(summaryNotice));
  ctx.effect(() =>
    ctx.slots.inject('conversation.chat.node', () =>
      ctx.slots.register(
        { name: 'conversation.chat.node', key: 'mindwrite-suggestions' },
        SuggestionSummary,
      ),
    ),
  );
  ctx.effect(() => ctx.uiConversation.events.register(integrityNotice));
  ctx.effect(() =>
    ctx.slots.inject('conversation.chat.node', () =>
      ctx.slots.register(
        { name: 'conversation.chat.node', key: 'mindwrite-integrity' },
        IntegrityNotice,
      ),
    ),
  );
}
