import type { MindNode } from '../model.ts';
import { type NumberedTitle, matchesImportPrefix, numberedTitles } from '../numbering.ts';
import { naturalParagraphs } from '../paragraphs.ts';
import { mapCountLabel } from '../locales.ts';
import { breakpoints, mapTokens as map, styleTokens } from '../style-tokens.ts';
import type { Arrangement } from './layout.ts';

export interface MapCardSource {
  value: (node: MindNode, field: 'title' | 'body') => string;
  numbers: ReadonlyMap<string, NumberedTitle>;
  language: string;
  legacy?: boolean;
  statuses?: ReadonlyMap<string, string>;
}

export function savedMapSource(root: MindNode): MapCardSource {
  return {
    value: (node, field) => node[field],
    numbers: numberedTitles(root, 'official'),
    language: 'zh',
  };
}

export function nodeTitleParts(
  node: MindNode,
  raw: string,
  heading?: NumberedTitle,
  legacy = false,
) {
  const sourcePrefix = legacy ? '' : (heading?.sourcePrefix ?? '');
  const matches = heading?.importPrefix
    ? matchesImportPrefix(raw, sourcePrefix)
    : raw.startsWith(sourcePrefix);
  const editable = matches ? raw.slice(sourcePrefix.length) : raw;
  return { editable, text: raw === node.title ? (heading?.title ?? raw) : editable };
}

// Estimate just enough glyph advances to choose one or two lines. CSS clamps to that
// same number at the actual font width. No per-card DOM read or dependency on a font file.
export function textWidth(text: string, size: number, limit: number) {
  let width = 0;
  for (const char of text) {
    if (/\p{Mark}/u.test(char) || char === '\u200d') continue;
    const em = /[ .]/.test(char)
      ? map.glyphAdvanceEm.separator
      : /[0-9]/.test(char)
        ? map.glyphAdvanceEm.digit
        : /[ilI,:;'|!]/.test(char)
          ? map.glyphAdvanceEm.narrow
          : /[A-Za-z0-9]/.test(char) && !/[MWmw]/.test(char)
            ? map.glyphAdvanceEm.latin
            : map.glyphAdvanceEm.full;
    width += em * size;
    if (width > limit) break;
  }
  return width;
}

export function childCountLabel(
  children: MindNode[],
  numbers: ReadonlyMap<string, NumberedTitle>,
  language: string,
) {
  const allNumbered = (unit: '章' | '条') =>
    children.every((child) => numbers.get(child.id)?.prefix.trimEnd().endsWith(unit));
  const unit = allNumbered('章')
    ? 'chapters'
    : allNumbered('条')
      ? 'articlesCount'
      : 'sectionsCount';
  return mapCountLabel(language, children.length, unit);
}

export function describeMapCard(
  node: MindNode,
  depth: number,
  width: number,
  viewport: number,
  dense: boolean,
  arrangement: Arrangement,
  source: MapCardSource,
) {
  const card = map.card;
  const { aux, body, chapter, doc } = styleTokens.type;
  const wide = viewport >= breakpoints.wide;
  const down = arrangement === 'down';
  const tight = arrangement === 'right' && viewport < breakpoints.narrow;
  const font = depth === 0 && wide ? doc : depth < 2 ? chapter : body;
  const own = source.value(node, 'body').trim();
  const expandedSummary = wide && !down;
  const excerpt = depth >= 2 || expandedSummary ? own.replace(/\s+/gu, ' ') : '';
  const children = node.children;
  let count = '';
  if (children.length && (node.collapsed || (down && depth === 1))) {
    count = childCountLabel(children, source.numbers, source.language);
  } else if (own && !expandedSummary) {
    count = mapCountLabel(source.language, naturalParagraphs(own).length, 'paragraphCount');
  }

  const compact = dense && depth >= 2;
  const flow =
    down || tight ? 'column' : arrangement === 'right' && wide && compact ? 'inline' : 'heading';
  const padX = tight ? card.tightX : card.padX;
  const padY = compact ? card.denseY : tight ? card.tightY : card.padY;
  const fold = children.length ? (tight ? card.smallFold : card.fold) + card.gap : 0;
  const marks = styleTokens.manuscript.checkSize + styleTokens.icon.size + card.gap;
  const tools = compact && fold ? marks + fold : Math.max(fold, marks);
  const available = Math.max(map.minExtent, width - 2 * (padX + card.border) - tools - card.gap);
  const capsule =
    node.collapsed && children.length ? 2 * (card.border + styleTokens.space.small) : 0;
  const countWidth =
    count && flow !== 'column' ? textWidth(count, aux.size, available) + capsule + card.gap : 0;
  const titleWidth = Math.max(map.minExtent, available - countWidth);
  const heading = source.numbers.get(node.id);
  const prefix = heading?.prefix.trim() ?? '';
  const numberWidth =
    prefix && !tight
      ? Math.min(titleWidth * card.prefixShare, textWidth(prefix, aux.size, titleWidth)) + card.gap
      : 0;
  const title = nodeTitleParts(node, source.value(node, 'title'), heading, source.legacy).text;
  const titleRoom = Math.max(map.minExtent, titleWidth - numberWidth);
  const titleLimit = compact
    ? card.minLines
    : tight && depth === 0
      ? card.narrowRootLines
      : card.maxLines;
  const titleLines = Math.max(
    card.minLines,
    Math.min(
      titleLimit,
      Math.ceil(textWidth(title, font.size, titleRoom * (titleLimit - 1)) / titleRoom),
    ),
  );
  const excerptLines = excerpt
    ? !dense && textWidth(excerpt, aux.size, available) > available
      ? card.maxLines
      : card.minLines
    : 0;
  const titleHeight = titleLines * font.line + (prefix && tight ? aux.line : 0);
  let height = titleHeight;
  if (flow === 'column' && count) height += aux.line + card.gap + (capsule ? 2 * card.border : 0);
  if (flow !== 'column' && capsule) height = Math.max(height, aux.line + 2 * card.border);
  if (flow !== 'inline' && excerptLines) height += excerptLines * aux.line + card.gap;
  if (!down && source.statuses?.has(node.id)) height += aux.line + card.gap;
  const minHeight = tight
    ? map.right.narrowMinHeights[Math.min(depth, 2)]
    : compact
      ? card.denseMinHeight
      : card.minHeight;
  height = Math.max(minHeight, height + 2 * (padY + card.border));
  return { hasBody: !!own, excerpt, count, flow, titleLines, excerptLines, height };
}

export type MapCardContent = ReturnType<typeof describeMapCard>;
