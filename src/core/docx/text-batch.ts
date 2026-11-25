import { isCellEdgeBlock, resolveAddress, type AddressKind } from './addresses.js';
import { editableText, firstVisibleRunProperties, replaceVisibleRange, visibleOffsetBefore, visibleTextPositions, wrapVisibleRange, type VisibleTextToken } from './visible-surgery.js';
import { buildRowCopies, fillEmptyCellParagraph, type RowIdentities } from './row-copies.js';
import { isEmptyViewCell, viewBlankHints } from './document-view.js';
import { markdownBlocks } from './markdown.js';
import { assertXmlCharacters, elementChildren, escapeXml, extractFirstParagraphPr, extractFirstRunPr, injectHighlightYellow, isMergedContinuation, parseDocumentBody, parseRowCells, parseTableRows, sanitizeInsertedBodyParagraphPr, setRunHighlight, xmlElements, type TopLevelBlock } from './xml.js';
import { rangeRelation, sealRanges } from './seal-ranges.js';
import { captionedCellImage, imageParagraph, terminateCellBlocks } from './image-insert.js';
import { layoutBox } from './layout.js';
import { applyInsertToc, findAdjacentTocField, validateInsertTocEdit, type InsertTocEdit, type TocHeading } from './toc.js';

export interface TextLocator { at: string; find?: string; blank?: number; }
export interface TextTarget { find: string; start: number; end: number; }

export function resolveCheckTarget(documentXml: string, at: string, option: string): TextTarget {
  if (!option) throw new Error('复选项名称不能为空');
  const text = editableText(resolveAddress(documentXml, at).xml), positions: number[] = [];
  for (let index = text.indexOf(option); index >= 0; index = text.indexOf(option, index + 1)) {
    let symbol = index - 1;
    while (symbol >= 0 && /\s/.test(text[symbol])) symbol--;
    if (symbol >= 0 && '□☐☑■√'.includes(text[symbol])) positions.push(symbol);
  }
  if (positions.length !== 1) throw new Error(`复选项不存在或不唯一：${option}`);
  const start = positions[0];
  return { find: text[start], start, end: start + 1 };
}

export function cellStyleSource(documentXml: string, at: string): string | undefined {
  const rowAddress = at.replace(/\/c:\d+$/, ''), row = resolveAddress(documentXml, rowAddress);
  const cells = parseRowCells(row.xml), cellIndex = Number(/\/c:(\d+)$/.exec(at)?.[1]);
  const sourceInRow = cells.map((cell, index) => ({ cell, index }))
    .filter(candidate => candidate.index !== cellIndex && editableText(candidate.cell.xml).length > 0)
    .sort((a, b) => Math.abs(a.index - cellIndex) - Math.abs(b.index - cellIndex))[0];
  if (sourceInRow) return `${rowAddress}/c:${sourceInRow.index}`;
  const tableAddress = rowAddress.replace(/\/r:\d+$/, ''), rowIndex = Number(/\/r:(\d+)$/.exec(rowAddress)?.[1]);
  const sourceInColumn = parseTableRows(resolveAddress(documentXml, tableAddress).xml)
    .map(candidate => ({ row: candidate.rowIndex, cell: candidate.cells[cellIndex] }))
    .filter(candidate => candidate.row !== rowIndex && candidate.cell && editableText(candidate.cell.xml))
    .sort((a, b) => Math.abs(a.row - rowIndex) - Math.abs(b.row - rowIndex))[0];
  return sourceInColumn ? `${tableAddress}/r:${sourceInColumn.row}/c:${cellIndex}` : undefined;
}

