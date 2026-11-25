import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { containers, packageDocument, paragraph, paths, matrixDocument } from './fixtures/layout-matrix.js';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { readZip, sha256Hex } from '../src/core/docx/zip.js';
import { auditImageLayout } from '../src/core/docx/layout.js';
import { bodyViewNodes, type BodyViewNode } from '../src/core/docx/document-view.js';
import { editableText } from '../src/core/docx/visible-surgery.js';

const output = path.resolve(process.env.SEAL_LAYOUT_EVIDENCE ?? '.tmp/evidence/milestone-29/worker');
const inputs = path.join(output, 'inputs'), documents = path.join(output, 'documents'), renders = path.join(output, 'render');
for (const directory of [inputs, documents, renders]) await mkdir(directory, { recursive: true });
const command = (file: string, args: string[], env = process.env) => execFileSync(file, args, { encoding: 'utf8', env, timeout: 60_000 });
const xmlOf = async (bytes: Uint8Array) => new TextDecoder().decode((await readZip(bytes)).get('word/document.xml'));
const addressOf = async (bytes: Uint8Array, target: string) => {
  const flatten = (nodes: BodyViewNode[]): BodyViewNode[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
  const found = flatten(bodyViewNodes(await xmlOf(bytes))).filter(node => node.kind === 'paragraph' && editableText(node.xml) === target);
  assert.equal(found.length, 1, `unique insertion anchor ${target}`);
  return found[0].address;
};
const evidenceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1239" height="1827"><rect width="1239" height="1827" fill="#fcfcf3"/><rect x="12" y="12" width="1215" height="1803" fill="none" stroke="#a22" stroke-width="18"/><path d="M40 900H1200M620 40V1790" stroke="#456" stroke-width="5"/><g font-family="Arial" font-size="70" fill="#123"><text x="55" y="110">A</text><text x="1110" y="110">B</text><text x="55" y="1760">C</text><text x="1110" y="1760">D</text><text x="190" y="400">SEAL EVIDENCE</text><text x="190" y="520">1239 x 1827</text><text x="190" y="1200">ALL EDGES VISIBLE</text></g></svg>`;
const image = await sharp(Buffer.from(evidenceSvg)).png().toBuffer();
await writeFile(path.join(inputs, 'matrix-evidence.png'), image);
const combinations = path.join(output, 'combinations');
await mkdir(combinations, { recursive: true });
const combinationsManifest = [];
for (const item of containers) for (const insertion of paths) {
  const generated = await matrixDocument(item, insertion, image);
  const file = `${item.id}--${insertion}.docx`;
  await writeFile(path.join(combinations, file), generated.output);
  combinationsManifest.push({ container: item.id, path: insertion, file, availableWidthTwips: generated.width, sha256: sha256Hex(generated.output) });
}
await writeFile(path.join(output, 'combinations.json'), JSON.stringify(combinationsManifest, null, 2));
const margin = '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>';
const normalPage = '<w:pgSz w:w="12240" w:h="15840"/>';
const body = containers.map((item, index) => {
  const heading = paragraph(`${String(index + 1).padStart(2, '0')} / ${item.id} / ${item.label}`);
  const content = item.body.replace('定位', `TARGET_${item.id}`);
  const section = item.section ?? '';
  const end = index === containers.length - 1 ? '' : `<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/>${section.includes('w:pgSz') ? '' : normalPage}${section}${section.includes('w:cols') ? '' : '<w:cols w:num="1"/>'}${margin}</w:sectPr></w:pPr></w:p>`;
  return heading + content + end;
}).join('');
const styles = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Songti SC"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>';
let matrix = await packageDocument(body, normalPage, styles);
await writeFile(path.join(inputs, 'matrix.base.docx'), matrix);
const cases: Array<Record<string, unknown>> = [];
for (const item of containers) {
  let at = await addressOf(matrix, `TARGET_${item.id}`);
  if (item.generated) {
    matrix = await editTextDocument(matrix, [{ op: 'replace', at, find: `TARGET_${item.id}`, value: '表格锚点' }]);
    matrix = await editTextDocument(matrix, [{ op: 'insert', at, position: 'after', markdown: `| 证据 | 备注 |\n| --- | --- |\n| SEAL_CELL_${item.id} | 相邻备注完整 |` }]);
    at = await addressOf(matrix, `SEAL_CELL_${item.id}`);
  }
  const label = `持证方：合成矩阵企业 / ${item.id}`;
  const markdownPath = ['landscape', 'auto-grid'].includes(item.id);
  matrix = await editTextDocument(matrix, [markdownPath ? { op: 'insert', at, position: 'after', markdown: '![证据](matrix.png)', images: [image], imageCaptions: [label] } : { op: 'insert_image', at, image, captioned: true, imageLabel: label }]);
  const original = item.generated ? `SEAL_CELL_${item.id}` : `TARGET_${item.id}`;
  matrix = await editTextDocument(matrix, [{ op: 'replace', at, find: original, value: '证据位置' }]);
  cases.push({ id: item.id, label: item.label, path: markdownPath ? 'paragraph-markdown' : item.generated ? 'create-table-then-direct' : 'direct', widthTwips: item.width });
}
assert.deepEqual(auditImageLayout(await xmlOf(matrix), styles), []);
await writeFile(path.join(documents, 'layout-matrix.docx'), matrix);

if (process.env.SEAL_LAYOUT_REAL_BASE && process.env.SEAL_LAYOUT_REAL_IMAGE) {
  const copiedInput = path.join(inputs, 'golden-offer.base.docx'), copiedImage = path.join(inputs, 'real-cert.png');
  await copyFile(process.env.SEAL_LAYOUT_REAL_BASE, copiedInput);
  await copyFile(process.env.SEAL_LAYOUT_REAL_IMAGE, copiedImage);
  const base = await readFile(copiedInput), certificate = await readFile(copiedImage);
  const label = '持证方：合成配套方 [甲](乙) & 丙_厂';
  let staged = await editTextDocument(base, [{ op: 'insert', at: 'p:0', position: 'after', markdown: '| 证据 | 备注 |\n| --- | --- |\n|  | 相邻备注完整 |' }]);
  staged = await editTextDocument(staged, [{ op: 'insert_image', at: 't:0/r:1/c:0', image: certificate, captioned: true, imageLabel: label }]);
  const ordinary = await editTextDocument(base, [{ op: 'insert_image', at: 't:0/r:1/c:1/p:1', image: certificate, captioned: true, imageLabel: label }]);
  const marked = await editTextDocument(base, [{ op: 'mark_pending', at: 't:0/r:1/c:1', find: '小写：大写：', seal: { name: '_Seal_P_rendercross', id: 92001 } }]);
  const captioned = await editTextDocument(marked, [{ op: 'insert', at: 't:0/r:1/c:1/p:1', position: 'after', markdown: '![证书](real-cert.png)', images: [certificate], imageCaptions: [label] }]);
  for (const [name, bytes] of [['regression-staged-two-columns', staged], ['regression-ordinary-quote-long', ordinary], ['regression-caption-cross-tail', captioned]] as const) {
    const parts = await readZip(bytes), xml = await xmlOf(bytes), style = new TextDecoder().decode(parts.get('word/styles.xml') ?? new Uint8Array());
    assert.deepEqual(auditImageLayout(xml, style), []);
    await writeFile(path.join(documents, `${name}.docx`), bytes);
    cases.push({ id: name, baseSha256: sha256Hex(base), imageSha256: sha256Hex(certificate), originalSource: process.env.SEAL_LAYOUT_REAL_BASE });
  }
}
const fontConfig = path.join(output, 'fonts.conf');
await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/System/Library/Fonts</dir><dir>/System/Library/Fonts/Supplemental</dir><dir>/Library/Fonts</dir><cachedir>${output}/font-cache</cachedir><alias><family>sans-serif</family><prefer><family>STHeiti</family></prefer></alias><alias><family>serif</family><prefer><family>Songti SC</family><family>STHeiti</family></prefer></alias></fontconfig>`);
const renderResults = [];
for (const file of (await readdir(documents)).filter(file => file.endsWith('.docx'))) {
  const name = path.basename(file, '.docx'), directory = path.join(renders, name);
  await mkdir(directory, { recursive: true });
  for (const page of (await readdir(directory)).filter(name => /^page-\d+\.png$/.test(name))) await unlink(path.join(directory, page));
  command('/Applications/LibreOffice.app/Contents/MacOS/soffice', ['-env:UserInstallation=' + pathToFileURL(path.join(output, 'lo-profile')).href, '--headless', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', directory, path.join(documents, file)], { ...process.env, FONTCONFIG_FILE: fontConfig });
  const pdf = path.join(directory, `${name}.pdf`);
  command('pdftoppm', ['-r', '100', '-png', pdf, path.join(directory, 'page')]);
  const text = command('pdftotext', ['-layout', pdf, '-']);
  await writeFile(path.join(directory, 'text.txt'), text);
  const imageList = command('pdfimages', ['-list', pdf]);
  await writeFile(path.join(directory, 'images.txt'), imageList);
  const pages = (await readdir(directory)).filter(file => /^page-\d+\.png$/.test(file)).sort();
  renderResults.push({ name, pages, imageList, sha256: sha256Hex(await readFile(path.join(documents, file))) });
}
await writeFile(path.join(output, 'render-matrix.json'), JSON.stringify({ cases, renderResults }, null, 2));
console.log(JSON.stringify(renderResults.map(({ name, pages }) => ({ name, pages: pages.length }))));
