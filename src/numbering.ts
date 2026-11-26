import type { TitleNumbering } from './document-profile.ts';
import type { MindNode } from './model.ts';
import type { SourceNumber } from './metadata.ts';

export function chinese(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > 999_999_999_999)
    throw new RangeError('编号须为 0 到 999999999999 之间的整数');
  if (n === 0) return '零';
  const digits = '零一二三四五六七八九';
  const units = ['', '十', '百', '千'];
  function section(value: number): string {
    let text = '',
      zero = false;
    for (let place = 3; place >= 0; place--) {
      const digit = Math.floor(value / 10 ** place) % 10;
      if (digit) {
        if (zero) text += '零';
        text += digits[digit] + units[place];
        zero = false;
      } else if (text) zero = true;
    }
    return text;
  }
  let text = '',
    zero = false;
  for (let group = 2; group >= 0; group--) {
    const value = Math.floor(n / 10000 ** group) % 10000;
    if (value) {
      if (text && (zero || value < 1000)) text += '零';
      text += section(value) + ['', '万', '亿'][group];
      zero = false;
    } else if (text) zero = true;
  }
  // Only a leading 一十 is shortened: 一百一十 must retain its second 一.
  return text.replace(/^一十/, '十');
}
export const numeral = '[零〇一二三四五六七八九十百千万亿两\\d]+';
export function parseNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  let total = 0,
    section = 0,
    digit = 0;
  for (const character of text.replace(/〇/g, '零').replace(/两/g, '二')) {
    const value = digits.indexOf(character);
    if (value >= 0) digit = value;
    else {
      const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 }[character] ?? 0;
      if (unit >= 10000) {
        section += digit;
        total =
          unit === 100000000 ? (total + (section || 1)) * unit : total + (section || 1) * unit;
        section = 0;
      } else {
        // A unit can have an implicit one, including the 十 in archived 一百十.
        section += (digit || 1) * unit;
      }
      digit = 0;
    }
  }
  return total + section + digit;
}
export function titleNumber(title: string): string {
  return (
    /^(?:第[零〇一二三四五六七八九十百千万\d]+[章节条]|[（(][零〇一二三四五六七八九十百\d]+[）)]|[零〇一二三四五六七八九十百]+[、.]|\d+(?:、|[.．](?!\d)))/.exec(
      title,
    )?.[0] ?? ''
  );
}
export function stripNumber(title: string): string {
  return title.slice(titleNumber(title).length).trim();
}
export function headingPrefix(depth: number, ordinal: number) {
  return [`${chinese(ordinal)}、`, `（${chinese(ordinal)}）`, `${ordinal}. `, `（${ordinal}）`][
    Math.min(depth - 1, 3)
  ];
}
function officialUnit(depth: number): SourceNumber['unit'] {
  return depth === 1 ? 'chapter' : depth === 2 ? 'article' : depth === 3 ? 'item' : 'subitem';
}
export function numbering(root: MindNode): Map<string, SourceNumber> {
  const result = new Map<string, SourceNumber>();
  let articles = 0;
  function walk(nodes: MindNode[], depth: number) {
    let ordinal = 0;
    for (const node of nodes) {
      if (node.kind === 'preamble') continue;
      ordinal++;
      const unit = officialUnit(depth);
      result.set(node.id, { unit, number: depth === 2 ? ++articles : ordinal });
      walk(node.children, depth + 1);
    }
  }
  walk(root.children, 1);
  return result;
}
export function numberLabel(value: SourceNumber, arabic = false): string {
  const n = arabic ? String(value.number) : chinese(value.number);
  if (value.unit === 'chapter') return `第${n}章`;
  if (value.unit === 'article') return `第${n}条`;
  return value.unit === 'item' ? `（${n}）` : `${value.number}.`;
}
export interface NumberedTitle {
  id: string;
  depth: number;
  path: number[];
  prefix: string;
  sourcePrefix: string;
  importPrefix?: string;
  title: string;
  heading: string;
  label: string;
  body: string;
  inlineBodyPrefix?: string;
  position?: { path: number[]; article: number };
}

const decimalToken = /^([1-9]\d*(?:\.[1-9]\d*)*)\s+(?=\S)/u;
export const personCounter = /人次|人|位(?!置|移|于)|名(?!称|词)/u.source;
export const quantitySuffix =
  /^(?:[的万亿千百元角年月日天倍吨岁秒人次家台套件份户笔米周折%％‰℃￥¥$]|个(?!人)|项(?!目)|[美欧港澳加新]元|英镑|公里|公斤|公顷|厘米|毫米|平方|立方|小时|分钟|版本|版(?:$|\s))/u;