/** Resolve against the same current hint numbering as the public view. Offsets refer to editable source text. */
export function resolveTextTarget(documentXml: string, locator: TextLocator): TextTarget {
  const element = resolveAddress(documentXml, locator.at);
  if (!['paragraph', 'cell'].includes(element.kind)) throw new Error('文字定位需要段落或单元格地址；建议读取 blocks 并使用可编辑地址');
  const text = editableText(element.xml);
  const emptyCell = isEmptyViewCell({ ...element, kind: element.kind, address: locator.at, continuation: isMergedContinuation(element.xml), children: [] });
  const hints = element.kind === 'paragraph' ? viewBlankHints(locator.at, text, element.xml) : emptyCell ? viewBlankHints(locator.at, '', '', true) : [];
  const suggestion = `建议重新读取 ${locator.at}，选择唯一 find 或提示 blank；当前候选：${hints.slice(0, 8).map((hint, index) => `${index}:${JSON.stringify(hint.text.slice(0, 40))}`).join('、') || '无提示，可指定唯一原文'}`;
  if ((locator.find !== undefined) === (locator.blank !== undefined)) throw new Error(`find 与 blank 必须二择一；${suggestion}`);
  if (locator.blank !== undefined) {
    if (!Number.isSafeInteger(locator.blank) || locator.blank < 0 || !hints[locator.blank]) throw new Error(`提示序号无效；${suggestion}`);
    const hint = hints[locator.blank];
    return { find: text.slice(hint.start, hint.end), start: hint.start, end: hint.end };
  }
  if (typeof locator.find !== 'string' || !locator.find) throw new Error(`原文片段不能为空；${suggestion}`);
  assertXmlCharacters(locator.find);
  const start = text.indexOf(locator.find);
  if (start < 0 || text.indexOf(locator.find, start + 1) >= 0) throw new Error(`原文片段${start < 0 ? '不存在' : '不唯一'}；${suggestion}`);
  return { find: locator.find, start, end: start + locator.find.length };
}

function operationError(index: number, error: unknown): Error {
  return new Error(`操作 ${index + 1}：${error instanceof Error ? error.message : String(error)}；建议核对该操作的地址、原文或 blank 序号后重新提交整批`);
}

