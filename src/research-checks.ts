import type { flatten, MindNode } from './model.ts';
import { personCounter, isMarkerQuantity, readMarker } from './numbering.ts';

// Keep offsets in the original UTF-16 string for the review diff.
function* proseLines(text: string) {
  let fence = '';
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    const raw = line[0];
    const delimiter = /^ {0,3}(\x60{3,}|~{3,})(.*)$/u.exec(raw);
    if (fence) {
      if (delimiter?.[1].startsWith(fence) && !delimiter[2].trim()) fence = '';
      continue;
    }
    if (delimiter) {
      fence = delimiter[1];
      continue;
    }
    if (/^(?: {4}| {0,3}\t)/u.test(raw)) continue;
    yield {
      raw,
      start: line.index,
      text: raw.replace(/\x60+[^\x60]*\x60+/gu, (s) => '\0'.repeat(s.length)),
    };
  }
}

const entryLabel = /[\[［][ \t]*([0-9０-９]+)[ \t]*[\]］]/u;
const citation = /[\[［][ \t]*([0-9０-９]+(?:[ \t]*[-–—,，、;；][ \t]*[0-9０-９]+)*)[ \t]*[\]］]/gu;
const citationId = (value: string) => value.normalize('NFKC').replace(/^0+(?=\d)/u, '');
const authorYear =
  /[（(][\p{L}][^，,；;（）()\n]{0,60}[，,]\s*(?:19|20)\d{2}[a-z]?[）)]|[\p{L}]{1,60}[ \t]*[（(](?:19|20)\d{2}[a-z]?[）)]/gu;
const listHeading =
  /^(?:参考文献(?:表)?|引用文献|文献(?:表|列表)?|参考资料|资料来源|数据来源|来源(?:表|清单|列表)?|references|bibliography|sources)[:：]?$/iu;
