import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePackageImages } from '../src/core/docx/package-images.js';
import { validateImageBytes } from '../src/core/docx/zip.js';
import { NodeHostPort } from '../src/shells/node-host.js';

test('C01 decodes registered image parts and reports unsupported or corrupt images', async () => {
  const png = await readFile('tests/fixtures/evidence-2x1.png');
  const jpeg = await readFile('tests/fixtures/evidence-2x1.jpeg');
  const wmf = await readFile('tests/fixtures/geometry.wmf');
  const types = '<Types><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="wmf" ContentType="image/x-wmf"/><Default Extension="xml" ContentType="application/xml"/></Types>';
  const entries = new Map<string, Uint8Array>([
    ['[Content_Types].xml', new TextEncoder().encode(types)],
    ['word/media/a.png', png], ['word/media/b.jpg', jpeg], ['word/media/c.wmf', wmf],
    ['word/activeX/control.xml', new TextEncoder().encode('<control/>')],
  ]);
  assert.deepEqual(await validatePackageImages(entries, new NodeHostPort()), []);
  const host = new NodeHostPort();
  await validateImageBytes(await host.normalizeImage(wmf, 'picture.wmf'), 'image/png');
  await assert.rejects(host.normalizeImage(new Uint8Array([0, 1, 2]), 'picture.wmf'));
  const noDecoder = await validatePackageImages(entries, {});
  assert.deepEqual(noDecoder.map(issue => issue.part), ['word/media/c.wmf']);
  entries.set('word/media/a.png', png.subarray(0, png.length - 10));
  entries.set('word/media/c.wmf', new Uint8Array([0, 1, 2]));
  const issues = await validatePackageImages(entries, new NodeHostPort());
  assert.deepEqual(issues.map(issue => issue.part), ['word/media/a.png', 'word/media/c.wmf']);
});

test('JPEG entropy data must decode, not merely contain valid frame and scan headers', async () => {
  const jpeg = new Uint8Array(await readFile('tests/fixtures/evidence-2x1.jpeg'));
  await validateImageBytes(jpeg, 'image/jpeg');
  const scan = jpeg.findIndex((byte, index) => byte === 0xff && jpeg[index + 1] === 0xda);
  assert.ok(scan >= 0);
  const start = scan + 2 + (jpeg[scan + 2] << 8 | jpeg[scan + 3]);
  const end = jpeg.length - 2;
  assert.ok(end - start > 1);
  jpeg.fill(0, start, end);
  await assert.rejects(validateImageBytes(jpeg, 'image/jpeg'));
});

test('other supported image formats decode before conversion; corrupt and unsupported images fail', async () => {
  const host = new NodeHostPort();
  for (const [extension, mime] of [['gif', 'image/gif'], ['tiff', 'image/tiff'], ['svg', 'image/svg+xml'], ['emf', 'image/x-emf'], ['bmp', 'image/bmp']] as const) {
    const bytes = await readFile(`tests/fixtures/geometry.${extension}`);
    await host.validateImage(bytes, mime);
    await assert.rejects(host.validateImage(bytes.subarray(0, 10), mime));
    const png = await host.normalizeImage(bytes, `picture.${extension}`);
    await validateImageBytes(png, 'image/png');
  }
  await assert.rejects(host.validateImage(await readFile('tests/fixtures/geometry.bmp'), 'image/unknown'));
});

test('image validation only requires the decoder capability and overrides obey the declared actual image type', async () => {
  const image = await readFile('tests/fixtures/evidence-2x1.png');
  const entries = new Map<string, Uint8Array>([
    ['[Content_Types].xml', new TextEncoder().encode('<Types><Override PartName="/word/media/no-extension" ContentType="image/png"/></Types>')],
    ['word/media/no-extension', image],
  ]);
  assert.deepEqual(await validatePackageImages(entries, {}), []);
  entries.set('word/media/no-extension', image.subarray(0, 12));
  const issues = await validatePackageImages(entries, {});
  assert.equal(issues.length, 1);
  assert.equal(issues[0].part, 'word/media/no-extension');
});
