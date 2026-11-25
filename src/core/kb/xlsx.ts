import { xmlAttributes } from '../docx/outline.js';
import { resolveRelationshipTarget } from '../docx/package-structure.js';
import { elementChildren, unescapeXml, xmlElements, type XmlElement } from '../docx/xml.js';
import { readZip } from '../docx/zip.js';

export const MAX_OOXML_COLUMNS = 16_384;
export const MAX_OOXML_ROWS = 1_048_576;
export const MAX_SPREADSHEET_CELLS = 500_000;

export interface ParsedSpreadsheetRow {
  rowNumber: number;
  cells: string[];
}

export interface ParsedSpreadsheetSheet {
  name: string;
  rows: ParsedSpreadsheetRow[];
}

interface CellFormatStyle {
  numFmtId: number;
  formatCode: string;
}

interface CellBudget {
  remaining: number;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const BUILTIN_NUM_FMTS = new Map<number, string>([
  [0, 'General'],
  [1, '0'],
  [2, '0.00'],
  [3, '#,##0'],
  [4, '#,##0.00'],
  [9, '0%'],
  [10, '0.00%'],
  [11, '0.00E+00'],
  [12, '# ?/?'],
  [13, '# ??/??'],
  [14, 'mm-dd-yy'],
  [15, 'd-mmm-yy'],
  [16, 'd-mmm'],
  [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'],
  [19, 'h:mm:ss AM/PM'],
  [20, 'h:mm'],
  [21, 'h:mm:ss'],
  [22, 'm/d/yy h:mm'],
  [27, 'yyyy"年"m"月"'],
  [28, 'm"月"d"日"'],
  [29, 'm"月"d"日"'],
  [30, 'm/d/yy'],
  [31, 'yyyy"年"m"月"d"日"'],
  [32, 'h"时"mm"分"'],
  [33, 'h"时"mm"分"ss"秒"'],
  [34, 'yyyy"年"m"月"'],
  [35, 'm"月"d"日"'],
  [36, 'yyyy"年"m"月"'],
  [37, '#,##0 ;(#,##0)'],
  [38, '#,##0 ;[Red](#,##0)'],
  [39, '#,##0.00;(#,##0.00)'],
  [40, '#,##0.00;[Red](#,##0.00)'],
  [45, 'mm:ss'],
  [46, '[h]:mm:ss'],
  [47, 'mmss.0'],
  [48, '##0.0E+0'],
  [49, '@'],
  [50, 'yyyy"年"m"月"'],
  [51, 'm"月"d"日"'],
  [52, 'yyyy"年"m"月"'],
  [53, 'm"月"d"日"'],
  [54, 'm"月"d"日"'],
  [55, 'yyyy"年"m"月"'],
  [56, 'm"月"d"日"'],
  [57, 'yyyy"年"m"月"d"日"'],
  [58, 'm"月"d"日"'],
]);

const CALENDAR_DATE_BUILTIN_IDS = new Set([
  14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
const TIME_OF_DAY_BUILTIN_IDS = new Set([18, 19, 20, 21, 32, 33]);
const ELAPSED_BUILTIN_IDS = new Set([45, 46, 47]);

const DAY_MS = 86_400_000;
const EPOCH_1900_MS = Date.UTC(1899, 11, 31);
const EPOCH_1904_MS = Date.UTC(1904, 0, 1);
const MAX_EXCEL_SERIAL = 2_958_465;

function localName(qname: string): string {
  const colon = qname.lastIndexOf(':');
  return colon < 0 ? qname : qname.slice(colon + 1);
}

function collectTextNodes(
  xml: string,
  elements: readonly XmlElement[],
  children: readonly number[][],
  nodeIndex: number,
  parts: string[],
): void {
  const name = localName(elements[nodeIndex].name);
  if (name === 'rPh') return;
  if (name === 't') {
    parts.push(unescapeXml(xml.slice(elements[nodeIndex].openEnd, elements[nodeIndex].closeStart)));
    return;
  }
  for (const childIndex of children[nodeIndex]) {
    collectTextNodes(xml, elements, children, childIndex, parts);
  }
}

function parseSharedStrings(xml: string): string[] {
  const elements = xmlElements(xml);
  const children = elementChildren(elements);
  const strings: string[] = [];
  for (let index = 0; index < elements.length; index++) {
    if (localName(elements[index].name) !== 'si') continue;
    const parts: string[] = [];
    collectTextNodes(xml, elements, children, index, parts);
    strings.push(parts.join(''));
  }
  return strings;
}

function parseStyles(xml: string): CellFormatStyle[] {
  const elements = xmlElements(xml);
  const children = elementChildren(elements);
  const customFormats = new Map<number, string>();
  const cellXfs: CellFormatStyle[] = [];

  for (let i = 0; i < elements.length; i++) {
    const tag = localName(elements[i].name);
    if (tag === 'numFmts') {
      for (const childIdx of children[i]) {
        if (localName(elements[childIdx].name) !== 'numFmt') continue;
        const attrs = xmlAttributes(xml, elements[childIdx]);
        const idRaw = attrs.get('numFmtId');
        const formatCode = attrs.get('formatCode');
        if (idRaw !== undefined && formatCode !== undefined && /^\d+$/.test(idRaw.trim())) {
          customFormats.set(Number.parseInt(idRaw.trim(), 10), formatCode);
        }
      }
    } else if (tag === 'cellXfs') {
      for (const childIdx of children[i]) {
        if (localName(elements[childIdx].name) !== 'xf') continue;
        const attrs = xmlAttributes(xml, elements[childIdx]);
        const idRaw = attrs.get('numFmtId');
        const numFmtId = idRaw !== undefined && /^\d+$/.test(idRaw.trim()) ? Number.parseInt(idRaw.trim(), 10) : 0;
        const formatCode = customFormats.get(numFmtId) ?? BUILTIN_NUM_FMTS.get(numFmtId) ?? '';
        cellXfs.push({ numFmtId, formatCode });
      }
    }
  }
  return cellXfs;
}

type TemporalKind = 'none' | 'date' | 'time' | 'elapsed_hms' | 'unsupported';

function inspectSingleSectionFormat(formatCode: string): {
  multiSection: boolean;
  hasCondition: boolean;
  hasElapsedBracket: boolean;
  stripped: string;
} {
  let out = '';
  let multiSection = false;
  let hasCondition = false;
  let hasElapsedBracket = false;
  for (let i = 0; i < formatCode.length; i++) {
    const ch = formatCode[i];
    if (ch === '"') {
      i++;
      while (i < formatCode.length && formatCode[i] !== '"') i++;
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      i++;
    } else if (ch === ';') {
      multiSection = true;
      break;
    } else if (ch === '[') {
      const close = formatCode.indexOf(']', i + 1);
      if (close < 0) {
        hasCondition = true;
        break;
      }
      const inner = formatCode.slice(i + 1, close).trim();
      if (/^[<>=]/.test(inner)) {
        hasCondition = true;
      } else if (/^(?:h+|m+|s+)$/i.test(inner)) {
        hasElapsedBracket = true;
        out += `[${inner.toLowerCase()}]`;
      }
      i = close;
    } else {
      out += ch;
    }
  }
  return { multiSection, hasCondition, hasElapsedBracket, stripped: out };
}

function classifyTemporalFormat(numFmtId: number, formatCode: string): TemporalKind {
  if (!formatCode) {
    if (CALENDAR_DATE_BUILTIN_IDS.has(numFmtId)) return 'date';
    if (TIME_OF_DAY_BUILTIN_IDS.has(numFmtId)) return 'time';
    if (numFmtId === 46) return 'elapsed_hms';
    if (ELAPSED_BUILTIN_IDS.has(numFmtId)) return 'unsupported';
    return 'none';
  }
  const inspected = inspectSingleSectionFormat(formatCode);
  if (inspected.multiSection || inspected.hasCondition) return 'unsupported';
  const cleaned = inspected.stripped.replace(/\bAM\/PM\b|\bA\/P\b/gi, '').trim();
  if (inspected.hasElapsedBracket || ELAPSED_BUILTIN_IDS.has(numFmtId)) {
    if (/^\[h+\]:mm:ss(?:\.0{1,3})?$/i.test(cleaned)) return 'elapsed_hms';
    return 'unsupported';
  }
  if (/s+\.0{4,}/i.test(cleaned)) return 'unsupported';
  if (CALENDAR_DATE_BUILTIN_IDS.has(numFmtId)) return 'date';
  if (TIME_OF_DAY_BUILTIN_IDS.has(numFmtId)) return 'time';
  const hasDateToken = /[yd]/i.test(cleaned);
  const hasTimeToken = /[hs]/i.test(cleaned);
  if (hasDateToken) return 'date';
  if (hasTimeToken) return 'time';
  if (/m/i.test(cleaned)) return 'unsupported';
  return 'none';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function formatTimeMs(totalMs: number): string {
  const totalSeconds = Math.floor(totalMs / 1000);
  const ms = totalMs % 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const base = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return ms > 0 ? `${base}.${pad3(ms)}` : base;
}

function formatExcelDate(rawText: string, num: number, date1904: boolean, formatLabel: string): string {
  if (num < 0 || num > MAX_EXCEL_SERIAL) {
    return `${rawText}（格式：${formatLabel}）`;
  }
  if (!date1904 && num < 1) {
    return `${rawText}（格式：${formatLabel}）`;
  }

  const serial = Math.floor(num);
  const frac = num - serial;
  const timeMs = Math.round(frac * 86_400_000);
  if ((frac > 0 && timeMs === 0) || timeMs >= 86_400_000) {
    return `${rawText}（格式：${formatLabel}）`;
  }
  if (!date1904 && serial === 60) {
    return `${rawText}（格式：${formatLabel}，1900-02-29 无效日期无法可靠换算）`;
  }

  let ms: number;
  if (date1904) {
    ms = EPOCH_1904_MS + serial * DAY_MS;
  } else {
    const daysFromEpoch = serial >= 60 ? serial - 1 : serial;
    ms = EPOCH_1900_MS + daysFromEpoch * DAY_MS;
  }
  const date = new Date(ms);
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  return timeMs > 0 ? `${y}-${m}-${d} ${formatTimeMs(timeMs)}` : `${y}-${m}-${d}`;
}

function formatTimeOfDay(rawText: string, num: number, formatLabel: string): string {
  if (num < 0 || num >= 1) {
    return `${rawText}（格式：${formatLabel}）`;
  }
  const totalMs = Math.round(num * 86_400_000);
  if ((num > 0 && totalMs === 0) || totalMs >= 86_400_000) {
    return `${rawText}（格式：${formatLabel}）`;
  }
  return formatTimeMs(totalMs);
}

function formatElapsedHms(rawText: string, num: number, formatLabel: string): string {
  if (num < 0 || num > MAX_EXCEL_SERIAL) {
    return `${rawText}（格式：${formatLabel}）`;
  }
  const totalMs = Math.round(num * 86_400_000);
  if (num > 0 && totalMs === 0) {
    return `${rawText}（格式：${formatLabel}）`;
  }
  return formatTimeMs(totalMs);
}

function formatPercentString(rawText: string, formatLabel: string): string {
  const trimmed = rawText.trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(trimmed);
  if (!match) {
    return `${rawText}（格式：${formatLabel}）`;
  }
  const sign = match[1] === '-' ? '-' : '';
  const intPart = match[2] ?? '';
  const fracPart = match[3] ?? match[4] ?? '';
  const expRaw = match[5];
  const exp = expRaw !== undefined ? Number.parseInt(expRaw, 10) : 0;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 100) {
    return `${rawText}（格式：${formatLabel}）`;
  }
  const digits = intPart + fracPart;
  if (!/[1-9]/.test(digits)) {
    return '0%';
  }
  const pointPos = intPart.length + exp + 2;
  let whole: string;
  let frac: string;
  if (pointPos <= 0) {
    whole = '0';
    frac = `${'0'.repeat(-pointPos)}${digits}`.replace(/0+$/, '');
  } else if (pointPos >= digits.length) {
    whole = `${digits}${'0'.repeat(pointPos - digits.length)}`.replace(/^0+(?=\d)/, '') || '0';
    frac = '';
  } else {
    whole = digits.slice(0, pointPos).replace(/^0+(?=\d)/, '') || '0';
    frac = digits.slice(pointPos).replace(/0+$/, '');
  }
  return `${sign}${whole}${frac ? `.${frac}` : ''}%`;
}

function formatNumericValue(
  rawText: string,
  styleIndexRaw: string | undefined,
  cellXfs: readonly CellFormatStyle[],
  date1904: boolean,
): string {
  const trimmed = rawText.trim();
  if (!trimmed || styleIndexRaw === undefined) return rawText;
  if (!/^\d+$/.test(styleIndexRaw.trim())) return rawText;
  const styleIdx = Number.parseInt(styleIndexRaw.trim(), 10);
  if (styleIdx < 0 || styleIdx >= cellXfs.length) return rawText;

  const { numFmtId, formatCode } = cellXfs[styleIdx];
  if (numFmtId === 0 && (!formatCode || formatCode.toLowerCase() === 'general')) {
    return rawText;
  }

  const num = Number(trimmed);
  if (!Number.isFinite(num)) return rawText;

  const formatLabel = formatCode || `numFmtId=${numFmtId}`;
  const temporalKind = classifyTemporalFormat(numFmtId, formatCode);
  if (temporalKind === 'date') {
    return formatExcelDate(rawText, num, date1904, formatLabel);
  }
  if (temporalKind === 'time') {
    return formatTimeOfDay(rawText, num, formatLabel);
  }
  if (temporalKind === 'elapsed_hms') {
    return formatElapsedHms(rawText, num, formatLabel);
  }
  if (temporalKind === 'unsupported') {
    return `${rawText}（格式：${formatLabel}）`;
  }

  const codeTrimmed = formatCode.trim();
  if (/^0{2,}$/.test(codeTrimmed)) {
    if (/^\d+$/.test(trimmed)) {
      return trimmed.padStart(codeTrimmed.length, '0');
    }
    return `${rawText}（格式：${formatLabel}）`;
  }

  if (
    codeTrimmed === '@' ||
    codeTrimmed.toLowerCase() === 'general' ||
    /^(?:0+|#(?:,#+)*0*)(?:\.0+)?$/.test(codeTrimmed) ||
    (!formatCode && numFmtId >= 1 && numFmtId <= 4)
  ) {
    return rawText;
  }

  if (
    numFmtId === 9 ||
    numFmtId === 10 ||
    /^(?:0+|#(?:,#+)*0*)(?:\.0+)?%$/.test(codeTrimmed)
  ) {
    return formatPercentString(rawText, formatLabel);
  }

  return `${rawText}（格式：${formatLabel}）`;
}

function columnLettersToIndex(letters: string): number {
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) & 0xdf) - 64;
  }
  return col - 1;
}

function parseCellReference(reference: string): { col: number; row: number } {
  const trimmed = reference.trim();
  const match = /^([A-Za-z]+)([0-9]+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`XLSX 包含非法单元格坐标：${reference}`);
  }
  const letters = match[1];
  if (letters.length < 1 || letters.length > 3) {
    throw new Error(`XLSX 单元格列坐标超出 OOXML 合法范围 (A..XFD)：${reference}`);
  }
  const colIndex = columnLettersToIndex(letters);
  if (colIndex < 0 || colIndex >= MAX_OOXML_COLUMNS) {
    throw new Error(`XLSX 单元格列坐标超出 OOXML 合法范围 (A..XFD)：${reference}`);
  }
  const rowNum = Number(match[2]);
  if (!Number.isInteger(rowNum) || rowNum < 1 || rowNum > MAX_OOXML_ROWS) {
    throw new Error(`XLSX 单元格行坐标超出 OOXML 合法范围 (1..1048576)：${reference}`);
  }
  return { col: colIndex, row: rowNum };
}

function parseRowNumberAttr(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[1-9]\d{0,6}$/.test(trimmed)) {
    throw new Error(`XLSX 工作表包含非法行号：${raw}`);
  }
  const num = Number(trimmed);
  if (!Number.isInteger(num) || num < 1 || num > MAX_OOXML_ROWS) {
    throw new Error(`XLSX 工作表行号超出 OOXML 合法范围 (1..1048576)：${raw}`);
  }
  return num;
}

function parseWorksheetRows(
  sheetXml: string,
  sharedStrings: readonly string[],
  cellXfs: readonly CellFormatStyle[],
  date1904: boolean,
  workbookBudget: CellBudget,
): ParsedSpreadsheetRow[] {
  const elements = xmlElements(sheetXml);
  const children = elementChildren(elements);
  const sheetDataIndex = elements.findIndex((el) => localName(el.name) === 'sheetData');
  if (sheetDataIndex < 0) return [];

  const rows: ParsedSpreadsheetRow[] = [];
  let lastRowNumber = 0;
  let sheetAllocatedCells = 0;
  let sheetMaxCols = 0;

  for (const rowIndex of children[sheetDataIndex]) {
    if (localName(elements[rowIndex].name) !== 'row') continue;
    const rowAttrs = xmlAttributes(sheetXml, elements[rowIndex]);
    const rowRef = rowAttrs.get('r');
    let resolvedRowNumber: number | undefined = rowRef !== undefined ? parseRowNumberAttr(rowRef) : undefined;

    const rowValues: string[] = [];
    let nextColumn = 0;

    for (const cellIndex of children[rowIndex]) {
      const cellEl = elements[cellIndex];
      if (localName(cellEl.name) !== 'c') continue;
      const attrs = xmlAttributes(sheetXml, cellEl);
      const refAttr = attrs.get('r');
      let colIndex: number;
      if (refAttr !== undefined) {
        const parsedRef = parseCellReference(refAttr);
        if (resolvedRowNumber !== undefined && resolvedRowNumber !== parsedRef.row) {
          throw new Error(`XLSX 工作表行号与单元格坐标不一致：row=${resolvedRowNumber}, ref=${refAttr}`);
        }
        resolvedRowNumber = parsedRef.row;
        colIndex = parsedRef.col;
      } else {
        colIndex = nextColumn;
      }
      if (colIndex < 0 || colIndex >= MAX_OOXML_COLUMNS) {
        throw new Error(`XLSX 单元格列坐标超出 OOXML 合法范围 (A..XFD)：col=${colIndex + 1}`);
      }
      nextColumn = colIndex + 1;

      const cellType = attrs.get('t');
      const styleAttr = attrs.get('s');
      let value = '';
      if (cellType === 'inlineStr') {
        const isIndex = children[cellIndex].find((child) => localName(elements[child].name) === 'is');
        if (isIndex !== undefined) {
          const parts: string[] = [];
          collectTextNodes(sheetXml, elements, children, isIndex, parts);
          value = parts.join('');
        }
      } else {
        const fIndex = children[cellIndex].find((child) => localName(elements[child].name) === 'f');
        const vIndex = children[cellIndex].find((child) => localName(elements[child].name) === 'v');
        const vText =
          vIndex !== undefined
            ? unescapeXml(sheetXml.slice(elements[vIndex].openEnd, elements[vIndex].closeStart))
            : '';
        if (fIndex !== undefined && vText.trim() === '') {
          const formulaText = unescapeXml(
            sheetXml.slice(elements[fIndex].openEnd, elements[fIndex].closeStart),
          ).trim();
          value = formulaText ? `=${formulaText}（公式结果未缓存）` : '（公式结果未缓存）';
        } else if (cellType === 's') {
          const idx = Number.parseInt(vText, 10);
          value = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : '';
        } else if (cellType === 'b') {
          const trimmed = vText.trim();
          value = trimmed === '1' ? 'TRUE' : trimmed === '0' ? 'FALSE' : vText;
        } else if (!cellType || cellType === 'n') {
          value = formatNumericValue(vText, styleAttr, cellXfs, date1904);
        } else {
          value = vText;
        }
      }

      if (value !== '') {
        const requiredCols = colIndex + 1;
        const addedCells = Math.max(0, requiredCols - rowValues.length);
        if (
          sheetAllocatedCells + addedCells > MAX_SPREADSHEET_CELLS ||
          addedCells > workbookBudget.remaining
        ) {
          throw new Error('工作表尺寸或单元格数超出安全上限');
        }
        const projectedMaxCols = Math.max(sheetMaxCols, requiredCols);
        const projectedGrid = (rows.length + 1) * projectedMaxCols;
        if (projectedGrid > MAX_SPREADSHEET_CELLS) {
          throw new Error('工作表尺寸或单元格数超出安全上限');
        }
        while (rowValues.length < requiredCols) rowValues.push('');
        sheetAllocatedCells += addedCells;
        workbookBudget.remaining -= addedCells;
        sheetMaxCols = projectedMaxCols;
        rowValues[colIndex] = value;
      }
    }

    const rowNumber = resolvedRowNumber ?? lastRowNumber + 1;
    if (rowNumber > MAX_OOXML_ROWS) {
      throw new Error(`XLSX 工作表行号超出 OOXML 合法范围 (1..1048576)：${rowNumber}`);
    }
    if (rowNumber <= lastRowNumber) {
      throw new Error(`XLSX 工作表行号非严格递增：前一行=${lastRowNumber}, 当前行=${rowNumber}`);
    }
    lastRowNumber = rowNumber;

    if (rowValues.some((cell) => cell !== '')) {
      rows.push({ rowNumber, cells: rowValues });
    }
  }
  return rows;
}

/** Parse sheets from an XLSX OOXML ZIP archive without Node dependencies. */
export async function parseXlsxSheets(bytes: Uint8Array): Promise<ParsedSpreadsheetSheet[]> {
  const entries = await readZip(bytes);
  const workbookBytes = entries.get('xl/workbook.xml');
  if (!workbookBytes) {
    throw new Error('无效的 XLSX 文件：缺少 xl/workbook.xml');
  }
  const workbookXml = utf8Decoder.decode(workbookBytes);

  let date1904 = false;
  const workbookElements = xmlElements(workbookXml);
  for (const element of workbookElements) {
    if (localName(element.name) === 'workbookPr') {
      const attrs = xmlAttributes(workbookXml, element);
      const val = attrs.get('date1904')?.trim().toLowerCase();
      if (val === '1' || val === 'true') {
        date1904 = true;
      }
    }
  }

  const relTargets = new Map<string, { target: string; type: string }>();
  let sharedStringsPath = 'xl/sharedStrings.xml';
  let stylesPath = 'xl/styles.xml';
  const relsBytes = entries.get('xl/_rels/workbook.xml.rels');
  if (relsBytes) {
    const relsXml = utf8Decoder.decode(relsBytes);
    for (const element of xmlElements(relsXml)) {
      if (localName(element.name) !== 'Relationship') continue;
      const attrs = xmlAttributes(relsXml, element);
      const id = attrs.get('Id');
      const target = attrs.get('Target');
      const type = attrs.get('Type') ?? '';
      if (id && target && attrs.get('TargetMode') !== 'External') {
        const resolved = resolveRelationshipTarget('xl/', target);
        relTargets.set(id, { target: resolved, type });
        if (type.endsWith('/sharedStrings')) sharedStringsPath = resolved;
        if (type.endsWith('/styles')) stylesPath = resolved;
      }
    }
  }

  const sharedBytes = entries.get(sharedStringsPath) ?? entries.get('xl/sharedStrings.xml');
  const sharedStrings = sharedBytes ? parseSharedStrings(utf8Decoder.decode(sharedBytes)) : [];

  const stylesBytes = entries.get(stylesPath) ?? entries.get('xl/styles.xml');
  const cellXfs = stylesBytes ? parseStyles(utf8Decoder.decode(stylesBytes)) : [];

  const sheets: ParsedSpreadsheetSheet[] = [];
  const workbookBudget: CellBudget = { remaining: MAX_SPREADSHEET_CELLS };
  let fallbackIndex = 0;
  for (const element of workbookElements) {
    if (localName(element.name) !== 'sheet') continue;
    fallbackIndex++;
    const attrs = xmlAttributes(workbookXml, element);
    const name = attrs.get('name') ?? `Sheet${fallbackIndex}`;
    const relId = attrs.get('r:id');
    const rel = relId ? relTargets.get(relId) : undefined;
    if (rel && rel.type && !rel.type.endsWith('/worksheet')) {
      continue;
    }
    const targetPath = rel?.target ?? `xl/worksheets/sheet${fallbackIndex}.xml`;
    const sheetBytes = entries.get(targetPath);
    if (!sheetBytes) {
      throw new Error(`XLSX 缺少工作表部件：${targetPath}`);
    }
    const rows = parseWorksheetRows(
      utf8Decoder.decode(sheetBytes),
      sharedStrings,
      cellXfs,
      date1904,
      workbookBudget,
    );
    sheets.push({ name, rows });
  }
  return sheets;
}

/** Parse RFC-4180 delimited text (CSV or TSV) into rows carrying 1-based physical start line numbers. */
export function parseDelimitedRecords(text: string, delimiter: ',' | '\t'): ParsedSpreadsheetRow[] {
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (!input.length) return [];

  const rows: ParsedSpreadsheetRow[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let lineNumber = 1;
  let recordStartLine = 1;
  let quoteStartLine = 1;
  let totalCells = 0;

  const pushField = (value: string) => {
    totalCells += 1;
    if (totalCells > MAX_SPREADSHEET_CELLS) {
      throw new Error('工作表尺寸或单元格数超出安全上限');
    }
    row.push(value);
  };

  const pushRow = () => {
    rows.push({ rowNumber: recordStartLine, cells: row });
    row = [];
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\r') {
        if (input[i + 1] === '\n') {
          field += '\r\n';
          i++;
        } else {
          field += '\r';
        }
        lineNumber++;
      } else if (ch === '\n') {
        field += '\n';
        lineNumber++;
      } else {
        field += ch;
      }
      continue;
    }

    if (!fieldStarted && ch === '"') {
      inQuotes = true;
      fieldStarted = true;
      quoteStartLine = lineNumber;
    } else if (ch === delimiter) {
      pushField(field);
      field = '';
      fieldStarted = false;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      pushField(field);
      pushRow();
      field = '';
      fieldStarted = false;
      lineNumber++;
      recordStartLine = lineNumber;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }

  if (inQuotes) {
    throw new Error(`CSV/TSV 第 ${quoteStartLine} 行引号未闭合，无法安全入库`);
  }

  if (fieldStarted || row.length > 0) {
    pushField(field);
    pushRow();
  }
  return rows;
}

/** Parse RFC-4180 delimited text (CSV or TSV) into a 2D cell array. */
export function parseDelimitedRows(text: string, delimiter: ',' | '\t'): string[][] {
  return parseDelimitedRecords(text, delimiter).map((record) => record.cells);
}

function escapeMarkdownCell(cell: string): string {
  return cell.replace(/\r\n?|\n/g, '<br>').replace(/\|/g, '\\|').trim();
}

/** Format a 2D table of strings or spreadsheet rows as a standard GitHub-flavored Markdown table. */
export function rowsToMarkdownTable(rows: readonly (readonly string[] | ParsedSpreadsheetRow)[]): string {
  if (!rows.length) return '';
  const cellRows = rows.map((row) => (Array.isArray(row) ? row : (row as ParsedSpreadsheetRow).cells));
  const columns = Math.max(1, ...cellRows.map((row) => row.length));
  if (cellRows.length * columns > MAX_SPREADSHEET_CELLS) {
    throw new Error('工作表尺寸或单元格数超出安全上限');
  }
  const normalize = (row: readonly string[]) => {
    const escaped = row.map(escapeMarkdownCell);
    while (escaped.length < columns) escaped.push('');
    return `| ${escaped.join(' | ')} |`;
  };
  return [
    normalize(cellRows[0]),
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
    ...cellRows.slice(1).map(normalize),
  ].join('\n');
}
