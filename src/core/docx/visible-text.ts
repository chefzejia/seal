import { unescapeXml, xmlElements, type XmlElement } from './xml.js';

/** Visible text of one editable paragraph, preserving tabs and soft line breaks. */
export function paragraphText(paragraphXml: string): string {
  const elements = xmlElements(paragraphXml);
  const text: string[] = [];
  for (const element of elements) {
    if (!['w:t', 'w:tab', 'w:br', 'w:cr'].includes(element.name)) continue;
    if (element.parent === null || elements[element.parent].name !== 'w:r') continue;
    let parent: number | null = element.parent;
    let excluded = false;
    while (parent !== null) {
      if (['w:txbxContent', 'w:del', 'w:moveFrom'].includes(elements[parent].name)) { excluded = true; break; }
      if (elements[parent].name === 'w:r') {
        const runIndex = parent;
        const property = elements.findIndex(candidate => candidate.parent === runIndex && candidate.name === 'w:rPr');
        if (property >= 0 && elements.some(candidate => candidate.parent === property && candidate.name === 'w:vanish' && !/\bw:val=["'](?:0|false|off)["']/.test(paragraphXml.slice(candidate.start, candidate.end)))) excluded = true;
      }
      parent = elements[parent].parent;
    }
    if (excluded) continue;
    if (element.name === 'w:t') text.push(unescapeXml(paragraphXml.slice(element.openEnd, element.closeStart)));
    else text.push(element.name === 'w:tab' ? '\t' : '\n');
  }
  return text.join('');
}

/** Render paragraph-level hidden text and object markers without making them editable. */
export function paragraphView(paragraphXml: string): string {
  const elements = xmlElements(paragraphXml);
  const output: string[] = [];
  let activeHiddenRun: number | null = null;
  for (const element of elements) {
    if (!['w:t', 'w:tab', 'w:br', 'w:cr', 'w:drawing', 'w:pict', 'w:object'].includes(element.name)) continue;
    if (element.parent === null || elements[element.parent].name !== 'w:r') continue;
    let parent: number | null = element.parent, hiddenRun: number | null = null, excluded = false;
    while (parent !== null) {
      const ancestor: XmlElement = elements[parent];
      if (['w:txbxContent', 'w:del', 'w:moveFrom', 'w:drawing', 'w:pict', 'w:object'].includes(ancestor.name)) { excluded = true; break; }
      if (ancestor.name === 'w:r') {
        const property = elements.findIndex(candidate => candidate.parent === parent && candidate.name === 'w:rPr');
        if (property >= 0 && elements.some(candidate => candidate.parent === property && candidate.name === 'w:vanish' && !/\bw:val=["'](?:0|false|off)["']/.test(paragraphXml.slice(candidate.start, candidate.end)))) hiddenRun = parent;
      }
      parent = ancestor.parent;
    }
    if (excluded) continue;
    if (activeHiddenRun !== hiddenRun) {
      if (activeHiddenRun !== null) output.push('‹/隐藏›');
      if (hiddenRun !== null) output.push('‹隐藏›');
      activeHiddenRun = hiddenRun;
    }
    if (element.name === 'w:t') output.push(unescapeXml(paragraphXml.slice(element.openEnd, element.closeStart)));
    else if (element.name === 'w:drawing' || element.name === 'w:pict') output.push('[图片]');
    else if (element.name === 'w:object') output.push('[对象]');
    else output.push(element.name === 'w:tab' ? '\t' : '\n');
  }
  if (activeHiddenRun !== null) output.push('‹/隐藏›');
  return output.join('');
}
