import { sha256Hex } from "./zip.js";

export interface TopLevelBlock {
  kind: "paragraph" | "table" | "sectPr" | "other";
  index: number; // pIdx for paragraph, tIdx for table, -1 for others
  startOffset: number;
  endOffset: number;
  xml: string;
}

export interface ParsedBody {
  prefixXml: string;
  blocks: TopLevelBlock[];
  suffixXml: string;
}

export function extractPlainText(xml: string): string {
  const parts: string[] = [];
  const regex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    parts.push(unescapeXml(m[1]));
  }
  return parts.join("");
}

export function escapeXml(str: string): string {
  assertXmlCharacters(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function assertXmlCharacters(str: string): void {
  for (const character of str) {
    const code = character.codePointAt(0)!;
    if (!(code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) {
      throw new Error(`XML 不允许字符 U+${code.toString(16).toUpperCase()}`);
    }
  }
}

export function unescapeXml(str: string): string {
  assertXmlCharacters(str);
  return str.replace(/&(?:#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);|&/g, entity => {
    const named: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
    if (entity in named) return named[entity];
    if (entity === '&') throw new Error('XML 实体无效');
    const hex = entity.startsWith('&#x');
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    if (!Number.isSafeInteger(code) || code > 0x10ffff || code < 0) throw new Error('XML 实体码点无效');
    const value = String.fromCodePoint(code);
    assertXmlCharacters(value);
    return value;
  });
}

export function normalizeXmlDigest(xml: string): string {
  const normalized = xml
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
  return sha256Hex(normalized);
}

export interface XmlElement { name: string; start: number; openEnd: number; closeStart: number; end: number; parent: number | null }

/** Exact QName nesting determines physical spans; properties never count as their owning element. */
export function xmlElements(xml: string): XmlElement[] {
  const elements: XmlElement[] = [], stack: number[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start === -1) break;
    const special = xml.startsWith("<!--", start) ? "-->" : xml.startsWith("<![CDATA[", start) ? "]]>" : xml.startsWith("<?", start) ? "?>" : null;
    if (special !== null) {
      const close = xml.indexOf(special, start + 2);
      if (close === -1) throw new Error("Malformed XML: unterminated declaration");
      cursor = close + special.length; continue;
    }
    let end = start + 1, quote = "";
    for (; end < xml.length; end++) {
      const character = xml[end];
      if (quote !== "") { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
      else if (character === "<") throw new Error("Malformed XML: nested tag opening");
    }
    if (end === xml.length) throw new Error("Malformed XML: unterminated tag");
    const tag = xml.slice(start, end + 1), match = /^<\/?([A-Za-z_][\w:.-]*)(?=[\s/>])/.exec(tag);
    if (match === null) throw new Error("Malformed XML: invalid element name");
    const name = match[1];
    if (tag.startsWith("</")) {
      const index = stack.pop();
      if (index === undefined || elements[index].name !== name) throw new Error(`Malformed XML: mismatched closing ${name}`);
      elements[index].closeStart = start; elements[index].end = end + 1;
    } else {
      const selfClosing = /\/\s*>$/.test(tag), index = elements.length;
      elements.push({ name, start, openEnd: end + 1, closeStart: end + 1, end: end + 1, parent: stack.length === 0 ? null : stack[stack.length - 1] });
      if (!selfClosing) stack.push(index);
    }
    cursor = end + 1;
  }
  if (stack.length > 0) throw new Error("Malformed XML: unclosed element");
  return elements;
}

/** Build a child-index adjacency list in document order from parsed elements. */
export function elementChildren(elements: readonly XmlElement[]): number[][] {
  const children: number[][] = Array.from({ length: elements.length }, () => []);
  for (let index = 0; index < elements.length; index++) {
    const parent = elements[index].parent;
    if (parent !== null) children[parent].push(index);
  }
  return children;
}

export function parseDocumentBody(documentXml: string): ParsedBody {
  const elements = xmlElements(documentXml);
  const body = elements.find(element => element.name === "w:body");
  if (body === undefined) throw new Error("Invalid word/document.xml: missing <w:body>");
  const bodyIndex = elements.indexOf(body), blocks: TopLevelBlock[] = [];
  let cursor = body.openEnd, pIndex = 0, tableIndex = 0;
  for (const element of elements.filter(element => element.parent === bodyIndex)) {
    if (element.start > cursor) blocks.push({ kind: "other", index: -1, startOffset: cursor - body.openEnd, endOffset: element.start - body.openEnd, xml: documentXml.slice(cursor, element.start) });
    const kind = element.name === "w:p" ? "paragraph" : element.name === "w:tbl" ? "table" : element.name === "w:sectPr" ? "sectPr" : "other";
    blocks.push({ kind, index: kind === "paragraph" ? pIndex++ : kind === "table" ? tableIndex++ : -1, startOffset: element.start - body.openEnd, endOffset: element.end - body.openEnd, xml: documentXml.slice(element.start, element.end) });
    cursor = element.end;
  }
  if (cursor < body.closeStart) blocks.push({ kind: "other", index: -1, startOffset: cursor - body.openEnd, endOffset: body.closeStart - body.openEnd, xml: documentXml.slice(cursor, body.closeStart) });
  return { prefixXml: documentXml.slice(0, body.openEnd), blocks, suffixXml: documentXml.slice(body.closeStart) };
}

export interface TableRowSpan {
  rowIndex: number;
  startOffset: number;
  endOffset: number;
  xml: string;
  cells: TableCellSpan[];
}

export interface TableCellSpan {
  cellIndex: number;
  startOffset: number; // relative to row xml
  endOffset: number;
  xml: string;
}

export function isMergedContinuation(cellXml: string): boolean {
  const properties = /<w:tcPr(?:\s[^>]*)?>[\s\S]*?<\/w:tcPr>/.exec(cellXml)?.[0] ?? '';
  return [...properties.matchAll(/<w:(?:vMerge|hMerge)\b([^>]*)\/?\s*>/g)].some(match => {
    const value = /\bw:val\s*=\s*["']([^"']+)["']/.exec(match[1]);
    return value === null || value[1] !== 'restart';
  });
}

export function repeatMarkerColumn(cells: readonly TableCellSpan[], labels: readonly string[]): number {
  const index = cells.findIndex((cell, column) => !isMergedContinuation(cell.xml) && !/^(?:序号|编号)$/.test((labels[column] ?? '').trim()));
  if (index < 0) throw new Error('重复行没有可见的非序号单元格');
  return index;
}

export function parseTableRows(tableXml: string): TableRowSpan[] {
  const elements = xmlElements(tableXml);
  const outer = elements.findIndex(element => element.name === "w:tbl");
  return elements.filter(element => {
    if (element.name !== "w:tr") return false;
    let parent = element.parent;
    while (parent !== null && elements[parent].name !== "w:tbl") parent = elements[parent].parent;
    return parent === outer;
  }).map((element, rowIndex) => {
    const xml = tableXml.slice(element.start, element.end);
    return { rowIndex, startOffset: element.start, endOffset: element.end, xml, cells: parseRowCells(xml) };
  });
}

export function parseRowCells(rowXml: string): TableCellSpan[] {
  const elements = xmlElements(rowXml);
  const outer = elements.findIndex(element => element.name === "w:tr");
  return elements.filter(element => {
    if (element.name !== "w:tc") return false;
    let parent = element.parent;
    while (parent !== null && elements[parent].name !== "w:tr") parent = elements[parent].parent;
    return parent === outer;
  }).map((element, cellIndex) => ({ cellIndex, startOffset: element.start, endOffset: element.end, xml: rowXml.slice(element.start, element.end) }));
}

export function extractFirstParagraphPr(xml: string): string {
  const m = xml.match(/<w:pPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:pPr>)/);
  return m ? m[0] : "";
}

const STRIPPED_BODY_PPR_TAGS = new Set([
  'w:pageBreakBefore',
  'w:keepNext',
  'w:outlineLvl',
  'w:numPr',
  'w:sectPr',
  'w:pPrChange',
]);

/**
 * Strip non-body structural properties (including section properties and revision metadata)
 * and center/right alignment from an anchor `<w:pPr>` while keeping font/size (`<w:rPr>`),
 * spacing (`<w:spacing>`) and ordinary indentation (`<w:ind>`).
 */
export function sanitizeInsertedBodyParagraphPr(pPrXml: string): string {
  if (!pPrXml || !pPrXml.trim()) return '';
  const elements = xmlElements(pPrXml);
  const root = elements.findIndex(element => element.name === 'w:pPr' && element.parent === null);
  if (root < 0) return '';
  const rootEl = elements[root];
  if (rootEl.openEnd === rootEl.closeStart) return '';
  const parts: string[] = [];
  let cursor = rootEl.openEnd;
  for (const child of elements) {
    if (child.parent !== root) continue;
    parts.push(pPrXml.slice(cursor, child.start));
    cursor = child.end;
    if (STRIPPED_BODY_PPR_TAGS.has(child.name)) continue;
    const tag = pPrXml.slice(child.start, child.openEnd);
    const valMatch = /\bw:val\s*=\s*(["'])([\s\S]*?)\1/.exec(tag);
    const val = valMatch ? unescapeXml(valMatch[2]) : undefined;
    if (child.name === 'w:pStyle' && val !== undefined && (/^(?:Heading|Title|Subtitle|TOC|标题)/i.test(val) || /^[1-9]$/.test(val))) {
      continue;
    }
    if (child.name === 'w:jc' && val !== undefined && /^(?:center|right)$/i.test(val)) {
      parts.push('<w:jc w:val="left"/>');
      continue;
    }
    parts.push(pPrXml.slice(child.start, child.end));
  }
  parts.push(pPrXml.slice(cursor, rootEl.closeStart));
  const inner = parts.join('');
  if (!inner.trim()) return '';
  return pPrXml.slice(rootEl.start, rootEl.openEnd) + inner + pPrXml.slice(rootEl.closeStart, rootEl.end);
}

export function extractFirstRunPr(xml: string): string {
  // Prefer the direct run properties. Parsing the tree avoids stopping at the
  // nested historical <w:rPr> inside <w:rPrChange>.
  try {
    const elements = xmlElements(xml), run = elements.findIndex(element => element.name === 'w:r' && element.parent === null);
    const direct = elements.find(element => element.name === 'w:rPr' && element.parent === run);
    if (direct) return xml.slice(direct.start, direct.end);
    const any = elements.find(element => element.name === 'w:rPr');
    return any ? xml.slice(any.start, any.end) : '';
  } catch {
    return '';
  }
}

export function setRunHighlight(rPrXml: string, highlightXml: string | null): string {
  if (highlightXml === null) {
    if (!rPrXml || /^<w:rPr\b[^>]*\/>$/.test(rPrXml)) return '';
    const elements = xmlElements(rPrXml), root = elements.findIndex(element => element.name === 'w:rPr' && element.parent === null);
    if (root < 0) throw new Error('run 属性无效');
    const highlights = elements.filter(element => element.parent === root && element.name === 'w:highlight');
    if (highlights.length > 1) throw new Error('run 高亮属性不唯一');
    const highlight = highlights[0];
    if (!highlight) return rPrXml;
    const stripped = rPrXml.slice(0, highlight.start) + rPrXml.slice(highlight.end);
    const rootEl = elements[root];
    const inner = stripped.slice(rootEl.openEnd, rootEl.closeStart - (highlight.end - highlight.start));
    return inner.trim() ? stripped : '';
  }
  if (!rPrXml) {
    return `<w:rPr>${highlightXml}</w:rPr>`;
  }
  if (/^<w:rPr\b[^>]*\/>$/.test(rPrXml)) {
    return rPrXml.replace(/\/>$/, `>${highlightXml}</w:rPr>`);
  }
  const elements = xmlElements(rPrXml), root = elements.findIndex(element => element.name === 'w:rPr' && element.parent === null);
  if (root < 0) throw new Error('run 属性无效');
  const highlights = elements.filter(element => element.parent === root && element.name === 'w:highlight');
  if (highlights.length > 1) throw new Error('run 高亮属性不唯一');
  const highlight = highlights[0];
  if (highlight) return rPrXml.slice(0, highlight.start) + highlightXml + rPrXml.slice(highlight.end);
  const history = elements.find(element => element.parent === root && element.name === 'w:rPrChange');
  const position = history?.start ?? elements[root].closeStart;
  return rPrXml.slice(0, position) + highlightXml + rPrXml.slice(position);
}

export function injectHighlightYellow(rPrXml: string): string {
  return setRunHighlight(rPrXml, '<w:highlight w:val="yellow"/>');
}
