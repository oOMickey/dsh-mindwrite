import { useCallback, useEffect, useRef, useState } from 'react';

export const onboardingKey = 'mindwrite:onboarding:v1';
const initial = { selection: false, review: false, blankDrag: false, plus: false };
export type Hint = keyof typeof initial;
const hints = Object.keys(initial) as Hint[];

/** Shared by the editors on this page, including when storage access throws. */
export function onboardingMemory() {
  const seen = { ...initial };
  function merge(raw: string | null) {
    try {
      const bits = JSON.parse(raw ?? 'null');
      for (const hint of hints) if (bits?.[hint] === true) seen[hint] = true;
    } catch {
      // Ignore malformed preferences.
    }
  }
  function read() {
    try {
      merge(localStorage.getItem(onboardingKey));
    } catch {
      // The in-memory bits still apply to the next document.
    }
    return seen;
  }
  function write() {
    try {
      localStorage.setItem(onboardingKey, JSON.stringify(read()));
    } catch {
      // The page keeps the merged value.
    }
  }
  return {
    read,
    shown(hint: Hint) {
      if (read()[hint]) return false;
      seen[hint] = true;
      write();
      return true;
    },
    sync(raw: string | null) {
      merge(raw);
      // Concurrent tabs may have written different bits before receiving each other's event.
      try {
        const latest = JSON.parse(localStorage.getItem(onboardingKey) ?? '{}');
        if (hints.some((hint) => seen[hint] && latest?.[hint] !== true)) write();
      } catch {
        // Storage is optional.
      }
    },
  };
}
const memory = onboardingMemory();

export function useOnboarding(owner: string) {
  const [queue, setQueue] = useState<{
    owner: string;
    hints: { kind: Hint; preferChapter?: boolean }[];
  }>({ owner, hints: [] });
  const visible = useRef<Hint>();
  const first = queue.owner === owner ? queue.hints[0] : undefined;
  const hint = first?.kind;
  const dismiss = useCallback(() => {
    setQueue((q) => ({ ...q, hints: q.hints.slice(1) }));
    visible.current = undefined;
  }, []);
  const offer = useCallback(
    (kind: Hint, preferChapter?: boolean) => {
      if (!owner || memory.read()[kind]) return;
      const previous = visible.current;
      setQueue((q) => {
        const waiting = q.owner === owner ? q.hints.filter((h) => h.kind !== previous) : [];
        return waiting.some((h) => h.kind === kind)
          ? q
          : { owner, hints: [...waiting, { kind, preferChapter }] };
      });
    },
    [owner],
  );
  const shown = useCallback(() => {
    if (!hint || visible.current === hint) return;
    if (memory.shown(hint)) visible.current = hint;
    else dismiss();
  }, [hint, dismiss]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== onboardingKey || !event.newValue) return;
      memory.sync(event.newValue);
      if (hint && visible.current !== hint && memory.read()[hint]) dismiss();
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [hint, dismiss]);
  useEffect(() => {
    visible.current = undefined;
    setQueue((q) => (q.owner === owner ? q : { owner, hints: [] }));
  }, [owner]);
  return { hint, preferChapter: first?.preferChapter, offer, shown, dismiss };
}
