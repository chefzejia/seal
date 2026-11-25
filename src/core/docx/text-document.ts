import { resolveRelationshipTarget, validatePackageStructure } from './package-structure.js';
import { validatePackageImages } from './package-images.js';
import type { HostPort } from '../host.js';
import { applyTextBatch, applyTextBatchWithMeta, type AppliedTocEffect, type TextBatchEdit } from './text-batch.js';
import { ensureUpdateFieldsSetting, hasCustomPageNumbering, patchTocPageNumbers, resolveTocPageNumbers } from './toc.js';
import { writeZip } from './zip.js';
import { headingStyles, xmlAttributes } from './outline.js';
import { imageParagraph, prepareImage, startCellBlocks, terminateCellBlocks } from './image-insert.js';
import { layoutCaptionedImages, markdownBlocks, markdownImageTokens } from './markdown.js';
import { fitImageLayout, layoutBox } from './layout.js';
import { isCellEdgeBlock, resolveAddress } from './addresses.js';
import { extractFirstParagraphPr, sanitizeInsertedBodyParagraphPr, xmlElements } from './xml.js';
import { editableText, replaceVisibleRange } from './visible-surgery.js';
import { remapCopiedIdentities, reserveCopiedIdentities, type RowIdentities } from './row-copies.js';

export type DocumentEdit = Exclude<TextBatchEdit, { op: 'insert_prepared_image' | 'insert' }> |
  (Extract<TextBatchEdit, { op: 'insert' }> & { images?: Uint8Array[]; pendingImages?: boolean; imageSeals?: Array<{ name: string; id: number } | undefined>; imageCaptions?: Array<string | undefined>; markdownLiterals?: ReadonlyMap<string, string> }) |
  { op: 'insert_image'; at: string; image: Uint8Array; imageLabel?: string; captioned?: boolean; pending?: boolean; seal?: { name: string; id: number } };

export function pendingImageLabel(index?: number): string {
  return `（图片待核对${index === undefined ? '' : index + 1}）`;
}

