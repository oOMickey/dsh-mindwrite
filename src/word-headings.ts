import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type JSZip from 'jszip';
import type { InputParagraph } from './import.ts';
import { titleNumber } from './numbering.ts';

export const wordBodyStyle = 'MindwriteBody';
export const wordClauseStyle = 'MindwriteClause';
export const wordNumberStyle = 'MindwriteNumber';
const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function parse(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX 标题定义包含不支持的实体');
  const invalid = () => {
    throw new Error('DOCX 标题定义格式无效');
  };
  return new DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(xml, 'application/xml');
}
const child = (element: Element | undefined, name: string) =>
  element &&
  (Array.from(element.childNodes).find(
    (n) => n.nodeType === 1 && (n as Element).localName === name,
  ) as Element | undefined);
const val = (element?: Element) => element?.getAttributeNS(NS, 'val') ?? undefined;

export async function wordStyles(zip: JSZip) {
  const styles = new Map<string, Element>();
  const xml = await zip.file('word/styles.xml')?.async('string');
  if (xml)
    for (const style of Array.from(parse(xml).getElementsByTagNameNS(NS, 'style')))
      styles.set(style.getAttributeNS(NS, 'styleId')!, style);
  return styles;
}

/** Mark the structural runs, leaving Word text conversion (including symbols and notes) to Mammoth. */
export async function materializeWordHeadings(
  zip: JSZip,
  styles: Map<string, Element>,
  listMarkers: ReadonlyMap<string, unknown>,
) {
  const xml = await zip.file('word/document.xml')!.async('string');
  const document = parse(xml);
  function namedLevel(id: string | undefined) {
    const name = val(child(id ? styles.get(id) : undefined, 'name')) ?? id ?? '';
    const level = /^(?:heading|标题)\s*([1-9])$/i.exec(name);
    return level ? Number(level[1]) + 1 : undefined;
  }
  function styleHeading(id: string | undefined, visited = new Set<string>()): number | undefined {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const style = styles.get(id);
    const name = val(child(style, 'name')) ?? id;
    if (/^(?:Title|标题)$/i.test(name)) return 1;
    const outline = val(child(child(style, 'pPr'), 'outlineLvl'));
    if (outline !== undefined) return Number(outline) < 9 ? Number(outline) + 2 : undefined;
    return namedLevel(id) ?? styleHeading(val(child(style, 'basedOn')), visited);
  }
  function quoteStyle(id: string | undefined, visited = new Set<string>()): boolean {
    if (!id || visited.has(id)) return false;
    visited.add(id);
    const style = styles.get(id);
    const quote = /^(?:Quote|Intense\s*Quote|引用|明显引用)$/iu;
    return (
      quote.test(id) ||
      quote.test(val(child(style, 'name')) ?? '') ||
      quoteStyle(val(child(style, 'basedOn')), visited)
    );
  }
  const core = await zip.file('docProps/core.xml')?.async('string');
  const fromMindwrite = core?.includes('<dc:creator>dsh-mindwrite</dc:creator>');
  const markedExport = styles.has(wordClauseStyle);
  // Word can wrap edited runs in transparent custom XML. Keep those runs in the
  // marked export stream so that their text still goes through Mammoth.
  const wrappers = markedExport ? Array.from(document.getElementsByTagNameNS(NS, 'customXml')) : [];
  for (const wrapper of wrappers) {
    const parent = wrapper.parentNode!;
    for (const node of Array.from(wrapper.childNodes))
      if ((node as Element).localName !== 'customXmlPr') parent.insertBefore(node, wrapper);
    parent.removeChild(wrapper);
  }
  function markerRun(marker: string) {
    const run = document.createElementNS(NS, 'w:r'),
      text = document.createElementNS(NS, 'w:t');
    text.appendChild(document.createTextNode(marker));
    run.appendChild(text);
    return run;
  }
  const markers = new Map<
      string,
      Pick<InputParagraph, 'heading' | 'inlineBody' | 'literal' | 'numberRun'> & {
        boundary?: string;
      }
    >(),
    nonce = crypto.randomUUID().replaceAll('-', '');
  for (const [index, paragraph] of Array.from(document.getElementsByTagNameNS(NS, 'p')).entries()) {
    let parent = paragraph.parentNode,
      deleted = false;
    while (parent) {
      if ((parent as Element).localName === 'del') deleted = true;
      parent = parent.parentNode;
    }
    if (deleted) continue;
    const properties = child(paragraph, 'pPr'),
      outline = val(child(properties, 'outlineLvl')),
      styleId = val(child(properties, 'pStyle'));
    if (child(child(properties, 'rPr'), 'del')) continue;
    const heading =
      namedLevel(styleId) ??
      (outline !== undefined
        ? Number(outline) < 9
          ? Number(outline) + 2
          : undefined
        : styleHeading(styleId));
    const runs = Array.from(paragraph.getElementsByTagNameNS(NS, 'r')).filter((run) => {
      if (listMarkers.has(run.textContent ?? '')) return false;
      for (let parent = run.parentNode; parent && parent !== paragraph; parent = parent.parentNode)
        if ((parent as Element).localName === 'del') return false;
      return true;
    });
    const bodyStart = runs.findIndex(
      (r) => val(child(child(r, 'rPr'), 'rStyle')) === wordBodyStyle,
    );
    const firstLine = child(properties, 'ind')?.getAttributeNS(NS, 'firstLine');
    // Earlier standard exports kept headings with the next paragraph. Official exports indented body paragraphs.
    const legacyBody =
      fromMindwrite &&
      !markedExport &&
      val(child(properties, 'keepNext')) === 'false' &&
      (Number(firstLine) > 0 ||
        child(properties, 'spacing')?.getAttributeNS(NS, 'lineRule') === 'auto');
    const first = runs[0]?.textContent ?? '';
    const token = titleNumber(first);
    const numberRun =
      val(child(child(runs[0], 'rPr'), 'rStyle')) === wordNumberStyle ? first : undefined;
    const number = token.endsWith('条') && first.startsWith(token + '　') ? token + '　' : token;
    // Before MindwriteClause, real exported articles used Heading2 and a
    // separate bold number run. A promoted body paragraph has no such run.
    const bold = child(child(runs[0], 'rPr'), 'b');
    const oldClause =
      legacyBody &&
      bodyStart !== 0 &&
      ((heading === 3 &&
        token.endsWith('条') &&
        first === number &&
        bold &&
        !['0', 'false', 'off'].includes(val(bold) ?? '')) ||
        (heading !== undefined && heading >= 4 && /^[（(\d]/u.test(token)));
    const clause = styleId === wordClauseStyle || oldClause;
    const literal =
      !heading &&
      !clause &&
      (bodyStart >= 0 || (legacyBody && styleId === 'Normal') || quoteStyle(styleId));
    if (!literal && !clause && !numberRun && (!heading || !Number.isInteger(heading))) continue;
    const marker = `__MW_HEAD_${nonce}_${index}__`;
    let inlineBody: InputParagraph['inlineBody'], boundary: string | undefined;
    if (clause && number) {
      const labelRun = runs[1];
      const label =
        token.endsWith('条') && first === number && runs.length > 2 && bodyStart !== 1
          ? /^【(.*)】$/su.exec(labelRun.textContent ?? '')
          : null;
      inlineBody = { start: number.length, title: label?.[1] };
      if (first === number) {
        const last = label ? labelRun : runs[0];
        boundary = `__MW_BODY_${nonce}_${index}__`;
        last.parentNode!.insertBefore(markerRun(boundary), last.nextSibling);
      }
    }
    markers.set(marker, { heading, inlineBody, literal, numberRun, boundary });
    paragraph.insertBefore(
      markerRun(marker),
      properties ? properties.nextSibling : paragraph.firstChild,
    );
  }
  if (markers.size || wrappers.length)
    zip.file('word/document.xml', new XMLSerializer().serializeToString(document));
  return markers;
}
