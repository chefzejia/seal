import { resolveAddress } from './addresses.js';
import { editableText, replaceVisibleRange } from './visible-surgery.js';
import { assertXmlCharacters, escapeXml, extractFirstParagraphPr, extractFirstRunPr, injectHighlightYellow, parseRowCells, setRunHighlight, xmlElements } from './xml.js';

/** Reuse an ordinary first paragraph; object-bearing paragraphs keep their own line. */
export function fillEmptyCellParagraph(xml: string, run: string): string {
  const elements = xmlElements(xml), root = elements.findIndex(element => element.name === 'w:tc');
  const first = elements.find(element => element.name === 'w:p' && element.parent === root);
  if (first) {
    const paragraph = xml.slice(first.start, first.end);
    const object = /<w:(?:drawing|pict|object|fldChar|fldSimple|sym|footnoteReference|endnoteReference)\b/.test(paragraph);
    if (object) return xml.slice(0, first.end) + `<w:p>${extractFirstParagraphPr(paragraph)}${run}</w:p>` + xml.slice(first.end);
    const filled = first.openEnd === first.end ? paragraph.replace(/\/>$/, `>${run}</w:p>`) : paragraph.slice(0, first.closeStart - first.start) + run + paragraph.slice(first.closeStart - first.start);
    return xml.slice(0, first.start) + filled + xml.slice(first.end);
  }
  const paragraph = `<w:p>${run}</w:p>`;
  if (/<\/w:tc>$/.test(xml)) return xml.replace(/<\/w:tc>$/, `${paragraph}</w:tc>`);
  if (/^<w:tc\b[^>]*\/>$/.test(xml)) return xml.replace(/\/>$/, `>${paragraph}</w:tc>`);
  throw new Error('无法写入单元格，请选择正文中的普通单元格');
}

export interface RowIdentities {
  drawing: number; anchor: number; usedDrawings: Set<number>; usedAnchors: Set<number>;
  names?: Set<string>; markers?: Set<number>;
  copyReference?: (kind: 'comment' | 'footnote' | 'endnote', id: string, identities: RowIdentities) => string;
}

