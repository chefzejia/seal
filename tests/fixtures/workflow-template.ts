import { writeZip } from '../../src/core/docx/index.js';
export async function workflowTemplate(master = false) {
  const paragraph = (text: string, outline = false) => `<w:p><w:pPr>${outline ? '<w:outlineLvl w:val="0"/>' : ''}<w:spacing w:after="180"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Noto Sans CJK SC"/><w:sz w:val="24"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  const body = master ? paragraph('历史服务方案', true) + paragraph('建立项目资料台账，按责任分工开展实施与复核。') : paragraph('外部招标要求，应提取后面的格式章节') + paragraph('第九章 投标文件格式', true) + paragraph('投标人名称：________') + paragraph('报价：________') + paragraph('实施方案（格式自拟）') + paragraph('营业执照（格式自拟）') + paragraph('固定责任条款：资料按真实原件提供，禁止篡改。');
  const entries = new Map<string, Uint8Array>(); const add = (name:string, text:string) => entries.set(name,new TextEncoder().encode(text));
  add('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  add('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  add('word/_rels/document.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  add('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  return writeZip(entries);
}
