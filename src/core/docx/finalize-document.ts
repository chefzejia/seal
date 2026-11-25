import type { HostPort } from '../host.js';
import { xmlAttributes } from './outline.js';
import { validatePackageImages } from './package-images.js';
import { auditImageLayout } from './layout.js';
import { validatePackageStructure } from './package-structure.js';
import { elementChildren, unescapeXml, xmlElements, type XmlElement } from './xml.js';
import { sha256Hex, writeZip } from './zip.js';
import { sealRanges } from './seal-ranges.js';

export interface FinalizeMark {
  id: string;
  state: 'confirmed' | 'unconfirmed';
  originalHighlights: Array<string | null>;
}
export interface FinalizeContext {
  draftSha256: string;
  baseSha256: string;
  marks: readonly FinalizeMark[];
}
interface Token { element: XmlElement; text: string; start: number; end: number; }
interface Run {
  element: XmlElement; open: string; close: string; properties: string;
  high: string | undefined; highStart: number; highEnd: number;
  children: XmlElement[]; tokens: Map<number, Token>;
}
interface Scan { xml: string; elements: XmlElement[]; runs: Run[]; tokens: Token[]; }
const textNames = new Set(['w:t', 'w:tab', 'w:br', 'w:cr']);
const excluded = new Set(['w:txbxContent', 'w:del', 'w:moveFrom', 'w:drawing', 'w:pict', 'w:object']);
const on = (value: string | undefined) => value === undefined || ['1','true','on'].includes(value);

function scan(xml: string): Scan {
  const elements = xmlElements(xml), childrenByParent = elementChildren(elements);
  const ancestorExcluded = new Uint8Array(elements.length);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (excluded.has(element.name) || (element.parent !== null && ancestorExcluded[element.parent] === 1)) {
      ancestorExcluded[index] = 1;
    }
  }
  const runs: Run[] = [], tokens: Token[] = [];
  let offset = 0;
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (element.name !== 'w:r') continue;
    const childIndices = childrenByParent[index];
    const children = childIndices.map(childIndex => elements[childIndex]);
    let propertyIndex = -1;
    for (const childIndex of childIndices) {
      if (elements[childIndex].name === 'w:rPr') {
        if (propertyIndex !== -1) throw new Error('run 属性不唯一');
        propertyIndex = childIndex;
      }
    }
    const property = propertyIndex >= 0 ? elements[propertyIndex] : undefined;
    let highlight: XmlElement | undefined;
    let vanished = false;
    if (propertyIndex >= 0) {
      for (const propChildIndex of childrenByParent[propertyIndex]) {
        const propChild = elements[propChildIndex];
        if (propChild.name === 'w:highlight') {
          if (highlight !== undefined) throw new Error('run 高亮属性不唯一');
          highlight = propChild;
        } else if (propChild.name === 'w:vanish' && on(xmlAttributes(xml, propChild).get('w:val'))) {
          vanished = true;
        }
      }
    }
    const blocked = ancestorExcluded[index] === 1 || vanished;
    const run: Run = {
      element, open: xml.slice(element.start, element.openEnd), close: xml.slice(element.closeStart, element.end),
      properties: property ? xml.slice(property.start, property.end) : '',
      high: highlight ? xml.slice(highlight.start, highlight.end) : undefined,
      highStart: highlight ? highlight.start - property!.start : 0,
      highEnd: highlight ? highlight.end - property!.start : 0,
      children, tokens: new Map(),
    };
    if (!blocked) for (const child of children) if (textNames.has(child.name)) {
      const text = child.name === 'w:t' ? unescapeXml(xml.slice(child.openEnd, child.closeStart)) : child.name === 'w:tab' ? '\t' : '\n';
      const token = { element: child, text, start: offset, end: offset + text.length };
      run.tokens.set(child.start, token); tokens.push(token); offset += text.length;
    }
    runs.push(run);
  }
  return { xml, elements, runs, tokens };
}

function color(high: string | undefined): string | undefined {
  if (high === undefined) return undefined;
  return xmlAttributes(high,xmlElements(high)[0]).get('w:val');
}

