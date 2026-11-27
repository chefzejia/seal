import { resolveAddress } from './addresses.js';
import { layoutBox } from './layout.js';
import { styleChain, wordStyles, xmlAttributes, type WordStyle, type WordStyles } from './outline.js';
import { sealRanges } from './seal-ranges.js';
import { paragraphText } from './visible-text.js';
import { escapeXml, parseDocumentBody, unescapeXml, xmlElements } from './xml.js';

export interface InsertTocEdit {
  op: 'insert_toc';
  at: string;
  position: 'before' | 'after';
  maxLevel?: 1 | 2 | 3;
}

export interface TocHeading {
  blockIndex: number;
  pIndex: number;
  level: number;
  title: string;
  bookmarkName: string;
  beforeToc: boolean;
}

export interface TocPageHint {
  anchorTitle?: string;
  tocPageIndices?: readonly number[];
}

export interface TocRunSpan {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
}

export interface TocFieldSpan {
  startBlockIdx: number;
  endBlockIdx: number;
  /** Offset in blocks[startBlockIdx].xml where the outer field starts (<w:fldChar> or <w:fldSimple>). */
  fieldStartOffset: number;
  /** Offset in blocks[endBlockIdx].xml where the outer field ends (<w:fldChar> or <w:fldSimple>). */
  fieldEndOffset: number;
  /** Direct-child <w:r> of <w:p> containing begin fldChar (undefined for fldSimple, null if nested inside composite). */
  beginRun?: TocRunSpan | null;
  /** Direct-child <w:r> of <w:p> containing end fldChar (undefined for fldSimple, null if nested inside composite). */
  endRun?: TocRunSpan | null;
  /** True when non-paragraph blocks (e.g. w:tbl) appear between field begin and end. */
  containsNonParagraph?: boolean;
  instr: string;
}

export interface TocApplyResult {
  xml: string;
  entries: TocHeading[];
  anchorTitle?: string;
  anchorParagraphUpdated: boolean;
  removedParagraphs: number;
  insertedParagraphs: number;
  insertAtParagraphIndex: number;
  paragraphsBeforeReplaceRange: number;
  oldRangeParagraphCount: number;
  newRangeParagraphCount: number;
  insertedAddresses: string[];
}

const TOC_ANCHOR_NAME_PATTERN = /^(?:目录|contents|tableofcontents)$/i;
const TOC_FIELD_INSTR_PATTERN = /^\s*TOC\b/i;
const PAGEREF_INSTR_PATTERN = /^\s*PAGEREF\s+(\S+)(?:\s|$)/i;
const HEADING_STYLE_PATTERN = /^(?:heading|标题)\s*([1-9])$/i;
const TOC_BOOKMARK_NAME_PATTERN = /^_TocSeal_(\d+)$/;

function styleHeadingLevel(chain: readonly WordStyle[], defaults?: number): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    const level = chain[i].outlineLevel;
    if (level !== undefined) return level === 9 ? 0 : level + 1;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const heading = HEADING_STYLE_PATTERN.exec(chain[i].name ?? chain[i].id);
    if (heading) return Number(heading[1]);
  }
  return defaults !== undefined && defaults !== 9 ? defaults + 1 : 0;
}

function paragraphHeadingLevel(paragraphXml: string, styles: WordStyles): number {
  const elements = xmlElements(paragraphXml);
  const p = elements.findIndex(element => element.name === 'w:p');
  if (p < 0) return 0;
  const property = elements.findIndex(element => element.parent === p && element.name === 'w:pPr');
  const explicit = elements.find(element => element.parent === property && element.name === 'w:outlineLvl');
  const style = elements.find(element => element.parent === property && element.name === 'w:pStyle');
  const explicitLevel = explicit ? xmlAttributes(paragraphXml, explicit).get('w:val') : undefined;
  const styleId = style ? xmlAttributes(paragraphXml, style).get('w:val') : styles.defaultParagraph;
  if (explicit) return explicitLevel !== undefined && /^[0-8]$/.test(explicitLevel) ? Number(explicitLevel) + 1 : 0;
  let level = styleHeadingLevel(styleChain(styles, styleId, 'paragraph'), styles.defaultOutline);
  if (!level && !styles.styles.has(styleId ?? '')) {
    const heading = HEADING_STYLE_PATTERN.exec(styleId ?? '');
    if (heading) level = Number(heading[1]);
  }
  return level;
}

export function validateInsertTocEdit(
  documentXml: string,
  edit: { at?: unknown; position?: unknown; maxLevel?: unknown; pending?: unknown; thirdPartyHolder?: unknown },
): { at: string; position: 'before' | 'after'; maxLevel: 1 | 2 | 3 } {
  if (edit.pending !== undefined || edit.thirdPartyHolder !== undefined) {
    throw new Error('insert_toc 不支持 pending 或 thirdPartyHolder');
  }
  if (edit.position !== 'before' && edit.position !== 'after') {
    throw new Error('insert_toc 的 position 必须为 before 或 after');
  }
  const maxLevel = edit.maxLevel === undefined ? 3 : edit.maxLevel;
  if (typeof maxLevel !== 'number' || !Number.isInteger(maxLevel) || (maxLevel !== 1 && maxLevel !== 2 && maxLevel !== 3)) {
    throw new Error('insert_toc 的 maxLevel 必须为 1、2 或 3');
  }
  if (typeof edit.at !== 'string' || !/^(?:p|t):(?:0|[1-9]\d*)$/.test(edit.at)) {
    throw new Error('insert_toc 仅支持正文顶层段落或表格地址（p:N 或 t:N）');
  }
  const resolved = resolveAddress(documentXml, edit.at);
  if (resolved.kind !== 'paragraph' && resolved.kind !== 'table') {
    throw new Error('insert_toc 仅支持正文顶层段落或表格地址（p:N 或 t:N）');
  }
  return { at: edit.at, position: edit.position, maxLevel };
}

/** Find top-level TOC field spans across body blocks, respecting nested PAGEREF fields. */
export function findTopLevelTocFields(documentXml: string): TocFieldSpan[] {
  const { blocks } = parseDocumentBody(documentXml);
  const stack: Array<{ startBlockIdx: number; fieldStartOffset: number; beginRun?: TocRunSpan | null; instr: string; separated: boolean }> = [];
  const fields: TocFieldSpan[] = [];
  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const block = blocks[bIdx];
    if (block.kind !== 'paragraph') continue;
    const elements = xmlElements(block.xml);
    const pIdx = elements.findIndex(el => el.name === 'w:p' && el.parent === null);
    for (let elIdx = 0; elIdx < elements.length; elIdx++) {
      const element = elements[elIdx];
      if (element.name === 'w:fldSimple' && stack.length === 0) {
        const instr = xmlAttributes(block.xml, element).get('w:instr') ?? '';
        if (TOC_FIELD_INSTR_PATTERN.test(instr)) {
          fields.push({
            startBlockIdx: bIdx,
            endBlockIdx: bIdx,
            fieldStartOffset: element.start,
            fieldEndOffset: element.end,
            beginRun: element.parent === pIdx ? undefined : null,
            endRun: element.parent === pIdx ? undefined : null,
            instr,
          });
        }
        continue;
      }
      if (element.name === 'w:fldChar') {
        const kind = xmlAttributes(block.xml, element).get('w:fldCharType');
        const parentEl = element.parent !== null ? elements[element.parent] : undefined;
        const directRunSpan: TocRunSpan | null =
          parentEl && parentEl.name === 'w:r' && parentEl.parent === pIdx
            ? { start: parentEl.start, openEnd: parentEl.openEnd, closeStart: parentEl.closeStart, end: parentEl.end }
            : null;
        if (kind === 'begin') {
          stack.push({
            startBlockIdx: bIdx,
            fieldStartOffset: element.start,
            beginRun: stack.length === 0 ? directRunSpan : undefined,
            instr: '',
            separated: false,
          });
        } else if (kind === 'separate') {
          if (stack.length > 0) stack[stack.length - 1].separated = true;
        } else if (kind === 'end') {
          const frame = stack.pop();
          if (frame && stack.length === 0 && TOC_FIELD_INSTR_PATTERN.test(frame.instr)) {
            const slice = blocks.slice(frame.startBlockIdx, bIdx + 1);
            const containsNonParagraph = !slice.every(
              item => item.kind === 'paragraph' || (item.kind === 'other' && !item.xml.trim()),
            );
            fields.push({
              startBlockIdx: frame.startBlockIdx,
              endBlockIdx: bIdx,
              fieldStartOffset: frame.fieldStartOffset,
              fieldEndOffset: element.end,
              beginRun: frame.beginRun,
              endRun: directRunSpan,
              containsNonParagraph,
              instr: frame.instr,
            });
          }
        }
      } else if (element.name === 'w:instrText' && stack.length > 0 && !stack[stack.length - 1].separated) {
        stack[stack.length - 1].instr += unescapeXml(block.xml.slice(element.openEnd, element.closeStart));
      }
    }
  }
  return fields;
}

