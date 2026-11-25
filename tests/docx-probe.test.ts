import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip, writeZip } from '../src/core/docx/zip.js';
import { probeDocx } from '../src/shells/dsh/docx-probe.js';
import { workflowTemplate } from './fixtures/workflow-template.js';

test('template probe rejects malformed document XML and accepts legal entity references', async () => {
  const entries = await readZip(await workflowTemplate());
  const original = new TextDecoder().decode(entries.get('word/document.xml'));
  assert.match(original, /投标人名称/);
  const encode = async (xml: string) => { const copy = new Map(entries); copy.set('word/document.xml', new TextEncoder().encode(xml)); return Buffer.from(await writeZip(copy)); };
  const malformed: Array<[string, string]> = [
    ['undefined entity', original.replace('投标人名称', '投标人&undefinedEntity;名称')],
    ['invalid numeric entity', original.replace('投标人名称', '&#0;')],
    ['bare ampersand', original.replace('投标人名称', '投标人&名称')],
    ['duplicate attribute', original.replace('<w:document ', '<w:document a="1" a="2" ')],
    ['undeclared namespace', original.replace('<w:body>', '<w:body><bad:item/>')],
    ['multiple roots', original + '<extra/>'],
    ['external entity declaration', '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + original.replace('投标人名称', '&x;')],
  ];
  for (const [name, xml] of malformed) {
    const bytes = await encode(xml);
    assert.throws(() => probeDocx(bytes), /Word 文件损坏或无法读取/, name);
  }
  probeDocx(await encode(original));
  probeDocx(await encode(original.replace('投标人名称', '&lt; &amp; &gt; &apos; &quot; &#65; &#x1F600;')));
});
