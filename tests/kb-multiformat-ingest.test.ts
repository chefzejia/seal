import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { NodeHostPort, findSofficeBinary } from '../src/shells/node-host.js';
import {
  KnowledgeBase,
  parseDelimitedRows,
  parseEntry,
  parseXlsxSheets,
  rowsToMarkdownTable,
} from '../src/core/kb/index.js';
import { readZip, writeZip } from '../src/core/docx/zip.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import { runKnowledgeBase } from '../src/shells/cli/kb.js';
import { runProject } from '../src/shells/cli/project-v2.js';
import { WorkbenchHost } from '../src/shells/dsh/workbench-host.js';
import { workflowTemplate } from './fixtures/workflow-template.js';

const encoder = new TextEncoder();

function buildPdfFromObjects(objects: string[]): Uint8Array {
  const chunks: Uint8Array[] = [encoder.encode('%PDF-1.4\n')];
  const offsets: number[] = [0];
  let byteLength = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLength);
    const part = encoder.encode(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    chunks.push(part);
    byteLength += part.length;
  }
  const xrefStart = byteLength;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(encoder.encode(xrefLines.join('') + trailer));
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** Build a pure image-only PDF with zero text operators (simulates a scanned certificate). */
function buildScannedPdf(pageCount = 1): Uint8Array {
  // 1=Catalog, 2=Pages, 3=Image XObject, then pairs of (Page, Content)
  const objects: string[] = ['', ''];
  // Solid 4x4 RGB image (blue/gold seal block)
  const pixels: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      pixels.push(x === 0 || y === 0 ? 0x26 : 0xd4, x === 0 || y === 0 ? 0x47 : 0x88, 0x66);
    }
  }
  const rawHex = Buffer.from(pixels).toString('hex') + '>';
  objects.push(
    `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${rawHex.length} >>\nstream\n${rawHex}\nendstream`,
  );
  const kidRefs: string[] = [];
  for (let p = 0; p < pageCount; p++) {
    const pageObj = objects.length + 1;
    const contentObj = pageObj + 1;
    kidRefs.push(`${pageObj} 0 R`);
    const contentStream = 'q\n360 0 0 480 100 180 cm\n/Im0 Do\nQ\n';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 3 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    objects.push(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kidRefs.join(' ')}] /Count ${pageCount} >>`;
  return buildPdfFromObjects(objects);
}

/** Build a multi-page text PDF (122 pages etc.) cleanly and fast. */
function buildTextPdf(pages: string[]): Uint8Array {
  const objects: string[] = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kidRefs: string[] = [];
  for (const line of pages) {
    const pageObj = objects.length + 1;
    const contentObj = pageObj + 1;
    kidRefs.push(`${pageObj} 0 R`);
    const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = `BT\n/F1 14 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${kidRefs.join(' ')}] /Count ${pages.length} >>`;
  return buildPdfFromObjects(objects);
}

async function buildXlsxBytes(
  sheets: Array<{ name: string; sheetXml: string }>,
  sharedStringsXml?: string,
  options?: { stylesXml?: string; date1904?: boolean },
): Promise<Uint8Array> {
  const files = new Map<string, Uint8Array>();
  files.set(
    '[Content_Types].xml',
    encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        (sharedStringsXml ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : '') +
        (options?.stylesXml ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' : '') +
        '</Types>',
    ),
  );
  files.set(
    '_rels/.rels',
    encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
  );
  files.set(
    'xl/workbook.xml',
    encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        (options?.date1904 ? '<workbookPr date1904="1"/>' : '') +
        '<sheets>' +
        sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    ),
  );
  let nextRelId = sheets.length + 1;
  const extraRels: string[] = [];
  if (sharedStringsXml) {
    extraRels.push(
      `<Relationship Id="rId${nextRelId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
    );
  }
  if (options?.stylesXml) {
    extraRels.push(
      `<Relationship Id="rId${nextRelId++}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    );
  }
  files.set(
    'xl/_rels/workbook.xml.rels',
    encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        extraRels.join('') +
        '</Relationships>',
    ),
  );
  if (sharedStringsXml) files.set('xl/sharedStrings.xml', encoder.encode(sharedStringsXml));
  if (options?.stylesXml) files.set('xl/styles.xml', encoder.encode(options.stylesXml));
  for (const [i, sheet] of sheets.entries()) {
    files.set(`xl/worksheets/sheet${i + 1}.xml`, encoder.encode(sheet.sheetXml));
  }
  return writeZip(files);
}

test('pure core xlsx, csv, tsv, and markdown table parsers handle sharedStrings, inlineStr, sparse columns, and quotes', async () => {
  const sharedStrings =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<si><t>项目名称</t></si>' +
    '<si><r><t>金额</t></r><r><t>(元)</t></r><rPh sb="0" eb="2"><t>ignored</t></rPh></si>' +
    '<si><t>合成项目A</t></si>' +
    '</sst>';
  const sheet1 =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>状态</t></is></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="str"><v>A|B</v></c><c r="C2"><v>12345.67</v></c><c r="D2" t="b"><v>1</v></c></row>' +
    '<row r="3"><c r="AA3" t="inlineStr"><is><t>远端列</t></is></c></row>' +
    '</sheetData></worksheet>';
  const sheet2 =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>   </t></is></c></row>' +
    '</sheetData></worksheet>';
  const xlsx = await buildXlsxBytes(
    [
      { name: '业绩汇总', sheetXml: sheet1 },
      { name: '空白表', sheetXml: sheet2 },
    ],
    sharedStrings,
  );
  const parsed = await parseXlsxSheets(xlsx);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, '业绩汇总');
  assert.deepEqual(parsed[0].rows[0], { rowNumber: 1, cells: ['项目名称', '', '金额(元)', '状态'] });
  assert.deepEqual(parsed[0].rows[1], { rowNumber: 2, cells: ['合成项目A', 'A|B', '12345.67', 'TRUE'] });
  assert.equal(parsed[0].rows[2].rowNumber, 3);
  assert.equal(parsed[0].rows[2].cells.length, 27);
  assert.equal(parsed[0].rows[2].cells[26], '远端列');

  const csvRows = parseDelimitedRows('\uFEFF"名称","说明"\r\n"甲""公司","第一行\n第二行|竖线"\r\n"乙公司",100\n', ',');
  assert.deepEqual(csvRows, [
    ['名称', '说明'],
    ['甲"公司', '第一行\n第二行|竖线'],
    ['乙公司', '100'],
  ]);
  const md = rowsToMarkdownTable(csvRows);
  assert.match(md, /\| 甲"公司 \| 第一行<br>第二行\\\|竖线 \|/);

  const tsvRows = parseDelimitedRows('A\tB\n1\t2\n', '\t');
  assert.deepEqual(tsvRows, [['A', 'B'], ['1', '2']]);
});

test('PDF extraction and ingest handle text PDFs, pure scan PDFs, and maxPages truncation', async (t) => {
  const sandbox = path.resolve('.tmp', `kb-pdf-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  await fs.mkdir(sandbox, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const textPdf = path.join(sandbox, 'text-2p.pdf');
  const scanPdf = path.join(sandbox, 'scan-1p.pdf');
  const longPdf = path.join(sandbox, 'long-122p.pdf');
  const corruptPdf = path.join(sandbox, 'corrupt.pdf');

  await fs.writeFile(textPdf, buildTextPdf(['Page 1 Synthetic License 91110000000000000X', 'Page 2 Details']));
  await fs.writeFile(scanPdf, buildScannedPdf(1));
  await fs.writeFile(
    longPdf,
    buildTextPdf(Array.from({ length: 122 }, (_, i) => `Synthetic line ${i + 1}`)),
  );
  await fs.writeFile(corruptPdf, encoder.encode('not-a-pdf-file'));

  await assert.rejects(
    host.extractPdf(corruptPdf, path.join(sandbox, 'corrupt-out')),
    /无法解析 PDF/,
  );

  // Verify default maxPages=120 truncation on a real 122-page PDF
  const longOut = path.join(sandbox, 'long-out');
  const longExtracted = await host.extractPdf(longPdf, longOut);
  assert.equal(longExtracted.pageCount, 122);
  assert.equal(longExtracted.renderedPages, 120);
  assert.equal(longExtracted.truncatedPages, 2);
  assert.equal(longExtracted.pages.filter((p) => p.imagePath).length, 120);
  assert.equal(longExtracted.pages[120].imagePath, undefined);
  assert.match(longExtracted.pages[121].text, /Synthetic line 122/);

  // Ingest text PDF + scanned PDF + truncated PDF (via maxPages=2 override on 5-page PDF too)
  await runKnowledgeBase(host, ['init', '--vault', 'pdf-vault', '--name', 'PDF 资料柜']);
  const kb = new KnowledgeBase(host, path.join(process.env.SEAL_HOME!, 'vaults'));

  const fivePagePdf = path.join(sandbox, 'five.pdf');
  await fs.writeFile(fivePagePdf, buildTextPdf(['P1', 'P2', 'P3', 'P4', 'P5']));
  const truncatedHost = new (class extends NodeHostPort {
    override extractPdf(inputPath: string, outDir: string) {
      return super.extractPdf(inputPath, outDir, { maxPages: 2 });
    }
  })();
  const truncatedKb = new KnowledgeBase(truncatedHost, path.join(process.env.SEAL_HOME!, 'vaults'));
  const truncatedReport = await truncatedKb.ingestMaterials(
    'pdf-vault',
    [{ kind: 'pdf', sourcePath: fivePagePdf }],
    path.join(sandbox, 'stage-trunc'),
  );
  assert.equal(truncatedReport.candidateCount, 1);
  const truncCand = await kb.getCandidate('pdf-vault', truncatedReport.candidates[0].id);
  assert.equal(truncCand.fields.sourceType, 'pdf');
  assert.equal(truncCand.fields.truncatedPages, '3');
  assert.equal(truncCand.fields.renderedPages, '2');
  assert.match(truncCand.body, /truncatedPages=3/);
  assert.match(truncCand.body, /超出安全渲染页数上限 2 页/);

  const res = (await runKnowledgeBase(host, [
    'ingest',
    '--vault',
    'pdf-vault',
    '--files',
    JSON.stringify([textPdf, scanPdf]),
  ])) as { batchId: string; candidates: Array<{ id: string; sourceType: string }>; imageCount: number };
  assert.equal(res.imageCount, 3);
  assert.equal(res.candidates.length, 2);
  assert.ok(res.candidates.every((c) => c.sourceType === 'pdf'));

  const entries = await Promise.all(
    res.candidates.map((c) => kb.getCandidate('pdf-vault', c.id)),
  );
  const textEntry = entries.find((e) => e.fields.source === 'text-2p.pdf')!;
  const scanEntry = entries.find((e) => e.fields.source === 'scan-1p.pdf')!;
  assert.equal(textEntry.fields.location, '第 1-2 页 / 共 2 页');
  assert.match(textEntry.body, /Synthetic License 91110000000000000X/);
  assert.equal((textEntry.fields.imageFiles as string[]).length, 2);
  assert.ok((textEntry.fields.files as string[]).some((f) => f.endsWith('.pdf')));

  assert.equal(scanEntry.fields.location, '第 1 页 / 共 1 页');
  assert.match(scanEntry.body, /本页无文本层，疑似扫描件，请查看对应图片提取关键信息/);
  const scanPngRel = (scanEntry.fields.imageFiles as string[])[0];
  const scanPngBytes = await fs.readFile(path.join(kb.vaultRoot('pdf-vault'), scanPngRel));
  const meta = await sharp(scanPngBytes).metadata();
  assert.equal(meta.format, 'png');
  assert.ok((meta.width ?? 0) > 0 && (meta.height ?? 0) > 0);
});

test('E2E pipeline: PDF -> PNG in KB record -> Owner verify -> Word draft table mount -> C16=0 -> Finalize export', async (t) => {
  const sandbox = path.resolve('.tmp', `kb-pdf-e2e-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  await fs.mkdir(sandbox, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const scanPdf = path.join(sandbox, 'cert-scan.pdf');
  await fs.writeFile(scanPdf, buildScannedPdf(1));
  const tenderPath = path.join(sandbox, 'tender.docx');
  await fs.writeFile(tenderPath, await workflowTemplate());

  const kb = new KnowledgeBase(host, path.join(process.env.SEAL_HOME!, 'vaults'));
  await kb.createVault({ vaultId: 'e2e-vault', name: '端到端PDF柜' });
  const ingested = (await runKnowledgeBase(host, [
    'ingest',
    '--vault',
    'e2e-vault',
    '--files',
    JSON.stringify([scanPdf]),
  ])) as { batchId: string; candidates: Array<{ id: string }> };
  const cand = await kb.getCandidate('e2e-vault', ingested.candidates[0].id);
  const pngRel = (cand.fields.imageFiles as string[])[0];
  assert.ok(pngRel.endsWith('.png'));

  // Agent classifies into subject & record referencing stored PNG relative path and dismisses candidate
  await kb.save('e2e-vault', {
    action: 'update',
    kind: 'subject',
    fields: { legalName: '合成端到端企业' },
  });
  const record = await kb.save('e2e-vault', {
    action: 'create',
    kind: 'record',
    fields: {
      type: '营业执照',
      title: '合成营业执照扫描件',
      number: 'E2E-001',
      holder: '合成端到端企业',
      validUntil: '长期',
      files: [pngRel],
    },
    body: '从扫描件 PDF 拆包提取。',
  });
  await kb.save('e2e-vault', { action: 'dismiss_candidate', kind: 'material', id: cand.id });
  assert.deepEqual(await kb.listPendingBatches('e2e-vault'), []);

  // Owner verifies subject and record
  await kb.verify('e2e-vault', 'subject', 'subject', ['legalName']);
  await kb.verify('e2e-vault', 'record', record.id);

  // Create WorkbenchHost project, extract draft, insert table and mount PDF PNG into cell, check C16=0 & finalize
  const wb = new WorkbenchHost(host);
  const wbCreated = (await wb.create({
    name: 'WB端到端',
    deadline: '2028-02-29',
    vaultId: 'e2e-vault',
    files: [tenderPath],
  })) as { id: string; root: string };
  await runProject(host, [
    'extract',
    '--project',
    wbCreated.root,
    '--tender',
    'tender/1.docx',
    '--draft',
    '商务分册',
    '--ranges',
    JSON.stringify([{ from: 'p:1', to: 'p:6' }]),
  ]);
  const kbImageRef = `kb:${record.id}/${pngRel}`;
  await runProject(host, [
    'edit',
    '--project',
    wbCreated.root,
    '--draft',
    '商务分册',
    '--ops',
    JSON.stringify([
      { op: 'replace', at: 'p:1', find: '投标人名称：________', value: '投标人名称：{{subject.legalName}}' },
      { op: 'replace', at: 'p:2', find: '报价：________', value: '报价：100000元', pending: { category: '报价', note: '合成报价' } },
      { op: 'dismiss_hint', at: 'p:3', blank: 0, reason: '纯证照闭环测试跳过方案自拟提示' },
      { op: 'dismiss_hint', at: 'p:4', blank: 0, reason: '下附表格已挂载营业执照扫描件' },
      {
        op: 'insert',
        at: 'p:4',
        position: 'after',
        markdown: `| 证照名称 | 证照扫描件 |\n| --- | --- |\n| {{record:${record.id}.title}} | ![营业执照](<${kbImageRef}>) |`,
      },
    ]),
  ]);

  const checkReport = (await runProject(host, ['check', '--project', wbCreated.root, '--draft', '商务分册', '--json'])) as {
    blockingCounts: Record<string, number>;
    results: { C16: unknown[] };
  };
  assert.deepEqual(checkReport.results.C16, []);
  assert.equal(checkReport.blockingCounts.C16, 0);
  assert.equal(checkReport.blockingCounts.C08, 0);

  const rev = (await wb.review({ projectId: wbCreated.id })) as any;
  const confirmKeys = Object.values(rev.groups)
    .flatMap((g: any) => g.items)
    .filter((item: any) => item.actions.includes('confirm'))
    .map((item: any) => item.key);
  if (confirmKeys.length) {
    await wb.act({ projectId: wbCreated.id, revision: rev.revision, action: 'confirm', keys: confirmKeys });
  }
  const rev2 = (await wb.review({ projectId: wbCreated.id })) as any;
  const reviewKeys = Object.values(rev2.groups)
    .flatMap((g: any) => g.items)
    .filter((item: any) => item.actions.includes('review'))
    .map((item: any) => item.key);
  if (reviewKeys.length) {
    await wb.act({ projectId: wbCreated.id, revision: rev2.revision, action: 'review', keys: reviewKeys });
  }
  const revReady = (await wb.review({ projectId: wbCreated.id })) as any;
  assert.equal(revReady.ready, true, JSON.stringify(revReady.blockingCounts));
  assert.equal(revReady.blockingCounts.C05, 0);
  assert.equal(revReady.blockingCounts.C16, 0);

  await wb.finalize({ projectId: wbCreated.id, revision: revReady.revision });
  const finalBytes = await fs.readFile(path.join(wbCreated.root, 'final/商务分册.docx'));
  const finalZip = await readZip(finalBytes);
  const mediaEntries = [...finalZip.keys()].filter((name) => name.startsWith('word/media/'));
  assert.equal(mediaEntries.length, 1);
  const finalPng = finalZip.get(mediaEntries[0])!;
  assert.equal((await sharp(finalPng).metadata()).format, 'png');
  const finalXml = new TextDecoder().decode(finalZip.get('word/document.xml')!);
  assert.equal(sealRanges(finalXml).filter((r) => r.name.startsWith('_Seal_')).length, 0);
  assert.doesNotMatch(finalXml, /<w:r>(?:<w:rPr>(?:(?!<\/w:r>).)*<w:highlight w:val="yellow"[^>]*>(?:(?!<\/w:r>).)*<\/w:rPr>)?<\/w:r>/);
});

test('loose images (PNG/JPG/WebP->PNG) and corrupted image batch rollback', async (t) => {
  const sandbox = path.resolve('.tmp', `kb-img-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  await fs.mkdir(sandbox, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  await runKnowledgeBase(host, ['init', '--vault', 'img-vault', '--name', '散装图片柜']);
  const kb = new KnowledgeBase(host, path.join(process.env.SEAL_HOME!, 'vaults'));

  const pngPath = path.join(sandbox, 'sample.png');
  const jpgPath = path.join(sandbox, 'sample.jpg');
  const webpPath = path.join(sandbox, 'sample.webp');
  await fs.copyFile('tests/fixtures/evidence-2x1.png', pngPath);
  await fs.copyFile('tests/fixtures/evidence-2x1.jpeg', jpgPath);
  const webpBytes = await sharp('tests/fixtures/evidence-2x1.png').webp().toBuffer();
  await fs.writeFile(webpPath, webpBytes);

  const ok = (await runKnowledgeBase(host, [
    'ingest',
    '--vault',
    'img-vault',
    '--files',
    JSON.stringify([pngPath, jpgPath, webpPath]),
  ])) as { batchId: string; candidates: Array<{ id: string; sourceType: string }>; imageCount: number };
  assert.equal(ok.imageCount, 3);
  assert.equal(ok.candidates.length, 3);
  assert.ok(ok.candidates.every((c) => c.sourceType === 'image'));

  const entries = await Promise.all(ok.candidates.map((c) => kb.getCandidate('img-vault', c.id)));
  const webpCandidate = entries.find((e) => e.fields.source === 'sample.webp')!;
  const convertedRel = (webpCandidate.fields.imageFiles as string[])[0];
  assert.match(convertedRel, /\.png$/);
  assert.deepEqual(webpCandidate.fields.files, [convertedRel]);
  assert.match(webpCandidate.body, /请结合图像内容提取主体\/证照\/有效期\/编号等结构化字段/);
  const convertedMeta = await sharp(
    await fs.readFile(path.join(kb.vaultRoot('img-vault'), convertedRel)),
  ).metadata();
  assert.equal(convertedMeta.format, 'png');

  // Corrupted image alongside valid PNG must roll back entire batch atomically
  const corruptWebp = path.join(sandbox, 'broken.webp');
  await fs.writeFile(corruptWebp, webpBytes.subarray(0, 12));
  const vaultRoot = kb.vaultRoot('img-vault');
  const logBefore = await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8');
  await assert.rejects(
    runKnowledgeBase(host, ['ingest', '--vault', 'img-vault', '--files', JSON.stringify([pngPath, corruptWebp])]),
  );
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'inbox')), [ok.batchId]);
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'files')), [ok.batchId]);
  assert.equal(await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8'), logBefore);
});

