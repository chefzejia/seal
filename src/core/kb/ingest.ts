import type { HostPort } from '../host.js';
import { outline, xmlAttributes } from '../docx/outline.js';
import { parseDocumentBody, parseTableRows, xmlElements } from '../docx/xml.js';
import { paragraphText } from '../docx/visible-text.js';
import { validatePackageStructure, resolveRelationshipTarget } from '../docx/package-structure.js';
import { sha256Hex, validateImageBytes } from '../docx/zip.js';
import { serializeEntry } from './markdown.js';
import { parseDelimitedRecords, parseXlsxSheets, rowsToMarkdownTable } from './xlsx.js';
import type { IngestCandidate, IngestSourceType } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

export interface IngestSkippedItem {
  source: string;
  reason: string;
}

export type IngestMaterialItem =
  | { kind: 'docx'; sourcePath: string; originalPath?: string }
  | { kind: 'pdf'; sourcePath: string; originalPath?: string }
  | { kind: 'image'; sourcePath: string; originalPath?: string; mime: string }
  | { kind: 'xlsx'; sourcePath: string; originalPath?: string }
  | { kind: 'delimited'; sourcePath: string; originalPath?: string; delimiter: ',' | '\t' }
  | { kind: 'text'; sourcePath: string; originalPath?: string };

export interface IngestCandidateSummary extends Pick<IngestCandidate, 'id' | 'title' | 'location' | 'imageFiles'> {
  sourceType?: IngestSourceType;
}

export interface IngestMasterReport {
  batchId: string;
  sourceCount: number;
  candidateCount: number;
  imageCount: number;
  candidates: IngestCandidateSummary[];
}

export interface IngestMaterialsReport extends IngestMasterReport {
  skipped: IngestSkippedItem[];
}

interface CandidateDraft {
  title: string;
  tags: string[];
  location: string;
  lines: string[];
  parts: Set<string>;
}

function fileBase(path: string): string { return path.replace(/\\/g, '/').split('/').at(-1) ?? 'source.docx'; }

function safeFileName(value: string): string {
  const cleaned = value.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '').slice(-100);
  return cleaned || 'image.bin';
}

