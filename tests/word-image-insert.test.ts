import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';
import { sha256Hex, writeZip } from '../src/core/docx/zip.js';
import { bodyViewNodes } from '../src/core/docx/document-view.js';
import { resolveAddress } from '../src/core/docx/addresses.js';
import { sealRanges } from '../src/core/docx/seal-ranges.js';
import { editableText } from '../src/core/docx/visible-surgery.js';
import { finalizeDocument } from '../src/core/docx/finalize-document.js';
import type { HostPort } from '../src/core/host.js';
import sharp from 'sharp';

test('insert_image registers image bytes, relationships, type and bounded dimensions', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const input = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>锚点</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const image = await readFile('tests/fixtures/evidence-2x1.png');
  const original = input.slice();
  const output = await editTextDocument(input, [{ op: 'insert_image', at: 'p:0', image }]);
  assert.deepEqual(input, original);
  const parts = await validatePackageStructure(output);
  assert.deepEqual(parts.get('word/media/seal-image-1.png'), new Uint8Array(image));
  const xml = new TextDecoder().decode(parts.get('word/document.xml'));
  assert.match(xml, /<w:ind w:left="0" w:right="0"[^>]*w:firstLineChars="0"[^>]*\/><w:jc w:val="left"\/>/);
  assert.match(xml, /<wp:extent cx="\d+" cy="\d+"\/>/);
  assert.match(xml, /<a:blip r:embed="rId1"\/>/);
  await assert.rejects(editTextDocument(input, [{ op: 'insert_image', at: 'p:0', image: new Uint8Array([0, 1, 2]) }]));
  const markdown = await editTextDocument(input, [{ op: 'insert', at: 'p:0', position: 'after', markdown: '正文 ![图](materials/image.png) 后文', images: [image] }]);
  const markdownParts = await validatePackageStructure(markdown);
  const markdownXml = new TextDecoder().decode(markdownParts.get('word/document.xml'));
  assert.match(markdownXml, /正文/);
  assert.match(markdownXml, /后文/);
  assert.match(markdownXml, /<a:blip r:embed="rId1"\/>/);
  await assert.rejects(editTextDocument(input, [{ op: 'insert', at: 'p:0', position: 'after', markdown: '![图](materials/image.png)' }]));
});

test('an image inserted after a cell paragraph is bounded by its containing cell', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const input = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:tbl><w:tr><w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>锚点</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>')],
  ]));
  const image = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#2277aa' } }).png().toBuffer();
  for (const edit of [
    { op: 'insert_image' as const, at: 't:0/r:0/c:0/p:0', image },
    { op: 'insert' as const, at: 't:0/r:0/c:0/p:0', position: 'after' as const, markdown: '![图](image.png)', images: [image] },
  ]) {
    const output = await editTextDocument(input, [edit]);
    const xml = new TextDecoder().decode((await validatePackageStructure(output)).get('word/document.xml'));
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    assert.ok(Number(extent[1]) <= (2000 - 240) * 635);
    assert.ok(Math.abs(Number(extent[1]) / Number(extent[2]) - 4 / 3) < 0.001);
  }
});

test('image paragraphs override inherited exact line height without changing text paragraphs', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const anchor = '<w:p><w:pPr><w:pStyle w:val="47"/><w:spacing w:line="400" w:lineRule="exact"/></w:pPr><w:r><w:t>原文</w:t></w:r></w:p>';
  const input = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode(`<w:document xmlns:w="word"><w:body>${anchor}<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`)]]));
  const image = await readFile('tests/fixtures/evidence-2x1.png');
  for (const edit of [
    { op: 'insert_image' as const, at: 'p:0', image },
    { op: 'insert_image' as const, at: 't:0/r:0/c:0', image },
    { op: 'insert' as const, at: 'p:0', position: 'after' as const, markdown: '正文 ![图](image.png)', images: [image] },
  ]) {
    const output = await editTextDocument(input, [edit]);
    const xml = new TextDecoder().decode((await validatePackageStructure(output)).get('word/document.xml'));
    const paragraphs: string[] = [];
    const visit = (nodes: ReturnType<typeof bodyViewNodes>) => { for (const node of nodes) { if (node.kind === 'paragraph' && /<w:drawing\b/.test(node.xml)) paragraphs.push(node.xml); visit(node.children); } };
    visit(bodyViewNodes(xml));
    assert.equal(paragraphs.length, 1);
    assert.match(paragraphs[0], /<w:spacing\b[^>]*w:lineRule="auto"/);
    assert.ok(xml.includes(anchor));
  }
});

