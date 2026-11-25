import { elementChildren, unescapeXml, xmlElements, type XmlElement } from './xml.js';
import { sealRanges } from './seal-ranges.js';

const TEXT_ELEMENT_NAMES = new Set(['w:t', 'w:tab', 'w:br', 'w:cr']);
const EXCLUDED_ANCESTOR_NAMES = new Set(['w:txbxContent', 'w:del', 'w:moveFrom', 'w:drawing', 'w:pict', 'w:object']);

function currentVisibleRunProperties(xml: string): string[] {
  const elements = xmlElements(xml);
  const children = elementChildren(elements);
  const ancestorExcluded = new Uint8Array(elements.length);
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (EXCLUDED_ANCESTOR_NAMES.has(element.name) || (element.parent !== null && ancestorExcluded[element.parent] === 1)) {
      ancestorExcluded[index] = 1;
    }
  }
  const runCache = new Map<number, { excluded: boolean; highlight: string }>();
  const inspectRun = (runIndex: number): { excluded: boolean; highlight: string } => {
    const cached = runCache.get(runIndex);
    if (cached !== undefined) return cached;
    let excluded = ancestorExcluded[runIndex] === 1;
    let highlight = '';
    let propertiesIndex = -1;
    for (const childIndex of children[runIndex]) {
      if (elements[childIndex].name === 'w:rPr') {
        propertiesIndex = childIndex;
        break;
      }
    }
    if (propertiesIndex >= 0) {
      let highlightElement: XmlElement | undefined;
      for (const propIndex of children[propertiesIndex]) {
        const prop = elements[propIndex];
        if (prop.name === 'w:vanish' && !/\bw:val=["'](?:0|false|off)["']/.test(xml.slice(prop.start, prop.end))) {
          excluded = true;
        } else if (prop.name === 'w:highlight' && highlightElement === undefined) {
          highlightElement = prop;
        }
      }
      if (!excluded && highlightElement !== undefined) {
        highlight = xml.slice(highlightElement.start, highlightElement.end);
      }
    }
    const entry = { excluded, highlight };
    runCache.set(runIndex, entry);
    return entry;
  };
  const result: string[] = [];
  for (const element of elements) {
    if (!TEXT_ELEMENT_NAMES.has(element.name) || element.parent === null) continue;
    const runIndex = element.parent;
    if (elements[runIndex].name !== 'w:r') continue;
    const { excluded, highlight } = inspectRun(runIndex);
    if (excluded) continue;
    const text = element.name === 'w:t' ? unescapeXml(xml.slice(element.openEnd, element.closeStart)) : element.name === 'w:tab' ? '\t' : '\n';
    for (let k = 0; k < text.length; k++) result.push(highlight);
  }
  return result;
}

export function auditSealPending(documentXml: string, names: readonly string[]): Array<{ id: string; reason: string }> {
  let ranges: ReturnType<typeof sealRanges>;
  try { ranges = sealRanges(documentXml); }
  catch { return names.map(id => ({ id, reason: 'Seal 书签无效、缺失或交叉' })); }
  if (names.length === 0) return [];
  const rangeByName = new Map(ranges.map(item => [item.name, item]));
  let visibleProperties: string[] | undefined;
  const issues: Array<{ id: string; reason: string }> = [];
  for (const id of names) {
    const range = rangeByName.get(id);
    if (!range) {
      issues.push({ id, reason: '待定范围缺失' });
      continue;
    }
    visibleProperties ??= currentVisibleRunProperties(documentXml);
    for (let index = 0; index < range.text.length; index++) {
      const property = range.start + index < range.end ? visibleProperties[range.start + index] ?? '' : '';
      if (!/\s/u.test(range.text[index]) && !/<w:highlight\b[^>]*\bw:val\s*=\s*["']yellow["']/.test(property)) {
        issues.push({ id, reason: '待定范围内文字缺少黄色高亮' });
        break;
      }
    }
  }
  return issues;
}
