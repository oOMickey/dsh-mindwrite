import { breakpoints } from '../../style-tokens.ts';
import React, { useEffect, useRef } from 'react';
import { modifierKey } from '../keyboard.ts';
import { Icon } from './Icon.tsx';
import type { WithEditor } from './toolbar.tsx';

export function OnboardingHint({ editor: c }: WithEditor) {
  const { hint, shown, dismiss } = c.onboarding;
  const ref = useRef<HTMLDivElement>(null);
  const relevant =
    hint === 'review'
      ? !!c.aiReviewCount
      : hint === 'plus'
        ? !!c.newHeading
        : hint === 'selection'
          ? c.view !== 'preview' && !!c.targets.ids.length
          : hint === 'blankDrag' && c.view === 'map';
  const show = relevant && c.drawer !== 'help' && !c.creating;
  useEffect(() => {
    if (hint && !relevant) dismiss();
  }, [hint, relevant, dismiss]);
  useEffect(() => {
    const el = ref.current;
    if (!show || !el) return;
    let intersects = false;
    function check() {
      if (intersects && document.visibilityState === 'visible') shown();
    }
    const observer = new IntersectionObserver(([entry]) => {
      intersects = entry.isIntersecting && entry.intersectionRect.height > 0;
      check();
    });
    observer.observe(el);
    document.addEventListener('visibilitychange', check);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', check);
    };
  }, [show, hint, shown]);
  // Keep the workspace's sibling order stable when the first hint appears beside a long map.
  if (!hint || !show) return <div hidden />;
  const chapterPicker =
    c.onboarding.preferChapter ??
    (c.navigation.editorWidth < breakpoints.narrow || matchMedia('(pointer: coarse)').matches);
  const label =
    hint === 'selection'
      ? chapterPicker
        ? 'hintTouchSelection'
        : 'hintSelection'
      : hint === 'review'
        ? 'hintReview'
        : hint === 'plus'
          ? 'hintPlus'
          : chapterPicker
            ? 'hintBlankDragTouch'
            : 'hintBlankDrag';
  return (
    <div className="mw-onboarding" data-hint={hint} ref={ref}>
      <span role="status">{c.t(label).replace('{mod}', modifierKey())}</span>
      {hint === 'review' && c.view !== 'preview' && (
        <button
          onClick={() => {
            dismiss();
            c.openDrawer(null);
            c.setView('preview');
          }}
        >
          {c.t('hintFullText')}
        </button>
      )}
      <button aria-label={c.t('close')} onMouseDown={(e) => e.preventDefault()} onClick={dismiss}>
        <Icon name="close" />
      </button>
    </div>
  );
}
