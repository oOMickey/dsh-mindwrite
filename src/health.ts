import { flatten, type MindNode, type Operation } from './model.ts';
import { checkReferences } from './references.ts';
import { chinese, numeral, numbering, parseNumber } from './numbering.ts';
import type { ImportReport } from './metadata.ts';
import { isResearchType, profileFor, typeFromText } from './document-profile.ts';
import { citationChecks } from './research-checks.ts';
import { en, zh } from './locales.ts';

export interface HealthIssue {
  id: string;
  nodeId: string;
  code: string;
  message: string;
  messageEn?: string;
  severity: 'error' | 'warning';
  field?: 'title' | 'body';
  before?: string;
  after?: string;
}
export function healthMessage(issue: HealthIssue, language: string) {
  return language.startsWith('zh') ? issue.message : (issue.messageEn ?? issue.message);
}
const articlePrefix = new RegExp(`^第(${numeral})条(?=\\s|$)`, 'u');
const itemPrefix = new RegExp(`^(?:[（(]${numeral}[）)]|\\d+[.．、](?!\\d))`, 'u');

function listedItem(node: MindNode) {
  return (
    node.sourceNumber?.unit === 'item' ||
    node.sourceNumber?.unit === 'subitem' ||
    itemPrefix.test(node.title) ||
    itemPrefix.test(node.body.trimStart())
  );
}
function enumeratesItems(parent: MindNode) {
  const items = parent.children;
  if (
    items.length < 2 ||
    !items.every((n) => !n.children.length && /^[^\r\n]+$/u.test(n.body.trim()))
  )
    return false;
  return (
    items.every(listedItem) ||
    /(?:下列|以下|如下|包括|分别为|分为)[^。！？；：:\r\n]*[：:]$/u.test(parent.body.trimEnd()) ||
    (articlePrefix.test(parent.title) &&
      listedItem(items[0]) &&
      items.slice(1).every((n) => listedItem(n) || /[；;]$/u.test(n.body.trimEnd())))
  );
}
export function documentHealth(
  root: MindNode,
  report?: ImportReport,
  profile = profileFor({}),
): HealthIssue[] {
  const result: HealthIssue[] = [],
    rows = flatten(root),
    numbers = numbering(root);
  const officialClauses = profile.type === 'regulation' && profile.scheme === 'official';
  const research = isResearchType(profile.type);
  const namedType = profile.legacy ? typeFromText(root.title) : profile.type;
  const checkClauseSyntax =
    officialClauses &&
    (namedType
      ? namedType === 'regulation'
      : rows.some(
          ({ node }) =>
            numbers.get(node.id)?.unit === 'article' &&
            (node.sourceNumber?.unit === 'article' ||
              (node.titleSource !== 'auto' && articlePrefix.test(node.title))),
        ));
  const add = (
    node: MindNode,
    code: string,
    message: string,
    field?: 'title' | 'body',
    after?: string,
    severity: 'error' | 'warning' = 'warning',
  ) =>
    result.push({
      id: `${node.id}:${code}:${field ?? ''}:${result.length}`,
      nodeId: node.id,
      code,
      message,
      severity,
      ...(field ? { field, before: node[field], ...(after === undefined ? {} : { after }) } : {}),
    });
  const written = new Set<MindNode>();
  function evidenceWarning(
    node: MindNode,
    code: string,
    field: 'body' | 'title',
    key: 'checkApproximate' | 'missingCitation' | 'manualCitation',
    value: string,
    excerpt: string,
  ) {
    const message = (copy: typeof en) =>
      (key === 'checkApproximate' ? '' : excerpt + ' · ') +
      copy[key].replace('{value}', () => value);
    result.push({
      id: node.id + ':' + code + ':' + result.length,
      nodeId: node.id,
      code,
      field,
      before: excerpt,
      severity: 'warning',
      message: message(zh),
      messageEn: message(en),
    });
  }
  if (research)
    for (const { node, marker, excerpt, missing } of citationChecks(rows))
      evidenceWarning(
        node,
        missing ? 'missing-citation' : 'unverified-citation',
        'body',
        missing ? 'missingCitation' : 'manualCitation',
        marker,
        excerpt,
      );
  for (const { node, parent } of rows.slice().reverse()) {
    if (!node.body.trim() && !written.has(node)) continue;
    written.add(node);
    if (parent) written.add(parent);
  }
  for (const { node, depth } of rows) {
    if (!written.has(node)) {
      const [code, message] = !depth
        ? ['empty-document', '文稿尚无正文，请补充内容']
        : depth === 1 && !node.kind
          ? ['empty-chapter', '空章节：请补写本节或下级的正文']
          : depth === 2 && officialClauses
            ? ['empty-article', '条款只有标题、尚无正文，请补写或确认下级内容是否完整']
            : ['title-only', '节点尚无正文，请核对是否需要补充正式文字'];
      add(node, code, message, undefined, undefined, 'error');
    }
    if (node.kind === 'preamble') continue;
    for (const field of ['title', 'body'] as const) {
      const text = node[field];
      const marker = new RegExp(`([（(]${numeral}[）)])、`, 'g');
      const withoutMarkerComma = text.replace(marker, '$1');
      if (withoutMarkerComma !== text)
        add(
          node,
          'marker-punctuation',
          '括号序号后不加顿号，可删除多余顿号',
          field,
          withoutMarkerComma,
        );
      const approximateValues = new Set<string>();
      const approx = text.replace(
        /(?<![第零一二三四五六七八九十百千万两\d])([一二三四五六七八九])、([一二三四五六七八九])(?=[个次天日月年名项家人])/g,
        (match, a: string, b: string, offset: number) => {
          if (Math.abs(parseNumber(a) - parseNumber(b)) !== 1) return match;
          if (research) {
            approximateValues.add(match + text[offset + match.length]);
            return match;
          }
          return a + b;
        },
      );
      if (research) {
        if (approximateValues.size)
          evidenceWarning(
            node,
            'approximate-number',
            field,
            'checkApproximate',
            [...approximateValues].join('、'),
            text,
          );
        continue;
      }
      if (approx !== text)
        add(node, 'approximate-number', '概数连用不加顿号，例如“三四个”', field, approx);
      const words = [
        ...new Set(text.match(/必须|不准|不能|(?<!需|只|主|将|想|重)要(?!求|素|点|件|旨)/g) ?? []),
      ];
      if (words.length)
        add(
          node,
          'modal-word',
          `请按语境核对“${words.join('、')}”：义务用语可改“应当”，禁止用语可改“不得”；不自动替换条件词`,
          field,
        );
    }
    const current = numbers.get(node.id);
    if (checkClauseSyntax && current && current.unit !== 'chapter' && enumeratesItems(node)) {
      node.children.forEach((item, i) => {
        const last = i === node.children.length - 1;
        const mark = last ? '。' : '；';
        if (item.body.trimEnd().endsWith(mark)) return;
        // A quote, ellipsis or question can carry meaning. Leave those endings for review.
        const after = item.body.replace(/(?<=[\p{L}\p{N}])[，,、；;。.]?(\s*)$/u, mark + '$1');
        add(
          item,
          'item-ending',
          last ? '最后一项应以句号收尾' : '同组非末项应以分号收尾',
          'body',
          after === item.body ? undefined : after,
        );
      });
    }
    const explicit =
      checkClauseSyntax && node.titleSource !== 'auto' && articlePrefix.exec(node.title);
    if (current?.unit === 'article' && explicit && parseNumber(explicit[1]) !== current.number)
      add(
        node,
        'article-number',
        '标题中的条号与当前顺序不一致，按连续编号修正',
        'title',
        node.title.replace(explicit[0], `第${chinese(current.number)}条`),
      );
  }
  if (report?.issues.some((issue) => ['missing-article', 'duplicate-article'].includes(issue.code)))
    add(
      root,
      'source-number',
      '导入原条号存在缺号或重复，现稿已按连续编号显示；请结合导入报告核对原文对应关系',
    );
  for (const ref of checkReferences(root))
    if (ref.status !== 'resolved')
      result.push({
        id: `reference:${ref.sourceId}:${ref.reference.id}`,
        nodeId: ref.sourceId,
        code: 'reference',
        message: ['deleted', 'dangling'].includes(ref.status)
          ? '引用目标已不存在，请定位并重新确认'
          : '引用尚未确认，请核对目标条款',
        severity: 'warning',
      });
  return result;
}
/** Recompute after each safe punctuation edit so multiple fixes on one field compose. */
export function healthFixes(root: MindNode, profile = profileFor({})): Operation[] {
  const next = structuredClone(root),
    original = new Map(flatten(root).map((r) => [r.node.id, r.node]));
  for (let pass = 0; pass < 4; pass++) {
    const issues = documentHealth(next, undefined, profile).filter(
      (issue) => issue.field && issue.after !== undefined,
    );
    if (!issues.length) break;
    for (const { node } of flatten(next)) {
      for (const field of ['title', 'body'] as const) {
        const fix = issues.find((issue) => issue.nodeId === node.id && issue.field === field);
        if (fix) node[field] = fix.after!;
      }
    }
  }
  return flatten(next).flatMap(({ node }) => {
    const old = original.get(node.id)!;
    return old.title !== node.title || old.body !== node.body
      ? [
          {
            type: 'update' as const,
            id: node.id,
            ...(old.title !== node.title ? { title: node.title } : {}),
            ...(old.body !== node.body ? { body: node.body } : {}),
          },
        ]
      : [];
  });
}
