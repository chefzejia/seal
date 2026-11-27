import type { BidLedger, PendingRecord } from './project.js';
import type { HostPort } from '../host.js';
import { pendingReasons, type PendingCategory } from './policy.js';
import { currentHints } from './dismissals.js';
import { isCellEdgeBlock, resolveAddress } from '../docx/addresses.js';
import { bodyViewNodes } from '../docx/document-view.js';
import { validatePackageStructure } from '../docx/package-structure.js';
import { layoutCaptionedImages, markdownBlocks, markdownImageTokens } from '../docx/markdown.js';
import { layoutBox } from '../docx/layout.js';
import { startCellBlocks, terminateCellBlocks } from '../docx/image-insert.js';
import { extractFirstRunPr, isMergedContinuation, parseDocumentBody, parseRowCells, xmlElements } from '../docx/xml.js';
import { editTextDocument, editTextDocumentWithMeta, pendingImageLabel, type DocumentEdit } from '../docx/text-document.js';
import { cellStyleSource, resolveCheckTarget, resolveTextTarget, type AppliedTocEffect, type TextBatchEdit } from '../docx/text-batch.js';
import { validateInsertTocEdit } from '../docx/toc.js';
import { editableText, firstVisibleRunProperties, visibleOffsetBefore, visibleRunProperties } from '../docx/visible-surgery.js';
import { rangeRelation, sealRanges } from '../docx/seal-ranges.js';
import { sha256Hex } from '../docx/zip.js';
import { displayedFactValue, type FactResolution, type FactSource } from './facts.js';

async function documentXml(bytes: Uint8Array): Promise<string> {
  return new TextDecoder('utf-8', { fatal: true }).decode((await validatePackageStructure(bytes)).get('word/document.xml')!);
}

type PublicTextEdit = Exclude<TextBatchEdit, { op: 'insert_prepared_image' | 'mark_fact' }>;
type WordAgentEdit = (PublicTextEdit | { op: 'insert_image'; at: string; image: string }) & { pending?: { category: PendingCategory; note: string }; thirdPartyHolder?: string };
export type DismissHintsEdit =
  | { op: 'dismiss_hints'; targets: Array<{ at: string; blanks?: number[] }>; reason: string }
  | { op: 'dismiss_hints'; from: string; to: string; reason: string };
export type AgentEdit =
  | WordAgentEdit
  | { op: 'dismiss_hint'; at: string; blank: number; reason: string }
  | DismissHintsEdit;

const isDismissOp = (
  operation: AgentEdit | undefined,
): operation is { op: 'dismiss_hint'; at: string; blank: number; reason: string } | DismissHintsEdit =>
  operation?.op === 'dismiss_hint' || operation?.op === 'dismiss_hints';

function addressAfterEdits(address: string, edits: readonly WordAgentEdit[], xml: string, insertionBlocks: ReadonlyMap<WordAgentEdit, ReturnType<typeof parseDocumentBody>['blocks']>): string {
  const parts = address.split('/');
  return parts.map((part, depth) => {
    const match = /^([ptrc]):(\d+)$/.exec(part);
    if (!match) return part;
    let adjustment = 0;
    for (const edit of edits) {
      if (edit.op === 'insert' || edit.op === 'insert_image') {
        const editParts = edit.at.split('/');
        if (editParts.length !== depth + 1 || !editParts.slice(0, depth).every((value, index) => value === parts[index])) continue;
        const anchor = resolveAddress(xml, edit.at), target = resolveAddress(xml, parts.slice(0, depth + 1).join('/'));
        if (anchor.kind === 'cell') continue;
        if (!(anchor.start < target.start || anchor.start === target.start && edit.op === 'insert' && edit.position === 'before')) continue;
        const blocks = insertionBlocks.get(edit) ?? [];
        adjustment += blocks.filter(block => match[1] === 'p' ? block.kind === 'paragraph' : block.kind === 'table').length;
      } else if (edit.op === 'delete' || edit.op === 'insert_rows') {
        const target = edit.at.split('/'), last = /^([ptrc]):(\d+)$/.exec(target[depth] ?? '');
        if (target.length === depth + 1 && target.slice(0, depth).every((value, index) => value === parts[index]) && last && last[1] === match[1] && Number(last[2]) < Number(match[2])) adjustment += edit.op === 'delete' ? -1 : edit.rows.length - (edit.mode === 'replace' ? 1 : 0);
      }
    }
    return `${match[1]}:${Number(match[2]) + adjustment}`;
  }).join('/');
}

function highlight(properties: string): string | null {
  const elements = xmlElements(properties), root = elements.findIndex(item => item.parent === null);
  const element = elements.find(item => item.parent === root && item.name === 'w:highlight');
  return element ? properties.slice(element.start, element.end) : null;
}

interface CellLogicalRange {
  cellIndex: number;
  start: number;
  end: number;
  xml: string;
}