function highlightRange(xml: string, start: number, end: number): string {
  const elements = xmlElements(xml), childrenByParent = elementChildren(elements);
  const runIndexByStart = new Map<number, number>();
  for (let index = 0; index < elements.length; index++) {
    if (elements[index].name === 'w:r') runIndexByStart.set(elements[index].start, index);
  }
  const affected = visibleTextPositions(xml).filter(token => token.start < end && token.end > start);
  const runGroups = new Map<number, VisibleTextToken[]>();
  for (const token of affected) {
    const group = runGroups.get(token.run.start) ?? [];
    group.push(token);
    runGroups.set(token.run.start, group);
  }
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const [runStart, tokens] of runGroups) {
    const runIndex = runIndexByStart.get(runStart) ?? -1;
    if (runIndex < 0) continue;
    const run = elements[runIndex], runOpen = xml.slice(run.start, run.openEnd), properties = extractFirstRunPr(xml.slice(run.start, run.end));
    const highlightedProperties = injectHighlightYellow(properties);
    const tokenByStart = new Map(tokens.map(token => [token.element.start, token]));
    const outputRuns: string[] = [];
    let pendingNodes: string[] = [], pendingYellow = false;
    const flush = () => {
      if (pendingNodes.length > 0) {
        outputRuns.push(`${runOpen}${pendingYellow ? highlightedProperties : properties}${pendingNodes.join('')}</w:r>`);
        pendingNodes = [];
      }
    };
    const pushNode = (nodeXml: string, yellow: boolean) => {
      if (pendingNodes.length > 0 && pendingYellow !== yellow) flush();
      pendingYellow = yellow;
      pendingNodes.push(nodeXml);
    };
    for (const childIndex of childrenByParent[runIndex]) {
      const child = elements[childIndex];
      if (child.name === 'w:rPr') continue;
      const token = tokenByStart.get(child.start);
      if (!token) {
        if (child.name !== 'w:t' || child.openEnd !== child.closeStart) pushNode(xml.slice(child.start, child.end), false);
        continue;
      }
      if (child.name !== 'w:t') {
        pushNode(xml.slice(child.start, child.end), true);
        continue;
      }
      const left = Math.max(0, start - token.start), right = Math.min(token.text.length, end - token.start);
      const before = token.text.slice(0, left), selected = token.text.slice(left, right), after = token.text.slice(right);
      if (before) pushNode(`<w:t xml:space="preserve">${escapeXml(before)}</w:t>`, false);
      if (selected) pushNode(`<w:t xml:space="preserve">${escapeXml(selected)}</w:t>`, true);
      if (after) pushNode(`<w:t xml:space="preserve">${escapeXml(after)}</w:t>`, false);
    }
    flush();
    replacements.push({ start: run.start, end: run.end, value: outputRuns.join('') });
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

export type TextBatchEdit = (
  | ({ op: 'replace'; value: string; yellow?: boolean; nativeHighlight?: string | null } & TextLocator)
  | { op: 'set_cell'; at: string; value: string; yellow?: boolean; nativeHighlight?: string | null }
  | { op: 'check'; at: string; option: string; checked: boolean; yellow?: boolean }
  | ({ op: 'mark_pending'; span?: { start: number; end: number } } & TextLocator)
  | { op: 'mark_fact'; at: string; span: { start: number; end: number }; seal: { name: string; id: number } }
  | { op: 'insert_rows'; at: string; mode: 'after' | 'replace'; rows: string[][]; yellow?: boolean; cellHighlights?: ReadonlyArray<string | null | undefined> }
  | { op: 'insert'; at: string; position: 'before' | 'after'; markdown: string; yellow?: boolean; compiledXml?: string; imageSeals?: Array<{ name: string; id: number } | undefined> }
  | { op: 'insert_prepared_image'; at: string; drawing: string; imageLabel?: string; captioned?: boolean; pending?: boolean; widthTwips: number; seal?: { name: string; id: number } }
  | { op: 'delete'; at: string }
  | InsertTocEdit) & { seal?: { name: string; id: number } };

export interface AppliedTocEffect {
  originalAt: string;
  mappedAnchorBeforeToc: string;
  position: 'before' | 'after';
  insertAtParagraphIndex: number;
  paragraphsBeforeReplaceRange: number;
  oldRangeParagraphCount: number;
  newRangeParagraphCount: number;
  removedParagraphs: number;
  insertedParagraphs: number;
  insertedAddresses: string[];
  entries: TocHeading[];
  anchorTitle?: string;
}

export interface TextBatchResult {
  xml: string;
  tocEffects: AppliedTocEffect[];
  nonTocInsertedAddresses: Map<number, string[]>;
}

interface Planned {
  kind: AddressKind;
  start: number;
  end: number;
  xml: string;
  edit: Exclude<TextBatchEdit, { op: 'check' | 'insert_toc' }>;
  index: number;
  textStart: number;
  textEnd: number;
}

/** A low-level XML operation; callers must validate the resulting complete package before saving. */
export function applyTextBatch(
  documentXml: string,
  edits: readonly TextBatchEdit[],
  options: { headingStyles?: ReadonlyMap<number, string>; copyReference?: RowIdentities['copyReference']; pendingFacts?: ReadonlySet<string>; stylesXml?: string; tocPlaceholderPage?: string } = {},
): string {
  return applyTextBatchWithMeta(documentXml, edits, options).xml;
}

/** Apply a batch and return both resulting XML and metadata for any insert_toc operations. */
export function applyTextBatchWithMeta(
  documentXml: string,
  edits: readonly TextBatchEdit[],
  options: { headingStyles?: ReadonlyMap<number, string>; copyReference?: RowIdentities['copyReference']; pendingFacts?: ReadonlySet<string>; stylesXml?: string; tocPlaceholderPage?: string } = {},
): TextBatchResult {
  const ranges = sealRanges(documentXml), removed = new Set<string>();
  const nonTocPlanned: Planned[] = [];
  const tocEdits: Array<{ index: number; edit: { op: 'insert_toc'; at: string; position: 'before' | 'after'; maxLevel: 1 | 2 | 3 } }> = [];
  const deletedAddresses = new Set<string>();

  for (const [index, requested] of edits.entries()) {
    try {
      if (requested.op === 'insert_toc') {
        const validated = validateInsertTocEdit(documentXml, requested);
        tocEdits.push({ index, edit: { op: 'insert_toc', ...validated } });
        continue;
      }
      const element = resolveAddress(documentXml, requested.at);
      let edit: Exclude<TextBatchEdit, { op: 'check' | 'insert_toc' }>;
      if (requested.op === 'delete') {
        if (!['paragraph', 'table', 'row'].includes(element.kind)) throw new Error(`不能删除该位置：${requested.at}`);
        deletedAddresses.add(requested.at);
        nonTocPlanned.push({ ...element, index, edit: requested, textStart: 0, textEnd: 0 });
        continue;
      }
      if (requested.op === 'insert_rows') {
        if (element.kind !== 'row' || !['after', 'replace'].includes(requested.mode)) throw new Error('插入行位置或模式无效');
        nonTocPlanned.push({ ...element, index, edit: requested, textStart: 0, textEnd: 0 });
        continue;
      }
      if (requested.op === 'insert') {
        if (!['paragraph', 'table'].includes(element.kind) || !['before', 'after'].includes(requested.position)) throw new Error('插入位置无效');
        assertXmlCharacters(requested.markdown);
        nonTocPlanned.push({ ...element, index, edit: requested, textStart: 0, textEnd: 0 });
        continue;
      }
      if (requested.op === 'insert_prepared_image') {
        if (!['paragraph', 'table', 'cell'].includes(element.kind)) throw new Error('图片位置无效');
        if (element.kind === 'cell' && editableText(element.xml)) throw new Error('图片目标单元格已有文字');
        nonTocPlanned.push({ ...element, index, edit: requested, textStart: 0, textEnd: 0 });
        continue;
      }
      if (requested.op === 'check') {
        const { start: position, find } = resolveCheckTarget(documentXml, requested.at, requested.option);
        const checkEdit = { op: 'replace' as const, at: requested.at, find, value: requested.checked ? '☑' : '□', yellow: requested.yellow, seal: requested.seal };
        nonTocPlanned.push({ ...element, index, edit: checkEdit, textStart: position, textEnd: position + 1 });
        continue;
      }
      edit = requested;
      if (edit.op !== 'mark_pending' && edit.op !== 'mark_fact') assertXmlCharacters(edit.value);
      if (edit.op === 'set_cell') {
        if (element.kind !== 'cell') throw new Error(`set_cell 需要单元格地址：${edit.at}`);
        if (editableText(element.xml).length) throw new Error(`单元格已有文字：${edit.at}`);
        nonTocPlanned.push({ ...element, index, edit, textStart: 0, textEnd: 0 });
        continue;
      }
      if (element.kind !== 'paragraph' && element.kind !== 'cell') throw new Error(`replace 需要段落或单元格地址：${edit.at}`);
      const target = (edit.op === 'mark_pending' && edit.span || edit.op === 'mark_fact') ? (() => {
        const text = editableText(element.xml), span = edit.op === 'mark_fact' ? edit.span : edit.span!;
        const { start, end } = span;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) throw new Error('待定范围无效');
        return { start, end, find: text.slice(start, end) };
      })() : resolveTextTarget(documentXml, edit);
      if (target.start === target.end) {
        if (edit.op === 'mark_pending' || edit.op === 'mark_fact') throw new Error('空提示没有可标记文字，请先填写该单元格');
        nonTocPlanned.push({ ...element, index, edit: { op: 'set_cell', at: edit.at, value: edit.value, yellow: edit.yellow, nativeHighlight: edit.nativeHighlight, seal: edit.seal }, textStart: 0, textEnd: 0 });
        continue;
      }
      nonTocPlanned.push({ ...element, index, edit, textStart: target.start, textEnd: target.end });
    } catch (error) { throw operationError(index, error); }
  }
  for (const toc of tocEdits) {
    if (deletedAddresses.has(toc.edit.at)) {
      throw operationError(toc.index, new Error(`不能在删除锚点 ${toc.edit.at} 的同一批次中执行 insert_toc`));
    }
    if (nonTocPlanned.length > 0) {
      const oldField = findAdjacentTocField(
        documentXml,
        options.stylesXml ?? '',
        toc.edit.at,
        toc.edit.position,
        toc.edit.maxLevel,
      );
      if (oldField) {
        const bodyBlocks = parseDocumentBody(documentXml).blocks;
        const startP = bodyBlocks[oldField.startBlockIdx]?.index ?? -1;
        const endP = bodyBlocks[oldField.endBlockIdx]?.index ?? -1;
        if (startP >= 0 && endP >= startP) {
          for (const item of nonTocPlanned) {
            const pMatch = /^p:(\d+)$/.exec(item.edit.at);
            if (!pMatch) continue;
            const pNum = Number(pMatch[1]);
            const inside =
              item.edit.op === 'insert'
                ? (pNum > startP && pNum < endP) ||
                  (startP < endP && pNum === startP && item.edit.position === 'after') ||
                  (startP < endP && pNum === endP && item.edit.position === 'before')
                : item.edit.op === 'insert_prepared_image'
                  ? pNum >= startP && pNum < endP
                  : pNum >= startP && pNum <= endP;
            if (inside) {
              throw operationError(
                item.index,
                new Error('同一批次中的编辑落入待替换旧目录区间，请拆分批次后再刷新目录'),
              );
            }
          }
        }
      }
    }
  }
  for (const item of nonTocPlanned) {
    const structural = item.edit.op === 'delete' || item.edit.op === 'insert_rows' && item.edit.mode === 'replace';
    if (structural) {
      for (const range of ranges) {
        const starts = item.start <= range.startXml && range.startXml < item.end;
        const ends = item.start < range.endXml && range.endXml <= item.end;
        if (starts && ends) removed.add(range.bookmarkId);
        else if (starts !== ends) throw operationError(item.index, new Error('编辑与 Seal 范围部分交叉；请整体替换该范围或只改范围内部'));
      }
    } else if (item.edit.op === 'replace' || item.edit.op === 'mark_pending' || item.edit.op === 'mark_fact') {
      const offset = visibleOffsetBefore(documentXml, item.start), start = offset + item.textStart, end = offset + item.textEnd;
      for (const range of ranges) {
        const relation = rangeRelation(range, start, end);
        if (relation === 'partial') throw operationError(item.index, new Error('编辑与 Seal 范围部分交叉；请整体替换该范围或只改范围内部'));
        if (relation === 'cover') removed.add(range.bookmarkId);
      }
    }
  }
  const groups = new Map<string, Planned[]>();
  const idSource = documentXml + edits.filter((edit): edit is Extract<TextBatchEdit, { op: 'insert_prepared_image' }> => edit.op === 'insert_prepared_image').map(edit => edit.drawing).join('');
  const drawingIds = [...idSource.matchAll(/<wp:docPr\b[^>]*\bid=["'](\d+)["']/g)].map(match => Number(match[1]));
  const anchorIds = [...idSource.matchAll(/\b(?:wp14:(?:anchorId|editId)|w14:(?:paraId|textId))=["']([0-9a-fA-F]{8})["']/g)].map(match => Number.parseInt(match[1], 16));
  const identities = { drawing: Math.max(0, ...drawingIds) + 1, anchor: Math.max(0, ...anchorIds) + 1, usedDrawings: new Set(drawingIds), usedAnchors: new Set(anchorIds), copyReference: options.copyReference };
  for (const item of nonTocPlanned) {
    const key = `${item.start}:${item.end}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const insertedBlocksByIndex = new Map<number, TopLevelBlock[]>();
  const replacements = [...groups.values()].map(group => {
    const first = group[0];
    if (group.length > 1 && group.some(item => item.edit.op === 'set_cell' || item.edit.op === 'delete' || item.edit.op === 'insert_rows' || item.edit.op === 'insert' || item.edit.op === 'insert_prepared_image')) throw operationError(first.index, new Error('同一编辑区域不能重复设置、复制、插入或删除'));
    const ordered = [...group].sort((a, b) => b.textStart - a.textStart);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i].textEnd > ordered[i - 1].textStart) throw operationError(ordered[i].index, new Error('同一批次中的文本范围重叠'));
    }
    let xml = first.xml;
    for (const item of ordered) {
      try {
        if (item.edit.op === 'delete') {
          xml = '';
        } else if (item.edit.op === 'insert_prepared_image') {
          const atomic = !!item.edit.imageLabel || item.edit.captioned;
          const picture = imageParagraph(item.edit.drawing, item.edit.imageLabel, item.edit.pending, item.edit.seal, atomic);
          let paragraph = atomic && item.edit.at.includes('/c:') ? captionedCellImage(picture, item.edit.widthTwips) : picture;
          if (atomic && (item.kind === 'cell' || isCellEdgeBlock(documentXml, item.edit.at, 'last'))) paragraph = terminateCellBlocks(paragraph);
          if (item.kind !== 'cell') {
            insertedBlocksByIndex.set(item.index, parseDocumentBody(`<w:document><w:body>${paragraph}</w:body></w:document>`).blocks);
            xml += paragraph;
          } else if (/<\/w:tc>$/.test(xml)) xml = xml.replace(/<\/w:tc>$/, `${paragraph}</w:tc>`);
          else if (/^<w:tc\b[^>]*\/>$/.test(xml)) xml = xml.replace(/\/>$/, `>${paragraph}</w:tc>`);
          else throw new Error('无法插入图片到该单元格');
        } else if (item.edit.op === 'insert') {
          const point = item.edit.position === 'before' ? item.start : item.end;
          const content = item.edit.compiledXml ?? markdownBlocks(item.edit.markdown, { paragraphProperties: sanitizeInsertedBodyParagraphPr(extractFirstParagraphPr(item.xml)), headingStyles: options.headingStyles, yellow: item.edit.yellow, widthTwips: layoutBox(documentXml, point).width / 635 }).xml;
          insertedBlocksByIndex.set(item.index, parseDocumentBody(`<w:document><w:body>${content}</w:body></w:document>`).blocks);
          xml = item.edit.position === 'before' ? content + xml : xml + content;
        } else if (item.edit.op === 'insert_rows') {
          const copies = buildRowCopies(documentXml, item.edit.at, item.edit.rows, !!item.edit.yellow, identities, item.edit.cellHighlights);
          xml = item.edit.mode === 'after' ? xml + copies : copies;
        } else if (item.edit.op === 'replace') {
          xml = replaceVisibleRange(xml, item.textStart, item.textEnd, item.edit.value, item.edit.yellow, '', new Set(ranges.map(range => range.bookmarkId)));
          if (item.edit.seal && item.edit.value) xml = wrapVisibleRange(xml, item.textStart, item.textStart + item.edit.value.replace(/\r\n/g, '\n').length, item.edit.seal.name, item.edit.seal.id);
        } else if (item.edit.op === 'mark_pending') {
          xml = highlightRange(xml, item.textStart, item.textEnd);
          if (item.edit.seal) xml = wrapVisibleRange(xml, item.textStart, item.textEnd, item.edit.seal.name, item.edit.seal.id);
        } else if (item.edit.op === 'mark_fact') {
          xml = wrapVisibleRange(xml, item.textStart, item.textEnd, item.edit.seal.name, item.edit.seal.id);
        } else {
          const source = cellStyleSource(documentXml, item.edit.at);
          let properties = source ? firstVisibleRunProperties(resolveAddress(documentXml, source).xml) : '';
          if (item.edit.yellow) properties = injectHighlightYellow(properties);
          else if (item.edit.nativeHighlight !== undefined) properties = setRunHighlight(properties, item.edit.nativeHighlight);
          const text = item.edit.value.split(/\r?\n/).map((line, index) => `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`).join('');
          xml = fillEmptyCellParagraph(xml, `<w:r>${properties}${text}</w:r>`);
          if (item.edit.seal && item.edit.value) xml = wrapVisibleRange(xml, 0, item.edit.value.replace(/\r\n/g, '\n').length, item.edit.seal.name, item.edit.seal.id);
        }
      } catch (error) { throw operationError(item.index, error); }
    }
    return { start: first.start, end: first.end, xml, index: first.index };
  }).sort((a, b) => b.start - a.start);
  for (let i = 1; i < replacements.length; i++) {
    if (replacements[i].end > replacements[i - 1].start) throw operationError(replacements[i].index, new Error('同一批次中的编辑区域重叠'));
  }
  let output = replacements.reduce((result, item) => result.slice(0, item.start) + item.xml + result.slice(item.end), documentXml);
  if (removed.size) {
    const markers = xmlElements(output).filter(element => ['w:bookmarkStart', 'w:bookmarkEnd'].includes(element.name) && removed.has(/\bw:id\s*=\s*["']([^"']+)["']/.exec(output.slice(element.start, element.openEnd))?.[1] ?? ''));
    output = markers.reverse().reduce((result, marker) => result.slice(0, marker.start) + result.slice(marker.end), output);
  }
  const active = sealRanges(output);
  if (options.pendingFacts?.size) {
    const adopting = active.filter(scope => options.pendingFacts!.has(scope.name));
    if (adopting.length !== options.pendingFacts.size || adopting.some(scope => !scope.name.startsWith('_Seal_F_'))) throw new Error('待转为待定的事实范围不存在');
    for (const scope of adopting) if (scope.start < scope.end) output = highlightRange(output, scope.start, scope.end);
    const markers = xmlElements(output).filter(element => element.name === 'w:bookmarkStart');
    for (const marker of markers.reverse()) {
      const tag = output.slice(marker.start, marker.openEnd);
      const name = /\bw:name\s*=\s*["']([^"']+)["']/.exec(tag)?.[1];
      if (name && options.pendingFacts.has(name)) output = output.slice(0, marker.start) + tag.replace(name, name.replace('_Seal_F_', '_Seal_P_')) + output.slice(marker.openEnd);
    }
    sealRanges(output);
  }

  const tocEffects: AppliedTocEffect[] = [];
  const nonTocInsertedAddresses = new Map<number, string[]>();
  if (tocEdits.length > 0) {
    const mapTopLevelAddressAfterNonToc = (at: string): string => {
      const match = /^([pt]):(\d+)$/.exec(at)!;
      const kindChar = match[1];
      const origIdx = Number(match[2]);
      const target = resolveAddress(documentXml, at);
      let delta = 0;
      for (const item of nonTocPlanned) {
        if (item.edit.op === 'delete') {
          const m = /^([pt]):(\d+)$/.exec(item.edit.at);
          if (m && m[1] === kindChar && Number(m[2]) < origIdx) delta -= 1;
        } else if (item.edit.op === 'insert' && /^[pt]:\d+$/.test(item.edit.at)) {
          if (item.start < target.start || (item.start === target.start && item.edit.position === 'before')) {
            const blocks = insertedBlocksByIndex.get(item.index) ?? [];
            delta += blocks.filter(b => b.kind === (kindChar === 'p' ? 'paragraph' : 'table')).length;
          }
        } else if (item.edit.op === 'insert_prepared_image' && /^[pt]:\d+$/.test(item.edit.at)) {
          if (item.start < target.start) {
            const blocks = insertedBlocksByIndex.get(item.index) ?? [];
            delta += blocks.filter(b => b.kind === (kindChar === 'p' ? 'paragraph' : 'table')).length;
          }
        }
      }
      return `${kindChar}:${origIdx + delta}`;
    };

    const intermediateBody = parseDocumentBody(output).blocks.filter(b => b.kind === 'paragraph' || b.kind === 'table');
    const intermediateAddr = (b: TopLevelBlock) => `${b.kind === 'paragraph' ? 'p' : 't'}:${b.index}`;
    for (const item of nonTocPlanned) {
      if ((item.edit.op === 'insert' || (item.edit.op === 'insert_prepared_image' && item.kind !== 'cell')) && /^[pt]:\d+$/.test(item.edit.at)) {
        const anchorAddr = mapTopLevelAddressAfterNonToc(item.edit.at);
        const anchorPos = intermediateBody.findIndex(b => intermediateAddr(b) === anchorAddr);
        const count = (insertedBlocksByIndex.get(item.index) ?? []).filter(b => b.kind === 'paragraph' || b.kind === 'table').length;
        if (anchorPos >= 0) {
          const startPos = item.edit.op === 'insert' && item.edit.position === 'before' ? anchorPos - count : anchorPos + 1;
          nonTocInsertedAddresses.set(
            item.index,
            intermediateBody.slice(startPos, startPos + count).map(intermediateAddr),
          );
        }
      }
    }

    for (const tocItem of tocEdits) {
      try {
        const mappedBeforeToc = mapTopLevelAddressAfterNonToc(tocItem.edit.at);
        let currentAt = mappedBeforeToc;
        const pMatch = /^p:(\d+)$/.exec(currentAt);
        if (pMatch) {
          let pIdx = Number(pMatch[1]);
          for (const prev of tocEffects) {
            const shiftStart = prev.paragraphsBeforeReplaceRange + prev.oldRangeParagraphCount;
            if (pIdx >= shiftStart) {
              pIdx += prev.newRangeParagraphCount - prev.oldRangeParagraphCount;
            }
          }
          currentAt = `p:${pIdx}`;
        }
        const activeField = findAdjacentTocField(
          output,
          options.stylesXml ?? '',
          currentAt,
          tocItem.edit.position,
          tocItem.edit.maxLevel,
        );
        if (activeField) {
          const activeBlocks = parseDocumentBody(output).blocks;
          const activeStartP = activeBlocks[activeField.startBlockIdx]?.index ?? -1;
          const activeEndP = activeBlocks[activeField.endBlockIdx]?.index ?? -1;
          for (const addrs of nonTocInsertedAddresses.values()) {
            for (const addr of addrs) {
              const m = /^p:(\d+)$/.exec(addr);
              if (m && Number(m[1]) >= activeStartP && Number(m[1]) <= activeEndP) {
                throw new Error('同一批次中新增内容落入待替换旧目录区间，请拆分批次后再刷新目录');
              }
            }
          }
        }
        const res = applyInsertToc(
          output,
          { ...tocItem.edit, at: currentAt },
          options.stylesXml ?? '',
          { placeholderPage: options.tocPlaceholderPage ?? '' },
        );
        output = res.xml;
        const shiftStart = res.paragraphsBeforeReplaceRange + res.oldRangeParagraphCount;
        const deltaP = res.newRangeParagraphCount - res.oldRangeParagraphCount;
        for (const [editIdx, addrs] of nonTocInsertedAddresses) {
          nonTocInsertedAddresses.set(
            editIdx,
            addrs.map(addr => {
              const m = /^p:(\d+)$/.exec(addr);
              if (!m) return addr;
              const num = Number(m[1]);
              return num >= shiftStart ? `p:${num + deltaP}` : addr;
            }),
          );
        }
        tocEffects.push({
          originalAt: tocItem.edit.at,
          mappedAnchorBeforeToc: mappedBeforeToc,
          position: tocItem.edit.position,
          insertAtParagraphIndex: res.insertAtParagraphIndex,
          paragraphsBeforeReplaceRange: res.paragraphsBeforeReplaceRange,
          oldRangeParagraphCount: res.oldRangeParagraphCount,
          newRangeParagraphCount: res.newRangeParagraphCount,
          removedParagraphs: res.removedParagraphs,
          insertedParagraphs: res.insertedParagraphs,
          insertedAddresses: res.insertedAddresses,
          entries: res.entries,
          ...(res.anchorTitle ? { anchorTitle: res.anchorTitle } : {}),
        });
      } catch (error) {
        throw operationError(tocItem.index, error);
      }
    }
  }

  return { xml: output, tocEffects, nonTocInsertedAddresses };
}
