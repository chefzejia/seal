import { visibleOffsetFromTokens, visibleTextPositions } from './visible-surgery.js';
import { unescapeXml, xmlElements } from './xml.js';

export interface SealRange {
  name: string;
  bookmarkId: string;
  start: number;
  end: number;
  startXml: number;
  endXml: number;
  text: string;
}

export function rangeRelation(range: Pick<SealRange, 'start' | 'end'>, start: number, end: number): 'inside' | 'cover' | 'partial' | 'disjoint' {
  if (end <= range.start || start >= range.end) return 'disjoint';
  if (start >= range.start && end <= range.end) return 'inside';
  if (start <= range.start && end >= range.end) return 'cover';
  return 'partial';
}

/** Parse Word bookmark pairs directly; offsets are transient to this document version. */
export function sealRanges(xml: string): SealRange[] {
  const elements = xmlElements(xml), tokens = visibleTextPositions(xml);
  const documentText = tokens.map(token => token.text).join('');
  const starts = new Map<string, { name: string; startXml: number; position: number }>();
  const seenNames = new Set<string>(), result: SealRange[] = [];
  const markers = elements.filter(element => element.name === 'w:bookmarkStart' || element.name === 'w:bookmarkEnd');
  const counts = new Map<string, { starts: number; ends: number }>();
  for (const element of markers) {
    const open = xml.slice(element.start, element.openEnd);
    const id = /\bw:id\s*=\s*(["'])(.*?)\1/.exec(open)?.[2];
    const name = /\bw:name\s*=\s*(["'])(.*?)\1/.exec(open)?.[2];
    if (!id && name && unescapeXml(name).startsWith('_Seal_')) throw new Error('Seal 书签缺少编号');
    if (!id) continue;
    const count = counts.get(id) ?? { starts: 0, ends: 0 };
    if (element.name === 'w:bookmarkStart') count.starts++; else count.ends++;
    counts.set(id, count);
  }
  for (const element of elements) {
    if (element.name !== 'w:bookmarkStart' && element.name !== 'w:bookmarkEnd') continue;
    const open = xml.slice(element.start, element.openEnd);
    const id = /\bw:id\s*=\s*(["'])(.*?)\1/.exec(open)?.[2];
    if (!id) continue;
    if (element.name === 'w:bookmarkStart') {
      const raw = /\bw:name\s*=\s*(["'])(.*?)\1/.exec(open)?.[2];
      const name = raw && unescapeXml(raw);
      if (!name?.startsWith('_Seal_')) continue;
      if (!/^_Seal_[PF]_[A-Za-z0-9]+$/.test(name) || starts.has(id) || seenNames.has(name)) throw new Error('Seal 书签名称或编号无效、重复');
      const count = counts.get(id)!;
      if (count.starts !== 1 || count.ends !== 1) throw new Error('Seal 书签编号重复或缺少结束标记');
      seenNames.add(name);
      starts.set(id, { name, startXml: element.end, position: visibleOffsetFromTokens(tokens, element.end) });
    } else {
      const start = starts.get(id);
      if (!start) continue;
      const end = visibleOffsetFromTokens(tokens, element.start);
      result.push({ name: start.name, bookmarkId: id, start: start.position, end, startXml: start.startXml, endXml: element.start, text: documentText.slice(start.position, end) });
      starts.delete(id);
    }
  }
  if (starts.size) throw new Error('Seal 书签缺少结束标记');
  result.sort((a, b) => a.startXml - b.startXml);
  for (let index = 0; index < result.length; index++) {
    if (result[index].start > result[index].end || index && result[index].startXml < result[index - 1].endXml) throw new Error('Seal 书签范围交叉或嵌套');
  }
  return result;
}
