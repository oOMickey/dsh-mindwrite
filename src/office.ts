import { printLayout } from './style-tokens.ts';
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  PageOrientation,
} from 'docx';
import { margins, type PageStyle, type TitleNumbering } from './document-profile.ts';
import { documentParagraphs, type ArticleTitle } from './format.ts';
import mammoth from 'mammoth';
import { loadSafeDocx } from './docx-safety.ts';
import { materializeWordTables } from './word-tables.ts';
import { DOMParser } from '@xmldom/xmldom';
import { importParagraphs, type InputParagraph, type ImportResult } from './import.ts';
import type { MindNode, MindDocument } from './model.ts';
import { revisionRows } from './revisions.ts';
import { materializeWordLists } from './word-lists.ts';
import {
  materializeWordHeadings,
  wordStyles,
  wordBodyStyle,
  wordClauseStyle,
  wordNumberStyle,
} from './word-headings.ts';

const BLACK = '000000';
const bodyFont = { ascii: 'FangSong', hAnsi: 'FangSong', eastAsia: '仿宋_GB2312', cs: 'FangSong' };
const titleFont = { ascii: 'SimSun', hAnsi: 'SimSun', eastAsia: '方正小标宋简体', cs: 'SimSun' };
const chapterFont = { ascii: 'SimHei', hAnsi: 'SimHei', eastAsia: '黑体', cs: 'SimHei' };
const mm = (value: number) => Math.round((value * 1440) / printLayout.mmPerInch);
const standardFont = { ascii: 'SimSun', hAnsi: 'SimSun', eastAsia: '宋体', cs: 'SimSun' };

export async function exportRevisionDocx(
  document: Pick<MindDocument, 'root' | 'sourceRoot'>,
  onlyChanges = false,
): Promise<Buffer> {
  const rows = revisionRows(document).filter(
    (row) => !onlyChanges || !row.flags.includes('未改动'),
  );
  const table = printLayout.revisionTable;
  const cell = (text: string, header = false) =>
    new TableCell({
      width: { size: table.columnPercent, type: WidthType.PERCENTAGE },
      children: text.split('\n').map(
        (line) =>
          new Paragraph({
            spacing: { after: table.afterTwips },
            children: [
              new TextRun({
                text: line,
                font: bodyFont,
                size: printLayout.standard.bodyPt * printLayout.halfPointsPerPoint,
                bold: header,
                color: BLACK,
              }),
            ],
          }),
      ),
    });
  return Packer.toBuffer(
    new Document({
      creator: 'dsh-mindwrite',
      title: document.root.title + '修订对照表',
      sections: [
        {
          properties: {
            page: {
              size: {
                orientation: PageOrientation.LANDSCAPE,
                width: mm(printLayout.widthMm),
                height: mm(printLayout.heightMm),
              },
              margin: {
                top: mm(table.marginVerticalMm),
                bottom: mm(table.marginVerticalMm),
                left: mm(table.marginHorizontalMm),
                right: mm(table.marginHorizontalMm),
              },
            },
          },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: document.root.title + ' · 修订对照表',
                  font: titleFont,
                  size: printLayout.standard.titlePt * printLayout.halfPointsPerPoint,
                }),
              ],
            }),
            new Table({
              width: { size: table.tablePercent, type: WidthType.PERCENTAGE },
              rows: [
                new TableRow({
                  tableHeader: true,
                  children: ['原条文', '修改后条文', '修改说明'].map((text) => cell(text, true)),
                }),
                ...rows.map(
                  (row) =>
                    new TableRow({
                      children: [
                        cell(row.original),
                        cell(row.current),
                        cell(
                          row.flags.map((flag) => '【' + flag + '】').join('') +
                            '\n' +
                            (row.note || '（尚未填写修改说明）'),
                        ),
                      ],
                    }),
                ),
              ],
            }),
          ],
        },
      ],
    }),
  );
}

