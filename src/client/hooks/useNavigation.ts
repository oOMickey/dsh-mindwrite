import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { breakpoints, mapTokens, styleTokens } from '../../style-tokens.ts';
import type { MapCardSource } from '../map-card.ts';
import { flatten, type MindNode } from '../../model.ts';
import { documentKey, type Snapshot } from '../types.ts';
import { layouts, fitZoom, handleClearance, readArrangement, type Arrangement } from '../layout.ts';
import { ancestors, panIntoView, projectTree } from '../navigation.ts';
import { articlePosition, firstArticle, type ReadingAnchor } from '../reading.ts';
export type EditorView = 'map' | 'outline' | 'preview';
type Position = { left: number; top: number };
type FocusMode = 'auto' | 'chapter' | 'all';
type WheelMode = 'zoom' | 'scroll';
interface SavedViewport {
  view: EditorView;
  narrow?: boolean;
  explicitView?: boolean;
  selection: string[];
  zoom: number;
  positions: Partial<Record<EditorView, Position>>;
  focusMode?: FocusMode;
  chapter?: string;
  arrangement?: Arrangement;
  wheelMode?: WheelMode;
  anchor?: ReadingAnchor;
}
type Move = 'origin' | 'position' | 'anchor' | 'fit';
interface ZoomPoint {
  x: number;
  y: number;
  worldX: number;
  worldY: number;
  zoom: number;
}
const frames = (work: () => void) => requestAnimationFrame(() => requestAnimationFrame(work));