function setParagraphOutlineLevel(paragraphXml: string, level: number): string {
  const elements = xmlElements(paragraphXml);
  const p = elements.findIndex(element => element.name === 'w:p' && element.parent === null);
  if (p < 0) return paragraphXml;
  const pEl = elements[p];
  if (pEl.openEnd === pEl.closeStart) {
    return `${paragraphXml.slice(0, pEl.openEnd - 2)}><w:pPr><w:outlineLvl w:val="${level}"/></w:pPr></w:p>`;
  }
  const pPrIndex = elements.findIndex(element => element.parent === p && element.name === 'w:pPr');
  if (pPrIndex < 0) {
    return `${paragraphXml.slice(0, pEl.openEnd)}<w:pPr><w:outlineLvl w:val="${level}"/></w:pPr>${paragraphXml.slice(pEl.openEnd)}`;
  }
  const pPr = elements[pPrIndex];
  const tag = `<w:outlineLvl w:val="${level}"/>`;
  if (pPr.openEnd === pPr.closeStart) {
    return `${paragraphXml.slice(0, pPr.start)}<w:pPr>${tag}</w:pPr>${paragraphXml.slice(pPr.end)}`;
  }
  const existing = elements.filter(element => element.parent === pPrIndex && element.name === 'w:outlineLvl');
  if (existing.length > 0) {
    let result = paragraphXml;
    for (let i = existing.length - 1; i >= 0; i--) {
      const node = existing[i];
      result = result.slice(0, node.start) + (i === 0 ? tag : '') + result.slice(node.end);
    }
    return result;
  }
  const trailing = elements.find(
    element =>
      element.parent === pPrIndex &&
      ['w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange'].includes(element.name),
  );
  const insertAt = trailing ? trailing.start : pPr.closeStart;
  return `${paragraphXml.slice(0, insertAt)}${tag}${paragraphXml.slice(insertAt)}`;
}

function stripParagraphSectPr(pPrXml: string): string {
  if (!pPrXml) return '';
  const elements = xmlElements(pPrXml);
  const root = elements.findIndex(el => el.name === 'w:pPr' && el.parent === null);
  if (root < 0) return pPrXml;
  const sectPrs = elements.filter(el => el.parent === root && el.name === 'w:sectPr');
  if (!sectPrs.length) return pPrXml;
  let result = pPrXml;
  for (let i = sectPrs.length - 1; i >= 0; i--) {
    result = result.slice(0, sectPrs[i].start) + result.slice(sectPrs[i].end);
  }
  const rootEl = xmlElements(result)[0];
  if (!rootEl || result.slice(rootEl.openEnd, rootEl.closeStart).trim() === '') return '';
  return result;
}

function injectParagraphSectPr(paragraphXml: string, sectPrXml: string): string {
  if (!sectPrXml) return paragraphXml;
  const elements = xmlElements(paragraphXml);
  const p = elements.findIndex(el => el.name === 'w:p' && el.parent === null);
  if (p < 0) return paragraphXml;
  const pEl = elements[p];
  if (pEl.openEnd === pEl.closeStart) {
    return `${paragraphXml.slice(0, pEl.openEnd - 2)}><w:pPr>${sectPrXml}</w:pPr></w:p>`;
  }
  const pPrIdx = elements.findIndex(el => el.parent === p && el.name === 'w:pPr');
  if (pPrIdx < 0) {
    return `${paragraphXml.slice(0, pEl.openEnd)}<w:pPr>${sectPrXml}</w:pPr>${paragraphXml.slice(pEl.openEnd)}`;
  }
  const pPr = elements[pPrIdx];
  if (pPr.openEnd === pPr.closeStart) {
    return `${paragraphXml.slice(0, pPr.start)}<w:pPr>${sectPrXml}</w:pPr>${paragraphXml.slice(pPr.end)}`;
  }
  const existing = elements.filter(el => el.parent === pPrIdx && el.name === 'w:sectPr');
  if (existing.length > 0) {
    let result = paragraphXml;
    for (let i = existing.length - 1; i >= 0; i--) {
      result = result.slice(0, existing[i].start) + (i === 0 ? sectPrXml : '') + result.slice(existing[i].end);
    }
    return result;
  }
  const pPrChange = elements.find(el => el.parent === pPrIdx && el.name === 'w:pPrChange');
  const insertAt = pPrChange ? pPrChange.start : pPr.closeStart;
  return `${paragraphXml.slice(0, insertAt)}${sectPrXml}${paragraphXml.slice(insertAt)}`;
}

function extractDirectParagraphProperties(paragraphXml: string): { openTag: string; pPr: string; contentStart: number; closeStart: number; sectPr: string } {
  const elements = xmlElements(paragraphXml);
  const p = elements.findIndex(el => el.name === 'w:p' && el.parent === null);
  if (p < 0) throw new Error('段落 XML 无效');
  const pEl = elements[p];
  const pPrEl = elements.find(el => el.parent === p && el.name === 'w:pPr');
  const pPr = pPrEl ? paragraphXml.slice(pPrEl.start, pPrEl.end) : '';
  const sectPrEl = pPrEl
    ? elements.find(el => el.parent === elements.indexOf(pPrEl) && el.name === 'w:sectPr')
    : undefined;
  const sectPr = sectPrEl ? paragraphXml.slice(sectPrEl.start, sectPrEl.end) : '';
  return {
    openTag: paragraphXml.slice(pEl.start, pEl.openEnd),
    pPr,
    contentStart: pPrEl ? pPrEl.end : pEl.openEnd,
    closeStart: pEl.closeStart,
    sectPr,
  };
}

function hasSignificantBodyContent(fragment: string): boolean {
  if (!fragment.trim()) return false;
  // Parse wrapped fragment to check whether any non-whitespace XML nodes exist.
  const wrapped = `<w:p>${fragment}</w:p>`;
  const elements = xmlElements(wrapped);
  return elements.length > 1;
}

