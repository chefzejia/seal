import { escapeXml, injectHighlightYellow, xmlElements } from './xml.js';
import { validateImageBytes } from './zip.js';
import { CAPTION_HALF_POINTS } from './layout.js';

function addChild(xml: string, root: string, child: (prefix: string) => string): string {
  const close = new RegExp(`</((?:[A-Za-z_][\\w.-]*:)?${root})\\s*>`);
  const match = close.exec(xml);
  if (!match) throw new Error(`缺少 ${root} 根元素`);
  const prefix = match[1].includes(':') ? `${match[1].split(':')[0]}:` : '';
  return xml.slice(0, match.index) + child(prefix) + xml.slice(match.index);
}

function addDefault(xml: string, extension: string, mime: string): string {
  const has = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?Default\\b(?=[^>]*\\bExtension=["']${extension}["'])`, 'i').test(xml);
  return has ? xml : addChild(xml, 'Types', prefix => `<${prefix}Default Extension="${extension}" ContentType="${mime}"/>`);
}

export function imageParagraph(drawing: string, label = '', pending = false, seal?: { name: string; id: number }, captioned = false): string {
  const captionProperties = captioned ? `<w:rPr><w:sz w:val="${CAPTION_HALF_POINTS}"/><w:szCs w:val="${CAPTION_HALF_POINTS}"/></w:rPr>` : '';
  const labelProperties = pending ? injectHighlightYellow(captionProperties) : captionProperties;
  const labelRun = label ? `<w:r>${labelProperties}<w:t xml:space="preserve">${escapeXml(label)}</w:t></w:r>` : '';
  const contents = `${labelRun}<w:r>${captioned ? '<w:br/>' : ''}${drawing}</w:r>`;
  const marked = seal ? `<w:bookmarkStart w:id="${seal.id}" w:name="${seal.name}"/>${contents}<w:bookmarkEnd w:id="${seal.id}"/>` : contents;
  const pagination = '<w:keepNext w:val="0"/><w:keepLines/><w:pageBreakBefore w:val="0"/><w:snapToGrid w:val="0"/>';
  const indent = ['left', 'right', 'start', 'end', 'firstLine', 'hanging', 'leftChars', 'rightChars', 'startChars', 'endChars', 'firstLineChars', 'hangingChars'].map(name => ` w:${name}="0"`).join('');
  return `<w:p><w:pPr>${pagination}<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind${indent}/><w:jc w:val="left"/></w:pPr>${marked}</w:p>`;
}

export function captionedCellImage(paragraph: string, widthTwips: number): string {
  // Word can split paragraphs in table rows even with keepLines.
  // Constrain only the evidence row so the surrounding row can still flow.
  const noMargins = ['top', 'left', 'bottom', 'right'].map(edge => `<w:${edge} w:w="0" w:type="dxa"/>`).join('');
  const noBorders = ['top', 'left', 'bottom', 'right'].map(edge => `<w:${edge} w:val="nil"/>`).join('');
  return '<w:tbl>' +
    `<w:tblPr><w:tblW w:w="${widthTwips}" w:type="dxa"/><w:tblBorders>${noBorders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar>${noMargins}</w:tblCellMar></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="${widthTwips}"/></w:tblGrid>` +
    `<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${widthTwips}" w:type="dxa"/><w:tcMar>${noMargins}</w:tcMar></w:tcPr>${paragraph}</w:tc></w:tr></w:tbl>`;
}

const emptyCellParagraph = '<w:p><w:pPr><w:snapToGrid w:val="0"/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>';

export function startCellBlocks(content: string): string {
  const first = xmlElements(content).find(element => element.parent === null);
  return first?.name === 'w:tbl' ? emptyCellParagraph + content : content;
}

export function terminateCellBlocks(content: string): string {
  const last = xmlElements(content).filter(element => element.parent === null).at(-1);
  return last?.name === 'w:tbl' ? content + emptyCellParagraph : content;
}

/** Validate and register a PNG/JPEG, returning the drawing XML for insertion. */
export async function prepareImage(parts: Map<string, Uint8Array>, documentXml: string, bytes: Uint8Array): Promise<string> {
  const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpeg = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error('当前图片格式必须是可解码的 PNG 或 JPEG');
  const extension = isPng ? 'png' : 'jpg', mime = isPng ? 'image/png' : 'image/jpeg';
  const dimensions = await validateImageBytes(bytes, mime);
  const naturalWidth = dimensions.widthPx * 9525, naturalHeight = dimensions.heightPx * 9525;
  const width = naturalWidth, height = naturalHeight;
  let sequence = 1;
  while (parts.has(`word/media/seal-image-${sequence}.${extension}`)) sequence++;
  const filename = `seal-image-${sequence}.${extension}`;
  const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder();
  let types = decoder.decode(parts.get('[Content_Types].xml')!);
  types = addDefault(addDefault(types, extension, mime), 'rels', 'application/vnd.openxmlformats-package.relationships+xml');
  const relPath = 'word/_rels/document.xml.rels';
  let rels = parts.has(relPath) ? decoder.decode(parts.get(relPath)!) : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const used = new Set([...rels.matchAll(/\bId=["']([^"']+)["']/g)].map(match => match[1]));
  let relationNumber = 1;
  while (used.has(`rId${relationNumber}`)) relationNumber++;
  const relation = `rId${relationNumber}`;
  rels = addChild(rels, 'Relationships', prefix => `<${prefix}Relationship Id="${relation}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${filename}"/>`);
  const usedDrawingIds = [...documentXml.matchAll(/<wp:docPr\b[^>]*\bid=["'](\d+)["']/g)].map(match => Number(match[1]));
  const drawingId = Math.max(0, ...usedDrawingIds) + 1;
  parts.set('[Content_Types].xml', encoder.encode(types));
  parts.set(relPath, encoder.encode(rels));
  parts.set(`word/media/${filename}`, bytes.slice());
  return `<w:drawing xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${drawingId}" name="Seal image ${drawingId}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${filename}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relation}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}
