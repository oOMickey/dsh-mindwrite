import type { PaperSpan } from './paper-projection.ts';

/** The React page and DOM measurement probe use exactly the same inline elements. */
export function paperRun(span: PaperSpan) {
  const attrs: Record<string, string> = {};
  let tag: 'ins' | 'del' | 'mark' | 'strong' | undefined;
  if (span.change) {
    tag = span.change === 'added' ? 'ins' : 'del';
    if (span.critical) {
      attrs['data-critical'] = 'true';
      if (span.text.length > 16) attrs['data-long-term'] = 'true';
    }
  } else if (span.referenceBound || span.referenceWarning) {
    tag = 'mark';
    attrs['data-warning'] = String(!!span.referenceWarning);
    if (span.original) attrs.title = '原文：' + span.original;
    else if (span.referenceWarning) attrs.title = '引用需要核对';
  } else if (span.emphasis) tag = 'strong';
  return { tag, attrs };
}