function splitRunOutsideFieldChar(
  blockXml: string,
  runSpan: TocRunSpan,
  fieldOffset: number,
  side: 'prefix' | 'suffix',
): string {
  const runXml = blockXml.slice(runSpan.start, runSpan.end);
  const runElems = xmlElements(runXml);
  const root = runElems.findIndex(el => el.name === 'w:r' && el.parent === null);
  if (root < 0) return '';
  const rPrEl = runElems.find(el => el.parent === root && el.name === 'w:rPr');
  const rPrXml = rPrEl ? runXml.slice(rPrEl.start, rPrEl.end) : '';
  const relOffset = fieldOffset - runSpan.start;
  const keptChildren: string[] = [];
  for (const el of runElems) {
    if (el.parent !== root || el.name === 'w:rPr') continue;
    const keep = side === 'prefix' ? el.end <= relOffset : el.start >= relOffset;
    if (!keep) continue;
    if (el.name === 'w:t' && el.openEnd === el.closeStart) continue;
    keptChildren.push(runXml.slice(el.start, el.end));
  }
  if (!keptChildren.length) return '';
  const runOpen = blockXml.slice(runSpan.start, runSpan.openEnd);
  return `${runOpen}${rPrXml}${keptChildren.join('')}</w:r>`;
}

function splitPreservedBoundary(
  blockXml: string,
  fieldOffset: number,
  runSpan: TocRunSpan | null | undefined,
  side: 'prefix' | 'suffix',
): { fragment: string; openTag: string; pPr: string } {
  const info = extractDirectParagraphProperties(blockXml);
  if (runSpan === null) {
    throw new Error('旧目录域边界位于复合元素内部，无法安全拆分保留外围内容');
  }
  let rawSlice: string;
  if (runSpan) {
    const splitRun = splitRunOutsideFieldChar(blockXml, runSpan, fieldOffset, side);
    rawSlice =
      side === 'prefix'
        ? blockXml.slice(info.contentStart, runSpan.start) + splitRun
        : splitRun + blockXml.slice(runSpan.end, info.closeStart);
  } else {
    rawSlice =
      side === 'prefix'
        ? blockXml.slice(info.contentStart, fieldOffset)
        : blockXml.slice(fieldOffset, info.closeStart);
  }
  if (!hasSignificantBodyContent(rawSlice)) {
    return { fragment: '', openTag: info.openTag, pPr: info.pPr };
  }
  try {
    xmlElements(`<w:p>${rawSlice}</w:p>`);
  } catch {
    throw new Error('旧目录域边界位于复合元素内部，无法安全拆分保留外围内容');
  }
  return { fragment: rawSlice, openTag: info.openTag, pPr: info.pPr };
}

function wrapParagraphBookmark(paragraphXml: string, id: number, name: string): string {
  const elements = xmlElements(paragraphXml);
  const p = elements.findIndex(element => element.name === 'w:p' && element.parent === null);
  if (p < 0) return paragraphXml;
  const pEl = elements[p];
  if (pEl.openEnd === pEl.closeStart) return paragraphXml;
  const pPr = elements.find(element => element.parent === p && element.name === 'w:pPr');
  const startInsert = pPr ? pPr.end : pEl.openEnd;
  const endInsert = pEl.closeStart;
  const startTag = `<w:bookmarkStart w:id="${id}" w:name="${escapeXml(name)}"/>`;
  const endTag = `<w:bookmarkEnd w:id="${id}"/>`;
  return (
    paragraphXml.slice(0, startInsert) +
    startTag +
    paragraphXml.slice(startInsert, endInsert) +
    endTag +
    paragraphXml.slice(endInsert)
  );
}

function extractSafeRunFontProps(rPrXml: string): { rFonts?: string; sz?: string; szCs?: string } {
  if (!rPrXml) return {};
  const elements = xmlElements(rPrXml);
  const root = elements.findIndex(element => element.name === 'w:rPr' && element.parent === null);
  if (root < 0) return {};
  let rFonts: string | undefined;
  let sz: string | undefined;
  let szCs: string | undefined;
  for (const el of elements) {
    if (el.parent !== root) continue;
    if (el.name === 'w:rFonts') rFonts = rPrXml.slice(el.start, el.end);
    else if (el.name === 'w:sz') sz = rPrXml.slice(el.start, el.end);
    else if (el.name === 'w:szCs') szCs = rPrXml.slice(el.start, el.end);
  }
  return { rFonts, sz, szCs };
}

function extractBaseTocRunPr(documentXml: string, stylesXml: string, anchorXml: string): string {
  let rFonts: string | undefined;
  let sz: string | undefined;
  let szCs: string | undefined;
  const merge = (props: { rFonts?: string; sz?: string; szCs?: string }) => {
    if (props.rFonts) rFonts = props.rFonts;
    if (props.sz) sz = props.sz;
    if (props.szCs) szCs = props.szCs;
  };
  if (stylesXml) {
    const elements = xmlElements(stylesXml);
    const root = elements.findIndex(element => element.name === 'w:styles');
    const defaults = elements.findIndex(element => element.parent === root && element.name === 'w:docDefaults');
    const rPrDefault = elements.findIndex(element => element.parent === defaults && element.name === 'w:rPrDefault');
    const defaultRPr = elements.find(element => element.parent === rPrDefault && element.name === 'w:rPr');
    if (defaultRPr) merge(extractSafeRunFontProps(stylesXml.slice(defaultRPr.start, defaultRPr.end)));

    const styleNodes = elements.filter(element => element.parent === root && element.name === 'w:style');
    const normalStyle =
      styleNodes.find(node => {
        const attrs = xmlAttributes(stylesXml, node);
        return attrs.get('w:type') === 'paragraph' && ['1', 'true', 'on'].includes(attrs.get('w:default') ?? '');
      }) ??
      styleNodes.find(node => {
        const attrs = xmlAttributes(stylesXml, node);
        return attrs.get('w:type') === 'paragraph' && attrs.get('w:styleId') === 'Normal';
      });
    if (normalStyle) {
      const styleIdx = elements.indexOf(normalStyle);
      const styleRPr = elements.find(element => element.parent === styleIdx && element.name === 'w:rPr');
      if (styleRPr) merge(extractSafeRunFontProps(stylesXml.slice(styleRPr.start, styleRPr.end)));
    }
  }
  if (!rFonts || !sz) {
    const styles = wordStyles(stylesXml);
    const { blocks } = parseDocumentBody(documentXml);
    for (const block of blocks) {
      if (block.kind !== 'paragraph') continue;
      if (paragraphHeadingLevel(block.xml, styles) > 0) continue;
      if (!paragraphText(block.xml).trim()) continue;
      const elems = xmlElements(block.xml);
      const runRPr = elems.find(el => el.name === 'w:rPr' && el.parent !== null && elems[el.parent].name === 'w:r');
      if (runRPr) {
        const props = extractSafeRunFontProps(block.xml.slice(runRPr.start, runRPr.end));
        if (!rFonts && props.rFonts) rFonts = props.rFonts;
        if (!sz && props.sz) sz = props.sz;
        if (!szCs && props.szCs) szCs = props.szCs;
      }
      if (rFonts && sz) break;
    }
  }
  if (!rFonts) {
    const elems = xmlElements(anchorXml);
    const runRPr = elems.find(el => el.name === 'w:rPr' && el.parent !== null && elems[el.parent].name === 'w:r');
    if (runRPr) {
      const props = extractSafeRunFontProps(anchorXml.slice(runRPr.start, runRPr.end));
      if (props.rFonts) rFonts = props.rFonts;
    }
  }
  const inner = `${rFonts ?? ''}${sz ?? ''}${szCs ?? ''}`;
  return inner ? `<w:rPr>${inner}</w:rPr>` : '';
}

