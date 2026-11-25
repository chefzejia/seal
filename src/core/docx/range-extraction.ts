import { parseDocumentBody, unescapeXml, xmlElements } from './xml.js';
import { sha256Hex, writeZip } from './zip.js';
import { validatePackageStructure } from './package-structure.js';
import { validatePackageImages } from './package-images.js';
import type { HostPort } from '../host.js';

export interface ExtractionRange { from: string; to: string; }
export interface ExtractionResult { base: Uint8Array; draft: Uint8Array; removedMarkers: string[]; renamedMarkers: Array<{ part: string; before: string; after: string }>; }

const paired = /^(w:(?:bookmark|commentRange|perm|moveFromRange|moveToRange|customXmlInsRange|customXmlDelRange|customXmlMoveFromRange|customXmlMoveToRange))(Start|End)$/;

function removeOrphanMarkers(xml: string): { xml: string; removed: string[] } {
  const nodes = xmlElements(xml);
  const markers = nodes.flatMap(node => {
    const match = paired.exec(node.name);
    if (!match) return [];
    const id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(xml.slice(node.start, node.openEnd))?.[1];
    return id === undefined ? [] : [{ node, key: `${match[1]}:${id}`, side: match[2] }];
  });
  const counts = new Map<string, { Start: number; End: number }>();
  for (const marker of markers) {
    const count = counts.get(marker.key) ?? { Start: 0, End: 0 };
    count[marker.side as 'Start' | 'End']++;
    counts.set(marker.key, count);
  }
  const orphaned = markers.filter(marker => {
    const count = counts.get(marker.key)!;
    return count.Start !== 1 || count.End !== 1;
  }).sort((a, b) => b.node.start - a.node.start);
  return { xml: orphaned.reduce((result, marker) => result.slice(0, marker.node.start) + result.slice(marker.node.end), xml), removed: orphaned.map(marker => `${marker.key}:${marker.side}`) };
}

function renameReservedBookmarks(parts: Map<string, Uint8Array>): ExtractionResult['renamedMarkers'] {
  const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
  const documents = [...parts].filter(([name]) => name.startsWith('word/') && name.endsWith('.xml')).map(([name, bytes]) => ({ name, xml: decoder.decode(bytes) }));
  const names = new Set<string>();
  for (const { xml } of documents) for (const element of xmlElements(xml)) if (element.name === 'w:bookmarkStart') {
    const match = /\bw:name\s*=\s*(["'])(.*?)\1/.exec(xml.slice(element.start, element.openEnd));
    if (match) names.add(unescapeXml(match[2]));
  }
  const renamed: ExtractionResult['renamedMarkers'] = [];
  for (const document of documents) {
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const element of xmlElements(document.xml)) {
      if (element.name !== 'w:bookmarkStart') continue;
      const open = document.xml.slice(element.start, element.openEnd), match = /\bw:name\s*=\s*(["'])(.*?)\1/.exec(open);
      if (!match) continue;
      const before = unescapeXml(match[2]);
      if (!before.startsWith('_Seal_')) continue;
      let index = 0, after: string;
      do { after = `Original_${sha256Hex(JSON.stringify([document.name, before, index++])).slice(0, 24)}`; } while (names.has(after));
      names.add(after);
      renamed.push({ part: document.name, before, after });
      edits.push({ start: element.start, end: element.openEnd, text: open.slice(0, match.index) + `w:name=${match[1]}${after}${match[1]}` + open.slice(match.index + match[0].length) });
    }
    if (edits.length) parts.set(document.name, encoder.encode(edits.reverse().reduce((xml, edit) => xml.slice(0, edit.start) + edit.text + xml.slice(edit.end), document.xml)));
  }
  const replacements = new Map<string, string>();
  for (const item of renamed) {
    if (replacements.has(item.before)) throw new Error(`源文档保留书签名称重复，无法安全重命名：${item.before}`);
    replacements.set(item.before, item.after);
  }
  for (const document of documents) {
    const xml = decoder.decode(parts.get(document.name)!);
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const element of xmlElements(xml)) {
      if (element.name !== 'w:hyperlink') continue;
      const open = xml.slice(element.start, element.openEnd), match = /\bw:anchor\s*=\s*(["'])(.*?)\1/.exec(open);
      const after = match && replacements.get(unescapeXml(match[2]));
      if (match && after) edits.push({ start: element.start, end: element.openEnd, text: open.slice(0, match.index) + `w:anchor=${match[1]}${after}${match[1]}` + open.slice(match.index + match[0].length) });
    }
    if (edits.length) parts.set(document.name, encoder.encode(edits.reverse().reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), xml)));
  }
  return renamed;
}

/** Copy selected body ranges; all referenced package parts remain in the copy. */
export async function extractRanges(source: Uint8Array, ranges: readonly ExtractionRange[], host: Pick<HostPort, 'validateImage'> = {}): Promise<ExtractionResult> {
  if (!ranges.length) throw new Error('至少选择一个复制范围');
  const entries = await validatePackageStructure(source);
  const sourceXml = new TextDecoder('utf-8', { fatal: true }).decode(entries.get('word/document.xml')!);
  const body = parseDocumentBody(sourceXml);
  const address = (block: typeof body.blocks[number]) => block.kind === 'paragraph' ? `p:${block.index}` : block.kind === 'table' ? `t:${block.index}` : '';
  let previous = -1;
  const selected: string[] = [];
  for (const range of ranges) {
    const from = body.blocks.findIndex(block => address(block) === range.from);
    const to = body.blocks.findIndex(block => address(block) === range.to);
    if (from < 0 || to < from || from <= previous) throw new Error(`复制范围无效或顺序重叠：${range.from}..${range.to}`);
    selected.push(...body.blocks.slice(from, to + 1).filter(block => block.kind !== 'sectPr').map(block => block.xml));
    previous = to;
  }
  const selectedXml = selected.join('');
  const sections = xmlElements(selectedXml).filter(element => element.name === 'w:sectPr');
  const last = sections.at(-1);
  const section = last ? selectedXml.slice(last.start, last.end) : [...body.blocks].reverse().find(block => block.kind === 'sectPr')?.xml ?? '';
  const cleaned = removeOrphanMarkers(selectedXml + section);
  entries.set('word/document.xml', new TextEncoder().encode(body.prefixXml + cleaned.xml + body.suffixXml));
  const renamedMarkers = renameReservedBookmarks(entries);
  const base = await writeZip(entries);
  const output = await validatePackageStructure(base);
  const issues = await validatePackageImages(output, host);
  if (issues.length) throw new Error(`文件合法性检查失败：${issues.map(issue => `${issue.part}：${issue.reason}`).join('；')}；请修复图片或配置宿主解码器后重试`);
  return { base, draft: base.slice(), removedMarkers: cleaned.removed, renamedMarkers };
}
