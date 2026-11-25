import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { readZip, writeZip } from '../src/core/docx/zip.js';
import { parseDocumentBody, parseTableRows } from '../src/core/docx/xml.js';
import { editableText } from '../src/core/docx/visible-surgery.js';

test('editing an ordinary cell preserves adjacent nested table structure', async () => {
  const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const cell = (body: string) => `<w:tc><w:tcPr><w:tcW w:w="3000"/></w:tcPr>${body}</w:tc>`;
  const row = (cells: string) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells}</w:tr>`;
  const nested = `<w:tbl><w:tblPr><w:tblW w:w="3000"/></w:tblPr>${row(cell(p('')) + cell(p('')))}</w:tbl>`;
  const outer = `<w:tbl><w:tblPr><w:tblW w:w="6000"/></w:tblPr>${row(cell(p('固定标签')) + cell(p('') + nested + p('')))}${row(cell(p('投标人名称')) + cell(p('____')))}</w:tbl>`;
  const original = `<w:document xmlns:w="word"><w:body>${outer}${p('固定尾注')}<w:sectPr/></w:body></w:document>`;
  const encode = (value: string) => new TextEncoder().encode(value);
  const before = await writeZip(new Map([['word/document.xml', encode(original)], ['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')]]));
  const table = parseDocumentBody(original).blocks.find(block => block.kind === 'table')!;
  assert.equal(table.xml, outer); assert.deepEqual(parseTableRows(table.xml).map(item => item.cells.length), [2, 2]);
  const after = await editTextDocument(before, [{ op: 'replace', at: 't:0/r:1/c:1', find: '____', value: '甲公司', yellow: true }]);
  const xml = new TextDecoder().decode((await readZip(after)).get('word/document.xml'));
  assert.ok(xml.includes(nested)); assert.ok(editableText(xml).includes('甲公司')); assert.ok(xml.includes(p('固定尾注')));
  const broken = new Map(await readZip(before)); broken.set('word/document.xml', encode(original.replace('</w:tbl>', '</w:tc>')));
  await assert.rejects(editTextDocument(await writeZip(broken), []), /XML|xml/i);
});