export function findAdjacentTocField(
  documentXml: string,
  stylesXml: string,
  at: string,
  position: 'before' | 'after',
  maxLevel: 1 | 2 | 3 = 3,
): TocFieldSpan | undefined {
  const { blocks } = parseDocumentBody(documentXml);
  const targetMatch = /^([pt]):(\d+)$/.exec(at);
  if (!targetMatch) return undefined;
  const targetKind = targetMatch[1] === 'p' ? 'paragraph' : 'table';
  const targetIndex = Number(targetMatch[2]);
  const anchorBlockIdx = blocks.findIndex(b => b.kind === targetKind && b.index === targetIndex);
  if (anchorBlockIdx < 0) return undefined;

  const styles = wordStyles(stylesXml);
  const tocFields = findTopLevelTocFields(documentXml);
  const step = position === 'after' ? 1 : -1;
  for (let idx = anchorBlockIdx + step; idx >= 0 && idx < blocks.length; idx += step) {
    const b = blocks[idx];
    if (b.kind === 'other') {
      if (b.xml.trim()) break;
      continue;
    }
    if (b.kind !== 'paragraph') break;
    const hit = tocFields.find(f => (position === 'after' ? f.startBlockIdx === idx : f.endBlockIdx === idx));
    if (hit) return hit;
    const pLevel = paragraphHeadingLevel(b.xml, styles);
    if ((pLevel >= 1 && pLevel <= maxLevel) || TOC_ANCHOR_NAME_PATTERN.test(paragraphText(b.xml).replace(/\s+/g, ''))) {
      break;
    }
  }
  return undefined;
}

export function hasCustomPageNumbering(documentXml: string): boolean {
  const elements = xmlElements(documentXml);
  let firstSectPr = -1;
  for (let i = 0; i < elements.length; i++) {
    if (elements[i].name === 'w:sectPr') {
      firstSectPr = i;
      break;
    }
  }
  for (const el of elements) {
    if (el.name !== 'w:pgNumType') continue;
    const attrs = xmlAttributes(documentXml, el);
    const fmt = attrs.get('w:fmt');
    if (fmt !== undefined && fmt !== 'decimal') return true;
    if (attrs.has('w:start')) {
      const startVal = attrs.get('w:start');
      // Section 0 starting at 1 in decimal is standard continuous numbering
      // (emitted by LibreOffice .doc -> .docx); any non-1 start or restart
      // on a subsequent section diverges from physical page order.
      if (startVal !== '1' || el.parent !== firstSectPr) return true;
    }
  }
  return false;
}

