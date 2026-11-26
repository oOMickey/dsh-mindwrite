import type { ProfileFields } from '../document-profile.ts';
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ComposerDraft } from './quote-draft.ts';
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { MindNode, Expansion } from '../model.ts';
import type { ImportNumbering, ImportReport } from '../metadata.ts';
import type { ImportDetection } from '../import-numbering.ts';
import type { ReviewedBatch, ReviewDraft } from '../suggestions.ts';
export interface Snapshot extends ProfileFields {
  importReport?: ImportReport;
  importSummary?: { levels: number; paragraphs: number; excerpts?: Record<number, string> };
  importNumbering?: ImportNumbering;
  detection?: ImportDetection;
  root: MindNode;
  path: string;
  id: string;
  revision: number;
  token: string;
  canUndo: boolean;
  canRedo: boolean;
  lastAi: boolean;
  adoptionId?: string;
  adoptedIds?: string[];
  historyLimited?: boolean;
  expansionDefault?: Expansion;
  hasSource?: boolean;
}
export function documentKey(s: Pick<Snapshot, 'id' | 'path'> | null | undefined) {
  return s ? JSON.stringify([s.path, s.id]) : '';
}
export interface State {
  files: { path: string; title: string }[];
  snapshot?: Snapshot | null;
  locked: boolean;
  suggestions?: ReviewedBatch[];
  reviewDrafts?: ReviewDraft[];
  draftToken?: string;
  revising?: { batchId: string; id: string }[];
  suggestionToken?: string;
  queueNotice?: string | null;
  scope?: { mode: string; ids: string[] } | null;
  alert?: { id: string; kind: string; message: string } | null;
}
export type Request = <T>(endpoint: string, payload: object) => Promise<T>;
export interface EditorProps {
  sessionId: string;
  useTabInfo: UseSidebarRightTabInfo;
  useInput?: <T>(select: (state: InputState) => T) => T;
  inputActions?: InputActions;
  readInput?: (sessionId: string) => InputState | undefined;
  readComposer?: (sessionId: string) => ComposerDraft | undefined;
  request: Request;
  initialLanguage: string;
  languageSource: { subscribe: (fn: () => void) => () => void; get: () => string };
}
export type { LocalDraft as Draft } from './drafts.ts';

export interface AppliedChangeBatch {
  id: string;
  time: string;
  changes: {
    id: string;
    title: string;
    fields: { field: 'title' | 'body' | 'note'; before: string; after: string }[];
  }[];
}
