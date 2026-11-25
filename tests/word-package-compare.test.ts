import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareDocuments } from '../src/core/docx/package-compare.js';
import { writeZip } from '../src/core/docx/zip.js';

test('package comparison follows media content when relationships are renumbered', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const image = await readFile('tests/fixtures/evidence-2x1.png');
  const build = async (id: string, include: boolean) => writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/></Types>')],
    ['word/document.xml', encode(`<w:document xmlns:w="word" xmlns:r="relations" xmlns:a="drawing" xmlns:wp="word-drawing"><w:body><w:p><w:r>${include ? `<w:drawing><wp:docPr id="${id === 'a' ? 1 : 9}"/><a:blip r:embed="${id}"/></w:drawing>` : ''}<w:t>正文</w:t></w:r></w:p></w:body></w:document>`)],
    ['word/_rels/document.xml.rels', encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="${id}" Type="image" Target="media/image.png"/></Relationships>`)],
    ['word/media/image.png', image],
  ]));
  const original = await build('a', true), saved = await build('b', true), lost = await build('b', false);
  assert.ok(!(await compareDocuments(original, saved)).some(item => item.kind === 'objectLost'));
  assert.ok((await compareDocuments(original, lost)).some(item => item.kind === 'objectLost' && item.address === 'p:0'));
});

async function document(body: string, relationships = '', extra: Array<[string, Uint8Array]> = []): Promise<Uint8Array> {
  const encode = (value: string) => new TextEncoder().encode(value);
  return writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/octet-stream"/></Types>')],
    ['word/document.xml', encode(`<w:document xmlns:w="word" xmlns:r="relations" xmlns:a="drawing" xmlns:o="objects"><w:body>${body}</w:body></w:document>`)],
    ['word/_rels/document.xml.rels', encode(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`)],
    ...extra,
  ]));
}

test('comparison classifies only literal blank characters as filling, independent of hint vocabulary', async () => {
  const paragraph = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cases = [
    ['本合同款项（合同金额）应按期支付。', '本合同款项（全部费用）应按期支付。', 'modified', 'bracketText'],
    ['本合同款项（合同费用）应按期支付。', '本合同款项（全部费用）应按期支付。', 'modified', 'bracketText'],
    ['投标人：（投标人名称）', '投标人：某某有限公司', 'modified', 'bracketText'],
    ['投标人：（投标人全称）', '投标人：某某有限公司', 'modified', 'bracketText'],
    ['投标人：________', '投标人：某某有限公司', 'filled', undefined],
    ['原文（固定条款）', '原文（固定内容）', 'modified', 'bracketText'],
    ['原文（固定条款）', '修改（固定内容）', 'modified', undefined],
    ['名称：（ ）', '名称：某某有限公司', 'filled', undefined],
    ['日期：年 月 日', '日期：2028年2月29日', 'filled', undefined],
    ['签署：2025 年  月  日', '签署：2025 年11月18日', 'filled', undefined],
    ['签署：2025 年  月  日', '签署：2026 年11月18日', 'modified', undefined],
    ['签署：  年  月  日', '签署：不明2026年11月18日', 'modified', undefined],
    ['选项：□是', '选项：☑是', 'filled', undefined],
    ['选项：☑是', '选项：√是', 'modified', undefined],
    ['选项：□是', '选项：☐是', 'modified', undefined],
    ['选项：√是', '选项：☐是', 'filled', undefined],
    ['名称：XX', '名称：某某有限公司', 'modified', undefined],
  ] as const;
  for (const [before, after, kind, subtype] of cases) {
    const changes = await compareDocuments(await document(paragraph(before)), await document(paragraph(after)));
    const change = changes.find(item => ['filled', 'modified'].includes(item.kind));
    assert.ok(change, `${before} → ${after}`);
    assert.equal(change.kind, kind, `${before} → ${after}`);
    assert.equal((change as { subtype?: string }).subtype, subtype, `${before} → ${after}`);
  }
});

test('comparison ignores only Seal bookmarks and still detects lost original bookmarks', async () => {
  const paragraph = (name: string) => `<w:p><w:bookmarkStart w:id="1" w:name="${name}"/><w:r><w:t>原文</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>`;
  const plain = '<w:p><w:r><w:t>原文</w:t></w:r></w:p>';
  assert.deepEqual(await compareDocuments(await document(paragraph('_Seal_P_42')), await document(plain)), []);
  assert.ok((await compareDocuments(await document(paragraph('OriginalBookmark')), await document(plain))).some(item => item.kind === 'objectLost'));
});

