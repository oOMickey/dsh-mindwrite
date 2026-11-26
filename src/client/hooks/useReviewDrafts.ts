import { useRef, useState } from 'react';
import {
  editsSchema,
  reviewKey,
  type ReviewedSuggestion,
  type ReviewDraft,
  type SuggestionEdit,
} from '../../suggestions.ts';
import { documentKey } from '../types.ts';
import type { EditorController } from './useEditor.ts';

type LocalEdit = { value?: SuggestionEdit; digest: string; nonce: string };
function recover(prefix: string) {
  const edits = new Map<string, LocalEdit>();
  if (typeof sessionStorage === 'undefined') return edits;
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    const saved = JSON.parse(sessionStorage.getItem(key)!);
    if (
      typeof saved.digest === 'string' &&
      typeof saved.nonce === 'string' &&
      (saved.value === undefined || editsSchema.safeParse(saved.value).success)
    )
      edits.set(key.slice(prefix.length), saved);
  }
  return edits;
}

/** Keep typed text visible while its conditional save is in flight or has failed. */
export function useReviewDrafts(c: EditorController) {
  const prefix =
    'mindwrite:unsaved-review:' + JSON.stringify([c.sessionId, documentKey(c.snapshot)]) + ':';
  const [local, setLocal] = useState(() => {
    try {
      return recover(prefix);
    } catch {
      return new Map<string, LocalEdit>();
    }
  });
  const saves = useRef(new Map<string, Promise<ReviewDraft>>());
  const remote = new Map(c.reviewDrafts.map((d) => [reviewKey(d.batchId, d.id), d]));
  const drafts = new Map<string, Pick<ReviewDraft, 'digest' | 'value'>>([...remote, ...local]);
  function change(batchId: string, entry: ReviewedSuggestion, value?: SuggestionEdit) {
    const key = reviewKey(batchId, entry.id);
    const prior = saves.current.get(key);
    const base = remote.get(key);
    const existing = drafts.get(key);
    const next = {
      value,
      digest: existing?.value !== undefined ? existing.digest : entry.digest,
      nonce: crypto.randomUUID(),
    };
    try {
      if (typeof sessionStorage !== 'undefined')
        sessionStorage.setItem(prefix + key, JSON.stringify(next));
    } catch {
      c.setError(c.t('draftStorageError'));
    }
    setLocal((old) => new Map(old).set(key, next));
    const save = async () => {
      const previous = prior ? await prior : base;
      return c.saveReviewDraft(
        { batchId, id: entry.id, digest: entry.digest, draftStamp: previous?.stamp },
        value,
        next.digest,
      );
    };
    const work = save();
    saves.current.set(key, work);
    void work
      .then(
        () => {
          try {
            if (
              typeof sessionStorage !== 'undefined' &&
              sessionStorage.getItem(prefix + key) === JSON.stringify(next)
            )
              sessionStorage.removeItem(prefix + key);
          } catch {
            c.setError(c.t('draftStorageError'));
          }
          setLocal((old) => {
            if (old.get(key) !== next) return old;
            const latest = new Map(old);
            latest.delete(key);
            return latest;
          });
        },
        (e: Error) => c.setError(e.message),
      )
      .finally(() => {
        if (saves.current.get(key) === work) saves.current.delete(key);
      });
    return work;
  }
  function saved(batchId: string, id: string) {
    const key = reviewKey(batchId, id);
    const pending = saves.current.get(key);
    const recovered = local.get(key);
    if (!pending && recovered) {
      const entry = c.review.byKey.get(key)?.entry;
      if (!entry) throw Error(c.t('reviewCardExpired'));
      return change(batchId, entry, recovered.value);
    }
    return pending ?? remote.get(key);
  }
  return { drafts, change, saved };
}
