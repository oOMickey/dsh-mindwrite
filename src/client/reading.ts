export interface ReadingAnchor {
  id: string;
  paragraph: number;
  line: number;
}
type ReadingView = 'map' | 'outline' | 'preview';

function lineHeight(p: HTMLElement) {
  return (
    (parseFloat(getComputedStyle(p).lineHeight) * p.getBoundingClientRect().height) / p.offsetHeight
  );
}
function fragments(port: HTMLElement, anchor: ReadingAnchor) {
  return [...port.querySelectorAll<HTMLElement>('article p[data-node-id]')].filter(
    (p) => p.dataset.nodeId === anchor.id && Number(p.dataset.paragraph) === anchor.paragraph,
  );
}
function intersects(rect: DOMRect, area: DOMRect) {
  return (
    rect.bottom > area.top + 1 &&
    rect.top < area.bottom &&
    rect.right > area.left + 1 &&
    rect.left < area.right &&
    rect.bottom > rect.top &&
    rect.right > rect.left
  );
}

export function paragraphAnchor(port: HTMLElement, paragraph: HTMLElement): ReadingAnchor {
  const anchor = {
    id: paragraph.dataset.nodeId!,
    paragraph: Number(paragraph.dataset.paragraph),
    line: 0,
  };
  for (const part of fragments(port, anchor)) {
    if (part === paragraph) break;
    anchor.line += Math.round(part.getBoundingClientRect().height / lineHeight(part));
  }
  const clipped = port.getBoundingClientRect().top - paragraph.getBoundingClientRect().top;
  if (clipped > 0) anchor.line += clipped / lineHeight(paragraph);
  return anchor;
}

/** Prefer visible manuscript content. A viewport containing only headings still has an anchor. */
export function firstArticle(port: HTMLElement, view: ReadingView): ReadingAnchor | undefined {
  const area = port.getBoundingClientRect();
  if (view === 'preview') {
    const paragraphs = port.querySelectorAll<HTMLElement>('article p[data-node-id]');
    let lo = 0,
      hi = paragraphs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (paragraphs[mid].getBoundingClientRect().bottom <= area.top + 1) lo = mid + 1;
      else hi = mid;
    }
    let first: HTMLElement | undefined;
    for (let i = lo; i < paragraphs.length; i++) {
      const p = paragraphs[i],
        rect = p.getBoundingClientRect();
      if (rect.top >= area.bottom) break;
      if (!intersects(rect, area)) continue;
      first ??= p;
      if (p.dataset.readingBody) {
        first = p;
        break;
      }
    }
    if (!first) return;
    return paragraphAnchor(port, first);
  }

  const selector =
    view === 'outline'
      ? '[data-node-id][data-depth], .mw-paragraphs p[data-node-id]'
      : '[data-node-id][data-depth]';
  let first: { id: string; body: boolean; top: number; left: number } | undefined;
  for (const node of port.querySelectorAll<HTMLElement>(selector)) {
    const rect = node.getBoundingClientRect();
    if (!intersects(rect, area) || node.closest?.('[aria-hidden="true"], [inert]')) continue;
    let top = Math.max(rect.top, area.top),
      body = !!node.dataset.readingBody;
    if (view === 'outline') {
      const section = node.closest?.('.mw-chapter-section');
      const header = section?.firstElementChild;
      if (section && header && section.getBoundingClientRect().top < area.top) {
        if (node === header) body = false;
        else top = Math.max(top, header.getBoundingClientRect().bottom);
      }
      if (top >= rect.bottom || top >= area.bottom) continue;
    }
    const left = Math.max(rect.left, area.left);
    if (
      !first ||
      (body && !first.body) ||
      (body === first.body &&
        (top < first.top || (Math.abs(top - first.top) < 1 && left < first.left)))
    ) {
      first = { id: node.dataset.nodeId!, body, top, left };
    }
  }
  if (first) return { id: first.id, paragraph: 0, line: 0 };
}

export function articlePosition(
  port: HTMLElement,
  view: ReadingView,
  anchor: ReadingAnchor,
  showChapterStart = false,
) {
  const area = port.getBoundingClientRect();
  const selector = view === 'preview' ? 'article p[data-node-id]' : '[data-node-id][data-depth]';
  let node = [...port.querySelectorAll<HTMLElement>(selector)].find(
    (n) => n.dataset.nodeId === anchor.id,
  );
  if (!node) return;
  if (view === 'outline' && showChapterStart) {
    const section = node.closest('.mw-chapter-section')?.getBoundingClientRect();
    const end = node.getBoundingClientRect().bottom;
    // Locating an import warning often lands in the first few rows of a chapter.
    // Keep its card intact whenever both the chapter start and the target will fit.
    if (section && end - section.top <= area.height) {
      return {
        left: 0,
        top:
          section.top >= area.top && end <= area.bottom
            ? port.scrollTop
            : port.scrollTop + section.top - area.top,
      };
    }
  }
  let offset = 0;
  if (view === 'preview') {
    let lines = anchor.line;
    for (const part of fragments(port, anchor)) {
      node = part;
      const height = lineHeight(part),
        count = Math.max(1, Math.round(part.getBoundingClientRect().height / height));
      offset = Math.min(lines, count - 0.1) * height;
      if (lines < count) break;
      lines -= count;
    }
  }
  if (view === 'outline' && node.dataset.depth === '1') {
    node = node.closest<HTMLElement>('.mw-chapter-section') ?? node;
  }
  const r = node.getBoundingClientRect();
  let inset = 0;
  if (view === 'outline' && Number(node.dataset.depth) > 1) {
    let chapter =
      node.closest?.('.mw-chapter-section')?.querySelector<HTMLElement>(':scope > .mw-block') ??
      (node.previousElementSibling as HTMLElement | null);
    while (chapter && chapter.dataset.depth !== '1')
      chapter = chapter.previousElementSibling as HTMLElement | null;
    inset = chapter?.offsetHeight ?? 0;
  }
  return {
    // Outline rows animate on entry. Use the final layout position relative to
    // the positioned scrollport and leave room for the selection border.
    top:
      view === 'outline' && node.offsetParent === port
        ? node.offsetTop - inset
        : port.scrollTop + r.top - area.top + offset - inset,
    left: view === 'map' ? port.scrollLeft + r.left - area.left : 0,
  };
}