test('spreadsheets (XLSX/CSV/TSV/ODS) and text (TXT/MD) ingest plus invalid UTF-8 rollback', async (t) => {
  const sandbox = path.resolve('.tmp', `kb-sheet-txt-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  await fs.mkdir(sandbox, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  await runKnowledgeBase(host, ['init', '--vault', 'sheet-vault', '--name', '表格文本柜']);
  const kb = new KnowledgeBase(host, path.join(process.env.SEAL_HOME!, 'vaults'));

  // Large 205-row XLSX -> splits into 200 + 5 rows
  const rowsXml = Array.from({ length: 205 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>行${i + 1}</t></is></c></row>`).join('');
  const xlsxPath = path.join(sandbox, 'large.xlsx');
  await fs.writeFile(
    xlsxPath,
    await buildXlsxBytes([
      {
        name: '明细',
        sheetXml: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
      },
    ]),
  );

  // Convert XLSX to ODS via LibreOffice to also verify convertSpreadsheetToXlsx on real ODS
  const odsOutDir = path.join(sandbox, 'ods-src');
  await fs.mkdir(odsOutDir, { recursive: true });
  execFileSync(findSofficeBinary(), ['--headless', '--convert-to', 'ods', '--outdir', odsOutDir, xlsxPath], {
    stdio: 'pipe',
    timeout: 60000,
  });
  const odsPath = path.join(odsOutDir, 'large.ods');

  const csvPath = path.join(sandbox, 'contracts.csv');
  await fs.writeFile(csvPath, '项目,金额\n"甲方""合同","100万元"\n', 'utf8');
  const tsvPath = path.join(sandbox, 'items.tsv');
  await fs.writeFile(tsvPath, '编号\t名称\nT1\t设备\n', 'utf8');
  const txtPath = path.join(sandbox, 'long-intro.txt');
  await fs.writeFile(txtPath, 'A'.repeat(23999) + '😀' + '公司简介😀'.repeat(500), 'utf8'); // >24,000 with surrogate pair right at boundary 23999..24001
  const mdPath = path.join(sandbox, 'note.md');
  await fs.writeFile(mdPath, '# 工艺说明\n内容完整。', 'utf8');

  const res = (await runKnowledgeBase(host, [
    'ingest',
    '--vault',
    'sheet-vault',
    '--files',
    JSON.stringify([xlsxPath, odsPath, csvPath, tsvPath, txtPath, mdPath]),
    '--limit',
    '50',
  ])) as { batchId: string; candidates: Array<{ id: string; sourceType: string }> };
  assert.equal(res.candidates.length, 9); // 2 (xlsx) + 2 (ods) + 1 (csv) + 1 (tsv) + 2 (txt) + 1 (md)
  const txtEntries = [];
  for (const c of res.candidates) {
    const entry = await kb.getCandidate('sheet-vault', c.id);
    if (entry.fields.source === 'long-intro.txt') txtEntries.push(entry);
  }
  assert.equal(txtEntries.length, 2);
  // Ensure surrogate pair was not split
  for (const entry of txtEntries) {
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(entry.body));
  }

  // Invalid UTF-8 file rolls back entire batch
  const badTxt = path.join(sandbox, 'invalid-utf8.txt');
  await fs.writeFile(badTxt, Buffer.from([0xff, 0xfe, 0x80, 0x81]));
  const vaultRoot = kb.vaultRoot('sheet-vault');
  const logBefore = await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8');
  await assert.rejects(
    runKnowledgeBase(host, ['ingest', '--vault', 'sheet-vault', '--files', JSON.stringify([mdPath, badTxt])]),
  );
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'inbox')), [res.batchId]);
  assert.equal(await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8'), logBefore);
});

