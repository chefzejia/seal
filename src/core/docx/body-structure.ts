import { isMergedContinuation, xmlElements } from './xml.js';

export interface BodyViewNode {
  address: string;
  kind: 'paragraph' | 'table' | 'row' | 'cell';
  xml: string;
  start: number;
  end: number;
  continuation: boolean;
  children: BodyViewNode[];
}
/** Addressed structure is separate from the compatibility flat text API. */
export function bodyViewNodes(documentXml: string): BodyViewNode[] {
  const elements = xmlElements(documentXml), children = elements.map(() => [] as number[]);
  for (const [index, element] of elements.entries()) if (element.parent !== null) children[element.parent].push(index);
  const body = elements.findIndex(element => element.name === 'w:body');
  if (body < 0) throw new Error('Word 正文不存在');
  const kinds = { 'w:p': 'paragraph', 'w:tbl': 'table', 'w:tr': 'row', 'w:tc': 'cell' } as const;
  const codes = { paragraph: 'p', table: 't', row: 'r', cell: 'c' };
  const visit = (parent: number, prefix: string, allowed: readonly string[]): BodyViewNode[] => {
    const counts = new Map<string, number>();
    return children[parent].filter(index => allowed.includes(elements[index].name)).map(index => {
      const element = elements[index], kind = kinds[element.name as keyof typeof kinds], count = counts.get(kind) ?? 0;
      counts.set(kind, count + 1);
      const address = `${prefix}${codes[kind]}:${count}`, xml = documentXml.slice(element.start, element.end);
      return { address, kind, xml, start: element.start, end: element.end, continuation: kind === 'cell' && isMergedContinuation(xml), children: visit(index, `${address}/`, kind === 'table' ? ['w:tr'] : kind === 'row' ? ['w:tc'] : kind === 'cell' ? ['w:p', 'w:tbl'] : []) };
    });
  };
  return visit(body, '', ['w:p', 'w:tbl']);
}

/** Locations shared by comparison and the public view. Only explicitly addressed nodes are editable. */
export function bodyLocations(xml: string): Map<number, string> {
  const nodes = bodyViewNodes(xml), locations = new Map<number, string>(), allParagraphs = new Set<number>();
  const suppressed: Array<{ start: number; end: number }> = [];
  const visit = (selected: readonly BodyViewNode[], visible: boolean) => {
    for (const node of selected) {
      if (node.kind === 'paragraph') allParagraphs.add(node.start);
      if (node.continuation) suppressed.push(node);
      if (visible) locations.set(node.start, node.address);
      visit(node.children, visible && !node.continuation);
    }
  };
  visit(nodes, true);
  const elements = xmlElements(xml), branches = new Map<number, { prefix: string; choice?: number; fallback?: number }>();
  for (const [index, element] of elements.entries()) {
    const match = /^([^:]+):AlternateContent$/.exec(element.name);
    if (match) branches.set(index, { prefix: match[1] });
    const parent = element.parent === null ? undefined : branches.get(element.parent);
    if (parent && element.name === `${parent.prefix}:Choice` && parent.choice === undefined) parent.choice = index;
    if (parent && element.name === `${parent.prefix}:Fallback` && parent.fallback === undefined) parent.fallback = index;
  }
  let ordinal = 0;
  for (const [index, element] of elements.entries()) {
    if (element.name !== 'w:p' || allParagraphs.has(element.start) || suppressed.some(span => element.start >= span.start && element.end <= span.end)) continue;
    let parent = element.parent, child = index, excluded = false;
    while (parent !== null) {
      if (['w:del', 'w:moveFrom'].includes(elements[parent].name) || elements[parent].name.endsWith('PrChange')) excluded = true;
      const alternatives = branches.get(parent), selected = alternatives?.fallback ?? alternatives?.choice;
      if (selected !== undefined && selected !== child) excluded = true;
      child = parent; parent = elements[parent].parent;
    }
    if (!excluded) locations.set(element.start, `word/document.xml#readonly:p:${ordinal++}`);
  }
  return locations;
}
