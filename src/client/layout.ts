import type { MindNode } from '../model.ts';

import { breakpoints, mapTokens as map, styleTokens } from '../style-tokens.ts';
import {
  describeMapCard,
  savedMapSource,
  textWidth,
  type MapCardContent,
  type MapCardSource,
} from './map-card.ts';

export const arrangements = ['right', 'down', 'directory'] as const;
export type Arrangement = (typeof arrangements)[number];
export interface HandleSpace {
  id: string;
  size: number;
}
export function readArrangement(value: unknown): Arrangement {
  return arrangements.find((form) => form === value) ?? 'right';
}
export interface LayoutNode {
  node: MindNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  parentId?: string;
}
export interface TreeLayout {
  cards: ReadonlyMap<string, MapCardContent>;
  nodes: LayoutNode[];
  width: number;
  height: number;
}

const { margin } = map;

function layoutCanvas(
  arrangement: Arrangement,
  viewport: number,
  dense: boolean,
  source: MapCardSource,
) {
  const nodes: LayoutNode[] = [];
  const cards = new Map<string, MapCardContent>();
  function place(
    node: MindNode,
    depth: number,
    x: number,
    y: number,
    w: number,
    parentId?: string,
  ) {
    const card = describeMapCard(node, depth, w, viewport, dense, arrangement, source);
    const row = { node, depth, x, y, w, h: card.height, parentId };
    cards.set(node.id, card);
    nodes.push(row);
    return row;
  }
  function bounds(): TreeLayout {
    return {
      nodes,
      cards,
      width: Math.max(...nodes.map((r) => r.x + r.w)) + margin,
      height: Math.max(...nodes.map((r) => r.y + r.h)) + margin,
    };
  }
  return { nodes, place, bounds };
}

// Anchor headings near their first child, keeping a long branch readable from its beginning.
export function rightLayout(
  root: MindNode,
  viewport: number = breakpoints.wide,
  dense = true,
  source = savedMapSource(root),
  handles?: HandleSpace,
): TreeLayout {
  const rules = map.right;
  const narrow = viewport < breakpoints.narrow;
  const gap = narrow ? rules.narrowGap : rules.columnGap;
  const canvas = layoutCanvas('right', viewport, dense, source);
  function place(
    node: MindNode,
    depth: number,
    x: number,
    top: number,
    parentId?: string,
    minCenter = top,
  ): number {
    const w = (narrow ? rules.narrowWidths : rules.widths)[Math.min(depth, 2)];
    const row = canvas.place(node, depth, x, top, w, parentId);
    const extra = handles?.id === node.id ? handles.size : 0;
    top = Math.max(top, minCenter - row.h / 2);
    const firstChild = canvas.nodes.length;
    const single = !node.collapsed && node.children.length === 1;
    let bottom = top;
    if (!node.collapsed)
      node.children.forEach((child, i) => {
        if (i) bottom += depth === 0 ? rules.chapterGap : dense ? rules.denseGap : rules.rowGap;
        bottom = place(
          child,
          depth + 1,
          x + w + Math.max(gap, extra),
          bottom,
          node.id,
          single ? top + row.h / 2 : bottom,
        );
      });
    const middle = Math.max(0, (bottom - top - row.h) / 2);
    const child = canvas.nodes[firstChild];
    row.y = single
      ? child.y + (child.h - row.h) / 2
      : top + (dense ? Math.min(rules.anchorOffset, middle) : middle);
    return Math.max(bottom, row.y + row.h + (depth ? extra : 0));
  }
  place(root, 0, margin, margin);
  return canvas.bounds();
}

// Each chapter owns a column. Only nested levels need more horizontal space.
export function downLayout(
  root: MindNode,
  viewport: number = breakpoints.wide,
  dense = true,
  source = savedMapSource(root),
  handles?: HandleSpace,
): TreeLayout {
  const rules = map.down;
  const canvas = layoutCanvas('down', viewport, dense, source);
  const rootFont = viewport >= breakpoints.wide ? styleTokens.type.doc : styleTokens.type.chapter;
  const foldSpace = root.children.length ? map.card.fold + map.card.gap : 0;
  const width =
    textWidth(source.value(root, 'title'), rootFont.size, rules.rootMax) +
    2 * (map.card.padX + map.card.border) +
    foldSpace;
  const heading = canvas.place(
    root,
    0,
    margin,
    margin,
    Math.max(
      map.minExtent,
      Math.min(viewport - 2 * margin, rules.rootMax, Math.max(rules.rootMin, Math.ceil(width))),
    ),
  );
  if (root.collapsed || !root.children.length) return canvas.bounds();

  const chapterWidth = viewport >= breakpoints.wide ? rules.chapter : rules.compactChapter;
  let left = margin;
  const centers = root.children.map((chapter) => {
    const center = left + chapterWidth / 2;
    let right = left + chapterWidth;
    let top =
      heading.y + heading.h + Math.max(rules.rootGap, handles?.id === root.id ? handles.size : 0);
    function stack(node: MindNode, depth: number, x: number, parentId: string) {
      const w = depth === 1 ? chapterWidth : chapterWidth - rules.indent;
      const row = canvas.place(node, depth, x, top, w, parentId);
      const extra = handles?.id === node.id ? handles.size : 0;
      right = Math.max(right, x + w + extra);
      top += row.h + Math.max(depth === 1 ? rules.chapterGap : rules.rowGap, extra);
      if (!node.collapsed)
        for (const child of node.children) stack(child, depth + 1, x + rules.indent, node.id);
    }
    stack(chapter, 1, left, root.id);
    left = right + rules.columnGap;
    return center;
  });
  heading.x = (centers[0] + centers.at(-1)!) / 2 - heading.w / 2;
  const shift = Math.max(0, margin - heading.x);
  if (shift) for (const row of canvas.nodes) row.x += shift;
  return canvas.bounds();
}

