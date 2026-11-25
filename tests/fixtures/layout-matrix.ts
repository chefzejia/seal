import { writeZip } from '../../src/core/docx/zip.js';
import { editTextDocument, type DocumentEdit } from '../../src/core/docx/text-document.js';

const enc = (text: string) => new TextEncoder().encode(text);
export const paragraph = (text = '') => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const cell = (text: string, properties = '') => `<w:tc><w:tcPr>${properties}</w:tcPr>${paragraph(text)}</w:tc>`;
const table = (grid: number[], properties = '', first = '', rowProperties = '') => `<w:tbl><w:tblPr>${properties}</w:tblPr>${grid.length ? `<w:tblGrid>${grid.map(width => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>` : ''}<w:tr><w:trPr>${rowProperties}</w:trPr>${cell('定位', first)}${cell('相邻备注完整')}</w:tr></w:tbl>`;
export const caption = '持证方：矩阵企业';
export const paths = ['direct', 'same-markdown', 'staged-table', 'paragraph-markdown'] as const;
export type MatrixPath = typeof paths[number];
export interface ContainerCase { id: string; label: string; body: string; section?: string; at: string; width: number; height?: number; generated?: boolean; }
export const containers: ContainerCase[] = [
  { id: 'body', label: '正文', body: paragraph('定位'), at: 'p:0', width: 9360 },
  { id: 'landscape', label: '横向分节', body: paragraph('定位'), section: '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>', at: 'p:0', width: 12960, height: 9360 },
  { id: 'columns', label: '双栏分节', body: paragraph('定位'), section: '<w:cols w:num="2" w:space="720"/>', at: 'p:0', width: 4320 },
  { id: 'dxa', label: 'dxa 宽度格', body: table([2000, 4000], '<w:tblW w:w="9000" w:type="dxa"/>', '<w:tcW w:w="5000" w:type="dxa"/>'), at: 't:0/r:0/c:0/p:0', width: 2760 },
  { id: 'pct', label: 'pct 宽度格', body: table([3000, 6000], '<w:tblW w:w="2500" w:type="pct"/>', '<w:tcW w:w="1000" w:type="pct"/>'), at: 't:0/r:0/c:0/p:0', width: 696 },
  { id: 'auto-grid', label: '带网格自动宽度表', body: table([3120, 6240], '<w:tblW w:w="0" w:type="auto"/>'), at: 't:0/r:0/c:0/p:0', width: 2880 },
  { id: 'no-grid', label: '缺网格两列表', body: table([]), at: 't:0/r:0/c:0/p:0', width: 4440 },
  { id: 'seal-table', label: 'Seal Markdown 表', body: paragraph('定位'), at: 't:0/r:1/c:0/p:0', width: 4440, generated: true },
  { id: 'merged', label: '横向合并与前置列', body: table([2000, 2500, 4500, 360], '', '<w:gridSpan w:val="2"/>', '<w:gridBefore w:val="1"/>'), at: 't:0/r:0/c:0/p:0', width: 6760 },
  { id: 'nested', label: '嵌套表内的格', body: `<w:tbl><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid><w:tr><w:tc>${paragraph('外层')}${table([2220, 2220])}${paragraph()}</w:tc>${cell('外侧备注完整')}</w:tr></w:tbl>`, at: 't:0/r:0/c:0/t:0/r:0/c:0/p:0', width: 1980 },
  { id: 'narrow', label: '窄格', body: table([900, 8460]), at: 't:0/r:0/c:0/p:0', width: 660 },
  { id: 'large-margins', label: '大边距格', body: table([4680, 4680], '', '<w:tcMar><w:left w:w="1200" w:type="dxa"/><w:right w:w="1000" w:type="dxa"/></w:tcMar>'), at: 't:0/r:0/c:0/p:0', width: 2480 },
];

export async function packageDocument(body: string, section = '', styles = ''): Promise<Uint8Array> {
  return writeZip(new Map([
    ['[Content_Types].xml', enc(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${styles ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' : ''}</Types>`)],
    ['_rels/.rels', enc('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')],
    ['word/document.xml', enc(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr>${section}<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`)],
    ...(styles ? [['word/styles.xml', enc(styles)] as [string, Uint8Array]] : []),
    ...(styles ? [['word/_rels/document.xml.rels', enc('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')] as [string, Uint8Array]] : []),
  ]));
}

export async function matrixDocument(item: ContainerCase, path: MatrixPath, image: Uint8Array, label: string | null = caption): Promise<{ base: Uint8Array; output: Uint8Array; width: number }> {
  let base = await packageDocument(item.body, item.section);
  if (item.generated) base = await editTextDocument(base, [{ op: 'insert', at: 'p:0', position: 'after', markdown: '| 证据 | 备注 |\n| --- | --- |\n| 定位 | 相邻备注完整 |' }]);
  let at = item.at;
  const options = { imageCaptions: [label ?? undefined] };
  let edit: DocumentEdit, width = item.width;
  if (path === 'same-markdown') {
    width = Math.floor(width / 2) - 240;
    edit = { op: 'insert', at, position: 'after', markdown: '| 证据 | 备注 |\n| --- | --- |\n| ![图](image.png) | 相邻备注完整 |', images: [image], ...options };
  } else if (path === 'staged-table') {
    base = await editTextDocument(base, [{ op: 'insert', at, position: 'after', markdown: '| 证据 | 备注 |\n| --- | --- |\n|  | 相邻备注完整 |' }]);
    at = at.includes('/c:') ? at.replace(/p:\d+$/, 't:0/r:1/c:0') : 't:0/r:1/c:0';
    width = Math.floor(width / 2) - 240;
    edit = { op: 'insert_image', at, image, imageLabel: label ?? undefined, captioned: !!label };
  } else if (path === 'paragraph-markdown') {
    edit = { op: 'insert', at, position: 'after', markdown: '![图](image.png)', images: [image], ...options };
  } else edit = { op: 'insert_image', at, image, imageLabel: label ?? undefined, captioned: !!label };
  return { base, output: await editTextDocument(base, [edit]), width };
}
