import { proseLead, sentenceTitle, shortHeading } from './heading-text.ts';
import type { InputParagraph } from './import.ts';
import type { ImportNumbering, ImportReport } from './metadata.ts';
import { namedImportType, presets, type DocumentType, type Numbering } from './document-profile.ts';
import { flatten, type MindNode } from './model.ts';
import { readMarker, parseNumber, isMarkerQuantity, type ImportMarker } from './numbering.ts';

export interface NativeList {
  numId: string;
  level: number;
  label: string;
  ordinal: number;
  start: number;
  /** The template spells out every decimal ancestor, in order. */
  fullPath?: boolean;
  restarted?: boolean;
  separator?: string;
}

type Evidence =
  | 'document-title'
  | 'explicit-heading'
  | 'native-list'
  | 'native-path'
  | 'official'
  | 'parent-path'
  | 'child-path'
  | 'siblings'
  | 'table'
  | 'literal'
  | 'list'
  | 'plain'
  | 'sentence'
  | 'quantity'
  | 'too-long'
  | 'ambiguous';

export interface ImportParagraphEvidence {
  paragraph: number;
  text: string;
  nodeId: string;
  kind: 'heading' | 'body';
  evidence: Evidence;
  numbering?: ImportMarker;
  /** A marked Word heading run counts as structure, never as a handwritten prefix. */
  numberRun?: string;
  nativeList?: NativeList;
  /** Accepted Word runs, without the automatic label. */
  authorText?: string;
}

export type ImportNumberingWarning = NonNullable<ImportNumbering['warnings']>[number] & {
  code: 'gap' | 'duplicate' | 'out-of-order' | 'ambiguous' | 'mixed-scheme' | 'numbering-conflict';
};
export interface ImportDetection {
  documentType: DocumentType;
  numberingScheme: Numbering;
  typeReason:
    'importTitleName' | 'importFileName' | 'importTopics' | 'importClauses' | 'importGenericType';
  schemeReason: 'importNumberedGroup' | 'importTiedGroups' | 'importPlainHeadings' | 'importPreset';
  votes: number;
}

type Shape = 'short' | 'long' | 'bare' | 'quantity' | 'sentence' | 'too-long';