test('package comparison reports a removed same-result simple field at a nested paragraph address', async () => {
  const before = '<w:tbl><w:tr><w:tc><w:p><w:fldSimple w:instr="DATE"><w:r><w:t>正文</w:t></w:r></w:fldSimple></w:p></w:tc></w:tr></w:tbl>';
  const after = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const changes = await compareDocuments(await document(before), await document(after));
  assert.ok(changes.some(item => item.kind === 'objectLost' && item.address === 't:0/r:0/c:0/p:0'));
});

test('renamed image parts and IDs preserve identity but changed embedded object bytes do not', async () => {
  const image = await readFile('tests/fixtures/evidence-2x1.png');
  const body = (imageId: string, objectId: string) => `<w:p><w:r><w:drawing><a:blip r:embed="${imageId}"/></w:drawing><w:object><o:OLEObject r:id="${objectId}"/></w:object><w:t>正文</w:t></w:r></w:p>`;
  const rels = (imageId: string, objectId: string, imageName: string) => `<Relationship Id="${imageId}" Type="image" Target="media/${imageName}"/><Relationship Id="${objectId}" Type="oleObject" Target="embeddings/object.bin"/>`;
  const first = await document(body('i1', 'o1'), rels('i1', 'o1', 'original.png'), [['word/media/original.png', image], ['word/embeddings/object.bin', new Uint8Array([1, 2, 3])]]);
  const saved = await document(body('i8', 'o8'), rels('i8', 'o8', 'renamed.png'), [['word/media/renamed.png', image], ['word/embeddings/object.bin', new Uint8Array([1, 2, 3])]]);
  assert.deepEqual(await compareDocuments(first, saved), []);
  const changed = await document(body('i8', 'o8'), rels('i8', 'o8', 'renamed.png'), [['word/media/renamed.png', image], ['word/embeddings/object.bin', new Uint8Array([9, 2, 3])]]);
  const changes = await compareDocuments(first, changed);
  assert.equal(changes.filter(item => item.kind === 'objectLost').length, 1);
  assert.match(changes.find(item => item.kind === 'objectLost')!.before, /w:object/);
});

test('a relationship with the same target bytes but a different role is not the original object', async () => {
  const image = await readFile('tests/fixtures/evidence-2x1.png');
  const body = '<w:p><w:r><w:drawing><a:blip r:embed="image"/></w:drawing><w:t>正文</w:t></w:r></w:p>';
  const build = (type: string) => document(body, `<Relationship Id="image" Type="${type}" Target="media/image.png"/>`, [['word/media/image.png', image]]);
  assert.ok((await compareDocuments(await build('image'), await build('differentRole'))).some(item => item.kind === 'objectLost'));
});

test('a deleted nested image placement cannot be replaced by bytes retained elsewhere in the package', async () => {
  const image = await readFile('tests/fixtures/evidence-2x1.png');
  const drawing = '<w:drawing><a:blip r:embed="image"/></w:drawing>';
  const build = (first: boolean) => document(`<w:tbl><w:tr><w:tc><w:p><w:r>${first ? drawing : ''}<w:t>第一处</w:t></w:r></w:p><w:p><w:r>${drawing}<w:t>第二处</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`, '<Relationship Id="image" Type="image" Target="media/image.png"/>', [['word/media/image.png', image]]);
  const changes = await compareDocuments(await build(true), await build(false));
  assert.ok(changes.some(item => item.kind === 'objectLost' && item.address === 't:0/r:0/c:0/p:0'));
  assert.ok(!changes.some(item => item.kind === 'objectLost' && item.address === 't:0/r:0/c:0/p:1'));
});

test('external object relationships preserve target and role across relationship ID changes', async () => {
  const build = (id: string, type: string, target: string) => document(`<w:p><w:r><w:object><o:OLEObject r:id="${id}"/></w:object><w:t>正文</w:t></w:r></w:p>`, `<Relationship Id="${id}" Type="${type}" Target="${target}" TargetMode="External"/>`);
  const before = await build('one', 'oleObject', 'https://example.com/object');
  assert.deepEqual(await compareDocuments(before, await build('two', 'oleObject', 'https://example.com/object')), []);
  for (const changed of [await build('two', 'otherRole', 'https://example.com/object'), await build('two', 'oleObject', 'https://example.com/other')]) {
    assert.ok((await compareDocuments(before, changed)).some(item => item.kind === 'objectLost'));
  }
});
