import JSZip from 'jszip';
import { inflateRawSync } from 'node:zlib';
import { MindError } from './model.ts';

export const DOCX_LIMITS = {
  compressed: 20 * 1024 * 1024,
  expanded: 40 * 1024 * 1024,
  entries: 2048,
  xmlDepth: 96,
};
const invalid = () =>
  new MindError(
    'INVALID_DOCX',
    'Word 文件结构不完整或使用了不支持的压缩方式，请在 Word 中另存为 .docx 后重试',
  );
const limit = () =>
  new MindError('IMPORT_LIMIT', 'Word 文件展开后过大、内容项过多或嵌套过深，请拆分文档后再导入');

/** Scan XML before a DOM parser can allocate a deep tree. Quoted > characters are not tag ends. */
export function assertXmlSafe(xml: string, maxDepth = DOCX_LIMITS.xmlDepth): void {
  // The downstream importers consume UTF-8. Reject UTF-16/binary XML before scanning;
  // interleaved NUL bytes must not hide markup from the depth guard.
  if (
    xml.includes('\0') ||
    xml.includes('\ufffd') ||
    /encoding\s*=\s*["'](?!utf-8|utf8|us-ascii)[^"']+["']/i.test(xml.slice(0, 200))
  )
    throw invalid();
  let depth = 0,
    index = 0;
  while ((index = xml.indexOf('<', index)) >= 0) {
    const special = xml.startsWith('<!--', index)
      ? (['-->', 4] as const)
      : xml.startsWith('<![CDATA[', index)
        ? ([']]>', 9] as const)
        : xml.startsWith('<?', index)
          ? (['?>', 2] as const)
          : null;
    if (special) {
      const end = xml.indexOf(special[0], index + special[1]);
      if (end < 0) throw invalid();
      index = end + special[0].length;
      continue;
    }
    if (xml.startsWith('<!', index)) throw invalid();
    let end = index + 1,
      quote = '';
    for (; end < xml.length; end++) {
      const c = xml[end];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (end === xml.length) throw invalid();
    if (xml[index + 1] === '/') depth--;
    else if (xml[end - 1] !== '/') depth++;
    if (depth > maxDepth) throw limit();
    if (depth < 0) throw invalid();
    index = end + 1;
  }
  if (depth) throw invalid();
}

/** Bound both advertised and actual expansion. Do not trust ZIP size headers or inflate first. */
export function loadSafeDocx(bytes: Buffer, limits = DOCX_LIMITS): JSZip {
  if (bytes.length > limits.compressed) throw limit();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6)) throw invalid();
  const count = bytes.readUInt16LE(eocd + 10),
    start = bytes.readUInt32LE(eocd + 16),
    size = bytes.readUInt32LE(eocd + 12);
  if (count > limits.entries || count === 0xffff) throw limit();
  if (bytes.readUInt16LE(eocd + 8) !== count || start + size !== eocd) throw invalid();
  const zip = new JSZip(),
    names = new Set<string>();
  let cursor = start,
    advertised = 0,
    expanded = 0;
  const entries: { name: string; method: number; size: number; from: number; length: number }[] =
    [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      packed = bytes.readUInt32LE(cursor + 20),
      unpacked = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      local = bytes.readUInt32LE(cursor + 42);
    if (
      cursor + 46 + nameLength + extra + comment > eocd ||
      local + 30 > start ||
      ![0, 8].includes(method) ||
      flags & 1
    )
      throw invalid();
    advertised += unpacked;
    if (advertised > limits.expanded) throw limit();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      name = nameBytes.toString('utf8');
    if (
      !name ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name.includes('\0') ||
      name.split('/').includes('..') ||
      names.has(name)
    )
      throw invalid();
    names.add(name);
    if (
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 6) !== flags
    )
      throw invalid();
    const localName = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28),
      from = local + 30 + localName + localExtra;
    if (
      from + packed > start ||
      !bytes.subarray(local + 30, local + 30 + localName).equals(nameBytes)
    )
      throw invalid();
    entries.push({ name, method, size: unpacked, from, length: packed });
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== eocd) throw invalid();
  for (const entry of entries) {
    const compressed = bytes.subarray(entry.from, entry.from + entry.length);
    let data: Buffer;
    try {
      data =
        entry.method === 0
          ? compressed
          : inflateRawSync(compressed, {
              maxOutputLength: Math.max(
                1,
                Math.min(entry.size + 1, limits.expanded - expanded + 1),
              ),
            });
    } catch {
      throw limit();
    }
    expanded += data.length;
    if (expanded > limits.expanded) throw limit();
    if (data.length !== entry.size) throw invalid();
    if (/\.(?:xml|rels)$/i.test(entry.name)) assertXmlSafe(data.toString('utf8'), limits.xmlDepth);
    if (!entry.name.endsWith('/')) zip.file(entry.name, data);
  }
  if (!zip.file('word/document.xml')) throw invalid();
  return zip;
}