function titleShape(marker: ImportMarker | undefined, text: string): Shape {
  const tail = text
    .trimStart()
    .slice(marker?.prefix.length ?? 0)
    .trim();
  if (marker && isMarkerQuantity(marker.marker, tail)) return 'quantity';
  if ((tail ? text.trim() : text.trimStart()).length > 500) return 'too-long';
  if (!tail) return 'bare';
  if (
    sentenceTitle(tail) ||
    proseLead.test(tail) ||
    /^(?:这是|例如|比如|["'“‘「『>])|\.\s|\n/u.test(tail)
  )
    return 'sentence';
  return shortHeading(tail) ? 'short' : 'long';
}

interface ClassifiedParagraph extends InputParagraph {
  index: number;
  marker?: ImportMarker;
  authorMarker?: ImportMarker;
  /** A single prefix in the retained title was supplied by both Word and the author. */
  sharedPrefix?: string;
  authorQuantity?: boolean;
  shape?: Shape;
  evidence: Evidence;
  level?: number;
  headingLevel?: number;
  /** Close list items above this parent before attaching the paragraph. */
  parentLevel?: number;
  listBase?: number;
}

function markerValue(label: string) {
  return label
    .replaceAll('（', '(')
    .replaceAll('）', ')')
    .replaceAll('．', '.')
    .replace(/[零〇一二三四五六七八九十百千万亿两]+/gu, (n) => '中' + parseNumber(n));
}

function scan(p: InputParagraph, index: number): ClassifiedParagraph {
  const evidence = p.table ? 'table' : p.literal ? 'literal' : 'plain';
  // A marked inline Word clause can put a number run immediately before another digit.
  const typed =
    evidence === 'plain'
      ? readMarker(p.inlineBody && p.numberRun ? p.numberRun : p.text)
      : undefined;
  let shape = typed && titleShape(typed, p.text);
  const authorMarker = !p.numberRun && shape !== 'quantity' ? typed : undefined;
  const native = p.nativeList;
  if (!native) return { ...p, index, evidence, marker: typed, authorMarker, shape };
  const authorQuantity = !p.numberRun && shape === 'quantity';
  const marker =
    p.inlineBody && typed ? typed : evidence === 'plain' ? readMarker(native.label) : undefined;
  // A quantity belongs to the author's title even when Word puts an automatic label before it.
  if (!typed || shape === 'quantity') shape = titleShape(undefined, p.text);
  const written = authorMarker ?? (p.numberRun ? typed : undefined);
  const same = written && markerValue(written.marker) === markerValue(native.label);
  const separator =
    native.separator ?? (/\d$/u.test(native.label) && p.text && !/^\s/u.test(p.text) ? ' ' : '');
  const sourceLine = same ? p.text : native.label + separator + p.text;
  return {
    ...p,
    index,
    evidence,
    sourceLine,
    marker,
    authorMarker,
    shape,
    ...(same && authorMarker && { sharedPrefix: authorMarker.prefix }),
    ...(authorQuantity && { authorQuantity: true }),
  };
}

function boundedOfficial(p: ClassifiedParagraph) {
  return (
    p.heading ||
    p.inlineBody ||
    p.nativeList ||
    p.shape === 'bare' ||
    p.marker!.prefix !== p.marker!.marker ||
    p.text.trimStart().slice(p.marker!.prefix.length).startsWith('【')
  );
}

function documentTitles(
  rows: ClassifiedParagraph[],
  source: ImportReport['source'],
  firstChapter: number,
) {
  const wordTitle = source === 'docx' ? rows.findIndex((p) => p.heading === 1 && !p.table) : -1;
  const before = rows.slice(0, Math.max(1, firstChapter, wordTitle + 1));
  const first = before[0];
  const groupedH1 =
    source === 'markdown' &&
    first?.heading === 1 &&
    first.marker &&
    first.shape !== 'quantity' &&
    rows
      .slice(1)
      .some(
        (p) =>
          p.heading === 1 && p.marker?.family === first.marker!.family && p.shape !== 'quantity',
      );
  if (!first || groupedH1) return [];
  let title =
    wordTitle >= 0
      ? wordTitle
      : before.findIndex(
          (p) =>
            !p.literal &&
            !p.table &&
            !p.nativeList &&
            (p.heading === 1 || (p.centered && !p.heading)) &&
            p.marker?.family !== 'official',
        );
  if (
    title < 0 &&
    firstChapter > 0 &&
    !first.heading &&
    !first.table &&
    !first.literal &&
    !first.nativeList &&
    !first.marker &&
    first.text.length <= 120 &&
    !/[。；！？]$/u.test(first.text.trim())
  )
    title = 0;
  if (title < 0) return [];
  let end = title + 1;
  while (end < before.length) {
    const p = before[end];
    if (
      p.heading ||
      p.table ||
      p.literal ||
      p.nativeList ||
      p.marker ||
      !(p.centered || /^[（(].{0,80}[）)]$/u.test(p.text.trim()))
    )
      break;
    end++;
  }
  return before.slice(title, end);
}

function bodyShape(shape?: Shape): shape is 'sentence' | 'quantity' | 'too-long' {
  return shape === 'sentence' || shape === 'quantity' || shape === 'too-long';
}

function pathKey(marker: ImportMarker, parent: boolean) {
  if (marker.family !== 'decimal') return marker.family;
  return (parent ? marker.path.slice(0, -1) : marker.path).join('.');
}

/** Look ahead only within the current section. At a given rank a stray child
 * with a different parent path cannot hide the genuine sibling/child behind it. */
function followingEvidence(rows: ClassifiedParagraph[]) {
  const next: (Map<string, boolean> | undefined)[] = [];
  const evidence = new Map<ClassifiedParagraph, { peer: boolean; child: boolean }>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const p = rows[i],
      m = p.marker;
    if (p.evidence === 'document-title') {
      next.length = 0;
      continue;
    }
    if (p.table || (p.literal && !p.headingLevel)) continue;
    if (p.nativeList && !p.headingLevel && (!p.nativeList.fullPath || bodyShape(p.shape))) continue;
    const level = p.headingLevel ?? m?.level;
    if (!level) continue;
    if (m)
      evidence.set(p, {
        peer: next[level]?.get(pathKey(m, true)) === true,
        child: p.nativeList
          ? [p.nativeList.numId, 'hand'].some((source) =>
              next[level + 1]?.has(pathKey(m, false) + '/' + source),
            )
          : next[level + 1]?.has(pathKey(m, false)) === true,
      });
    if (!p.headingLevel && (!m || bodyShape(p.shape) || p.shape === 'long')) continue;
    next.length = level + 1;
    if (level === 1 || p.headingLevel) next[level] = undefined;
    if (m?.level === level && p.shape !== 'quantity') {
      const peers = next[level] ?? new Map<string, boolean>();
      const key = pathKey(m, true);
      peers.set(key, p.shape === 'short' || peers.get(key) === true);
      peers.set(key + '/' + (p.nativeList?.numId ?? 'hand'), true);
      next[level] = peers;
    }
  }
  return evidence;
}

function handwrittenEvidence(
  p: ClassifiedParagraph,
  marker: ImportMarker,
  open: (ClassifiedParagraph | undefined)[],
  following?: { peer: boolean; child: boolean },
): Evidence {
  if (bodyShape(p.shape)) return p.shape;
  const { level } = marker;
  const series = pathKey(marker, true);
  const parent = open[level - 1],
    previous = open[level];
  const parentMarker = parent?.shape !== 'quantity' ? parent?.marker : undefined;
  const peer =
    following?.peer ||
    (previous?.shape === 'short' &&
      previous.marker?.level === level &&
      pathKey(previous.marker, true) === series);
  if (
    parentMarker &&
    parentMarker.level === level - 1 &&
    pathKey(parentMarker, false) === series &&
    (p.shape !== 'long' || peer)
  )
    return 'parent-path';
  if (level === 1 && following?.child && p.shape !== 'long') return 'child-path';
  const listMarker = marker.family === 'heading' && level >= 3;
  if (
    peer &&
    p.shape === 'short' &&
    (level === 1 || (!listMarker && parent?.headingLevel && !parentMarker))
  )
    return 'siblings';
  if (listMarker && !open.some((row) => row?.marker?.family === 'heading')) return 'list';
  return 'ambiguous';
}

/** Return the deepest still-open, matching document ancestor. A missing middle
 * level can be reported without attaching to an unrelated decimal sibling. */
function documentPathParent(
  p: ClassifiedParagraph,
  open: (ClassifiedParagraph | undefined)[],
  childFollows: boolean | undefined,
) {
  const native = p.nativeList,
    marker = p.marker;
  if (!native?.fullPath || marker?.family !== 'decimal' || bodyShape(p.shape)) return;
  if (marker.level === 1) {
    const chapter = open[1];
    if (
      childFollows ||
      (!native.restarted &&
        chapter?.nativeList?.numId === native.numId &&
        chapter.marker?.family === 'decimal' &&
        chapter.marker.level === 1)
    )
      return 0;
  } else {
    for (let level = marker.level - 1; level > 0; level--) {
      const parent = open[level]?.marker;
      if (
        parent?.family === 'decimal' &&
        parent.level === level &&
        parent.path.every((n, i) => n === marker.path[i])
      )
        return level;
    }
  }
}

/** Resolve weak markers against source paragraphs before allocating any manuscript nodes. */
export function classifyImportParagraphs(input: InputParagraph[], source: ImportReport['source']) {
  const rows = input
    .map((p, i) => scan(p, i + 1))
    .filter((p) => p.text.trim() || p.nativeList || (source === 'markdown' && p.literal));
  // An unspaced chapter heading can open an otherwise unstyled chapter/article pair.
  const chapters = new Set<ClassifiedParagraph>();
  let nextMarker: ImportMarker | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const p = rows[i],
      m = p.marker;
    const articleFollows = nextMarker?.family === 'official' && nextMarker.level === 2;
    if (m?.family === 'official' && m.level === 1) {
      const boundary = boundedOfficial(p);
      if (
        p.heading ||
        p.nativeList ||
        (boundary && articleFollows) ||
        (!bodyShape(p.shape) && (boundary || articleFollows))
      )
        chapters.add(p);
    }
    if (p.heading || m) nextMarker = m;
  }
  const titles = documentTitles(
    rows,
    source,
    rows.findIndex((p) => chapters.has(p)),
  );
  for (const p of titles) p.evidence = 'document-title';
  const firstHeading = rows.find((p) => p.heading && p.evidence !== 'document-title')?.heading;
  const base = source === 'docx' || titles.length ? 1 : Math.max(0, (firstHeading ?? 1) - 1);
  for (const p of rows) if (p.heading) p.headingLevel = Math.max(1, p.heading - base);
  const following = followingEvidence(rows);
  // Only document headings enter this stack. Ordinary list items use the active
  // numId and relative rank, so they can never become the base of the next list.
  const open: (ClassifiedParagraph | undefined)[] = [];
  let listId: string | undefined;
  for (const p of rows) {
    if (p.evidence === 'document-title' || p.table) continue;
    let m = p.marker;
    const native = p.nativeList;
    if (native) {
      // A promoted list row is a document ancestor only inside its numbering instance.
      // Keep explicit and handwritten document headings when starting a new list.
      const boundary = open.findIndex(
        (row) =>
          row?.evidence === 'native-path' &&
          (native.restarted || row.nativeList?.numId !== native.numId),
      );
      if (boundary >= 0) open.length = boundary;
    }
    const base = open.findLast((row) => row !== undefined);
    const baseLevel = base?.level ?? 0;
    if (p.listBreak && listId !== undefined) {
      p.parentLevel = baseLevel;
      listId = undefined;
    }
    const inStatute =
      open.findLast((row) => row?.marker && row.shape !== 'quantity')?.marker?.family ===
      'official';
    if (
      (!native || p.inlineBody) &&
      inStatute &&
      m?.family === 'heading' &&
      m.level >= 2 &&
      m.path[0] <= 10000
    ) {
      m = { ...m, family: 'official', level: m.level === 3 ? 4 : 3 };
      p.marker = m;
      if (p.authorMarker) p.authorMarker = m;
    }
    if (native && !p.headingLevel && m?.family !== 'official') {
      const inArticle = base?.marker?.family === 'official' && baseLevel >= 2;
      const parent = inArticle ? undefined : documentPathParent(p, open, following.get(p)?.child);
      if (parent !== undefined) {
        p.evidence = 'native-path';
        p.level = m!.level;
        p.parentLevel = parent;
        open.length = parent + 1;
      } else {
        // In an article, handwritten 款/目 are list items too. A native child
        // can use an open handwritten 款 without counting its depth twice.
        const article = open[2];
        const listBase =
          inArticle &&
          (!base?.headingLevel || base.inlineBody) &&
          article?.marker?.family === 'official' &&
          article.marker.level === 2
            ? 2
            : baseLevel;
        const level = listBase + 1 + native.level;
        const clause = inArticle && level <= 4 && native.ordinal >= 1 && native.ordinal <= 10000;
        if (listBase < baseLevel && open.length > level) open.length = level;
        p.listBase = listBase;
        p.parentLevel =
          listId === native.numId && !native.restarted
            ? level - 1
            : (open.findLast((row) => row !== undefined)?.level ?? 0);
        listId = native.numId;
        if (p.literal) continue;
        if (!clause && (p.shape === 'too-long' || p.shape === 'sentence')) {
          p.evidence = p.shape;
          continue;
        }
        p.evidence = 'native-list';
        p.level = level;
        if (clause) {
          p.marker = {
            family: 'official',
            level,
            marker: native.label,
            prefix: native.label,
            path: [native.ordinal],
          };
        }
        continue;
      }
    }
    if (
      m?.family === 'official' &&
      !inStatute &&
      !(m.level === 1 ? chapters.has(p) : boundedOfficial(p))
    ) {
      p.evidence = bodyShape(p.shape) ? p.shape : 'ambiguous';
      continue;
    }
    if (p.headingLevel) {
      p.level = p.headingLevel;
      p.evidence = 'explicit-heading';
    } else if (m?.family === 'official') {
      p.level = m.level;
      p.evidence = 'official';
    } else if (!native && m) {
      p.evidence = handwrittenEvidence(p, m, open, following.get(p));
      if (p.evidence === 'parent-path' || p.evidence === 'child-path' || p.evidence === 'siblings')
        p.level = m.level;
    }
    if (p.level) {
      if (listId !== undefined && !(p.evidence === 'official' && p.level > 2))
        p.parentLevel ??= baseLevel;
      listId = undefined;
      open.length = p.level + 1;
      open[p.level] = p;
    }
  }
  return rows;
}

