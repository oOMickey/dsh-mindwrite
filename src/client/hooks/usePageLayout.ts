import { printLayout, styleTokens } from '../../style-tokens.ts';
import { useLayoutEffect, useRef, useState } from 'react';
import { margins, type PageStyle } from '../../document-profile.ts';
import { paragraphText } from '../../format.ts';
import { paperRun } from '../paper-run.ts';
import type { PreviewParagraph } from '../paper-projection.ts';

/** Index once per long paragraph. Page probes never copy or re-scan the remaining manuscript. */
function paragraphSlices(p: PreviewParagraph) {
  const offsets = [0];
  for (const char of paragraphText(p)) offsets.push(offsets[offsets.length - 1] + char.length);
  let offset = 0;
  const runs = p.spans.map((span) => {
    const start = offset;
    offset += span.text.length;
    return { span, start, end: offset };
  });
  function slice(from: number, to: number) {
    const start = offsets[from],
      end = offsets[to];
    let lo = 0,
      hi = runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (runs[mid].end <= start) lo = mid + 1;
      else hi = mid;
    }
    const spans: PreviewParagraph['spans'] = [];
    for (let i = lo; i < runs.length && runs[i].start < end; i++) {
      const r = runs[i];
      spans.push({
        ...r.span,
        text: r.span.text.slice(Math.max(0, start - r.start), end - r.start),
      });
    }
    return {
      ...p,
      spans,
      first: from === 0 && p.first,
      badge: from === 0 ? p.badge : undefined,
      versions: from === 0 ? p.versions : undefined,
      indent: from === 0 && p.indent,
      outline: from === 0 ? p.outline : undefined,
    };
  }
  return { slice, length: offsets.length - 1 };
}

/** Measure in the browser's actual fonts, then fit paragraphs into A4 text areas. */
export function usePageLayout(
  paragraphs: PreviewParagraph[],
  fontSize: number,
  enabled = true,
  style: PageStyle = 'official',
) {
  const measurement = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<PreviewParagraph[][]>([]);
  const [scale, setScale] = useState<number>(styleTokens.zoom.actual);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !enabled) return;
    const resize = () =>
      setScale(
        Math.min(
          styleTokens.zoom.actual,
          Math.max(
            styleTokens.zoom.pageMin,
            (element.clientWidth - styleTokens.space.gutter) /
              ((printLayout.widthMm * printLayout.pixelsPerInch) / printLayout.mmPerInch),
          ),
        ),
      );
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, [enabled]);
  useLayoutEffect(() => {
    const holder = measurement.current;
    if (!holder || !enabled) return;
    let alive = true;
    function paginate() {
      if (!holder || !alive) return;
      const templates = [...holder.children] as HTMLElement[];
      const heights = templates.map((p) => p.getBoundingClientRect().height);
      const capacity =
        ((printLayout.heightMm - margins[style].top - margins[style].bottom) *
          printLayout.pixelsPerInch) /
          printLayout.mmPerInch -
        styleTokens.detail.hairline;
      const output: PreviewParagraph[][] = [[]];
      let used = 0;
      const nextPage = () => {
        if (output.at(-1)!.length) output.push([]);
        used = 0;
      };
      paragraphs.forEach((paragraph, index) => {
        let height = heights[index];
        const keepNext =
          ['title', 'chapter'].includes(paragraph.kind) ||
          (style === 'standard' && paragraph.kind === 'heading');
        const followingHeight = heights[index + 1] ?? 0;
        const nextHeight =
          followingHeight > capacity
            ? ((style === 'standard'
                ? printLayout.standard.bodyPt * printLayout.standard.leading
                : printLayout.official.linePt) *
                printLayout.pixelsPerInch) /
              printLayout.pointsPerInch
            : Math.min(followingHeight, Math.max(0, capacity - height));
        if (keepNext && used + height + nextHeight > capacity) nextPage();
        if (height <= capacity) {
          if (used + height > capacity) nextPage();
          output.at(-1)!.push(paragraph);
          used += height;
          return;
        }
        // A paragraph longer than a page is split at a measured text boundary.
        // Continuations have no repeated number or first-line indentation.
        const probe = templates[index].cloneNode(true) as HTMLElement;
        const caption = probe.querySelector('.mw-paper-caption');
        const ink = probe.querySelector('.mw-paper-ink') ?? probe;
        holder!.append(probe);
        const measure = (candidate: PreviewParagraph) => {
          if (caption) {
            if (candidate.badge || (candidate.versions?.length ?? 0) > 1) probe.prepend(caption);
            else caption.remove();
          }
          ink.replaceChildren();
          probe.dataset.indent = String(candidate.indent);
          for (const span of candidate.spans) {
            const { tag, attrs } = paperRun(span);
            if (!tag) {
              ink.append(span.text);
              continue;
            }
            const el = document.createElement(tag);
            for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
            el.textContent = span.text;
            ink.append(el);
          }
          return probe.getBoundingClientRect().height;
        };
        const { slice, length } = paragraphSlices(paragraph);
        let start = 0;
        // Use the measured line density as the first bound, then grow it if the next page is denser.
        const estimate = Math.max(1, Math.ceil((length * capacity) / height));
        while (start < length) {
          if (used && measure(slice(start, start + 1)) > capacity - used) nextPage();
          const available = capacity - used;
          let low = start + 1,
            high = Math.min(length, start + estimate);
          while (high < length && measure(slice(start, high)) <= available) {
            low = high;
            high = Math.min(length, start + 2 * (high - start));
          }
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (measure(slice(start, middle)) <= available) low = middle;
            else high = middle - 1;
          }
          const piece = slice(start, low);
          used += measure(piece);
          output.at(-1)!.push(piece);
          start = low;
          if (start < length) nextPage();
        }
        probe.remove();
      });
      if (viewport.current)
        viewport.current.dataset.pagination = String(
          Number(viewport.current.dataset.pagination ?? 0) + 1,
        );
      setPages(output.filter((page) => page.length));
    }
    paginate();
    // FontFaceSet also fires for a font first requested after initial layout.
    document.fonts.addEventListener('loadingdone', paginate);
    document.fonts.addEventListener('loadingerror', paginate);
    return () => {
      alive = false;
      document.fonts.removeEventListener('loadingdone', paginate);
      document.fonts.removeEventListener('loadingerror', paginate);
    };
  }, [paragraphs, fontSize, enabled, style]);
  return { measurement, viewport, pages, scale };
}
