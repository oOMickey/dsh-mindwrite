import { useLayoutEffect, useRef } from 'react';
import { breakpoints } from '../../style-tokens.ts';
import { composing } from '../keyboard.ts';
import {
  boxBetween,
  boxSelection,
  pastDragThreshold,
  viewportPoint,
  type MapViewport,
  type Point,
} from '../map-selection.ts';
import type { EditorController } from './useEditor.ts';
import { documentKey } from '../types.ts';

type OpenMenu = (node: HTMLElement, x: number, y: number) => void;
interface Gesture {
  id: number;
  button: number;
  mode: 'pan' | 'box';
  start: Point;
  end: Point;
  port: MapViewport;
  selection: string[];
  owner: string;
  chapterPicker: boolean;
  node: HTMLElement | null;
  capture: Element;
  dragged: boolean;
  menuAt?: Point;
  listeners: AbortController;
  frame?: number;
}
const controls =
  'button,input,textarea,select,a,[contenteditable]:not([contenteditable=false]),.mw-inline-editor';
const point = (e: MouseEvent) => ({ x: e.clientX, y: e.clientY });
function consume(e: Event) {
  e.preventDefault();
  e.stopPropagation();
}

export function useMapGestures(c: EditorController, openMenu: OpenMenu) {
  const preview = useRef<HTMLDivElement>(null);
  const live = useRef({ c, openMenu });
  live.current = { c, openMenu };
  const invalidate = useRef<() => void>();
  const hasLayout = !!c.layout;
  useLayoutEffect(() => {
    if (!c.board.current) return;
    const board = c.board.current;
    const lifetime = new AbortController();
    const capture = { capture: true, signal: lifetime.signal };
    let active: Gesture | undefined;
    let space: { element: Element; used: boolean } | undefined;
    // Click/auxclick and contextmenu can arrive after capture is released. Their ownership
    // ends at the next independent pointerdown, including when a mouse reuses its pointerId.
    const consumed = new Set<number>();
    let settledScroll: Point | undefined;

    function finish(g: Gesture, discard: boolean) {
      active = undefined;
      g.listeners.abort();
      if (g.frame !== undefined) cancelAnimationFrame(g.frame);
      if (preview.current) preview.current.hidden = true;
      if (g.capture.hasPointerCapture(g.id)) g.capture.releasePointerCapture(g.id);
      if (discard || g.dragged || g.button !== 0 || g.menuAt || (space && !g.chapterPicker))
        consumed.add(g.id);
      const current = live.current.c;
      if (
        g.mode === 'pan' &&
        g.dragged &&
        current.board.current === board &&
        g.owner === documentKey(current.snapshot)
      ) {
        settledScroll = { x: board.scrollLeft, y: board.scrollTop };
        current.navigation.onScroll();
      }
    }
    function cancel() {
      if (active) finish(active, true);
      space = undefined;
    }
    invalidate.current = cancel;

    function paint(g: Gesture) {
      g.frame = undefined;
      const el = preview.current;
      if (g !== active || !el) return;
      const box = boxBetween(viewportPoint(g.start, g.port), viewportPoint(g.end, g.port));
      el.style.left = g.port.scroll.x + box.left + 'px';
      el.style.top = g.port.scroll.y + box.top + 'px';
      el.style.width = box.right - box.left + 'px';
      el.style.height = box.bottom - box.top + 'px';
      el.hidden = false;
    }
    function advance(g: Gesture, e: PointerEvent, previewFrame: boolean) {
      g.end = point(e);
      if (!g.dragged && !pastDragThreshold(g.start, g.end)) return;
      g.dragged = true;
      if (space) space.used = true;
      if (g.mode === 'pan') {
        board.scrollLeft = g.port.scroll.x - (g.end.x - g.start.x);
        board.scrollTop = g.port.scroll.y - (g.end.y - g.start.y);
      } else if (previewFrame && g.frame === undefined) {
        g.frame = requestAnimationFrame(() => paint(g));
      }
    }
    function down(e: PointerEvent) {
      if (!e.isPrimary || active) return;
      consumed.clear();
      const editor = live.current.c;
      const el = e.target as Element;
      const node = el.closest<HTMLElement>('.mw-node[data-node-id]');
      if (
        el.closest(controls) ||
        editor.composingNodes.current.size ||
        (node &&
          (node.dataset.nodeId === editor.editing ||
            node.dataset.nodeId === editor.inlineEdit?.id ||
            node.dataset.nodeId === editor.newHeading?.node.id))
      )
        return;
      const direct = e.pointerType === 'touch' || e.pointerType === 'pen';
      const chapterPicker = direct || editor.navigation.editorWidth < breakpoints.narrow;
      if (
        (!direct && (e.pointerType !== 'mouse' || (e.button !== 0 && e.button !== 2))) ||
        e.button < 0
      )
        return;
      if (!direct && e.button === 0 && ((node && !space) || e.ctrlKey || e.metaKey || e.altKey))
        return;
      const rect = board.getBoundingClientRect();
      const port: MapViewport = {
        left: rect.left + board.clientLeft,
        top: rect.top + board.clientTop,
        width: board.clientWidth,
        height: board.clientHeight,
        scroll: { x: board.scrollLeft, y: board.scrollTop },
        offset: editor.navigation.offset,
        zoom: editor.zoom,
      };
      if (
        e.clientX < port.left ||
        e.clientX >= port.left + port.width ||
        e.clientY < port.top ||
        e.clientY >= port.top + port.height
      )
        return;
      const start = point(e);
      const g: Gesture = {
        id: e.pointerId,
        button: e.button,
        start,
        end: start,
        port,
        chapterPicker,
        node,
        selection: editor.selection,
        owner: documentKey(editor.snapshot),
        mode: chapterPicker || space || e.button !== 0 ? 'pan' : 'box',
        capture: node ? el : board,
        dragged: false,
        listeners: new AbortController(),
      };
      consume(e);
      // Panning past a title input must not commit its text by blurring it.
      const textFocus =
        editor.editorElement.current?.contains(document.activeElement) &&
        document.activeElement?.matches('input,textarea,[contenteditable=true]');
      if (!node && e.button === 0 && !textFocus) board.focus({ preventScroll: true });
      active = g;
      try {
        g.capture.setPointerCapture(g.id);
      } catch {
        // The pointer or its target can disappear before capture is established.
        cancel();
        return;
      }
      const during = { capture: true, signal: g.listeners.signal };
      document.addEventListener(
        'pointermove',
        (move) => {
          if (move.pointerId === g.id) advance(g, move, true);
        },
        during,
      );
      document.addEventListener(
        'pointerup',
        (up) => {
          if (up.pointerId !== g.id) return;
          const current = live.current.c;
          if (g.selection !== current.selection) return cancel();
          // A host can resize or scroll the pane and release in the same event turn,
          // before ResizeObserver or scroll has delivered the invalidation.
          if (g.mode === 'box') {
            const bounds = board.getBoundingClientRect();
            if (
              board.clientWidth !== port.width ||
              board.clientHeight !== port.height ||
              bounds.left + board.clientLeft !== port.left ||
              bounds.top + board.clientTop !== port.top ||
              board.scrollLeft !== port.scroll.x ||
              board.scrollTop !== port.scroll.y
            )
              return cancel();
          }
          advance(g, up, false);
          finish(g, false);
          if (g.dragged) {
            if (!g.node) current.onboarding.offer('blankDrag', g.chapterPicker);
            if (g.mode === 'box' && current.layout) {
              const ids = boxSelection(current.layout.nodes, g.port, g.start, g.end);
              current.replaceSelection(
                current.newHeading ? ids.filter((id) => id !== current.newHeading!.node.id) : ids,
              );
            }
          } else if (!g.node && g.button === 0 && textFocus) {
            board.focus({ preventScroll: true });
          } else if (g.node && (g.button === 2 || g.menuAt)) {
            const at = g.menuAt ?? g.end;
            live.current.openMenu(g.node, at.x, at.y);
          } else if (direct && g.node && g.button === 0) {
            // A pen or finger need not synthesize a click after a cancelled default pointerdown.
            // The tap belongs to the original card. Consume any compatibility click as well.
            consumed.add(g.id);
            const id = g.node.dataset.nodeId!;
            if (current.navigation.hideLabels) {
              current.navigation.readable(id);
              current.onboarding.offer('selection', true);
            } else {
              if (!up.ctrlKey && !up.metaKey && !up.shiftKey)
                current.focusWithoutSelecting(g.node.querySelector<HTMLElement>('.mw-node-title'));
              current.select(id, {
                ctrlKey: up.ctrlKey,
                metaKey: up.metaKey,
                shiftKey: up.shiftKey,
                nativeEvent: up,
              });
            }
          }
        },
        during,
      );
      document.addEventListener(
        'pointerdown',
        (next) => {
          if (next.pointerId === g.id) return;
          cancel();
          consumed.add(next.pointerId);
          if (board.contains(next.target as Node)) consume(next);
        },
        during,
      );
      document.addEventListener(
        'pointercancel',
        (event) => {
          if (event.pointerId === g.id) cancel();
        },
        during,
      );
      document.addEventListener(
        'keydown',
        (key) => {
          if (
            key.key !== 'Escape' ||
            composing(key) ||
            live.current.c.composingNodes.current.size ||
            key.ctrlKey ||
            key.metaKey ||
            key.altKey
          )
            return;
          cancel();
          if (board.contains(key.target as Node)) consume(key);
        },
        during,
      );
      g.capture.addEventListener(
        'lostpointercapture',
        (event) => {
          if ((event as PointerEvent).pointerId === g.id && event.target === g.capture) cancel();
        },
        during,
      );
    }

    function ownedClick(e: MouseEvent) {
      const id = (e as PointerEvent).pointerId;
      const legacy = !(e as PointerEvent).pointerType;
      if (consumed.has(id) || (legacy && consumed.size && (e.detail || e.type === 'contextmenu')))
        consume(e);
    }
    board.addEventListener('pointerdown', down, capture);
    board.addEventListener(
      'contextmenu',
      (e) => {
        if (active) {
          active.menuAt = point(e);
          consume(e);
        } else ownedClick(e);
      },
      capture,
    );
    for (const name of ['click', 'auxclick', 'dblclick'] as const)
      board.addEventListener(name, ownedClick, capture);
    board.addEventListener(
      'dragstart',
      (e) => {
        if (active || consumed.size) consume(e);
      },
      capture,
    );
    board.addEventListener(
      'scroll',
      () => {
        if (active?.mode === 'pan') return;
        if (
          active &&
          (board.scrollLeft !== active.port.scroll.x || board.scrollTop !== active.port.scroll.y)
        )
          cancel();
        if (
          settledScroll &&
          settledScroll.x === board.scrollLeft &&
          settledScroll.y === board.scrollTop
        )
          return;
        settledScroll = undefined;
        live.current.c.navigation.onScroll();
      },
      capture,
    );
    // Cancel before wheel handling changes the transform, even at the zoom limit or in wheel-scroll mode.
    for (const name of ['wheel', 'gesturestart', 'gesturechange'])
      board.addEventListener(name, cancel, { ...capture, passive: true });
    board.addEventListener(
      'keydown',
      (e) => {
        const editor = live.current.c;
        const el = e.target as Element;
        if (
          composing(e) ||
          editor.composingNodes.current.size ||
          e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          el.closest(controls)
        )
          return;
        if (e.key === 'Escape' && (space || active)) {
          cancel();
          consume(e);
        } else if (e.key === ' ' && !e.shiftKey && document.getSelection()?.isCollapsed !== false) {
          if (e.repeat && !space) return;
          consume(e);
          if (!e.repeat) space = { element: el, used: false };
        }
      },
      capture,
    );
    board.addEventListener(
      'keyup',
      (e) => {
        if (e.key !== ' ' || !space) return;
        const armed = space;
        space = undefined;
        const editor = live.current.c;
        if (
          composing(e) ||
          editor.composingNodes.current.size ||
          e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          e.shiftKey
        )
          return;
        consume(e);
        const id = armed.element.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        if (
          id &&
          !armed.used &&
          armed.element === e.target &&
          armed.element === document.activeElement &&
          !editor.locked
        ) {
          if (editor.navigation.hideLabels) editor.navigation.readable(id);
          else editor.setEditing(id);
        }
      },
      capture,
    );
    board.addEventListener(
      'focusout',
      (e) => {
        if (space?.element === e.target) space = undefined;
        if (!board.contains(e.relatedTarget as Node | null)) cancel();
      },
      capture,
    );
    window.addEventListener('blur', cancel, capture);
    window.addEventListener('resize', cancel, capture);
    return () => {
      cancel();
      lifetime.abort();
      invalidate.current = undefined;
    };
  }, [c.board, hasLayout]);

  useLayoutEffect(() => {
    invalidate.current?.();
  }, [
    c.snapshot?.path,
    c.snapshot?.id,
    c.layout,
    c.zoom,
    c.navigation.size,
    c.navigation.editorHeight,
    c.navigation.editorWidth,
  ]);
  return preview;
}
