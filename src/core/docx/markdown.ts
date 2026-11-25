import { marked, type Token, type Tokens, type TokensList } from 'marked';
import { assertXmlCharacters, escapeXml, injectHighlightYellow, xmlElements } from './xml.js';
import { captionedCellImage, startCellBlocks, terminateCellBlocks } from './image-insert.js';
import { layoutBox } from './layout.js';

type InlineFlags = { bold?: boolean; italic?: boolean };

export interface MarkdownImageRef { href: string; placeholder: string; }

/** Parse images as Markdown tokens, so code blocks and literal punctuation are not mistaken for references. */
export function markdownImageTokens(markdown: string): { tokens: TokensList; images: MarkdownImageRef[] } {
  const tokens = marked.lexer(markdown), images: MarkdownImageRef[] = [];
  marked.walkTokens(tokens, token => {
    if (token.type !== 'image') return;
    const image = token as Tokens.Image;
    let placeholder = `SEAL_MD_IMAGE_${images.length}_END`;
    while (markdown.includes(placeholder)) placeholder += '_';
    images.push({ href: image.href, placeholder });
    Object.assign(token, { type: 'text', raw: placeholder, text: placeholder });
  });
  return { tokens, images };
}

export function layoutCaptionedImages(xml: string, images: ReadonlyMap<string, { paragraph: string; width: number; atomic?: boolean }>, insideCell = false): string {
  if (!images.size) return xml;
  const elements = xmlElements(xml);
  const children = new Map<number, number[]>();
  for (const [index, { parent }] of elements.entries()) {
    if (parent === null) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(index);
    children.set(parent, siblings);
  }
  const paragraphs: Array<{ start: number; end: number; value: string }> = [];
  for (const [index, element] of elements.entries()) {
    if (element.name !== 'w:p') continue;
    const inCell = insideCell || element.parent !== null && elements[element.parent].name === 'w:tc';
    const nodes = children.get(index) ?? [];
    const properties = nodes.map(item => elements[item]).find(child => child.name === 'w:pPr');
    const start = properties?.end ?? element.openEnd;
    let cursor = start, output = '';
    const textParagraph = (end: number): string => cursor < end
      ? xml.slice(element.start, start) + xml.slice(cursor, end) + xml.slice(element.closeStart, element.end)
      : '';
    for (const runIndex of nodes) {
      const run = elements[runIndex];
      if (run.name !== 'w:r') continue;
      const text = children.get(runIndex)?.map(item => elements[item]).find(child => child.name === 'w:t');
      const picture = text && images.get(xml.slice(text.openEnd, text.closeStart));
      if (picture === undefined) continue;
      output += textParagraph(run.start) + (inCell && picture.atomic !== false ? captionedCellImage(picture.paragraph, picture.width) : picture.paragraph);
      cursor = run.end;
    }
    if (cursor !== start) {
      output += textParagraph(element.closeStart);
      const parent = element.parent;
      if (parent !== null && elements[parent].name === 'w:tc') {
        const blocks = children.get(parent)?.filter(child => elements[child].name !== 'w:tcPr');
        if (blocks?.[0] === index) output = startCellBlocks(output);
        if (blocks?.at(-1) === index) output = terminateCellBlocks(output);
      }
      paragraphs.push({ start: element.start, end: element.end, value: output });
    }
  }
  return paragraphs.reverse().reduce((output, item) => output.slice(0, item.start) + item.value + output.slice(item.end), xml);
}