export async function exportDocx(
  root: MindNode,
  scheme: TitleNumbering = 'official',
  fontSize: number = printLayout.official.bodyPt,
  articleTitle: ArticleTitle = 'omit',
  pageStyle: PageStyle = 'official',
  sectionHeadings = false,
): Promise<Buffer> {
  const standard = pageStyle === 'standard';
  const margin = margins[pageStyle];
  const bodySize = standard ? printLayout.standard.bodyPt : fontSize;
  const spacing = standard
    ? {
        before: 0,
        after: printLayout.standard.afterPt * 20,
        line: printLayout.standard.leading * 240,
        lineRule: LineRuleType.AUTO,
      }
    : { before: 0, after: 0, line: printLayout.official.linePt * 20, lineRule: LineRuleType.EXACT };
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];
  const normalRun = {
    font: standard ? standardFont : bodyFont,
    color: BLACK,
    size: bodySize * printLayout.halfPointsPerPoint,
    bold: false,
    italics: false,
  };
  const headingStyle = { run: normalRun, paragraph: { spacing } };
  const children = documentParagraphs(root, scheme, articleTitle, sectionHeadings).map((p) => {
    const title = p.kind === 'title';
    const heading = p.kind === 'chapter' || p.kind === 'heading';
    const clause = p.kind === 'article' || p.kind === 'item';
    // The article number and optional bracketed title precede the author's text.
    const spans = p.spans.map((span) => ({ ...span, style: undefined as string | undefined }));
    const bodyStart = p.kind === 'article' ? (articleTitle === 'bracket' ? 2 : 1) : 0;
    if (!title && !heading && spans[bodyStart]) spans[bodyStart].style = wordBodyStyle;
    if (p.numberPrefix) {
      const first = spans[0];
      const rest = first.text.slice(p.numberPrefix.length);
      spans.splice(
        0,
        1,
        { ...first, text: p.numberPrefix, style: wordNumberStyle },
        ...(rest ? [{ ...first, text: rest }] : []),
      );
    }
    return new Paragraph({
      heading: title
        ? HeadingLevel.TITLE
        : clause || p.outline === undefined
          ? undefined
          : headings[Math.min(p.outline, headings.length - 1)],
      style: clause ? wordClauseStyle : !title && p.outline === undefined ? 'Normal' : undefined,
      outlineLevel: clause ? p.outline : undefined,
      alignment: (standard ? title : p.centered) ? AlignmentType.CENTER : AlignmentType.LEFT,
      indent: !standard && p.indent ? { firstLine: fontSize * 40 } : undefined,
      spacing,
      keepLines: true,
      keepNext: (standard && heading) || p.kind === 'chapter' || p.kind === 'title',
      children: spans.flatMap((span) =>
        span.text.split('\n').map(
          (text, index) =>
            new TextRun({
              text,
              style: span.style,
              break: index ? 1 : undefined,
              color: BLACK,
              font: standard
                ? standardFont
                : title
                  ? titleFont
                  : heading || span.emphasis
                    ? chapterFont
                    : bodyFont,
              size:
                (title
                  ? standard
                    ? printLayout.standard.titlePt
                    : printLayout.official.titlePt
                  : standard && heading
                    ? p.depth === 1
                      ? printLayout.standard.chapterPt
                      : printLayout.standard.headingPt
                    : bodySize) * printLayout.halfPointsPerPoint,
              bold: (standard && (title || heading)) || !!span.emphasis,
              italics: false,
            }),
        ),
      ),
    });
  });
  return Packer.toBuffer(
    new Document({
      features: { updateFields: true },
      creator: 'dsh-mindwrite',
      title: root.title,
      styles: {
        characterStyles: [
          { id: wordBodyStyle, name: '导图写作正文', basedOn: 'DefaultParagraphFont' },
          { id: wordNumberStyle, name: '导图写作编号', basedOn: 'DefaultParagraphFont' },
        ],
        default: {
          document: { run: normalRun, paragraph: { spacing } },
          title: {
            run: {
              ...normalRun,
              font: standard ? standardFont : titleFont,
              size:
                (standard ? printLayout.standard.titlePt : printLayout.official.titlePt) *
                printLayout.halfPointsPerPoint,
            },
            paragraph: { spacing },
          },
          heading1: {
            run: { ...normalRun, font: standard ? standardFont : chapterFont },
            paragraph: { spacing, outlineLevel: 0 },
          },
          heading2: { ...headingStyle, paragraph: { spacing, outlineLevel: 1 } },
          heading3: { ...headingStyle, paragraph: { spacing, outlineLevel: 2 } },
          heading4: { ...headingStyle, paragraph: { spacing, outlineLevel: 3 } },
          heading5: { ...headingStyle, paragraph: { spacing, outlineLevel: 4 } },
          heading6: { ...headingStyle, paragraph: { spacing, outlineLevel: 5 } },
          strong: { run: { ...normalRun, bold: true } },
          listParagraph: headingStyle,
          hyperlink: { run: normalRun },
          footnoteReference: { run: normalRun },
          footnoteText: headingStyle,
          footnoteTextChar: { run: normalRun },
        },
        paragraphStyles: [
          { id: wordClauseStyle, name: '导图写作条文', basedOn: 'Normal' },
          {
            id: 'Normal',
            name: 'Normal',
            quickFormat: true,
            run: normalRun,
            paragraph: { spacing },
          },
        ],
      },
      sections: [
        {
          properties: {
            page: {
              size: { width: mm(printLayout.widthMm), height: mm(printLayout.heightMm) },
              margin: {
                top: mm(margin.top),
                bottom: mm(margin.bottom),
                left: mm(margin.left),
                right: mm(margin.right),
                footer: mm(margin.footer),
              },
            },
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  spacing,
                  children: [
                    new TextRun({
                      children: standard ? [PageNumber.CURRENT] : ['— ', PageNumber.CURRENT, ' —'],
                      color: BLACK,
                      font: { eastAsia: '宋体', ascii: 'SimSun', hAnsi: 'SimSun' },
                      size: printLayout.official.footerPt * printLayout.halfPointsPerPoint,
                      bold: false,
                    }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    }),
  );
}

function decode(text: string): string {
  return text
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n: string) =>
      String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)),
    )
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
interface MammothElement {
  type?: string;
  alignment?: string;
  styleId?: string;
  styleName?: string;
  children?: MammothElement[];
}
function markCentered(element: MammothElement): MammothElement {
  return {
    ...element,
    ...(element.type === 'paragraph' && element.alignment === 'center'
      ? { styleId: 'MindwriteCentered', styleName: 'MindwriteCentered' }
      : {}),
    ...(element.children ? { children: element.children.map(markCentered) } : {}),
  };
}
export async function importDocxDetailed(bytes: Buffer, title: string): Promise<ImportResult> {
  const zip = loadSafeDocx(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX 正文格式无效');
  const invalid = () => {
    throw new Error('DOCX 正文格式无效');
  };
  const document = new DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(xml, 'application/xml');
  const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const revisions = {
    accepted: true as const,
    insertions: document.getElementsByTagNameNS(namespace, 'ins').length,
    deletions: document.getElementsByTagNameNS(namespace, 'del').length,
  };
  const styles = await wordStyles(zip);
  const tables = await materializeWordTables(zip, styles.has(wordClauseStyle));
  const lists = await materializeWordLists(
    zip,
    await zip.file('word/document.xml')!.async('string'),
    styles,
  );
  const headings = await materializeWordHeadings(zip, styles, lists);
  const normalized = await zip.generateAsync({ type: 'nodebuffer' });
  const result = await mammoth.convertToHtml(
    { buffer: normalized },
    {
      transformDocument: markCentered,
      styleMap: [
        "p[style-name='MindwriteCentered'] => p.mw-center:fresh",
        "p[style-name='Title'] => h1:fresh",
        ...Array.from(
          { length: 5 },
          (_, i) => `p[style-name='Heading ${i + 1}'] => h${i + 2}:fresh`,
        ),
      ],
      externalFileAccess: false,
    },
  );
  const paragraphs = [...result.value.matchAll(/<(h[1-6]|p|li)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map(
    (m) => ({
      text: decode(m[3].replace(/<br\s*\/?\s*>/g, '\n').replace(/<[^>]+>/g, '')),
      centered: /class="[^"]*\bmw-center\b/.test(m[2]),
      heading: m[1][0] === 'h' ? Number(m[1][1]) : undefined,
    }),
  );
  let nativeListItems = 0;
  const listLosses: NonNullable<ImportResult['report']['losses']> = [];
  const accepted = paragraphs.map((paragraph: InputParagraph, index) => {
    for (const [marker, table] of tables)
      if (paragraph.text.includes(marker))
        return { text: table.text || `表格 ${table.index}`, literal: true, table };
    for (const [marker] of paragraph.text.matchAll(/__MW_HEAD_[\da-f]{32}_\d+__/gu)) {
      const properties = headings.get(marker);
      if (!properties) continue;
      const { boundary, inlineBody, ...heading } = properties;
      const text = paragraph.text.replace(marker, '');
      const start = boundary ? text.indexOf(boundary) : -1;
      paragraph = {
        ...paragraph,
        ...heading,
        text: boundary && start >= 0 ? text.replace(boundary, '') : text,
        inlineBody: inlineBody && start >= 0 ? { ...inlineBody, start } : inlineBody,
      };
    }
    for (const [marker] of paragraph.text.matchAll(/__MW_LIST_[\da-f]{32}_\d+__/gu)) {
      const info = lists.get(marker);
      if (!info) continue;
      const text = paragraph.text.replace(marker, '');
      if ('nativeList' in info) {
        nativeListItems++;
        return { ...paragraph, text, nativeList: info.nativeList };
      }
      listLosses.push({
        kind: 'word-list',
        paragraph: index + 1,
        reason: info.reason,
        marker: info.fallback,
      });
      return { ...paragraph, text: info.fallback + text, literal: true, listBreak: true };
    }
    return paragraph;
  });
  const imported = importParagraphs(accepted, title, 'docx', revisions);
  if (lists.size) imported.report.nativeListItems = nativeListItems;
  if (listLosses.length)
    imported.report.losses = [...(imported.report.losses ?? []), ...listLosses];
  return imported;
}
export async function importDocx(bytes: Buffer, title: string): Promise<MindNode> {
  return (await importDocxDetailed(bytes, title)).root;
}