function isSourceHeading(text: string) {
  const title = text.trim().replace(/^#{1,6}\s+/u, '');
  return listHeading.test(title.slice(readMarker(title)?.prefix.length ?? 0).trim());
}
const entryNumber = new RegExp(
  '^(?:' +
    entryLabel.source +
    '|[（(]([0-9０-９]+)[）)]|([0-9０-９]+)[.．、)）](?![0-9０-９]))\\s*\\S',
  'u',
);
const endNumber = new RegExp('\\S\\s*' + entryLabel.source + '[。.]?$', 'u');
function entryId(text: string) {
  const lead = entryNumber.exec(text);
  const number = lead ? (lead[1] ?? lead[2] ?? lead[3]) : endNumber.exec(text)?.[1];
  return number && citationId(number);
}

/** Only an explicitly labelled source entry can establish a numeric target. */
export function citationChecks(rows: ReturnType<typeof flatten>) {
  const entries = new Set<string>();
  const sourceNodes = new Set<MindNode>();
  const checks: { node: MindNode; marker: string; excerpt: string; id?: string }[] = [];
  for (const { node, parent } of rows) {
    const heading = isSourceHeading(node.title);
    const sourceNode = heading || (!!parent && sourceNodes.has(parent));
    if (sourceNode) sourceNodes.add(node);
    if (sourceNode && !heading) {
      const id = entryId(node.title.trim());
      if (id) entries.add(id);
    }
    let inList = sourceNode;
    const seen = new Set<string>();
    for (const { text, raw } of proseLines(node.body)) {
      const line = text.trim();
      if (isSourceHeading(line)) {
        inList = true;
        continue;
      }
      if (/^#{1,6}\s/u.test(line)) inList = sourceNode;
      // Also accept a standalone source declaration outside a separate bibliography node.
      const declaration = /^(?:(?:参考|资料|数据)?来源|sources?)\s*[:：]\s*(.+)$/iu.exec(line);
      if (inList || declaration) {
        const id = entryId(declaration?.[1] ?? line);
        if (id) entries.add(id);
        if (inList || id) continue;
      }
      const years = /[(（]/u.test(text) ? text.matchAll(authorYear) : [];
      for (const match of [...text.matchAll(citation), ...years]) {
        const id = match[1]?.normalize('NFKC').replace(/[ \t]/gu, '');
        const key = id ?? match[0];
        if (seen.has(key)) continue;
        seen.add(key);
        // A long single-paragraph article can have hundreds of markers. Keep the matching context.
        const start = Math.max(0, match.index - 64),
          end = match.index + match[0].length + 64;
        const excerpt =
          (start ? '…' : '') + raw.slice(start, end).trim() + (end < raw.length ? '…' : '');
        checks.push({ node, marker: match[0], excerpt, id });
      }
    }
  }
  // A range uses the consecutive entries actually present, even for very large printed end labels.
  const through = new Map<number, number>();
  if (checks.some((check) => check.id && /[-–—]/u.test(check.id)))
    for (const n of [...entries]
      .map(Number)
      .filter(Number.isSafeInteger)
      .sort((a, b) => b - a))
      through.set(n, through.get(n + 1) ?? n);
  return checks.flatMap((check) => {
    if (!check.id || !entries.size) return [{ ...check, missing: false }];
    for (const part of check.id.split(/[,、;]/u)) {
      const [first, last] = part.split(/[-–—]/u);
      if (last && (!Number.isSafeInteger(+last) || +last < +first))
        return [{ ...check, missing: false }];
      if (!entries.has(citationId(first)) || (last && (through.get(+first) ?? -1) < +last))
        return [{ ...check, missing: true }];
    }
    return [];
  });
}

export const conditionWords =
  /应当|不得|可以|必须|不能|不准|除外|至少|不超过|以内|以下|以上|之前|之后/u;
const space = /[ \t\u3000]*/u.source;
const digits = /[0-9０-９]+/u.source;
const decimal =
  /[+＋−-]?(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)(?:[.．][0-9０-９]+)?/u.source;
const han = /(?<![零〇一二三四五六七八九十百千万亿两])[零〇一二三四五六七八九十百千万亿两]+/u
  .source;
const number = `(?:${decimal}|${han})`;
const timeUnit = /(?:个?(?:工作日|季度|星期|小时|分钟|月)|年|周|天|日|时|分|秒)/u.source;
const units = [
  /个百分点|百分比|[%％‰]|倍|摄氏度|℃|°[CF]/u.source,
  `(?:万亿|[百千万亿])?(?:${personCounter}|户次|美元|欧元|亿元|万元|例|组|个|项|份|次|户|家|件|元|吨|台|册|笔|套|辆|所|天)`,
  /(?:平方|立方)?(?:公里|千米|厘米|毫米|米)|公顷|千克|公斤|毫克|克|毫升|升|万|亿/u.source,
  /(?:[kcmnµμu]?g|[kcmdnµμu]?m[²³]?|m?L|ms|s|k?Wh|people|participants|cases|hours?|days?|weeks?|months?|years?)(?![a-z])/u
    .source,
  timeUnit,
].join('|');
const unit = `(?:${units})(?:${space}[/／]${space}(?:${units}))?`;
const measurementSuffix = new RegExp('^' + unit, 'iu');
const month = `${digits}${space}月(?:${space}${digits}${space}日)?`;
const quarter = `第?${number}${space}季度`;
const isoDate = /[0-9０-９]{4}[-/][0-9０-９]{1,2}(?:[-/][0-9０-９]{1,2})?(?![0-9０-９])/u.source;
const date = `(?:${digits}${space}年(?:${space}(?:${month}|${quarter}))?|${isoDate}|${number}${space}${timeUnit})`;
const value = `(?:${decimal}(?:${space}${unit})?|${han}${space}${unit}|百分之${number})`;
const endpoint = `(?:${date}|${value})`;
const interval = `${endpoint}${space}(?:至|到|[–—~～－-]|to\\b)${space}${endpoint}`;
// Multi-level paths and explicit cross-references are structural even within running text.
const path = `${digits}(?:[.．]${digits})+`;
const section = [
  `(?:第|章节|小节|标题路径|见|section\\s+|§)${space}${path}(?![.．0-9０-９]|${space}${unit})(?:${space}[章节])?`,
  `(?:第${space})?${digits}(?:[.．]${digits})*${space}[章节]`,
  `${digits}(?:[.．]${digits}){2,}`,
].join('|');
const evidence = new RegExp(
  [
    `(?<citation>${citation.source}|${authorYear.source})`,
    `(?<section>${section})`,
    `(?<unitLabel>(?:单位|units?)${space}[:：]${space})(?<unit>${unit})`,
    `(?<interval>${interval})`,
    `(?<date>${date})`,
    value,
    '(?<deadline>期限|截止)',
    `(?<condition>${conditionWords.source})`,
  ].join('|'),
  'giu',
);

export type RiskTerm = 'citation' | 'number' | 'deadline' | 'condition';
export function researchTerms(text: string, title: boolean) {
  const ranges: { start: number; end: number; term: RiskTerm }[] = [];
  for (const line of proseLines(text)) {
    const trimmed = line.text.trimStart();
    const marker = readMarker(trimmed);
    const tail = trimmed.slice(marker?.prefix.length ?? 0);
    const skip =
      marker &&
      (title || marker.family !== 'decimal' || (marker.path.length > 1 && !!tail)) &&
      !isMarkerQuantity(marker.marker, tail) &&
      !measurementSuffix.test(tail)
        ? marker.prefix.length
        : 0;
    const offset = line.start + line.text.length - trimmed.length + skip;
    for (const match of trimmed.slice(skip).matchAll(evidence)) {
      if (match.groups!.section) continue;
      const start = offset + match.index + (match.groups!.unitLabel?.length ?? 0);
      const { citation, date, deadline, condition } = match.groups!;
      const term = citation
        ? 'citation'
        : date || deadline
          ? 'deadline'
          : condition
            ? 'condition'
            : 'number';
      ranges.push({ start, end: offset + match.index + match[0].length, term });
    }
  }
  return ranges;
}
