import { type MindNode } from '../model.ts';
import { ancestors } from './navigation.ts';

/** Only the tree views project this input. Saving it uses the ordinary human add command. */
export interface NewHeading {
  owner: string;
  parentId: string;
  afterId?: string;
  node: MindNode;
}

export function headingIndex(parent: MindNode, afterId?: string) {
  if (!afterId) return parent.children.length;
  const at = parent.children.findIndex((n) => n.id === afterId);
  return at < 0 ? -1 : at + 1;
}

export function projectHeading(root: MindNode, heading: NewHeading) {
  const path = ancestors(root, heading.parentId);
  const parent = path.pop();
  if (!parent) return root;
  const index = headingIndex(parent, heading.afterId);
  if (index < 0) return root;
  const children = parent.children.slice();
  children.splice(index, 0, heading.node);
  return path.reduceRight<MindNode>(
    (child, ancestor) => ({
      ...ancestor,
      children: ancestor.children.map((n) => (n.id === child.id ? child : n)),
    }),
    { ...parent, children },
  );
}
