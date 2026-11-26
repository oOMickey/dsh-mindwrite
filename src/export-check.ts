import { flatten, type MindNode } from './model.ts';
import { checkReferences } from './references.ts';
import type { ArticleTitle, Numbering } from './format.ts';
import { documentHealth } from './health.ts';
import type { ImportReport } from './metadata.ts';
import { profileFor } from './document-profile.ts';

export interface ExportOmission {
  id: string;
  title: string;
  field: 'note' | 'title';
  text: string;
}
export function exportCheck(
  root: MindNode,
  numbering: Numbering | ReturnType<typeof profileFor>,
  articleTitle: ArticleTitle,
  report?: ImportReport,
  sectionHeadings = typeof numbering !== 'string' && numbering.type !== 'regulation',
) {
  const profile =
    typeof numbering === 'string'
      ? profileFor(
          sectionHeadings ? { documentType: 'article', numberingScheme: numbering } : {},
          numbering,
        )
      : numbering;
  const scheme = profile.scheme;
  const health = documentHealth(root, report, profile);
  const excluded: ExportOmission[] = [];
  const rows = flatten(root);
  const titles = new Map(rows.map(({ node }) => [node.id, node.title]));
  for (const { node, depth } of rows) {
    if (node.note?.trim())
      excluded.push({ id: node.id, title: node.title, field: 'note', text: node.note });
    const titleOmitted =
      node.kind === 'preamble' ||
      (!sectionHeadings &&
        scheme === 'official' &&
        ((depth === 2 && articleTitle === 'omit' && !!node.body.trim()) ||
          (depth > 2 && !!node.body.trim())));
    if (titleOmitted)
      excluded.push({ id: node.id, title: node.title, field: 'title', text: node.title });
  }
  return {
    excluded,
    health,
    incomplete: health
      .filter((issue) => issue.severity === 'error')
      .map((issue) => ({
        id: issue.nodeId,
        title: titles.get(issue.nodeId)!,
        reason: issue.message,
      })),
    unresolved: checkReferences(root).filter((reference) => reference.status !== 'resolved'),
  };
}