export interface ImportMarker {
  family: 'decimal' | 'heading' | 'official';
  level: number;
  /** Full decimal path, or the single ordinal printed in a Chinese/official marker. */
  path: number[];
  marker: string;
  /** Author's token and immediately following whitespace, before normalization. */
  prefix: string;
}

const official = new RegExp('^第(' + numeral + ')([章条])', 'u');
const chineseMarker = /^([零〇一二三四五六七八九十百千万亿两]+)、/u;
const parentheses = new RegExp('^[（(](' + numeral + ')[）)]', 'u');
const dottedItem = /^([1-9]\d*)[.．、](?![\d.．])/u;
const decimal = /^[1-9]\d*(?:[.．][1-9]\d*)*(?=[^\S\r\n]|$)/u;

export function readMarker(raw: string): ImportMarker | undefined {
  const text = raw.trimStart();
  const statute = official.exec(text);
  const path = decimal.exec(text);
  const shape =
    statute ?? path ?? chineseMarker.exec(text) ?? parentheses.exec(text) ?? dottedItem.exec(text);
  if (!shape) return;
  const marker = shape[0];
  const numbers = path ? marker.split(/[.．]/u).map(Number) : [parseNumber(shape[1])];
  if (numbers.length > 20 || numbers.some((n) => n < 1 || !Number.isSafeInteger(n))) return;
  if (statute && numbers[0] > 10000) return;
  const family = statute ? 'official' : path ? 'decimal' : 'heading';
  let level = numbers.length;
  if (statute) level = statute[2] === '章' ? 1 : 2;
  else if (!path) {
    if (/^[（(]/u.test(marker)) level = /^\d/u.test(shape[1]) ? 4 : 2;
    else level = /^\d/u.test(marker) ? 3 : 1;
  }
  const space = /^[^\S\r\n]*/u.exec(text.slice(marker.length))![0];
  return { family, level, path: numbers, marker, prefix: marker + space };
}

const personSuffix = new RegExp('^(?:' + personCounter + ')', 'u');

export function isMarkerQuantity(marker: string, tail: string) {
  if (!/^\d/u.test(marker)) return false;
  if (/^\d{4}(?:[.．]|$)/u.test(marker) || quantitySuffix.test(tail) || personSuffix.test(tail))
    return true;
  const nextNumber = /^\d+(?:[.,．，]\d+)*[^\S\r\n]*/u.exec(tail);
  if (!nextNumber) return false;
  // A grouped number is one quantity. A second number with its own unit starts another.
  if (/^\d{1,3}$/u.test(marker) && /^\d{3}(?!\d)/u.test(tail)) return true;
  return !quantitySuffix.test(tail.slice(nextNumber[0].length));
}

/** Compare the entire token and its original separator, including the boundary after a bare number. */
export function matchesImportPrefix(title: string, prefix: string) {
  if (!title.startsWith(prefix)) return false;
  const current = readMarker(title);
  return (
    current?.prefix === prefix &&
    !isMarkerQuantity(current.marker, title.slice(prefix.length).trimStart())
  );
}

const chineseToken = /[零〇一二三四五六七八九十百千万亿两]+/gu;
const punctuation = (token: string) =>
  token.trimEnd().replaceAll('(', '（').replaceAll(')', '）').replaceAll('．', '.');

// Carry the numeral system in the comparison: 第110条 and 第一百十条
// have different forms, while 一百十 and 一百一十 have the same numeric value.
const labelValue = (token: string) =>
  punctuation(token).replace(chineseToken, (n) => '中' + parseNumber(n));
const labelShape = (token: string) => labelValue(token).replace(/\d+/gu, '#');

type Position = { path: number[]; article: number };

function positionPrefix(
  title: string,
  { path, article }: Position,
  numberRun?: string,
  wordLiteral = false,
) {
  const depth = path.length;
  if (!depth) return '';
  const ordinal = path[depth - 1];
  const declared = numberRun && title.startsWith(numberRun) ? numberRun : '';
  const writtenPath = decimalToken.exec(title)?.[0];
  // A coincident section position cannot turn the author's amount into a prefix.
  // An explicitly marked number run still ends at its own Word boundary.
  if (
    wordLiteral &&
    !declared &&
    writtenPath &&
    isMarkerQuantity(writtenPath.trimEnd(), title.slice(writtenPath.length))
  )
    return '';
  const token =
    declared || writtenPath || /^[1-9]\d*(?:\.[1-9]\d*)*$/u.exec(title)?.[0] || titleNumber(title);
  if (!token) return '';
  const official = { unit: officialUnit(depth), number: depth === 2 ? article : ordinal };
  const value = labelValue(token);
  const labels = [
    path.join('.'),
    numberLabel(official),
    numberLabel(official, true),
    headingPrefix(depth, ordinal),
  ];
  if (!labels.some((label) => labelValue(label) === value)) return '';
  return declared || token + /^\s*/u.exec(title.slice(token.length))![0];
}

interface TitlePosition extends Position {
  prefix: string;
  groupPrefix: string;
}

function consistentPrefixes(group: { prefix: string }[]) {
  const form = group.length >= 2 && labelShape(group[0].prefix);
  return form && group.every(({ prefix }) => labelShape(prefix) === form);
}

/** Both import and rendering compare siblings against this same ordered set of positions. */
export function titlePositions(root: MindNode, textOf = (node: MindNode) => node.title) {
  const positions = new Map<MindNode, TitlePosition>();
  let article = 0;
  function visit(node: MindNode, position: TitlePosition) {
    positions.set(node, position);
    let ordinal = 0;
    const children = position.path.length
      ? node.children
      : [
          ...node.children.filter((n) => n.kind === 'preamble'),
          ...node.children.filter((n) => n.kind !== 'preamble'),
        ];
    const siblings = children.map((child) => {
      const numbered = child.kind !== 'preamble';
      const path = [...position.path, numbered ? ++ordinal : 0];
      if (numbered && path.length === 2) article++;
      const pos = { path, article };
      return {
        child,
        ...pos,
        prefix: numbered
          ? positionPrefix(
              textOf(child),
              pos,
              child.wordNumber?.field === 'title' ? child.wordNumber.text : undefined,
              child.wordTitlePrefix === '',
            )
          : '',
      };
    });
    const numbered = siblings.filter((s) => s.child.kind !== 'preamble');
    const consistent = consistentPrefixes(numbered);
    for (const { child, path, article, prefix } of siblings)
      visit(child, { path, article, prefix, groupPrefix: consistent ? prefix : '' });
  }
  visit(root, { path: [], article: 0, prefix: '', groupPrefix: '' });
  // Article labels count across chapters. Decimal paths and other headings keep their local group.
  const articles = [...positions.values()].filter(({ path }) => path.length === 2 && path[1] !== 0);
  const consistent = consistentPrefixes(articles);
  for (const pos of articles)
    if (pos.prefix.trimEnd().endsWith('条')) pos.groupPrefix = consistent ? pos.prefix : '';
  return positions;
}

function fitsHeadingLevel(token: string, depth: number) {
  if (token.startsWith('第')) return depth === (token.endsWith('章') ? 1 : 2);
  if (/^[（(]/u.test(token)) return depth === 2 || depth === 3 || (depth >= 4 && /\d/u.test(token));
  return depth === 1 || (depth >= 3 && /^\d/u.test(token));
}

// Configured manuscripts already use this interpretation for hand-typed, movable numbers.
// It is intentionally isolated from position matching for legacy documents and Word input.
function configuredPrefix(title: string, depth: number, decimalPosition?: string) {
  const quantity =
    /^(?:[的\d万亿千百元角个项年月日天倍人次家台套件份户笔米吨岁周秒%％‰℃￥¥$]|[美欧港澳加新]元|英镑|公里|公斤|公顷|厘米|毫米|平方|立方|小时|分钟)/u;
  const path = decimalToken.exec(title);
  if (path) {
    // A dotted number can move among siblings. A bare integer needs its exact decimal position.
    const number = path[1];
    if (
      number.split('.').length !== depth ||
      (depth === 1 && number !== decimalPosition) ||
      /^\d{4}\./u.test(number) ||
      quantity.test(title.slice(path[0].length))
    )
      return '';
    return path[0];
  }
  const token = titleNumber(title);
  if (!token || !fitsHeadingLevel(token, depth)) return '';
  const rest = title.slice(token.length);
  if (/^\d/u.test(token) && quantity.test(rest.trimStart())) return '';
  return token + /^\s*/u.exec(rest)![0];
}

export function editedTitle(value: string, heading?: NumberedTitle) {
  if (!heading?.sourcePrefix || !value.trim()) return value;
  if (heading.importPrefix) {
    // Pasting the displayed heading back into its editor is also a title edit.
    const text = matchesImportPrefix(value, heading.prefix)
      ? value.slice(heading.prefix.length)
      : value;
    if (text === value && readMarker(value)) return value;
    const original = heading.importPrefix + text;
    return matchesImportPrefix(original, heading.importPrefix) ? original : text || value;
  }
  const pos = heading.position;
  const present = pos
    ? positionPrefix(value, pos)
    : configuredPrefix(value, heading.depth, heading.prefix.trim());
  return present || (pos && value.startsWith(heading.sourcePrefix))
    ? value
    : heading.sourcePrefix + value;
}

export function numberedTitles(root: MindNode, numbering: TitleNumbering, arabic = false) {
  const scheme = typeof numbering === 'string' ? numbering : numbering.scheme;
  const matchPosition = typeof numbering === 'string' || numbering.matchPosition;
  const prefixes = typeof numbering === 'string' ? undefined : numbering.prefixes;
  const result = new Map<string, NumberedTitle>();
  for (const [node, position] of titlePositions(root)) {
    const { path, article } = position;
    const depth = path.length,
      ordinal = path.at(-1) ?? 0;
    const indexed = prefixes && Object.hasOwn(prefixes, node.id) ? prefixes[node.id] : undefined;
    let prefix = '',
      sourcePrefix = '';
    if (depth && node.kind !== 'preamble' && scheme !== 'none') {
      const decimal = path.join('.');
      if (scheme === 'official')
        prefix =
          numberLabel(
            { unit: officialUnit(depth), number: depth === 2 ? article : ordinal },
            arabic,
          ) + (depth <= 2 ? '　' : '');
      else prefix = scheme === 'heading' ? headingPrefix(depth, ordinal) : decimal + ' ';
      if (indexed !== undefined) {
        if (matchesImportPrefix(node.title, indexed)) {
          sourcePrefix = indexed;
        }
      } else {
        const run =
          node.wordNumber?.field === 'title' && node.title.startsWith(node.wordNumber.text)
            ? node.wordNumber.text
            : '';
        const configured = !matchPosition && node.wordTitlePrefix === undefined;
        if (run) sourcePrefix = run;
        else if (configured)
          sourcePrefix = configuredPrefix(
            node.title,
            depth,
            scheme === 'decimal' ? decimal : undefined,
          );
        // A scheme alone is the existing formatter API for an explicitly numbered
        // tree. Document callers pass their profile for sibling inference.
        else if (typeof numbering === 'string' && !/^\d+\s*$/u.test(position.prefix))
          sourcePrefix = position.prefix;
        else sourcePrefix = position.groupPrefix;

        // Compare the author's opening with the output number even when a move
        // changed the position, or a previous export put a number run before it.
        const present = run
          ? positionPrefix(node.title.slice(run.length), position, undefined, true)
          : position.prefix;
        const decimalStart = configured && !run && decimalToken.exec(node.title);
        const configuredQuantity =
          decimalStart &&
          (!decimalStart[1].includes('.') ||
            isMarkerQuantity(decimalStart[1], node.title.slice(decimalStart[0].length)));
        if (
          sourcePrefix === run &&
          present &&
          !configuredQuantity &&
          labelValue(present) === labelValue(prefix)
        )
          sourcePrefix += present;
      }
    }
    // When an unmarked Word clause kept its complete first line, that same
    // line supplies the number in an inline official paragraph.
    const literalClause =
      node.wordNumber?.field === 'body'
        ? node.body.startsWith(node.wordNumber.text)
        : node.wordTitlePrefix === '' && node.sourceNumber && node.sourceText === node.body;
    const bodyNumber = prefix && literalClause ? positionPrefix(node.body, position) : '';
    const title = node.title.slice(sourcePrefix.length);
    if (!title && (indexed || node.wordNumber?.field === 'title')) prefix = prefix.trimEnd();
    result.set(node.id, {
      id: node.id,
      depth,
      path,
      prefix,
      sourcePrefix,
      ...(indexed && sourcePrefix && { importPrefix: indexed }),
      title,
      heading: prefix + title,
      label: prefix ? prefix.trim() + ' · ' + title : title,
      body: node.body,
      ...(bodyNumber &&
        labelValue(bodyNumber) === labelValue(prefix) && { inlineBodyPrefix: bodyNumber }),
      ...(matchPosition && sourcePrefix && { position: { path, article } }),
    });
  }
  return result;
}

export function nodeLabels(root: MindNode, arabic = false): Map<string, string> {
  return new Map([...numberedTitles(root, 'official', arabic)].map(([id, n]) => [id, n.label]));
}
