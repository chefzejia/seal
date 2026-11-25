import { bodyViewNodes, isEmptyViewCell, viewBlankHints, type BodyViewNode } from './document-view.js';
import { paragraphText } from './visible-text.js';
import { parseDocumentBody, unescapeXml, xmlElements, type XmlElement } from './xml.js';

export interface OutlineSection { title: string; level: number; from: string; to: string; paragraphs: number; tables: number; hints: number; }
export interface WordStyle { id: string; type: string; parent?: string; name?: string; outlineLevel?: number; hidden?: boolean; isDefault: boolean; }
export interface WordStyles { styles: ReadonlyMap<string, WordStyle>; defaultParagraph?: string; defaultCharacter?: string; defaultOutline?: number; defaultHidden: boolean; }

export function xmlAttributes(xml: string, element: XmlElement): Map<string, string> {
  return new Map([...xml.slice(element.start, element.openEnd).matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g)].map(match => [match[1], unescapeXml(match[3])]));
}
const on = (value: string | undefined) => value === undefined || ['1', 'true', 'on'].includes(value);

export function wordStyles(stylesXml = ''): WordStyles {
  const elements = xmlElements(stylesXml), styles = new Map<string, WordStyle>();
  const child = (parent: number, name: string) => elements.findIndex(element => element.parent === parent && element.name === name);
  const value = (index: number) => index < 0 ? undefined : xmlAttributes(stylesXml, elements[index]).get('w:val');
  const level = (index: number) => { const val = value(index); return val !== undefined && /^[0-9]$/.test(val) ? Number(val) : undefined; };
  const root = elements.findIndex(element => element.name === 'w:styles');
  let defaultParagraph: string | undefined, defaultCharacter: string | undefined;
  for (const [index, element] of elements.entries()) {
    if (element.name !== 'w:style' || element.parent !== root) continue;
    const attrs = xmlAttributes(stylesXml, element), id = attrs.get('w:styleId');
    if (!id) continue;
    const pPr = child(index, 'w:pPr'), rPr = child(index, 'w:rPr'), vanish = child(rPr, 'w:vanish');
    const style: WordStyle = { id, type: attrs.get('w:type') ?? 'paragraph', parent: value(child(index, 'w:basedOn')), name: value(child(index, 'w:name')), outlineLevel: level(child(pPr, 'w:outlineLvl')), hidden: vanish < 0 ? undefined : on(value(vanish)), isDefault: ['1', 'true', 'on'].includes(attrs.get('w:default') ?? '') };
    styles.set(id, style);
    if (style.type === 'paragraph' && style.isDefault) defaultParagraph = id;
    if (style.type === 'character' && style.isDefault) defaultCharacter = id;
  }
  const defaults = elements.findIndex(element => element.name === 'w:docDefaults' && element.parent === root);
  const pPr = child(child(defaults, 'w:pPrDefault'), 'w:pPr'), rPr = child(child(defaults, 'w:rPrDefault'), 'w:rPr');
  const vanish = child(rPr, 'w:vanish');
  return { styles, defaultParagraph, defaultCharacter, defaultOutline: level(child(pPr, 'w:outlineLvl')), defaultHidden: vanish >= 0 && on(value(vanish)) };
}

/** A missing or differently typed parent does not participate in OOXML style inheritance. */
export function styleChain(styles: WordStyles, id: string | undefined, type: string): WordStyle[] {
  const result: WordStyle[] = [], seen = new Set<string>();
  while (id) {
    if (seen.has(id)) throw new Error(`样式继承循环：${id}`);
    seen.add(id);
    const style = styles.styles.get(id);
    if (!style || style.type !== type) break;
    result.unshift(style); id = style.parent;
  }
  return result;
}

function headingLevel(chain: readonly WordStyle[], defaults?: number): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    const level = chain[i].outlineLevel;
    if (level !== undefined) return level === 9 ? 0 : level + 1;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const heading = /^(?:heading|标题)\s*([1-9])$/i.exec(chain[i].name ?? chain[i].id);
    if (heading) return Number(heading[1]);
  }
  return defaults !== undefined && defaults !== 9 ? defaults + 1 : 0;
}

export function headingStyles(stylesXml: string): Map<number, string> {
  const styles = wordStyles(stylesXml), byLevel = new Map<number, string>();
  for (const style of styles.styles.values()) {
    if (style.type !== 'paragraph') continue;
    const level = headingLevel(styleChain(styles, style.id, 'paragraph'));
    if (level && !byLevel.has(level)) byLevel.set(level, style.id);
  }
  return byLevel;
}

export function outline(documentXml: string, stylesXml = ''): OutlineSection[] {
  const styles = wordStyles(stylesXml), nodes = bodyViewNodes(documentXml);
  const blocks = parseDocumentBody(documentXml).blocks.filter(block => block.kind === 'paragraph' || block.kind === 'table');
  const headings = blocks.flatMap((block, index) => {
    if (block.kind !== 'paragraph') return [];
    const elements = xmlElements(block.xml), p = elements.findIndex(element => element.name === 'w:p');
    const property = elements.findIndex(element => element.parent === p && element.name === 'w:pPr');
    const explicit = elements.find(element => element.parent === property && element.name === 'w:outlineLvl');
    const style = elements.find(element => element.parent === property && element.name === 'w:pStyle');
    const explicitLevel = explicit ? xmlAttributes(block.xml, explicit).get('w:val') : undefined;
    const styleId = style ? xmlAttributes(block.xml, style).get('w:val') : styles.defaultParagraph;
    let level: number;
    if (explicit) level = explicitLevel !== undefined && /^[0-8]$/.test(explicitLevel) ? Number(explicitLevel) + 1 : 0;
    else {
      level = headingLevel(styleChain(styles, styleId, 'paragraph'), styles.defaultOutline);
      if (!level && !styles.styles.has(styleId ?? '')) {
        const heading = /^(?:heading|标题)\s*([1-9])$/i.exec(styleId ?? '');
        if (heading) level = Number(heading[1]);
      }
    }
    return level ? [{ index, level, title: paragraphText(block.xml) }] : [];
  });
  const address = (index: number) => `${blocks[index].kind === 'paragraph' ? 'p' : 't'}:${blocks[index].index}`;
  const count = (selected: readonly BodyViewNode[]): { paragraphs: number; tables: number; hints: number } => {
    const counts = { paragraphs: 0, tables: 0, hints: 0 };
    for (const node of selected) {
      if (node.kind === 'paragraph') { counts.paragraphs++; counts.hints += viewBlankHints(node.address, paragraphText(node.xml), node.xml).length; }
      if (node.kind === 'table') counts.tables++;
      if (isEmptyViewCell(node)) counts.hints++;
      if (!node.continuation) {
        const child = count(node.children);
        counts.paragraphs += child.paragraphs; counts.tables += child.tables; counts.hints += child.hints;
      }
    }
    return counts;
  };
  const ends = headings.map(() => blocks.length - 1), open: number[] = [];
  for (const [index, heading] of headings.entries()) {
    while (open.length && headings[open[open.length - 1]].level >= heading.level) ends[open.pop()!] = heading.index - 1;
    open.push(index);
  }
  return headings.map((heading, index) => {
    const end = ends[index];
    return { title: heading.title, level: heading.level, from: address(heading.index), to: address(end), ...count(nodes.slice(heading.index, end + 1)) };
  });
}
