import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeZip } from '../src/core/docx/zip.js';
import { ingestMasterDocuments } from '../src/core/kb/ingest.js';
import { NodeHostPort } from '../src/shells/node-host.js';
import type { HostPort } from '../src/core/host.js';

const encoder = new TextEncoder();
const encode = (value: string) => encoder.encode(value);

async function sourceDocx(png: Uint8Array): Promise<Uint8Array> {
  const paragraph = (text: string, level?: number) => `<w:p>${level === undefined ? '' : `<w:pPr><w:outlineLvl w:val="${level}"/></w:pPr>`}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  const image = '<w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>';
  const body = paragraph('合成商务档案', 0) + paragraph('证照候选 直接套用', 1) + paragraph('合成正文段落') + image + paragraph('写作素材 标黄', 1) + paragraph('合成素材正文') + '<w:sectPr/>';
  return writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
    ['word/document.xml', encode(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>${body}</w:body></w:document>`) ],
    ['word/_rels/document.xml.rels', encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/linked.png"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/unlinked.png"/></Relationships>')],
    ['word/media/linked.png', png], ['word/media/unlinked.png', png],
  ]));
}

async function vectorDocx(vector: Uint8Array): Promise<Uint8Array> {
  const document = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>合成矢量候选</w:t></w:r></w:p><w:p><w:r><w:drawing><a:blip r:embed="vector"/></w:drawing></w:r></w:p><w:sectPr/></w:body></w:document>';
  return writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="wmf" ContentType="image/x-wmf"/></Types>')],
    ['word/document.xml', encode(document)],
    ['word/_rels/document.xml.rels', encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="vector" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/vector.wmf"/></Relationships>')],
    ['word/media/vector.wmf', vector],
  ]));
}

test('master ingest creates outline candidates, preserves tagged headings, image parts and source locations', async t => {
  const root = path.resolve('.tmp', `kb-ingest-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = new NodeHostPort(), vaultRoot = path.join(root, 'vault');
  await fs.mkdir(path.join(vaultRoot, 'inbox'), { recursive: true });
  await fs.mkdir(path.join(vaultRoot, 'files'), { recursive: true });
  const originalImage = new Uint8Array(await fs.readFile('tests/fixtures/evidence-2x1.png'));
  const source = path.join(root, 'master.docx'), bytes = await sourceDocx(originalImage);
  await fs.writeFile(source, bytes);
  const before = await fs.readFile(source);
  const report = await ingestMasterDocuments({
    host, vaultRoot, sourcePaths: [source, source], stagingRoot: path.join(root, 'staging'), batchId: 'batch-synthetic',
  });
  assert.equal(report.candidateCount, 8);
  assert.equal(report.imageCount, 4);
  assert.ok(report.candidates.some(candidate => candidate.title === '证照候选' && candidate.location.includes('word/document.xml#p:')));
  assert.ok(report.candidates.some(candidate => candidate.title === '未关联章节图片 1'));
  assert.ok((await fs.readFile(source)).equals(Buffer.from(before)));
  const candidate = report.candidates.find(item => item.title === '证照候选')!;
  const candidateMarkdown = await fs.readFile(path.join(vaultRoot, 'inbox', report.batchId, `${candidate.id}.md`), 'utf8');
  assert.match(candidateMarkdown, /tags:\n  - "直接套用"/);
  assert.match(candidateMarkdown, /合成正文段落/);
  assert.match(candidateMarkdown, /location: "word\/document.xml#/);
  assert.match(candidateMarkdown, /!\[母本图片\]\(\.\.\/\.\.\/files\/batch-synthetic\//);
  const unlinked = report.candidates.find(item => item.title === '未关联章节图片 1')!;
  const unlinkedMarkdown = await fs.readFile(path.join(vaultRoot, 'inbox', report.batchId, `${unlinked.id}.md`), 'utf8');
  assert.match(unlinkedMarkdown, /主体与用途待核实/);
  assert.match(unlinkedMarkdown, /!\[母本图片\]/);
  const allFiles = await host.listFiles!(vaultRoot);
  const importedPng = allFiles.filter(file => file.startsWith('files/batch-synthetic/'));
  assert.equal(importedPng.length, 4);
  assert.ok(importedPng.some(file => file.includes('/source-1/')));
  assert.ok(importedPng.some(file => file.includes('/source-2/')));
  for (const file of importedPng) assert.ok((await fs.readFile(path.join(vaultRoot, file))).equals(Buffer.from(originalImage)));
  await assert.rejects(ingestMasterDocuments({
    host, vaultRoot, sourcePaths: [source], stagingRoot: path.join(root, 'staging-again'), batchId: report.batchId,
  }), /入库批次已存在/);
  assert.deepEqual(await fs.readFile(source), before);
});

test('vector preview failure rolls back its batch and preserves previous batches', async t => {
  const root = path.resolve('.tmp', `kb-ingest-vector-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = new NodeHostPort(), host: HostPort = {
    ...real,
    readBytes: real.readBytes.bind(real), writeBytes: real.writeBytes.bind(real), readText: real.readText.bind(real), writeText: real.writeText.bind(real),
    stat: real.stat.bind(real), makeDirectory: real.makeDirectory.bind(real), removeDirectory: real.removeDirectory.bind(real),
    joinPath: real.joinPath.bind(real), dirname: real.dirname.bind(real), listFiles: real.listFiles!.bind(real),
    validateImage: real.validateImage.bind(real), convertImageToPng: undefined,
  };
  const vaultRoot = path.join(root, 'vault');
  for (const directory of ['inbox/batch-old', 'files/batch-old']) await fs.mkdir(path.join(vaultRoot, directory), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, 'inbox/batch-old/keep.md'), 'older candidate');
  await fs.writeFile(path.join(vaultRoot, 'files/batch-old/keep.wmf'), 'older media');
  const vector = new Uint8Array(await fs.readFile('tests/fixtures/geometry.wmf'));
  const source = path.join(root, 'source.docx');
  const original = await vectorDocx(vector);
  await fs.writeFile(source, original);
  const before = await fs.readFile(source);
  await assert.rejects(ingestMasterDocuments({ host, vaultRoot, sourcePaths: [source], stagingRoot: path.join(root, 'staging'), batchId: 'batch-no-converter' }), /宿主不支持生成图片预览/);
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'inbox')), ['batch-old']);
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'files')), ['batch-old']);
  assert.equal(await fs.readFile(path.join(vaultRoot, 'inbox/batch-old/keep.md'), 'utf8'), 'older candidate');
  assert.deepEqual(await fs.readFile(source), before);

  const corrupted = await vectorDocx(vector.subarray(0, 12));
  await fs.writeFile(source, corrupted);
  await assert.rejects(ingestMasterDocuments({ host: real, vaultRoot, sourcePaths: [source], stagingRoot: path.join(root, 'staging-broken'), batchId: 'batch-corrupt-vector' }), /WMF|矢量/);
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'inbox')), ['batch-old']);
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'files')), ['batch-old']);
  assert.ok((await fs.readFile(source)).equals(Buffer.from(corrupted)));
});