export function applyInsertToc(
  documentXml: string,
  edit: InsertTocEdit,
  stylesXml = '',
  options: { placeholderPage?: string } = {},
): TocApplyResult {
  const validated = validateInsertTocEdit(documentXml, edit);
  const { prefixXml, blocks, suffixXml } = parseDocumentBody(documentXml);
  const bodyOpenEnd = prefixXml.length;

  const targetMatch = /^([pt]):(\d+)$/.exec(validated.at)!;
  const targetKind = targetMatch[1] === 'p' ? 'paragraph' : 'table';
  const targetIndex = Number(targetMatch[2]);
  const anchorBlockIdx = blocks.findIndex(b => b.kind === targetKind && b.index === targetIndex);
  if (anchorBlockIdx < 0) throw new Error(`地址不存在：${validated.at}`);

  const styles = wordStyles(stylesXml);
  const tocFields = findTopLevelTocFields(documentXml);
  for (const existing of tocFields) {
    if (existing.startBlockIdx <= anchorBlockIdx && anchorBlockIdx <= existing.endBlockIdx) {
      throw new Error('不能在已有目录域内部插入嵌套目录');
    }
  }
  const replaceField = findAdjacentTocField(
    documentXml,
    stylesXml,
    validated.at,
    validated.position,
    validated.maxLevel,
  );

  let preservedPrefixPara = '';
  let preservedSuffixPara = '';
  let preservedSectPr = '';
  if (replaceField) {
    if (replaceField.containsNonParagraph) {
      throw new Error('旧目录域包含表格等非段落块，无法安全原位刷新');
    }
    const spanStart = bodyOpenEnd + blocks[replaceField.startBlockIdx].startOffset + replaceField.fieldStartOffset;
    const spanEnd = bodyOpenEnd + blocks[replaceField.endBlockIdx].startOffset + replaceField.fieldEndOffset;
    for (const range of sealRanges(documentXml)) {
      const startsInside = spanStart <= range.startXml && range.startXml < spanEnd;
      const endsInside = spanStart < range.endXml && range.endXml <= spanEnd;
      if (startsInside !== endsInside) {
        throw new Error('待替换的旧目录与 Seal 范围部分交叉');
      }
    }
    const bookmarkSpans = new Map<string, { hasInside: boolean; hasOutside: boolean }>();
    for (const el of xmlElements(documentXml)) {
      if (el.name !== 'w:bookmarkStart' && el.name !== 'w:bookmarkEnd') continue;
      const id = xmlAttributes(documentXml, el).get('w:id');
      if (id === undefined) continue;
      const entry = bookmarkSpans.get(id) ?? { hasInside: false, hasOutside: false };
      if (spanStart <= el.start && el.start < spanEnd) entry.hasInside = true;
      else entry.hasOutside = true;
      bookmarkSpans.set(id, entry);
    }
    for (const span of bookmarkSpans.values()) {
      if (span.hasInside && span.hasOutside) {
        throw new Error('待替换的旧目录与书签范围部分交叉，无法安全替换');
      }
    }
    const prefixSplit = splitPreservedBoundary(
      blocks[replaceField.startBlockIdx].xml,
      replaceField.fieldStartOffset,
      replaceField.beginRun,
      'prefix',
    );
    const suffixSplit = splitPreservedBoundary(
      blocks[replaceField.endBlockIdx].xml,
      replaceField.fieldEndOffset,
      replaceField.endRun,
      'suffix',
    );
    if (prefixSplit.fragment) {
      const cleanPrefixPPr = stripParagraphSectPr(prefixSplit.pPr);
      preservedPrefixPara = `${prefixSplit.openTag}${cleanPrefixPPr}${prefixSplit.fragment}</w:p>`;
    }
    const sectPrs: string[] = [];
    for (let i = replaceField.startBlockIdx; i <= replaceField.endBlockIdx; i++) {
      if (blocks[i].kind !== 'paragraph') continue;
      const info = extractDirectParagraphProperties(blocks[i].xml);
      if (info.sectPr) sectPrs.push(info.sectPr);
    }
    if (sectPrs.length > 1) {
      throw new Error('待替换的旧目录跨越多个分节，无法安全替换');
    }
    preservedSectPr = sectPrs[0] ?? '';
    if (suffixSplit.fragment) {
      const baseSuffix = `${suffixSplit.openTag}${stripParagraphSectPr(suffixSplit.pPr)}${suffixSplit.fragment}</w:p>`;
      preservedSuffixPara = preservedSectPr ? injectParagraphSectPr(baseSuffix, preservedSectPr) : baseSuffix;
    }
  }

  const excludedBlocks = new Set<number>();
  for (const field of tocFields) {
    for (let i = field.startBlockIdx; i <= field.endBlockIdx; i++) excludedBlocks.add(i);
  }

  const anchorBlock = blocks[anchorBlockIdx];
  const anchorRawText = anchorBlock.kind === 'paragraph' ? paragraphText(anchorBlock.xml) : '';
  const anchorTitleNormalized = anchorRawText.replace(/\s+/g, '');
  const excludeAnchorSelf =
    anchorBlock.kind === 'paragraph' &&
    TOC_ANCHOR_NAME_PATTERN.test(anchorTitleNormalized);
  if (excludeAnchorSelf) excludedBlocks.add(anchorBlockIdx);

  const effectiveInsertBlockIdx = replaceField
    ? replaceField.startBlockIdx
    : validated.position === 'before'
      ? anchorBlockIdx
      : anchorBlockIdx + 1;

  const rawHeadings: Array<{ blockIndex: number; pIndex: number; level: number; title: string; beforeToc: boolean }> = [];
  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const block = blocks[bIdx];
    if (block.kind !== 'paragraph' || excludedBlocks.has(bIdx)) continue;
    const level = paragraphHeadingLevel(block.xml, styles);
    if (level < 1 || level > validated.maxLevel) continue;
    const title = paragraphText(block.xml).replace(/[\r\n\t]+/g, ' ').trim();
    if (!title) continue;
    rawHeadings.push({
      blockIndex: bIdx,
      pIndex: block.index,
      level,
      title,
      beforeToc: bIdx < effectiveInsertBlockIdx,
    });
  }

  if (rawHeadings.length === 0) {
    throw new Error(`文档中没有可生成目录的 1–${validated.maxLevel} 级标题`);
  }

  const allElements = xmlElements(documentXml);
  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  const idStartCount = new Map<string, number>();
  const idEndCount = new Map<string, number>();
  const nameCount = new Map<string, number>();
  let maxNumericId = 0;
  let maxTocNum = 0;
  for (const el of allElements) {
    if (el.name !== 'w:bookmarkStart' && el.name !== 'w:bookmarkEnd') continue;
    const attrs = xmlAttributes(documentXml, el);
    const id = attrs.get('w:id');
    if (id !== undefined) {
      usedIds.add(id);
      if (/^\d+$/.test(id)) maxNumericId = Math.max(maxNumericId, Number(id));
      if (el.name === 'w:bookmarkStart') idStartCount.set(id, (idStartCount.get(id) ?? 0) + 1);
      else idEndCount.set(id, (idEndCount.get(id) ?? 0) + 1);
    }
    if (el.name === 'w:bookmarkStart') {
      const name = attrs.get('w:name');
      if (name !== undefined) {
        usedNames.add(name);
        nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
        const tocMatch = TOC_BOOKMARK_NAME_PATTERN.exec(name);
        if (tocMatch) maxTocNum = Math.max(maxTocNum, Number(tocMatch[1]));
      }
    }
  }
  let nextNumericId = maxNumericId + 1;
  let nextTocNum = maxTocNum + 1;
  const allocateBookmark = (): { id: number; name: string } => {
    while (usedIds.has(String(nextNumericId))) nextNumericId++;
    const id = nextNumericId++;
    usedIds.add(String(id));
    while (usedNames.has(`_TocSeal_${nextTocNum}`)) nextTocNum++;
    const name = `_TocSeal_${nextTocNum++}`;
    usedNames.add(name);
    return { id, name };
  };

  const findReusableTocBookmark = (paragraphXml: string): string | undefined => {
    const elems = xmlElements(paragraphXml);
    const endsById = new Set<string>();
    for (const el of elems) {
      if (el.name === 'w:bookmarkEnd') {
        const id = xmlAttributes(paragraphXml, el).get('w:id');
        if (id !== undefined) endsById.add(id);
      }
    }
    for (const el of elems) {
      if (el.name !== 'w:bookmarkStart') continue;
      const attrs = xmlAttributes(paragraphXml, el);
      const id = attrs.get('w:id');
      const name = attrs.get('w:name');
      if (
        id !== undefined &&
        name !== undefined &&
        TOC_BOOKMARK_NAME_PATTERN.test(name) &&
        endsById.has(id) &&
        idStartCount.get(id) === 1 &&
        idEndCount.get(id) === 1 &&
        nameCount.get(name) === 1
      ) {
        return name;
      }
    }
    return undefined;
  };

  const updatedBlockXml = new Map<number, string>();
  if (excludeAnchorSelf) {
    updatedBlockXml.set(anchorBlockIdx, setParagraphOutlineLevel(anchorBlock.xml, 9));
  }

  const entries: TocHeading[] = rawHeadings.map(heading => {
    const baseXml = updatedBlockXml.get(heading.blockIndex) ?? blocks[heading.blockIndex].xml;
    const reusable = findReusableTocBookmark(baseXml);
    if (reusable) {
      return { ...heading, bookmarkName: reusable };
    }
    const { id, name } = allocateBookmark();
    updatedBlockXml.set(heading.blockIndex, wrapParagraphBookmark(baseXml, id, name));
    return { ...heading, bookmarkName: name };
  });

  const insertDocOffset = replaceField
    ? bodyOpenEnd + blocks[replaceField.startBlockIdx].startOffset
    : validated.position === 'before'
      ? bodyOpenEnd + anchorBlock.startOffset
      : bodyOpenEnd + anchorBlock.endOffset;
  if (!replaceField) {
    for (const existing of tocFields) {
      const fStart = bodyOpenEnd + blocks[existing.startBlockIdx].startOffset + existing.fieldStartOffset;
      const fEnd = bodyOpenEnd + blocks[existing.endBlockIdx].startOffset + existing.fieldEndOffset;
      if (fStart < insertDocOffset && insertDocOffset < fEnd) {
        throw new Error('不能在已有目录域内部插入嵌套目录');
      }
    }
  }
  const widthTwips = layoutBox(documentXml, insertDocOffset, { stylesXml, paragraph: false }).width / 635;
  const tabPos = Math.max(1440, Math.floor(widthTwips));
  const minLevel = Math.min(...entries.map(entry => entry.level));
  const baseRunPr = extractBaseTocRunPr(documentXml, stylesXml, anchorBlock.xml);
  const pageText = options.placeholderPage ?? '';

  const tocParagraphsList = entries.map((entry, idx) => {
    const indent = (entry.level - minLevel) * 420;
    const attachSectPr = !preservedSuffixPara && idx === entries.length - 1 ? preservedSectPr : '';
    const pPr = `<w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${tabPos}"/></w:tabs><w:spacing w:before="20" w:after="20" w:line="280" w:lineRule="auto"/><w:ind w:left="${indent}"/><w:jc w:val="left"/><w:outlineLvl w:val="9"/>${attachSectPr}</w:pPr>`;
    const outerBegin =
      idx === 0
        ? `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-${validated.maxLevel}" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>`
        : '';
    const outerEnd = idx === entries.length - 1 ? `<w:r><w:fldChar w:fldCharType="end"/></w:r>` : '';
    const hyperlink =
      `<w:hyperlink w:anchor="${escapeXml(entry.bookmarkName)}" w:history="1">` +
      `<w:r>${baseRunPr}<w:t xml:space="preserve">${escapeXml(entry.title)}</w:t></w:r>` +
      `<w:r>${baseRunPr}<w:tab/></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
      `<w:r><w:instrText xml:space="preserve"> PAGEREF ${escapeXml(entry.bookmarkName)} \\h </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
      `<w:r>${baseRunPr}<w:t>${escapeXml(pageText)}</w:t></w:r>` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
      `</w:hyperlink>`;
    return `<w:p>${pPr}${outerBegin}${hyperlink}${outerEnd}</w:p>`;
  });
  const replacementChunk = preservedPrefixPara + tocParagraphsList.join('') + preservedSuffixPara;

  const bodyParts: string[] = [];
  let paragraphsBeforeReplaceRange = 0;
  let oldRangeParagraphCount = 0;
  let newRangeParagraphCount = entries.length;
  let insertAtParagraphIndex = 0;

  if (replaceField) {
    paragraphsBeforeReplaceRange = blocks
      .slice(0, replaceField.startBlockIdx)
      .filter(b => b.kind === 'paragraph').length;
    oldRangeParagraphCount = blocks
      .slice(replaceField.startBlockIdx, replaceField.endBlockIdx + 1)
      .filter(b => b.kind === 'paragraph').length;
    newRangeParagraphCount = (preservedPrefixPara ? 1 : 0) + entries.length + (preservedSuffixPara ? 1 : 0);
    insertAtParagraphIndex = paragraphsBeforeReplaceRange + (preservedPrefixPara ? 1 : 0);
    for (let i = 0; i < blocks.length; i++) {
      if (i === replaceField.startBlockIdx) {
        bodyParts.push(replacementChunk);
      }
      if (i >= replaceField.startBlockIdx && i <= replaceField.endBlockIdx) continue;
      bodyParts.push(updatedBlockXml.get(i) ?? blocks[i].xml);
    }
  } else {
    const boundaryIdx = validated.position === 'before' ? anchorBlockIdx : anchorBlockIdx + 1;
    paragraphsBeforeReplaceRange = blocks.slice(0, boundaryIdx).filter(b => b.kind === 'paragraph').length;
    oldRangeParagraphCount = 0;
    newRangeParagraphCount = entries.length;
    insertAtParagraphIndex = paragraphsBeforeReplaceRange;
    for (let i = 0; i < blocks.length; i++) {
      if (i === anchorBlockIdx && validated.position === 'before') {
        bodyParts.push(replacementChunk);
      }
      bodyParts.push(updatedBlockXml.get(i) ?? blocks[i].xml);
      if (i === anchorBlockIdx && validated.position === 'after') {
        bodyParts.push(replacementChunk);
      }
    }
  }

  const insertedAddresses = entries.map((_, idx) => `p:${insertAtParagraphIndex + idx}`);
  return {
    xml: prefixXml + bodyParts.join('') + suffixXml,
    entries,
    ...(excludeAnchorSelf ? { anchorTitle: anchorRawText.trim() } : {}),
    anchorParagraphUpdated: excludeAnchorSelf,
    removedParagraphs: oldRangeParagraphCount,
    insertedParagraphs: newRangeParagraphCount,
    insertAtParagraphIndex,
    paragraphsBeforeReplaceRange,
    oldRangeParagraphCount,
    newRangeParagraphCount,
    insertedAddresses,
  };
}

