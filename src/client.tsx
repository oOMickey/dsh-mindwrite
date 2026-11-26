import type { DraftSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client';
import React from 'react';
import { QuotePreview } from '@deepseek-ai/dsh-client-ui-primitives';
import { sentQuoteRule } from './quotes.ts';
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import { zh, en } from './locales.ts';
import { Editor } from './client/Editor.tsx';
import { documentKey, type Request, type State } from './client/types.ts';
import css from './style.css';
import { registerIntegrityNotice } from './client/integrity-notice.tsx';

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    mindwrite: { path?: string; documentId?: string };
  }
}
export const inject = [
  'slots',
  'locale',
  'sidebarRightTabs',
  'sidebarRight',
  'connection',
  'uiConversation',
  'sessions',
  'conversation',
];
export function apply(ctx: Context & { connection: ConnectionHandle }) {
  registerIntegrityNotice(ctx);
  ctx.effect(() => ctx.uiConversation.userText.register(sentQuoteRule));
  ctx.effect(() =>
    ctx.slots.inject('conversation.user.text.node', () =>
      ctx.slots.register(
        { name: 'conversation.user.text.node', key: 'mindwrite-quote' },
        ({ node }: UserTextNodeProps<'mindwrite-quote'>) =>
          node.data.review ? (
            <span data-mw-review-quote>
              <QuotePreview text={node.data.text} />
            </span>
          ) : (
            <QuotePreview text={node.data.text} />
          ),
      ),
    ),
  );
  const id = 'dsh-mindwrite';
  const title = () => (ctx.locale.getSnapshot().active.startsWith('zh') ? zh.title : en.title);
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.effect(() =>
    ctx.sidebarRightTabs.register({
      id,
      kind: 'mindwrite',
      patterns: ['*.导图.json', '*.mindwrite.json'],
      title,
      keepMounted: true,
      guide: [
        {
          id: 'mindwrite',
          order: 45,
          title,
          description: () =>
            ctx.locale.getSnapshot().active.startsWith('zh') ? zh.guide : en.guide,
        },
      ],
    }),
  );
  const request: Request = async <T,>(endpoint: string, payload: object): Promise<T> => {
    const result = await ctx.connection.rpc.call('/api', `mindwrite/${endpoint}`, payload);
    if (!result.ok)
      throw Object.assign(new Error(result.error.message), {
        code: result.error.code,
        details: result.error.details,
      });
    return result.value as T;
  };
  ctx.effect(() =>
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: id,
          inject: () => ({
            request,
            readInput: (sessionId: string) => {
              const scope = ctx.sessions.scope(sessionId as SessionId);
              return scope?.get('conversation')?.input.for(scope).state.getSnapshot();
            },
            readComposer: (sessionId: string) => {
              const scope = ctx.sessions.scope(sessionId as SessionId);
              const input = scope?.get('conversation')?.input.for(scope);
              // rc.3 exposes the semantic snapshot on the retained facade. Reading it
              // preserves other plugins' chips when removing ours with public TokenSpan edits.
              if (!input || !('draftSnapshot' in input)) return;
              const snapshot = input.draftSnapshot as DraftSnapshot | undefined;
              if (snapshot && Array.isArray(snapshot.references))
                return { state: input.state.getSnapshot(), document: snapshot };
            },
            initialLanguage: ctx.locale.getSnapshot().active,
            languageSource: {
              subscribe: (fn: () => void) => ctx.locale.subscribe(fn),
              get: () => ctx.locale.getSnapshot().active,
            },
          }),
        },
        Editor,
      ),
    ),
  );
  ctx.effect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const seen = new Map<string, string>();
    const versions = new Map<string, { known: string; knownPath: string }>();
    async function watch() {
      const sessionId = ctx.sidebarRight.mounted.getSnapshot();
      if (sessionId) {
        try {
          const state = await request<State>('state', { sessionId, ...versions.get(sessionId) });
          if (state.snapshot)
            versions.set(sessionId, {
              known: state.snapshot.token,
              knownPath: state.snapshot.path,
            });
          if (
            alive &&
            state.snapshot &&
            ctx.sidebarRight.mounted.getSnapshot() === sessionId &&
            seen.get(sessionId) !== documentKey(state.snapshot)
          ) {
            seen.set(sessionId, documentKey(state.snapshot));
            ctx.sidebarRight.openTab('mindwrite', {
              params: { path: state.snapshot.path, documentId: state.snapshot.id },
            });
          }
        } catch {
          /* The tab owns actionable errors; an unopened session may not yet have a workspace. */
        }
      }
      if (alive) timer = setTimeout(watch, 1200);
    }
    void watch();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  });
}
