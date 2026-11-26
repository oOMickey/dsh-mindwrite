import { styleTokens } from '../../style-tokens.ts';
import { useEffect, useState, type PointerEvent } from 'react';
const key = 'mindwrite.editor.height';
function savedHeight() {
  try {
    return Math.max(
      styleTokens.resize.min,
      Math.min(
        styleTokens.resize.max,
        Number(localStorage.getItem(key)) || styleTokens.resize.initial,
      ),
    );
  } catch {
    return styleTokens.resize.initial;
  }
}
export function useResizableEditor() {
  const [height, setHeight] = useState(savedHeight);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(key, String(height));
    } catch {
      /* Storage may be unavailable. */
    }
  }, [height]);
  function resize(event: PointerEvent<HTMLElement>) {
    const start = event.clientY;
    const previous = height;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (e: globalThis.PointerEvent) =>
      setHeight(
        Math.max(
          styleTokens.resize.min,
          Math.min(styleTokens.resize.max, previous + start - e.clientY),
        ),
      );
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }
  return { height, setHeight, expanded, setExpanded, resize };
}