test('directory recursive ingest skips hidden/unsupported files transparently, blocks vault self-ingest, and tracks pending batches across reloads', async (t) => {
  const sandbox = path.resolve('.tmp', `kb-dir-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  await fs.mkdir(sandbox, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const wb = new WorkbenchHost(host);
  const created = (await wb.kb({ action: 'create', name: '混合目录测试柜' })) as { vaultId: string };
  const vaultId = created.vaultId;
  const vaultRoot = path.join(process.env.SEAL_HOME!, 'vaults', vaultId);

  const mixedDir = path.join(sandbox, 'materials');
  const subDir = path.join(mixedDir, 'nested');
  const hiddenDir = path.join(mixedDir, '.hidden');
  await fs.mkdir(subDir, { recursive: true });
  await fs.mkdir(hiddenDir, { recursive: true });

  await fs.writeFile(path.join(mixedDir, 'a-master.docx'), await workflowTemplate());
  await fs.writeFile(path.join(mixedDir, 'b-scan.pdf'), buildScannedPdf(1));
  await fs.copyFile('tests/fixtures/evidence-2x1.png', path.join(subDir, 'c-photo.png'));
  await fs.writeFile(
    path.join(subDir, 'd-table.xlsx'),
    await buildXlsxBytes([
      {
        name: 'Sheet1',
        sheetXml: '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>表格数据</t></is></c></row></sheetData></worksheet>',
      },
    ]),
  );
  await fs.writeFile(path.join(subDir, 'e-note.txt'), '目录文本内容', 'utf8');
  await fs.writeFile(path.join(mixedDir, '.DS_Store'), 'ignored');
  await fs.writeFile(path.join(hiddenDir, 'secret.txt'), 'ignored');
  await fs.writeFile(path.join(mixedDir, 'archive.zip'), 'unsupported-zip');
  // Symlink cycle must not cause infinite recursion
  await fs.symlink(mixedDir, path.join(subDir, 'loop-link'));

  // Explicit single unsupported file must fail immediately
  await assert.rejects(
    runKnowledgeBase(host, ['ingest', '--vault', vaultId, '--files', JSON.stringify([path.join(mixedDir, 'archive.zip')])]),
    /不支持的入库文件格式/,
  );

  // Vault self-ingest must fail assertOutputIsolation
  await assert.rejects(
    runKnowledgeBase(host, ['ingest', '--vault', vaultId, '--files', JSON.stringify([vaultRoot])]),
    /must not overwrite.*vault/,
  );

  // Empty/unsupported-only directory must fail explicitly
  const onlyUnsupported = path.join(sandbox, 'only-zip');
  await fs.mkdir(onlyUnsupported, { recursive: true });
  await fs.writeFile(path.join(onlyUnsupported, 'only.zip'), 'zip');
  await assert.rejects(
    runKnowledgeBase(host, ['ingest', '--vault', vaultId, '--files', JSON.stringify([onlyUnsupported])]),
    /未找到受支持的可入库材料/,
  );

  // Mixed directory ingest via WorkbenchHost
  const report = (await wb.kb({ action: 'ingest', vaultId, files: [mixedDir] })) as {
    batchId: string;
    sourceCount: number;
    candidateCount: number;
    candidates: Array<{ id: string }>;
    skipped?: Array<{ source: string; reason: string }>;
  };
  assert.equal(report.sourceCount, 5);
  assert.equal(report.skipped?.length, 1);
  assert.match(report.skipped![0].source, /archive\.zip$/);

  // Reload catalog via fresh WorkbenchHost -> pendingBatches shows unfinished batch
  const freshWb = new WorkbenchHost(host);
  let catalog = (await freshWb.kb({ action: 'catalog', vaultId })) as {
    pendingBatches: Array<{ batchId: string; totalCandidates: number; pendingCount: number }>;
  };
  assert.equal(catalog.pendingBatches.length, 1);
  assert.equal(catalog.pendingBatches[0].batchId, report.batchId);
  assert.equal(catalog.pendingBatches[0].pendingCount, report.candidateCount);

  // Dismiss all candidates -> pendingBatches clears
  const kb = new KnowledgeBase(host, path.join(process.env.SEAL_HOME!, 'vaults'));
  let allIds = [...report.candidates.map((c) => c.id)];
  let page = await kb.listCandidates(vaultId, report.batchId, 100);
  allIds = page.candidates.map((c) => c.id);
  for (const id of allIds) {
    await kb.save(vaultId, { action: 'dismiss_candidate', kind: 'material', id });
  }
  catalog = (await freshWb.kb({ action: 'catalog', vaultId })) as typeof catalog;
  assert.deepEqual(catalog.pendingBatches, []);
});

test('seal-kb skill registration metadata satisfies DSH bounds', async () => {
  const { SEAL_KB_SKILL } = await import(pathToFileURL(path.resolve('src/shells/dsh/seal-kb-skill.ts')).href);
  assert.equal(SEAL_KB_SKILL.name, 'seal-kb');
  assert.equal(SEAL_KB_SKILL.source, 'bundled');
  assert.ok(SEAL_KB_SKILL.description.length > 0 && SEAL_KB_SKILL.description.length <= 500);
  assert.match(SEAL_KB_SKILL.content, /seal_kb_ingest/);
  assert.match(SEAL_KB_SKILL.content, /seal_kb_save/);
  assert.match(SEAL_KB_SKILL.content, /dismiss_candidate/);
});

test('spreadsheet hardening: OOM coordinate/budget bounds, styles/date1904 formatting, uncached formulas, sparse row numbers, and unclosed CSV quotes', async (t) => {
  const sandbox = path.resolve('.tmp', `kb-xlsx-hardening-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, 'seal-home');
  await fs.mkdir(sandbox, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  await runKnowledgeBase(host, ['init', '--vault', 'hardening-vault', '--name', '表格严密性柜']);
  const kb = new KnowledgeBase(host, path.join(process.env.SEAL_HOME!, 'vaults'));
  const vaultRoot = kb.vaultRoot('hardening-vault');

  // Seed one valid entry so we can verify atomic rollback leaves prior state untouched
  const seedTxt = path.join(sandbox, 'seed.txt');
  await fs.writeFile(seedTxt, '基线文件', 'utf8');
  const seedRes = (await runKnowledgeBase(host, ['ingest', '--vault', 'hardening-vault', '--files', JSON.stringify([seedTxt])])) as { batchId: string };
  const logBefore = await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8');

  // 1a. Oversized column coordinate (ZZZZZZZZZZ1, XFE1) and invalid row coordinate (A1048577) reject & roll back
  const oobColXlsx = path.join(sandbox, 'oob-col.xlsx');
  await fs.writeFile(
    oobColXlsx,
    await buildXlsxBytes([
      {
        name: 'BadCol',
        sheetXml:
          '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          '<row r="1"><c r="ZZZZZZZZZZ1"><v>1</v></c></row>' +
          '</sheetData></worksheet>',
      },
    ]),
  );
  await assert.rejects(parseXlsxSheets(await fs.readFile(oobColXlsx)), /超出 OOXML 合法范围/);
  await assert.rejects(
    runKnowledgeBase(host, ['ingest', '--vault', 'hardening-vault', '--files', JSON.stringify([seedTxt, oobColXlsx])]),
    /超出 OOXML 合法范围/,
  );
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'inbox')), [seedRes.batchId]);
  assert.equal(await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8'), logBefore);

  const xfeXlsx = await buildXlsxBytes([
    {
      name: 'XFE',
      sheetXml:
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="XFE1"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);
  await assert.rejects(parseXlsxSheets(xfeXlsx), /超出 OOXML 合法范围/);

  const oobRowXlsx = await buildXlsxBytes([
    {
      name: 'BadRow',
      sheetXml:
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1048577"><c r="A1048577"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);
  await assert.rejects(parseXlsxSheets(oobRowXlsx), /超出 OOXML 合法范围/);

  // 1b. Expanded grid budget (> 500,000 cells: 35 rows with one XFD cell = 35 * 16384 = 573,440 > 500,000) rejects & rolls back
  const overBudgetRows =
    '<row r="1"><c r="XFD1"><v>wide</v></c></row>' +
    Array.from({ length: 34 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}"><v>${i + 2}</v></c></row>`).join('');
  const overBudgetXlsx = path.join(sandbox, 'over-budget.xlsx');
  await fs.writeFile(
    overBudgetXlsx,
    await buildXlsxBytes([
      {
        name: 'TooWideSparse',
        sheetXml: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${overBudgetRows}</sheetData></worksheet>`,
      },
    ]),
  );
  await assert.rejects(parseXlsxSheets(await fs.readFile(overBudgetXlsx)), /工作表尺寸或单元格数超出安全上限/);
  await assert.rejects(
    runKnowledgeBase(host, ['ingest', '--vault', 'hardening-vault', '--files', JSON.stringify([overBudgetXlsx])]),
    /工作表尺寸或单元格数超出安全上限/,
  );
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'inbox')), [seedRes.batchId]);
  assert.equal(await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8'), logBefore);
  assert.throws(
    () => rowsToMarkdownTable([Array(16_384).fill('x'), ...Array.from({ length: 31 }, () => ['a'])]),
    /工作表尺寸或单元格数超出安全上限/,
  );

  // 2 & 3. styles.xml (dates 1900 & 1904, Lotus serial 60, zero-padded IDs, percent, complex custom format) & uncached vs cached formulas
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="4">' +
    '<numFmt numFmtId="164" formatCode="000000"/>' +
    '<numFmt numFmtId="165" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/>' +
    '<numFmt numFmtId="166" formatCode="¥#,##0.00"/>' +
    '<numFmt numFmtId="167" formatCode="0&quot;days&quot;"/>' +
    '</numFmts>' +
    '<cellXfs count="8">' +
    '<xf numFmtId="0"/>' + // s=0 General
    '<xf numFmtId="14"/>' + // s=1 built-in date mm-dd-yy
    '<xf numFmtId="164"/>' + // s=2 zero-padded 000000
    '<xf numFmtId="165"/>' + // s=3 custom CJK date
    '<xf numFmtId="166"/>' + // s=4 custom currency ¥#,##0.00
    '<xf numFmtId="9"/>' + // s=5 percentage 0%
    '<xf numFmtId="167"/>' + // s=6 quoted "days" (must NOT be treated as date)
    '<xf numFmtId="21"/>' + // s=7 built-in time-of-day h:mm:ss
    '</cellXfs>' +
    '</styleSheet>';

  const formattedSheetXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1">' +
    '<c r="A1" s="1"><v>45292</v></c>' + // 2024-01-01
    '<c r="B1" s="3"><v>45292.5</v></c>' + // 2024-01-01 12:00:00
    '<c r="C1" s="1"><v>0.5</v></c>' + // <1 on 1900 calendar-date style -> preserved with format note
    '<c r="D1" s="1"><v>59</v></c>' + // 1900-02-28
    '<c r="E1" s="1"><v>60</v></c>' + // Lotus 1900-02-29 unconvertible
    '<c r="F1" s="1"><v>61</v></c>' + // 1900-03-01
    '<c r="G1" s="7"><v>0.5</v></c>' + // built-in time-of-day -> 12:00:00
    '</row>' +
    '<row r="2">' +
    '<c r="A2" s="2"><v>123</v></c>' + // 000123
    '<c r="B2" s="4"><v>1234.5</v></c>' + // 1234.5（格式：¥#,##0.00）
    '<c r="C2" s="5"><v>0.15</v></c>' + // 15%
    '<c r="D2" s="6"><v>30</v></c>' + // 30（格式：0"days"）
    '<c r="E2"><f>1+1</f></c>' + // =1+1（公式结果未缓存）
    '<c r="F2"><f t="shared" si="0"/></c>' + // （公式结果未缓存）
    '<c r="G2" s="1"><f>TODAY()</f><v>45292</v></c>' + // 2024-01-01
    '</row>' +
    '</sheetData></worksheet>';

  const styled1900 = await buildXlsxBytes(
    [{ name: 'Formats', sheetXml: formattedSheetXml }],
    undefined,
    { stylesXml },
  );
  const parsed1900 = await parseXlsxSheets(styled1900);
  assert.deepEqual(parsed1900[0].rows[0].cells, [
    '2024-01-01',
    '2024-01-01 12:00:00',
    '0.5（格式：mm-dd-yy）',
    '1900-02-28',
    '60（格式：mm-dd-yy，1900-02-29 无效日期无法可靠换算）',
    '1900-03-01',
    '12:00:00',
  ]);
  assert.deepEqual(parsed1900[0].rows[1].cells, [
    '000123',
    '1234.5（格式：¥#,##0.00）',
    '15%',
    '30（格式：0"days"）',
    '=1+1（公式结果未缓存）',
    '（公式结果未缓存）',
    '2024-01-01',
  ]);

  // 1904 date epoch: serial 43830 -> 2024-01-01
  const styled1904 = await buildXlsxBytes(
    [
      {
        name: 'Epoch1904',
        sheetXml:
          '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          '<row r="1"><c r="A1" s="1"><v>43830</v></c></row>' +
          '</sheetData></worksheet>',
      },
    ],
    undefined,
    { stylesXml, date1904: true },
  );
  const parsed1904 = await parseXlsxSheets(styled1904);
  assert.equal(parsed1904[0].rows[0].cells[0], '2024-01-01');

  // 4. Sparse original row numbers (<row r="1"> and <row r="10">) report exact range in location & body
  const sparseXlsxPath = path.join(sandbox, 'sparse-rows.xlsx');
  await fs.writeFile(
    sparseXlsxPath,
    await buildXlsxBytes([
      {
        name: '稀疏表',
        sheetXml:
          '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          '<row r="1"><c r="A1" t="inlineStr"><is><t>编号</t></is></c><c r="B1" t="inlineStr"><is><t>日期</t></is></c></row>' +
          '<row r="10"><c r="A10" s="2"><v>42</v></c><c r="B10" s="1"><v>45292</v></c></row>' +
          '</sheetData></worksheet>',
      },
    ], undefined, { stylesXml }),
  );
  const sparseIngest = (await runKnowledgeBase(host, [
    'ingest',
    '--vault',
    'hardening-vault',
    '--files',
    JSON.stringify([sparseXlsxPath]),
  ])) as { candidates: Array<{ id: string }> };
  assert.equal(sparseIngest.candidates.length, 1);
  const sparseCand = await kb.getCandidate('hardening-vault', sparseIngest.candidates[0].id);
  assert.equal(sparseCand.fields.location, '工作表「稀疏表」第 1-10 行（含 2 行非空数据）');
  assert.match(sparseCand.body, /原表真实行号：1, 10/);
  assert.match(sparseCand.body, /\| 000042 \| 2024-01-01 \|/);

  // 5. CSV unclosed quotes fail-closed and roll back entire batch
  const unclosedCsvPath = path.join(sandbox, 'unclosed.csv');
  await fs.writeFile(unclosedCsvPath, 'name,amount\n"first,100\nsecond,200', 'utf8');
  assert.throws(
    () => parseDelimitedRows('name,amount\n"first,100\nsecond,200', ','),
    /CSV\/TSV 第 2 行引号未闭合，无法安全入库/,
  );
  const logBeforeCsv = await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8');
  const inboxBeforeCsv = await fs.readdir(path.join(vaultRoot, 'inbox'));
  await assert.rejects(
    runKnowledgeBase(host, ['ingest', '--vault', 'hardening-vault', '--files', JSON.stringify([seedTxt, unclosedCsvPath])]),
    /CSV\/TSV 第 2 行引号未闭合，无法安全入库/,
  );
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'inbox')), inboxBeforeCsv);
  assert.equal(await fs.readFile(path.join(vaultRoot, 'log.jsonl'), 'utf8'), logBeforeCsv);
});

test('xlsx/csv parser separates elapsed duration, time-of-day, multi-section formats, exact zero-padding, row/ref consistency, and per-cell CSV budget', async () => {
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3">' +
    '<numFmt numFmtId="164" formatCode="[&gt;=1]0;yyyy-mm-dd"/>' +
    '<numFmt numFmtId="165" formatCode="000000000000000000000000"/>' +
    '<numFmt numFmtId="166" formatCode="h:mm:ss"/>' +
    '</numFmts>' +
    '<cellXfs count="6">' +
    '<xf numFmtId="0"/>' +
    '<xf numFmtId="46"/>' + // [h]:mm:ss elapsed duration
    '<xf numFmtId="164"/>' + // conditional multi-section format
    '<xf numFmtId="165"/>' + // 24-digit zero-padded integer
    '<xf numFmtId="166"/>' + // time-of-day
    '<xf numFmtId="45"/>' + // mm:ss elapsed (fallback annotated)
    '</cellXfs></styleSheet>';

  const bytes = await buildXlsxBytes([
    {
      name: '边界测试',
      sheetXml:
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row><c r="A10" s="1"><v>1.5</v></c><c r="B10" s="2"><v>45292</v></c><c r="C10" s="3"><v>9007199254740993</v></c><c r="D10" s="3"><v>1e+21</v></c><c r="E10" s="4"><v>0.5</v></c><c r="F10" s="4"><v>1.5</v></c><c r="G10" s="5"><v>0.01</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ], undefined, { stylesXml });

  const sheets = await parseXlsxSheets(bytes);
  assert.equal(sheets[0].rows.length, 1);
  // Inferred from cell ref A10 when <row> omits r attribute
  assert.equal(sheets[0].rows[0].rowNumber, 10);
  const row = sheets[0].rows[0].cells;
  assert.equal(row[0], '36:00:00'); // format 46 [h]:mm:ss for 1.5 days
  assert.equal(row[1], '45292（格式：[>=1]0;yyyy-mm-dd）'); // multi-section not misclassified as date
  assert.equal(row[2], '000000009007199254740993'); // exact decimal string padding without float drift
  assert.equal(row[3], '1e+21（格式：000000000000000000000000）'); // scientific notation not mangled
  assert.equal(row[4], '12:00:00'); // valid time-of-day < 1
  assert.equal(row[5], '1.5（格式：h:mm:ss）'); // >= 1 on time-of-day preserved with format note
  assert.equal(row[6], '0.01（格式：mm:ss）'); // non-[h]:mm:ss elapsed preserved transparently

  // Conflicting <row r="1"> vs <c r="A10"> fails closed
  const conflictingBytes = await buildXlsxBytes([
    {
      name: '行号冲突',
      sheetXml:
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A10"><v>42</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);
  await assert.rejects(parseXlsxSheets(conflictingBytes), /行号与单元格坐标不一致/);

  // Per-cell CSV budget aborts before allocating > MAX_SPREADSHEET_CELLS in a single ultra-wide row
  const ultraWideCsv = ','.repeat(600_000);
  assert.throws(() => parseDelimitedRows(ultraWideCsv, ','), /工作表尺寸或单元格数超出安全上限/);
});

test('xlsx parser preserves millisecond precision, exact scientific percentages, and strictly increasing row order', async () => {
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="4">' +
    '<numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss.000"/>' +
    '<numFmt numFmtId="165" formatCode="h:mm:ss.000"/>' +
    '<numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm:ss.0000"/>' +
    '<numFmt numFmtId="167" formatCode="[h]:mm:ss.000"/>' +
    '</numFmts>' +
    '<cellXfs count="6">' +
    '<xf numFmtId="0"/>' +
    '<xf numFmtId="164"/>' + // s=1 datetime with ms
    '<xf numFmtId="165"/>' + // s=2 time-of-day with ms
    '<xf numFmtId="9"/>' + // s=3 percentage 0%
    '<xf numFmtId="166"/>' + // s=4 sub-millisecond unsupported
    '<xf numFmtId="167"/>' + // s=5 elapsed duration with ms
    '</cellXfs></styleSheet>';

  const bytes = await buildXlsxBytes(
    [
      {
        name: '精度边界',
        sheetXml:
          '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
          '<row r="1">' +
          '<c r="A1" s="1"><v>45292.999999</v></c>' +
          '<c r="B1" s="2"><v>0.500001</v></c>' +
          '<c r="C1" s="1"><v>45292.999999999</v></c>' +
          '<c r="D1" s="3"><v>1.23456789012345E-1</v></c>' +
          '<c r="E1" s="3"><v>0.123456789012345</v></c>' +
          '<c r="F1" s="3"><v>5e-4</v></c>' +
          '<c r="G1" s="3"><v>0.0005</v></c>' +
          '<c r="H1" s="3"><v>1e200</v></c>' +
          '<c r="I1" s="4"><v>45292.5</v></c>' +
          '<c r="J1" s="5"><v>1.500001</v></c>' +
          '<c r="K1" s="5"><v>0.000000001</v></c>' +
          '<c r="L1" s="2"><v>0.000000001</v></c>' +
          '<c r="M1" s="1"><v>45292.000000001</v></c>' +
          '<c r="N1" s="3"><v>1e2</v></c>' +
          '<c r="O1" s="3"><v>1.25e+2</v></c>' +
          '<c r="P1" s="3"><v>-1.25e+2</v></c>' +
          '<c r="Q1" s="3"><v>-0.0</v></c>' +
          '</row>' +
          '</sheetData></worksheet>',
      },
    ],
    undefined,
    { stylesXml },
  );

  const sheets = await parseXlsxSheets(bytes);
  const row = sheets[0].rows[0].cells;
  // Sub-second pre-midnight never rolls into next day
  assert.equal(row[0], '2024-01-01 23:59:59.914');
  assert.equal(row[1], '12:00:00.086');
  // Within <0.5ms of midnight preserves raw value + format note instead of jumping to 2024-01-02
  assert.equal(row[2], '45292.999999999（格式：yyyy-mm-dd hh:mm:ss.000）');
  // Scientific notation and decimal notation produce identical exact percentages
  assert.equal(row[3], '12.3456789012345%');
  assert.equal(row[4], row[3]);
  assert.equal(row[5], '0.05%');
  assert.equal(row[6], row[5]);
  // Extreme exponent fails safe with format note
  assert.equal(row[7], '1e200（格式：0%）');
  // Sub-millisecond precision format preserved transparently
  assert.equal(row[8], '45292.5（格式：yyyy-mm-dd hh:mm:ss.0000）');
  // Elapsed duration with milliseconds & sub-half-ms positive fallbacks
  assert.equal(row[9], '36:00:00.086');
  assert.equal(row[10], '0.000000001（格式：[h]:mm:ss.000）');
  assert.equal(row[11], '0.000000001（格式：h:mm:ss.000）');
  assert.equal(row[12], '45292.000000001（格式：yyyy-mm-dd hh:mm:ss.000）');
  // Positive-exponent scientific percentages, negative percentages, and signed zero
  assert.equal(row[13], '10000%');
  assert.equal(row[14], '12500%');
  assert.equal(row[15], '-12500%');
  assert.equal(row[16], '0%');

  // Non-monotonic [1, 10, 3] and duplicate [1, 1, 3] row numbers fail closed
  const outOfOrder = await buildXlsxBytes([
    {
      name: '乱序',
      sheetXml:
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1"><v>1</v></c></row>' +
        '<row r="10"><c r="A10"><v>2</v></c></row>' +
        '<row r="3"><c r="A3"><v>3</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);
  await assert.rejects(parseXlsxSheets(outOfOrder), /XLSX 工作表行号非严格递增/);

  const duplicateRows = await buildXlsxBytes([
    {
      name: '重复行',
      sheetXml:
        '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1"><v>1</v></c></row>' +
        '<row r="1"><c r="A1"><v>2</v></c></row>' +
        '<row r="3"><c r="A3"><v>3</v></c></row>' +
        '</sheetData></worksheet>',
    },
  ]);
  await assert.rejects(parseXlsxSheets(duplicateRows), /XLSX 工作表行号非严格递增/);
});
