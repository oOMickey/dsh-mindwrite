import { equalRanges } from './text-diff.ts';
import { conditionWords, researchTerms, type RiskTerm } from './research-checks.ts';
export type { RiskTerm } from './research-checks.ts';
export type ResearchText = 'body' | 'title';
export interface DiffSpan {
  text: string;
  kind: 'same' | 'removed' | 'added';
  critical: boolean;
  term?: RiskTerm;
}
const quantity = '(?:\\d+(?:\\.\\d+)?|[零一二三四五六七八九十百千万两]+)';
const sensitive = new RegExp(
  `(${quantity}个?(?:工作)?(?:小时|分钟|天|日|月|年|周)(?:以内|内|前|后)?|期限|截止)|(${quantity}(?:[%％]|[ \\u3000]*(?:亿元|万元|元))?)|(${conditionWords.source})`,
  'g',
);
function terms(text: string, research?: ResearchText) {
  const inside = new Uint8Array(text.length + 1);
  const ranges = research
    ? researchTerms(text, research === 'title')
    : [...text.matchAll(sensitive)].map((match) => {
        const start = match.index!,
          end = start + match[0].length;
        const term: RiskTerm = match[1] ? 'deadline' : match[2] ? 'number' : 'condition';
        return { start, end, term };
      });
  for (const { start, end } of ranges) inside.fill(1, start + 1, end);
  return { inside, ranges, cursor: 0 };
}
function diffColumns(merged: DiffSpan[]) {
  return {
    merged,
    before: merged.filter((s) => s.kind !== 'added'),
    after: merged.filter((s) => s.kind !== 'removed'),
  };
}
export function reviewDiff(
  before: string,
  after: string,
  research?: ResearchText,
  paragraphGrant = false,
): ReturnType<typeof diffColumns> {
  // Selected paragraphs are joined by paragraphSelection with one LF. Each ordinal is its
  // own grant, even when identical text moves from one selected paragraph to another.
  if (research && paragraphGrant && before.includes('\n')) {
    const original = before.split('\n'),
      proposed = after.split('\n');
    if (original.length === proposed.length) {
      const merged: DiffSpan[] = [];
      original.forEach((line, i) => {
        if (i) merged.push({ text: '\n', kind: 'same', critical: false });
        for (const span of reviewDiff(line, proposed[i], research).merged) merged.push(span);
      });
      return diffColumns(merged);
    }
  }
  const old = terms(before, research),
    next = terms(after, research);
  const merged: DiffSpan[] = [];
  function append(
    text: string,
    start: number,
    end: number,
    kind: DiffSpan['kind'],
    term?: RiskTerm,
  ) {
    if (end > start)
      merged.push({
        text: text.slice(start, end),
        kind,
        critical: !!term,
        ...(term ? { term } : {}),
      });
  }
  function changed(
    text: string,
    start: number,
    end: number,
    kind: 'removed' | 'added',
    source: ReturnType<typeof terms>,
  ) {
    while (source.cursor < source.ranges.length && source.ranges[source.cursor].end <= start)
      source.cursor++;
    while (source.cursor < source.ranges.length && source.ranges[source.cursor].start < end) {
      const r = source.ranges[source.cursor++];
      append(text, start, r.start, kind);
      append(text, r.start, r.end, kind, r.term);
      start = r.end;
    }
    append(text, start, end, kind);
  }
  let left = 0,
    right = 0;
  for (const range of equalRanges(before, after)) {
    let a = range.before,
      b = range.after,
      length = range.length;
    // Keep whole sensitive terms and Unicode scalar values together.
    while (length && (old.inside[a] || next.inside[b] || /[\uDC00-\uDFFF]/.test(before[a]))) {
      a++;
      b++;
      length--;
    }
    while (
      length &&
      (old.inside[a + length] ||
        next.inside[b + length] ||
        /[\uD800-\uDBFF]/.test(before[a + length - 1]))
    )
      length--;
    if (!length) continue;
    // Skip a short interior match so the next gap emits one complete replacement.
    // At these boundaries a sensitive term is either wholly in the match or wholly outside it.
    if (length <= 4 && (a || b) && (a + length < before.length || b + length < after.length)) {
      const same = before.slice(a, a + length);
      if (
        Array.from(same).length <= 2 &&
        same.search(sensitive) < 0 &&
        !(research && /[\r\n]/u.test(same))
      )
        continue;
    }
    changed(before, left, a, 'removed', old);
    changed(after, right, b, 'added', next);
    append(before, a, a + length, 'same');
    left = a + length;
    right = b + length;
  }
  changed(before, left, before.length, 'removed', old);
  changed(after, right, after.length, 'added', next);
  return diffColumns(merged);
}

