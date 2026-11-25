import { xmlAttributes } from './outline.js';
import { editableText } from './visible-surgery.js';
import { xmlElements, type XmlElement } from './xml.js';
import { paragraphLayout } from './layout-paragraph.js';

export const CAPTION_HALF_POINTS = 20;
const EMU_PER_TWIP = 635;
export interface LayoutBox { width: number; height: number; }

/** Deterministic safe bounds include container constraints; natural column flow is not inferred. */
export function layoutBox(documentXml: string, position: number, options: { stylesXml?: string; caption?: string; paragraph?: boolean } = {}): LayoutBox {
  const nodes = xmlElements(documentXml);
  const child = (parent: number, name: string) => nodes.findIndex(node => node.parent === parent && node.name === name);
  const attributes = (index: number) => index < 0 ? new Map<string, string>() : xmlAttributes(documentXml, nodes[index]);
  const number = (index: number, key: string, fallback = 0) => {
    const value = Number(attributes(index).get(key));
    return attributes(index).has(key) && Number.isFinite(value) ? value : fallback;
  };
  const sections = nodes.flatMap((node, index) => node.name === 'w:sectPr' && node.parent !== null && ['w:body', 'w:pPr'].includes(nodes[node.parent].name) ? [index] : []);
  const sectionEnd = (index: number) => {
    const parent = nodes[index].parent;
    const paragraph = parent === null ? null : nodes[parent].parent;
    return parent !== null && nodes[parent].name === 'w:pPr' && paragraph !== null ? nodes[paragraph].end : nodes[index].end;
  };
  const section = sections.find(index => sectionEnd(index) > position) ?? -1;
  const size = child(section, 'w:pgSz'), margins = child(section, 'w:pgMar');
  let width = Math.max(1, number(size, 'w:w', 12240) - number(margins, 'w:left', 1440) - number(margins, 'w:right', 1440) - number(margins, 'w:gutter'));
  let pageHeight = Math.max(1, number(size, 'w:h', 15840) - Math.abs(number(margins, 'w:top', 1440)) - Math.abs(number(margins, 'w:bottom', 1440)));
  const cols = child(section, 'w:cols');
  const columnNodes = nodes.flatMap((node, index) => node.parent === cols && node.name === 'w:col' ? [index] : []);
  const count = Math.max(1, Math.floor(number(cols, 'w:num', columnNodes.length || 1)));
  if (count > 1 || columnNodes.length > 1) {
    const unequal = attributes(cols).get('w:equalWidth') === '0' || attributes(cols).get('w:equalWidth') === 'false';
    width = unequal && columnNodes.length ? Math.min(width, Math.max(1, Math.min(...columnNodes.map(index => number(index, 'w:w', width))))) : Math.max(1, (width - number(cols, 'w:space', 720) * (count - 1)) / count);
  }
  const styleXml = options.stylesXml ?? '', styles = styleXml ? xmlElements(styleXml) : [];
  const styleAttributes = (node: XmlElement) => xmlAttributes(styleXml, node);
  const styleById = new Map(styles.flatMap((node, index) => node.name === 'w:style' && styleAttributes(node).get('w:type') === 'table' ? [[styleAttributes(node).get('w:styleId') ?? '', index] as const] : []));
  const defaultStyle = styles.findIndex(node => node.name === 'w:style' && styleAttributes(node).get('w:type') === 'table' && ['1', 'true', 'on'].includes(styleAttributes(node).get('w:default') ?? ''));
  const styleMargins = (index: number, edge: string, seen = new Set<number>()): number | undefined => {
    if (index < 0 || seen.has(index)) return undefined;
    seen.add(index);
    const direct = styles.findIndex(node => node.parent === index && node.name === 'w:tblPr');
    const margin = styles.findIndex(node => node.parent === direct && node.name === 'w:tblCellMar');
    const value = styles.find(node => node.parent === margin && [edge, edge === 'w:left' ? 'w:start' : edge === 'w:right' ? 'w:end' : edge].includes(node.name));
    if (value) {
      const attr = styleAttributes(value), amount = Number(attr.get('w:w'));
      if (attr.get('w:type') === 'nil') return 0;
      if ((!attr.has('w:type') || attr.get('w:type') === 'dxa') && Number.isFinite(amount)) return Math.max(0, amount);
    }
    const based = styles.find(node => node.parent === index && node.name === 'w:basedOn');
    return based ? styleMargins(styleById.get(styleAttributes(based).get('w:val') ?? '') ?? -1, edge, seen) : undefined;
  };
  const cells = nodes.flatMap((node, index) => node.name === 'w:tc' && node.start < position && position < node.end ? [index] : []);
  const cellMargins = (cell: number, edge: string): number => {
    const row = nodes[cell].parent!, table = nodes[row].parent!;
    const properties = child(table, 'w:tblPr'), cellProperties = child(cell, 'w:tcPr');
    const marginValue = (parent: number): number | undefined => {
      const edgeName = `w:${edge}`;
      const edgeIndex = child(parent, edgeName) >= 0 ? child(parent, edgeName) : child(parent, edge === 'left' ? 'w:start' : edge === 'right' ? 'w:end' : edgeName);
      if (edgeIndex < 0) return undefined;
      const type = attributes(edgeIndex).get('w:type');
      return type === 'nil' ? 0 : !type || type === 'dxa' ? Math.max(0, number(edgeIndex, 'w:w')) : undefined;
    };
    const style = styleById.get(attributes(child(properties, 'w:tblStyle')).get('w:val') ?? '') ?? -1;
    return marginValue(child(cellProperties, 'w:tcMar')) ?? marginValue(child(properties, 'w:tblCellMar')) ?? styleMargins(style, `w:${edge}`) ?? styleMargins(defaultStyle, `w:${edge}`) ?? (edge === 'left' || edge === 'right' ? 120 : 0);
  };
  const constraints: Array<{ cell: number; width: number; height: number }> = [];
  const cellContentWidth = (cell: number, outer: number): number => {
    const row = nodes[cell].parent;
    if (row === null) return 0;
    const table = nodes[row].parent;
    if (table === null || nodes[table].name !== 'w:tbl') return 0;
    const properties = child(table, 'w:tblPr'), cellProperties = child(cell, 'w:tcPr');
    const grid = child(table, 'w:tblGrid');
    const gridWidths = nodes.flatMap((node, index) => node.parent === grid && node.name === 'w:gridCol' ? [Math.max(0, number(index, 'w:w'))] : []);
    const total = gridWidths.reduce((sum, value) => sum + value, 0);
    const rowCells = nodes.flatMap((node, index) => node.parent === row && node.name === 'w:tc' ? [index] : []);
    const span = (index: number) => Math.max(1, Math.floor(number(child(child(index, 'w:tcPr'), 'w:gridSpan'), 'w:val', 1)));
    const rowProperties = child(row, 'w:trPr');
    const before = Math.max(0, Math.floor(number(child(rowProperties, 'w:gridBefore'), 'w:val')));
    const after = Math.max(0, Math.floor(number(child(rowProperties, 'w:gridAfter'), 'w:val')));
    const offset = before + rowCells.slice(0, rowCells.indexOf(cell)).reduce((sum, index) => sum + span(index), 0);
    const tableWidth = child(properties, 'w:tblW'), tableType = attributes(tableWidth).get('w:type');
    const declared = number(tableWidth, 'w:w');
    const physicalTableWidth = declared > 0 && tableType === 'dxa' ? declared : declared > 0 && tableType === 'pct' ? outer * declared / 5000 : undefined;
    let cellWidth = total > 0
      ? gridWidths
          .slice(offset, offset + span(cell))
          .reduce((sum, value) => sum + value, 0) *
        (physicalTableWidth === undefined ? 1 : physicalTableWidth / total)
      : outer * span(cell) /
        (before + after + rowCells.reduce((sum, index) => sum + span(index), 0));
    const preferred = child(cellProperties, 'w:tcW'), preferredWidth = number(preferred, 'w:w'), preferredType = attributes(preferred).get('w:type') ?? 'dxa';
    if (preferredWidth > 0 && preferredType === 'dxa') cellWidth = Math.min(cellWidth, preferredWidth);
    if (preferredWidth > 0 && preferredType === 'pct') cellWidth = Math.min(cellWidth, (physicalTableWidth ?? (total || outer)) * preferredWidth / 5000);
    return Math.max(0, Math.min(outer, cellWidth) - cellMargins(cell, 'left') - cellMargins(cell, 'right'));
  };
  for (const cell of cells) {
    width = cellContentWidth(cell, width);
    const rowProperties = child(nodes[cell].parent!, 'w:trPr');
    pageHeight -= cellMargins(cell, 'top') + cellMargins(cell, 'bottom');
    const rowHeight = child(rowProperties, 'w:trHeight');
    if (attributes(rowHeight).get('w:hRule') === 'exact') constraints.push({ cell, width, height: number(rowHeight, 'w:val') - cellMargins(cell, 'top') - cellMargins(cell, 'bottom') });
  }
  const paragraphs = paragraphLayout(documentXml, styleXml);
  const paragraph = nodes.findIndex(node => node.name === 'w:p' && node.start < position && position < node.end);
  if (paragraph >= 0 && options.paragraph !== false) {
    const indent = paragraphs.insets(paragraph);
    width = indent.outside ? 0 : Math.max(0, width - indent.left - indent.right - paragraphs.prefix(paragraph, position));
    if (options.caption === undefined) options = { ...options, caption: editableText(documentXml.slice(nodes[paragraph].start, nodes[paragraph].end)).trimEnd() };
  }
  const reservation = (index: number, outer: number): { height: number; images: number[] } => {
    const node = nodes[index];
    if (node.name === 'w:p') return paragraphs.measure(index, outer);
    if (node.name === 'w:tbl') {
      let height = 0; const images: number[] = [];
      for (const [row, value] of nodes.entries()) {
        if (value.parent !== index || value.name !== 'w:tr') continue;
        const children = nodes.flatMap((item, i) => item.parent === row && item.name === 'w:tc' ? [i] : []);
        const content = children.map(cell => {
          const result = reservation(cell, cellContentWidth(cell, outer));
          return { height: result.height + cellMargins(cell, 'top') + cellMargins(cell, 'bottom'), images: result.images };
        });
        const limit = child(child(row, 'w:trPr'), 'w:trHeight'), exact = attributes(limit).get('w:hRule') === 'exact';
        const minimum = attributes(limit).get('w:hRule') === 'auto' ? 0 : number(limit, 'w:val');
        height += exact ? number(limit, 'w:val') : Math.max(minimum, ...content.map(item => item.height));
        if (!exact) images.push(...content.flatMap(item => item.images));
      }
      return { height, images };
    }
    const children = nodes.flatMap((item, i) => item.parent === index && ['w:p', 'w:tbl', 'w:sdt', 'w:sdtContent'].includes(item.name) ? [i] : []).map(i => reservation(i, outer));
    return { height: children.reduce((sum, item) => sum + item.height, 0), images: children.flatMap(item => item.images) };
  };
  width = Math.max(0, Math.floor(width));
  const glyphs = Math.max(1, Math.floor(width / (CAPTION_HALF_POINTS * 10)));
  const captionLines = options.caption ? options.caption.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).length / glyphs)), 0) : 0;
  const linePitch = Math.max(300, number(child(section, 'w:docGrid'), 'w:linePitch'));
  let height = pageHeight - 360 - (captionLines ? linePitch * (captionLines + 2) : 0);
  if (paragraph >= 0 && options.paragraph !== false && paragraphs.spacing(paragraph).get('w:lineRule') === 'exact') height = Math.min(height, Number(paragraphs.spacing(paragraph).get('w:line') ?? 240) - 120);
  const drawing = nodes.findIndex(node => node.name === 'w:drawing' && node.start <= position && position < node.end);
  for (const constraint of constraints) {
    const reserved = reservation(constraint.cell, constraint.width), free = constraint.height - reserved.height;
    if (drawing >= 0 && !reserved.images.includes(drawing)) { if (free < 0) height = 0; continue; }
    height = Math.min(height, free / Math.max(1, reserved.images.length + (drawing < 0 ? 1 : 0)));
  }
  return { width: width * EMU_PER_TWIP, height: Math.max(0, Math.floor(height)) * EMU_PER_TWIP };
}

