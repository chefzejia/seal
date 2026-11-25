import { assertXmlCharacters, elementChildren, escapeXml, extractFirstRunPr, injectHighlightYellow, setRunHighlight, unescapeXml, xmlElements, type XmlElement } from './xml.js';

export interface VisibleTextToken { element: XmlElement; run: XmlElement; text: string; start: number; end: number; }

const TEXT_ELEMENT_NAMES = new Set(['w:t', 'w:tab', 'w:br', 'w:cr']);
const EXCLUDED_ANCESTOR_NAMES = new Set(['w:txbxContent', 'w:del', 'w:moveFrom', 'w:drawing', 'w:pict', 'w:object']);

export function visibleTextPositions(xml: string): VisibleTextToken[] {
  const elements = xmlElements(xml);
  const children = elementChildren(elements);
  const ancestorBlocked = new Uint8Array(elements.length);
  const hasOuterRun = new Uint8Array(elements.length);
  for (let index = 0; index < elements.length; index++) {
    const parent = elements[index].parent;
    if (parent !== null) {
      if (ancestorBlocked[parent] === 1 || EXCLUDED_ANCESTOR_NAMES.has(elements[parent].name)) {
        ancestorBlocked[index] = 1;
      }
      if (hasOuterRun[parent] === 1 || elements[parent].name === 'w:r') {
        hasOuterRun[index] = 1;
      }
    }
  }
  const runVanishCache = new Map<number, boolean>();
  const isRunVanished = (runIndex: number): boolean => {
    const cached = runVanishCache.get(runIndex);
    if (cached !== undefined) return cached;
    let vanished = false;
    for (const childIndex of children[runIndex]) {
      if (elements[childIndex].name === 'w:rPr') {
        for (const propIndex of children[childIndex]) {
          const prop = elements[propIndex];
          if (prop.name === 'w:vanish' && !/\bw:val=["'](?:0|false|off)["']/.test(xml.slice(prop.start, prop.end))) {
            vanished = true;
            break;
          }
        }
        break;
      }
    }
    runVanishCache.set(runIndex, vanished);
    return vanished;
  };
  const result: VisibleTextToken[] = [];
  let offset = 0;
  for (const element of elements) {
    if (!TEXT_ELEMENT_NAMES.has(element.name) || element.parent === null) continue;
    const runIndex = element.parent;
    const run = elements[runIndex];
    if (run.name !== 'w:r') continue;
    if (ancestorBlocked[runIndex] === 1 || hasOuterRun[runIndex] === 1 || isRunVanished(runIndex)) continue;
    const text = element.name === 'w:t' ? unescapeXml(xml.slice(element.openEnd, element.closeStart)) : element.name === 'w:tab' ? '\t' : '\n';
    result.push({ element, run, text, start: offset, end: offset + text.length });
    offset += text.length;
  }
  return result;
}

export function visibleOffsetFromTokens(tokens: readonly VisibleTextToken[], xmlOffset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (tokens[mid].element.end <= xmlOffset) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? 0 : tokens[low - 1].end;
}

export function editableText(xml: string): string {
  return visibleTextPositions(xml).map(token => token.text).join('');
}

export function visibleOffsetBefore(xml: string, xmlOffset: number): number {
  return visibleOffsetFromTokens(visibleTextPositions(xml), xmlOffset);
}

export function firstVisibleRunProperties(xml: string): string {
  const first = visibleTextPositions(xml).find(token => token.text.length > 0);
  return first ? extractFirstRunPr(xml.slice(first.run.start, first.run.end)) : '';
}

export function visibleRunProperties(xml: string): string[] {
  const result: string[] = [];
  const runPrCache = new Map<number, string>();
  for (const token of visibleTextPositions(xml)) {
    let runPr = runPrCache.get(token.run.start);
    if (runPr === undefined) {
      runPr = extractFirstRunPr(xml.slice(token.run.start, token.run.end));
      runPrCache.set(token.run.start, runPr);
    }
    for (let k = 0; k < token.text.length; k++) result.push(runPr);
  }
  return result;
}

function isSignificantRunChild(element: XmlElement): boolean {
  return element.name !== 'w:rPr' && !(element.name === 'w:t' && element.openEnd === element.closeStart);
}

function renderTextRunLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line, part) => `${part ? '<w:br/>' : ''}${line ? `<w:t xml:space="preserve">${escapeXml(line)}</w:t>` : ''}`)
    .join('');
}