test('captioned portrait images respect the current section and reserve room above the image', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const section = (height: number) => `<w:sectPr><w:pgSz w:w="12000" w:h="${height}"/><w:pgMar w:top="720" w:bottom="720" w:left="0" w:right="0"/><w:docGrid w:type="lines" w:linePitch="400"/></w:sectPr>`;
  const first = `<w:p><w:pPr>${section(7000)}</w:pPr><w:r><w:t>First</w:t></w:r></w:p>`;
  const second = '<w:p><w:r><w:t>Second</w:t></w:r></w:p>';
  const input = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode(`<w:document xmlns:w="word"><w:body>${first}${second}${section(12000)}</w:body></w:document>`)],
  ]));
  const image = await sharp({ create: { width: 180, height: 1800, channels: 3, background: '#2277aa' } }).png().toBuffer();
  const caption = '持证方：合成持证单位';
  const edits = [
    { op: 'insert' as const, at: 'p:0', position: 'before' as const, markdown: '![图](image.png)', images: [image], imageCaptions: [caption] },
    { op: 'insert_image' as const, at: 'p:0', image, imageLabel: caption, captioned: true },
  ];
  const heights: number[] = [];
  for (const edit of edits) {
    const output = await editTextDocument(input, [edit]);
    const xml = new TextDecoder().decode((await validatePackageStructure(output)).get('word/document.xml'));
    const extent = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(xml)!;
    heights.push(Number(extent[2]) / 635);
    assert.ok(Math.abs(Number(extent[1]) / Number(extent[2]) - 0.1) < 0.001);
    assert.match(xml, /<w:keepLines\/>/);
    assert.match(xml, /<w:snapToGrid w:val="0"\/>/);
    assert.ok(xml.includes(first) && xml.includes(second));
  }
  assert.ok(heights[0] <= 7000 - 1440 - 1560);
  assert.ok(heights[1] <= 12000 - 1440 - 1560 && heights[1] > heights[0]);
});