/** Final batch structure determines space; only Seal drawings are proportionally reduced. */
export function fitImageLayout(xml: string, stylesXml = ''): string {
  const nodes = xmlElements(xml), replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const drawing of nodes) {
    if (drawing.name !== 'w:drawing') continue;
    const children = nodes.filter(node => node.start >= drawing.start && node.end <= drawing.end);
    const identity = children.find(node => node.name === 'wp:docPr');
    if (!identity || !/^Seal image \d+$/.test(xmlAttributes(xml, identity).get('name') ?? '')) continue;
    const extent = children.find(node => node.name === 'wp:extent');
    if (!extent) continue;
    const attr = xmlAttributes(xml, extent), width = Number(attr.get('cx')), height = Number(attr.get('cy'));
    const box = layoutBox(xml, drawing.start, { stylesXml });
    // An impossible container remains a valid draft with a C16 finding, not a fictitious 1-EMU allowance.
    if (box.width <= 0 || box.height <= 0) continue;
    const scale = Math.min(1, box.width / width, box.height / height);
    if (!(scale > 0 && scale < 1)) continue;
    for (const node of children.filter(node => node.name === 'wp:extent' || node.name === 'a:ext')) {
      const value = xml.slice(node.start, node.end).replace(/\bcx="\d+"/, `cx="${Math.floor(width * scale)}"`).replace(/\bcy="\d+"/, `cy="${Math.floor(height * scale)}"`);
      replacements.push({ start: node.start, end: node.end, value });
    }
  }
  return replacements.sort((a, b) => b.start - a.start).reduce((result, item) => result.slice(0, item.start) + item.value + result.slice(item.end), xml);
}

