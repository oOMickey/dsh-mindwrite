import type { LayoutNode } from './layout.ts';

export interface Point {
  x: number;
  y: number;
}
export interface MapViewport {
  // Client coordinates of the scrollport's inner edge (including clientLeft/Top).
  left: number;
  top: number;
  width: number;
  height: number;
  scroll: Point;
  offset: Point;
  zoom: number;
}

export function pastDragThreshold(start: Point, end: Point) {
  return Math.hypot(end.x - start.x, end.y - start.y) > 4;
}

export function viewportPoint(point: Point, port: MapViewport): Point {
  return {
    x: Math.max(0, Math.min(port.width, point.x - port.left)),
    y: Math.max(0, Math.min(port.height, point.y - port.top)),
  };
}

export function canvasPoint(point: Point, port: MapViewport): Point {
  const local = viewportPoint(point, port);
  return {
    x: (port.scroll.x + local.x - port.offset.x) / port.zoom,
    y: (port.scroll.y + local.y - port.offset.y) / port.zoom,
  };
}

export function boxBetween(a: Point, b: Point) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** Both ends are clipped to the scrollport. Layout rows already use global canvas coordinates
 * and visit the visible projection in manuscript order, including in the downward layout. */
export function boxSelection(
  rows: readonly LayoutNode[],
  port: MapViewport,
  from: Point,
  to: Point,
) {
  const box = boxBetween(canvasPoint(from, port), canvasPoint(to, port));
  const ids = new Set<string>();
  for (const { node, x, y, w, h } of rows) {
    if (x >= box.left && x + w <= box.right && y >= box.top && y + h <= box.bottom)
      ids.add(node.id);
  }
  return [...ids];
}
