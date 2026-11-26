import { MindError } from './model.ts';

export interface NaturalParagraph {
  ordinal: number;
  start: number;
  end: number;
  text: string;
}

export function naturalParagraphs(body: string): NaturalParagraph[] {
  const result: NaturalParagraph[] = [];
  for (const match of body.matchAll(/[^\r\n]+/gu)) {
    if (!match[0].trim()) continue;
    result.push({
      ordinal: result.length + 1,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }
  return result;
}

export interface ParagraphGrant {
  nodeId: string;
  ordinal: number;
  original: string;
}

export function paragraphSelection(body: string, ordinals: number[]) {
  const paragraphs = naturalParagraphs(body);
  return ordinals
    .map((n) => {
      const p = paragraphs[n - 1];
      if (!p) throw new MindError('SCOPE_VIOLATION', '所选自然段已改变，请重新引用。');
      return p.text;
    })
    .join('\n');
}

/** Splice by original ranges so CRLF, whitespace-only lines and all other bytes survive. */
export function replaceParagraphs(body: string, ordinals: number[], replacement: string) {
  const lines = replacement.split('\n'),
    source = naturalParagraphs(body);
  if (lines.length !== ordinals.length || lines.some((line) => !line.trim() || line.includes('\r')))
    throw new MindError(
      'PARAGRAPH_COUNT',
      '自然段数已改变，请保持所选段数，每个自然段写在一行里。',
    );
  const parts: string[] = [];
  let start = 0;
  ordinals.forEach((n, i) => {
    const p = source[n - 1];
    if (!p || p.start < start) throw new MindError('SCOPE_VIOLATION', '段落序号无效，请重新引用。');
    parts.push(body.slice(start, p.start), lines[i]);
    start = p.end;
  });
  parts.push(body.slice(start));
  return parts.join('');
}

export function checkParagraphChange(before: string, after: string, ordinals: number[]) {
  if (naturalParagraphs(before).length !== naturalParagraphs(after).length)
    throw new MindError(
      'PARAGRAPH_COUNT',
      '自然段数已改变，请保持原有段数，同一自然段内的两点写在一行里。',
    );
  if (replaceParagraphs(before, ordinals, paragraphSelection(after, ordinals)) !== after)
    throw new MindError(
      'SCOPE_VIOLATION',
      '改写越出选区。只能改写引用的自然段，同一小节其他段落、空白和分隔符须保持原样。',
    );
}
