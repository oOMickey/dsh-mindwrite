import { naturalParagraphs } from './paragraphs.ts';
import { flatten, makeNode, type MindNode } from './model.ts';
import { readMarker, stripNumber, titleNumber, titlePositions } from './numbering.ts';
import {
  classifyImportParagraphs,
  analyzeImportNumbering,
  type ImportDetection,
  type ImportParagraphEvidence,
  type NativeList,
} from './import-numbering.ts';
import { bindReferences } from './references.ts';
import type { ImportNumbering, ImportReport, SourceNumber } from './metadata.ts';

export interface InputParagraph {
  text: string;
  /** Source line before unwrapping a Markdown heading or separating a Word label. */
  sourceLine?: string;
  centered?: boolean;
  heading?: number;
  inlineBody?: { start: number; title?: string };
  numberRun?: string;
  literal?: boolean;
  nativeList?: NativeList;
  /** A numbering instance with no recoverable structure closes the preceding list. */
  listBreak?: boolean;
  table?: InputTable;
}
export interface InputTable {
  index: number;
  rows: number;
  columns: number;
  count: number;
  method: 'column-values' | 'original-note';
  text: string;
  original?: string;
  reason: string;
}
export interface ImportResult extends Pick<ImportDetection, 'documentType' | 'numberingScheme'> {
  root: MindNode;
  report: ImportReport;
  paragraphs: ImportParagraphEvidence[];
  importNumbering?: ImportNumbering;
  detection: ImportDetection;
}
export function importSummary(root: MindNode) {
  const levels = new Set<number>();
  let paragraphs = 0;
  for (const { node, depth } of flatten(root)) {
    if (depth && node.kind !== 'preamble') levels.add(depth);
    paragraphs += naturalParagraphs(node.body).length;
  }
  return { levels: levels.size, paragraphs };
}

/** The baseline retains the visible source line even after a live node is moved or deleted. */
export function warningExcerpts(
  source: MindNode,
  warnings: NonNullable<ImportNumbering['warnings']>,
) {
  const nodes = new Map(flatten(source).map(({ node }) => [node.id, node]));
  const excerpts: Record<number, string> = {};
  const ambiguous = new Map<MindNode, Map<string, number[]>>();
  for (const warning of warnings) {
    const node = nodes.get(warning.nodeId);
    if (!node) continue;
    if (warning.code === 'ambiguous') {
      const markers = ambiguous.get(node) ?? new Map<string, number[]>();
      const ordinals = markers.get(warning.marker) ?? [];
      ordinals.push(warning.paragraph);
      markers.set(warning.marker, ordinals);
      ambiguous.set(node, markers);
    } else if (node.sourceText) {
      excerpts[warning.paragraph] = node.sourceText.slice(0, 240).split('\n', 1)[0];
    }
  }
  for (const [node, markers] of ambiguous) {
    const lines = new Map<string, string[]>();
    for (const line of node.body.split('\n')) {
      const token = readMarker(line)?.marker;
      if (!token || !markers.has(token)) continue;
      const matches = lines.get(token) ?? [];
      matches.push(line.slice(0, 240));
      lines.set(token, matches);
    }
    for (const [marker, paragraphs] of markers) {
      const matches = lines.get(marker);
      // Empty Markdown lines need not survive in the tree. Never guess between duplicate candidates.
      if (matches?.length === paragraphs.length)
        paragraphs.forEach((p, i) => {
          excerpts[p] = matches[i];
        });
    }
  }
  return excerpts;
}
export function summarizeTitle(body: string): string {
  const first = body.split(/[，。；：\n]/, 1)[0].trim();
  return [...(first || body.trim() || '待完善条款')].slice(0, 16).join('');
}
const officialUnits: SourceNumber['unit'][] = ['chapter', 'article', 'item', 'subitem'];
// Match a whole placeholder paragraph, including the placeholder emitted by our exporter.
const placeholder = /^(?:待补(?:充|写)?|待完善|待填写|TODO|TBD|【待完善[：:][^】]+】)[。.]?$/iu;

