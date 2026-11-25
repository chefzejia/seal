import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { editableText } from '../src/core/docx/visible-surgery.js';
import { unescapeXml } from '../src/core/docx/xml.js';
import { readZip, writeZip } from '../src/core/docx/zip.js';

const enc = (text: string) => new TextEncoder().encode(text);
async function document(text: string) {
  return writeZip(new Map([
    ['word/document.xml', enc(`<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`) ],
    ['[Content_Types].xml', enc('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
  ]));
}

test('numeric entities decode once and retain raw text offsets during surgery', async () => {
  assert.equal(unescapeXml('&#x1F600; &#40; &amp;#65;'), '😀 ( &#65;');
  assert.throws(() => unescapeXml('&#0;'));
  const input = await document('😀&#91;姓名&#x5D; 固定 &amp;#65;');
  const output = await editTextDocument(input, [{ op: 'replace', at: 'p:0', find: '[姓名]', value: '张三' }]);
  const xml = new TextDecoder().decode((await readZip(output)).get('word/document.xml'));
  assert.equal(editableText(xml), '😀张三 固定 &#65;');
  assert.ok(xml.includes('&amp;#65;'));
});

for (const invalid of ['\u0001', '\ud800', '\udc00']) test(`illegal input code unit ${invalid.charCodeAt(0)} is rejected before encoding`, async () => {
  const input = await document('联系人：[姓名]');
  await assert.rejects(editTextDocument(input, [{ op: 'replace', at: 'p:0', find: '[姓名]', value: invalid }]), /XML|Unicode|字符/i);
});
