import { styleTokens } from '../../style-tokens.ts';
import { useLayoutEffect, useRef, type RefObject } from 'react';

/** FLIP motion for outline reorders; inert exit clones live in a separate presentation layer. */
export function useListMotion(viewport: RefObject<HTMLDivElement>, revision: unknown) {
  const layer = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, { top: number; height: number; clone: HTMLElement }>());
  useLayoutEffect(() => {
    const parent = viewport.current,
      overlay = layer.current;
    if (!parent || !overlay) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const next = new Map<string, { top: number; height: number; clone: HTMLElement }>();
    const animations: Animation[] = [];
    for (const element of parent.querySelectorAll<HTMLElement>('.mw-block[data-node-id]')) {
      const id = element.dataset.nodeId!,
        old = previous.current.get(id);
      const top = element.offsetTop,
        height = element.offsetHeight;
      next.set(id, { top, height, clone: element.cloneNode(true) as HTMLElement });
      if (!reduce && old && old.top !== top && element.dataset.depth !== '1')
        animations.push(
          element.animate(
            [{ transform: `translateY(${old.top - top}px)` }, { transform: 'none' }],
            { duration: styleTokens.motion.move, easing: 'ease-out' },
          ),
        );
    }
    if (!reduce)
      for (const [id, row] of previous.current)
        if (!next.has(id)) {
          const clone = row.clone;
          clone.removeAttribute('data-node-id');
          clone.setAttribute('aria-hidden', 'true');
          clone.inert = true;
          clone.classList.add('mw-node-leaving');
          Object.assign(clone.style, {
            position: 'absolute',
            top: `${row.top}px`,
            left: 'var(--mw-space-regular)',
            width: 'calc(100% - var(--mw-space-large))',
            height: `${row.height}px`,
            margin: '0',
          });
          overlay.append(clone);
        }
    previous.current = next;
    const timer = setTimeout(() => overlay.replaceChildren(), styleTokens.motion.move);
    return () => {
      clearTimeout(timer);
      animations.forEach((animation) => animation.cancel());
      overlay.replaceChildren();
    };
  }, [revision]);
  return layer;
}
