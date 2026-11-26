export interface EqualRange {
  before: number;
  after: number;
  length: number;
}

/** Bounded Myers diff. On very large rewrites only proven prefix/suffix matches survive. */
export function equalRanges(before: string, after: string): EqualRange[] {
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix])
    prefix++;
  while (
    suffix < Math.min(before.length, after.length) - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  const a = before.slice(prefix, before.length - suffix),
    b = after.slice(prefix, after.length - suffix);
  const result: EqualRange[] = prefix ? [{ before: 0, after: 0, length: prefix }] : [];
  const trace: Map<number, number>[] = [];
  let previous = new Map([[1, 0]]),
    work = 0,
    distance = -1;
  for (let d = 0; d <= Math.min(a.length + b.length, 512); d++) {
    const frontier = new Map<number, number>();
    for (let k = -d; k <= d; k += 2) {
      const down = previous.get(k + 1) ?? -1,
        right = previous.get(k - 1) ?? -1;
      let x = k === -d || (k !== d && right < down) ? down : right + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
        work++;
      }
      frontier.set(k, x);
      work++;
      if (x >= a.length && y >= b.length) {
        distance = d;
        break;
      }
    }
    trace.push(frontier);
    if (distance >= 0 || work > 2_000_000) break;
    previous = frontier;
  }
  if (distance >= 0) {
    let x = a.length,
      y = b.length;
    const matches: EqualRange[] = [];
    for (let d = distance; d >= 0; d--) {
      const prior = d ? trace[d - 1] : new Map([[1, 0]]);
      const k = x - y;
      const down = prior.get(k + 1) ?? -1,
        right = prior.get(k - 1) ?? -1;
      const priorK = k === -d || (k !== d && right < down) ? k + 1 : k - 1;
      const priorX = Math.max(0, prior.get(priorK) ?? 0),
        priorY = priorX - priorK;
      const endX = x;
      while (x > priorX && y > priorY) {
        x--;
        y--;
      }
      if (endX > x) matches.push({ before: prefix + x, after: prefix + y, length: endX - x });
      x = priorX;
      y = Math.max(0, priorY);
    }
    result.push(...matches.reverse());
  }
  if (suffix)
    result.push({ before: before.length - suffix, after: after.length - suffix, length: suffix });
  const merged: EqualRange[] = [];
  for (const range of result) {
    const last = merged.at(-1);
    if (
      last &&
      last.before + last.length === range.before &&
      last.after + last.length === range.after
    )
      last.length += range.length;
    else if (range.length) merged.push(range);
  }
  return merged;
}
