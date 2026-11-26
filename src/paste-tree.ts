import { MindError, type MindNode, type NodeInput, type Operation } from './model.ts';
import { numeral } from './numbering.ts';
import { naturalParagraphs } from './paragraphs.ts';
import { proseLead, sentenceEnd, shortHeading } from './heading-text.ts';

export const pasteTextLimit = 200000;
export const pasteNodeLimit = 1000;

export type PasteCommand =
  | { mode: 'auto'; text: string; copiedTitle?: string }
  | { mode: 'body'; text: string }
  | { mode: 'section'; title: string; text: string }
  | { mode: 'retract' };
export type PasteTarget = { id: string; after?: number };
export interface PasteReceipt {
  group: string;
  kind: 'body' | 'sections';
  count: number;
  text: string;
  introCount: number;
}

export interface PastePreview {
  nodes: NodeInput[];
  count: number;
  warnings: string[];
}

const chapter = new RegExp(`^第${numeral}章\\s*`);
const article = new RegExp(`^第${numeral}[条节]\\s*`);
const chinese = new RegExp(`^${numeral}、\\s*`);
const parenthesized = new RegExp(`^[（(]${numeral}[）)]\\s*`);
const legacyLabel = new RegExp(
  `^(?:第${numeral}[章条]|[（(]${numeral}[）)]|\\d+\\.)\\s+·\\s+(.+)$`,
);
function marker(text: string) {
  const hash = /^(#{1,6})\s+/.exec(text);
  if (hash) return { title: text.slice(hash[0].length), rank: hash[1].length, explicit: true };
  const decimal = /^(\d+(?:\.\d+)+|[1-9]\d*)\s+(?=\S)/.exec(text);
  if (decimal && !/^\d{4}(?:\.|$)/.test(decimal[1]) && !/^\d/.test(text.slice(decimal[0].length)))
    return { title: text.slice(decimal[0].length), rank: decimal[1].split('.').length };
  for (const [pattern, rank] of [
    [chapter, 1],
    [article, 2],
    [chinese, 3],
    [parenthesized, /^[（(]\d/.test(text) ? 6 : 4],
    [/^\d+[.．](?!\d)\s*/, 5],
    [/^[-+*]\s+/, 0],
  ] as const) {
    const match = pattern.exec(text);
    if (match) {
      const tail = text.slice(match[0].length);
      return { title: tail.replace(/^·\s+/, '') || text, rank, explicit: /^·\s+/.test(tail) };
    }
  }
}

function pasteLines(text: string) {
  if (text.length > pasteTextLimit)
    throw new MindError('PASTE_LIMIT', '粘贴文本超过 20 万字，请分段插入');
  return text.replace(/\r\n?/g, '\n').split('\n');
}
function outlineBuilder() {
  const nodes: NodeInput[] = [],
    stack: { node: NodeInput; indent: number; rank: number }[] = [];
  let count = 0;
  return {
    add(node: NodeInput, raw: string, rank: number) {
      if (++count > pasteNodeLimit)
        throw new MindError('PASTE_LIMIT', '一次最多粘贴 1000 个节点，请分批插入');
      const indent = /^\s*/.exec(raw)![0].replace(/\t/g, '    ').replace(/　/g, '  ').length;
      while (stack.length) {
        const top = stack.at(-1)!;
        if (
          indent > top.indent ||
          (indent === top.indent && rank > 0 && top.rank > 0 && rank > top.rank)
        )
          break;
        stack.pop();
      }
      if (stack.length >= 20) throw new MindError('PASTE_LIMIT', '粘贴结构超过 20 层，请减少缩进');
      (stack.at(-1)?.node.children ?? nodes).push(node);
      stack.push({ node, indent, rank });
    },
    nodes,
    get count() {
      return count;
    },
  };
}

/** Explicit outline preview: even an unmarked line is a title here. */
export function parsePaste(text: string): PastePreview {
  const tree = outlineBuilder(),
    warnings: string[] = [];
  for (const [i, raw] of pasteLines(text).entries()) {
    if (!raw.trim()) continue;
    const heading = marker(raw.trim()),
      title = heading?.title ?? raw.trim();
    tree.add(
      { title: title.slice(0, 500), ...(title.length > 500 && { body: title }), children: [] },
      raw,
      heading?.rank ?? 0,
    );
    if (title.length > 500) warnings.push(`第 ${i + 1} 行超过 500 字，完整内容放入正文`);
  }
  if (!tree.count) throw new MindError('PASTE_EMPTY', '剪贴板中没有可建树的文本，请先复制多行提纲');
  return { nodes: tree.nodes, count: tree.count, warnings };
}

function headingOf(raw: string) {
  const line = raw.trim(),
    h = marker(line);
  if (!h || h.title === line || h.title.length > 500) return;
  if (
    !h.explicit &&
    (!shortHeading(h.title) ||
      proseLead.test(h.title) ||
      /^\d+(?:\.\d+)*\s+(?:[万亿千百][元人份]|公里|公斤|小时|人次|[倍吨岁秒%％]|个(?!人)|项(?!目)|[元年月日天份件点人](?:$|\s|已|将|用于|前|后|内|到|参加))/u.test(
        line,
      ))
  )
    return;
  return h;
}

/** Only join a run with two similarly wide lines. Blank lines, headings, indents
 * and sentence endings are paragraph boundaries, even after a verified PDF wrap. */
function cleanLines(lines: string[], joinWrapped = true) {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    const width = line.length;
    const similar = (length: number) => Math.abs(length - width) <= width * 0.22;
    if (joinWrapped && width >= 12 && !headingOf(line)) {
      let previous = line,
        joined = false;
      while (!sentenceEnd.test(previous) && i + 1 < lines.length) {
        const raw = lines[i + 1],
          next = raw.trim();
        if (
          !next ||
          /^\s/.test(raw) ||
          marker(next) ||
          (!similar(next.length) && !(joined && next.length < width && sentenceEnd.test(next)))
        )
          break;
        line += (/\w$/.test(previous) && /^\w/.test(next) ? ' ' : '') + next;
        i++;
        joined = true;
        previous = next;
      }
    }
    result.push(line);
  }
  return result.join('\n');
}

export interface ClassifiedPaste {
  /** Clean original including visible numbers, also used when switching to body. */
  text: string;
  nodes: NodeInput[];
  count: number;
  intro: string;
}
export function cleanPasteText(text: string) {
  return cleanLines(pasteLines(text));
}

/** The optional title comes from the plugin's rich clipboard representation. Its
 * body already has natural paragraphs and can itself contain heading-like lines. */
export function classifyPaste(text: string, copiedTitle?: string): ClassifiedPaste {
  const lines = pasteLines(text);
  // Plain-text-only clipboards carry the node as a Markdown heading and block quote.
  const quoted = /^# (.+)$/.exec(lines[0]);
  const quotedBody = quoted && lines.length > 1 && lines.slice(1).every((l) => /^>( |$)/.test(l));
  const legacy = legacyLabel.exec(lines[0])?.[1];
  const title =
    copiedTitle ||
    (quotedBody && quoted[1]) ||
    (legacy && !lines.slice(1).some((line) => legacyLabel.test(line)) && legacy);
  if (title) {
    if (title.length <= 500) {
      const body = cleanLines(
        lines.slice(1).map((l) => (quotedBody && !copiedTitle ? l.replace(/^> ?/, '') : l)),
        false,
      );
      return {
        text: [lines[0].trim(), body].filter(Boolean).join('\n'),
        nodes: [{ title, body }],
        count: 1,
        intro: '',
      };
    }
  }
  const nonempty = lines.filter((l) => l.trim());
  // Plain-text outlines use nested tabs or spaces. Uniform Word paragraph indents
  // and an isolated short line among messages do not establish a heading level.
  const indentedOutline =
    nonempty.length >= 3 &&
    !/^\s/.test(nonempty[0]) &&
    nonempty.some((l) => /^(?:\t| {2})/.test(l)) &&
    nonempty.every(
      (l) => !marker(l.trim()) && !/^　/.test(l) && shortHeading(l.trim()) && l.trim().length <= 24,
    );
  const tree = outlineBuilder();
  let current: NodeInput | undefined,
    intro = '',
    pending: string[] = [];
  function flush() {
    const body = cleanLines(pending);
    if (current && body) current.body = body;
    else if (!current) intro = body;
    pending = [];
  }
  for (const raw of lines) {
    const heading =
      headingOf(raw) ??
      (indentedOutline && raw.trim() ? { title: raw.trim(), rank: 0 } : undefined);
    if (!heading) {
      pending.push(raw);
      continue;
    }
    flush();
    current = { title: heading.title, children: [] };
    tree.add(current, raw, heading.rank);
  }
  flush();
  return {
    text: tree.count ? cleanLines(lines) : intro,
    nodes: tree.nodes,
    count: tree.count,
    intro: tree.count ? intro : '',
  };
}

/** Splice at a manuscript paragraph boundary, preserving the original field byte for byte. */
export function insertPasteBody(body: string, text: string, after?: number) {
  const separator = /\r\n|\n|\r/.exec(body)?.[0] ?? '\n';
  const incoming = text.replace(/\r\n?|\n/g, separator);
  if (after === 0) return incoming + (body && !/^[\r\n]/.test(body) ? separator : '') + body;
  const end = after === undefined ? body.length : naturalParagraphs(body)[after - 1]?.end;
  if (end === undefined) throw new MindError('CONFLICT', '所选段落已改变，请重新粘贴');
  const before = body.slice(0, end);
  return before + (before && !/[\r\n]$/.test(before) ? separator : '') + incoming + body.slice(end);
}

/** Both writes of a mixed paste share the manuscript transaction and undo entry. */
export function planPaste(
  node: MindNode,
  after: number | undefined,
  command: Exclude<PasteCommand, { mode: 'retract' }>,
) {
  const parsed =
    command.mode === 'auto' ? classifyPaste(command.text, command.copiedTitle) : undefined;
  const text = parsed?.text ?? command.text;
  const nodes =
    command.mode === 'section'
      ? [{ title: command.title, body: text }]
      : node.kind === 'preamble'
        ? []
        : (parsed?.nodes ?? []);
  const count = nodes.length ? (parsed?.count ?? nodes.length) : 0;
  const body = count ? (parsed?.intro ?? '') : text;
  if (!count && !body.trim()) throw new MindError('PASTE_EMPTY', '剪贴板中没有可粘贴的文字');
  const operations: Operation[] = [];
  if (body) {
    const next = insertPasteBody(node.body, body, after);
    if (next.length > pasteTextLimit)
      throw new MindError('PASTE_LIMIT', '加入后正文超过 20 万字，请分段插入其他小节');
    operations.push({ type: 'update', id: node.id, body: next });
  }
  if (count) operations.push({ type: 'add', parentId: node.id, nodes });
  const paragraphs = body ? naturalParagraphs(body).length : 0;
  const receipt: Omit<PasteReceipt, 'group'> = {
    kind: count ? 'sections' : 'body',
    count: count || paragraphs,
    text: command.mode === 'section' && !text.trim() ? command.title : text,
    introCount: count ? paragraphs : 0,
  };
  return { operations, receipt };
}
