/** Plain text keeps the displayed numbering. The companion HTML carries the author's title
 * independently of that number, even when the body starts with another apparent heading. */
export async function copyNodeText(
  label: string,
  title: string,
  body: string,
  plainHeading = title,
) {
  const text = [label, body].filter(Boolean).join('\n');
  const section = document.createElement('section');
  section.dataset.mindwriteTitle = title;
  const heading = document.createElement('strong');
  heading.textContent = label;
  section.append(heading);
  for (const line of body.split(/\r\n?|\n/)) section.append(document.createElement('br'), line);
  const html = section.outerHTML;
  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {
      /* Some desktop renderers expose only plain text. */
    }
  }
  // Native copy can carry both representations on WebViews without async ClipboardItem.
  function copy(e: ClipboardEvent) {
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', html);
  }
  document.addEventListener('copy', copy);
  try {
    if (document.execCommand?.('copy')) return;
  } finally {
    document.removeEventListener('copy', copy);
  }
  await navigator.clipboard.writeText(
    '# ' +
      plainHeading +
      (body
        ? '\n' +
          body
            .split(/\r\n?|\n/)
            .map((line) => '> ' + line)
            .join('\n')
        : ''),
  );
}

export function copiedNodeTitle(data: DataTransfer, plain: string) {
  const html = data.getData('text/html');
  if (!html.includes('data-mindwrite-title')) return;
  const fragment = document.createElement('template');
  fragment.innerHTML = html;
  const section = fragment.content.querySelector('section[data-mindwrite-title]');
  const heading = section?.firstElementChild;
  if (heading?.tagName !== 'STRONG' || heading.textContent !== plain.split(/[\r\n]/, 1)[0]) return;
  const title = section?.getAttribute('data-mindwrite-title');
  if (title && title.length <= 500) return title;
}
