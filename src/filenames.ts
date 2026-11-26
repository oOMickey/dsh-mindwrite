/** A document name, not a path. Strip accidental format suffixes before Windows cleanup. */
// rc.3 writes through .<basename>.<pid>.<uuid>.tmpdir. Reserve 65 bytes
// below the 255-byte component ceiling for that host-owned staging name.
export const MAX_FILENAME_BYTES = 190;
export function truncateUtf8(input: string, bytes: number): string {
  let used = 0,
    result = '';
  const encoder = new TextEncoder();
  for (const character of input) {
    const length = encoder.encode(character).length;
    if (used + length > bytes) break;
    result += character;
    used += length;
  }
  return result;
}
export function cleanFilename(input: string, bytes = MAX_FILENAME_BYTES - 14): string {
  let name = input.trim().replace(/[. ]+$/, '');
  while (/\.(?:导图|mindmap|mindwrite|json)$/i.test(name)) {
    name = name.replace(/\.(?:导图|mindmap|mindwrite|json)$/i, '').replace(/[. ]+$/, '');
  }
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  name = name.replace(/[. ]+$/, '') || '未命名文稿';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) name = '_' + name;
  return truncateUtf8(name, bytes).replace(/[. ]+$/, '') || '未命名';
}

export function isDocumentPath(path: string) {
  return /\.(?:导图|mindwrite)\.json$/i.test(path);
}
export function documentFilename(input: string): string {
  return cleanFilename(input) + '.导图.json';
}

export function exportBasename(title: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const suffix = `_${date}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  // Reserve .docx and the largest collision suffix (-10000), independently of title length.
  const limit = MAX_FILENAME_BYTES - suffix.length - '.docx'.length - '-10000'.length;
  return `${cleanFilename(title.replace(/\.(?:docx|md)$/i, ''), limit)}${suffix}`;
}

/** writeExclusive must create-if-absent atomically, returning false only for an existing name. */
export async function saveUniqueExport(
  title: string,
  extension: 'docx' | 'md',
  writeExclusive: (filename: string) => Promise<boolean>,
  now = new Date(),
): Promise<string> {
  const base = exportBasename(title, now);
  for (let index = 1; index <= 10000; index++) {
    const filename = `${base}${index === 1 ? '' : '-' + index}.${extension}`;
    if (await writeExclusive(filename)) return filename;
  }
  throw new Error('同一分钟导出文件过多，请稍后再试');
}
