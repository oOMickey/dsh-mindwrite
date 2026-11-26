import { styleTokens } from '../style-tokens.ts';
import { flatten, type MindNode } from '../model.ts';
export function ancestors(root: MindNode, id: string): MindNode[] {
  if (root.id === id) return [root];
  for (const child of root.children) {
    const chain = ancestors(child, id);
    if (chain.length) return [root, ...chain];
  }
  return [];
}
/** View-only projection: focusing and searching never change the saved document. */
export function projectTree(
  root: MindNode,
  chapterId: string | undefined,
  folds: ReadonlyMap<string, boolean>,
): MindNode {
  function walk(node: MindNode, depth: number, focused: boolean): MindNode {
    const current = focused || node.id === chapterId;
    const collapsed =
      depth === 0 && chapterId
        ? (folds.get(node.id) ?? false)
        : depth === 1 && chapterId && !current
          ? true
          : (folds.get(node.id) ?? (current ? false : node.collapsed));
    return {
      ...node,
      collapsed: !!collapsed,
      children: node.children.map((child) => walk(child, depth + 1, current)),
    };
  }
  return walk(root, 0, false);
}
export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
/** No movement for a visible node; otherwise pan only the overflowing edge into view. */
export function panIntoView(
  viewport: Bounds,
  node: Bounds,
  margin: number = styleTokens.space.medium,
) {
  function axis(start: number, span: number, target: number, extent: number) {
    if (target < start + margin) return Math.max(0, target - margin);
    if (target + extent > start + span - margin)
      return Math.max(
        0,
        extent > span - margin * 2 ? target - margin : target + extent - span + margin,
      );
    return start;
  }
  return {
    left: axis(viewport.left, viewport.width, node.left, node.width),
    top: axis(viewport.top, viewport.height, node.top, node.height),
  };
}
export function searchTree(root: MindNode, query: string) {
  const text = query.trim().toLocaleLowerCase();
  return text
    ? flatten(root).filter(({ node }) =>
        `${node.title}\n${node.body ?? ''}`.toLocaleLowerCase().includes(text),
      )
    : [];
}