/** Topic pairs must come from different structural headings. Repeated copies of one clue do not suffice. */
function hasTopicPair(titles: string[], clues: RegExp[]) {
  const found = new Set<number>();
  for (const title of titles) {
    const matches = clues.flatMap((clue, i) => (clue.test(title) ? [i] : []));
    if (matches.some((i) => [...found].some((previous) => previous !== i))) return true;
    for (const i of matches) found.add(i);
  }
  return false;
}

function importType(
  title: string,
  filename: string,
  headings: string[],
  chapterArticle: boolean,
): Pick<ImportDetection, 'documentType' | 'typeReason'> {
  const named = namedImportType(title);
  if (named) return { documentType: named, typeReason: 'importTitleName' };
  const fileType = namedImportType(filename.replace(/\.(?:md|docx)$/iu, ''));
  if (fileType) return { documentType: fileType, typeReason: 'importFileName' };
  if (hasTopicPair(headings, [/文献综述/u, /研究方法/u]))
    return { documentType: 'thesis', typeReason: 'importTopics' };
  if (hasTopicPair(headings, [/工作进展/u, /主要成效/u, /工作回顾/u]))
    return { documentType: 'report', typeReason: 'importTopics' };
  if (chapterArticle) return { documentType: 'regulation', typeReason: 'importClauses' };
  if (headings.some((s) => /实施步骤|进度安排/u.test(s)))
    return { documentType: 'plan', typeReason: 'importTopics' };
  return { documentType: 'article', typeReason: 'importGenericType' };
}