export function useNavigation(
  snapshot: Snapshot | null,
  editor: RefObject<HTMLElement>,
  cardSource: MapCardSource,
  displayRoot: MindNode | undefined = snapshot?.root,
) {
  const [hydratedDocument, setHydratedDocument] = useState<string>();
  const [view, setViewState] = useState<EditorView>('outline');
  const explicitView = useRef(false);
  const [selected, updateSelection] = useState<{ ids: string[]; chapterLead?: string }>({
    ids: [],
  });
  const selection = selected.ids;
  // Every ordinary selection, including viewport restoration, drops the chapter-body grant.
  function setSelection(ids: string[] | ((old: string[]) => string[]), chapterLead?: string) {
    updateSelection((old) => ({
      ids: typeof ids === 'function' ? ids(old.ids) : ids,
      chapterLead,
    }));
  }
  const [zoom, setZoom] = useState<number>(styleTokens.zoom.actual);
  const [location, setLocation] = useState<{ id: string; onLocated: () => void }>();
  const [arrangement, setArrangementState] = useState<Arrangement>('right');
  const [wheelMode, setWheelMode] = useState<WheelMode>('zoom');
  const [size, setSize] = useState({ width: 0, height: 0, fitHeight: 0 });
  const [editorWidth, setEditorWidth] = useState<number>(mapTokens.initialWidth),
    [editorHeight, setEditorHeight] = useState<number>(styleTokens.size.editorFallback);
  const [focusMode, setFocusMode] = useState<FocusMode>('auto');
  const [chapter, setChapter] = useState<string>();
  const [folds, setFolds] = useState(new Map<string, boolean>());
  const focused = focusMode === 'chapter' && view !== 'preview';
  const currentChapter =
    chapter && snapshot?.root.children.some((n) => n.id === chapter)
      ? chapter
      : snapshot?.root.children.find((n) => n.kind !== 'preamble')?.id;
  const projected = useMemo(
    () => displayRoot && projectTree(displayRoot, focused ? currentChapter : undefined, folds),
    [displayRoot, focused, currentChapter, folds],
  );
  const visible = useMemo(() => (projected ? flatten(projected, true) : []), [projected]);
  const handleId =
    view === 'map' && selection.length === 1 && displayRoot === snapshot?.root
      ? selection[0]
      : undefined;
  const dense = visible.length > mapTokens.denseAbove;
  const handleSpace = handleId ? handleClearance(zoom, dense) : 0;
  const layout = useMemo(
    () =>
      projected
        ? layouts[arrangement](
            projected,
            editorWidth,
            dense,
            cardSource,
            handleId ? { id: handleId, size: handleSpace } : undefined,
          )
        : null,
    [projected, arrangement, editorWidth, dense, cardSource, handleId, handleSpace],
  );
  const board = useRef<HTMLDivElement>(null),
    outline = useRef<HTMLDivElement>(null),
    preview = useRef<HTMLDivElement | null>(null);
  const documentId = useRef<string>(),
    positions = useRef<SavedViewport['positions']>({});
  const anchor = useRef<ReadingAnchor>(),
    pending = useRef<{ view: EditorView; move: Move }>();
  const explicitAnchor = useRef(false);
  const zoomPoint = useRef<ZoomPoint>();
  const previewWidth = useRef(0);
  const previousMapSize = useRef<{ port: HTMLElement; width: number; height: number }>();
  const placed = useRef<{ port: HTMLElement; left: number; top: number }>();
  const prior = useRef<{ id: string; token: string; ids: Set<string> }>();
  // A viewport of travel at either edge lets a point near a small tree stay under the pointer.
  const offset = {
    x: size.width + Math.max(0, (size.width - (layout?.width ?? 0) * zoom) / 2),
    y: size.height + Math.max(0, (size.height - (layout?.height ?? 0) * zoom) / 2),
  };
  const minZoom = layout
    ? Math.min(
        styleTokens.zoom.mapMin,
        fitZoom(size.width || editorWidth, size.fitHeight || editorHeight, layout),
      )
    : styleTokens.zoom.mapMin;
  const state = {
    snapshot,
    view,
    selection,
    zoom,
    layout,
    chapter,
    focusMode,
    arrangement,
    wheelMode,
    offset,
  };
  const latest = useRef(state);
  latest.current = state;
  const element = () => ({ map: board, outline, preview })[latest.current.view].current;
  const floatingControls = () =>
    editor.current!.querySelectorAll('.mw-map-controls, .mw-map-tools, .mw-workspace > .mw-footer');
  function mapFitHeight(port: HTMLElement) {
    // Narrow controls occupy their own row. Count only the part covering the scrollport.
    const top = port.getBoundingClientRect().top;
    let height = port.clientHeight;
    for (const floating of floatingControls()) {
      const box = floating.getBoundingClientRect();
      if (box.height && box.bottom > top) height = Math.min(height, box.top - top);
    }
    return Math.max(mapTokens.minExtent, height);
  }
  function scroll(port: HTMLElement, position: Position) {
    if (port === outline.current) {
      // Ordinary scrolling ends at the last chapter. An explicit reading position can
      // still align that chapter near the top when returning from another view.
      port.style.removeProperty('--mw-outline-anchor-space');
      const extra = Math.ceil(position.top) - (port.scrollHeight - port.clientHeight);
      if (extra > 0) port.style.setProperty('--mw-outline-anchor-space', extra + 'px');
    }
    port.scrollTo(position);
    placed.current = { port, left: port.scrollLeft, top: port.scrollTop };
  }
  function savePosition() {
    const s = latest.current,
      port = element();
    if (
      !s.snapshot ||
      documentId.current !== documentKey(s.snapshot) ||
      pending.current ||
      zoomPoint.current
    )
      return;
    if (port)
      positions.current[s.view] = {
        left: port.scrollLeft - (s.view === 'map' ? port.clientWidth : 0),
        top: port.scrollTop - (s.view === 'map' ? port.clientHeight : 0),
      };
    try {
      localStorage.setItem(
        `mindwrite:viewport:${documentKey(s.snapshot)}`,
        JSON.stringify({
          view: s.view,
          explicitView: explicitView.current,
          narrow: (editor.current?.clientWidth ?? mapTokens.initialWidth) < breakpoints.narrow,
          selection: s.selection,
          zoom: s.zoom,
          positions: positions.current,
          focusMode: s.focusMode,
          chapter: s.chapter,
          arrangement: s.arrangement,
          wheelMode: s.wheelMode,
          anchor: anchor.current,
        } satisfies SavedViewport),
      );
    } catch {
      /* Browsing also works with local preferences disabled. */
    }
  }
  function onScroll() {
    const port = element(),
      s = latest.current;
    if (!port || pending.current || zoomPoint.current) return;
    // Width changes can clamp scrollTop before ResizeObserver delivers the new
    // pagination. Keep the last article captured in the previous text layout.
    if (s.view === 'preview' && previewWidth.current !== port.clientWidth) return;
    if (s.view === 'map' && (size.width !== port.clientWidth || size.height !== port.clientHeight))
      return;
    const last = placed.current;
    if (!(last?.port === port && port.scrollLeft === last.left && port.scrollTop === last.top)) {
      const first = firstArticle(port, s.view);
      if (first && (s.view === 'preview' || first.id !== anchor.current?.id)) {
        anchor.current = first;
        explicitAnchor.current = false;
      }
    }
    savePosition();
  }
  function markReading(id: string, position?: ReadingAnchor) {
    anchor.current = position ?? { id, paragraph: 0, line: 0 };
    explicitAnchor.current = true;
  }
  function unfold(id: string, root = latest.current.snapshot?.root) {
    if (!root) return;
    const chain = ancestors(root, id);
    if (chain[1]) setChapter(chain[1].id);
    setFolds((old) => {
      const closed = chain.slice(0, -1).filter((n) => old.get(n.id) ?? n.collapsed);
      if (!closed.length) return old;
      const next = new Map(old);
      closed.forEach((n) => next.set(n.id, false));
      return next;
    });
  }
  function reveal(id: string, root = latest.current.snapshot?.root) {
    markReading(id);
    unfold(id, root);
  }
  function ensure(id: string, controls = false) {
    const port = board.current,
      s = latest.current,
      row = s.layout?.nodes.find((n) => n.node.id === id);
    if (!port || !row) return;
    const rightward = s.arrangement === 'right';
    const child = row.node.kind !== 'preamble',
      sibling = row.depth > 0;
    const handle = controls ? styleTokens.size.controlSmall : 0;
    scroll(
      port,
      panIntoView(
        {
          left: port.scrollLeft,
          top: port.scrollTop,
          width: port.clientWidth,
          height:
            port.clientHeight -
            (controls ? styleTokens.size.capsule + styleTokens.space.medium : 0),
        },
        {
          left: s.offset.x + row.x * s.zoom,
          top: s.offset.y + row.y * s.zoom,
          width: row.w * s.zoom + ((rightward ? child : sibling) ? handle : 0),
          height: row.h * s.zoom + ((rightward ? sibling : child) ? handle : 0),
        },
      ),
    );
  }
  function applyAnchor(showChapterStart = false) {
    const port = element(),
      s = latest.current,
      a = anchor.current;
    if (!port || !a) return false;
    // Use final map coordinates even during the CSS layout transition.
    const row = s.view === 'map' && s.layout?.nodes.find((n) => n.node.id === a.id);
    const pos = row
      ? { left: s.offset.x + row.x * s.zoom, top: s.offset.y + row.y * s.zoom }
      : articlePosition(port, s.view, a, showChapterStart);
    if (!pos) return false;
    scroll(port, pos);
    return true;
  }
  function ready() {
    const req = pending.current,
      port = element(),
      s = latest.current;
    if (!req || req.view !== s.view || !port || hydratedDocument !== documentKey(s.snapshot))
      return;
    if (
      s.view === 'map' &&
      (!s.layout ||
        !size.width ||
        !size.height ||
        port.clientWidth !== size.width ||
        port.clientHeight !== size.height ||
        editorWidth !== editor.current?.clientWidth)
    )
      return;
    if (s.view === 'map' && req.move === 'origin') {
      const root = s.layout!.nodes[0],
        inset = 2 * styleTokens.space.medium;
      const readable = Math.min(
        s.zoom,
        (size.width - inset) / root.w,
        (size.height - inset) / root.h,
      );
      if (readable > 0 && readable < s.zoom) {
        setZoom(readable);
        return;
      }
    }
    if (req.move === 'fit' && s.layout) {
      const height = mapFitHeight(port);
      const next = fitZoom(port.clientWidth, height, s.layout);
      // A single selection reserves physical space for its handles at the new scale.
      if (Math.abs(next - s.zoom) > s.zoom * 0.0001) {
        setZoom(next);
        return;
      }
      pending.current = undefined;
      scroll(port, {
        left: s.offset.x + (s.layout.width * s.zoom - port.clientWidth) / 2,
        top: s.offset.y + (s.layout.height * s.zoom - height) / 2,
      });
      return;
    }
    pending.current = undefined;
    if (req.move === 'anchor' && applyAnchor()) return;
    const pos = req.move === 'position' && positions.current[s.view];
    let left = pos ? pos.left : 0,
      top = pos ? pos.top : 0;
    if (s.view === 'map') {
      left += port.clientWidth;
      top += port.clientHeight;
      if (!pos && s.arrangement === 'down') {
        const root = s.layout!.nodes[0];
        left = s.offset.x + (root.x + root.w / 2) * s.zoom - port.clientWidth / 2;
      }
    }
    scroll(port, { left, top });
    if (s.view === 'map' && !pos) ensure(s.layout!.nodes[0].node.id);
  }
  function moveForView(next: EditorView): Move {
    if (next === 'map' && !explicitAnchor.current)
      return positions.current.map ? 'position' : 'origin';
    return anchor.current ? 'anchor' : 'position';
  }
  function previewReady() {
    if (latest.current.view !== 'preview' || !preview.current) return;
    previewWidth.current = preview.current.clientWidth;
    if (pending.current) ready();
    else if (anchor.current) applyAnchor();
  }
  function setView(next: EditorView) {
    explicitView.current = true;
    const s = latest.current;
    if (s.view === next) return;
    const port = element();
    if (!anchor.current && port) anchor.current = firstArticle(port, s.view);
    savePosition();
    if (
      anchor.current &&
      s.view === 'preview' &&
      s.snapshot &&
      !visible.some((r) => r.node.id === anchor.current!.id)
    ) {
      // A review can temporarily expose a folded descendant. Returning to the map must respect that fold.
      const path = ancestors(s.snapshot.root, anchor.current.id);
      const visibleIds = new Set(visible.map((r) => r.node.id));
      const parent = path.reverse().find((n) => visibleIds.has(n.id));
      anchor.current = parent ? { id: parent.id, paragraph: 0, line: 0 } : undefined;
    } else if (anchor.current) unfold(anchor.current.id);
    pending.current = { view: next, move: moveForView(next) };
    setViewState(next);
  }
  function center() {
    explicitView.current = true;
    zoomPoint.current = undefined;
    setViewState('map');
    pending.current = { view: 'map', move: 'fit' };
    if (latest.current.view === 'map') ready();
  }
  function readable(id = latest.current.selection.at(-1) ?? currentChapter) {
    setZoom(styleTokens.zoom.actual);
    if (id) {
      reveal(id);
      setSelection([id]);
      frames(() => ensure(id));
    }
  }
  function locate(id: string, onLocated: () => void) {
    reveal(id);
    setLocation({ id, onLocated });
  }
  useLayoutEffect(() => {
    if (!location) return;
    const { id, onLocated } = location;
    if (view === 'map') {
      // The target can be folded before the jump. Measure its rendered title
      // and wait for the new scale to commit before focusing a hidden label.
      const title = board.current?.querySelector<HTMLElement>(
        `.mw-node[data-node-id="${CSS.escape(id)}"] .mw-title-text`,
      );
      const font = title ? parseFloat(getComputedStyle(title).fontSize) : styleTokens.type.aux.size;
      if (font * zoom < styleTokens.type.aux.size) {
        zoomPoint.current = undefined;
        setZoom(
          Math.max(
            styleTokens.zoom.actual,
            Math.ceil((styleTokens.type.aux.size * styleTokens.zoom.percent) / font) /
              styleTokens.zoom.percent,
          ),
        );
        return;
      }
    }
    setLocation(undefined);
    frames(() => {
      if (latest.current.view === 'map')
        ensure(id, latest.current.selection.length === 1 && latest.current.selection[0] === id);
      else applyAnchor(!!editor.current?.querySelector('.mw-diagnostics[data-report="import"]'));
      onLocated();
    });
  }, [location, zoom, view]);
  function setArrangement(value: Arrangement) {
    if (view === 'map') explicitView.current = true;
    if (value === arrangement) {
      savePosition();
      return;
    }
    if (view === 'map')
      pending.current = {
        view,
        move: anchor.current ? 'anchor' : 'origin',
      };
    setArrangementState(value);
  }
  function zoomAt(factor: number, clientX: number, clientY: number) {
    const port = board.current,
      s = latest.current,
      tree = s.layout;
    if (!port || !tree || !Number.isFinite(factor) || factor <= 0) return;
    const rect = port.getBoundingClientRect(),
      x = clientX - rect.left,
      y = clientY - rect.top;
    const last = zoomPoint.current;
    const from = last?.zoom ?? s.zoom;
    let next = Math.min(styleTokens.zoom.mapMax, Math.max(minZoom, from * factor));
    if (Math.abs(next - 1) < 0.00001) next = styleTokens.zoom.actual;
    if (next === from) return;
    const worldX = last
      ? last.worldX + (x - last.x) / from
      : (port.scrollLeft + x - s.offset.x) / from;
    const worldY = last
      ? last.worldY + (y - last.y) / from
      : (port.scrollTop + y - s.offset.y) / from;
    zoomPoint.current = { x, y, worldX, worldY, zoom: next };
    pending.current = undefined;
    setZoom(next);
  }
  function stepZoom(factor: number) {
    const rect = board.current?.getBoundingClientRect();
    if (rect) zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  function browseChapter(id: string) {
    markReading(id);
    frames(() => {
      if (latest.current.view === 'map') ensure(id);
      else applyAnchor();
    });
  }
  function expandChapter(id: string) {
    unfold(id);
    browseChapter(id);
    setFolds((old) => new Map(old).set(id, false));
  }
  function toggleFold(id: string) {
    const node =
      visible.find((row) => row.node.id === id)?.node ??
      (snapshot && ancestors(snapshot.root, id).at(-1));
    if (!node || node.id !== id) return;
    if (focused && snapshot?.root.children.some((n) => n.id === id) && id !== currentChapter)
      setChapter(id);
    setFolds((old) => new Map(old).set(id, !(old.get(id) ?? node.collapsed)));
  }
  useLayoutEffect(() => {
    if (!snapshot) return;
    const ids = new Set(flatten(snapshot.root).map((r) => r.node.id));
    const sameDocument = documentId.current === documentKey(snapshot);
    if (!sameDocument) {
      documentId.current = documentKey(snapshot);
      setHydratedDocument(documentKey(snapshot));
      setLocation(undefined);
      let saved: SavedViewport | undefined;
      try {
        saved =
          JSON.parse(
            localStorage.getItem(`mindwrite:viewport:${documentKey(snapshot)}`) ??
              localStorage.getItem(`mindwrite:viewport:${snapshot.id}`) ??
              'null',
          ) ?? undefined;
      } catch {
        /* Ignore damaged preferences. */
      }
      positions.current = saved?.positions ?? {};
      const mapPosition = positions.current.map;
      if (mapPosition && !(Number.isFinite(mapPosition.left) && Number.isFinite(mapPosition.top)))
        delete positions.current.map;
      const selected = Array.isArray(saved?.selection)
        ? saved.selection.filter((id) => ids.has(id))
        : [];
      setSelection(selected);
      anchor.current = saved?.anchor && ids.has(saved.anchor.id) ? saved.anchor : undefined;
      explicitAnchor.current = !!anchor.current && selected.includes(anchor.current.id);
      const narrow = (editor.current?.clientWidth ?? editorWidth) < breakpoints.narrow;
      const next =
        saved && ['map', 'outline', 'preview'].includes(saved.view)
          ? saved.view
          : narrow
            ? 'outline'
            : 'map';
      explicitView.current =
        saved?.explicitView ?? (saved ? saved.view !== (saved.narrow ? 'outline' : 'map') : false);
      setViewState(next);
      setZoom(
        saved && Number.isFinite(saved.zoom) && saved.zoom > 0
          ? Math.min(styleTokens.zoom.mapMax, saved.zoom)
          : styleTokens.zoom.actual,
      );
      setArrangementState(readArrangement(saved?.arrangement));
      setWheelMode(saved?.wheelMode === 'scroll' ? 'scroll' : 'zoom');
      setFocusMode(
        saved?.focusMode === 'chapter' || saved?.focusMode === 'all' ? saved.focusMode : 'auto',
      );
      setChapter(saved?.chapter);
      setFolds(new Map());
      zoomPoint.current = undefined;
      pending.current = {
        view: next,
        move:
          next === 'preview' && anchor.current
            ? 'anchor'
            : saved?.positions?.[next]
              ? 'position'
              : moveForView(next),
      };
    } else {
      updateSelection((old) => {
        const kept = old.ids.filter((id) => ids.has(id));
        const lead =
          kept.length && old.chapterLead && ids.has(old.chapterLead) ? old.chapterLead : undefined;
        return kept.length === old.ids.length && lead === old.chapterLead
          ? old
          : { ids: kept, chapterLead: lead };
      });
    }
    if (
      sameDocument &&
      positions.current.map &&
      prior.current?.token !== snapshot.token &&
      snapshot.lastAi &&
      view === 'map'
    ) {
      const added = [...ids].find((id) => !prior.current?.ids.has(id));
      if (added)
        frames(() => {
          reveal(added);
          frames(() => ensure(added));
        });
    }
    prior.current = { id: snapshot.id, token: snapshot.token, ids };
  }, [snapshot?.id, snapshot?.path, snapshot?.token]);
  useLayoutEffect(() => {
    const container = editor.current;
    if (!container) return;
    let narrow = container.clientWidth < breakpoints.narrow;
    const resize = () => {
      const nextNarrow = container.clientWidth < breakpoints.narrow,
        s = latest.current;
      if (nextNarrow !== narrow && !explicitView.current && s.view !== 'preview') {
        const next = nextNarrow ? 'outline' : 'map';
        pending.current = { view: next, move: moveForView(next) };
        if (anchor.current) unfold(anchor.current.id);
        setViewState(next);
      }
      narrow = nextNarrow;
      setEditorWidth(container.clientWidth);
      setEditorHeight(container.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    return () => observer.disconnect();
  }, []);
  const hasContent =
    !!snapshot &&
    (!!displayRoot?.children.length ||
      !!snapshot.root.body.trim() ||
      !!cardSource.value(snapshot.root, 'body').trim());
  const hasSelection = selection.length > 0;
  useLayoutEffect(() => {
    const port = board.current;
    if (!port) return;
    if (!pending.current && previousMapSize.current?.port !== port) {
      pending.current = { view: 'map', move: moveForView('map') };
    }
    const resize = () => {
      const width = port.clientWidth,
        height = port.clientHeight,
        fitHeight = mapFitHeight(port);
      setSize((old) =>
        old.width === width && old.height === height && old.fitHeight === fitHeight
          ? old
          : { width, height, fitHeight },
      );
    };
    const observer = new ResizeObserver(resize);
    observer.observe(port);
    for (const control of floatingControls()) observer.observe(control);
    resize();
    return () => observer.disconnect();
  }, [view, hasContent, hasSelection]);
  useLayoutEffect(() => {
    const point = zoomPoint.current,
      port = board.current;
    if (port && size.width === port.clientWidth && size.height === port.clientHeight) {
      const old = previousMapSize.current;
      if (
        !point &&
        !pending.current &&
        old?.port === port &&
        (old.width !== size.width || old.height !== size.height)
      ) {
        scroll(port, {
          left: port.scrollLeft + size.width - old.width,
          top: port.scrollTop + size.height - old.height,
        });
      }
      previousMapSize.current = { port, ...size };
    }
    if (point && layout && port && zoom === point.zoom) {
      scroll(port, {
        left: offset.x + point.worldX * zoom - point.x,
        top: offset.y + point.worldY * zoom - point.y,
      });
      zoomPoint.current = undefined;
    }
  }, [layout, view, zoom, size, hasContent, hydratedDocument, editorWidth]);
  // A transient status footer can resize the board during a toolbar click and disappear
  // before ResizeObserver runs. Finish a pending placement against the settled DOM.
  useLayoutEffect(() => {
    if (pending.current) ready();
  });
  useEffect(() => {
    savePosition();
  }, [
    selection,
    zoom,
    view,
    snapshot?.id,
    snapshot?.path,
    focusMode,
    chapter,
    arrangement,
    wheelMode,
  ]);
  useEffect(() => {
    window.addEventListener('beforeunload', savePosition);
    return () => {
      savePosition();
      window.removeEventListener('beforeunload', savePosition);
    };
  }, []);
  return {
    view,
    readable,
    hasContent,
    hideLabels: zoom < mapTokens.hideLabelsBelow,
    editorWidth,
    editorHeight,
    setView,
    selection,
    setSelection,
    chapterLead: selected.chapterLead,
    minZoom,
    zoom,
    board,
    outline,
    preview,
    size,
    center,
    locate,
    previewReady,
    onScroll,
    savePosition,
    reveal,
    ensure,
    layout,
    visible,
    projected,
    focused,
    focusMode,
    setFocusMode,
    chapter: currentChapter,
    setChapter,
    toggleFold,
    expandChapter,
    browseChapter,
    offset,
    arrangement,
    setArrangement,
    wheelMode,
    setWheelMode,
    zoomAt,
    stepZoom,
    markReading,
    unfold,
  };
}
