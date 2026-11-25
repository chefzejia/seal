import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { readZip, writeZip } from '../src/core/docx/zip.js';
import { editableText } from '../src/core/docx/visible-surgery.js';

test('editing an actual ZIP preserves input and rejects the whole invalid batch', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const input = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>姓名：____ □同意</w:t></w:r></w:p></w:body></w:document>')],
  ]));
  const before = input.slice();
  const output = await editTextDocument(input, [
    { op: 'replace', at: 'p:0', find: '____', value: '张三', yellow: true },
    { op: 'check', at: 'p:0', option: '同意', checked: true },
  ]);
  assert.deepEqual(input, before);
  const xml = new TextDecoder().decode((await readZip(output)).get('word/document.xml'));
  assert.equal(editableText(xml), '姓名：张三 ☑同意');
  assert.match(xml, /<w:highlight w:val="yellow"\/>/);
  await assert.rejects(editTextDocument(input, [
    { op: 'replace', at: 'p:0', find: '____', value: '张三' },
    { op: 'replace', at: 'p:0', find: '不存在', value: 'x' },
  ]));
  assert.deepEqual(input, before);
});

test('every edit validates untouched image parts and can use a narrow image decoder port', async () => {
  const { readFile } = await import('node:fs/promises');
  const encode = (value: string) => new TextEncoder().encode(value);
  const make = async (image: Uint8Array, extension: string, mime: string) => writeZip(new Map([
    ['[Content_Types].xml', encode(`<Types><Default Extension="xml" ContentType="application/xml"/><Default Extension="${extension}" ContentType="${mime}"/></Types>`)],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>原文</w:t></w:r></w:p></w:body></w:document>')],
    [`word/media/untouched.${extension}`, image],
  ]));
  const png = await readFile('tests/fixtures/evidence-2x1.png');
  const good = await make(png, 'png', 'image/png');
  const bad = await make(png.subarray(0, png.length - 10), 'png', 'image/png');
  const before = bad.slice();
  const edits = [{ op: 'replace' as const, at: 'p:0', find: '原文', value: '填写' }];
  await editTextDocument(good, edits);
  await assert.rejects(editTextDocument(bad, edits), /word\/media\/untouched.png/);
  assert.deepEqual(bad, before);
  const gif = await make(await readFile('tests/fixtures/geometry.gif'), 'gif', 'image/gif');
  await assert.rejects(editTextDocument(gif, edits), /宿主|解码/);
  const { NodeHostPort } = await import('../src/shells/node-host.js');
  const decoder = new NodeHostPort();
  await editTextDocument(gif, edits, { validateImage: decoder.validateImage.bind(decoder) });
  await assert.rejects(editTextDocument(gif, edits, { validateImage: async () => { throw new Error('decoder rejected'); } }), /decoder rejected/);
});

test('row copies clone comment, footnote and endnote records with fresh body and story identities', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const namespaces = 'xmlns:w="word" xmlns:wp="drawing" xmlns:pic="picture" xmlns:w14="word14"';
  const row = '<w:tr><w:tc><w:p><w:commentRangeStart w:id="2"/><w:r><w:t>示例</w:t><w:footnoteReference w:id="2"/><w:endnoteReference w:id="2"/><w:commentReference w:id="2"/><w:drawing><wp:docPr id="7"/></w:drawing></w:r><w:commentRangeEnd w:id="2"/></w:p></w:tc></w:tr>';
  const parts = new Map<string, Uint8Array>([
    ['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>')],
    ['word/document.xml', encode(`<w:document ${namespaces}><w:body><w:tbl>${row}</w:tbl></w:body></w:document>`)],
    ['word/_rels/document.xml.rels', encode(`<Relationships>${['comment', 'footnote', 'endnote'].map((kind, index) => `<Relationship Id="r${index}" Type="urn:relationships/${kind}s" Target="${kind}s.xml"/>`).join('')}</Relationships>`)],
  ]);
  for (const [index, kind] of ['comment', 'footnote', 'endnote'].entries()) {
    parts.set(`word/${kind}s.xml`, encode(`<w:${kind}s ${namespaces}><w:${kind} w:id="2"><w:p w14:paraId="000000${index}A"><w:bookmarkStart w:id="4" w:name="Story${index}"/><w:r><w:t>${kind}记录</w:t><w:drawing><wp:docPr id="${20 + index * 2}"/><pic:cNvPr id="${21 + index * 2}"/></w:drawing></w:r><w:bookmarkEnd w:id="4"/></w:p></w:${kind}></w:${kind}s>`));
  }
  const source = await writeZip(parts), before = source.slice();
  const output = await readZip(await editTextDocument(source, [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['甲'], ['乙']] }]));
  assert.deepEqual(source, before);
  const document = new TextDecoder().decode(output.get('word/document.xml'));
  const allDrawings: string[] = [];
  for (const kind of ['comment', 'footnote', 'endnote']) {
    const story = new TextDecoder().decode(output.get(`word/${kind}s.xml`));
    assert.ok(story.includes(new TextDecoder().decode(parts.get(`word/${kind}s.xml`)).match(new RegExp(`<w:${kind} w:id="2">[\\s\\S]*</w:${kind}>`))![0]));
    const ids = [...story.matchAll(new RegExp(`<w:${kind} w:id="(\\d+)"`, 'g'))].map(match => match[1]);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual([...document.matchAll(new RegExp(`<w:${kind}Reference w:id="(\\d+)"`, 'g'))].map(match => match[1]), ids);
    for (const regex of [/w14:paraId="([^"]+)"/g, /<w:bookmarkStart w:id="([^"]+)"/g, /w:name="([^"]+)"/g]) {
      const values = [...story.matchAll(regex)].map(match => match[1]);
      assert.equal(new Set(values).size, 3);
    }
    allDrawings.push(...[...story.matchAll(/<(?:wp:docPr|pic:cNvPr) id="(\d+)"/g)].map(match => match[1]));
  }
  allDrawings.push(...[...document.matchAll(/<wp:docPr id="(\d+)"/g)].map(match => match[1]));
  assert.equal(new Set(allDrawings).size, allDrawings.length);
  assert.deepEqual([...document.matchAll(/<w:commentRangeStart w:id="(\d+)"/g)].map(match => match[1]), [...document.matchAll(/<w:commentReference w:id="(\d+)"/g)].map(match => match[1]));
  const missing = new Map(parts); missing.delete('word/comments.xml');
  await assert.rejects(editTextDocument(await writeZip(missing), [{ op: 'insert_rows', at: 't:0/r:0', mode: 'after', rows: [['甲']] }]));
});