/** Seal media remains identifiable after review bookmarks are removed. */
export function auditImageLayout(documentXml: string, stylesXml = ''): Array<{ address: string; reason: string; width: number; height: number; available: LayoutBox }> {
  const nodes = xmlElements(documentXml), issues: Array<{ address: string; reason: string; width: number; height: number; available: LayoutBox }> = [];
  for (const [index, drawing] of nodes.entries()) {
    if (drawing.name !== 'w:drawing') continue;
    const contents = nodes.filter(node => drawing.start <= node.start && node.end <= drawing.end);
    const identity = contents.find(node => node.name === 'wp:docPr');
    if (!identity || !/^Seal image \d+$/.test(xmlAttributes(documentXml, identity).get('name') ?? '')) continue;
    const extent = contents.find(node => node.name === 'wp:extent');
    const attributes = extent ? xmlAttributes(documentXml, extent) : new Map<string, string>();
    const width = Number(attributes.get('cx')), height = Number(attributes.get('cy'));
    let paragraph = drawing.parent;
    while (paragraph !== null && nodes[paragraph].name !== 'w:p') paragraph = nodes[paragraph].parent;
    const caption = paragraph === null ? '' : editableText(documentXml.slice(nodes[paragraph].start, nodes[paragraph].end)).trimEnd();
    const available = layoutBox(documentXml, drawing.start, { stylesXml, caption });
    if (width > 0 && height > 0 && width <= available.width && height <= available.height) continue;
    const chain: number[] = [];
    for (let parent: number | null = index; parent !== null; parent = nodes[parent].parent) if (['w:tbl', 'w:tr', 'w:tc', 'w:p'].includes(nodes[parent].name)) chain.unshift(parent);
    const address = chain.map(parent => `${({ 'w:tbl': 't', 'w:tr': 'r', 'w:tc': 'c', 'w:p': 'p' } as Record<string, string>)[nodes[parent].name]}:${nodes.slice(0, parent).filter(node => node.parent === nodes[parent].parent && node.name === nodes[parent].name).length}`).join('/');
    issues.push({ address, reason: 'Seal 图片尺寸超过所在位置的可用版面或尺寸无效', width, height, available });
  }
  return issues;
}
