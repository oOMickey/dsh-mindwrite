import { requestedDocumentType, type DocumentType } from './document-profile.ts';
import {
  flatten,
  MindError,
  type MindNode,
  type NodeInput,
  type Operation,
  type Scope,
  type Expansion,
} from './model.ts';

/** Preserve the text of descendants outside the requested depth in writing notes. */
export function oneLevel(nodes: NodeInput[], levels = 1): { nodes: NodeInput[]; demoted: number } {
  let demoted = 0;
  function notes(node: NodeInput, depth = 0): string[] {
    demoted++;
    return [
      `${'  '.repeat(depth)}${node.title}`,
      ...(node.body ? [node.body] : []),
      ...(node.note ? [node.note] : []),
      ...(node.children ?? []).flatMap((child) => notes(child, depth + 1)),
    ];
  }
  function limit(node: NodeInput, remaining: number): NodeInput {
    const { children, ...value } = node;
    if (!children?.length) return value;
    if (remaining > 1)
      return { ...value, children: children.map((child) => limit(child, remaining - 1)) };
    return {
      ...value,
      note: [node.note, '待确认的下级草稿：', ...children.flatMap((child) => notes(child))]
        .filter(Boolean)
        .join('\n'),
    };
  }
  const normalized = nodes.map((n) => limit(n, levels));
  return { nodes: normalized, demoted };
}

interface Grant {
  key: string;
  parentIds: string[];
}
export class ProgressiveGeneration {
  private requests = new Map<
    string,
    {
      messageId: string;
      documentType?: DocumentType;
      expansion?: Expansion;
      grants: Map<string, Grant>;
    }
  >();
  observe(sessionId: string, messageId: string, text = '') {
    if (this.requests.get(sessionId)?.messageId === messageId) return;
    // Only a new human message may widen the grant. Negative/quoted examples
    // and text read from the manuscript do not authorize deeper generation.
    const request = text.replace(/[“「『"‘][^”」』"’]*[”」』"’]/g, '');
    const explicit = request
      .split(/[。！？；，,\n]/)
      .some(
        (part) => /展开到条/.test(part) && !/不|别|勿|无需|禁止|暂缓|能否|是否|[？?]/.test(part),
      );
    const single =
      /只(?:新增|展开)?一层|仅(?:新增|展开)?一层|先搭一级|先.{0,3}一级|不要展开到条/.test(request);
    this.requests.set(sessionId, {
      messageId,
      documentType: requestedDocumentType(text),
      expansion: single ? 'one' : explicit ? 'articles' : undefined,
      grants: new Map(),
    });
  }
  documentType(sessionId: string) {
    return this.requests.get(sessionId)?.documentType;
  }
  expansion(sessionId: string, fallback: Expansion = 'one', scope?: Scope): Expansion {
    return scope
      ? (scope.expansion ?? 'one')
      : (this.requests.get(sessionId)?.expansion ?? fallback);
  }
  forget(sessionId: string) {
    this.requests.delete(sessionId);
  }
  created(sessionId: string, key: string) {
    // Creating the document has already consumed this turn's one new layer.
    this.requests.get(sessionId)?.grants.set(key, { key, parentIds: [] });
  }
  permit(
    sessionId: string,
    key: string,
    root: MindNode,
    scope?: Scope,
    depth: Expansion = 'one',
  ): Grant | undefined {
    if (scope && scope.mode !== 'expand') return;
    const parents = () =>
      flatten(root)
        .filter((row) => row.node.kind !== 'preamble' && (depth !== 'articles' || row.depth < 2))
        .map(({ node }) => node.id);
    if (scope) {
      const allowed = new Set(parents());
      return { key: scope.key, parentIds: scope.ids.filter((id) => allowed.has(id)) };
    }
    const request = this.requests.get(sessionId);
    if (!request) return;
    const prior = request.grants.get(key);
    if (prior && depth === 'one') return prior;
    const grant = {
      key,
      parentIds: parents(),
    };
    request.grants.set(key, grant);
    return grant;
  }
  authorize(
    sessionId: string,
    key: string,
    root: MindNode,
    operations: Operation[],
    scope?: Scope,
    fallback: Expansion = 'one',
  ) {
    const adds = operations.filter((op) => op.type === 'add');
    if (!adds.length) return { operations, demoted: 0 };
    const expansion = this.expansion(sessionId, fallback, scope);
    const grant = this.permit(sessionId, key, root, scope, expansion);
    if (!grant || grant.key !== key || adds.some((op) => !grant.parentIds.includes(op.parentId)))
      throw new MindError(
        'ONE_LEVEL',
        '本轮只能向开始时已有的节点新增一层；请在下一条用户消息中继续展开新节点。',
      );
    const depths = new Map(flatten(root).map((row) => [row.node.id, row.depth]));
    if (expansion === 'one' && new Set(adds.map((op) => depths.get(op.parentId))).size !== 1)
      throw new MindError('ONE_LEVEL', '每次只能展开同一层级，请分别确认各层结构');
    let demoted = 0;
    const normalized = operations.map((op): Operation => {
      if (op.type !== 'add') return op;
      const depth = depths.get(op.parentId)!;
      const levels =
        expansion === 'articles' ? 2 - depth : expansion === 'unlimited' ? 20 - depth : 1;
      if (levels < 1) throw new MindError('ONE_LEVEL', '授权止于条，请选择章或文稿根节点');
      const shallow = oneLevel(op.nodes, levels);
      demoted += shallow.demoted;
      return { ...op, nodes: shallow.nodes };
    });
    return { operations: normalized, demoted };
  }
}
