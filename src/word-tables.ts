import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type JSZip from 'jszip';
import type { InputTable } from './import.ts';
import { MindError } from './model.ts';

const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const children = (e: Element, tag: string) =>
  Array.from(e.childNodes).filter(
    (n) => n.nodeType === 1 && (n as Element).localName === tag,
  ) as Element[];
function acceptedText(e: Element): string {
  function walk(n: Node): string {
    if (n.nodeType !== 1) return '';
    const tag = (n as Element).localName;
    if (tag === 'del') return '';
    if (tag === 't') return n.textContent ?? '';
    if (tag === 'br') return '\n';
    if (tag === 'tab') return '\t';
    return Array.from(n.childNodes).map(walk).join('') + (tag === 'p' ? '\n' : '');
  }
  return walk(e).trim();
}
export function tableText(rows: string[][]): string {
  const header = rows[0];
  return rows
    .slice(1)
    .map((row) => header.map((label, col) => `${label}：${row[col] || '（空）'}`).join('；'))
    .join('\n');
}

/** Replace a table at its exact document position; its marker is attached to the current clause later. */
export async function materializeWordTables(zip: JSZip, markedExport: boolean) {
  const xml = await zip.file('word/document.xml')!.async('string');
  const fail = () => {
    throw new MindError('INVALID_DOCX', 'Word 表格格式无效，请另存文档后重试');
  };
  const doc = new DOMParser({
    errorHandler: { warning: fail, error: fail, fatalError: fail },
  }).parseFromString(xml, 'application/xml');
  const all = Array.from(doc.getElementsByTagNameNS(NS, 'tbl'));
  const markers = new Map<string, InputTable>();
  let index = 0;
  for (const table of all) {
    let parent = table.parentNode,
      nested = false,
      deleted = false;
    while (parent) {
      if ((parent as Element).localName === 'tbl') nested = true;
      if ((parent as Element).localName === 'del') deleted = true;
      parent = parent.parentNode;
    }
    if (nested || deleted) continue;
    const rows = children(table, 'tr')
      .filter(
        (row) => !children(row, 'trPr').some((properties) => children(properties, 'del').length),
      )
      .map((row) => children(row, 'tc').map(acceptedText));
    const columns = Math.max(0, ...rows.map((row) => row.length));
    const complex = ['gridSpan', 'vMerge', 'hMerge', 'drawing', 'pict', 'tbl'].some(
      (tag) => table.getElementsByTagNameNS(NS, tag).length > 0,
    );
    const header = rows[0] ?? [];
    const simple =
      !complex &&
      rows.length > 1 &&
      columns > 0 &&
      rows.every((row) => row.length === columns) &&
      header.every((text) => text.trim() && text.length <= 60) &&
      new Set(header).size === columns;
    const raw = new XMLSerializer().serializeToString(table);
    if (!simple && raw.length > 200000)
      throw new MindError('IMPORT_LIMIT', '复杂表格原文超过写作说明容量，请拆分该表后重新导入');
    const marker = `__MW_TABLE_${crypto.randomUUID().replaceAll('-', '')}__`;
    markers.set(marker, {
      index: ++index,
      rows: rows.length,
      columns,
      count: 1 + table.getElementsByTagNameNS(NS, 'tbl').length,
      method: simple ? 'column-values' : 'original-note',
      // Edits to a marked export must round-trip in cell order. A single
      // data row can be read directly under its headers without repeating them.
      text:
        markedExport && (!simple || rows.length === 2)
          ? rows.map((row) => row.join('　')).join('\n')
          : simple
            ? tableText(rows)
            : '',
      original: simple ? undefined : raw,
      reason: simple
        ? '首行作为列名，逐行保留列名和值'
        : '合并单元格、嵌套或非规则表格不能保真；原始 OOXML 已保存在所属节点写作说明',
    });
    const p = doc.createElementNS(NS, 'w:p'),
      r = doc.createElementNS(NS, 'w:r'),
      t = doc.createElementNS(NS, 'w:t');
    t.appendChild(doc.createTextNode(marker));
    r.appendChild(t);
    p.appendChild(r);
    table.parentNode!.replaceChild(p, table);
  }
  if (markers.size) zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  return markers;
}
