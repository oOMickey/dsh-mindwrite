import { printLayout } from './style-tokens.ts';
import type { NodeInput } from './model.ts';
import type { ImportNumbering } from './metadata.ts';

export const documentTypes = [
  'regulation',
  'report',
  'plan',
  'notice',
  'article',
  'thesis',
] as const;
export const numberingSchemes = ['official', 'heading', 'decimal', 'none'] as const;
export type DocumentType = (typeof documentTypes)[number];
export const isResearchType = (type: DocumentType) => type === 'thesis' || type === 'report';
export type Numbering = (typeof numberingSchemes)[number];
export type TitleNumbering =
  Numbering | { scheme: Numbering; matchPosition: boolean; prefixes?: Record<string, string> };
export type PageStyle = 'official' | 'standard';
export const margins = printLayout.margin;
export interface ProfileFields {
  documentType?: string;
  numberingScheme?: string;
}
export const presets = {
  regulation: { scheme: 'official', layout: 'official', zh: '制度', en: 'Regulation' },
  report: { scheme: 'heading', layout: 'standard', zh: '报告', en: 'Report' },
  plan: { scheme: 'heading', layout: 'standard', zh: '方案计划', en: 'Plan' },
  notice: { scheme: 'heading', layout: 'official', zh: '通知', en: 'Notice' },
  article: { scheme: 'none', layout: 'standard', zh: '普通文章', en: 'Speech / article' },
  thesis: { scheme: 'decimal', layout: 'standard', zh: '论文提纲', en: 'Thesis outline' },
} as const;
export const schemeExamples = {
  official: '章条',
  heading: '一、（一）1.（1）',
  decimal: '1 / 1.1 / 1.1.1',
  none: '不编号',
};

export function profileLabel(type: DocumentType, title: string, language: 'zh' | 'en') {
  if (type === 'article' && /发言|讲话|演讲/.test(title))
    return language === 'zh' ? '讲话稿' : 'Speech';
  return presets[type][language];
}

export const typeOptions: Record<DocumentType, string> = {
  regulation: '制度 / 管理办法',
  report: '报告 / 总结',
  plan: '方案计划',
  notice: '通知',
  article: '讲话稿 / 普通文章',
  thesis: '论文提纲',
};

export function typeDefaults(type: DocumentType) {
  return { documentType: type, numberingScheme: presets[type].scheme };
}

export function profileFor(
  fields: ProfileFields & { importReport?: { source: string }; importNumbering?: ImportNumbering },
  legacyScheme: Numbering = 'official',
) {
  const type = documentTypes.find((t) => t === fields.documentType);
  const override = numberingSchemes.find((s) => s === fields.numberingScheme);
  const legacy = !type && !override;
  const resolved = type ?? (legacy ? 'regulation' : 'article');
  return {
    type: resolved,
    legacy,
    scheme: override ?? (legacy ? legacyScheme : presets[resolved].scheme),
    matchPosition: !override || fields.importReport?.source === 'docx',
    ...(fields.importNumbering?.prefixes && { prefixes: fields.importNumbering.prefixes }),
    layout: presets[resolved].layout,
  };
}

const typeNames: [DocumentType, RegExp][] = [
  ['article', /讲话|发言|演讲|普通文章|散文/u],
  ['thesis', /论文|学术提纲/u],
  ['report', /报告|总结|述职/u],
  ['notice', /通知|通告/u],
  ['plan', /方案|计划|规划/u],
  ['regulation', /办法|条例|规定|细则|制度|章程/u],
];
const documentNames = new RegExp(typeNames.map(([, names]) => names.source).join('|'), 'gu');

export function typeFromText(text: string): DocumentType | undefined {
  return typeNames.find(([, names]) => names.test(text))?.[0];
}

export function namedImportType(title: string) {
  const last = title.match(documentNames)?.at(-1);
  return last && typeFromText(last);
}

export function requestedDocumentType(text: string): DocumentType | undefined {
  const clauses = text
    .split(/[。！？；，,\n]/u)
    .map((clause) => clause.replace(/以[^以]*?为(?:参考|依据|参照)的?/gu, ''));
  const action = /(?:整理成|改成|写成|起草|撰写|编写|拟写|编制|生成|形成|拟|写)(?!作|[过好]?的)/u;
  const beforeReference = (phrase: string) => phrase.split(/参考|根据|依据|参照/u, 1)[0];
  const requests = clauses.flatMap((clause) => clause.split(action).slice(1));
  for (const phrase of requests.reverse()) {
    let target = beforeReference(phrase);
    // In “一份参考…的通知” the reference modifies the requested document.
    const end = phrase.lastIndexOf('的');
    if (end >= target.length && /^\s*(?:一[份篇封则个本部])?\s*$/u.test(target))
      target = phrase.slice(end + 1);
    const name = target.match(documentNames)?.at(-1);
    if (name) return typeFromText(name);
  }
  return typeFromText(clauses.map(beforeReference).join(' '));
}

export function inferDocumentType(title: string, children: NodeInput[] = []): DocumentType {
  const named = typeFromText(title);
  if (named) return named;
  const hasClause = (n: NodeInput): boolean =>
    n.sourceNumber?.unit === 'chapter' ||
    n.sourceNumber?.unit === 'article' ||
    /^第[零〇一二三四五六七八九十百千万两\d]+[章条]/u.test(n.title) ||
    !!n.children?.some(hasClause);
  if (children.some(hasClause)) return 'regulation';
  const headings = children.map((n) => n.title);
  if (headings.some((t) => /研究方法|文献综述/.test(t))) return 'thesis';
  if (headings.some((t) => /工作进展|主要成效|工作回顾/.test(t))) return 'report';
  if (headings.some((t) => /实施步骤|进度安排/.test(t))) return 'plan';
  return 'article';
}