/** Apply text operations in memory and return bytes + TOC metadata only after package structure validates. */
export async function editTextDocumentWithMeta(
  source: Uint8Array,
  edits: readonly DocumentEdit[],
  host: Pick<HostPort, 'validateImage' | 'extractDocxPageTexts'> = {},
  pendingFacts?: ReadonlySet<string>,
): Promise<{ bytes: Uint8Array; tocEffects: AppliedTocEffect[]; nonTocInsertedAddresses: Map<number, string[]> }> {
  const parts = await validatePackageStructure(source);
  const document = new TextDecoder('utf-8', { fatal: true }).decode(parts.get('word/document.xml')!);
  const styles = parts.get('word/styles.xml'), drawings: string[] = [], prepared: TextBatchEdit[] = [];
  const stylesXml = styles ? new TextDecoder('utf-8', { fatal: true }).decode(styles) : '';
  const headingMap = headingStyles(stylesXml);
  for (const edit of edits) {
    if (edit.op === 'insert_image') {
      const target = resolveAddress(document, edit.at);
      if (!['paragraph', 'table', 'cell'].includes(target.kind)) throw new Error('图片位置必须是段落、表格或空单元格');
      const position = target.kind === 'cell' ? target.start + 1 : target.end;
      const options = { caption: edit.imageLabel, stylesXml, paragraph: false };
      const drawing = await prepareImage(parts, document + drawings.join(''), edit.image);
      drawings.push(drawing);
      prepared.push({ op: 'insert_prepared_image', at: edit.at, drawing, imageLabel: edit.imageLabel, captioned: edit.captioned, pending: edit.pending, seal: edit.seal, widthTwips: layoutBox(document, position, options).width / 635 });
    } else if (edit.op === 'insert') {
      const parsed = markdownImageTokens(edit.markdown);
      if (parsed.images.length !== (edit.images?.length ?? 0)) throw new Error('Markdown 图片文件未完整提供');
      const anchor = resolveAddress(document, edit.at);
      const position = edit.position === 'before' ? anchor.start : anchor.end;
      let content = markdownBlocks(edit.markdown, { tokens: parsed.tokens, paragraphProperties: sanitizeInsertedBodyParagraphPr(extractFirstParagraphPr(anchor.xml)), headingStyles: headingMap, yellow: edit.yellow, widthTwips: layoutBox(document, position, { stylesXml, paragraph: false }).width / 635 }).xml;
      const preview = applyTextBatch(document, [{ op: 'insert', at: edit.at, position: edit.position, markdown: edit.markdown, compiledXml: content }]);
      const captioned = new Map<string, { paragraph: string; width: number; atomic: boolean }>();
      for (let index = 0; index < parsed.images.length; index++) {
        const { placeholder } = parsed.images[index];
        const seal = edit.imageSeals?.[index];
        const pendingImage = seal?.name.startsWith('_Seal_P_') ?? false;
        const pending = !!edit.yellow || pendingImage;
        const label = pendingImage || !seal && (edit.yellow || edit.pendingImages) ? pendingImageLabel(index) : '';
        const caption = edit.imageCaptions?.[index];
        const imagePosition = preview.indexOf(placeholder);
        if (imagePosition < 0 || preview.indexOf(placeholder, imagePosition + placeholder.length) >= 0) throw new Error('Markdown 图片位置不唯一');
        const imageOptions = { caption: label + (caption ?? ''), stylesXml, paragraph: false };
        const drawing = await prepareImage(parts, preview + drawings.join(''), edit.images![index]);
        drawings.push(drawing);
        const atomic = !!label || !!caption;
        captioned.set(placeholder, { paragraph: imageParagraph(drawing, label + (caption ?? ''), pending, seal, atomic), width: layoutBox(preview, imagePosition, imageOptions).width / 635, atomic });
      }
      content = layoutCaptionedImages(content, captioned, edit.at.includes('/c:'));
      if (edit.position === 'after' && isCellEdgeBlock(document, edit.at, 'last')) content = terminateCellBlocks(content);
      if (edit.position === 'before' && isCellEdgeBlock(document, edit.at, 'first')) content = startCellBlocks(content);
      if (edit.markdownLiterals?.size) {
        const text = editableText(content);
        const literals = [...edit.markdownLiterals].map(([token, value]) => {
          const start = text.indexOf(token);
          if (start < 0 || text.indexOf(token, start + token.length) >= 0) throw new Error('Markdown 事实引用必须位于可见文本中，且位置唯一');
          return { start, end: start + token.length, value };
        });
        for (const { start, end, value } of literals.sort((a, b) => b.start - a.start)) content = replaceVisibleRange(content, start, end, value);
      }
      prepared.push({ ...edit, compiledXml: content });
    } else {
      prepared.push(edit);
    }
  }
  let referenceIdentitiesReserved = false;
  const copyReference = (kind: 'comment' | 'footnote' | 'endnote', id: string, identities: RowIdentities): string => {
    const decoder = new TextDecoder('utf-8', { fatal: true }), type = `${kind}s`;
    const rels = decoder.decode(parts.get('word/_rels/document.xml.rels') ?? new Uint8Array());
    const relationship = xmlElements(rels).find(element => element.name.split(':').pop() === 'Relationship' && xmlAttributes(rels, element).get('Type')?.endsWith(`/${type}`));
    if (!relationship) throw new Error(`缺少 ${type} 关系，不能复制引用 ${id}`);
    const attributes = xmlAttributes(rels, relationship);
    if (attributes.get('TargetMode') === 'External') throw new Error(`不能复制外部 ${type} 引用`);
    const file = resolveRelationshipTarget('word/', attributes.get('Target') ?? '');
    const bytes = parts.get(file);
    if (!bytes) throw new Error(`缺少引用部件 ${file}`);
    const xml = decoder.decode(bytes), nodes = xmlElements(xml), root = nodes.findIndex(element => element.name === `w:${type}`);
    const records = nodes.filter(element => element.name === `w:${kind}` && element.parent === root);
    const record = records.find(element => xmlAttributes(xml, element).get('w:id') === id);
    if (root < 0 || !record) throw new Error(`引用记录不存在：${file}#${id}`);
    const ids = records.map(element => xmlAttributes(xml, element).get('w:id'));
    if (ids.some(value => value === undefined || !/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) || new Set(ids).size !== ids.length) throw new Error(`引用记录标识无效或重复：${file}`);
    const nextId = Math.max(0, ...ids.map(Number)) + 1;
    if (!Number.isSafeInteger(nextId)) throw new Error(`引用记录标识超出范围：${file}`);
    const next = String(nextId);
    if (!referenceIdentitiesReserved) {
      for (const [name, data] of parts) if (name.endsWith('.xml')) reserveCopiedIdentities(decoder.decode(data), identities);
      referenceIdentitiesReserved = true;
    }
    const clone = remapCopiedIdentities(xml.slice(record.start, record.end).replace(/\bw:id\s*=\s*(["'])[^"']+\1/, `w:id="${next}"`), identities);
    parts.set(file, new TextEncoder().encode(xml.slice(0, nodes[root].closeStart) + clone + xml.slice(nodes[root].closeStart)));
    return next;
  };
  const hasToc = prepared.some(edit => edit.op === 'insert_toc');
  const batchResult = applyTextBatchWithMeta(document, prepared, {
    headingStyles: headingMap,
    copyReference,
    pendingFacts,
    stylesXml,
    ...(hasToc && host.extractDocxPageTexts ? { tocPlaceholderPage: '1' } : {}),
  });
  let edited = fitImageLayout(batchResult.xml, stylesXml);
  if (hasToc) ensureUpdateFieldsSetting(parts);
  parts.set('word/document.xml', new TextEncoder().encode(edited));
  let result = await writeZip(parts);
  let output = await validatePackageStructure(result);
  let issues = await validatePackageImages(output, host);
  if (issues.length) throw new Error(`文件合法性检查失败：${issues.map(issue => `${issue.part}：${issue.reason}`).join('；')}；请修复图片或配置宿主解码器后重试`);

  if (hasToc && host.extractDocxPageTexts) {
    const pageMap = new Map<string, string>();
    if (!hasCustomPageNumbering(edited)) {
      const pageTexts = await host.extractDocxPageTexts(result);
      if (pageTexts.length > 0) {
        for (const effect of batchResult.tocEffects) {
          const resolved = resolveTocPageNumbers(
            effect.entries,
            pageTexts,
            effect.anchorTitle ? { anchorTitle: effect.anchorTitle } : undefined,
          );
          for (const [k, v] of resolved) pageMap.set(k, v);
        }
      }
    }
    edited = patchTocPageNumbers(edited, pageMap);
    parts.set('word/document.xml', new TextEncoder().encode(edited));
    result = await writeZip(parts);
    output = await validatePackageStructure(result);
    issues = await validatePackageImages(output, host);
    if (issues.length) throw new Error(`文件合法性检查失败：${issues.map(issue => `${issue.part}：${issue.reason}`).join('；')}；请修复图片或配置宿主解码器后重试`);
  }

  return {
    bytes: result,
    tocEffects: batchResult.tocEffects,
    nonTocInsertedAddresses: batchResult.nonTocInsertedAddresses,
  };
}

/** Apply text operations in memory and return bytes only after package structure validates. */
export async function editTextDocument(source: Uint8Array, edits: readonly DocumentEdit[], host: Pick<HostPort, 'validateImage' | 'extractDocxPageTexts'> = {}, pendingFacts?: ReadonlySet<string>): Promise<Uint8Array> {
  return (await editTextDocumentWithMeta(source, edits, host, pendingFacts)).bytes;
}