function changeGroups(spans: DiffSpan[]) {
  const changes: { spans: DiffSpan[]; paragraph: number }[] = [];
  let run: DiffSpan[] | undefined;
  let paragraph = 0;
  for (const span of spans) {
    if (span.kind === 'same') {
      run = undefined;
      if (/[\r\n]/u.test(span.text)) paragraph++;
      continue;
    }
    if (!run) {
      run = [];
      changes.push({ spans: run, paragraph });
    }
    run.push(span);
  }
  return changes;
}

/** A replacement counts once, even when highlighting splits a term into several spans. */
export function editSummary(spans: DiffSpan[]) {
  const changes = changeGroups(spans);
  const terms = changes.flatMap(({ spans: group }) => {
    const kinds = new Set(group.map((s) => s.term).filter((t): t is RiskTerm => !!t));
    return [...kinds].map((term) => {
      const values = (kind: DiffSpan['kind']) =>
        group
          .filter((s) => s.term === term && s.kind === kind)
          .map((s) => s.text)
          .join('、');
      return { term, before: values('removed'), after: values('added') };
    });
  });
  return { count: changes.length, terms };
}

function comparable(value: string, citation: boolean) {
  const plain = value.normalize('NFKC').replace(/\s+/gu, '').replace(/−/gu, '-');
  if (citation) return plain.replace(/\d+/gu, (n) => n.replace(/^0+(?=\d)/u, ''));
  return plain
    .replace(/\d{1,3}(?:,\d{3})+/gu, (n) => n.replaceAll(',', ''))
    .replace(/\d+(?:\.\d+)?/gu, (n) =>
      n
        .replace(/^0+(?=\d)/u, '')
        .replace(/(\.\d*?)0+$/u, '$1')
        .replace(/\.$/u, ''),
    );
}

/** Pair only terms inside the same changed passage. Citation IDs never pair with measurements. */
export function sourceChecks(spans: DiffSpan[]) {
  const checks: { citation: boolean; before: string; after: string }[] = [];
  // Moving the same value within a paragraph can look like separate deletion/insertion runs.
  // Cancel just those pairs, retaining repeated occurrences and genuine in-place substitutions.
  const removed = new Map<string, number[]>(),
    added = new Map<string, number[]>();
  const moved = new Set<number>();
  for (const { spans: group, paragraph } of changeGroups(spans)) {
    for (const citation of [false, true]) {
      const values = (kind: DiffSpan['kind']) =>
        group
          .filter(
            (s) =>
              s.kind === kind &&
              s.term &&
              s.term !== 'condition' &&
              !(s.term === 'deadline' && /^(?:期限|截止)$/u.test(s.text)) &&
              (s.term === 'citation') === citation,
          )
          .map((s) => s.text);
      const before = values('removed'),
        after = values('added');
      for (let i = 0; i < Math.max(before.length, after.length); i++) {
        const a = before[i] ?? '',
          b = after[i] ?? '';
        if (comparable(a, citation) === comparable(b, citation)) continue;
        if (!a || !b) {
          const key = JSON.stringify([paragraph, citation, comparable(a || b, citation)]);
          const other = (a ? added : removed).get(key)?.pop();
          if (other !== undefined) {
            moved.add(other);
            continue;
          }
          const own = a ? removed : added;
          const indices = own.get(key) ?? [];
          indices.push(checks.length);
          own.set(key, indices);
        }
        checks.push({ citation, before: a, after: b });
      }
    }
  }
  return checks.filter((_, i) => !moved.has(i));
}
