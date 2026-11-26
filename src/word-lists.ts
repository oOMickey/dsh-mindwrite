import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type JSZip from 'jszip';
import { chinese } from './numbering.ts';
import type { NativeList } from './import-numbering.ts';

const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
type XmlElement = Element;
const children = (element: XmlElement, name: string): XmlElement[] =>
  Array.from(element.childNodes).filter(
    (node) => node.nodeType === 1 && (node as Element).localName === name,
  ) as XmlElement[];
const first = (element: XmlElement | undefined, name: string) =>
  element && children(element, name)[0];
const value = (element?: XmlElement, name = 'val') =>
  element?.getAttributeNS(NS, name) ?? undefined;
const prop = (element: XmlElement | undefined, name: string) => value(first(element, name));
interface Level {
  format: string;
  text: string;
  start: number;
  restart?: number;
  suffix?: string;
}
interface ListDefinition {
  levels: Map<number, Level>;
  restartAfterBreak: boolean;
}

function parse(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX 编号定义包含不支持的实体');
  const invalid = () => {
    throw new Error('DOCX 编号定义格式无效');
  };
  return new DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(xml, 'application/xml');
}
function readLevel(element: XmlElement): Level {
  return {
    format: prop(element, 'numFmt') ?? 'decimal',
    text: prop(element, 'lvlText') ?? '',
    start: Number(prop(element, 'start') ?? 1),
    suffix: prop(element, 'suff'),
    ...(prop(element, 'lvlRestart') !== undefined
      ? { restart: Number(prop(element, 'lvlRestart')) }
      : {}),
  };
}
function formatted(number: number, format: string): string | undefined {
  if (!Number.isSafeInteger(number) || number < 0 || number > 999_999_999_999) return;
  if (format === 'decimal') return String(number);
  if (supportedFormat.test(format) && /chinese|ideograph/i.test(format)) return chinese(number);
  if (format === 'decimalZero') return String(number).padStart(2, '0');
  if (/Letter$/.test(format)) {
    let text = '',
      n = number;
    while (n > 0) {
      n--;
      text = String.fromCharCode(65 + (n % 26)) + text;
      n = Math.floor(n / 26);
    }
    return format === 'lowerLetter' ? text.toLowerCase() : text;
  }
  if (/Roman$/.test(format)) {
    if (number > 3999) return;
    let text = '',
      n = number;
    for (const [count, symbol] of [
      [1000, 'M'],
      [900, 'CM'],
      [500, 'D'],
      [400, 'CD'],
      [100, 'C'],
      [90, 'XC'],
      [50, 'L'],
      [40, 'XL'],
      [10, 'X'],
      [9, 'IX'],
      [5, 'V'],
      [4, 'IV'],
      [1, 'I'],
    ] as const) {
      while (n >= count) {
        text += symbol;
        n -= count;
      }
    }
    return format === 'lowerRoman' ? text.toLowerCase() : text;
  }
}

const supportedFormat = /^(?:chineseCounting(?:Thousand)?|ideographTraditional|decimal(?:Zero)?)$/u;
const supportedLabel =
  /^(?:\d+(?:[.．]\d+)*|[（(][一二三四五六七八九十百千万亿零〇\d]+[）)]|[一二三四五六七八九十百千万亿零〇\d]+、|\d+[.．]|第[一二三四五六七八九十百千万亿零〇\d]+[章条])$/u;

type ListMarker =
  | { nativeList: NativeList }
  | { fallback: string; reason: 'missing-definition' | 'unsupported-pattern' };

function listMarker(
  numId: string,
  index: number,
  levels: Map<number, Level> | undefined,
  counters: Map<number, number>,
  restarted: boolean,
): ListMarker {
  const level = levels?.get(index);
  const missing = { fallback: '', reason: 'missing-definition' } as const;
  if (!level || !levels) return missing;
  const parts = level.text.split(/(%\d)/u);
  for (let i = 1; i < parts.length; i += 2) {
    const depth = Number(parts[i][1]) - 1;
    const referenced = levels.get(depth);
    if (!referenced) return missing;
    const restart = referenced.restart ?? depth;
    const value = formatted(counters.get(depth) ?? referenced.start, referenced.format);
    if (
      value === undefined ||
      depth > index ||
      !Number.isInteger(restart) ||
      restart < 0 ||
      restart > depth
    )
      return { fallback: '', reason: 'unsupported-pattern' };
    parts[i] = value;
  }
  const label = parts.join('');
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index > 8 ||
    !supportedFormat.test(level.format) ||
    !supportedLabel.test(label) ||
    !level.text.includes('%' + (index + 1))
  )
    return { fallback: label, reason: 'unsupported-pattern' };
  const fullPath =
    /^\d+(?:[.．]\d+)*$/u.test(label) &&
    level.text.replaceAll('．', '.') ===
      Array.from({ length: index + 1 }, (_, i) => '%' + (i + 1)).join('.');
  return {
    nativeList: {
      numId,
      level: index,
      label,
      ordinal: counters.get(index)!,
      start: level.start,
      ...(fullPath && { fullPath: true }),
      ...(restarted && { restarted: true }),
      ...(level.suffix && {
        separator: level.suffix === 'tab' ? '\t' : level.suffix === 'space' ? ' ' : '',
      }),
    },
  };
}

