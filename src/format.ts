import { naturalParagraphs } from './paragraphs.ts';
import { flatten, type MindNode } from './model.ts';
import { numberedTitles } from './numbering.ts';
import { importMarkdownDetailed } from './import.ts';
import {
  checkReferences,
  referenceSpans,
  type ReferenceCheck,
  type ReferenceSpan,
} from './references.ts';
export { chinese, stripNumber } from './numbering.ts';
import type { TitleNumbering } from './document-profile.ts';
export type { Numbering } from './document-profile.ts';
export interface Paragraph {
  id: string;
  depth: number;
  heading: string;
  body: string;
  prefix: string;
  inlineBodyPrefix?: string;
  title: string;
}
export type ArticleTitle = 'omit' | 'bracket' | 'separate';
export interface TextSpan extends ReferenceSpan {
  text: string;
  emphasis?: boolean;
}
export interface DocumentParagraph {
  id: string;
  kind: 'title' | 'chapter' | 'article' | 'heading' | 'body' | 'item';
  depth: number;
  spans: TextSpan[];
  centered: boolean;
  indent: boolean;
  outline?: number;
  numberPrefix?: string;
  bodyOrdinal?: number;
  /** Display characters before the author’s body (number and optional article title). */
  bodyOffset?: number;
}
export function compose(root: MindNode, scheme: TitleNumbering = 'official'): Paragraph[] {
  return [...numberedTitles(root, scheme).values()];
}
/** Shared semantic paragraphs drive text, Markdown, Word and the in-app page preview. */
export function documentParagraphs(
  root: MindNode,
  numbering: TitleNumbering = 'official',
  articleTitle: ArticleTitle = 'omit',
  sectionHeadings = false,
): DocumentParagraph[] {
  const nodes = new Map(flatten(root).map(({ node }) => [node.id, node]));
  const checks = referencesByNode(root);
  return compose(root, numbering).flatMap((section) =>
    sectionParagraphs(
      nodes.get(section.id)!,
      section,
      checks.get(section.id) ?? [],
      numbering,
      articleTitle,
      sectionHeadings,
    ),
  );
}

export function referencesByNode(root: MindNode) {
  const groups = new Map<string, ReferenceCheck[]>();
  for (const check of checkReferences(root)) {
    const group = groups.get(check.sourceId) ?? [];
    group.push(check);
    groups.set(check.sourceId, group);
  }
  return groups;
}

export function sectionParagraphs(
  node: MindNode,
  section: Paragraph,
  checks: ReferenceCheck[],
  numbering: TitleNumbering,
  articleTitle: ArticleTitle,
  sectionHeadings: boolean,
): DocumentParagraph[] {
  const result: DocumentParagraph[] = [];
  const scheme = typeof numbering === 'string' ? numbering : numbering.scheme;
  const { id, depth, prefix, title } = section;
  const source = referenceSpans(node, checks);
  const ranges = naturalParagraphs(source.map((s) => s.text).join(''));
  let index = 0,
    offset = 0;
  const inlinePrefix =
    !sectionHeadings && scheme === 'official' && depth >= 2 ? section.inlineBodyPrefix : undefined;
  const bodyLines = ranges.map((range, line) => {
    const start = range.start + (line === 0 && inlinePrefix ? inlinePrefix.length : 0);
    const spans: TextSpan[] = [];
    while (index < source.length && offset < range.end) {
      const span = source[index],
        end = offset + span.text.length;
      if (end > start)
        spans.push({
          ...span,
          text: span.text.slice(Math.max(0, start - offset), range.end - offset),
        });
      if (end > range.end) break;
      index++;
      offset = end;
    }
    return spans;
  });
  let ordinal = 0;
  const push = (
    kind: DocumentParagraph['kind'],
    spans: TextSpan[],
    outline?: number,
    numberPrefix?: string,
    bodyOffset?: number,
  ) => {
    result.push({
      id,
      kind,
      depth,
      spans,
      outline,
      ...(numberPrefix && { numberPrefix }),
      ...(bodyOffset && { bodyOffset }),
      ...(['article', 'item', 'body'].includes(kind) && ordinal < ranges.length
        ? { bodyOrdinal: ++ordinal }
        : {}),
      centered: kind === 'title' || kind === 'chapter',
      indent:
        !sectionHeadings && scheme === 'official' && ['article', 'body', 'item'].includes(kind),
    });
  };
  if (depth === 0) {
    push('title', [{ text: title }]);
    bodyLines.forEach((spans) => push('body', spans));
  } else if (node.kind === 'preamble') {
    bodyLines.forEach((spans) => push('body', spans));
  } else if (sectionHeadings || scheme !== 'official') {
    push('heading', [{ text: section.heading }], depth - 1, prefix);
    bodyLines.forEach((spans) => push('body', spans));
  } else if (depth === 1) {
    push('chapter', [{ text: prefix + title }], 0, prefix);
    bodyLines.forEach((spans) => push('body', spans));
  } else if (depth === 2) {
    if (articleTitle === 'separate') push('heading', [{ text: title }]);
    const label =
      articleTitle === 'bracket'
        ? node.wordTitlePrefix !== undefined && /^【.*】$/su.test(title)
          ? title
          : `【${title}】`
        : '';
    push(
      'article',
      [
        { text: prefix, emphasis: true },
        ...(label ? [{ text: label }] : []),
        ...(bodyLines.shift() ?? [{ text: `【待完善：${title}】` }]),
      ],
      1,
      prefix,
      prefix.length + label.length,
    );
    bodyLines.forEach((spans) => push('body', spans));
  } else {
    const [first, ...rest] = bodyLines.shift() ?? [{ text: title }];
    push(
      'item',
      [{ ...first, text: prefix + (first?.text ?? '') }, ...rest],
      Math.min(depth - 1, 5),
      prefix,
      prefix.length,
    );
    bodyLines.forEach((spans) => push('body', spans));
  }
  return result;
}

export function paragraphText(paragraph: DocumentParagraph): string {
  return paragraph.spans.map((span) => span.text).join('');
}

export function fullText(
  root: MindNode,
  scheme: TitleNumbering = 'official',
  articleTitle: ArticleTitle = 'omit',
  sectionHeadings = false,
): string {
  return documentParagraphs(root, scheme, articleTitle, sectionHeadings)
    .map(paragraphText)
    .join('\n\n');
}

export function markdown(
  root: MindNode,
  scheme: TitleNumbering = 'official',
  articleTitle: ArticleTitle = 'omit',
  sectionHeadings = false,
): string {
  return (
    documentParagraphs(root, scheme, articleTitle, sectionHeadings)
      .map((p) => {
        const text = paragraphText(p);
        if (['title', 'chapter', 'heading'].includes(p.kind))
          return '#'.repeat(Math.min(p.depth + 1, 6)) + ' ' + text;
        return text;
      })
      .join('\n\n') + '\n'
  );
}
export function importMarkdown(text: string, fallbackTitle = '导入文档'): MindNode {
  return importMarkdownDetailed(text, fallbackTitle).root;
}