/** Insert paired bookmarks around visible text without changing adjacent run formatting. */
export function wrapVisibleRange(xml: string, start: number, end: number, name: string, bookmarkId: number): string {
  if (!/^_Seal_[PF]_[A-Za-z0-9]+$/.test(name) || !Number.isSafeInteger(bookmarkId) || bookmarkId < 0 || start >= end) throw new Error('Seal 书签参数无效');
  const insert = (source: string, offset: number, marker: string, side: 'start' | 'end') => {
    const token = visibleTextPositions(source).find(item => side === 'start' ? item.start <= offset && offset < item.end : item.start < offset && offset <= item.end);
    if (!token) throw new Error('Seal 书签位置不存在');
    const { element, run } = token, index = offset - token.start;
    const elements = xmlElements(source), children = elementChildren(elements);
    const runIndex = elements.findIndex(item => item.start === run.start && item.name === 'w:r');
    const siblings = runIndex >= 0 ? children[runIndex] : [];
    const position = siblings.findIndex(item => elements[item].start === element.start);
    const hasBefore = position > 0 && siblings.slice(0, position).some(item => isSignificantRunChild(elements[item]));
    const hasAfter = position >= 0 && siblings.slice(position + 1).some(item => isSignificantRunChild(elements[item]));
    if (side === 'start' && index === 0 && !hasBefore) return source.slice(0, run.start) + marker + source.slice(run.start);
    if (side === 'end' && index === token.text.length && !hasAfter) return source.slice(0, run.end) + marker + source.slice(run.end);
    const runOpen = source.slice(run.start, run.openEnd), properties = extractFirstRunPr(source.slice(run.start, run.end));
    let left = '', right = '';
    if (element.name === 'w:t') {
      const leftText = token.text.slice(0, index), rightText = token.text.slice(index);
      left = leftText ? `<w:t xml:space="preserve">${escapeXml(leftText)}</w:t>` : '';
      right = rightText ? `<w:t xml:space="preserve">${escapeXml(rightText)}</w:t>` : '';
    } else {
      const original = source.slice(element.start, element.end);
      left = index ? original : '';
      right = index ? '' : original;
    }
    return source.slice(0, element.start) + left + `</w:r>${marker}${runOpen}${properties}` + right + source.slice(element.end);
  };
  const endMarker = `<w:bookmarkEnd w:id="${bookmarkId}"/>`;
  const startMarker = `<w:bookmarkStart w:id="${bookmarkId}" w:name="${name}"/>`;
  return insert(insert(xml, end, endMarker, 'end'), start, startMarker, 'start');
}

