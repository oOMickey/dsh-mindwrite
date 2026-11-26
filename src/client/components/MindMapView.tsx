import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AddNodeButton, FoldButton, NodeTitle, StateBadges } from './NodeEditor.tsx';
import { ActionButton, type WithEditor } from './toolbar.tsx';
import {
  arrangements,
  connections,
  exitPort,
  type Arrangement,
  type LayoutNode,
} from '../layout.ts';
import { useMapGestures } from '../hooks/useMapGestures.ts';
import { MapEditCard } from './InlineEditor.tsx';
import { styleTokens, breakpoints, mapTokens } from '../../style-tokens.ts';
import { Icon } from './Icon.tsx';
import type { MapCardContent } from '../map-card.ts';

export function LayoutSelect({ editor: c }: WithEditor) {
  return (
    <select
      aria-label={c.t('arrangement')}
      title={c.t('arrangement')}
      value={c.navigation.arrangement}
      onChange={(e) => c.navigation.setArrangement(e.target.value as Arrangement)}
    >
      {arrangements.map((value) => (
        <option key={value} value={value}>
          {c.t(value === 'down' ? 'downLayout' : value)}
        </option>
      ))}
    </select>
  );
}
export function MindMapView({
  editor: c,
  openMenu,
}: WithEditor & {
  openMenu: (node: HTMLElement, x: number, y: number) => void;
}) {
  const marquee = useMapGestures(c, openMenu);
  const layout = c.layout;
  // Layouts visit each chapter and its descendants together in document order.
  const branches = useMemo(() => {
    const groups = new Map<string, LayoutNode[]>();
    let head = '';
    for (const row of layout?.nodes ?? []) {
      if (row.depth < 2) head = row.node.id;
      if (!groups.has(head)) groups.set(head, []);
      groups.get(head)!.push(row);
    }
    return groups;
  }, [layout]);
  const downSelection = c.navigation.arrangement === 'down' ? c.selection : undefined;
  const rings = useMemo(() => downSelection && new Set(downSelection), [downSelection]);
  const paths = useMemo(() => {
    const chapters = Array.from(branches.values(), (rows) => rows[0]);
    const result = new Map(
      connections(chapters, c.navigation.arrangement, rings).map(({ row, path }) => [
        row.node.id,
        path,
      ]),
    );
    for (const rows of branches.values()) {
      const { x, y } = rows[0];
      const local = rows.map((row) => ({ ...row, x: row.x - x, y: row.y - y }));
      for (const { row, path } of connections(local, c.navigation.arrangement, rings))
        result.set(row.node.id, path);
    }
    return result;
  }, [branches, c.navigation.arrangement, rings]);
  // Work up the document once, including any selected descendants hidden by a fold.
  const active = useMemo(() => {
    const ids = new Set(c.selection);
    if (c.newHeading && ids.has(c.newHeading.node.id)) ids.add(c.newHeading.parentId);
    if (ids.size) {
      for (let i = c.rows.length - 1; i >= 0; i--) {
        const { node, parent } = c.rows[i];
        if (parent && ids.has(node.id)) ids.add(parent.id);
      }
    }
    return ids;
  }, [c.selection, c.rows, c.newHeading]);
  const edges = useMemo(() => {
    function paint(rows: LayoutNode[]) {
      // Shared directory trunks must keep the selected stroke on top.
      const normal: React.ReactElement[] = [],
        highlighted: React.ReactElement[] = [];
      for (const row of rows) {
        const selected = active.has(row.node.id);
        (selected ? highlighted : normal).push(
          <path
            key={row.node.id}
            data-to={row.node.id}
            data-active={selected}
            d={paths.get(row.node.id)}
          />,
        );
      }
      return [...normal, ...highlighted];
    }
    const groups = [...branches.values()];
    return (
      <>
        {paint(groups.slice(1).map((rows) => rows[0]))}
        {groups.map((rows) => {
          const head = rows[0];
          return (
            <g
              key={head.node.id}
              data-branch-edges={head.node.id}
              transform={`translate(${head.x} ${head.y})`}
            >
              {paint(rows.slice(1))}
              {c.navigation.arrangement !== 'directory' &&
                rows.map((row) => {
                  if (row.node.collapsed || !row.node.children.length) return null;
                  const port = exitPort(row, c.navigation.arrangement, rings?.has(row.node.id));
                  return (
                    <circle
                      key={row.node.id}
                      cx={port.x - head.x}
                      cy={port.y - head.y}
                      r={styleTokens.manuscript.portRadius}
                      data-active={row.node.children.some((child) => active.has(child.id))}
                    />
                  );
                })}
            </g>
          );
        })}
      </>
    );
  }, [branches, paths, active, c.navigation.arrangement, rings]);
  const previous = useRef<LayoutNode[]>([]);
  const previousArrangement = useRef(c.navigation.arrangement);
  const ghosts = useRef<React.Dispatch<React.SetStateAction<LayoutNode[]>> | null>(null);
  useLayoutEffect(() => {
    const next = layout?.nodes ?? [];
    const ids = new Set(next.map((row) => row.node.id));
    // Presentation-only exit ghosts never intercept selection, keyboard or drag events.
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const switched = previousArrangement.current !== c.navigation.arrangement;
    const oldRows = new Map(previous.current.map((r) => [r.node.id, r]));
    const folded = next.some(
      (r) =>
        oldRows.has(r.node.id) && !!oldRows.get(r.node.id)!.node.collapsed !== !!r.node.collapsed,
    );
    // Fading every removed card and then disposing its layer mid-slide stalls
    // the dense canvas. The surviving chapters carry the visible fold motion.
    const board = c.board.current;
    const common = folded ? next.reduce((n, row) => n + Number(oldRows.has(row.node.id)), 0) : 0;
    const instantFold = folded && Math.max(next.length, previous.current.length) - common > 40;
    board?.toggleAttribute('data-instant-fold', instantFold);
    const denseFold =
      folded && Math.max(next.length, previous.current.length) > mapTokens.denseAbove;
    const removed =
      !reduce && !instantFold && !denseFold
        ? previous.current.filter((row) => !ids.has(row.node.id))
        : [];
    const slides: Animation[] = [];
    // Small maps previously animated both reordering and arrangement switches.
    const smallMove =
      next.length <= mapTokens.denseAbove &&
      next.some((row) => {
        const old = oldRows.get(row.node.id);
        return old && (row.x !== old.x || row.y !== old.y);
      });
    if (board && !reduce && !instantFold && ((folded && !switched) || smallMove)) {
      const slide = (element: Element | null, dx: number, dy: number) => {
        if (element && (dx || dy))
          slides.push(
            element.animate([{ translate: dx + 'px ' + dy + 'px' }, { translate: 'none' }], {
              duration: styleTokens.motion.move,
              easing: 'linear',
              fill: 'backwards',
            }),
          );
      };
      for (const container of board.querySelectorAll<HTMLElement>('[data-map-branch]')) {
        const rows = branches.get(container.dataset.mapBranch!)!;
        const head = rows[0],
          oldHead = oldRows.get(head.node.id);
        if (!oldHead) continue;
        const dx = oldHead.x - head.x,
          dy = oldHead.y - head.y;
        slide(container, dx, dy);
        slide(
          board.querySelector('[data-branch-edges="' + CSS.escape(head.node.id) + '"]'),
          dx,
          dy,
        );
        for (const row of rows) {
          const old = oldRows.get(row.node.id);
          if (!old || (old.x - row.x === dx && old.y - row.y === dy)) continue;
          slide(
            container.querySelector('[data-node-id="' + CSS.escape(row.node.id) + '"]'),
            old.x - row.x - dx,
            old.y - row.y - dy,
          );
        }
      }
    }
    previousArrangement.current = c.navigation.arrangement;
    previous.current = next;
    if (removed.length) ghosts.current?.(removed);
    // Fade the clipped viewport as one layer on large trees. Animating hundreds
    // of off-screen left/top properties would lay out the entire canvas per frame.
    const fade =
      switched && next.length > mapTokens.denseAbove && !reduce && !instantFold
        ? c.board.current?.animate(
            [{ opacity: styleTokens.motion.initialOpacity }, { opacity: 1 }],
            {
              duration: styleTokens.motion.fade,
              easing: 'ease-out',
            },
          )
        : undefined;
    const timer = removed.length
      ? setTimeout(() => ghosts.current?.([]), styleTokens.motion.move)
      : undefined;
    return () => {
      clearTimeout(timer);
      if (removed.length) ghosts.current?.([]);
      fade?.cancel();
      slides.forEach((a) => a.cancel());
    };
  }, [layout]);
  const navigation = useRef(c.navigation);
  navigation.current = c.navigation;
  useLayoutEffect(() => {
    const board = c.board.current;
    if (!board) return;
    const wheel = (e: WheelEvent) => {
      e.stopPropagation();
      if (navigation.current.wheelMode === 'scroll' && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const unit =
        e.deltaMode === 1
          ? styleTokens.zoom.wheelLine
          : e.deltaMode === 2
            ? board.clientHeight
            : styleTokens.zoom.actual;
      navigation.current.zoomAt(
        Math.exp(
          -Math.max(
            -styleTokens.zoom.wheelLimit,
            Math.min(styleTokens.zoom.wheelLimit, e.deltaY * unit),
          ) * styleTokens.zoom.wheelSensitivity,
        ),
        e.clientX,
        e.clientY,
      );
    };
    // Chromium and Firefox express trackpad pinch as Ctrl+wheel. WebKit also
    // provides native gesture events with an absolute scale for each gesture.
    let scale: number = styleTokens.zoom.actual;
    const gesture = (event: Event) => {
      const e = event as MouseEvent & { scale: number };
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'gesturestart') scale = styleTokens.zoom.actual;
      else if (e.scale > 0) {
        navigation.current.zoomAt(e.scale / scale, e.clientX, e.clientY);
        scale = e.scale;
      }
    };
    board.addEventListener('wheel', wheel, { passive: false });
    board.addEventListener('gesturestart', gesture, { passive: false });
    board.addEventListener('gesturechange', gesture, { passive: false });
    return () => {
      board.removeEventListener('wheel', wheel);
      board.removeEventListener('gesturestart', gesture);
      board.removeEventListener('gesturechange', gesture);
    };
  }, []);
  // Zoom changes the canvas transform. Reuse the painted cards while their content and
  // geometry are stable. Commands on a cached card still read the current document and scope.
  const live = useRef(c);
  live.current = c;
  const editing = c.editing || c.newHeading ? c : undefined;
  const handleId = c.selection.length === 1 ? c.selection[0] : undefined;
  const handleNode = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    handleNode.current?.style.setProperty('--mw-map-scale', `${c.zoom}`);
  }, [handleId, c.zoom, layout]);
  const renderCard = useMemo(() => {
    const selected = new Set(c.selection);
    const faceEditor = {
      ...c,
      select: (...args: Parameters<typeof c.select>) => live.current.select(...args),
      beginInlineEdit: (...args: Parameters<typeof c.beginInlineEdit>) =>
        live.current.beginInlineEdit(...args),
      add: (...args: Parameters<typeof c.add>) => live.current.add(...args),
      perform: (...args: Parameters<typeof c.perform>) => live.current.perform(...args),
      get navigation() {
        return live.current.navigation;
      },
    };
    const cache = new WeakMap<
      LayoutNode['node'],
      {
        left: number;
        top: number;
        w: number;
        h: number;
        element: React.ReactElement;
      }
    >();
    return (row: LayoutNode, head: LayoutNode, card: MapCardContent) => {
      const { node, w, h, depth } = row;
      const left = row.x - head.x,
        top = row.y - head.y;
      const previous = cache.get(node);
      if (
        previous &&
        previous.left === left &&
        previous.top === top &&
        previous.w === w &&
        previous.h === h
      )
        return previous.element;
      const element = (
        <div
          key={node.id}
          ref={handleId === node.id ? handleNode : undefined}
          className="mw-node"
          {...c.nodeProps(node)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (!(e.target as HTMLElement)?.closest?.('button,input'))
              live.current.beginInlineEdit(node);
          }}
          aria-label={c.labels.get(node.id) ?? node.title}
          onClick={(e) => {
            const editor = live.current;
            if (editor.navigation.hideLabels) {
              editor.navigation.readable(node.id);
              editor.onboarding.offer('selection');
            } else editor.nodeInteraction(node).onClick(e);
          }}
          onDragOver={(e) => live.current.nodeInteraction(node).onDragOver(e)}
          onDrop={(e) => live.current.nodeInteraction(node).onDrop(e)}
          data-card-flow={card.flow}
          data-reading-body={card.hasBody || undefined}
          data-drop-axis={c.navigation.arrangement === 'down' && depth === 1 ? 'x' : 'y'}
          data-depth={Math.min(depth, 3)}
          style={
            {
              left,
              top,
              width: w,
              height: h,
              '--mw-map-title-lines': card.titleLines,
              '--mw-map-excerpt-lines': card.excerptLines,
            } as React.CSSProperties
          }
        >
          <div className="mw-card-marks" aria-hidden="true">
            {!c.locked && (
              <span className="mw-edit-pencil" title={c.t('doubleEdit')}>
                <Icon name="edit" />
              </span>
            )}
            {selected.has(node.id) && (
              <span className="mw-selection-check">
                <Icon name="check" />
              </span>
            )}
          </div>
          <div className="mw-node-content">
            <NodeTitle editor={faceEditor} node={node} />
            {card.count && <small className="mw-map-count">{card.count}</small>}
            {card.excerpt && <small className="mw-map-excerpt">{card.excerpt}</small>}
          </div>
          <StateBadges editor={faceEditor} node={node} />

          <FoldButton editor={faceEditor} node={node} />
          {!c.newHeading && c.selection.length === 1 && c.selection[0] === node.id && (
            <>
              {node.kind !== 'preamble' && <AddNodeButton editor={faceEditor} node={node} child />}
              {depth > 0 && <AddNodeButton editor={faceEditor} node={node} child={false} />}
            </>
          )}
          {c.drop?.id === node.id && (
            <span className="mw-drop-label">
              {c.t(
                c.drop.zone === 'before'
                  ? 'dropBefore'
                  : c.drop.zone === 'after'
                    ? 'dropAfter'
                    : 'dropInside',
              )}
            </span>
          )}
        </div>
      );
      cache.set(node, { left, top, w, h, element });
      return element;
    };
  }, [
    c.cardSource,
    c.visible,
    c.navigation.editorWidth,
    c.selection,
    handleId,
    c.labels,
    c.locked,
    c.busy,
    c.recovery,
    c.drop,
    c.language,
    c.profile.type,
    c.navigation.hideLabels,
    c.navigation.arrangement,
    editing,
  ]);
  const cards = useMemo(
    () =>
      layout &&
      Array.from(branches, ([id, rows]) => (
        <div key={id} data-map-branch={id} style={{ left: rows[0].x, top: rows[0].y }}>
          {rows.map((row) => renderCard(row, rows[0], layout.cards.get(row.node.id)!))}
        </div>
      )),
    [branches, layout, renderCard],
  );
  if (!layout) return null;
  return (
    <div
      className="mw-map-wrap"
      data-arrangement={c.navigation.arrangement}
      data-dense={layout.nodes.length > mapTokens.denseAbove}
      data-narrow={c.navigation.editorWidth < breakpoints.narrow}
      data-hide-labels={c.navigation.hideLabels}
    >
      <MapControls editor={c} />
      <div className="mw-map-tools">
        <LayoutSelect editor={c} />
        <Icon name="down" />
      </div>
      <div
        className="mw-map"
        ref={c.board}
        onDoubleClick={(e) => {
          if (!(e.target as HTMLElement).closest('.mw-node')) c.center();
        }}
        data-tree-surface
        tabIndex={-1}
      >
        <div
          className="mw-canvas-size"
          style={{
            width:
              2 * c.navigation.size.width +
              Math.max(c.navigation.size.width, layout.width * c.zoom),
            height:
              2 * c.navigation.size.height +
              Math.max(c.navigation.size.height, layout.height * c.zoom),
          }}
        >
          <div
            className="mw-canvas"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${c.navigation.offset.x}px,${c.navigation.offset.y}px) scale(${c.zoom})`,
            }}
          >
            <svg
              className="mw-connections"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {edges}
            </svg>
            {cards}
            <ExitGhosts setter={ghosts} />
          </div>
          <div ref={marquee} className="mw-selection-box" hidden aria-hidden="true" />
        </div>
      </div>
      {c.inlineEdit && layout.nodes.some((row) => row.node.id === c.inlineEdit!.id) && (
        <MapEditCard key={c.inlineEdit.id} editor={c} />
      )}
    </div>
  );
}
// Updating the temporary exit layer must not rerender hundreds of surviving cards.
function ExitGhosts({
  setter,
}: {
  setter: React.MutableRefObject<React.Dispatch<React.SetStateAction<LayoutNode[]>> | null>;
}) {
  const [leaving, setLeaving] = useState<LayoutNode[]>([]);
  useLayoutEffect(() => {
    setter.current = setLeaving;
    return () => {
      setter.current = null;
    };
  }, [setter]);
  return (
    <>
      {leaving.map(({ node, x, y, w, h, depth }) => (
        <div
          key={`exit-${node.id}`}
          className="mw-node mw-node-leaving"
          aria-hidden="true"
          data-depth={Math.min(depth, 3)}
          style={{ left: x, top: y, width: w, height: h }}
        >
          <span className="mw-title-text">{node.title}</span>
        </div>
      ))}
    </>
  );
}
/** Outside the canvas and drawer flow: zoom controls have a fixed, unoccluded slot. */
export function MapControls({ editor: c }: WithEditor) {
  if (c.view !== 'map') return null;
  return (
    <div className="mw-map-controls">
      <ActionButton
        editor={c}
        label="zoomOut"
        icon={<Icon name="minus" />}
        disabled={c.zoom <= c.navigation.minZoom}
        action={() => c.navigation.stepZoom(styleTokens.zoom.actual / styleTokens.zoom.step)}
      />
      <output title={c.t(c.navigation.hideLabels ? 'hiddenLabelsHint' : 'readableZoom')}>
        {Number((c.zoom * styleTokens.zoom.percent).toFixed(c.zoom < 0.01 ? 2 : 0))}%
      </output>
      <ActionButton
        editor={c}
        label="zoomIn"
        icon={<Icon name="plus" />}
        disabled={c.zoom >= 3}
        action={() => c.navigation.stepZoom(styleTokens.zoom.step)}
      />
      <ActionButton editor={c} label="center" icon={c.t('fitLabel')} action={c.center} />
    </div>
  );
}