/** Ensure word/settings.xml exists with <w:updateFields w:val="true"/> and OPC registrations. */
export function ensureUpdateFieldsSetting(parts: Map<string, Uint8Array>): void {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const settingsPath = 'word/settings.xml';
  const existing = parts.get(settingsPath);
  if (existing) {
    const xml = decoder.decode(existing);
    const elements = xmlElements(xml);
    const root = elements.findIndex(element => element.name === 'w:settings');
    if (root < 0) throw new Error('word/settings.xml 缺少 <w:settings> 根节点');
    const rootEl = elements[root];
    const updateTag = '<w:updateFields w:val="true"/>';
    let updated: string;
    if (rootEl.openEnd === rootEl.closeStart) {
      updated = `${xml.slice(0, rootEl.openEnd - 2)}>${updateTag}</w:settings>${xml.slice(rootEl.end)}`;
    } else {
      const existingNodes = elements.filter(element => element.parent === root && element.name === 'w:updateFields');
      if (existingNodes.length > 0) {
        updated = xml;
        for (let i = existingNodes.length - 1; i >= 0; i--) {
          const node = existingNodes[i];
          updated = updated.slice(0, node.start) + (i === 0 ? updateTag : '') + updated.slice(node.end);
        }
      } else {
        updated = `${xml.slice(0, rootEl.closeStart)}${updateTag}${xml.slice(rootEl.closeStart)}`;
      }
    }
    parts.set(settingsPath, encoder.encode(updated));
    return;
  }

  const minimalSettings =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:updateFields w:val="true"/>' +
    '</w:settings>';
  parts.set(settingsPath, encoder.encode(minimalSettings));

  const ctBytes = parts.get('[Content_Types].xml');
  if (!ctBytes) throw new Error('缺少 [Content_Types].xml');
  const ctXml = decoder.decode(ctBytes);
  const ctElements = xmlElements(ctXml);
  const hasSettingsOverride = ctElements.some(element => {
    if (element.name.split(':').pop() !== 'Override') return false;
    const partName = xmlAttributes(ctXml, element).get('PartName');
    return partName?.replace(/^\//, '') === settingsPath;
  });
  if (!hasSettingsOverride) {
    const typesRoot = ctElements.find(element => element.name.split(':').pop() === 'Types');
    if (!typesRoot) throw new Error('[Content_Types].xml 缺少 Types 根节点');
    const overrideTag =
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>';
    const nextCt =
      typesRoot.openEnd === typesRoot.closeStart
        ? `${ctXml.slice(0, typesRoot.openEnd - 2)}>${overrideTag}</${ctXml.slice(typesRoot.start + 1, typesRoot.openEnd).split(/[\s/>]/)[0]}>${ctXml.slice(typesRoot.end)}`
        : `${ctXml.slice(0, typesRoot.closeStart)}${overrideTag}${ctXml.slice(typesRoot.closeStart)}`;
    parts.set('[Content_Types].xml', encoder.encode(nextCt));
  }

  const relsPath = 'word/_rels/document.xml.rels';
  const relsBytes = parts.get(relsPath);
  const settingsRelType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
  if (!relsBytes) {
    const minimalRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${settingsRelType}" Target="settings.xml"/>` +
      '</Relationships>';
    parts.set(relsPath, encoder.encode(minimalRels));
    return;
  }
  const relsXml = decoder.decode(relsBytes);
  const relsElements = xmlElements(relsXml);
  const relsRoot = relsElements.find(element => element.name.split(':').pop() === 'Relationships');
  if (!relsRoot) throw new Error('word/_rels/document.xml.rels 缺少 Relationships 根节点');
  const existingIds = new Set<string>();
  let maxIdNum = 0;
  let hasSettingsRel = false;
  for (const el of relsElements) {
    if (el.name.split(':').pop() !== 'Relationship') continue;
    const attrs = xmlAttributes(relsXml, el);
    const id = attrs.get('Id');
    if (id) {
      existingIds.add(id);
      const numMatch = /^rId(\d+)$/.exec(id);
      if (numMatch) maxIdNum = Math.max(maxIdNum, Number(numMatch[1]));
    }
    const type = attrs.get('Type') ?? '';
    const target = attrs.get('Target') ?? '';
    if (type.endsWith('/settings') || target === 'settings.xml' || target === '/word/settings.xml') {
      hasSettingsRel = true;
    }
  }
  if (!hasSettingsRel) {
    let nextNum = maxIdNum + 1;
    while (existingIds.has(`rId${nextNum}`)) nextNum++;
    const relTag = `<Relationship Id="rId${nextNum}" Type="${settingsRelType}" Target="settings.xml"/>`;
    const nextRels =
      relsRoot.openEnd === relsRoot.closeStart
        ? `${relsXml.slice(0, relsRoot.openEnd - 2)}>${relTag}</${relsXml.slice(relsRoot.start + 1, relsRoot.openEnd).split(/[\s/>]/)[0]}>${relsXml.slice(relsRoot.end)}`
        : `${relsXml.slice(0, relsRoot.closeStart)}${relTag}${relsXml.slice(relsRoot.closeStart)}`;
    parts.set(relsPath, encoder.encode(nextRels));
  }
}

function normalizeMatchText(text: string): string {
  return text.replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface PageLine {
  globalIdx: number;
  pageIdx: number;
  raw: string;
  norm: string;
}

interface TocLineMatch {
  endIdx: number;
  hasDotLeader: boolean;
  hasTrailingNum: boolean;
}

function isPureLeaderOrNumberLine(line: PageLine): boolean {
  return /^[.\u2026·•\s\t]*\d+$/.test(line.raw.trim()) || /^[.\u2026·•]+$/.test(line.norm);
}

function matchTocLineAt(lines: readonly PageLine[], idx: number, normTitle: string): TocLineMatch | null {
  if (!normTitle || idx < 0 || idx >= lines.length) return null;
  const pageIdx = lines[idx].pageIdx;
  const dotRe = new RegExp(`^${escapeRegex(normTitle)}[.\u2026·•]{2,}(\\d*)$`);

  for (let span = 1; span <= 3 && idx + span - 1 < lines.length; span++) {
    const endIdx = idx + span - 1;
    if (lines[endIdx].pageIdx !== pageIdx) break;
    const prefixNorm = lines.slice(idx, endIdx).map(l => l.norm).join('');
    const lastLine = lines[endIdx];
    const combinedNorm = prefixNorm + lastLine.norm;

    const dotMatch = dotRe.exec(combinedNorm);
    if (dotMatch) {
      return { endIdx, hasDotLeader: true, hasTrailingNum: dotMatch[1].length > 0 };
    }
    const lastTrimmed = lastLine.raw.trim();
    if (/[\s.\u2026·•\t]+\d+$/.test(lastTrimmed)) {
      const strippedLast = normalizeMatchText(lastTrimmed.replace(/[\s.\u2026·•\t]+\d+$/, ''));
      if (prefixNorm + strippedLast === normTitle) {
        return {
          endIdx,
          hasDotLeader: /[.\u2026·•]{2,}/.test(lastTrimmed),
          hasTrailingNum: true,
        };
      }
    }
    if (combinedNorm === normTitle) {
      if (
        endIdx + 1 < lines.length &&
        lines[endIdx + 1].pageIdx === pageIdx &&
        isPureLeaderOrNumberLine(lines[endIdx + 1])
      ) {
        return {
          endIdx: endIdx + 1,
          hasDotLeader: /[.\u2026·•]{2,}/.test(lines[endIdx + 1].raw),
          hasTrailingNum: /\d+$/.test(lines[endIdx + 1].raw.trim()),
        };
      }
      return { endIdx, hasDotLeader: false, hasTrailingNum: false };
    }
  }
  return null;
}

function isTocHeaderLine(line: PageLine, hintAnchorNorm?: string): boolean {
  return TOC_ANCHOR_NAME_PATTERN.test(line.norm) || (hintAnchorNorm !== undefined && line.norm === hintAnchorNorm);
}

function findTocLineMasks(
  lines: readonly PageLine[],
  headings: readonly { normTitle: string; beforeToc?: boolean }[],
  hintAnchorNorm?: string,
): Array<{ start: number; end: number }> {
  if (!lines.length || !headings.length) return [];

  interface Candidate {
    start: number;
    end: number;
    dotLeaderCount: number;
    trailingNumCount: number;
    hasTocHeader: boolean;
    span: number;
  }

  const candidates: Candidate[] = [];
  const firstNorm = headings[0].normTitle;
  for (let s = 0; s < lines.length; s++) {
    const firstMatch = matchTocLineAt(lines, s, firstNorm);
    if (!firstMatch) continue;

    let cursor = firstMatch.endIdx + 1;
    let prevPage = lines[firstMatch.endIdx].pageIdx;
    let dotLeaderCount = firstMatch.hasDotLeader ? 1 : 0;
    let trailingNumCount = firstMatch.hasTrailingNum ? 1 : 0;
    let matchedAll = true;
    let lastEnd = firstMatch.endIdx;

    for (let hIdx = 1; hIdx < headings.length; hIdx++) {
      const targetNorm = headings[hIdx].normTitle;
      let found: TocLineMatch | null = null;
      let foundAt = -1;
      for (let pos = cursor; pos < lines.length; pos++) {
        const pageDiff = lines[pos].pageIdx - prevPage;
        if (pageDiff < 0 || pageDiff > 1) break;
        const lineGap = pos - cursor;
        const maxGap = pageDiff === 0 ? 2 : 8;
        if (lineGap > maxGap) break;
        const m = matchTocLineAt(lines, pos, targetNorm);
        if (m) {
          found = m;
          foundAt = pos;
          break;
        }
      }
      if (!found || foundAt < 0) {
        matchedAll = false;
        break;
      }
      if (found.hasDotLeader) dotLeaderCount++;
      if (found.hasTrailingNum) trailingNumCount++;
      lastEnd = found.endIdx;
      prevPage = lines[found.endIdx].pageIdx;
      cursor = found.endIdx + 1;
    }

    if (!matchedAll) continue;

    let effectiveStart = s;
    let hasTocHeader = false;
    for (let back = 1; back <= 2 && s - back >= 0; back++) {
      if (isTocHeaderLine(lines[s - back], hintAnchorNorm)) {
        effectiveStart = s - back;
        hasTocHeader = true;
        break;
      }
    }

    // Check if headings also appear outside [effectiveStart..lastEnd] in expected before/after order.
    const hasExplicitTocSignal =
      hasTocHeader || dotLeaderCount >= 1 || trailingNumCount >= Math.min(2, headings.length);
    let hasExternalBodyOccurrences = true;
    if (!hasExplicitTocSignal) {
      const beforeNorms = headings.filter(h => h.beforeToc === true).map(h => h.normTitle);
      const afterNorms = headings.filter(h => !h.beforeToc).map(h => h.normTitle);
      const beforeSlice = lines.slice(0, effectiveStart).map(l => l.norm).join('');
      const afterSlice = lines.slice(lastEnd + 1).map(l => l.norm).join('');
      hasExternalBodyOccurrences =
        beforeNorms.every(t => beforeSlice.includes(t)) && afterNorms.every(t => afterSlice.includes(t));
    }

    if (hasExplicitTocSignal || hasExternalBodyOccurrences) {
      candidates.push({
        start: effectiveStart,
        end: lastEnd,
        dotLeaderCount,
        trailingNumCount,
        hasTocHeader,
        span: lastEnd - s,
      });
    }
  }

  if (candidates.length === 0) return [];
  candidates.sort((a, b) => {
    if (a.hasTocHeader !== b.hasTocHeader) return a.hasTocHeader ? -1 : 1;
    if (a.dotLeaderCount !== b.dotLeaderCount) return b.dotLeaderCount - a.dotLeaderCount;
    if (a.trailingNumCount !== b.trailingNumCount) return b.trailingNumCount - a.trailingNumCount;
    if (a.span !== b.span) return a.span - b.span;
    return a.start - b.start;
  });
  const selected: Array<{ start: number; end: number }> = [];
  for (const candidate of candidates) {
    if (selected.some(item => !(candidate.end < item.start || candidate.start > item.end))) continue;
    selected.push({ start: candidate.start, end: candidate.end });
  }
  return selected.sort((a, b) => a.start - b.start);
}

/**
 * Resolve 1-based page numbers for TOC headings from extracted page texts,
 * masking only the exact TOC line span [tocStart..tocEnd] so mixed TOC+body pages still match cleanly.
 */
export function resolveTocPageNumbers(
  headings: readonly Pick<TocHeading, 'bookmarkName' | 'title' | 'beforeToc'>[],
  pageTexts: readonly string[],
  tocPageHint?: TocPageHint | number,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!headings.length || !pageTexts.length) return result;

  const lines: PageLine[] = [];
  for (let pageIdx = 0; pageIdx < pageTexts.length; pageIdx++) {
    for (const raw of pageTexts[pageIdx].split(/\r?\n/)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      lines.push({
        globalIdx: lines.length,
        pageIdx,
        raw: trimmed,
        norm: normalizeMatchText(trimmed),
      });
    }
  }
  if (!lines.length) return result;

  const hintAnchorNorm =
    typeof tocPageHint === 'object' && tocPageHint?.anchorTitle
      ? normalizeMatchText(tocPageHint.anchorTitle)
      : undefined;

  const normalizedHeadings = headings.map(h => ({
    ...h,
    normTitle: normalizeMatchText(h.title),
  }));

  const explicitPages = new Set<number>();
  if (typeof tocPageHint === 'number' && Number.isInteger(tocPageHint) && tocPageHint >= 0 && tocPageHint < pageTexts.length) {
    explicitPages.add(tocPageHint);
  } else if (typeof tocPageHint === 'object' && tocPageHint?.tocPageIndices?.length) {
    for (const idx of tocPageHint.tocPageIndices) {
      if (Number.isInteger(idx) && idx >= 0 && idx < pageTexts.length) explicitPages.add(idx);
    }
  }

  const tocMasks = explicitPages.size === 0 ? findTocLineMasks(lines, normalizedHeadings, hintAnchorNorm) : [];
  if (explicitPages.size === 0 && tocMasks.length === 0) {
    return result;
  }
  const isMasked = (line: PageLine): boolean => {
    if (explicitPages.size > 0) return explicitPages.has(line.pageIdx);
    return tocMasks.some(mask => line.globalIdx >= mask.start && line.globalIdx <= mask.end);
  };

  const matchInLineRange = (
    group: typeof normalizedHeadings,
    minLine: number,
    maxLine: number,
  ): number => {
    let cursorLine = minLine;
    for (const heading of group) {
      if (!heading.normTitle) continue;
      let matchedLine = -1;
      let matchedEndLine = -1;

      // Pass 1: exact single-line or same-page wrapped 2-3 line match inside unmasked range.
      for (let i = cursorLine; i <= maxLine; i++) {
        if (isMasked(lines[i])) continue;
        if (lines[i].norm === heading.normTitle) {
          matchedLine = i;
          matchedEndLine = i;
          break;
        }
        if (
          i + 1 <= maxLine &&
          !isMasked(lines[i + 1]) &&
          lines[i + 1].pageIdx === lines[i].pageIdx &&
          lines[i].norm + lines[i + 1].norm === heading.normTitle
        ) {
          matchedLine = i;
          matchedEndLine = i + 1;
          break;
        }
        if (
          i + 2 <= maxLine &&
          !isMasked(lines[i + 1]) &&
          !isMasked(lines[i + 2]) &&
          lines[i + 1].pageIdx === lines[i].pageIdx &&
          lines[i + 2].pageIdx === lines[i].pageIdx &&
          lines[i].norm + lines[i + 1].norm + lines[i + 2].norm === heading.normTitle
        ) {
          matchedLine = i;
          matchedEndLine = i + 2;
          break;
        }
      }

      // Pass 2: substring match on unmasked lines of a page (skipped for pure digits).
      if (matchedLine < 0 && !/^\d+$/.test(heading.normTitle)) {
        let pIdx = cursorLine <= maxLine ? lines[cursorLine].pageIdx : pageTexts.length;
        while (pIdx < pageTexts.length) {
          const pageUnmasked = lines.filter(
            l => l.pageIdx === pIdx && l.globalIdx >= cursorLine && l.globalIdx <= maxLine && !isMasked(l),
          );
          if (pageUnmasked.length > 0 && pageUnmasked.map(l => l.norm).join('').includes(heading.normTitle)) {
            let acc = '';
            let endIdx = 0;
            for (let k = 0; k < pageUnmasked.length; k++) {
              acc += pageUnmasked[k].norm;
              if (acc.includes(heading.normTitle)) {
                endIdx = k;
                break;
              }
            }
            matchedLine = pageUnmasked[0].globalIdx;
            matchedEndLine = pageUnmasked[endIdx].globalIdx;
            break;
          }
          pIdx++;
        }
      }

      if (matchedLine >= 0) {
        result.set(heading.bookmarkName, String(lines[matchedLine].pageIdx + 1));
        cursorLine = matchedEndLine + 1;
      }
    }
    return cursorLine;
  };

  const beforeHeadings = normalizedHeadings.filter(h => h.beforeToc === true);
  const afterHeadings = normalizedHeadings.filter(h => !h.beforeToc);

  let afterStartLine = 0;
  if (tocMasks.length > 0) {
    afterStartLine = tocMasks[0].end + 1;
  } else if (explicitPages.size > 0) {
    const maxExplicit = Math.max(...explicitPages);
    const firstAfter = lines.findIndex(l => l.pageIdx > maxExplicit);
    afterStartLine = firstAfter >= 0 ? firstAfter : lines.length;
  }

  if (beforeHeadings.length > 0) {
    let beforeEndLine = lines.length - 1;
    if (tocMasks.length > 0) {
      beforeEndLine = tocMasks[0].start - 1;
    } else if (explicitPages.size > 0) {
      const minExplicit = Math.min(...explicitPages);
      const firstInExplicit = lines.findIndex(l => l.pageIdx >= minExplicit);
      beforeEndLine = firstInExplicit >= 0 ? firstInExplicit - 1 : lines.length - 1;
    }
    if (beforeEndLine >= 0) {
      const lastBefore = matchInLineRange(beforeHeadings, 0, beforeEndLine);
      if (tocMasks.length === 0 && explicitPages.size === 0) {
        afterStartLine = Math.max(afterStartLine, lastBefore);
      }
    }
  }

  if (afterHeadings.length > 0 && afterStartLine < lines.length) {
    matchInLineRange(afterHeadings, afterStartLine, lines.length - 1);
  }

  return result;
}

/** Patch cached page number <w:t> inside PAGEREF _TocSeal_<N> fields. */
export function patchTocPageNumbers(documentXml: string, pageMap: ReadonlyMap<string, string>): string {
  const elements = xmlElements(documentXml);
  const stack: Array<{ instr: string; separated: boolean; tElements: Array<{ start: number; openEnd: number; closeStart: number; end: number }> }> = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const el of elements) {
    if (el.name === 'w:fldChar') {
      const kind = xmlAttributes(documentXml, el).get('w:fldCharType');
      if (kind === 'begin') {
        stack.push({ instr: '', separated: false, tElements: [] });
      } else if (kind === 'separate') {
        if (stack.length > 0) stack[stack.length - 1].separated = true;
      } else if (kind === 'end') {
        const frame = stack.pop();
        if (!frame) continue;
        const match = PAGEREF_INSTR_PATTERN.exec(frame.instr);
        if (!match) continue;
        const bookmarkName = match[1];
        if (!TOC_BOOKMARK_NAME_PATTERN.test(bookmarkName) && !pageMap.has(bookmarkName)) continue;
        const pageValue = pageMap.get(bookmarkName) ?? '';
        for (let i = 0; i < frame.tElements.length; i++) {
          const tEl = frame.tElements[i];
          const text = i === 0 ? escapeXml(pageValue) : '';
          if (tEl.openEnd === tEl.closeStart) {
            if (text) {
              replacements.push({ start: tEl.start, end: tEl.end, value: `<w:t>${text}</w:t>` });
            }
          } else {
            replacements.push({ start: tEl.openEnd, end: tEl.closeStart, value: text });
          }
        }
      }
    } else if (el.name === 'w:instrText' && stack.length > 0 && !stack[stack.length - 1].separated) {
      stack[stack.length - 1].instr += unescapeXml(documentXml.slice(el.openEnd, el.closeStart));
    } else if (el.name === 'w:t' && stack.length > 0 && stack[stack.length - 1].separated) {
      stack[stack.length - 1].tElements.push(el);
    }
  }

  if (replacements.length === 0) return documentXml;
  replacements.sort((a, b) => b.start - a.start);
  let output = documentXml;
  for (const item of replacements) {
    output = output.slice(0, item.start) + item.value + output.slice(item.end);
  }
  return output;
}