function mask(source: Scan): Array<string | undefined> {
  const result: Array<string | undefined> = [];
  for (const run of source.runs) for (const token of run.tokens.values()) for (let i = token.start; i < token.end; i++) result[i] = run.high;
  return result;
}
function units(raw: string): Array<{ raw: string; text: string }> {
  return [...raw.matchAll(/&(?:#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);|[\s\S]/gu)].map(match => ({ raw: match[0], text: unescapeXml(match[0]) }));
}
function properties(run: Run, high: string | undefined): string {
  return run.properties.slice(0,run.highStart) + (high ?? '') + run.properties.slice(run.highEnd);
}
interface Piece { xml: string; high: string | undefined; signature: string; text?: { id: number; open: string; close: string; raw: string }; }
function pieces(source: Scan, run: Run, changes: ReadonlyMap<number,string | undefined>): Piece[] {
  const result: Piece[] = [], { xml } = source;
  let cursor = run.element.openEnd;
  const raw = (value: string) => { if (value) result.push({ xml:value, high:run.high, signature:JSON.stringify(['raw',value]) }); };
  for (const child of run.children) {
    raw(xml.slice(cursor,child.start)); cursor = child.end;
    if (child.name === 'w:rPr') continue;
    const token = run.tokens.get(child.start);
    if (child.name !== 'w:t' || child.openEnd === child.end || child.openEnd === child.closeStart) {
      const high = token && token.end > token.start && changes.has(token.start) ? changes.get(token.start) : run.high;
      const value = xml.slice(child.start,child.end);
      result.push({xml:value,high,signature:JSON.stringify(['node',value])}); continue;
    }
    const open = xml.slice(child.start,child.openEnd), close = xml.slice(child.closeStart,child.end);
    let offset = token?.start;
    for (const unit of units(xml.slice(child.openEnd,child.closeStart))) {
      const high = offset !== undefined && changes.has(offset) ? changes.get(offset) : run.high;
      result.push({ xml:open+unit.raw+close, high, signature:JSON.stringify(['text',open,unit.raw,close]), text:{id:child.start,open,close,raw:unit.raw} });
      if (offset !== undefined) offset += unit.text.length;
    }
  }
  raw(xml.slice(cursor,run.element.closeStart));
  return result;
}

/** Equivalent run splitting is allowed; every content unit, property and surrounding XML stays exact. */
function representation(source: Scan, changes: ReadonlyMap<number,string | undefined>): string {
  const output: unknown[] = [];
  let cursor = 0;
  for (const run of source.runs) {
    if (run.element.start < cursor) continue;
    const between = source.xml.slice(cursor,run.element.start);
    if (between) output.push(['xml',between]);
    const content = pieces(source,run,changes);
    if (!content.length) output.push(['empty-run',run.open,run.close,run.properties]);
    for (const piece of content) output.push([run.open,run.close,properties(run,undefined),piece.signature,piece.high]);
    cursor = run.element.end;
  }
  if (cursor < source.xml.length) output.push(['xml',source.xml.slice(cursor)]);
  return JSON.stringify(output);
}

async function validated(bytes: Uint8Array, host: HostPort): Promise<Map<string,Uint8Array>> {
  const parts = await validatePackageStructure(bytes), issues = await validatePackageImages(parts,host);
  if (issues.length) throw new Error(`定稿图片校验失败：${issues[0].part} ${issues[0].reason}`);
  return parts;
}

/** The caller authenticates the ledger and each current human confirmation. */
export async function finalizeDocument(draft: Uint8Array, base: Uint8Array, context: FinalizeContext, host: HostPort): Promise<Uint8Array> {
  if (!context || context.draftSha256 !== sha256Hex(draft) || context.baseSha256 !== sha256Hex(base)) throw new Error('定稿上下文摘要与草稿或基准不一致');
  if (!Array.isArray(context.marks)) throw new Error('定稿上下文缺少台账标记');
  const parts = await validated(draft,host), decoder = new TextDecoder('utf-8',{fatal:true});
  await validated(base,host);
  const current = scan(decoder.decode(parts.get('word/document.xml')!)), ranges = sealRanges(current.xml);
  const rangeByName = new Map(ranges.map(item => [item.name, item]));
  const currentMask = mask(current), changes = new Map<number,string | undefined>(), ids = new Set<string>();
  for (const mark of context.marks) {
    if (!mark || typeof mark.id !== 'string' || !mark.id || ids.has(mark.id)) throw new Error('定稿台账标记编号缺失或重复');
    ids.add(mark.id);
    if (mark.state !== 'confirmed') throw new Error('定稿拒绝尚未由人确认的标记');
    const range = rangeByName.get(`_Seal_P_${mark.id}`);
    if (!range || !Array.isArray(mark.originalHighlights) || mark.originalHighlights.length !== range.text.length) throw new Error('定稿范围或原始高亮缺失');
    const restore = mark.originalHighlights.map((value: string | null) => value === null ? undefined : value);
    for (const high of restore) if (high !== undefined) {
      if (typeof high !== 'string') throw new Error('定稿原始高亮无效');
      const nodes = xmlElements(high);
      if (nodes.length !== 1 || nodes[0].name !== 'w:highlight' || nodes[0].start !== 0 || nodes[0].end !== high.length) throw new Error('定稿原始高亮无效');
    }
    for (let i = range.start; i < range.end; i++) {
      if (!/\s/u.test(range.text[i - range.start]) && color(currentMask[i]) !== 'yellow') throw new Error('定稿目标黄色高亮不完整');
      const high = color(restore[i-range.start]) === 'yellow' ? currentMask[i] : restore[i-range.start];
      if (changes.has(i) && changes.get(i) !== high) throw new Error('定稿台账重叠标记的来源格式冲突');
      changes.set(i,high);
    }
  }
  if (ranges.some(range => range.name.startsWith('_Seal_P_') && !ids.has(range.name.slice('_Seal_P_'.length)))) throw new Error('定稿存在无台账的待定范围');
  let xml = current.xml;
  for (const run of [...current.runs].reverse()) {
    if (![...run.tokens.values()].some(token => { for (let i=token.start;i<token.end;i++) if (changes.has(i) && changes.get(i) !== run.high) return true; return false; })) continue;
    const groups: Array<{ high: string | undefined; xml: string }> = [];
    let previous: Piece | undefined;
    for (const piece of pieces(current,run,changes)) {
      const last = groups[groups.length-1];
      if (last && last.high === piece.high) {
        if (piece.text && previous?.text?.id === piece.text.id) last.xml = last.xml.slice(0,-piece.text.close.length)+piece.text.raw+piece.text.close;
        else last.xml += piece.xml;
      }
      else groups.push({high:piece.high,xml:piece.xml});
      previous = piece;
    }
    const replacement = groups.map(group => run.open+properties(run,group.high)+group.xml+run.close).join('');
    xml = xml.slice(0,run.element.start)+replacement+xml.slice(run.element.end);
  }
  if (representation(scan(xml),new Map()) !== representation(current,changes)) throw new Error('定稿清理改变了目标高亮以外的文档内容');
  const bookmarkIds = new Set(ranges.map(range => range.bookmarkId));
  const markers = xmlElements(xml).filter(element => {
    if (element.name !== 'w:bookmarkStart' && element.name !== 'w:bookmarkEnd') return false;
    const open = xml.slice(element.start, element.openEnd), id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(open)?.[1];
    return id !== undefined && bookmarkIds.has(id);
  });
  for (const marker of markers.reverse()) xml = xml.slice(0, marker.start) + xml.slice(marker.end);
  if (auditImageLayout(xml, decoder.decode(parts.get('word/styles.xml') ?? new Uint8Array())).length) throw new Error('定稿复检 C16：Seal 图片超出版面');
  if (xml === current.xml) return draft.slice();
  parts.set('word/document.xml',new TextEncoder().encode(xml));
  const output = await writeZip(parts);
  await validated(output,host);
  return output;
}
