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

function rawIndexNoEntities(raw: string, decodedOffset: number): number {
  if (decodedOffset < 0 || decodedOffset > raw.length) throw new Error('XML 字符偏移越界');
  if (decodedOffset > 0 && decodedOffset < raw.length && /[\uD800-\uDBFF]/.test(raw[decodedOffset - 1]) && /[\uDC00-\uDFFF]/.test(raw[decodedOffset])) {
    throw new Error('XML 字符偏移不可拆分');
  }
  return decodedOffset;
}

function rawOffset(raw: string, decodedOffset: number): number {
  if (!raw.includes('&')) return rawIndexNoEntities(raw, decodedOffset);
  let count = 0;
  for (const match of raw.matchAll(/&(?:#x[0-9a-fA-F]+|#[0-9]+|lt|gt|quot|apos|amp);|[\s\S]/gu)) {
    if (count === decodedOffset) return match.index;
    count += unescapeXml(match[0]).length;
    if (count > decodedOffset) throw new Error('XML 字符偏移不可拆分');
  }
  if (count !== decodedOffset) throw new Error('XML 字符偏移越界');
  return raw.length;
}

function hasActiveUnderline(rPr: string): boolean {
  if (!rPr) return false;
  const elements = xmlElements(rPr);
  const root = elements.findIndex(el => el.name === 'w:rPr' && el.parent === null);
  if (root < 0) return false;
  return elements.some(el => {
    if (el.parent !== root || el.name !== 'w:u') return false;
    const val = /\bw:val\s*=\s*["']([^"']+)["']/.exec(rPr.slice(el.start, el.openEnd))?.[1];
    return val !== 'none';
  });
}

function applyRunHighlight(rPr: string, yellow: boolean | string | null): string {
  return yellow === true ? injectHighlightYellow(rPr) : yellow === false ? rPr : setRunHighlight(rPr, yellow);
}

function isBlankOnlyText(text: string): boolean {
  return text.length > 0 && /^[_\uFF3F\s\u3000\t]+$/.test(text);
}

type ReplaceSpan =
  | { kind: 'keep'; origStart: number; origEnd: number }
  | { kind: 'replace'; origStart: number; origEnd: number; text: string; style: string };

export function replaceVisibleRange(xml: string, start: number, end: number, value: string, yellow: boolean | string | null = false, drawing = '', sealBookmarkIds: ReadonlySet<string> = new Set()): string {
  assertXmlCharacters(value);
  const allTokens = visibleTextPositions(xml);
  const affected = allTokens.filter(token => token.start < end && token.end > start);
  if (!affected.length || start < affected[0].start || end > affected[affected.length - 1].end || start >= end) throw new Error('文字范围无效');
  const original = affected.map(token => token.text.slice(Math.max(0, start - token.start), Math.min(token.text.length, end - token.start))).join('');
  let prefix = 0, suffix = 0;
  while (prefix < original.length && prefix < value.length && original[prefix] === value[prefix]) prefix++;
  if (prefix && /[\uD800-\uDBFF]/.test(original[prefix - 1]) && /[\uDC00-\uDFFF]/.test(original[prefix] ?? '')) prefix--;
  while (suffix < original.length - prefix && suffix < value.length - prefix && original[original.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
  if (suffix && /[\uDC00-\uDFFF]/.test(original[original.length - suffix]) && /[\uD800-\uDBFF]/.test(original[original.length - suffix - 1] ?? '')) suffix--;
  const elements = xmlElements(xml), childrenByParent = elementChildren(elements), last = affected[affected.length - 1];
  const coveredPendingLocal: Array<[number, number]> = [];
  if (xml.includes('_Seal_P_')) {
    const pendingStartXml = new Map<string, number>();
    for (const element of elements) {
      if (element.name !== 'w:bookmarkStart') continue;
      const open = xml.slice(element.start, element.openEnd);
      if (!/\bw:name\s*=\s*["']_Seal_P_/.test(open)) continue;
      const id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(open)?.[1];
      if (id) pendingStartXml.set(id, element.start);
    }
    if (pendingStartXml.size > 0) {
      for (const element of elements) {
        if (element.name !== 'w:bookmarkEnd') continue;
        const id = /\bw:id\s*=\s*["']([^"']+)["']/.exec(xml.slice(element.start, element.openEnd))?.[1];
        const startXml = id ? pendingStartXml.get(id) : undefined;
        if (startXml === undefined) continue;
        const bmStart = visibleOffsetFromTokens(allTokens, startXml);
        const bmEnd = visibleOffsetFromTokens(allTokens, element.end);
        if (bmStart < bmEnd && start <= bmStart && bmEnd <= end && (start < bmStart || bmEnd < end)) {
          coveredPendingLocal.push([bmStart - start, bmEnd - start]);
        }
      }
    }
  }
  if (coveredPendingLocal.length > 0) {
    const minCoveredStart = Math.min(...coveredPendingLocal.map(range => range[0]));
    const maxCoveredEnd = Math.max(...coveredPendingLocal.map(range => range[1]));
    prefix = Math.min(prefix, minCoveredStart);
    suffix = Math.min(suffix, Math.max(0, original.length - maxCoveredEnd));
  }
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
  const runPrByStart = new Map<number, string>();
  const tokenRunPrs = affected.map(token => {
    let cached = runPrByStart.get(token.run.start);
    if (cached === undefined) {
      cached = extractFirstRunPr(xml.slice(token.run.start, token.run.end));
      runPrByStart.set(token.run.start, cached);
    }
    return cached;
  });
  const tokFroms = affected.map(token => Math.max(0, token.start - start));
  const tokTos = affected.map(token => Math.min(original.length, token.end - start));
  const firstTokenAtOrAfter = (pos: number): number => {
    let lo = 0, hi = affected.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tokTos[mid] <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const coveredFallbackStyle = (() => {
    if (!coveredPendingLocal.length) return '';
    for (let k = 0; k < affected.length; k++) {
      const tFrom = tokFroms[k], tTo = tokTos[k];
      if (!coveredPendingLocal.some(([cs, ce]) => cs <= tFrom && tTo <= ce)) return tokenRunPrs[k];
    }
    return setRunHighlight(tokenRunPrs[0], null);
  })();
  const pickSlotStyle = (origStart: number, origEnd: number): string => {
    if (coveredPendingLocal.some(([cs, ce]) => origStart < ce && origEnd > cs)) return coveredFallbackStyle;
    if (origStart >= origEnd) {
      const idx = origStart > 0 ? firstTokenAtOrAfter(origStart - 1) : 0;
      return tokenRunPrs[Math.min(idx, affected.length - 1)] ?? tokenRunPrs[0];
    }
    const firstIdx = firstTokenAtOrAfter(origStart);
    const defaultStyle = tokenRunPrs[Math.min(firstIdx, affected.length - 1)] ?? tokenRunPrs[0];
    if (!isBlankOnlyText(original.slice(origStart, origEnd)) || hasActiveUnderline(defaultStyle)) return defaultStyle;
    for (let k = firstIdx; k < affected.length && tokFroms[k] < origEnd; k++) {
      const slice = original.slice(Math.max(origStart, tokFroms[k]), Math.min(origEnd, tokTos[k]));
      if (isBlankOnlyText(slice) && hasActiveUnderline(tokenRunPrs[k])) return tokenRunPrs[k];
    }
    return defaultStyle;
  };

  const rawSpans: ReplaceSpan[] = [];
  if (prefix > 0) rawSpans.push({ kind: 'keep', origStart: 0, origEnd: prefix });
  const origMidStart = prefix, origMidEnd = original.length - suffix;
  const midNew = replacementValue.slice(prefix, replacementValue.length - suffix);
  if (origMidStart < origMidEnd || midNew.length > 0) {
    let aligned = false;
    if (origMidStart < origMidEnd && midNew.length > 0 && coveredPendingLocal.length === 0) {
      const styles = new Set<string>();
      const anchors: Array<{ origStart: number; origEnd: number; text: string }> = [];
      let hasBlankPiece = false;
      for (let k = firstTokenAtOrAfter(origMidStart); k < affected.length && tokFroms[k] < origMidEnd; k++) {
        styles.add(tokenRunPrs[k]);
        const segStart = Math.max(origMidStart, tokFroms[k]), segEnd = Math.min(origMidEnd, tokTos[k]);
        const seg = original.slice(segStart, segEnd);
        let pos = segStart;
        for (const part of seg.match(/([_\uFF3F\s\u3000]+|[^_\uFF3F\s\u3000]+)/g) ?? []) {
          const partEnd = pos + part.length;
          if (/^[_\uFF3F\s\u3000]+$/.test(part)) hasBlankPiece = true;
          else if (anchors.length > 0 && anchors[anchors.length - 1].origEnd === pos) {
            anchors[anchors.length - 1].origEnd = partEnd;
            anchors[anchors.length - 1].text += part;
          } else anchors.push({ origStart: pos, origEnd: partEnd, text: part });
          pos = partEnd;
        }
      }
      if (styles.size > 1 && hasBlankPiece && anchors.length > 0) {
        const candidate: ReplaceSpan[] = [];
        let newCursor = 0, origCursor = origMidStart, matchedAll = true;
        for (const anchor of anchors) {
          const hit = midNew.indexOf(anchor.text, newCursor);
          if (hit < 0) { matchedAll = false; break; }
          if (origCursor < anchor.origStart || newCursor < hit) {
            candidate.push({ kind: 'replace', origStart: origCursor, origEnd: anchor.origStart, text: midNew.slice(newCursor, hit), style: pickSlotStyle(origCursor, anchor.origStart) });
          }
          candidate.push({ kind: 'keep', origStart: anchor.origStart, origEnd: anchor.origEnd });
          origCursor = anchor.origEnd;
          newCursor = hit + anchor.text.length;
        }
        if (matchedAll) {
          if (origCursor < origMidEnd || newCursor < midNew.length) {
            candidate.push({ kind: 'replace', origStart: origCursor, origEnd: origMidEnd, text: midNew.slice(newCursor), style: pickSlotStyle(origCursor, origMidEnd) });
          }
          rawSpans.push(...candidate);
          aligned = true;
        }
      }
    }
    if (!aligned) {
      rawSpans.push({ kind: 'replace', origStart: origMidStart, origEnd: origMidEnd, text: midNew, style: pickSlotStyle(origMidStart, origMidEnd) });
    }
  }
  if (suffix > 0) rawSpans.push({ kind: 'keep', origStart: original.length - suffix, origEnd: original.length });

  const spans: ReplaceSpan[] = [];
  for (const span of rawSpans) {
    if (span.kind === 'keep' && span.origStart === span.origEnd) continue;
    if (span.kind === 'replace' && span.origStart === span.origEnd && span.text === '') continue;
    const prev = spans[spans.length - 1];
    if (span.kind === 'keep' && prev?.kind === 'keep' && prev.origEnd === span.origStart) prev.origEnd = span.origEnd;
    else spans.push({ ...span });
  }

  const runGroups = new Map<number, Array<{ token: VisibleTextToken; index: number }>>();
  for (const [index, token] of affected.entries()) {
    const group = runGroups.get(token.run.start) ?? [];
    group.push({ token, index });
    runGroups.set(token.run.start, group);
  }
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let spanIdx = 0;
  let lastEmittedStyle = tokenRunPrs[affected.length - 1];
  for (const [runStart, entries] of runGroups) {
    const runIndex = runIndexByStart.get(runStart) ?? -1;
    if (runIndex < 0) throw new Error('文字运行节点无效');
    const run = elements[runIndex];
    const runOpen = xml.slice(run.start, run.openEnd);
    const style = runPrByStart.get(runStart) ?? extractFirstRunPr(xml.slice(run.start, run.end));
    const affectedByStart = new Map(entries.map(entry => [entry.token.element.start, entry]));
    const outputRuns: string[] = [];
    let originalNodes: string[] = [];
    const flushOriginal = () => {
      if (originalNodes.length > 0) {
        outputRuns.push(`${runOpen}${style}${originalNodes.join('')}</w:r>`);
        originalNodes = [];
      }
    };
    const emitInserted = (text: string, runStyle: string, extra = '') => {
      if (!text && !extra) return;
      flushOriginal();
      const props = applyRunHighlight(runStyle, yellow);
      outputRuns.push(`${runOpen}${props}${text ? renderTextRunLines(text) : ''}${extra}</w:r>`);
      lastEmittedStyle = runStyle;
    };
    const flushZeroLengthAt = (pos: number) => {
      while (spanIdx < spans.length && spans[spanIdx].origStart === pos && spans[spanIdx].origEnd === pos) {
        const zeroSpan = spans[spanIdx++];
        if (zeroSpan.kind === 'replace' && zeroSpan.text) emitInserted(zeroSpan.text, zeroSpan.style);
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
      const fromPos = tokFroms[index], toPos = tokTos[index];
      const raw = child.name === 'w:t' ? xml.slice(child.openEnd, child.closeStart) : '';
      const open = child.name === 'w:t' ? xml.slice(child.start, child.openEnd) : '';
      const close = child.name === 'w:t' ? xml.slice(child.closeStart, child.end) : '';
      const from = child.name === 'w:t' ? Math.max(0, start - token.start) : 0;
      const to = child.name === 'w:t' ? Math.min(token.text.length, end - token.start) : 0;
      const rawFrom = child.name === 'w:t' ? rawOffset(raw, from) : 0;
      const rawTo = child.name === 'w:t' ? rawOffset(raw, to) : 0;
      const beforeRaw = child.name === 'w:t' ? raw.slice(0, rawFrom) : '';
      const midRaw = child.name === 'w:t' ? raw.slice(rawFrom, rawTo) : '';
      const afterRaw = child.name === 'w:t' ? raw.slice(rawTo) : '';

      const singleKeepThroughToken =
        child.name === 'w:t' &&
        yellow === false &&
        spanIdx < spans.length &&
        spans[spanIdx].kind === 'keep' &&
        spans[spanIdx].origStart <= fromPos &&
        toPos <= spans[spanIdx].origEnd &&
        (!afterRaw || !(toPos === original.length && (spanIdx + 1 < spans.length || (index === affected.length - 1 && drawing))));

      if (singleKeepThroughToken) {
        originalNodes.push(`${open}${raw}${close}`);
        lastEmittedStyle = style;
        if (toPos === spans[spanIdx].origEnd) spanIdx++;
        if (toPos === original.length) {
          flushZeroLengthAt(original.length);
          if (index === affected.length - 1 && drawing) {
            flushOriginal();
            outputRuns.push(`${runOpen}${applyRunHighlight(lastEmittedStyle, yellow)}${drawing}</w:r>`);
          }
        }
        continue;
      }

      if (beforeRaw) originalNodes.push(`${open}${beforeRaw}${close}`);
      const midHasEntity = midRaw.includes('&');
      let midRawPos = 0, midDecPos = 0;
      const advanceMidRaw = (targetDec: number): number => {
        if (!midHasEntity) return rawIndexNoEntities(midRaw, targetDec);
        while (midDecPos < targetDec && midRawPos < midRaw.length) {
          if (midRaw[midRawPos] === '&') {
            const semi = midRaw.indexOf(';', midRawPos + 1);
            if (semi < 0) throw new Error('XML 实体无效');
            midDecPos += unescapeXml(midRaw.slice(midRawPos, semi + 1)).length;
            midRawPos = semi + 1;
          } else {
            const cp = midRaw.codePointAt(midRawPos)!;
            const step = cp > 0xffff ? 2 : 1;
            midDecPos += step;
            midRawPos += step;
          }
          if (midDecPos > targetDec) throw new Error('XML 字符偏移不可拆分');
        }
        if (midDecPos !== targetDec) throw new Error('XML 字符偏移越界');
        return midRawPos;
      };
      let cursor = fromPos;
      while (cursor < toPos && spanIdx < spans.length) {
        flushZeroLengthAt(cursor);
        if (spanIdx >= spans.length) break;
        const span = spans[spanIdx];
        if (span.origStart >= toPos) break;
        const segStart = Math.max(cursor, span.origStart);
        const segEnd = Math.min(toPos, span.origEnd);
        if (segStart < segEnd) {
          if (span.kind === 'keep') {
            let sliceXml: string;
            if (child.name === 'w:t') {
              const sOff = advanceMidRaw(segStart - fromPos);
              const eOff = advanceMidRaw(segEnd - fromPos);
              sliceXml = `<w:t xml:space="preserve">${midRaw.slice(sOff, eOff)}</w:t>`;
            } else {
              sliceXml = xml.slice(child.start, child.end);
            }
            if (yellow === false) originalNodes.push(sliceXml);
            else {
              flushOriginal();
              outputRuns.push(`${runOpen}${applyRunHighlight(style, yellow)}${sliceXml}</w:r>`);
            }
            lastEmittedStyle = style;
          } else if (segStart === span.origStart && span.text) {
            emitInserted(span.text, span.style);
          }
          cursor = segEnd;
        }
        if (cursor >= span.origEnd) spanIdx++;
      }
      if (toPos === original.length) flushZeroLengthAt(original.length);
      if (index === affected.length - 1 && drawing) {
        flushOriginal();
        outputRuns.push(`${runOpen}${applyRunHighlight(lastEmittedStyle, yellow)}${drawing}</w:r>`);
      }
      if (afterRaw) originalNodes.push(`${open}${afterRaw}${close}`);
    }
    flushOriginal();
    replacements.push({ start: run.start, end: run.end, value: outputRuns.join('') });
  }
  if (appendAfter >= 0) {
    const runOpen = xml.slice(last.run.start, last.run.openEnd);
    const text = renderTextRunLines(value.slice(original.length));
    replacements.push({ start: appendAfter, end: appendAfter, value: `${runOpen}${applyRunHighlight(tokenRunPrs[affected.length - 1], yellow)}${text}</w:r>` });
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