/** Carry the generated label separately from every author run through Mammoth. */
export async function materializeWordLists(
  zip: JSZip,
  documentXml: string,
  styles: Map<string, Element>,
) {
  const numberingXml = await zip.file('word/numbering.xml')?.async('string');
  const abstracts = new Map<string, ListDefinition>(),
    lists = new Map<string, ListDefinition>();
  if (numberingXml) {
    const numbering = parse(numberingXml);
    for (const abstract of Array.from(numbering.getElementsByTagNameNS(NS, 'abstractNum'))) {
      abstracts.set(value(abstract, 'abstractNumId')!, {
        restartAfterBreak: ['1', 'true', 'on'].includes(
          abstract.getAttributeNS(W15, 'restartNumberingAfterBreak') ?? '',
        ),
        levels: new Map(
          children(abstract, 'lvl').map((level) => [
            Number(value(level, 'ilvl') ?? 0),
            readLevel(level),
          ]),
        ),
      });
    }
    for (const num of Array.from(numbering.getElementsByTagNameNS(NS, 'num'))) {
      const abstract = abstracts.get(prop(num, 'abstractNumId') ?? '');
      const levels = new Map(abstract?.levels);
      for (const override of children(num, 'lvlOverride')) {
        const index = Number(value(override, 'ilvl') ?? 0),
          replacement = first(override, 'lvl');
        const inherited = levels.get(index);
        const level = replacement
          ? { ...readLevel(replacement), restart: inherited?.restart }
          : inherited;
        if (level)
          levels.set(index, {
            ...level,
            start: Number(prop(override, 'startOverride') ?? level.start),
          });
      }
      lists.set(value(num, 'numId')!, {
        levels,
        restartAfterBreak: abstract?.restartAfterBreak ?? false,
      });
    }
  }
  function styleList(
    id: string | undefined,
    seen = new Set<string>(),
  ): { numId?: string; level?: string } {
    if (!id || seen.has(id)) return {};
    seen.add(id);
    const style = styles.get(id);
    if (!style) return {};
    const inherited = styleList(prop(style, 'basedOn'), seen),
      num = first(first(style, 'pPr'), 'numPr');
    return {
      ...inherited,
      ...(prop(num, 'numId') !== undefined ? { numId: prop(num, 'numId') } : {}),
      ...(prop(num, 'ilvl') !== undefined ? { level: prop(num, 'ilvl') } : {}),
    };
  }
  const document = parse(documentXml),
    nonce = crypto.randomUUID().replaceAll('-', '');
  const markers = new Map<string, ListMarker>();
  const counts = new Map<string, { section: number; counters: Map<number, number> }>();
  let section = 0;
  for (const [index, paragraph] of Array.from(document.getElementsByTagNameNS(NS, 'p')).entries()) {
    let ancestor = paragraph.parentNode,
      deleted = false;
    while (ancestor) {
      if ((ancestor as Element).localName === 'del') deleted = true;
      ancestor = ancestor.parentNode;
    }
    if (deleted) continue;
    const pPr = first(paragraph, 'pPr'),
      numPr = first(pPr, 'numPr');
    // A deleted paragraph mark joins its surviving runs to the following paragraph in Mammoth.
    if (first(first(pPr, 'rPr'), 'del')) continue;
    const currentSection = section;
    if (first(pPr, 'sectPr')) section++;
    const inherited = styleList(prop(pPr, 'pStyle'));
    const numId = prop(numPr, 'numId') ?? inherited.numId;
    if (numId === undefined || numId === '0') continue;
    const levelIndex = Number(prop(numPr, 'ilvl') ?? inherited.level ?? 0);
    const definition = lists.get(numId),
      level = definition?.levels.get(levelIndex);
    const previous = counts.get(numId);
    const restarted = !!(
      previous &&
      definition?.restartAfterBreak &&
      previous.section !== currentSection
    );
    const counters = previous && !restarted ? previous.counters : new Map<number, number>();
    counts.set(numId, { section: currentSection, counters });
    const count = (counters.get(levelIndex) ?? (level?.start ?? 1) - 1) + 1;
    counters.set(levelIndex, count);
    for (const deeper of counters.keys()) {
      const trigger = definition?.levels.get(deeper)?.restart ?? deeper;
      if (deeper > levelIndex && levelIndex < trigger) counters.delete(deeper);
    }
    const marker = `__MW_LIST_${nonce}_${index}__`;
    markers.set(marker, listMarker(numId, levelIndex, definition?.levels, counters, restarted));
    const run = document.createElementNS(NS, 'w:r'),
      text = document.createElementNS(NS, 'w:t');
    text.appendChild(document.createTextNode(marker));
    run.appendChild(text);
    paragraph.appendChild(run);
    // The marker owns the numbering. Mammoth must still read the original runs normally.
    const properties = pPr ?? document.createElementNS(NS, 'w:pPr');
    if (!pPr) paragraph.insertBefore(properties, paragraph.firstChild);
    if (numPr) properties.removeChild(numPr);
    const disabled = document.createElementNS(NS, 'w:numPr'),
      id = document.createElementNS(NS, 'w:numId');
    id.setAttributeNS(NS, 'w:val', '0');
    disabled.appendChild(id);
    properties.appendChild(disabled);
  }
  if (markers.size) zip.file('word/document.xml', new XMLSerializer().serializeToString(document));
  return markers;
}
