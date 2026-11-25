import { xmlElements, type XmlElement } from './xml.js';

export type AddressKind = 'paragraph' | 'table' | 'row' | 'cell';
export interface AddressedElement {
  kind: AddressKind;
  start: number;
  end: number;
  xml: string;
}

/** Resolve only body elements. Text boxes and other document parts are not editable. */
export function resolveAddress(documentXml: string, address: string): AddressedElement {
  const parts = address.split('/');
  if (!/^(?:p|t):(?:0|[1-9]\d*)$/.test(parts[0])) throw new Error(`无效地址：${address}`);
  const elements = xmlElements(documentXml);
  const body = elements.findIndex(element => element.name === 'w:body');
  if (body < 0) throw new Error('Word 正文不存在');
  let parent = body;
  let expected: readonly string[] = ['p', 't'];
  const names: Record<string, string> = { p: 'w:p', t: 'w:tbl', r: 'w:tr', c: 'w:tc' };
  let selected: XmlElement | undefined;
  let last = '';
  for (const part of parts) {
    const match = /^([ptrc]):(0|[1-9]\d*)$/.exec(part);
    if (!match || !expected.includes(match[1])) throw new Error(`无效地址：${address}`);
    const index = Number(match[2]);
    if (!Number.isSafeInteger(index)) throw new Error(`无效地址：${address}`);
    const candidates = elements.filter(element => element.parent === parent && element.name === names[match[1]]);
    selected = candidates[index];
    if (!selected) throw new Error(`地址不存在：${address}`);
    parent = elements.indexOf(selected);
    last = match[1];
    expected = last === 't' ? ['r'] : last === 'r' ? ['c'] : last === 'c' ? ['p', 't'] : [];
  }
  const kind = { p: 'paragraph', t: 'table', r: 'row', c: 'cell' }[last] as AddressKind;
  return { kind, start: selected!.start, end: selected!.end, xml: documentXml.slice(selected!.start, selected!.end) };
}

export function isCellEdgeBlock(documentXml: string, address: string, edge: 'first' | 'last'): boolean {
  const parentAddress = /^(.*\/c:\d+)\/[pt]:\d+$/.exec(address)?.[1];
  if (!parentAddress) return false;
  const cell = resolveAddress(documentXml, parentAddress), target = resolveAddress(documentXml, address);
  const elements = xmlElements(cell.xml), root = elements.findIndex(element => element.name === 'w:tc');
  const blocks = elements.filter(element => element.parent === root && ['w:p', 'w:tbl', 'w:sdt', 'w:customXml'].includes(element.name));
  return blocks.at(edge === 'first' ? 0 : -1)?.start === target.start - cell.start;
}