export function directoryLayout(
  root: MindNode,
  viewport: number = map.initialWidth,
  dense = false,
  source = savedMapSource(root),
  handles?: HandleSpace,
): TreeLayout {
  const rules = map.directory;
  const canvas = layoutCanvas('directory', viewport, dense, source);
  let top = margin;
  function indent(node: MindNode, depth: number, parentId?: string) {
    const offset = depth * rules.indent;
    const w =
      viewport >= breakpoints.wide
        ? rules.wideWidth
        : Math.max(rules.minWidth, Math.min(rules.maxWidth, viewport - margin * 2 - offset));
    const row = canvas.place(node, depth, margin + offset, top, w, parentId);
    top += row.h + Math.max(rules.gap, handles?.id === node.id ? handles.size : 0);
    if (!node.collapsed) node.children.forEach((child) => indent(child, depth + 1, node.id));
  }
  indent(root, 0);
  return canvas.bounds();
}

export const layouts = { right: rightLayout, down: downLayout, directory: directoryLayout };
/** Ports depend on the parent only. Stacked descendants use the clear inset beside their column. */
export function exitPort(parent: LayoutNode, arrangement: Arrangement, selected = false) {
  if (arrangement === 'right') return { x: parent.x + parent.w, y: parent.y + parent.h / 2 };
  const inset =
    arrangement === 'directory'
      ? map.edge.directoryInset
      : parent.depth === 0
        ? parent.w / 2
        : map.edge.downInset;
  const clearance = arrangement === 'down' && selected ? map.down.ringClearance : 0;
  return { x: parent.x + inset, y: parent.y + parent.h + clearance };
}

function connection(
  parent: LayoutNode,
  row: LayoutNode,
  arrangement: Arrangement,
  selected?: ReadonlySet<string>,
) {
  const { x, y } = exitPort(parent, arrangement, selected?.has(parent.node.id));
  const cy = row.y + row.h / 2;
  if (arrangement === 'directory') {
    const r = Math.min(map.edge.radius, cy - y, row.x - x);
    return `M${x},${y} V${cy - r} Q${x},${cy} ${x + r},${cy} H${row.x}`;
  }
  if (arrangement === 'down') {
    const clearance = selected?.has(row.node.id) ? map.down.ringClearance : 0;
    if (row.depth === 1) {
      const endX = row.x + row.w / 2;
      const landing = row.y - map.down.ringClearance;
      const mid = y + (landing - y) * map.edge.tension;
      return `M${x},${y} C${x},${mid} ${endX},${mid} ${endX},${landing} V${row.y - clearance}`;
    }
    // Stay in the parent's gutter until the target row, including on deep, uneven branches.
    const endX = row.x - clearance;
    const bend = Math.min(map.down.bend, endX - x, cy - y);
    return `M${x},${y} V${cy - bend} C${x},${cy} ${endX - bend},${cy} ${endX},${cy}`;
  }
  if (Math.abs(y - cy) <= map.card.border / 2) return `M${x},${y} H${row.x}`;
  const mid = x + (row.x - x) * map.edge.tension;
  return `M${x},${y} C${mid},${y} ${mid},${cy} ${row.x},${cy}`;
}

export function connections(
  nodes: LayoutNode[],
  arrangement: Arrangement,
  selected?: ReadonlySet<string>,
) {
  const byId = new Map(nodes.map((row) => [row.node.id, row]));
  return nodes.flatMap((row) => {
    const parent = row.parentId && byId.get(row.parentId);
    return parent ? [{ row, path: connection(parent, row, arrangement, selected) }] : [];
  });
}
/** The hit target always uses the exact zoom. Dense trees reuse its clearance across
 * nearby scales so a wheel gesture can transform the already-painted chapters. */
export function handleClearance(zoom: number, dense: boolean): number {
  const target = styleTokens.size.controlSmall + styleTokens.detail.focus;
  const minimum = target / zoom;
  if (!dense) return minimum;
  const preferred = target + styleTokens.space.regular;
  return preferred * 2 ** Math.ceil(Math.log2(minimum / preferred));
}
export function fitZoom(width: number, height: number, tree: TreeLayout): number {
  return Math.min(
    styleTokens.zoom.actual,
    Math.max(map.minExtent, width - map.fitInset) / tree.width,
    Math.max(map.minExtent, height - map.fitInset) / tree.height,
  );
}
