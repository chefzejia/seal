import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeZip } from '../src/core/docx/zip.js';
import { validatePackageStructure } from '../src/core/docx/package-structure.js';

const encode = (text: string) => new TextEncoder().encode(text);
function entries() {
  return new Map([
    ['[Content_Types].xml', encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>')],
    ['_rels/.rels', encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="word/document.xml" Type="document"/></Relationships>')],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body/></w:document>')],
    ['word/_rels/document.xml.rels', encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="media/one.png" Type="image"/></Relationships>')],
    ['word/media/one.png', new Uint8Array([1, 2, 3])],
  ]);
}

test('package structure resolves relationships and registrations', async () => {
  assert.equal((await validatePackageStructure(await writeZip(entries()))).size, 5);
  const missing = entries();
  missing.delete('word/media/one.png');
  await assert.rejects(validatePackageStructure(await writeZip(missing)), /关系目标不存在/);
  const unregistered = entries();
  unregistered.set('word/file.xyz', new Uint8Array([0]));
  await assert.rejects(validatePackageStructure(await writeZip(unregistered)), /内容类型/);
});