function runs(tokens: readonly Token[], flags: InlineFlags = {}): string {
  return tokens.map(token => {
    if (token.type === 'strong') return runs((token as Tokens.Strong).tokens, { ...flags, bold: true });
    if (token.type === 'em') return runs((token as Tokens.Em).tokens, { ...flags, italic: true });
    if (token.type === 'link') return runs((token as Tokens.Link).tokens, flags);
    if (token.type === 'image') throw new Error('Markdown 图片必须通过图片插入能力处理');
    if (token.type === 'br') return '<w:r><w:br/></w:r>';
    if (token.type === 'html') throw new Error('Markdown 内不支持原始 HTML');
    const text = 'text' in token && typeof token.text === 'string' ? token.text : token.raw;
    const properties = flags.bold || flags.italic ? `<w:rPr>${flags.bold ? '<w:b/>' : ''}${flags.italic ? '<w:i/>' : ''}</w:rPr>` : '';
    return `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  }).join('');
}

function paragraph(content: string, properties = ''): string { return `<w:p>${properties}${content}</w:p>`; }

export function markdownBlocks(markdown: string, options: { paragraphProperties?: string; headingStyles?: ReadonlyMap<number, string>; yellow?: boolean; tokens?: TokensList; widthTwips?: number } = {}): { xml: string; missingHeadings: number[] } {
  assertXmlCharacters(markdown);
  const missing = new Set<number>(), normal = options.paragraphProperties ?? '';
  const render = (tokens: readonly Token[]): string => tokens.map(token => {
    if (token.type === 'space') return '';
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading;
      const style = options.headingStyles?.get(heading.depth);
      if (!style) missing.add(heading.depth);
      const properties = style ? `<w:pPr><w:pStyle w:val="${escapeXml(style)}"/></w:pPr>` : '';
      return paragraph(runs(heading.tokens, { bold: !style }), properties);
    }
    if (token.type === 'paragraph' || token.type === 'text') {
      const inline = 'tokens' in token && Array.isArray(token.tokens) ? token.tokens : marked.lexer(token.raw)[0]?.type === 'paragraph' ? (marked.lexer(token.raw)[0] as Tokens.Paragraph).tokens : [];
      return paragraph(runs(inline), normal);
    }
    if (token.type === 'list') return (token as Tokens.List).items.map((item, index) => {
      const list = token as Tokens.List;
      const prefix = list.ordered ? `${Number(list.start) + index}. ` : '• ';
      const first = item.tokens[0];
      const inline = first && 'tokens' in first && Array.isArray(first.tokens) ? first.tokens : [];
      return paragraph(`<w:r><w:t xml:space="preserve">${escapeXml(prefix)}</w:t></w:r>${runs(inline)}`, normal) + render(item.tokens.slice(1));
    }).join('');
    if (token.type === 'blockquote') return render((token as Tokens.Blockquote).tokens);
    if (token.type === 'table') {
      const table = token as Tokens.Table;
      const width = Math.max(1, Math.floor(options.widthTwips ?? layoutBox('<w:document><w:body/></w:document>', 0).width / 635));
      const widths = table.header.map((_, index) => Math.floor(width * (index + 1) / table.header.length) - Math.floor(width * index / table.header.length));
      const row = (cells: readonly Tokens.TableCell[]) => `<w:tr>${cells.map((cell, index) => `<w:tc><w:tcPr><w:tcW w:w="${widths[index]}" w:type="dxa"/></w:tcPr>${paragraph(runs(cell.tokens))}</w:tc>`).join('')}</w:tr>`;
      return `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map(value => `<w:gridCol w:w="${value}"/>`).join('')}</w:tblGrid>${row(table.header)}${table.rows.map(row).join('')}</w:tbl>`;
    }
    if (token.type === 'code') return paragraph(`<w:r><w:t xml:space="preserve">${escapeXml(token.text)}</w:t></w:r>`, normal);
    if (token.type === 'html' && /^<!--\s*pagebreak\s*-->$/i.test(token.raw.trim())) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    if (token.type === 'hr') return paragraph('<w:r><w:t>---</w:t></w:r>', normal);
    throw new Error(`不支持的 Markdown 内容：${token.type}`);
  }).join('');
  let xml = render(options.tokens ?? marked.lexer(markdown));
  if (options.yellow) {
    const elements = xmlElements(xml);
    const replacements = elements.flatMap((element, index) => {
      if (element.name !== 'w:r') return [];
      const properties = elements.find(candidate => candidate.parent === index && candidate.name === 'w:rPr');
      return properties
        ? [{ start: properties.start, end: properties.end, value: injectHighlightYellow(xml.slice(properties.start, properties.end)) }]
        : [{ start: element.openEnd, end: element.openEnd, value: injectHighlightYellow('') }];
    }).sort((a, b) => b.start - a.start);
    xml = replacements.reduce((result, item) => result.slice(0, item.start) + item.value + result.slice(item.end), xml);
  }
  return { xml, missingHeadings: [...missing].sort((a, b) => a - b) };
}
