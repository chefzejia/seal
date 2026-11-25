import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { HostPort } from '../src/core/host.js';
import { finalizeDocument } from '../src/core/docx/finalize-document.js';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { readZip, sha256Hex, writeZip } from '../src/core/docx/zip.js';
import { NodeHostPort } from '../src/shells/node-host.js';

const encode = (value: string) => new TextEncoder().encode(value);
async function packageOf(image: Uint8Array, type: 'png' | 'gif'): Promise<Uint8Array> {
  return writeZip(new Map([
    ['[Content_Types].xml', encode(`<Types><Default Extension="xml" ContentType="application/xml"/><Default Extension="${type}" ContentType="image/${type}"/></Types>`) ],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:body></w:document>')],
    [`word/media/a.${type}`, image],
  ]));
}
const context = (draft: Uint8Array, base: Uint8Array) => ({ draftSha256: sha256Hex(draft), baseSha256: sha256Hex(base), marks: [{ id: 'a', state: 'confirmed' as const, originalHighlights: [null] }] });

test('finalization validates both inputs and preserves unrelated image bytes', async () => {
  const png = new Uint8Array(await readFile('tests/fixtures/evidence-2x1.png'));
  const base = await packageOf(png, 'png');
  const draft = await editTextDocument(base, [{ op: 'mark_pending', at: 'p:0', find: '甲', seal: { name: '_Seal_P_a', id: 1 } }]);
  const output = await finalizeDocument(draft, base, context(draft, base), {} as HostPort);
  assert.deepEqual((await readZip(output)).get('word/media/a.png'), png);
  const bad = await packageOf(png.subarray(0, png.length - 10), 'png');
  await assert.rejects(finalizeDocument(bad, base, context(bad, base), {} as HostPort), /图片/);
  await assert.rejects(finalizeDocument(draft, bad, context(draft, bad), {} as HostPort), /图片/);
  const brokenZip = draft.slice(); brokenZip[0] = 0;
  await assert.rejects(finalizeDocument(brokenZip, base, context(brokenZip, base), {} as HostPort));
});

test('output image decoding executes and a failure prevents finalization', async () => {
  const gif = new Uint8Array(await readFile('tests/fixtures/geometry.gif'));
  const base = await packageOf(gif, 'gif'), real = new NodeHostPort();
  const draft = await editTextDocument(base, [{ op: 'mark_pending', at: 'p:0', find: '甲', seal: { name: '_Seal_P_a', id: 1 } }], real);
  let calls = 0;
  const decoder = { validateImage: async (bytes: Uint8Array, mime: string) => { calls++; await real.validateImage(bytes, mime); } } as HostPort;
  await finalizeDocument(draft, base, context(draft, base), decoder);
  assert.equal(calls, 3);
  calls = 0;
  const failing = { validateImage: async (bytes: Uint8Array, mime: string) => { if (++calls === 3) throw new Error('output decoder failure'); await real.validateImage(bytes, mime); } } as HostPort;
  await assert.rejects(finalizeDocument(draft, base, context(draft, base), failing), /图片/);
  assert.equal(calls, 3);
});