function positiveIntAttr(xml: string, element: { start: number; openEnd: number }, attrName: string): number | undefined {
  const tag = xml.slice(element.start, element.openEnd);
  const match = new RegExp(`\\b${attrName}\\s*=\\s*(["'])(\\d+)\\1`).exec(tag);
  if (!match) return undefined;
  const value = Number(match[2]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function rowCellLogicalRanges(rowXml: string): CellLogicalRange[] {
  const elements = xmlElements(rowXml);
  const outer = elements.findIndex(element => element.name === 'w:tr');
  if (outer < 0) return [];
  let cursor = 0;
  const trPrIndex = elements.findIndex(element => element.parent === outer && element.name === 'w:trPr');
  if (trPrIndex >= 0) {
    const gridBefore = elements.find(element => element.parent === trPrIndex && element.name === 'w:gridBefore');
    if (gridBefore) {
      const val = positiveIntAttr(rowXml, gridBefore, 'w:val');
      if (val !== undefined && val > 0) cursor = val;
    }
  }
  const result: CellLogicalRange[] = [];
  let cellIndex = 0;
  let lastHorizontalStart = -1;
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (element.parent !== outer || element.name !== 'w:tc') continue;
    const tcPrIndex = elements.findIndex(candidate => candidate.parent === index && candidate.name === 'w:tcPr');
    let span = 1;
    let isHMergeContinuation = false;
    if (tcPrIndex >= 0) {
      const gridSpan = elements.find(candidate => candidate.parent === tcPrIndex && candidate.name === 'w:gridSpan');
      if (gridSpan) {
        const val = positiveIntAttr(rowXml, gridSpan, 'w:val');
        if (val !== undefined && val >= 1) span = val;
      }
      const hMerge = elements.find(candidate => candidate.parent === tcPrIndex && candidate.name === 'w:hMerge');
      if (hMerge) {
        const openTag = rowXml.slice(hMerge.start, hMerge.openEnd);
        isHMergeContinuation = !/\bw:val\s*=\s*["']restart["']/.test(openTag);
      }
    }
    if (isHMergeContinuation && lastHorizontalStart >= 0) {
      result[lastHorizontalStart].end += span;
    } else {
      lastHorizontalStart = result.length;
    }
    result.push({ cellIndex: cellIndex++, start: cursor, end: cursor + span, xml: rowXml.slice(element.start, element.end) });
    cursor += span;
  }
  return result;
}

function overlappingHeaderText(
  headerRanges: readonly CellLogicalRange[],
  targetRanges: readonly CellLogicalRange[],
  physicalColIndex: number,
  extraCellTexts?: ReadonlyMap<number, string>,
): string {
  const target = targetRanges[physicalColIndex];
  if (!target) return '';
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const header of headerRanges) {
    if (header.start >= target.end || target.start >= header.end) continue;
    if (isMergedContinuation(header.xml)) continue;
    for (const candidate of [editableText(header.xml).trim(), extraCellTexts?.get(header.cellIndex)?.trim() ?? '']) {
      if (candidate && !seen.has(candidate)) {
        seen.add(candidate);
        parts.push(candidate);
      }
    }
  }
  return parts.join(' ');
}

function combineCellLabel(
  headerText: string,
  colIndex: number,
  targetRanges: readonly CellLogicalRange[],
  headerRanges: readonly CellLogicalRange[],
  leftText: string,
): string {
  const isTwoColKeyValue =
    targetRanges.length === 2 &&
    colIndex === 1 &&
    targetRanges[0]?.start === 0 &&
    targetRanges[1]?.end === 2 &&
    (headerRanges.length === 0 || headerRanges[headerRanges.length - 1].end <= 2) &&
    leftText.trim().length > 0;
  if (isTwoColKeyValue) {
    return headerText ? `${headerText} ${leftText}` : leftText;
  }
  return headerText;
}

function sameBatchRowCellEdits(xml: string, operations: readonly WordAgentEdit[], rowPrefix: string): Map<number, string> {
  const editsByCol = new Map<number, Array<{ start: number; end: number; value: string; isFull: boolean }>>();
  const prefix = `${rowPrefix}/c:`;
  for (const op of operations) {
    if ((op.op !== 'replace' && op.op !== 'set_cell' && op.op !== 'check') || !op.at.startsWith(prefix)) continue;
    const match = /^(\d+)(?:\/p:\d+)?$/.exec(op.at.slice(prefix.length));
    if (!match) continue;
    const col = Number(match[1]);
    const list = editsByCol.get(col) ?? [];
    if (op.op === 'set_cell') {
      list.push({ start: 0, end: 0, value: op.value.replace(/\r\n/g, '\n'), isFull: true });
    } else {
      try {
        const cellAddress = `${rowPrefix}/c:${col}`;
        const cellEl = resolveAddress(xml, cellAddress);
        const target = op.op === 'replace' ? resolveTextTarget(xml, op) : resolveCheckTarget(xml, op.at, op.option);
        const replacement = op.op === 'check' ? (op.checked ? '☑' : '□') : op.value.replace(/\r\n/g, '\n');
        if (target.start === target.end && op.at === cellAddress) {
          list.push({ start: 0, end: 0, value: replacement, isFull: true });
        } else {
          const shift = op.at === cellAddress
            ? 0
            : visibleOffsetBefore(xml, resolveAddress(xml, op.at).start) - visibleOffsetBefore(xml, cellEl.start);
          list.push({ start: shift + target.start, end: shift + target.end, value: replacement, isFull: false });
        }
      } catch {
        list.push({ start: 0, end: 0, value: op.op === 'check' ? (op.checked ? '☑' : '□') : op.value, isFull: true });
      }
    }
    editsByCol.set(col, list);
  }
  const updates = new Map<number, string>();
  for (const [col, list] of editsByCol) {
    const full = list.find(item => item.isFull);
    if (full && list.length === 1) {
      updates.set(col, full.value);
      continue;
    }
    let text: string;
    try {
      text = editableText(resolveAddress(xml, `${rowPrefix}/c:${col}`).xml);
    } catch {
      text = '';
    }
    const spans = list.filter(item => !item.isFull).sort((a, b) => b.start - a.start || b.end - a.end);
    for (const span of spans) {
      if (span.start >= 0 && span.end <= text.length && span.start <= span.end) {
        text = text.slice(0, span.start) + span.value + text.slice(span.end);
      }
    }
    if (full) text = `${text} ${full.value}`.trim();
    updates.set(col, text);
  }
  return updates;
}

function cellFieldLabel(xml: string, address: string, operations: readonly WordAgentEdit[]): string {
  const match = /^(.*\/r:(\d+))\/c:(\d+)(?:\/p:\d+)?$/.exec(address);
  if (!match) return '';
  const rowAddress = match[1], colIndex = Number(match[3]);
  const tableAddress = rowAddress.replace(/\/r:\d+$/, '');
  let headerRanges: CellLogicalRange[] = [];
  try {
    headerRanges = rowCellLogicalRanges(resolveAddress(xml, `${tableAddress}/r:0`).xml);
  } catch {
    headerRanges = [];
  }
  const targetRanges = rowCellLogicalRanges(resolveAddress(xml, rowAddress).xml);
  const extraHeaderTexts = sameBatchRowCellEdits(xml, operations, `${tableAddress}/r:0`);
  const headerText = headerRanges.length
    ? overlappingHeaderText(headerRanges, targetRanges, colIndex, extraHeaderTexts)
    : '';
  const baseLeft = targetRanges[0] && !isMergedContinuation(targetRanges[0].xml) ? editableText(targetRanges[0].xml) : '';
  const extraLeft = sameBatchRowCellEdits(xml, operations, rowAddress).get(0) ?? '';
  const leftText = [baseLeft.trim(), extraLeft.trim()].filter(Boolean).join(' ');
  return combineCellLabel(headerText, colIndex, targetRanges, headerRanges, leftText);
}

interface InsertedParagraph {
  address: string;
  text: string;
  xml: string;
  rowIdx?: number;
  colIdx?: number;
}

interface LocatedFact extends InsertedParagraph {
  source: FactSource;
  start: number;
  end: number;
}

function locateFactOccurrences(sources: readonly FactSource[], paragraphs: readonly InsertedParagraph[]): LocatedFact[] {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const value = displayedFactValue(source).replace(/\r\n/g, '\n');
    if (!value) throw new Error('事实引用解析为空，拒绝写入');
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const occurrences = new Map<string, Array<InsertedParagraph & { start: number; end: number }>>();
  for (const paragraph of paragraphs) {
    for (const value of counts.keys()) {
      let offset = 0;
      while ((offset = paragraph.text.indexOf(value, offset)) >= 0) {
        const list = occurrences.get(value) ?? [];
        list.push({ ...paragraph, start: offset, end: offset + value.length });
        occurrences.set(value, list);
        offset += value.length;
      }
    }
  }
  const used = new Map<string, number>();
  return sources.map(source => {
    const value = displayedFactValue(source).replace(/\r\n/g, '\n');
    const matches = occurrences.get(value) ?? [];
    if (matches.length !== counts.get(value)) {
      throw new Error(`事实引用在插入内容中无法唯一定位：${source.reference}；请拆分插入内容或保留每个事实值的唯一上下文`);
    }
    const occurrence = used.get(value) ?? 0;
    used.set(value, occurrence + 1);
    return { source, ...matches[occurrence] };
  });
}

interface RangeEditEntry {
  start: number;
  end: number;
  length: number;
  xmlPos: number;
  opStart?: number;
  opEnd?: number;
  coveredByFact?: boolean;
  coveredByVerifiedFact?: boolean;
}

const MAX_RANGE_DIFF_STEPS = 1024;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isSubIntervalCovered(
  start: number,
  end: number,
  intervals: ReadonlyArray<readonly [number, number]>,
): boolean {
  if (end <= start) return true;
  const clipped = intervals
    .map(([s, e]) => [Math.max(start, s), Math.min(end, e)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let covered = start;
  for (const [s, e] of clipped) {
    if (s > covered) return false;
    if (e > covered) covered = e;
    if (covered >= end) return true;
  }
  return covered >= end;
}

function diffTextRangeEdits(
  localStart: number,
  oldText: string,
  newText: string,
  xmlPos: number,
  factCoverage?: {
    allSpans: ReadonlyArray<readonly [number, number]>;
    verifiedSpans: ReadonlyArray<readonly [number, number]>;
  },
): RangeEditEntry[] {
  if (oldText === newText) return [];
  const opStart = localStart;
  const opEnd = localStart + oldText.length;
  const decorate = (
    raw: Array<{ start: number; end: number; length: number; newStart: number; newEnd: number }>,
  ): RangeEditEntry[] => {
    const wholeFactCovered =
      !!factCoverage && isSubIntervalCovered(0, newText.length, factCoverage.allSpans);
    const wholeVerifiedCovered =
      !!factCoverage && isSubIntervalCovered(0, newText.length, factCoverage.verifiedSpans);
    return raw.map((item) => {
      const coveredByFact =
        !!factCoverage &&
        (item.newEnd > item.newStart
          ? isSubIntervalCovered(item.newStart, item.newEnd, factCoverage.allSpans)
          : wholeFactCovered);
      const coveredByVerifiedFact =
        !!factCoverage &&
        (item.newEnd > item.newStart
          ? isSubIntervalCovered(item.newStart, item.newEnd, factCoverage.verifiedSpans)
          : wholeVerifiedCovered);
      return {
        start: item.start,
        end: item.end,
        length: item.length,
        xmlPos,
        opStart,
        opEnd,
        coveredByFact,
        coveredByVerifiedFact,
      };
    });
  };
  const minLen = Math.min(oldText.length, newText.length);
  let pre = 0;
  while (pre < minLen && oldText.charCodeAt(pre) === newText.charCodeAt(pre)) pre++;
  if (pre > 0 && isHighSurrogate(oldText.charCodeAt(pre - 1))) pre--;
  let suf = 0;
  const maxSuf = minLen - pre;
  while (
    suf < maxSuf &&
    oldText.charCodeAt(oldText.length - 1 - suf) === newText.charCodeAt(newText.length - 1 - suf)
  ) {
    suf++;
  }
  if (suf > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suf))) suf--;
  const midStart = localStart + pre;
  const oldMid = oldText.slice(pre, oldText.length - suf);
  const newMid = newText.slice(pre, newText.length - suf);
  const n = oldMid.length;
  const m = newMid.length;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) {
    return decorate([{ start: midStart, end: midStart + n, length: m, newStart: pre, newEnd: pre + m }]);
  }
  const maxD = Math.min(n + m, MAX_RANGE_DIFF_STEPS);
  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  v[1 + offset] = 0;
  const trace: Int32Array[] = [];
  let foundD = -1;
  for (let d = 0; d <= maxD; d++) {
    const snap = new Int32Array(d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && oldMid.charCodeAt(x) === newMid.charCodeAt(y)) {
        x++;
        y++;
      }
      v[k + offset] = x;
      snap[(k + d) >> 1] = x;
      if (x === n && y === m) {
        foundD = d;
        break;
      }
    }
    trace.push(snap);
    if (foundD >= 0) break;
  }
  if (foundD < 0) {
    return decorate([{ start: midStart, end: midStart + n, length: m, newStart: pre, newEnd: pre + m }]);
  }
  const rawSteps: Array<{ start: number; end: number; length: number; newStart: number; newEnd: number }> = [];
  let x = n;
  let y = m;
  for (let d = foundD; d >= 1; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const prevK =
      k === -d ||
      (k !== d && prev[(k - 1 + (d - 1)) >> 1] < prev[(k + 1 + (d - 1)) >> 1])
        ? k + 1
        : k - 1;
    const prevX = prev[(prevK + (d - 1)) >> 1];
    const prevY = prevX - prevK;
    if (prevK === k + 1) {
      rawSteps.push({
        start: midStart + prevX,
        end: midStart + prevX,
        length: 1,
        newStart: pre + prevY,
        newEnd: pre + prevY + 1,
      });
    } else {
      rawSteps.push({
        start: midStart + prevX,
        end: midStart + prevX + 1,
        length: 0,
        newStart: pre + prevY,
        newEnd: pre + prevY,
      });
    }
    x = prevX;
    y = prevY;
  }
  rawSteps.reverse();
  const hunks: Array<{ start: number; end: number; length: number; newStart: number; newEnd: number }> = [];
  for (const step of rawSteps) {
    const last = hunks[hunks.length - 1];
    if (last && step.start <= last.end && step.newStart <= last.newEnd) {
      last.end = Math.max(last.end, step.end);
      last.length += step.length;
      last.newEnd = Math.max(last.newEnd, step.newEnd);
    } else {
      hunks.push({ ...step });
    }
  }
  return decorate(hunks);
}

function isIntervalCovered(length: number, intervals: ReadonlyArray<readonly [number, number]>): boolean {
  if (length <= 0) return true;
  const sorted = [...intervals]
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let covered = 0;
  for (const [s, e] of sorted) {
    if (s > covered) return false;
    if (e > covered) covered = e;
    if (covered >= length) return true;
  }
  return covered >= length;
}