test('master ingest failure rolls back only its new batch and leaves older batches intact', async t => {
  const root = path.resolve('.tmp', `kb-ingest-rollback-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = new NodeHostPort(), writeBytes = real.writeBytes.bind(real), host: HostPort = {
    ...real,
    readBytes: real.readBytes.bind(real), readText: real.readText.bind(real), writeText: real.writeText.bind(real),
    stat: real.stat.bind(real), makeDirectory: real.makeDirectory.bind(real), removeDirectory: real.removeDirectory.bind(real),
    joinPath: real.joinPath.bind(real), dirname: real.dirname.bind(real), listFiles: real.listFiles!.bind(real),
    writeBytes: async (file, bytes) => { if (file.includes('/0002-')) throw new Error('injected second-image persistence failure'); await writeBytes(file, bytes); },
  };
  const vaultRoot = path.join(root, 'vault');
  for (const directory of ['inbox/batch-old', 'files/batch-old']) await fs.mkdir(path.join(vaultRoot, directory), { recursive: true });
  await fs.writeFile(path.join(vaultRoot, 'inbox/batch-old', 'keep.md'), 'older batch');
  await fs.writeFile(path.join(vaultRoot, 'files/batch-old', 'keep.png'), 'older attachment');
  const image = new Uint8Array(await fs.readFile('tests/fixtures/evidence-2x1.png'));
  const source = path.join(root, 'source.docx');
  const original = await sourceDocx(image);
  await fs.writeFile(source, original);
  const before = await fs.readFile(source);
  await assert.rejects(ingestMasterDocuments({ host, vaultRoot, sourcePaths: [source], stagingRoot: path.join(root, 'staging'), batchId: 'batch-failed' }), /second-image persistence failure/);
  assert.equal(await fs.readFile(path.join(vaultRoot, 'inbox/batch-old/keep.md'), 'utf8'), 'older batch');
  assert.equal(await fs.readFile(path.join(vaultRoot, 'files/batch-old/keep.png'), 'utf8'), 'older attachment');
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'inbox')), ['batch-old']);
  assert.deepEqual(await fs.readdir(path.join(vaultRoot, 'files')), ['batch-old']);
  assert.deepEqual(await fs.readFile(source), before);
});