export function makeImportReport(
  root: MindNode,
  source: ImportReport['source'],
  revisions: ImportReport['revisions'],
  nativeStarts: ReadonlyMap<string, number> = new Map(),
): ImportReport {
  const rows = flatten(root);
  const chapters = rows.filter(({ node, depth }) => depth === 1 && node.kind !== 'preamble');
  const articles = rows.filter(({ depth }) => depth === 2);
  const issues: ImportReport['issues'] = [];
  for (const [unit, nodes] of [
    ['chapter', chapters],
    ['article', articles],
  ] as const) {
    const counts = new Map<number, string[]>();
    let start = 1;
    for (const { node } of nodes)
      if (node.sourceNumber?.unit === unit) {
        const n = node.sourceNumber.number;
        start = Math.min(n, counts.size ? start : (nativeStarts.get(node.id) ?? 1));
        counts.set(n, [...(counts.get(n) ?? []), node.id]);
      }
    for (const [number, nodeIds] of counts)
      if (nodeIds.length > 1)
        issues.push({
          code: unit === 'chapter' ? 'duplicate-chapter' : 'duplicate-article',
          numbers: [number],
          nodeIds,
        });
    const max = Math.min(10000, Math.max(0, ...counts.keys()));
    const missing = Array.from({ length: max - start + 1 }, (_, i) => start + i).filter(
      (n) => !counts.has(n),
    );
    if (missing.length)
      issues.push({
        code: unit === 'chapter' ? 'missing-chapter' : 'missing-article',
        numbers: missing,
        nodeIds: [],
      });
  }
  for (const { node } of rows) {
    const number = node.wordNumber?.field === 'body' ? node.wordNumber.text : '';
    const paragraphs = naturalParagraphs(
      number && node.body.startsWith(number) ? node.body.slice(number.length) : node.body,
    );
    if (
      paragraphs.length
        ? paragraphs.every((p) => placeholder.test(p.text.trim()))
        : !node.children.length
    )
      issues.push({
        code: 'unfinished',
        numbers: node.sourceNumber ? [node.sourceNumber.number] : [],
        nodeIds: [node.id],
      });
  }
  return {
    source,
    chapters: chapters.length,
    articles: articles.length,
    preambleParagraphs: root.children
      .filter((n) => n.kind === 'preamble')
      .reduce((sum, n) => sum + n.body.split('\n').filter(Boolean).length, 0),
    revisions,
    issues,
  };
}
export function importParagraphs(
  input: InputParagraph[],
  fallbackTitle: string,
  source: ImportReport['source'] = 'markdown',
  revisions: ImportReport['revisions'] = { accepted: true, insertions: 0, deletions: 0 },
): ImportResult {
  const paragraphs = classifyImportParagraphs(input, source);
  const title = paragraphs
    .filter((p) => p.evidence === 'document-title')
    .map((p) => p.text.trim())
    .join('\n');
  const root = makeNode({ title: title || fallbackTitle });
  const statutory = paragraphs.find((p) => p.level)?.marker?.family === 'official';
  const losses: NonNullable<ImportReport['losses']> = [];
  const tables: NonNullable<ImportReport['tables']> = [];
  const evidence: ImportParagraphEvidence[] = [];
  const prefixes: Record<string, string> = {};
  const wordSources = new Map<MindNode, { text: string; implicitBodyLength?: number }>();
  const stack = [{ node: root, level: 0, depth: 0 }];
  let preamble: MindNode | undefined;
  for (const paragraph of paragraphs) {
    const { level, headingLevel, marker, authorMarker, nativeList } = paragraph;
    const sourceText = nativeList ? paragraph.sourceLine! : paragraph.text;
    if (paragraph.parentLevel !== undefined)
      while (stack.at(-1)!.level > paragraph.parentLevel) stack.pop();
    const record = (node: MindNode) =>
      evidence.push({
        paragraph: paragraph.index,
        text: paragraph.sourceLine ?? paragraph.text,
        nodeId: node.id,
        kind: level || paragraph.evidence === 'document-title' ? 'heading' : 'body',
        evidence: paragraph.evidence,
        ...(authorMarker && { numbering: authorMarker }),
        ...(paragraph.numberRun && { numberRun: paragraph.numberRun }),
        ...(nativeList && { nativeList, authorText: paragraph.text }),
      });
    if (paragraph.evidence === 'document-title') {
      record(root);
      continue;
    }
    if (paragraph.table) {
      const table = paragraph.table;
      const node = stack.at(-1)!.node;
      record(node);
      const { original, text, ...entry } = table;
      tables.push({ ...entry, nodeId: node.id });
      if (text) node.body += (node.body ? '\n' : '') + text;
      if (table.method === 'original-note')
        node.note =
          (node.note ? node.note + '\n\n' : '') +
          `【表格 ${table.index} 原文：需人工核对】\n${original}`;
      if (node.sourceText !== undefined)
        node.sourceText +=
          '\n' +
          (table.method === 'column-values' ? text : `【表格 ${table.index} 原文见写作说明】`);
      continue;
    }
    const text = paragraph.text.trim() || nativeList?.label || '';
    if (level) {
      const numberedLevel =
        paragraph.shape === 'quantity' ||
        (nativeList && !nativeList.fullPath && marker?.family !== 'official')
          ? undefined
          : marker?.level;
      const legal = marker?.family === 'official' ? marker : undefined;
      const article = legal?.level === 2;
      while (stack.length > 1 && stack.at(-1)!.level >= level) stack.pop();
      if (article && !headingLevel && stack.at(-1)!.level === 0) {
        const section = makeNode({ title: '正文' });
        root.children.push(section);
        stack.push({ node: section, level: 1, depth: 1 });
      }
      const parent = stack.at(-1)!;
      const depth = parent.depth + 1;
      const sourceLevel =
        paragraph.listBase !== undefined && nativeList
          ? stack.find((parent) => parent.level === paragraph.listBase)!.depth +
            nativeList.level +
            1
          : (headingLevel ?? (paragraph.evidence === 'native-path' ? level : undefined));
      if (sourceLevel && sourceLevel !== depth)
        losses.push({
          kind: 'heading',
          paragraph: paragraph.index,
          reason: 'missing-parent',
          sourceLevel,
          targetLevel: depth,
          marker: nativeList?.label ?? text,
        });
      if (headingLevel && numberedLevel && headingLevel !== numberedLevel)
        losses.push({
          kind: 'heading',
          paragraph: paragraph.index,
          reason: 'numbering-conflict',
          sourceLevel: numberedLevel,
          targetLevel: depth,
          marker: nativeList?.label ?? text,
        });
      let content = paragraph.text;
      if (paragraph.inlineBody) content = content.slice(paragraph.inlineBody.start);
      else if (paragraph.sharedPrefix)
        content = content.trimStart().slice(paragraph.sharedPrefix.length);
      else if (legal && !nativeList)
        content = content.trimStart().slice(legal.prefix.length).trim();
      const inline = legal && legal.level > 1 && (!headingLevel || !!paragraph.inlineBody);
      const bracket =
        inline && article && !paragraph.inlineBody ? /^【([^】]+)】/.exec(content) : null;
      const inlineTitle = paragraph.inlineBody?.title ?? bracket?.[1];
      const node = makeNode({
        title: inline
          ? (inlineTitle ?? summarizeTitle(content))
          : source !== 'docx' && legal && !headingLevel
            ? stripNumber(text) || text
            : text,
        body: inline ? content.slice(bracket?.[0].length ?? 0) : '',
        ...(inline && article && !inlineTitle ? { titleSource: 'auto' as const } : {}),
        ...(legal && {
          sourceNumber: { unit: officialUnits[legal.level - 1], number: legal.path[0] },
        }),
      });
      if (!inline && paragraph.sharedPrefix) {
        // Word supplied this very prefix. The existing Word number slot lets every
        // projection consume it once, including when the display scheme changes.
        node.wordNumber = { field: 'title', text: text.slice(0, paragraph.sharedPrefix.length) };
      } else if (source === 'docx') {
        if (
          !inline &&
          !paragraph.numberRun &&
          (paragraph.authorQuantity || paragraph.shape === 'quantity')
        )
          node.wordTitlePrefix = '';
        if (!inline && paragraph.numberRun && text.startsWith(paragraph.numberRun))
          node.wordNumber = { field: 'title', text: paragraph.numberRun };
        wordSources.set(node, {
          text: paragraph.text,
          ...(inline &&
            !paragraph.inlineBody &&
            !bracket &&
            !paragraph.numberRun &&
            !nativeList && { implicitBodyLength: node.body.length }),
        });
      }
      parent.node.children.push(node);
      if (!inline && authorMarker && node.title === text) {
        // The separator on a number-only line is part of the author's original token.
        if (node.title === authorMarker.marker) node.title = authorMarker.prefix;
        prefixes[node.id] = authorMarker.prefix;
      }
      record(node);
      node.sourceText = sourceText;
      stack.push({ node, level, depth });
    } else {
      let node = stack.at(-1)!.node;
      if (statutory && node === root) {
        if (!preamble) {
          preamble = makeNode({ title: '序言', body: '', kind: 'preamble' });
          root.children.push(preamble);
        }
        node = preamble;
      }
      node.body += (node.body ? '\n' : '') + sourceText;
      record(node);
      if (node.sourceText !== undefined) node.sourceText += '\n' + sourceText;
    }
  }
  if (wordSources.size) {
    const positions = titlePositions(
      root,
      (node) => wordSources.get(node)?.text.trim() ?? node.title,
    );
    for (const [node, { text, implicitBodyLength }] of wordSources) {
      const position = positions.get(node)!;
      if (node.wordNumber && node.wordNumber.text !== position.prefix) delete node.wordNumber;
      if (implicitBodyLength === undefined || position.groupPrefix) continue;
      // A standalone article label occupied its own paragraph before the body.
      const rest = node.body.slice(implicitBodyLength);
      const standaloneArticle = implicitBodyLength === 0 && node.sourceNumber?.unit === 'article';
      node.body = text + (standaloneArticle && rest ? '\n' : '') + rest;
      const token = titleNumber(text);
      if (token) node.wordNumber = { field: 'body', text: token };
      if (node.titleSource !== 'auto') node.title = summarizeTitle(text);
    }
  }
  // A line containing only the article number takes its summary from the following body.
  for (const { node } of flatten(root))
    if (node.titleSource === 'auto') node.title = summarizeTitle(node.body);
  bindReferences(root);
  const nativeStarts = new Map(
    evidence.flatMap((p) =>
      p.kind === 'heading' && p.nativeList && p.nativeList.start > 1
        ? [[p.nodeId, p.nativeList.start] as const]
        : [],
    ),
  );
  const report = makeImportReport(root, source, revisions, nativeStarts);
  if (losses.length) report.losses = losses;
  report.tableCount = tables.reduce((n, table) => n + table.count, 0);
  report.tables = tables;
  const analysis = analyzeImportNumbering(root, evidence, prefixes, title, fallbackTitle);
  const { documentType, numberingScheme } = analysis.detection;
  return { root, report, paragraphs: evidence, documentType, numberingScheme, ...analysis };
}
export function importMarkdownDetailed(text: string, fallbackTitle = '导入文档'): ImportResult {
  let fence = '',
    table = false,
    quotedParagraph = false;
  const blockStart =
    /^ {0,3}(?:#{1,6}(?:\s|$)|(?:[-+*]|1[.)])\s+|>|`{3,}|~{3,}|(?:-{3,}|\*{3,}|_{3,})\s*$)/u;
  const paragraphs = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw, i, lines): InputParagraph => {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(raw);
      if (fence) {
        if (
          delimiter &&
          delimiter[1][0] === fence[0] &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        )
          fence = '';
        return { text: raw, literal: true };
      }
      if (delimiter && (delimiter[1][0] === '~' || !delimiter[2].includes('`'))) {
        fence = delimiter[1];
        table = false;
        quotedParagraph = false;
        return { text: raw, literal: true };
      }
      const quote = /^ {0,3}>[ \t]?(.*)$/u.exec(raw);
      if (quote) {
        table = false;
        quotedParagraph = !!quote[1].trim() && !blockStart.test(quote[1]);
        return { text: raw, literal: true };
      }
      // A quoted prose paragraph can continue without another > until a blank or block boundary.
      quotedParagraph = quotedParagraph && !!raw.trim() && !blockStart.test(raw);
      if (quotedParagraph || /^(?: {4}| {0,3}\t)/u.test(raw)) return { text: raw, literal: true };
      const heading = /^ {0,3}(#{1,6})\s+(.+)$/u.exec(raw);
      if (heading) {
        table = false;
        const trimmed = heading[2].trimEnd();
        const content = trimmed.endsWith('#')
          ? trimmed.replace(/#+$/u, '').trimEnd() || '#'
          : heading[2];
        return { text: content, heading: heading[1].length, sourceLine: raw };
      }
      table =
        raw.includes('|') &&
        (table || /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/u.test(lines[i + 1] ?? ''));
      return table ? { text: raw, literal: true } : { text: raw };
    });
  return importParagraphs(paragraphs, fallbackTitle);
}