test('captioned images use independent unbreakable rows within an otherwise unchanged cell', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const first = '<w:p><w:r><w:t>相邻第一段</w:t></w:r></w:p>';
  const last = '<w:p><w:r><w:t>相邻末段</w:t></w:r></w:p>';
  const rowProperties = '<w:trPr><w:trHeight w:val="400" w:hRule="atLeast"/></w:trPr>';
  const otherCell = '<w:tc><w:p><w:r><w:t>相邻列</w:t></w:r></w:p></w:tc>';
  const input = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode(`<w:document xmlns:w="word"><w:body><w:tbl><w:tr>${rowProperties}${otherCell}<w:tc><w:tcPr><w:tcW w:w="3300" w:type="dxa"/></w:tcPr>${first}${last}</w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`)],
  ]));
  const image = await sharp({ create: { width: 1300, height: 1920, channels: 3, background: '#2277aa' } }).png().toBuffer();
  const at = 't:0/r:0/c:1/p:0', cell = 't:0/r:0/c:1';
  const caption = '持证方：合成配套资料供应单位及验证附属设备联合测试机构';
  const seal = { name: '_Seal_P_explicit', id: 1 };
  const secondSeal = { name: '_Seal_F_verified', id: 2 };
  const edits = [
    { op: 'insert_image' as const, at, image, imageLabel: caption, captioned: true, seal, pending: true },
    { op: 'insert' as const, at, position: 'after' as const, markdown: '图前 ![证书](one.png) 图间 ![证书](two.png) 图后', images: [image, image], imageCaptions: [caption, caption], imageSeals: [seal, secondSeal] },
  ];
  for (const [index, edit] of edits.entries()) {
    const output = await editTextDocument(input, [edit]);
    const xml = new TextDecoder().decode((await validatePackageStructure(output)).get('word/document.xml'));
    assert.ok(xml.includes(rowProperties) && xml.includes(otherCell) && xml.includes(first) && xml.includes(last));
    const innerTables = bodyViewNodes(xml)[0].children[0].children[1].children.filter(node => node.kind === 'table');
    assert.equal(innerTables.length, index + 1);
    assert.equal([...xml.matchAll(/<w:cantSplit\/>/g)].length, innerTables.length);
    for (const [number, table] of innerTables.entries()) {
      assert.equal(table.address, `${cell}/t:${number}`);
      assert.equal(table.children.length, 1);
      assert.match(table.children[0].xml, /^<w:tr><w:trPr><w:cantSplit\/><\/w:trPr>/);
      const paragraph = table.children[0].children[0].children[0].xml;
      const [range] = sealRanges(paragraph);
      const within = paragraph.slice(range.startXml, range.endXml);
      assert.match(within, /持证方：[^\n]+<w:drawing\b/);
      const [x, y] = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(within)!.slice(1).map(Number);
      assert.ok(x <= (3300 - 240) * 635);
      assert.ok(Math.abs(x / y - 1300 / 1920) < 0.001);
      const expectedPending = number === 0;
      assert.equal(range.name.startsWith('_Seal_P_'), expectedPending);
      assert.equal(within.includes('w:val="yellow"'), expectedPending);
    }
    if (index === 1) {
      const paragraphs = bodyViewNodes(xml)[0].children[0].children[1].children.filter(node => node.kind === 'paragraph');
      assert.deepEqual(paragraphs.map(node => editableText(node.xml)), ['相邻第一段', '图前 ', ' 图间 ', ' 图后', '相邻末段']);
    }
  }
  const draft = await editTextDocument(input, [{
    op: 'insert', at: 't:0', position: 'after', markdown: '| 图片 | 正文 |\n| --- | --- |\n| ![证书](image.png) | 相邻栏 |', images: [image], imageCaptions: [caption],
  }]);
  const xml = new TextDecoder().decode((await validatePackageStructure(draft)).get('word/document.xml'));
  const authored = resolveAddress(xml, 't:1/r:1/c:0/t:0');
  assert.match(authored.xml, /<w:cantSplit\/>/);
  assert.match(authored.xml, /<w:drawing\b/);
  assert.equal(editableText(resolveAddress(xml, 't:1/r:1/c:1').xml), '相邻栏');
  assert.deepEqual(bodyViewNodes(xml)[1].children[1].children[0].children.map(node => node.kind), ['paragraph', 'table', 'paragraph']);

  const vacant = await editTextDocument(input, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['', '']] }]);
  const cellEdits = [
    { op: 'insert_image' as const, at: 't:0/r:1/c:0', image, imageLabel: caption, captioned: true, seal, pending: true },
    { op: 'insert' as const, at: `${cell}/p:1`, position: 'after' as const, markdown: '![证书](image.png)', images: [image], imageCaptions: [caption], imageSeals: [seal] },
  ];
  for (const edit of cellEdits) {
    const base = edit.op === 'insert_image' ? vacant : input;
    const output = await editTextDocument(base, [edit]);
    const cellAt = edit.op === 'insert_image' ? edit.at : cell;
    const doc = new TextDecoder().decode((await validatePackageStructure(output)).get('word/document.xml'));
    const blocks = bodyViewNodes(doc)[0].children[edit.op === 'insert_image' ? 1 : 0].children[edit.op === 'insert_image' ? 0 : 1].children;
    assert.deepEqual(blocks.slice(-2).map(node => [node.kind, editableText(node.xml)]), [['table', (edit.op === 'insert' ? '（图片待核对1）' : '') + caption + '\n'], ['paragraph', '']]);
    const [range] = sealRanges(doc);
    const finalized = await finalizeDocument(output, base, { draftSha256: sha256Hex(output), baseSha256: sha256Hex(base), marks: [
      { id: 'explicit', state: 'confirmed', originalHighlights: Array(range.text.length).fill(null) },
    ] }, {} as HostPort);
    const finalXml = new TextDecoder().decode((await validatePackageStructure(finalized)).get('word/document.xml'));
    assert.deepEqual(sealRanges(finalXml), []);
    const finalGroup = resolveAddress(finalXml, `${cellAt}/t:0`).xml;
    assert.match(finalGroup, /<w:cantSplit\/>/);
    assert.match(finalGroup, /<w:drawing\b/);
    assert.doesNotMatch(finalGroup, /w:val="yellow"/);
    assert.ok(editableText(finalGroup).includes(caption));
  }
});
