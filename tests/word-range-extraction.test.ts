import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRanges } from '../src/core/docx/range-extraction.js';
import { readZip, writeZip } from '../src/core/docx/zip.js';

test('range copy retains package parts, section properties and complete marker pairs', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const document = '<w:document xmlns:w="word"><w:body><w:p><w:bookmarkStart w:id="1"/><w:r><w:t>excluded</w:t></w:r></w:p><w:p><w:bookmarkEnd w:id="1"/><w:bookmarkStart w:id="2"/><w:r><w:t>included</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p><w:sectPr><w:pgSz w:w="100"/></w:sectPr></w:body></w:document>';
  const source = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode(document)],
    ['word/styles.xml', encode('<styles/>')],
  ]));
  const original = source.slice();
  const result = await extractRanges(source, [{ from: 'p:1', to: 'p:1' }]);
  assert.deepEqual(source, original);
  assert.deepEqual(result.base, result.draft);
  assert.notEqual(result.base, result.draft);
  const parts = await readZip(result.draft);
  const output = new TextDecoder().decode(parts.get('word/document.xml'));
  assert.doesNotMatch(output, /excluded|w:id="1"/);
  assert.match(output, /included/);
  assert.equal((output.match(/w:id="2"/g) ?? []).length, 2);
  assert.match(output, /<w:pgSz w:w="100"\/>/);
  assert.ok(parts.has('word/styles.xml'));
  assert.equal(result.removedMarkers.length, 1);
  await assert.rejects(extractRanges(source, [{ from: 'p:1', to: 'p:0' }]));
});

test('range copy renames reserved source bookmarks without changing the source', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const source = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:p><w:bookmarkStart w:id="1" w:name="_Seal_P_42"/><w:r><w:t>原文</w:t></w:r><w:bookmarkEnd w:id="1"/><w:hyperlink w:anchor="_Seal_P_42"><w:r><w:t>跳转</w:t></w:r></w:hyperlink><w:bookmarkStart w:id="2" w:name="Original"/><w:bookmarkEnd w:id="2"/></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const original = source.slice();
  const copied = await extractRanges(source, [{ from: 'p:0', to: 'p:0' }]);
  const xml = new TextDecoder().decode((await readZip(copied.draft)).get('word/document.xml'));
  assert.doesNotMatch(xml, /w:name="_Seal_/);
  assert.match(xml, /w:name="Original"/);
  assert.equal(copied.renamedMarkers.length, 1);
  assert.equal(copied.renamedMarkers[0].before, '_Seal_P_42');
  assert.ok(xml.includes(`w:name="${copied.renamedMarkers[0].after}"`));
  assert.ok(xml.includes(`w:anchor="${copied.renamedMarkers[0].after}"`));
  assert.deepEqual(source, original);
});

test('range output performs C01 on every image including untouched and unselected image parts', async () => {
  const { readFile } = await import('node:fs/promises');
  const encode = (value: string) => new TextEncoder().encode(value);
  const make = async (bytes: Uint8Array, extension: string, mime: string) => writeZip(new Map([
    ['[Content_Types].xml', encode(`<Types><Default Extension="xml" ContentType="application/xml"/><Default Extension="${extension}" ContentType="${mime}"/></Types>`)],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>复制文字</w:t></w:r></w:p></w:body></w:document>')],
    [`word/media/untouched.${extension}`, bytes],
  ]));
  const png = await readFile('tests/fixtures/evidence-2x1.png');
  await extractRanges(await make(png, 'png', 'image/png'), [{ from: 'p:0', to: 'p:0' }]);
  const source = await make(png.subarray(0, png.length - 10), 'png', 'image/png');
  const before = source.slice();
  await assert.rejects(extractRanges(source, [{ from: 'p:0', to: 'p:0' }]), /word\/media\/untouched.png/);
  assert.deepEqual(source, before);
  const gif = await make(await readFile('tests/fixtures/geometry.gif'), 'gif', 'image/gif');
  await assert.rejects(extractRanges(gif, [{ from: 'p:0', to: 'p:0' }]), /宿主|解码/);
  const { NodeHostPort } = await import('../src/shells/node-host.js');
  const host = new NodeHostPort();
  await extractRanges(gif, [{ from: 'p:0', to: 'p:0' }], { validateImage: host.validateImage.bind(host) });
});