export async function editBidDraft(input: { name: string; old: Uint8Array; base?: Uint8Array; host?: Pick<HostPort, 'validateImage' | 'extractDocxPageTexts'>; ledger: BidLedger; operations: AgentEdit[]; images: Map<AgentEdit, Uint8Array>; markdownImages: Map<AgentEdit, Uint8Array[]>; facts?: ReadonlyMap<AgentEdit, FactResolution> }): Promise<{ output: Uint8Array; ledger: BidLedger; pending: PendingRecord[]; operations: number; results: Array<{ op: string; status: 'applied'; views: Array<{ address: string; kind: string; text: string }> }> }> {
  const { name, old } = input, ledger = structuredClone(input.ledger), xml = await documentXml(old);
  const ranges = sealRanges(xml), initialPending = new Map(ledger.pending.filter(item => item.draft === name && item.status !== 'removed').map(item => [`_Seal_P_${item.id}`, item]));
  const initialFillState = new Map(
    ledger.fills
      .filter(item => item.draft === name && item.status !== 'removed')
      .map(item => [
        item.id,
        {
          sealKind: (item.sealKind ?? 'fact') as 'fact' | 'pending',
          sources: item.sources ? [...item.sources] : [],
        },
      ]),
  );
  const nonVerifiedFactTouchedFills = new Set<string>();
  const batchCreatedAggregateFills = new Set<string>();
  const fillTouchCount = new Map<string, number>();
  const fullRangeRebindFills = new Map<string, { verifiedFullCover: boolean }>();
  const sourceHighlight = (address: string, fallback = false): string | null => {
    const source = resolveAddress(xml, address), text = editableText(source.xml);
    if (text.length) {
      const offset = visibleOffsetBefore(xml, source.start);
      const range = ranges.find(item => item.name.startsWith('_Seal_P_') && item.start <= offset && offset < item.end);
      if (range) {
        const pending = initialPending.get(range.name), original = pending?.originalHighlights[offset - range.start];
        if (!pending || original === undefined) throw new Error('样式来源的待定范围缺少原始高亮记录');
        return original;
      }
    }
    return highlight(firstVisibleRunProperties(source.xml) || (fallback ? extractFirstRunPr(source.xml) : ''));
  };
  const pendingCellNativeHighlight = (cellAddress: string, fallback = false): string | null | undefined => {
    const sourceEl = resolveAddress(xml, cellAddress);
    if (!editableText(sourceEl.xml).length) return undefined;
    const cellOffset = visibleOffsetBefore(xml, sourceEl.start);
    const insideSealPending = ranges.some(item => item.name.startsWith('_Seal_P_') && item.start <= cellOffset && cellOffset < item.end);
    return insideSealPending ? sourceHighlight(cellAddress, fallback) : undefined;
  };
  const operations = input.operations.filter((operation): operation is WordAgentEdit => !isDismissOp(operation));
  const prepared: DocumentEdit[] = [], added: PendingRecord[] = [], updated = new Set<PendingRecord>();
  const preparedIndexByOp = new Map<WordAgentEdit, number>();
  const pushPrepared = (operation: WordAgentEdit, edit: DocumentEdit) => {
    preparedIndexByOp.set(operation, prepared.length);
    prepared.push(edit);
  };
  const insertionBlocks = new Map<WordAgentEdit, ReturnType<typeof parseDocumentBody>['blocks']>();
  const inserted = new Map<WordAgentEdit, ReturnType<typeof pendingReasons>>();
  const highlightEdits = new Map<PendingRecord, Array<{ start: number; end: number; length: number; originals?: Array<string | null> }>>();
  const rangeEditsByFillId = new Map<string, RangeEditEntry[]>();
  const batchAddedSpans = new Map<FactSource, { baseStart: number; xmlPos: number; ownEdits?: ReadonlySet<RangeEditEntry>; finalized?: boolean }>();
  const ensureRangeEditList = (fillId: string): RangeEditEntry[] => {
    let list = rangeEditsByFillId.get(fillId);
    if (!list) {
      list = [];
      rangeEditsByFillId.set(fillId, list);
    }
    return list;
  };
  const recordRangeEdit = (fillId: string, entry: RangeEditEntry): RangeEditEntry => {
    ensureRangeEditList(fillId).push(entry);
    fillTouchCount.set(fillId, (fillTouchCount.get(fillId) ?? 0) + 1);
    return entry;
  };
  const recordRangeEdits = (fillId: string, entries: readonly RangeEditEntry[]): ReadonlySet<RangeEditEntry> => {
    const list = ensureRangeEditList(fillId);
    fillTouchCount.set(fillId, (fillTouchCount.get(fillId) ?? 0) + 1);
    const set = new Set<RangeEditEntry>();
    for (const entry of entries) {
      list.push(entry);
      set.add(entry);
    }
    return set;
  };
  const normOffset = (text: string, pos: number): number =>
    text.slice(0, pos).replace(/\r\n/g, '\n').length;
  const buildSpannedFact = (
    fact: FactResolution,
    baseStart: number,
    xmlPos = 0,
    ownEdits?: ReadonlySet<RangeEditEntry>,
    insideExisting = false,
  ): FactResolution => {
    if (!fact.spans.length) return fact;
    const sources: FactSource[] = fact.spans.map(({ start, end, source }) => {
      const { cell: _cell, ...rest } = structuredClone(source);
      const s = baseStart + normOffset(fact.value, start);
      const e = baseStart + normOffset(fact.value, end);
      const stamped: FactSource = { ...rest, rangeSpan: { start: s, end: e } };
      if (insideExisting || ownEdits !== undefined || baseStart > 0) {
        batchAddedSpans.set(stamped, { baseStart, xmlPos, ownEdits });
      }
      return stamped;
    });
    return { ...fact, sources };
  };
  const insertedInto = new Map<WordAgentEdit, { item: PendingRecord; offset: number }>();
  const insertedIntoFact = new Map<WordAgentEdit, { fillId: string; offset: number }>();
  const imagePending = new Set<WordAgentEdit>();
  const pendingFacts = new Map<string, ReturnType<typeof pendingReasons>>();
  const existingIds = xmlElements(xml).filter(item => item.name === 'w:bookmarkStart' || item.name === 'w:bookmarkEnd').flatMap(item => {
    const id = /\bw:id\s*=\s*["'](\d+)["']/.exec(xml.slice(item.start, item.openEnd))?.[1];
    return id ? [Number(id)] : [];
  });
  let nextBookmark = Math.max(0, ...existingIds) + 1;
  const newPending = (reasons: ReturnType<typeof pendingReasons>, originalHighlights: Array<string | null>): { item: PendingRecord; seal: { name: string; id: number } } => {
    const id = sha256Hex(JSON.stringify([name, sha256Hex(old), ledger.pending.length, added.length, reasons])).slice(0, 24);
    const item: PendingRecord = { id, draft: name, category: reasons[0].category, note: reasons[0].note, reasons, status: 'open', originalHighlights };
    added.push(item);
    return { item, seal: { name: `_Seal_P_${id}`, id: nextBookmark++ } };
  };
  const newFactSeal = (operation: WordAgentEdit, index: number): { name: string; id: number } => ({
    name: `_Seal_F_${sha256Hex(JSON.stringify([name, sha256Hex(old), index, 'fact', ledger.fills.length])).slice(0, 24)}`,
    id: nextBookmark++,
  });
  const addFactFill = (operation: WordAgentEdit, fact: FactResolution, id: string, sealKind: 'fact' | 'pending', resolvedValue: string) => {
    const cleanSources = fact.sources.map((src) => {
      const { cell: _cell, ...rest } = src;
      const cloned = structuredClone(rest);
      const meta = batchAddedSpans.get(src);
      if (meta) {
        batchAddedSpans.delete(src);
        batchAddedSpans.set(cloned, meta);
      }
      return cloned;
    });
    const fill = {
      id, draft: name, operation: operation.op,
      reference: cleanSources.map(source => source.reference).join(' + '),
      sources: cleanSources, resolvedValue,
      verified: fact.verified, sealKind,
      ...(operation.thirdPartyHolder ? { thirdPartyHolder: operation.thirdPartyHolder } : {}),
    };
    const existing = ledger.fills.findIndex(item => item.id === id && item.draft === name);
    if (existing < 0) ledger.fills.push(fill);
    else ledger.fills[existing] = fill;
  };
  const keepFactFill = (id: string, kind: 'fact' | 'pending', fact?: FactResolution): boolean => {
    const fill = ledger.fills.find(item => item.id === id && item.draft === name && item.status !== 'removed');
    if (!fill) return false;
    fill.sealKind = kind;
    if (fact) {
      const sources = fill.sources ?? [];
      for (const source of fact.sources) {
        const { cell: _cell, ...rest } = source;
        const meta = batchAddedSpans.get(source);
        // When this batch stamps rangeSpan metadata, always append before post-batch
        // shift/invalidation so in-place rewrites never get deduplicated onto an old
        // pre-existing source that is about to be invalidated.
        if (meta || !sources.some(existing => JSON.stringify(existing) === JSON.stringify(rest))) {
          const cloned = structuredClone(rest);
          if (meta) {
            batchAddedSpans.delete(source);
            batchAddedSpans.set(cloned, meta);
          }
          sources.push(cloned);
        }
      }
      fill.sources = sources;
      fill.verified &&= fact.verified;
    }
    return true;
  };
  const dismissalKey = (draftName: string, address: string, blockFingerprint: string, hintText: string, hintIndex: number) =>
    JSON.stringify([draftName, address, blockFingerprint, hintText, hintIndex]);
  const dismissedHintAddrs = new Map<AgentEdit, string[]>();
  if (input.operations.some(isDismissOp)) {
    const allHints = currentHints(xml, name);
    const hintsByAddress = new Map<string, typeof allHints>();
    for (const hint of allHints) {
      const list = hintsByAddress.get(hint.address) ?? [];
      list.push(hint);
      hintsByAddress.set(hint.address, list);
    }
    const dismissedKeys = new Set(
      ledger.dismissals.map(item =>
        dismissalKey(item.draft, item.address, item.blockFingerprint, item.hintText, item.hintIndex),
      ),
    );
    let flatNodes: Array<{ address: string; start: number; end: number }> | undefined;
    const getFlatNodes = () => {
      if (!flatNodes) {
        const collected: Array<{ address: string; start: number; end: number }> = [];
        const visit = (nodes: ReturnType<typeof bodyViewNodes>) => {
          for (const node of nodes) {
            collected.push({ address: node.address, start: node.start, end: node.end });
            visit(node.children);
          }
        };
        visit(bodyViewNodes(xml));
        flatNodes = collected;
      }
      return flatNodes;
    };
    const recordDismissal = (hint: (typeof allHints)[number], reason: string, touched: Set<string>) => {
      const key = dismissalKey(hint.draft, hint.address, hint.blockFingerprint, hint.hintText, hint.hintIndex);
      ledger.dismissals.push({
        draft: name,
        address: hint.address,
        blockFingerprint: hint.blockFingerprint,
        hintText: hint.hintText,
        hintIndex: hint.hintIndex,
        reason,
        actor: 'agent',
      });
      dismissedKeys.add(key);
      touched.add(hint.address);
    };
    for (const operation of input.operations) {
      if (operation?.op === 'dismiss_hint') {
        if (
          typeof operation.at !== 'string' ||
          !Number.isSafeInteger(operation.blank) ||
          operation.blank < 0 ||
          typeof operation.reason !== 'string' ||
          !operation.reason.trim() ||
          Object.keys(operation).some(key => !['op', 'at', 'blank', 'reason'].includes(key))
        ) {
          throw new Error('空白跳过参数无效');
        }
        const hint = hintsByAddress.get(operation.at)?.find(item => item.hintIndex === operation.blank);
        if (!hint) throw new Error('该提示不存在，请重新读取并核对');
        const key = dismissalKey(hint.draft, hint.address, hint.blockFingerprint, hint.hintText, hint.hintIndex);
        if (dismissedKeys.has(key)) throw new Error('该空白已处理');
        const touched = new Set<string>();
        recordDismissal(hint, operation.reason, touched);
        dismissedHintAddrs.set(operation, [...touched]);
      } else if (operation?.op === 'dismiss_hints') {
        if (typeof operation.reason !== 'string' || !operation.reason.trim()) {
          throw new Error('批量空白跳过参数无效：reason 必须为非空字符串');
        }
        const touched = new Set<string>();
        if ('targets' in operation) {
          if (
            Object.keys(operation).some(key => !['op', 'targets', 'reason'].includes(key)) ||
            !Array.isArray(operation.targets) ||
            operation.targets.length === 0
          ) {
            throw new Error('批量空白跳过参数无效：targets 必须为非空数组');
          }
          for (const target of operation.targets) {
            if (
              !target ||
              typeof target !== 'object' ||
              Array.isArray(target) ||
              Object.keys(target).some(key => !['at', 'blanks'].includes(key)) ||
              typeof target.at !== 'string' ||
              !target.at
            ) {
              throw new Error('批量空白跳过 target 参数无效');
            }
            resolveAddress(xml, target.at);
            const blockHints = hintsByAddress.get(target.at) ?? [];
            if (target.blanks !== undefined) {
              if (
                !Array.isArray(target.blanks) ||
                target.blanks.length === 0 ||
                target.blanks.some(item => !Number.isSafeInteger(item) || item < 0) ||
                new Set(target.blanks).size !== target.blanks.length
              ) {
                throw new Error(`块 ${target.at} 的 blanks 必须为无重复的非空非负整数数组`);
              }
              for (const blankIndex of target.blanks) {
                const hint = blockHints.find(item => item.hintIndex === blankIndex);
                if (!hint) throw new Error(`块 ${target.at} 的疑似空白 #${blankIndex} 不存在，请重新读取并核对`);
                const key = dismissalKey(hint.draft, hint.address, hint.blockFingerprint, hint.hintText, hint.hintIndex);
                if (dismissedKeys.has(key)) throw new Error(`块 ${target.at} 的疑似空白 #${blankIndex} 已处理`);
                recordDismissal(hint, operation.reason, touched);
              }
            } else {
              const unhandled = blockHints.filter(
                hint => !dismissedKeys.has(dismissalKey(hint.draft, hint.address, hint.blockFingerprint, hint.hintText, hint.hintIndex)),
              );
              if (unhandled.length === 0) {
                throw new Error(`目标块 ${target.at} 没有可跳过的未处理疑似空白`);
              }
              for (const hint of unhandled) recordDismissal(hint, operation.reason, touched);
            }
          }
        } else if ('from' in operation || 'to' in operation) {
          if (
            Object.keys(operation).some(key => !['op', 'from', 'to', 'reason'].includes(key)) ||
            typeof operation.from !== 'string' ||
            !operation.from ||
            typeof operation.to !== 'string' ||
            !operation.to
          ) {
            throw new Error('批量空白跳过参数无效：区间模式必须仅包含 from、to 与 reason');
          }
          resolveAddress(xml, operation.from);
          resolveAddress(xml, operation.to);
          const nodes = getFlatNodes();
          const fromIndex = nodes.findIndex(node => node.address === operation.from);
          const toIndex = nodes.findIndex(node => node.address === operation.to);
          if (fromIndex < 0 || toIndex < 0) {
            throw new Error('批量空白跳过区间地址不在当前文档正文视图内');
          }
          if (toIndex < fromIndex) {
            throw new Error(`批量空白跳过区间反序：结束地址 ${operation.to} 位于起始地址 ${operation.from} 之前`);
          }
          const toNode = nodes[toIndex];
          let endIndex = toIndex;
          while (endIndex + 1 < nodes.length && nodes[endIndex + 1].start < toNode.end) {
            endIndex++;
          }
          const selectedHints: typeof allHints = [];
          for (const node of nodes.slice(fromIndex, endIndex + 1)) {
            for (const hint of hintsByAddress.get(node.address) ?? []) {
              const key = dismissalKey(hint.draft, hint.address, hint.blockFingerprint, hint.hintText, hint.hintIndex);
              if (!dismissedKeys.has(key)) {
                selectedHints.push(hint);
                dismissedKeys.add(key);
              }
            }
          }
          if (selectedHints.length === 0) {
            throw new Error(`区间 ${operation.from}..${operation.to} 内没有可跳过的未处理疑似空白`);
          }
          for (const hint of selectedHints) {
            ledger.dismissals.push({
              draft: name,
              address: hint.address,
              blockFingerprint: hint.blockFingerprint,
              hintText: hint.hintText,
              hintIndex: hint.hintIndex,
              reason: operation.reason,
              actor: 'agent',
            });
            touched.add(hint.address);
          }
        } else {
          throw new Error('批量空白跳过参数无效：必须提供 targets 或 from/to 区间');
        }
        dismissedHintAddrs.set(operation, [...touched]);
      }
    }
  }
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || !['replace', 'set_cell', 'check', 'mark_pending', 'delete', 'insert_rows', 'insert', 'insert_image', 'insert_toc'].includes(operation.op) || typeof operation.at !== 'string') throw new Error('编辑操作无效或尚不支持');
    const fields: Record<string, string[]> = { replace: ['find', 'blank', 'value'], set_cell: ['value'], check: ['option', 'checked'], mark_pending: ['find', 'blank'], delete: ['allowDeleteSectionBreak'], insert_rows: ['mode', 'rows'], insert: ['position', 'markdown'], insert_image: ['image'], insert_toc: ['position', 'maxLevel'] };
    if (Object.keys(operation).some(key => !['op', 'at', 'pending', 'thirdPartyHolder', ...fields[operation.op]].includes(key))) throw new Error('编辑操作包含不支持的参数');
    if (operation.op === 'insert_toc') {
      const validatedToc = validateInsertTocEdit(xml, operation);
      const tocAnchor = resolveAddress(xml, validatedToc.at);
      const tocPosition = validatedToc.position === 'before' ? tocAnchor.start : tocAnchor.end;
      if (ranges.some(range => range.startXml < tocPosition && tocPosition < range.endXml)) {
        throw new Error('目录不能插入已有 Seal 范围内部；请插到该范围的首段之前或末段之后');
      }
      pushPrepared(operation, { op: 'insert_toc', ...validatedToc });
      continue;
    }
    if ((operation.op === 'replace' || operation.op === 'set_cell') && typeof operation.value !== 'string' || operation.op === 'check' && (typeof operation.option !== 'string' || typeof operation.checked !== 'boolean') || operation.op === 'mark_pending' && !operation.pending || operation.op === 'insert_rows' && (!['after', 'replace'].includes(operation.mode) || !Array.isArray(operation.rows)) || operation.op === 'insert' && (!['after', 'before'].includes(operation.position) || typeof operation.markdown !== 'string')) throw new Error('编辑操作参数无效');
    if (operation.pending && (!['报价', '工期交期', '质保', '偏离', '承诺', '待核对', '其他'].includes(operation.pending.category) || typeof operation.pending.note !== 'string' || Object.keys(operation.pending).some(key => !['category', 'note'].includes(key)))) throw new Error('待定类别或说明无效');
    const element = resolveAddress(xml, operation.at);
    if (operation.thirdPartyHolder !== undefined && (typeof operation.thirdPartyHolder !== 'string' || !operation.thirdPartyHolder.trim())) throw new Error('thirdPartyHolder 必须是非空持证方名称');
    const fact = input.facts?.get(operation);
    const textFact: FactResolution | undefined = fact && fact.sources.some(source => !source.media)
      ? { ...fact, sources: fact.sources.filter(source => !source.media), verified: fact.sources.filter(source => !source.media).every(source => source.verified) }
      : undefined;
    const mediaFact = fact?.sources.some(source => source.media) ?? false;
    const hasFact = !!textFact?.sources.length;
    const verifiedReference = hasFact && textFact.verified;
    const unverifiedFact = hasFact && !verifiedReference;
    let reasons: ReturnType<typeof pendingReasons> = [];
    if (operation.op === 'replace' || operation.op === 'set_cell' || operation.op === 'check' || operation.op === 'mark_pending') {
      const writeValue = operation.op === 'replace' || operation.op === 'set_cell' ? operation.value : '';
      reasons = pendingReasons({
        context: `${editableText(element.xml)} ${cellFieldLabel(xml, operation.at, operations)} ${writeValue}`,
        unverifiedFact,
        declared: operation.pending,
      });
    } else if (operation.op === 'insert_image') {
      reasons = pendingReasons({ context: '', declared: operation.pending });
      if (mediaFact && fact?.sources.some(source => source.media && !source.verified)) {
        reasons.push({ category: '待核对', note: '图片证据未核实或效期、主体未知', source: 'unverified' });
      }
    } else if (operation.op === 'insert') {
      const position = operation.position === 'before' ? element.start : element.end;
      const insidePending = ranges.some(item => item.startXml < position && position < item.endXml && initialPending.has(item.name));
      if (operation.pending || insidePending) {
        reasons = pendingReasons({ context: '', unverifiedFact, declared: operation.pending });
      }
    } else if (operation.op === 'insert_rows') {
      if (operation.pending) {
        reasons = pendingReasons({ context: '', unverifiedFact, declared: operation.pending });
      }
    }
    if (operation.op === 'insert_image') {
      const image = input.images.get(operation);
      if (!image) throw new Error('缺少图片数据');
      if (mediaFact && ranges.some(range => range.startXml < element.end && element.end < range.endXml)) throw new Error('证据不能插入已有 Seal 范围内部；请插到该范围的首段之前或末段之后');
      if (reasons.length) inserted.set(operation, reasons);
      const holder = fact?.sources.find(source => source.media)?.thirdPartyHolder;
      const caption = holder === undefined ? '' : `持证方：${holder}`;
      const isPending = reasons.length > 0;
      const label = (isPending ? pendingImageLabel() : '') + caption;
      const visible = label ? label + '\n' : label;
      let block = label && operation.at.includes('/c:') ? '<w:tbl/>' : '<w:p/>';
      if (label && isCellEdgeBlock(xml, operation.at, 'last')) block = terminateCellBlocks(block);
      insertionBlocks.set(operation, parseDocumentBody(`<w:document><w:body>${block}</w:body></w:document>`).blocks);
      let imageSeal: { name: string; id: number } | undefined;
      if (mediaFact && fact) {
        if (isPending) {
          const item = newPending(reasons, Array(visible.length).fill(null));
          imageSeal = item.seal;
          imagePending.add(operation);
          addFactFill(operation, fact, item.item.id, 'pending', visible);
        } else {
          imageSeal = newFactSeal(operation, input.operations.indexOf(operation));
          addFactFill(operation, fact, imageSeal.name.slice('_Seal_F_'.length), 'fact', visible);
        }
      }
      if (!mediaFact && visible.length > 0) {
        const pos = visibleOffsetBefore(xml, element.end);
        for (const range of ranges) {
          if (range.startXml < element.end && element.end < range.endXml) {
            const localPos = pos - range.start;
            const fillId = range.name.slice('_Seal_P_'.length);
            nonVerifiedFactTouchedFills.add(fillId);
            recordRangeEdit(fillId, {
              start: localPos,
              end: localPos,
              length: visible.length,
              xmlPos: element.end,
            });
          }
        }
      }
      pushPrepared(operation, { op: 'insert_image', at: operation.at, image, imageLabel: label, captioned: !!caption, pending: isPending, seal: imageSeal });
      continue;
    }
    if (operation.op === 'insert') {
      const position = operation.position === 'before' ? element.start : element.end;
      const range = ranges.find(item => item.startXml < position && position < item.endXml);
      if (range && mediaFact) throw new Error('证据不能插入已有 Seal 范围内部；请插到该范围的首段之前或末段之后');
      const item = range && initialPending.get(range.name);
      if (item && range) {
        insertedInto.set(operation, { item, offset: visibleOffsetBefore(xml, position) - range.start });
        for (const reason of reasons) if (!item.reasons.some(existing => JSON.stringify(existing) === JSON.stringify(reason))) item.reasons.push(reason);
        item.status = 'open'; delete item.confirmation; updated.add(item);
      } else if (range && range.name.startsWith('_Seal_F_')) {
        insertedIntoFact.set(operation, {
          fillId: range.name.slice('_Seal_F_'.length),
          offset: visibleOffsetBefore(xml, position) - range.start,
        });
        const factInsertReasons = pendingReasons({
          context: '',
          unverifiedFact,
          declared: operation.pending,
        });
        const effectiveReasons = reasons.length ? reasons : factInsertReasons;
        if (effectiveReasons.length) {
          const prior = pendingFacts.get(range.name);
          const combined = [...(prior ?? []), ...effectiveReasons];
          pendingFacts.set(
            range.name,
            combined.filter((reason, idx) => combined.findIndex(entry => JSON.stringify(entry) === JSON.stringify(reason)) === idx),
          );
        }
      } else if (reasons.length) inserted.set(operation, reasons);
      const mediaSources = fact?.sources.filter(source => source.media) ?? [];
      const parsed = markdownImageTokens(operation.markdown);
      const imageCaptions: Array<string | undefined> = [];
      const imageSeals = parsed.images.map((_, imageIndex) => {
        const source = mediaSources.find(item => item.imageIndex === imageIndex);
        if (!source) return undefined;
        const caption = source.thirdPartyHolder === undefined ? '' : `持证方：${source.thirdPartyHolder}`;
        imageCaptions[imageIndex] = caption;
        const sourceFact: FactResolution = { value: '', sources: [source], spans: [], verified: source.verified };
        if (!source.verified) {
          const label = pendingImageLabel(imageIndex) + caption + '\n';
          const { item, seal } = newPending([{ category: '待核对', note: '图片证据未核实或效期、主体未知', source: 'unverified' }], Array(label.length).fill(null));
          addFactFill(operation, sourceFact, item.id, 'pending', label);
          return seal;
        }
        const seal = newFactSeal(operation, input.operations.indexOf(operation));
        addFactFill(operation, sourceFact, seal.name.slice('_Seal_F_'.length), 'fact', caption ? caption + '\n' : '');
        return seal;
      });
      const width = layoutBox(xml, position, { stylesXml: new TextDecoder().decode((await validatePackageStructure(input.old)).get('word/styles.xml') ?? new Uint8Array()) }).width / 635;
      const pictureBlocks = new Map(parsed.images.flatMap((image, index) => [[image.placeholder, { paragraph: '<w:p/>', width, atomic: !!imageCaptions[index] || !!imageSeals[index]?.name.startsWith('_Seal_P_') || reasons.length > 0 }] as const]));
      let content = layoutCaptionedImages(markdownBlocks(operation.markdown, { tokens: parsed.tokens, widthTwips: width }).xml, pictureBlocks, operation.at.includes('/c:'));
      if (operation.position === 'after' && isCellEdgeBlock(xml, operation.at, 'last')) content = terminateCellBlocks(content);
      if (operation.position === 'before' && isCellEdgeBlock(xml, operation.at, 'first')) content = startCellBlocks(content);
      insertionBlocks.set(operation, parseDocumentBody(`<w:document><w:body>${content}</w:body></w:document>`).blocks);
      pushPrepared(operation, { op: 'insert', at: operation.at, position: operation.position, markdown: operation.markdown, yellow: false, pendingImages: reasons.length > 0, images: input.markdownImages.get(operation) ?? [], imageSeals, imageCaptions, markdownLiterals: fact?.markdownLiterals }); continue;
    }
    if (operation.op === 'insert_rows') {
      if (reasons.length) inserted.set(operation, reasons);
      const rowStart = visibleOffsetBefore(xml, element.start);
      const rowEnd = visibleOffsetBefore(xml, element.end);
      const insertedLen = operation.rows.reduce(
        (sum, row) => sum + row.reduce((rSum, cell) => rSum + cell.replace(/\r\n/g, '\n').length, 0),
        0,
      );
      for (const range of ranges) {
        if (operation.mode === 'replace') {
          if (rowEnd <= range.start || rowStart >= range.end) continue;
          const localStart = Math.max(0, rowStart - range.start);
          const localEnd = Math.min(range.end - range.start, rowEnd - range.start);
          if (localEnd > localStart || insertedLen > 0) {
            const fillId = range.name.slice('_Seal_P_'.length);
            nonVerifiedFactTouchedFills.add(fillId);
            recordRangeEdit(fillId, {
              start: localStart,
              end: localEnd,
              length: insertedLen,
              xmlPos: element.start,
            });
          }
        } else if (range.startXml < element.end && element.end < range.endXml && insertedLen > 0) {
          const localPos = rowEnd - range.start;
          const fillId = range.name.slice('_Seal_P_'.length);
          nonVerifiedFactTouchedFills.add(fillId);
          recordRangeEdit(fillId, {
            start: localPos,
            end: localPos,
            length: insertedLen,
            xmlPos: element.end,
          });
        }
      }
      const cellHighlights = parseRowCells(element.xml).map((_cell, colIndex) => pendingCellNativeHighlight(`${operation.at}/c:${colIndex}`, true));
      pushPrepared(operation, { op: operation.op, at: operation.at, mode: operation.mode, rows: operation.rows, yellow: false, cellHighlights });
      continue;
    }
    if (operation.op === 'delete') {
      const delStart = visibleOffsetBefore(xml, element.start);
      const delEnd = visibleOffsetBefore(xml, element.end);
      for (const range of ranges) {
        if (delEnd <= range.start || delStart >= range.end) continue;
        const localStart = Math.max(0, delStart - range.start);
        const localEnd = Math.min(range.end - range.start, delEnd - range.start);
        if (localEnd > localStart) {
          const fillId = range.name.slice('_Seal_P_'.length);
          nonVerifiedFactTouchedFills.add(fillId);
          recordRangeEdit(fillId, {
            start: localStart,
            end: localEnd,
            length: 0,
            xmlPos: element.start,
          });
        }
      }
      pushPrepared(operation, {
        op: operation.op,
        at: operation.at,
        ...(operation.allowDeleteSectionBreak !== undefined ? { allowDeleteSectionBreak: operation.allowDeleteSectionBreak } : {}),
      });
      continue;
    }
    const target = operation.op === 'replace' || operation.op === 'mark_pending' ? resolveTextTarget(xml, operation) : operation.op === 'check' ? resolveCheckTarget(xml, operation.at, operation.option) : { start: 0, end: 0, find: '' };
    const offset = visibleOffsetBefore(xml, element.start), start = offset + target.start, end = offset + target.end;
    const related = ranges.map(range => ({ range, relation: rangeRelation(range, start, end) })).filter(item => item.relation !== 'disjoint');
    if (related.some(item => item.relation === 'partial')) throw new Error('编辑与 Seal 范围部分交叉；请整体替换该范围或只改范围内部');
    const contained = related.find(item => item.relation === 'inside')?.range;
    const existing = contained && initialPending.get(contained.name);
    const retainedFact = contained?.name.startsWith('_Seal_F_') ? contained : undefined;
    const value = operation.op === 'mark_pending' ? target.find : operation.op === 'check' ? operation.checked ? '☑' : '□' : operation.value.replace(/\r\n/g, '\n');
    let seal: { name: string; id: number } | undefined;
    let factFillId: string | undefined, factSealKind: 'fact' | 'pending' | undefined;
    let factToAdd: FactResolution | undefined = fact;
    const factCoverage =
      hasFact && !!fact && fact.value.replace(/\r\n/g, '\n') === value
        ? {
            allSpans: fact.spans.map(
              (span) => [normOffset(fact.value, span.start), normOffset(fact.value, span.end)] as const,
            ),
            verifiedSpans: fact.spans
              .filter((span) => span.source.verified)
              .map((span) => [normOffset(fact.value, span.start), normOffset(fact.value, span.end)] as const),
          }
        : undefined;
    if (existing) {
      let ownEdits: ReadonlySet<RangeEditEntry> | undefined;
      let localStart = 0;
      if (operation.op !== 'mark_pending') {
        localStart = start - contained!.start;
        const localEnd = end - contained!.start;
        const edits = highlightEdits.get(existing) ?? [];
        edits.push({ start: localStart, end: localEnd, length: value.length });
        highlightEdits.set(existing, edits);
        ownEdits = recordRangeEdits(
          existing.id,
          diffTextRangeEdits(localStart, target.find, value, element.start, factCoverage),
        );
        if (
          hasFact &&
          !!factCoverage &&
          factCoverage.allSpans.length > 0 &&
          localStart === 0 &&
          localEnd === contained!.text.length
        ) {
          fullRangeRebindFills.set(existing.id, {
            verifiedFullCover: isSubIntervalCovered(0, value.length, factCoverage.verifiedSpans),
          });
        }
      }
      for (const reason of reasons) if (!existing.reasons.some(item => JSON.stringify(item) === JSON.stringify(reason))) existing.reasons.push(reason);
      existing.status = 'open'; delete existing.confirmation;
      updated.add(existing);
      const spanned = fact ? buildSpannedFact(fact, localStart, element.start, ownEdits, true) : undefined;
      factToAdd = spanned;
      if (hasFact && !keepFactFill(existing.id, 'pending', spanned)) {
        factFillId = existing.id;
        factSealKind = 'pending';
        batchCreatedAggregateFills.add(existing.id);
      }
    } else if (retainedFact) {
      const retainedId = retainedFact.name.slice('_Seal_F_'.length);
      let ownEdits: ReadonlySet<RangeEditEntry> | undefined;
      let localStart = 0;
      if (operation.op !== 'mark_pending') {
        localStart = start - contained!.start;
        const hunks = diffTextRangeEdits(localStart, target.find, value, element.start, factCoverage);
        ownEdits = recordRangeEdits(retainedId, hunks);
        const fullyVerifiedReplace =
          target.find === value ||
          (hasFact &&
            verifiedReference &&
            !!factCoverage &&
            hunks.every((hunk) => hunk.coveredByVerifiedFact === true));
        if (!fullyVerifiedReplace) nonVerifiedFactTouchedFills.add(retainedId);
        if (
          hasFact &&
          !!factCoverage &&
          factCoverage.allSpans.length > 0 &&
          localStart === 0 &&
          end - contained!.start === contained!.text.length
        ) {
          fullRangeRebindFills.set(retainedId, {
            verifiedFullCover: isSubIntervalCovered(0, value.length, factCoverage.verifiedSpans),
          });
        }
      }
      const effectiveReasons = reasons.length || verifiedReference
        ? reasons
        : [{ category: '待核对' as const, note: '事实来源未核实', source: 'unverified' as const }];
      const prior = pendingFacts.get(retainedFact.name);
      if (effectiveReasons.length) {
        const combined = [...(prior ?? []), ...effectiveReasons];
        pendingFacts.set(retainedFact.name, combined.filter((reason, index) => combined.findIndex(item => JSON.stringify(item) === JSON.stringify(reason)) === index));
      }
      const spanned = fact ? buildSpannedFact(fact, localStart, element.start, ownEdits, true) : undefined;
      keepFactFill(retainedId, pendingFacts.has(retainedFact.name) ? 'pending' : 'fact', spanned);
    } else if (reasons.length && value) {
      const cellFill = operation.op === 'set_cell' || target.start === target.end;
      const source = cellFill ? cellStyleSource(xml, operation.at) : undefined;
      const covering = related.filter(item => item.relation === 'cover').flatMap(item => {
        const previous = initialPending.get(item.range.name);
        return previous ? [{ range: item.range, previous }] : [];
      });
      const first = covering.find(item => item.range.start <= start && item.range.end > start);
      const inherited = first ? first.previous.originalHighlights[start - first.range.start] : cellFill ? source ? sourceHighlight(source) : null : highlight(visibleRunProperties(element.xml)[target.start] ?? '');
      const originalHighlight = inherited;
      const originalHighlights: Array<string | null> = operation.op === 'mark_pending' ? visibleRunProperties(element.xml).slice(target.start, target.end).map(highlight) : Array(value.length).fill(originalHighlight ?? null);
      if (operation.op === 'mark_pending') for (const item of covering) {
        const offset = item.range.start - start;
        originalHighlights.splice(offset, item.previous.originalHighlights.length, ...item.previous.originalHighlights);
      }
      const created = newPending(reasons, originalHighlights);
      seal = created.seal;
      if (hasFact) {
        factFillId = created.item.id;
        factSealKind = 'pending';
        factToAdd = fact ? buildSpannedFact(fact, 0) : undefined;
      }
    } else if (hasFact && value) {
      seal = newFactSeal(operation, input.operations.indexOf(operation));
      factFillId = seal.name.slice('_Seal_F_'.length);
      factSealKind = 'fact';
      factToAdd = fact ? buildSpannedFact(fact, 0) : undefined;
    }
    if (hasFact && factToAdd && factFillId && factSealKind) addFactFill(operation, factToAdd, factFillId, factSealKind, value);
    const yellow = !retainedFact && (reasons.length > 0 || !!existing);
    const cellFill = operation.op === 'set_cell' || (operation.op === 'replace' && target.start === target.end);
    const styleSource = !yellow && cellFill ? cellStyleSource(xml, operation.at) : undefined;
    const nativeHighlight = styleSource ? pendingCellNativeHighlight(styleSource, true) : undefined;
    if (operation.op === 'replace') pushPrepared(operation, { op: 'replace', at: operation.at, ...(operation.find !== undefined ? { find: operation.find } : { blank: operation.blank }), value, yellow, ...(nativeHighlight !== undefined ? { nativeHighlight } : {}), seal });
    else if (operation.op === 'mark_pending') {
      if (!retainedFact) pushPrepared(operation, { op: 'mark_pending', at: operation.at, ...(operation.find !== undefined ? { find: operation.find } : { blank: operation.blank }), seal });
    }
    else if (operation.op === 'check') pushPrepared(operation, { op: 'check', at: operation.at, option: operation.option, checked: operation.checked, yellow, seal });
    else pushPrepared(operation, { op: 'set_cell', at: operation.at, value, yellow, ...(nativeHighlight !== undefined ? { nativeHighlight } : {}), seal });
  }
  const editedResult = prepared.length
    ? await editTextDocumentWithMeta(old, prepared, input.host)
    : { bytes: old.slice(), tocEffects: [] as AppliedTocEffect[], nonTocInsertedAddresses: new Map<number, string[]>() };
  let output = editedResult.bytes;
  const { tocEffects, nonTocInsertedAddresses } = editedResult;
  let outputXml = await documentXml(output);
  if (tocEffects.length > 0) {
    const outputBookmarkIds = xmlElements(outputXml)
      .filter(item => item.name === 'w:bookmarkStart' || item.name === 'w:bookmarkEnd')
      .flatMap(item => {
        const id = /\bw:id\s*=\s*["'](\d+)["']/.exec(outputXml.slice(item.start, item.openEnd))?.[1];
        return id ? [Number(id)] : [];
      });
    nextBookmark = Math.max(nextBookmark, ...outputBookmarkIds.map(id => id + 1));
  }
  const outputBody = bodyViewNodes(outputXml);
  const mappedAddress = (address: string) => {
    const afterNonToc = addressAfterEdits(address, operations, xml, insertionBlocks);
    const pMatch = /^p:(\d+)$/.exec(afterNonToc);
    if (!pMatch || tocEffects.length === 0) return afterNonToc;
    let pIdx = Number(pMatch[1]);
    for (const effect of tocEffects) {
      const shiftStart = effect.paragraphsBeforeReplaceRange + effect.oldRangeParagraphCount;
      if (pIdx >= shiftStart) {
        pIdx += effect.newRangeParagraphCount - effect.oldRangeParagraphCount;
      }
    }
    return `p:${pIdx}`;
  };
  const siblings = (address: string) => {
    const parts = address.split('/'); let nodes = outputBody, prefix = '';
    for (const part of parts.slice(0, -1)) { prefix = prefix ? `${prefix}/${part}` : part; const node = nodes.find(item => item.address === prefix); if (!node) throw new Error('无法确定插入内容的父级地址'); nodes = node.children; }
    return nodes;
  };
  const insertedNodes = (operation: Extract<WordAgentEdit, { op: 'insert' | 'insert_image' }>) => {
    const prepIdx = preparedIndexByOp.get(operation);
    if (tocEffects.length > 0 && prepIdx !== undefined && nonTocInsertedAddresses.has(prepIdx)) {
      const addrs = nonTocInsertedAddresses.get(prepIdx)!;
      const byAddr = new Map(outputBody.map(node => [node.address, node]));
      const nodes = addrs.map(addr => byAddr.get(addr)).filter((node): node is NonNullable<typeof node> => node !== undefined);
      if (nodes.length !== addrs.length) throw new Error('无法确定全部插入内容的新地址');
      return nodes;
    }
    const anchor = mappedAddress(operation.at), nodes = siblings(anchor), index = nodes.findIndex(node => node.address === anchor);
    if (index < 0) throw new Error('无法确定插入内容的新地址');
    const count = insertionBlocks.get(operation)!.filter(block => block.kind === 'paragraph' || block.kind === 'table').length;
    const start = operation.op === 'insert' && operation.position === 'before' ? index - count : index + 1, result = nodes.slice(start, start + count);
    if (result.length !== count) throw new Error('无法确定全部插入内容的新地址');
    return result;
  };
  let tocEffectCursor = 0;
  const results = input.operations.map(operation => {
    if (operation.op === 'dismiss_hints') {
      const views = (dismissedHintAddrs.get(operation) ?? []).flatMap(rawAddress => {
        const address = mappedAddress(rawAddress);
        try {
          const node = resolveAddress(outputXml, address);
          return [{ address, kind: node.kind, text: editableText(node.xml) }];
        } catch {
          return [];
        }
      });
      return { op: operation.op, status: 'applied' as const, views };
    }
    let addresses: string[] = [];
    if (operation.op === 'insert_toc') {
      const effectIndex = tocEffectCursor++;
      const effect = tocEffects[effectIndex];
      if (effect) {
        addresses = effect.insertedAddresses.map(address => {
          let pIdx = Number(/^p:(\d+)$/.exec(address)![1]);
          for (let j = effectIndex + 1; j < tocEffects.length; j++) {
            const shiftStart = tocEffects[j].paragraphsBeforeReplaceRange + tocEffects[j].oldRangeParagraphCount;
            if (pIdx >= shiftStart) {
              pIdx += tocEffects[j].newRangeParagraphCount - tocEffects[j].oldRangeParagraphCount;
            }
          }
          return `p:${pIdx}`;
        });
      }
    } else if (operation.op === 'insert_rows') {
      const table = operation.at.replace(/\/r:\d+$/, ''), mapped = mappedAddress(table), row = Number(/\/r:(\d+)$/.exec(mappedAddress(operation.at))?.[1]);
      addresses = operation.rows.map((_, index) => `${mapped}/r:${row + index + (operation.mode === 'after' ? 1 : 0)}`);
    } else if (operation.op === 'insert' || operation.op === 'insert_image' && resolveAddress(xml, operation.at).kind !== 'cell') addresses = insertedNodes(operation).map(node => node.address);
    else if (operation.op !== 'delete') addresses = [mappedAddress(operation.at)];
    return { op: operation.op, status: 'applied' as const, views: addresses.map(address => { const node = resolveAddress(outputXml, address); return { address, kind: node.kind, text: editableText(node.xml) }; }) };
  });
  const marking: DocumentEdit[] = [];
  let factSequence = 0;
  for (const [index, operation] of input.operations.entries()) {
    if (isDismissOp(operation)) continue;
    const reasons = inserted.get(operation), containing = insertedInto.get(operation), containingFact = insertedIntoFact.get(operation), fact = input.facts?.get(operation);
    const textFact = fact && fact.sources.some(source => !source.media) ? { ...fact, sources: fact.sources.filter(source => !source.media) } : undefined;
    const needsFactMarking = !!textFact?.sources.length && (operation.op === 'insert' || operation.op === 'insert_rows');
    if (!reasons && !containing && !containingFact && !needsFactMarking && operation.op !== 'insert_rows') continue;
    if (operation.op === 'insert_image' && imagePending.has(operation)) continue;
    const find = (nodes: ReturnType<typeof bodyViewNodes>, address: string): ReturnType<typeof bodyViewNodes>[number] | undefined => {
      for (const node of nodes) { if (node.address === address) return node; const child = find(node.children, address); if (child) return child; }
      return undefined;
    };
    const markFactOrPending = (match: LocatedFact) => {
      const value = displayedFactValue(match.source).replace(/\r\n/g, '\n');
      const spannedSource: FactSource = {
        ...structuredClone(match.source),
        rangeSpan: { start: 0, end: value.length },
      };
      if (match.source.verified) {
        const seal = newFactSeal(operation, index + factSequence++);
        marking.push({ op: 'mark_fact', at: match.address, span: { start: match.start, end: match.end }, seal });
        addFactFill(operation, { value, sources: [spannedSource], spans: [], verified: true }, seal.name.slice('_Seal_F_'.length), 'fact', value);
      } else {
        const unverifiedReasons = pendingReasons({ context: '', unverifiedFact: true });
        const originals = visibleRunProperties(match.xml).slice(match.start, match.end).map(highlight);
        const { item, seal } = newPending(unverifiedReasons, originals);
        marking.push({ op: 'mark_pending', at: match.address, span: { start: match.start, end: match.end }, seal });
        addFactFill(operation, { value, sources: [spannedSource], spans: [], verified: false }, item.id, 'pending', value);
      }
    };
    if (operation.op === 'insert_rows' && !reasons?.length) {
      const tableAddress = operation.at.replace(/\/r:\d+$/, '');
      const readHeaderRanges = (docXml: string, tblAddr: string): CellLogicalRange[] => {
        try {
          return rowCellLogicalRanges(resolveAddress(docXml, `${tblAddr}/r:0`).xml);
        } catch {
          return [];
        }
      };
      const beforeHeaderRanges = readHeaderRanges(xml, tableAddress);
      const afterHeaderRanges = readHeaderRanges(outputXml, mappedAddress(tableAddress));
      const rowTargetRanges = new Map<number, CellLogicalRange[]>();
      const cellEntries: Array<{ rowIdx: number; colIdx: number; paragraphs: InsertedParagraph[] }> = [];
      const allRowParagraphs: InsertedParagraph[] = [];
      for (const [rowIdx, view] of results[index].views.entries()) {
        const rowNode = find(outputBody, view.address);
        if (!rowNode) throw new Error('无法确定待定内容的新地址');
        rowTargetRanges.set(rowIdx, rowCellLogicalRanges(rowNode.xml));
        for (const [colIdx, cellNode] of rowNode.children.entries()) {
          const paragraphs: InsertedParagraph[] = [];
          const collect = (nodes: ReturnType<typeof bodyViewNodes>) => {
            for (const node of nodes) {
              if (node.kind === 'paragraph') {
                const text = editableText(node.xml);
                if (text) {
                  const entry: InsertedParagraph = { address: node.address, text, xml: node.xml, rowIdx, colIdx };
                  paragraphs.push(entry);
                  allRowParagraphs.push(entry);
                }
              } else collect(node.children);
            }
          };
          collect([cellNode]);
          if (paragraphs.length) cellEntries.push({ rowIdx, colIdx, paragraphs });
        }
      }
      const located: LocatedFact[] = [];
      if (textFact?.sources.length) {
        const paragraphByCell = new Map<string, InsertedParagraph>();
        for (const entry of cellEntries) {
          if (entry.paragraphs.length === 1) paragraphByCell.set(`${entry.rowIdx}:${entry.colIdx}`, entry.paragraphs[0]);
        }
        const unpositioned: FactSource[] = [];
        for (const source of textFact.sources) {
          if (source.cell) {
            const target = paragraphByCell.get(`${source.cell.row}:${source.cell.col}`);
            const value = displayedFactValue(source).replace(/\r\n/g, '\n');
            if (!target || target.text.slice(source.cell.start, source.cell.end) !== value) {
              throw new Error(`事实引用在插入行单元格 (${source.cell.row}, ${source.cell.col}) 中定位失效：${source.reference}`);
            }
            located.push({ ...target, source, start: source.cell.start, end: source.cell.end });
          } else {
            unpositioned.push(source);
          }
        }
        if (unpositioned.length) located.push(...locateFactOccurrences(unpositioned, allRowParagraphs));
      }
      const factsByCell = new Map<string, LocatedFact[]>();
      for (const match of located) {
        const key = `${match.rowIdx}:${match.colIdx}`;
        const list = factsByCell.get(key) ?? [];
        list.push(match);
        factsByCell.set(key, list);
      }
      for (const entry of cellEntries) {
        const rowValues = operation.rows[entry.rowIdx] ?? [];
        const targetRanges = rowTargetRanges.get(entry.rowIdx) ?? [];
        const beforeHeader = beforeHeaderRanges.length
          ? overlappingHeaderText(beforeHeaderRanges, targetRanges, entry.colIdx)
          : '';
        const afterHeader = afterHeaderRanges.length
          ? overlappingHeaderText(afterHeaderRanges, targetRanges, entry.colIdx)
          : '';
        const headerText = [...new Set([beforeHeader, afterHeader].filter(Boolean))].join(' ');
        const effectiveHeaderRanges = afterHeaderRanges.length ? afterHeaderRanges : beforeHeaderRanges;
        const label = combineCellLabel(headerText, entry.colIdx, targetRanges, effectiveHeaderRanges, rowValues[0] ?? '');
        const cellText = entry.paragraphs.map(p => p.text).join('\n');
        const cellFacts = factsByCell.get(`${entry.rowIdx}:${entry.colIdx}`) ?? [];
        const cellReasons = pendingReasons({
          context: `${cellText} ${label}`,
          unverifiedFact: cellFacts.some(m => !m.source.verified),
        });
        if (cellReasons.length) {
          for (const paragraph of entry.paragraphs) {
            const originalHighlights = Array(paragraph.text.length).fill(sourceHighlight(`${operation.at}/c:${entry.colIdx}`, true));
            const { item, seal } = newPending(cellReasons, originalHighlights);
            marking.push({ op: 'mark_pending', at: paragraph.address, span: { start: 0, end: paragraph.text.length }, seal });
            const paraSources = cellFacts
              .filter(m => m.address === paragraph.address)
              .map(m => ({ ...structuredClone(m.source), rangeSpan: { start: m.start, end: m.end } }));
            if (paraSources.length) {
              addFactFill(
                operation,
                { value: paragraph.text, sources: paraSources, spans: [], verified: paraSources.every(s => s.verified) },
                item.id,
                'pending',
                paragraph.text,
              );
            }
          }
        } else {
          for (const match of cellFacts) markFactOrPending(match);
        }
      }
      continue;
    }
    const insertedOriginals: Array<string | null> = [];
    const insertedParagraphs: InsertedParagraph[] = [];
    const pendingSlices: Array<{ address: string; start: number; end: number; text: string; itemId: string }> = [];
    const addParagraphs = (nodes: ReturnType<typeof bodyViewNodes>) => {
      for (const node of nodes) {
        if (node.kind === 'paragraph') {
          const value = editableText(node.xml);
          if (value) {
            let rowIdx: number | undefined;
            let colIdx: number | undefined;
            let originalHighlights = operation.op === 'insert_image' ? Array(value.length).fill(null) : visibleRunProperties(node.xml).map(highlight);
            if (operation.op === 'insert_rows') {
              const rowViewIdx = results[index].views.findIndex(view => node.address.startsWith(`${view.address}/`));
              const row = rowViewIdx >= 0 ? results[index].views[rowViewIdx] : undefined;
              const cell = row && /^\/c:(\d+)(?:\/|$)/.exec(node.address.slice(row.address.length))?.[1];
              if (cell === undefined) throw new Error('无法确定复制行的样式来源');
              rowIdx = rowViewIdx;
              colIdx = Number(cell);
              originalHighlights = Array(value.length).fill(sourceHighlight(`${operation.at}/c:${cell}`, true));
            }
            insertedParagraphs.push({ address: node.address, text: value, xml: node.xml, rowIdx, colIdx });
            if (containing) {
              insertedOriginals.push(...originalHighlights);
              marking.push({ op: 'mark_pending', at: node.address, span: { start: 0, end: value.length } });
            } else if (reasons?.length) {
              // A drawing has XML extent even when it contributes no visible characters.
              const images = operation.op === 'insert' && fact?.sources.some(source => source.media) ? sealRanges(node.xml) : [];
              let start = 0;
              for (const image of [...images, { start: value.length, end: value.length }]) {
                const end = image.start;
                const text = value.slice(start, end);
                if (text) {
                  const { item, seal } = newPending(reasons, originalHighlights.slice(start, end));
                  marking.push({ op: 'mark_pending', at: node.address, span: { start, end }, seal });
                  pendingSlices.push({ address: node.address, start, end, text, itemId: item.id });
                }
                start = image.end;
              }
            }
          }
        } else addParagraphs(node.children);
      }
    };
    for (const view of results[index].views) { const node = find(outputBody, view.address); if (!node) throw new Error('无法确定待定内容的新地址'); addParagraphs([node]); }
    if (pendingSlices.length && textFact?.sources.length) {
      const located: LocatedFact[] = [];
      const unpositioned: FactSource[] = [];
      const paragraphByCell = new Map<string, InsertedParagraph>();
      if (operation.op === 'insert_rows') {
        const countByCell = new Map<string, number>();
        for (const para of insertedParagraphs) {
          if (para.rowIdx === undefined || para.colIdx === undefined) continue;
          const key = `${para.rowIdx}:${para.colIdx}`;
          countByCell.set(key, (countByCell.get(key) ?? 0) + 1);
        }
        for (const para of insertedParagraphs) {
          if (para.rowIdx === undefined || para.colIdx === undefined) continue;
          const key = `${para.rowIdx}:${para.colIdx}`;
          if (countByCell.get(key) === 1) paragraphByCell.set(key, para);
        }
      }
      for (const source of textFact.sources) {
        if (source.cell && operation.op === 'insert_rows') {
          const target = paragraphByCell.get(`${source.cell.row}:${source.cell.col}`);
          const expectedVal = displayedFactValue(source).replace(/\r\n/g, '\n');
          if (!target || target.text.slice(source.cell.start, source.cell.end) !== expectedVal) {
            throw new Error(`事实引用在插入行单元格 (${source.cell.row}, ${source.cell.col}) 中定位失效：${source.reference}`);
          }
          located.push({ ...target, source, start: source.cell.start, end: source.cell.end });
        } else {
          unpositioned.push(source);
        }
      }
      if (unpositioned.length) located.push(...locateFactOccurrences(unpositioned, insertedParagraphs));
      let matchedTotal = 0;
      for (const slice of pendingSlices) {
        const matches = located.filter(
          (match) =>
            match.address === slice.address &&
            match.start >= slice.start &&
            match.end <= slice.end,
        );
        matchedTotal += matches.length;
        const sources = matches.map((match) => ({
          ...structuredClone(match.source),
          rangeSpan: { start: match.start - slice.start, end: match.end - slice.start },
        }));
        if (sources.length) {
          addFactFill(
            operation,
            { value: slice.text, sources, spans: [], verified: sources.every((source) => source.verified) },
            slice.itemId,
            'pending',
            slice.text,
          );
        }
      }
      if (matchedTotal !== located.length) {
        throw new Error('待定插入内容中的事实引用跨越了图片或边界，无法唯一定位；请拆分段落后再写入');
      }
    }
    if (!reasons?.length && !containing && !containingFact && textFact?.sources.length) {
      for (const match of locateFactOccurrences(textFact.sources, insertedParagraphs)) markFactOrPending(match);
    }
    if (containingFact) {
      const promotedKind = pendingFacts.has(`_Seal_F_${containingFact.fillId}`) ? 'pending' : 'fact';
      const insertedChars = insertedParagraphs.reduce((sum, para) => sum + para.text.length, 0);
      if (insertedChars > 0) {
        const anchorEl = resolveAddress(xml, operation.at);
        const insertXmlPos = operation.op === 'insert' && operation.position === 'before' ? anchorEl.start : anchorEl.end;
        recordRangeEdit(containingFact.fillId, {
          start: containingFact.offset,
          end: containingFact.offset,
          length: insertedChars,
          xmlPos: insertXmlPos,
        });
        const postRange = sealRanges(outputXml).find((item) => item.name === `_Seal_F_${containingFact.fillId}`);
        if (textFact?.sources.length && postRange) {
          const matches = locateFactOccurrences(textFact.sources, insertedParagraphs);
          if (matches.length) {
            const sources = matches.map((match) => {
              const { cell: _cell, ...rest } = structuredClone(match.source);
              const postPara = resolveAddress(outputXml, match.address);
              const paraRelStart = visibleOffsetBefore(outputXml, postPara.start) - postRange.start;
              const stamped: FactSource = {
                ...rest,
                rangeSpan: {
                  start: paraRelStart + match.start,
                  end: paraRelStart + match.end,
                },
              };
              batchAddedSpans.set(stamped, { baseStart: paraRelStart, xmlPos: insertXmlPos, finalized: true });
              return stamped;
            });
            keepFactFill(containingFact.fillId, promotedKind, { ...textFact, sources });
          }
          const fullyVerifiedInsert =
            textFact.verified &&
            insertedParagraphs.every((para) =>
              isIntervalCovered(
                para.text.length,
                matches
                  .filter((m) => m.address === para.address && m.source.verified)
                  .map((m) => [m.start, m.end] as const),
              ),
            );
          if (!fullyVerifiedInsert) nonVerifiedFactTouchedFills.add(containingFact.fillId);
        } else {
          nonVerifiedFactTouchedFills.add(containingFact.fillId);
          if (promotedKind === 'pending') {
            keepFactFill(containingFact.fillId, 'pending');
          }
        }
      } else if (promotedKind === 'pending') {
        keepFactFill(containingFact.fillId, 'pending');
      }
    }
    if (containing && insertedOriginals.length) {
      const anchorEl = resolveAddress(xml, operation.at);
      const insertXmlPos = operation.op === 'insert' && operation.position === 'before' ? anchorEl.start : anchorEl.end;
      recordRangeEdit(containing.item.id, {
        start: containing.offset,
        end: containing.offset,
        length: insertedOriginals.length,
        xmlPos: insertXmlPos,
      });
      const postRange = sealRanges(outputXml).find((item) => item.name === `_Seal_P_${containing.item.id}`);
      let spannedTextFact = textFact;
      if (textFact?.sources.length && postRange) {
        const matches = locateFactOccurrences(textFact.sources, insertedParagraphs);
        if (matches.length) {
          const sources = matches.map((match) => {
            const { cell: _cell, ...rest } = structuredClone(match.source);
            const postPara = resolveAddress(outputXml, match.address);
            const paraRelStart = visibleOffsetBefore(outputXml, postPara.start) - postRange.start;
            const stamped: FactSource = {
              ...rest,
              rangeSpan: {
                start: paraRelStart + match.start,
                end: paraRelStart + match.end,
              },
            };
            batchAddedSpans.set(stamped, { baseStart: paraRelStart, xmlPos: insertXmlPos, finalized: true });
            return stamped;
          });
          spannedTextFact = { ...textFact, sources };
        }
      }
      if (spannedTextFact && !keepFactFill(containing.item.id, 'pending', spannedTextFact)) {
        if (!postRange) throw new Error('无法确定既有待定范围内的事实引用');
        addFactFill(operation, spannedTextFact, containing.item.id, 'pending', postRange.text);
        batchCreatedAggregateFills.add(containing.item.id);
      }
      const edits = highlightEdits.get(containing.item) ?? [];
      edits.push({ start: containing.offset, end: containing.offset, length: insertedOriginals.length, originals: insertedOriginals });
      highlightEdits.set(containing.item, edits);
    }
  }
  for (const [item, edits] of highlightEdits) for (const edit of edits.sort((a, b) => b.start - a.start)) {
    const inherited = item.originalHighlights[edit.start] ?? null;
    item.originalHighlights.splice(edit.start, edit.end - edit.start, ...(edit.originals ?? Array(edit.length).fill(inherited)));
  }
  const supersededSources = new Set<FactSource>();
  for (const [fillId, edits] of rangeEditsByFillId) {
    const fill = ledger.fills.find((item) => item.id === fillId && item.draft === name && item.status !== 'removed');
    if (!fill?.sources?.length) continue;
    const rebindMeta =
      fillTouchCount.get(fillId) === 1 ? fullRangeRebindFills.get(fillId) : undefined;
    const isFullRangeRebind =
      !!rebindMeta &&
      (fill.sealKind === 'pending' || rebindMeta.verifiedFullCover) &&
      !fill.sources.some((src) => !batchAddedSpans.has(src) && src.media);
    let removedSuperseded = false;
    for (const src of fill.sources) {
      if (isFullRangeRebind && !batchAddedSpans.has(src)) {
        supersededSources.add(src);
        removedSuperseded = true;
        continue;
      }
      if (!src.rangeSpan || src.rangeSpan.start < 0) continue;
      const addedMeta = batchAddedSpans.get(src);
      if (addedMeta) {
        if (addedMeta.finalized) continue;
        let deltaBefore = 0;
        for (const edit of edits) {
          if (addedMeta.ownEdits?.has(edit)) continue;
          if (
            edit.end < addedMeta.baseStart ||
            (edit.end === addedMeta.baseStart && edit.xmlPos <= addedMeta.xmlPos)
          ) {
            deltaBefore += edit.length - (edit.end - edit.start);
          }
        }
        src.rangeSpan = {
          start: src.rangeSpan.start + deltaBefore,
          end: src.rangeSpan.end + deltaBefore,
        };
      } else {
        const origS = src.rangeSpan.start;
        const origE = src.rangeSpan.end;
        let deltaBefore = 0;
        const overlappingEdits: RangeEditEntry[] = [];
        for (const edit of edits) {
          if (edit.end <= origS) {
            deltaBefore += edit.length - (edit.end - edit.start);
          } else if (edit.start < origE) {
            overlappingEdits.push(edit);
          }
        }
        if (overlappingEdits.length > 0) {
          const isPendingKind = fill.sealKind === 'pending';
          const canSupersede =
            !src.media &&
            overlappingEdits.every(
              (edit) =>
                edit.opStart !== undefined &&
                edit.opEnd !== undefined &&
                edit.opStart <= origS &&
                origE <= edit.opEnd &&
                (isPendingKind ? edit.coveredByFact === true : edit.coveredByVerifiedFact === true),
            );
          if (canSupersede) {
            supersededSources.add(src);
            removedSuperseded = true;
          }
          src.rangeSpan = { start: -1, end: -1 };
        } else {
          src.rangeSpan = { start: origS + deltaBefore, end: origE + deltaBefore };
        }
      }
    }
    const deduped: FactSource[] = [];
    const seen = new Set<string>();
    for (const src of fill.sources) {
      if (supersededSources.has(src)) continue;
      const key = JSON.stringify(src);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(src);
    }
    fill.sources = deduped;
    if (removedSuperseded) {
      fill.verified = fill.sources.length > 0 && fill.sources.every((src) => src.verified);
      fill.reference = fill.sources.map((src) => src.reference).join(' + ');
    }
  }
  if (pendingFacts.size) {
    const originals = visibleRunProperties(outputXml).map(highlight);
    for (const scope of sealRanges(outputXml)) {
      const reasons = pendingFacts.get(scope.name);
      if (!reasons) continue;
      const id = scope.name.slice('_Seal_F_'.length);
      added.push({ id, draft: name, category: reasons[0].category, note: reasons[0].note, reasons, status: 'open', originalHighlights: originals.slice(scope.start, scope.end) });
    }
  }
  if (marking.length || pendingFacts.size) { output = await editTextDocument(output, marking, input.host, new Set(pendingFacts.keys())); outputXml = await documentXml(output); }
  const after = sealRanges(outputXml);
  for (const fillId of rangeEditsByFillId.keys()) {
    const fill = ledger.fills.find((item) => item.id === fillId && item.draft === name && item.status !== 'removed');
    if (!fill?.sources?.length) continue;
    const postKind = fill.sealKind ?? 'fact';
    const postMarker = postKind === 'pending' ? `_Seal_P_${fillId}` : `_Seal_F_${fillId}`;
    const postRange = after.find((range) => range.name === postMarker);
    if (!postRange) continue;
    const spanMatchesPost = (src: FactSource): boolean =>
      !src.media &&
      !!src.rangeSpan &&
      src.rangeSpan.start >= 0 &&
      src.rangeSpan.end >= src.rangeSpan.start &&
      postRange.text.slice(src.rangeSpan.start, src.rangeSpan.end).replace(/\r\n/g, '\n') ===
        displayedFactValue(src).replace(/\r\n/g, '\n');
    if (batchCreatedAggregateFills.has(fillId)) {
      if (postKind === 'pending' && fill.sources.every(spanMatchesPost)) {
        fill.resolvedValue = postRange.text;
      }
      continue;
    }
    const initial = initialFillState.get(fillId);
    const rebindMeta =
      fillTouchCount.get(fillId) === 1 ? fullRangeRebindFills.get(fillId) : undefined;
    const isFullRangeRebind =
      !!rebindMeta &&
      (postKind === 'pending' || rebindMeta.verifiedFullCover) &&
      !(initial?.sources.some((src) => src.media) ?? false);
    if (isFullRangeRebind) {
      const allowedByGate =
        postKind === 'pending' || (postKind === 'fact' && !nonVerifiedFactTouchedFills.has(fillId));
      if (allowedByGate && fill.sources.every(spanMatchesPost)) {
        fill.resolvedValue = postRange.text;
      }
      continue;
    }
    if (!initial || !initial.sources.length) continue;
    const preMarker = initial.sealKind === 'pending' ? `_Seal_P_${fillId}` : `_Seal_F_${fillId}`;
    const preRange = ranges.find((range) => range.name === preMarker);
    if (!preRange || preRange.text !== fill.resolvedValue) continue;
    const remainingInitial = initial.sources.filter((src) => !supersededSources.has(src));
    if (!remainingInitial.every(spanMatchesPost)) continue;
    if (!fill.sources.every(spanMatchesPost)) continue;
    const allowedByGate =
      postKind === 'pending' || (postKind === 'fact' && !nonVerifiedFactTouchedFills.has(fillId));
    if (allowedByGate) {
      fill.resolvedValue = postRange.text;
    }
  }
  const beforeNames = new Set(ranges.map(range => range.name));
  const afterNames = new Set(after.map(range => range.name));
  for (const [marker, item] of initialPending) {
    if (beforeNames.has(marker) && !afterNames.has(marker)) { item.status = 'removed'; delete item.confirmation; updated.add(item); }
  }
  for (const fill of ledger.fills) {
    if (fill.draft !== name || fill.status === 'removed') continue;
    const marker = fill.sealKind === 'pending' ? `_Seal_P_${fill.id}` : `_Seal_F_${fill.id}`;
    if (beforeNames.has(marker) && !afterNames.has(marker)) {
      fill.status = 'removed';
    }
  }
  ledger.pending.push(...added);
  ledger.drafts[name] = sha256Hex(output);
  Object.assign(input.ledger, ledger);
  return { output, ledger: input.ledger, pending: [...updated, ...added], operations: input.operations.length, results };
}

export async function persistEditedDraft(host: HostPort, draftPath: string, ledgerPath: string, anchorPath: string, draft: Uint8Array, ledger: BidLedger): Promise<void> {
  if (!host.writeFiles) throw new Error('宿主不支持原子文件批次');
  if (!ledger.integrity) throw new Error('台账尚未封印');
  await host.writeFiles([{ path: draftPath, data: draft }, { path: ledgerPath, data: new TextEncoder().encode(JSON.stringify(ledger, null, 2)) }, { path: anchorPath, data: new TextEncoder().encode(JSON.stringify(ledger.integrity)) }]);
}
