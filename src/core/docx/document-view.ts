import { detectBlankHints, type BlankHint } from './blank-hints.js';
import { paragraphText } from './visible-text.js';
import { isMergedContinuation, parseDocumentBody, parseTableRows, xmlElements } from './xml.js';
import { bodyViewNodes, type BodyViewNode } from './body-structure.js';

export interface ViewBlock { address: string; kind: 'paragraph' | 'cell'; text: string; hints: BlankHint[]; }

function paragraphs(xml: string): string[] {
  const elements = xmlElements(xml);
  const parent = elements.findIndex(element => element.name === 'w:tc');
  return elements.filter(element => element.parent === parent && element.name === 'w:p')
    .map(element => paragraphText(xml.slice(element.start, element.end)));
}

/** Extract a flat view of body paragraphs and top-level table cells. */
export function bodyBlocks(documentXml: string): ViewBlock[] {
  const result: ViewBlock[] = [];
  for (const block of parseDocumentBody(documentXml).blocks) {
    if (block.kind === 'paragraph') {
      const address = `p:${block.index}`;
      const text = paragraphText(block.xml);
      result.push({ address, kind: 'paragraph', text, hints: detectBlankHints(address, text) });
    } else if (block.kind === 'table') {
      for (const row of parseTableRows(block.xml)) {
        for (const cell of row.cells) {
          const address = `t:${block.index}/r:${row.rowIndex}/c:${cell.cellIndex}`;
          const text = isMergedContinuation(cell.xml) ? '〃' : paragraphs(cell.xml).join('\n');
          result.push({ address, kind: 'cell', text, hints: detectBlankHints(address, text) });
        }
      }
    }
  }
  return result;
}

export function searchBody(documentXml: string, query: string, offset = 0, limit = 30): { blocks: ViewBlock[]; next: number | null } {
  if (!query) throw new Error('搜索内容不能为空');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('搜索分页参数无效');
  const matches = bodyBlocks(documentXml).filter(block => block.text.includes(query));
  return { blocks: matches.slice(offset, offset + limit), next: offset + limit < matches.length ? offset + limit : null };
}

export { bodyViewNodes } from './body-structure.js';
export type { BodyViewNode } from './body-structure.js';
export interface ViewHint extends Omit<BlankHint, 'kind'> { kind: BlankHint['kind'] | 'emptyCell' | 'underlinedSpace'; }

/** Additional view hints never alter the plain text or its offsets. */
export function viewBlankHints(address: string, text: string, paragraphXml = '', emptyCell = false): ViewHint[] {
  const hints: ViewHint[] = detectBlankHints(address, text);
  if (emptyCell) hints.push({ id: '', start: 0, end: 0, text: '', kind: 'emptyCell' });
  if (paragraphXml) {
    const elements = xmlElements(paragraphXml);
    let offset = 0;
    for (const [index, element] of elements.entries()) {
      if (element.name !== 'w:r') continue;
      let ancestor = element.parent, excluded = false;
      while (ancestor !== null) {
        if (['w:txbxContent', 'w:del', 'w:moveFrom'].includes(elements[ancestor].name)) excluded = true;
        ancestor = elements[ancestor].parent;
      }
      if (excluded) continue;
      const run = paragraphXml.slice(element.start, element.end), value = paragraphText(run);
      const property = elements.findIndex(candidate => candidate.parent === index && candidate.name === 'w:rPr');
      const underlined = property >= 0 && elements.some(candidate => candidate.parent === property && candidate.name === 'w:u' && !/\bw:val\s*=\s*["'](?:none|0|false|off)["']/.test(paragraphXml.slice(candidate.start, candidate.end)));
      if (underlined) for (const match of value.matchAll(/[ \t\u3000]+/g)) {
        const start = offset + match.index, end = start + match[0].length;
        if (!hints.some(hint => start < hint.end && end > hint.start)) hints.push({ id: '', start, end, text: match[0], kind: 'underlinedSpace' });
      }
      offset += value.length;
    }
  }
  return hints.sort((a, b) => a.start - b.start || b.end - a.end).map((hint, index) => ({ ...hint, id: `${address}#${index}` }));
}

export function isEmptyViewCell(node: BodyViewNode): boolean {
  return node.kind === 'cell' && !node.continuation && !paragraphText(node.xml).trim() && !xmlElements(node.xml).some(element => ['w:drawing', 'w:pict', 'w:object', 'w:tbl'].includes(element.name));
}

/** Collect the same editable hints and addresses exposed by the document view. */
export function bodyHintBlocks(documentXml: string): Map<string, { text: string; hints: ViewHint[] }> {
  const result = new Map<string, { text: string; hints: ViewHint[] }>();
  const visit = (nodes: readonly BodyViewNode[]) => {
    for (const node of nodes) {
      if (node.continuation) continue;
      if (node.kind === 'paragraph') {
        const text = paragraphText(node.xml);
        result.set(node.address, { text, hints: viewBlankHints(node.address, text, node.xml) });
      } else if (node.kind === 'cell') {
        const text = paragraphText(node.xml);
        result.set(node.address, { text, hints: isEmptyViewCell(node) ? viewBlankHints(node.address, '', '', true) : [] });
      }
      visit(node.children);
    }
  };
  visit(bodyViewNodes(documentXml));
  return result;
}