export function analyzeImportNumbering(
  root: MindNode,
  paragraphs: ImportParagraphEvidence[],
  prefixes: Record<string, string>,
  title: string,
  filename: string,
) {
  const nodes = new Map(flatten(root).map((row) => [row.node.id, row]));
  const warnings: ImportNumberingWarning[] = [];
  const families = new Map<
    ImportMarker['family'],
    { first: ImportParagraphEvidence; votes: number; grouped: boolean }
  >();
  const markers = new Map<string, ImportMarker>();
  const headings: string[] = [];
  let plain = 0,
    chapterArticle = false;
  const sequences = new Map<
    string,
    { last: ImportParagraphEvidence; seen: Map<number, ImportParagraphEvidence>; numId?: string }
  >();
  const duplicates = new Set<number>();
  function warn(
    p: ImportParagraphEvidence,
    code: ImportNumberingWarning['code'],
    related?: ImportParagraphEvidence,
  ) {
    warnings.push({
      paragraph: p.paragraph,
      nodeId: p.nodeId,
      code,
      marker: p.numbering!.marker,
      ...(related && { related: related.numbering!.marker }),
    });
  }
  for (const row of paragraphs) {
    const native = row.nativeList,
      author = row.numbering;
    if (
      native &&
      author &&
      row.kind === 'heading' &&
      markerValue(native.label) !== markerValue(author.marker)
    )
      warnings.push({
        paragraph: row.paragraph,
        nodeId: row.nodeId,
        code: 'numbering-conflict',
        marker: author.marker,
        related: native.label,
      });
    // A relative list has its own sequence. Only document headings vote, once per paragraph.
    if (row.evidence === 'ambiguous' && author) warn(row, 'ambiguous');
    if (row.kind !== 'heading' || row.evidence === 'document-title') continue;
    const entry = nodes.get(row.nodeId)!;
    const m = native
      ? readMarker(native.label)
      : row.numberRun
        ? readMarker(row.numberRun)
        : author;
    // A multilevel Chinese outline may start at the root. A relative list inside
    // a section has a different base and cannot vote for document numbering.
    if (
      row.evidence === 'native-list' &&
      !(
        native &&
        m?.family === 'heading' &&
        m.level === entry.depth &&
        native.level + 1 === entry.depth
      )
    )
      continue;
    // Inline statutory summaries originate in prose and are not document-type clues.
    if (entry.node.titleSource !== 'auto') headings.push(entry.node.title);
    if (!m) {
      if (row.evidence === 'explicit-heading' && !native && !row.numberRun) plain++;
      continue;
    }
    const p = { ...row, numbering: m };
    const family = families.get(m.family) ?? { first: p, votes: 0, grouped: false };
    if (m.family !== 'official' || m.level <= 2) family.votes++;
    families.set(m.family, family);
    const parentId = entry.parent?.id;
    const parent = parentId && markers.get(parentId);
    if (
      parent &&
      parent.family === m.family &&
      parent.level + 1 === m.level &&
      (m.family !== 'decimal' || parent.path.every((n, i) => n === m.path[i]))
    ) {
      family.grouped = true;
      if (m.family === 'official' && m.level === 2) chapterArticle = true;
    }
    markers.set(row.nodeId, m);
    // Article ordinals continue across chapters. Other ordinals restart with their actual parent ID.
    const scope = m.family === 'official' && m.level === 2 ? root.id : parentId;
    const key = [scope, m.family, m.level, m.path.slice(0, -1).join('.')].join('/');
    const n = m.path.at(-1)!;
    let group = sequences.get(key);
    if (!group || native?.restarted || (native && group.numId && native.numId !== group.numId)) {
      group = { last: p, seen: new Map() };
      sequences.set(key, group);
    } else {
      family.grouped = true;
      const prior = group.last.numbering!.path.at(-1)!;
      if (n > prior + 1) warn(p, 'gap', group.last);
      if (n < prior) warn(p, 'out-of-order', group.last);
    }
    const first = group.seen.get(n);
    if (first) {
      if (!duplicates.has(first.paragraph)) {
        warn(first, 'duplicate', p);
        duplicates.add(first.paragraph);
      }
      warn(p, 'duplicate', first);
    } else group.seen.set(n, p);
    group.last = p;
    if (native) group.numId = native.numId;
  }
  const groups = [...families.entries()].filter(([, f]) => f.grouped);
  for (const [, other] of groups.slice(1)) warn(other.first, 'mixed-scheme', groups[0][1].first);
  const type = importType(title, filename, headings, chapterArticle);
  const eligible = groups.filter(([name]) => name !== 'official' || chapterArticle);
  const votes = Math.max(0, ...eligible.map(([, f]) => f.votes));
  const leaders = eligible.filter(([, f]) => f.votes === votes);
  const unnumbered = !families.size && plain >= 2;
  const detection: ImportDetection = {
    ...type,
    numberingScheme:
      leaders.length === 1
        ? leaders[0][0]
        : unnumbered
          ? 'none'
          : presets[type.documentType].scheme,
    schemeReason:
      leaders.length === 1
        ? 'importNumberedGroup'
        : leaders.length > 1
          ? 'importTiedGroups'
          : unnumbered
            ? 'importPlainHeadings'
            : 'importPreset',
    votes: unnumbered ? plain : votes,
  };
  const result: ImportNumbering = {};
  if (Object.keys(prefixes).length) result.prefixes = prefixes;
  if (warnings.length) result.warnings = warnings.sort((a, b) => a.paragraph - b.paragraph);
  return { detection, ...(result.prefixes || result.warnings ? { importNumbering: result } : {}) };
}