function rawOffset(raw: string, decodedOffset: number): number {
  let count = 0;
  for (const match of raw.matchAll(/&(?:#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);|[\s\S]/gu)) {
    if (count === decodedOffset) return match.index;
    count += unescapeXml(match[0]).length;
    if (count > decodedOffset) throw new Error('XML 字符偏移不可拆分');
  }
  if (count !== decodedOffset) throw new Error('XML 字符偏移越界');
  return raw.length;
}

export function replaceVisibleRange(xml: string, start: number, end: number, value: string, yellow: boolean | string | null = false, drawing = '', sealBookmarkIds: ReadonlySet<string> = new Set()): string {
  assertXmlCharacters(value);
  const affected = visibleTextPositions(xml).filter(token => token.start < end && token.end > start);
  if (!affected.length || start < affected[0].start || end > affected[affected.length - 1].end || start >= end) throw new Error('文字范围无效');
  const original = affected.map(token => token.text.slice(Math.max(0, start - token.start), Math.min(token.text.length, end - token.start))).join('');
  let prefix = 0, suffix = 0;
  while (prefix < original.length && prefix < value.length && original[prefix] === value[prefix]) prefix++;
  if (prefix && /[\uD800-\uDBFF]/.test(original[prefix - 1]) && /[\uDC00-\uDFFF]/.test(original[prefix] ?? '')) prefix--;
  while (suffix < original.length - prefix && suffix < value.length - prefix && original[original.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
  if (suffix && /[\uDC00-\uDFFF]/.test(original[original.length - suffix]) && /[\uD800-\uDBFF]/.test(original[original.length - suffix - 1] ?? '')) suffix--;
  const elements = xmlElements(xml), childrenByParent = elementChildren(elements), last = affected[affected.length - 1];
  const runIndexByStart = new Map<number, number>();
  for (let index = 0; index < elements.length; index++) {
    if (elements[index].name === 'w:r') runIndexByStart.set(elements[index].start, index);
  }
  const lastRunIndex = runIndexByStart.get(last.run.start) ?? -1;
  const parent = lastRunIndex < 0 ? null : elements[lastRunIndex].parent;
  let appendAfter = -1;
  if (!drawing && prefix === original.length && value.length > original.length && last.end === end && parent !== null) {
    const sealStartIds = new Set<string>(sealBookmarkIds);
    for (const element of elements) {
      if (element.name !== 'w:bookmarkStart') continue;
      const open = xml.slice(element.start, element.openEnd);
      if (!/\bw:name\s*=\s*["']_Seal_/.test(open)) continue;
      const id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(open)?.[1];
      if (id) sealStartIds.add(id);
    }
    for (const siblingIndex of childrenByParent[parent]) {
      const sibling = elements[siblingIndex];
      if (sibling.start < last.run.end) continue;
      if (sibling.name !== 'w:bookmarkEnd') break;
      const id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(xml.slice(sibling.start, sibling.openEnd))?.[1];
      if (id && sealStartIds.has(id)) break;
      appendAfter = sibling.end;
    }
  }
  const replacementValue = appendAfter >= 0 ? original : value;
  const translated = (position: number) => position === original.length ? replacementValue.length : position <= prefix ? position : position >= original.length - suffix ? replacementValue.length - (original.length - position) : prefix;
  const firstRun = affected[0].run, firstStyle = extractFirstRunPr(xml.slice(firstRun.start, firstRun.end));
  const insertedStyle = yellow === true
    ? injectHighlightYellow(firstStyle)
    : yellow === false
      ? firstStyle
      : setRunHighlight(firstStyle, yellow);
  const runGroups = new Map<number, Array<{ token: VisibleTextToken; index: number }>>();
  for (const [index, token] of affected.entries()) {
    const group = runGroups.get(token.run.start) ?? [];
    group.push({ token, index });
    runGroups.set(token.run.start, group);
  }
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const [runStart, entries] of runGroups) {
    const runIndex = runIndexByStart.get(runStart) ?? -1;
    if (runIndex < 0) throw new Error('文字运行节点无效');
    const run = elements[runIndex];
    const runOpen = xml.slice(run.start, run.openEnd);
    const style = extractFirstRunPr(xml.slice(run.start, run.end));
    const affectedByStart = new Map(entries.map(entry => [entry.token.element.start, entry]));
    const outputRuns: string[] = [];
    let originalNodes: string[] = [];
    const flushOriginal = () => {
      if (originalNodes.length > 0) {
        outputRuns.push(`${runOpen}${style}${originalNodes.join('')}</w:r>`);
        originalNodes = [];
      }
    };
    for (const childIndex of childrenByParent[runIndex]) {
      const child = elements[childIndex];
      if (child.name === 'w:rPr') continue;
      const entry = affectedByStart.get(child.start);
      if (!entry) {
        if (isSignificantRunChild(child)) originalNodes.push(xml.slice(child.start, child.end));
        continue;
      }
      const { token, index } = entry;
      const fromPosition = Math.max(0, token.start - start), toPosition = Math.min(original.length, token.end - start);
      const segment = replacementValue.slice(translated(fromPosition), translated(toPosition));
      const trailingDrawing = index === affected.length - 1 ? drawing : '';
      const insertText = (segment ? renderTextRunLines(segment) : '') + trailingDrawing;
      const inserted = segment || trailingDrawing ? `${runOpen}${insertedStyle}${insertText}</w:r>` : '';
      if (child.name !== 'w:t') {
        if (inserted) {
          flushOriginal();
          outputRuns.push(inserted);
        }
        continue;
      }
      const raw = xml.slice(child.openEnd, child.closeStart);
      const from = Math.max(0, start - token.start), to = Math.min(token.text.length, end - token.start);
      const before = raw.slice(0, rawOffset(raw, from)), after = raw.slice(rawOffset(raw, to));
      const open = xml.slice(child.start, child.openEnd), close = xml.slice(child.closeStart, child.end);
      if (inserted) {
        if (before) originalNodes.push(`${open}${before}${close}`);
        flushOriginal();
        outputRuns.push(inserted);
        if (after) originalNodes.push(`${open}${after}${close}`);
      } else if (before || after) {
        originalNodes.push(`${open}${before}${after}${close}`);
      }
    }
    flushOriginal();
    replacements.push({ start: run.start, end: run.end, value: outputRuns.join('') });
  }
  if (appendAfter >= 0) {
    const runOpen = xml.slice(firstRun.start, firstRun.openEnd);
    const text = renderTextRunLines(value.slice(original.length));
    replacements.push({ start: appendAfter, end: appendAfter, value: `${runOpen}${insertedStyle}${text}</w:r>` });
  }
  replacements.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const item of replacements) {
    parts.push(xml.slice(cursor, item.start), item.value);
    cursor = item.end;
  }
  parts.push(xml.slice(cursor));
  return parts.join('');
}