function contentTypes(entries: ReadonlyMap<string, Uint8Array>): Map<string, string> {
  const xml = decoder.decode(entries.get('[Content_Types].xml')!);
  const defaults = new Map<string, string>(), overrides = new Map<string, string>();
  for (const element of xmlElements(xml)) {
    const name = element.name.split(':').at(-1);
    if (name !== 'Default' && name !== 'Override') continue;
    const attrs = xmlAttributes(xml, element);
    if (name === 'Default') {
      const extension = attrs.get('Extension'), type = attrs.get('ContentType');
      if (extension && type) defaults.set(extension.toLowerCase(), type.toLowerCase());
    } else {
      const part = attrs.get('PartName'), type = attrs.get('ContentType');
      if (part && type) overrides.set(part.replace(/^\//, ''), type.toLowerCase());
    }
  }
  const result = new Map<string, string>();
  for (const name of entries.keys()) {
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const mime = overrides.get(name) ?? defaults.get(extension);
    if (name.startsWith('word/media/') && mime?.startsWith('image/')) result.set(name, mime);
  }
  return result;
}

function imageRelationships(entries: ReadonlyMap<string, Uint8Array>): Map<string, string> {
  const path = 'word/_rels/document.xml.rels';
  const xml = entries.has(path) ? decoder.decode(entries.get(path)!) : '';
  const result = new Map<string, string>();
  for (const element of xmlElements(xml)) {
    if (element.name.split(':').at(-1) !== 'Relationship') continue;
    const attrs = xmlAttributes(xml, element), id = attrs.get('Id'), target = attrs.get('Target'), type = attrs.get('Type');
    if (id && target && type?.endsWith('/image') && attrs.get('TargetMode') !== 'External') result.set(id, resolveRelationshipTarget('word/', target));
  }
  return result;
}

function imageIds(xml: string, relations: ReadonlyMap<string, string>): string[] {
  const ids = new Set<string>();
  for (const element of xmlElements(xml)) {
    const attrs = xmlAttributes(xml, element);
    for (const key of ['r:embed', 'r:id']) {
      const id = attrs.get(key);
      if (id && relations.has(id)) ids.add(id);
    }
  }
  return [...ids];
}

function tableMarkdown(xml: string): string {
  const rows = parseTableRows(xml).map(row => row.cells.map(cell => paragraphText(cell.xml).replace(/\n+/g, '<br>').replace(/\|/g, '｜').trim()));
  if (!rows.length) return '';
  const columns = Math.max(1, ...rows.map(row => row.length));
  const normalized = rows.map(row => [...row, ...Array(Math.max(0, columns - row.length)).fill('')]);
  return [
    `| ${normalized[0].join(' | ')} |`,
    `| ${normalized[0].map(() => '---').join(' | ')} |`,
    ...normalized.slice(1).map(row => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function titleAndTags(raw: string): { title: string; tags: string[] } {
  let title = raw.replace(/\s+/g, ' ').trim();
  const tags: string[] = [];
  for (const marker of ['直接套用', '标黄']) {
    if (title.includes(marker)) {
      tags.push(marker);
      title = title.split(marker).join(' ').replace(/\s+/g, ' ').trim();
    }
  }
  return { title: title || '未命名章节', tags };
}

function encodePath(path: string): string { return path.split('/').map(segment => encodeURIComponent(segment)).join('/'); }

function splitTextChunks(text: string, maxChars = 24000): Array<{ start: number; end: number; content: string }> {
  if (!text.length) return [{ start: 0, end: 0, content: '' }];
  const chunks: Array<{ start: number; end: number; content: string }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const prev = text.charCodeAt(end - 1);
      const curr = text.charCodeAt(end);
      if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
        end--;
      }
    }
    chunks.push({ start, end, content: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

interface IngestContext {
  host: HostPort;
  vaultRoot: string;
  stagingRoot: string;
  batchId: string;
  inboxRoot: string;
  fileRoot: string;
  candidates: IngestCandidateSummary[];
  totalImages: number;
}

async function processDocxItem(
  ctx: IngestContext,
  sourcePath: string,
  original: string,
  sourceSequence: number,
): Promise<void> {
  const sourceName = fileBase(original);
  if (!/\.docx$/i.test(sourcePath)) throw new Error('母本入库只接受 DOCX；DOC 应先由宿主转换');
  const sourceBytes = await ctx.host.readBytes(sourcePath);
  const entries = await validatePackageStructure(sourceBytes);
  const sourceDigest = sha256Hex(original === sourcePath ? sourceBytes : await ctx.host.readBytes(original));
  const documentXml = decoder.decode(entries.get('word/document.xml')!);
  const stylesRel = 'word/_rels/document.xml.rels';
  const rels = imageRelationships(entries);
  const stylesLink = (() => {
    if (!entries.has(stylesRel)) return undefined;
    const relXml = decoder.decode(entries.get(stylesRel)!);
    for (const element of xmlElements(relXml)) {
      if (element.name.split(':').at(-1) !== 'Relationship') continue;
      const attrs = xmlAttributes(relXml, element);
      if (attrs.get('Type')?.endsWith('/styles') && attrs.get('TargetMode') !== 'External' && attrs.has('Target')) return resolveRelationshipTarget('word/', attrs.get('Target')!);
    }
    return undefined;
  })();
  const stylesXml = stylesLink && entries.has(stylesLink) ? decoder.decode(entries.get(stylesLink)!) : '';
  const sections = outline(documentXml, stylesXml);
  const blocks = parseDocumentBody(documentXml).blocks;
  const addressToBlock = new Map<string, number>();
  for (const [index, block] of blocks.entries()) if (block.kind === 'paragraph' || block.kind === 'table') addressToBlock.set(`${block.kind === 'paragraph' ? 'p' : 't'}:${block.index}`, index);
  const headingByBlock = new Map<number, typeof sections[number]>();
  for (const section of sections) {
    const index = addressToBlock.get(section.from);
    if (index !== undefined) headingByBlock.set(index, section);
  }
  const drafts: CandidateDraft[] = [];
  let active: CandidateDraft | undefined;
  const ensureIntro = () => active ?? (active = { title: `未分段内容 ${sourceSequence}`, tags: [], location: 'word/document.xml#body', lines: [], parts: new Set() });
  for (const [blockIndex, block] of blocks.entries()) {
    if (block.kind !== 'paragraph' && block.kind !== 'table') continue;
    const heading = headingByBlock.get(blockIndex);
    if (heading) {
      const parsed = titleAndTags(heading.title);
      active = { title: parsed.title, tags: parsed.tags, location: `word/document.xml#${heading.from}-${heading.to}`, lines: [`# ${parsed.title}`], parts: new Set() };
      drafts.push(active);
    }
    if (!active) { active = ensureIntro(); drafts.push(active); }
    if (block.kind === 'paragraph') {
      const text = paragraphText(block.xml).trim();
      if (text && !heading) active.lines.push(text);
    } else {
      const table = tableMarkdown(block.xml);
      if (table) active.lines.push(table);
    }
    for (const id of imageIds(block.xml, rels)) active.parts.add(rels.get(id)!);
  }
  const mediaTypes = contentTypes(entries), imagePartNames = [...mediaTypes.keys()].sort();
  ctx.totalImages += imagePartNames.length;
  const persistedImage = new Map<string, { original: string; preview: string }>();
  const sourceFileRoot = ctx.host.joinPath(ctx.fileRoot, `source-${sourceSequence}`);
  await ctx.host.makeDirectory!(sourceFileRoot);
  for (const [imageIndex, part] of imagePartNames.entries()) {
    const mime = mediaTypes.get(part)!;
    const bytes = entries.get(part)!;
    if (mime === 'image/png' || mime === 'image/jpeg') await validateImageBytes(bytes, mime);
    else if (ctx.host.validateImage) await ctx.host.validateImage(bytes, mime);
    else throw new Error(`宿主不支持校验母本图片：${mime}`);
    const originalName = safeFileName(fileBase(part));
    const relative = `files/${ctx.batchId}/source-${sourceSequence}/${String(imageIndex + 1).padStart(4, '0')}-${originalName}`;
    const destination = ctx.host.joinPath(ctx.vaultRoot, relative);
    await ctx.host.writeBytes(destination, bytes);
    let preview = relative;
    if (!['image/png', 'image/jpeg'].includes(mime)) {
      if (!ctx.host.convertImageToPng) throw new Error(`宿主不支持生成图片预览：${mime}`);
      const stageInput = ctx.host.joinPath(ctx.stagingRoot, `source-${sourceSequence}-${imageIndex}.${originalName.split('.').at(-1)}`);
      await ctx.host.writeBytes(stageInput, bytes);
      const converted = await ctx.host.convertImageToPng(stageInput, ctx.host.joinPath(ctx.stagingRoot, `preview-${sourceSequence}-${imageIndex}`));
      const previewBytes = await ctx.host.readBytes(converted.filePath);
      await validateImageBytes(previewBytes, 'image/png');
      const previewName = `${String(imageIndex + 1).padStart(4, '0')}-${originalName.replace(/\.[^.]+$/, '')}.preview.png`;
      preview = `files/${ctx.batchId}/source-${sourceSequence}/${safeFileName(previewName)}`;
      await ctx.host.writeBytes(ctx.host.joinPath(ctx.vaultRoot, preview), previewBytes);
    }
    persistedImage.set(part, { original: relative, preview });
  }
  const referenced = new Set<string>();
  for (const draft of drafts) {
    const files = [...draft.parts].flatMap(part => {
      const item = persistedImage.get(part);
      if (!item) return [];
      referenced.add(part);
      return item.original === item.preview ? [item.original] : [item.original, item.preview];
    });
    const imageLinks = [...draft.parts].flatMap(part => {
      const item = persistedImage.get(part);
      return item ? [`![母本图片](../../${encodePath(item.preview)})`] : [];
    });
    const id = `candidate-${crypto.randomUUID()}`;
    const location = `${draft.location}; source ${sourceSequence}`;
    const body = [...draft.lines, ...imageLinks].filter(Boolean).join('\n\n');
    const fields = {
      title: draft.title, source: sourceName, sourceType: 'docx', location,
      tags: draft.tags, files, imageCount: String(draft.parts.size), processed: false, status: 'pending',
      sourceDigest,
    };
    await ctx.host.writeText(ctx.host.joinPath(ctx.inboxRoot, `${id}.md`), serializeEntry(fields, body));
    ctx.candidates.push({ id, title: draft.title, location, imageFiles: files, sourceType: 'docx' });
  }
  const unlinked = imagePartNames.filter(part => !referenced.has(part));
  if (unlinked.length) {
    const files = unlinked.flatMap(part => {
      const item = persistedImage.get(part);
      return item ? item.original === item.preview ? [item.original] : [item.original, item.preview] : [];
    });
    const id = `candidate-${crypto.randomUUID()}`, title = `未关联章节图片 ${sourceSequence}`;
    const imageLinks = unlinked.flatMap(part => {
      const item = persistedImage.get(part);
      return item ? [`![母本图片](../../${encodePath(item.preview)})`] : [];
    });
    const location = `word/media/*; source ${sourceSequence}`;
    const body = ['图片部件未被正文章节引用，主体与用途待核实。', ...imageLinks].join('\n\n');
    await ctx.host.writeText(ctx.host.joinPath(ctx.inboxRoot, `${id}.md`), serializeEntry({
      title, source: sourceName, sourceType: 'docx', location, tags: [], files,
      imageCount: String(unlinked.length), processed: false, status: 'pending', sourceDigest,
    }, body));
    ctx.candidates.push({ id, title, location, imageFiles: files, sourceType: 'docx' });
  }
}

async function processPdfItem(
  ctx: IngestContext,
  item: Extract<IngestMaterialItem, { kind: 'pdf' }>,
  sourceSequence: number,
): Promise<void> {
  if (!ctx.host.extractPdf) throw new Error('宿主不支持 PDF 解析');
  const original = item.originalPath ?? item.sourcePath;
  const sourceName = fileBase(original);
  const pdfBytes = await ctx.host.readBytes(item.sourcePath);
  const sourceDigest = sha256Hex(pdfBytes);
  const extractDir = ctx.host.joinPath(ctx.stagingRoot, `pdf-${sourceSequence}`);
  const extracted = await ctx.host.extractPdf(item.sourcePath, extractDir);

  const srcDirRel = `files/${ctx.batchId}/src-${sourceSequence}`;
  await ctx.host.makeDirectory!(ctx.host.joinPath(ctx.vaultRoot, srcDirRel));

  const pdfFileName = safeFileName(sourceName.toLowerCase().endsWith('.pdf') ? sourceName : `${sourceName}.pdf`);
  const pdfRel = `${srcDirRel}/${pdfFileName}`;
  await ctx.host.writeBytes(ctx.host.joinPath(ctx.vaultRoot, pdfRel), pdfBytes);

  const pngRelByPage = new Map<number, string>();
  for (const page of extracted.pages) {
    if (!page.imagePath) continue;
    const pngBytes = await ctx.host.readBytes(page.imagePath);
    await validateImageBytes(pngBytes, 'image/png');
    if (ctx.host.validateImage) await ctx.host.validateImage(pngBytes, 'image/png');
    const pngRel = `${srcDirRel}/page-${String(page.page).padStart(3, '0')}.png`;
    await ctx.host.writeBytes(ctx.host.joinPath(ctx.vaultRoot, pngRel), pngBytes);
    pngRelByPage.set(page.page, pngRel);
    ctx.totalImages++;
  }

  const pagesPerChunk = 10;
  const chunkCount = Math.max(1, Math.ceil(extracted.pages.length / pagesPerChunk));
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const slice = extracted.pages.slice(chunkIndex * pagesPerChunk, (chunkIndex + 1) * pagesPerChunk);
    const startPage = slice[0]?.page ?? 1;
    const endPage = slice.at(-1)?.page ?? startPage;
    const location =
      startPage === endPage
        ? `第 ${startPage} 页 / 共 ${extracted.pageCount} 页`
        : `第 ${startPage}-${endPage} 页 / 共 ${extracted.pageCount} 页`;
    const title = chunkCount === 1 ? sourceName : `${sourceName}（第 ${startPage}-${endPage} 页）`;
    const imageFiles = slice.map((p) => pngRelByPage.get(p.page)).filter((v): v is string => Boolean(v));
    const files = [...imageFiles, pdfRel];

    const lines: string[] = [];
    if (extracted.truncatedPages > 0) {
      lines.push(
        `> 注意：本 PDF 共 ${extracted.pageCount} 页，受安全渲染上限限制仅渲染前 ${extracted.renderedPages} 页 PNG，未渲染 ${extracted.truncatedPages} 页（truncatedPages=${extracted.truncatedPages}）。`,
      );
    }
    lines.push(`原 PDF 存档：\`${pdfRel}\``);
    for (const page of slice) {
      lines.push(`## 第 ${page.page} 页`);
      const text = page.text.trim();
      lines.push(text || '（本页无文本层，疑似扫描件，请查看对应图片提取关键信息）');
      const pngRel = pngRelByPage.get(page.page);
      if (pngRel) {
        lines.push(`图片路径：\`${pngRel}\``);
        lines.push(`![第 ${page.page} 页](../../${encodePath(pngRel)})`);
      } else if (page.page > extracted.renderedPages) {
        lines.push(`（超出安全渲染页数上限 ${extracted.renderedPages} 页，未生成 PNG 预览）`);
      }
    }

    const id = `candidate-${crypto.randomUUID()}`;
    await ctx.host.writeText(
      ctx.host.joinPath(ctx.inboxRoot, `${id}.md`),
      serializeEntry(
        {
          title,
          source: sourceName,
          sourceType: 'pdf',
          sourceDigest,
          location,
          tags: [],
          files,
          imageFiles,
          ...(extracted.truncatedPages > 0
            ? {
                truncatedPages: String(extracted.truncatedPages),
                renderedPages: String(extracted.renderedPages),
              }
            : {}),
          processed: false,
          status: 'pending',
        },
        lines.join('\n\n'),
      ),
    );
    ctx.candidates.push({ id, title, location, imageFiles, sourceType: 'pdf' });
  }
}

async function processImageItem(
  ctx: IngestContext,
  item: Extract<IngestMaterialItem, { kind: 'image' }>,
  sourceSequence: number,
): Promise<void> {
  const original = item.originalPath ?? item.sourcePath;
  const sourceName = fileBase(original);
  const rawBytes = await ctx.host.readBytes(item.sourcePath);
  const sourceDigest = sha256Hex(rawBytes);

  if (ctx.host.validateImage) {
    await ctx.host.validateImage(rawBytes, item.mime);
  } else if (item.mime === 'image/png' || item.mime === 'image/jpeg') {
    await validateImageBytes(rawBytes, item.mime);
  } else {
    throw new Error(`宿主不支持校验图片：${item.mime}`);
  }

  let persistedBytes = rawBytes;
  let targetFileName = safeFileName(sourceName);
  if (item.mime === 'image/webp') {
    if (!ctx.host.convertImageBytesToPng) {
      throw new Error('宿主不支持将 WebP 转换为 PNG');
    }
    persistedBytes = await ctx.host.convertImageBytesToPng(rawBytes, item.mime);
    await validateImageBytes(persistedBytes, 'image/png');
    targetFileName = safeFileName(`${sourceName.replace(/\.webp$/i, '')}.png`);
  } else if (item.mime === 'image/png' || item.mime === 'image/jpeg') {
    await validateImageBytes(persistedBytes, item.mime);
  }

  const srcDirRel = `files/${ctx.batchId}/src-${sourceSequence}`;
  await ctx.host.makeDirectory!(ctx.host.joinPath(ctx.vaultRoot, srcDirRel));
  const relPath = `${srcDirRel}/${targetFileName}`;
  await ctx.host.writeBytes(ctx.host.joinPath(ctx.vaultRoot, relPath), persistedBytes);
  ctx.totalImages++;

  const id = `candidate-${crypto.randomUUID()}`;
  const location = sourceName;
  const body = [
    '请结合图像内容提取主体/证照/有效期/编号等结构化字段。',
    `图片路径：\`${relPath}\``,
    `![${sourceName}](../../${encodePath(relPath)})`,
  ].join('\n\n');

  await ctx.host.writeText(
    ctx.host.joinPath(ctx.inboxRoot, `${id}.md`),
    serializeEntry(
      {
        title: sourceName,
        source: sourceName,
        sourceType: 'image',
        sourceDigest,
        location,
        tags: [],
        files: [relPath],
        imageFiles: [relPath],
        processed: false,
        status: 'pending',
      },
      body,
    ),
  );
  ctx.candidates.push({ id, title: sourceName, location, imageFiles: [relPath], sourceType: 'image' });
}

function formatRowNumberRanges(rowNumbers: readonly number[]): string {
  if (!rowNumbers.length) return '';
  const ranges: string[] = [];
  let start = rowNumbers[0];
  let end = rowNumbers[0];
  for (let i = 1; i < rowNumbers.length; i++) {
    const n = rowNumbers[i];
    if (n === end + 1) {
      end = n;
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = n;
      end = n;
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

async function processSpreadsheetItem(
  ctx: IngestContext,
  item: Extract<IngestMaterialItem, { kind: 'xlsx' | 'delimited' }>,
): Promise<void> {
  const original = item.originalPath ?? item.sourcePath;
  const sourceName = fileBase(original);
  const rawBytes = await ctx.host.readBytes(item.sourcePath);
  const sourceDigest = sha256Hex(
    original === item.sourcePath ? rawBytes : await ctx.host.readBytes(original),
  );

  const sheets =
    item.kind === 'xlsx'
      ? await parseXlsxSheets(rawBytes)
      : [{ name: sourceName, rows: parseDelimitedRecords(decoder.decode(rawBytes), item.delimiter) }];

  const nonEmptySheets = sheets
    .map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.filter((row) => row.cells.some((cell) => cell.trim() !== '')),
    }))
    .filter((sheet) => sheet.rows.length > 0);

  if (!nonEmptySheets.length) {
    const id = `candidate-${crypto.randomUUID()}`;
    const location = '空工作表';
    await ctx.host.writeText(
      ctx.host.joinPath(ctx.inboxRoot, `${id}.md`),
      serializeEntry(
        {
          title: sourceName,
          source: sourceName,
          sourceType: 'spreadsheet',
          sourceDigest,
          location,
          tags: [],
          files: [],
          imageFiles: [],
          processed: false,
          status: 'pending',
        },
        '（表格不包含有效行数据）',
      ),
    );
    ctx.candidates.push({ id, title: sourceName, location, imageFiles: [], sourceType: 'spreadsheet' });
    return;
  }

  const isStrictlyContiguous = (rows: readonly { rowNumber: number }[]): boolean => {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].rowNumber !== rows[i - 1].rowNumber + 1) return false;
    }
    return true;
  };

  const rowsPerChunk = 200;
  for (const sheet of nonEmptySheets) {
    const chunkCount = Math.ceil(sheet.rows.length / rowsPerChunk);
    const sheetFirstRow = sheet.rows[0].rowNumber;
    const sheetIsDenseFromStart = sheetFirstRow === 1 && isStrictlyContiguous(sheet.rows);

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
      const startOffset = chunkIndex * rowsPerChunk;
      const chunkRows = sheet.rows.slice(startOffset, startOffset + rowsPerChunk);
      const startRow = chunkRows[0].rowNumber;
      const endRow = chunkRows.at(-1)!.rowNumber;
      const chunkIsContiguous = isStrictlyContiguous(chunkRows);
      const rowSpanLabel = startRow === endRow ? `第 ${startRow} 行` : `第 ${startRow}-${endRow} 行`;

      const location =
        chunkIsContiguous && sheetIsDenseFromStart
          ? `工作表「${sheet.name}」${rowSpanLabel} / 共 ${sheet.rows.length} 行`
          : chunkCount === 1
            ? `工作表「${sheet.name}」${rowSpanLabel}（含 ${chunkRows.length} 行非空数据）`
            : `工作表「${sheet.name}」${rowSpanLabel}（本段含 ${chunkRows.length} 行，全表共 ${sheet.rows.length} 行非空数据）`;

      const title =
        nonEmptySheets.length === 1 && chunkCount === 1
          ? sourceName
          : chunkCount === 1
            ? `${sourceName} - ${sheet.name}`
            : `${sourceName} - ${sheet.name}（${rowSpanLabel}）`;

      const tableMarkdown = rowsToMarkdownTable(chunkRows);
      const body =
        !chunkIsContiguous || !sheetIsDenseFromStart
          ? `> 原表真实行号：${formatRowNumberRanges(chunkRows.map((row) => row.rowNumber))}（表格各行依次对应原表上述行号）\n\n${tableMarkdown}`
          : tableMarkdown;

      const id = `candidate-${crypto.randomUUID()}`;
      await ctx.host.writeText(
        ctx.host.joinPath(ctx.inboxRoot, `${id}.md`),
        serializeEntry(
          {
            title,
            source: sourceName,
            sourceType: 'spreadsheet',
            sourceDigest,
            location,
            tags: [],
            files: [],
            imageFiles: [],
            processed: false,
            status: 'pending',
          },
          body,
        ),
      );
      ctx.candidates.push({ id, title, location, imageFiles: [], sourceType: 'spreadsheet' });
    }
  }
}

async function processTextItem(
  ctx: IngestContext,
  item: Extract<IngestMaterialItem, { kind: 'text' }>,
): Promise<void> {
  const original = item.originalPath ?? item.sourcePath;
  const sourceName = fileBase(original);
  const rawBytes = await ctx.host.readBytes(item.sourcePath);
  const sourceDigest = sha256Hex(rawBytes);
  const text = decoder.decode(rawBytes);
  const chunks = splitTextChunks(text, 24000);

  for (const [index, chunk] of chunks.entries()) {
    const location =
      chunks.length === 1
        ? '全文'
        : `第 ${index + 1}/${chunks.length} 段（字符 ${chunk.start + 1}-${chunk.end}）`;
    const title = chunks.length === 1 ? sourceName : `${sourceName}（第 ${index + 1}/${chunks.length} 段）`;
    const body = chunk.content.trim() ? chunk.content : '（空文本文件）';
    const id = `candidate-${crypto.randomUUID()}`;
    await ctx.host.writeText(
      ctx.host.joinPath(ctx.inboxRoot, `${id}.md`),
      serializeEntry(
        {
          title,
          source: sourceName,
          sourceType: 'text',
          sourceDigest,
          location,
          tags: [],
          files: [],
          imageFiles: [],
          processed: false,
          status: 'pending',
        },
        body,
      ),
    );
    ctx.candidates.push({ id, title, location, imageFiles: [], sourceType: 'text' });
  }
}

export async function ingestMaterials(input: {
  host: HostPort;
  vaultRoot: string;
  items: readonly IngestMaterialItem[];
  skipped?: readonly IngestSkippedItem[];
  stagingRoot: string;
  batchId?: string;
  commit?: (report: IngestMaterialsReport) => Promise<void>;
}): Promise<IngestMaterialsReport> {
  if (!input.items.length) throw new Error('至少提供一个可入库材料');
  if (!input.host.makeDirectory || !input.host.removeDirectory) {
    throw new Error('HostPort 需要支持入库临时目录和本批回滚');
  }
  const batchId = input.batchId ?? `batch-${crypto.randomUUID()}`;
  const inboxRoot = input.host.joinPath(input.vaultRoot, 'inbox', batchId);
  const fileRoot = input.host.joinPath(input.vaultRoot, 'files', batchId);
  if ((await input.host.stat(inboxRoot)).exists || (await input.host.stat(fileRoot)).exists) {
    throw new Error('入库批次已存在，不会覆盖已有内容');
  }
  const ctx: IngestContext = {
    host: input.host,
    vaultRoot: input.vaultRoot,
    stagingRoot: input.stagingRoot,
    batchId,
    inboxRoot,
    fileRoot,
    candidates: [],
    totalImages: 0,
  };
  let sourceSequence = 0;
  try {
    await input.host.makeDirectory(inboxRoot);
    await input.host.makeDirectory(fileRoot);
    await input.host.makeDirectory(input.stagingRoot);
    for (const item of input.items) {
      sourceSequence++;
      if (item.kind === 'docx') {
        await processDocxItem(ctx, item.sourcePath, item.originalPath ?? item.sourcePath, sourceSequence);
      } else if (item.kind === 'pdf') {
        await processPdfItem(ctx, item, sourceSequence);
      } else if (item.kind === 'image') {
        await processImageItem(ctx, item, sourceSequence);
      } else if (item.kind === 'xlsx' || item.kind === 'delimited') {
        await processSpreadsheetItem(ctx, item);
      } else if (item.kind === 'text') {
        await processTextItem(ctx, item);
      }
    }
    const report: IngestMaterialsReport = {
      batchId,
      sourceCount: input.items.length,
      candidateCount: ctx.candidates.length,
      imageCount: ctx.totalImages,
      candidates: ctx.candidates,
      skipped: [...(input.skipped ?? [])],
    };
    await input.commit?.(report);
    return report;
  } catch (error) {
    await input.host.removeDirectory(inboxRoot);
    await input.host.removeDirectory(fileRoot);
    throw error;
  } finally {
    await input.host.removeDirectory(input.stagingRoot);
  }
}

export async function ingestMasterDocuments(input: {
  host: HostPort;
  vaultRoot: string;
  sourcePaths: readonly string[];
  originalSourcePaths?: readonly string[];
  stagingRoot: string;
  batchId?: string;
  commit?: (report: IngestMasterReport) => Promise<void>;
}): Promise<IngestMasterReport> {
  if (!input.sourcePaths.length) throw new Error('至少提供一个 DOCX 母本');
  const report = await ingestMaterials({
    host: input.host,
    vaultRoot: input.vaultRoot,
    items: input.sourcePaths.map((sourcePath, index) => ({
      kind: 'docx' as const,
      sourcePath,
      originalPath: input.originalSourcePaths?.[index] ?? sourcePath,
    })),
    stagingRoot: input.stagingRoot,
    batchId: input.batchId,
    commit: input.commit ? async (full) => input.commit!({
      batchId: full.batchId,
      sourceCount: full.sourceCount,
      candidateCount: full.candidateCount,
      imageCount: full.imageCount,
      candidates: full.candidates,
    }) : undefined,
  });
  return {
    batchId: report.batchId,
    sourceCount: report.sourceCount,
    candidateCount: report.candidateCount,
    imageCount: report.imageCount,
    candidates: report.candidates,
  };
}