/** Reserve identities before copying a body row or a related story record. */
export function reserveCopiedIdentities(sourceXml: string, identities: RowIdentities): void {
  identities.names ??= new Set(); identities.markers ??= new Set();
  for (const match of sourceXml.matchAll(/\b(?:id|w:name|ObjectID|o:spid)\s*=\s*["']([^"']+)["']/g)) identities.names.add(match[1]);
  for (const match of sourceXml.matchAll(/\bw:id\s*=\s*["'](\d+)["']|<w:id\b[^>]*\bw:val\s*=\s*["'](\d+)["']/g)) identities.markers.add(Number(match[1] ?? match[2]));
  for (const match of sourceXml.matchAll(/<(?:wp:docPr|\w+:cNvPr)\b[^>]*\bid\s*=\s*["'](\d+)["']/g)) identities.usedDrawings.add(Number(match[1]));
  for (const match of sourceXml.matchAll(/\b(?:wp14:(?:anchorId|editId)|w14:(?:paraId|textId))\s*=\s*["']([0-9a-fA-F]{8})["']/g)) identities.usedAnchors.add(Number.parseInt(match[1], 16));
}

/** Keep local cross-references together while assigning fresh copy identities. */
export function remapCopiedIdentities(copy: string, identities: RowIdentities): string {
  const allocate = (kind: 'drawing' | 'anchor', used: Set<number>): number => {
    let value = identities[kind] % 0x100000000;
    while (used.has(value)) value = (value + 1) % 0x100000000;
    used.add(value);
    identities[kind] = value + 1;
    return value;
  };
  const freshName = (old: string): string => {
    let index = 1, name: string;
    do { name = `${old.slice(0, 24)}_Seal_${index++}`; } while (identities.names!.has(name));
    identities.names!.add(name); return name;
  };
  const markerIds = new Map<string, string>(), names = new Map<string, string>(), objects = new Map<string, string>();
  copy = copy.replace(/<w:(?:bookmark|commentRange|perm|moveFromRange|moveToRange|customXmlInsRange|customXmlDelRange|customXmlMoveFromRange|customXmlMoveToRange)(?:Start|End)\b[^>]*>|<w:(?:comment|footnote|endnote)Reference\b[^>]*>/g, tag => {
    const element = /^<([^\s/>]+)/.exec(tag)![1], kind = /comment/.test(element) ? 'comment' : /footnote/.test(element) ? 'footnote' : /endnote/.test(element) ? 'endnote' : element.replace(/(?:Start|End)$/, '');
    return tag.replace(/\bw:id\s*=\s*(["'])([^"']+)\1/, (_attribute, _quote: string, old: string) => {
      const key = `${kind}:${old}`;
      if (!markerIds.has(key)) {
        if (['comment', 'footnote', 'endnote'].includes(kind)) {
          if (!identities.copyReference) throw new Error('复制批注或脚注需要完整文档部件，请使用 editTextDocument');
          markerIds.set(key, identities.copyReference(kind as 'comment' | 'footnote' | 'endnote', old, identities));
        } else {
          let next = Math.max(0, ...identities.markers!) + 1;
          while (identities.markers!.has(next)) next++;
          identities.markers!.add(next); markerIds.set(key, String(next));
        }
      }
      return `w:id="${markerIds.get(key)}"`;
    }).replace(/\bw:name\s*=\s*(["'])([^"']+)\1/, (_attribute, _quote: string, old: string) => { const name = freshName(old); names.set(old, name); return `w:name="${name}"`; });
  });
  copy = copy.replace(/<v:(?:shape|shapetype)\b[^>]*>/g, tag => tag.replace(/\b(id|o:spid)\s*=\s*(["'])([^"']+)\2/g, (_attribute, key: string, _quote: string, old: string) => { const name = objects.get(old) ?? freshName(old); objects.set(old, name); return `${key}="${name}"`; }));
  copy = copy.replace(/\b(w:anchor|ShapeID|type)\s*=\s*(["'])([^"']+)\2/g, (attribute, key: string, _quote: string, old: string) => {
    const name = key === 'w:anchor' ? names.get(old) : objects.get(old.replace(/^#/, ''));
    return name ? `${key}="${old.startsWith('#') ? '#' : ''}${name}"` : attribute;
  });
  copy = copy.replace(/\bObjectID\s*=\s*(["'])([^"']+)\1/g, (_attribute, _quote: string, old: string) => `ObjectID="${freshName(old)}"`);
  copy = copy.replace(/<wp:docPr\b[^>]*>/g, tag => tag.replace(/\bid\s*=\s*(["'])\d+\1/, `id="${allocate('drawing', identities.usedDrawings)}"`));
  copy = copy.replace(/<\w+:cNvPr\b[^>]*>/g, tag => tag.replace(/\bid\s*=\s*(["'])\d+\1/, `id="${allocate('drawing', identities.usedDrawings)}"`));
  copy = copy.replace(/\b(?:wp14:(?:anchorId|editId)|w14:(?:paraId|textId))\s*=\s*(["'])[0-9a-fA-F]{8}\1/g, attribute => `${attribute.slice(0, attribute.indexOf('='))}="${allocate('anchor', identities.usedAnchors).toString(16).padStart(8, '0').toUpperCase()}"`);
  copy = copy.replace(/<w:id\b[^>]*>/g, tag => tag.replace(/\bw:val\s*=\s*(["'])(\d+)\1/, () => {
    const next = Math.max(0, ...identities.markers!) + 1;
    identities.markers!.add(next); return `w:val="${next}"`;
  }));
  return copy;
}

/** Produce row copies while preserving table, row, cell and paragraph formatting. */
export function buildRowCopies(documentXml: string, address: string, values: readonly (readonly string[])[], yellow: boolean, identities: RowIdentities, cellHighlights?: ReadonlyArray<string | null | undefined>): string {
  const row = resolveAddress(documentXml, address);
  if (row.kind !== 'row') throw new Error('插入行需要表格行地址');
  if (!values.length || values.length > 1000) throw new Error('插入行数必须为 1 至 1000');
  const paired = /^(w:(?:bookmark|commentRange|perm|moveFromRange|moveToRange|customXmlInsRange|customXmlDelRange|customXmlMoveFromRange|customXmlMoveToRange))(Start|End)$/;
  const pairs = new Map<string, string[]>();
  for (const element of xmlElements(row.xml)) {
    const match = paired.exec(element.name), id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(row.xml.slice(element.start, element.openEnd))?.[1];
    if (!match || id === undefined) continue;
    const key = `${match[1]}:${id}`, sides = pairs.get(key) ?? [];
    sides.push(match[2]); pairs.set(key, sides);
  }
  if ([...pairs.values()].some(sides => sides.length !== 2 || !sides.includes('Start') || !sides.includes('End'))) throw new Error('模板行含有跨行或损坏的成对标记，请选择包含完整标记范围的行');
  reserveCopiedIdentities(documentXml, identities);
  const cells = parseRowCells(row.xml);
  const output: string[] = [];
  for (const input of values) {
    if (!Array.isArray(input) || input.length !== cells.length || input.some(value => typeof value !== 'string')) throw new Error('每行数据必须与模板单元格数量一致');
    const replacements = cells.map((cell, index) => {
      const value: string = input[index];
      assertXmlCharacters(value);
      const overrideHighlight = cellHighlights?.[index];
      const text = editableText(cell.xml);
      let xml: string;
      if (text) {
        const highlightMode = yellow && !!value ? true : overrideHighlight !== undefined ? overrideHighlight : false;
        xml = replaceVisibleRange(cell.xml, 0, text.length, value, highlightMode);
      } else {
        let properties = extractFirstRunPr(cell.xml);
        if (yellow && value) properties = injectHighlightYellow(properties);
        else if (overrideHighlight !== undefined) properties = setRunHighlight(properties, overrideHighlight);
        const content = value.split(/\r?\n/).map((line, position) => `${position ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join('');
        xml = fillEmptyCellParagraph(cell.xml, `<w:r>${properties}${content}</w:r>`);
      }
      return { start: cell.startOffset, end: cell.endOffset, xml };
    }).sort((a, b) => b.start - a.start);
    let copy = replacements.reduce((result, item) => result.slice(0, item.start) + item.xml + result.slice(item.end), row.xml);
    const copiedElements = xmlElements(copy), sealIds = new Set(copiedElements.flatMap(element => {
      if (element.name !== 'w:bookmarkStart') return [];
      const open = copy.slice(element.start, element.openEnd), name = /\bw:name\s*=\s*["']([^"']+)["']/.exec(open)?.[1];
      const id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(open)?.[1];
      return name?.startsWith('_Seal_') && id ? [id] : [];
    }));
    for (const marker of copiedElements.filter(element => {
      if (element.name !== 'w:bookmarkStart' && element.name !== 'w:bookmarkEnd') return false;
      const id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(copy.slice(element.start, element.openEnd))?.[1];
      return id !== undefined && sealIds.has(id);
    }).reverse()) copy = copy.slice(0, marker.start) + copy.slice(marker.end);
    copy = remapCopiedIdentities(copy, identities);
    output.push(copy);
  }
  return output.join('');
}
