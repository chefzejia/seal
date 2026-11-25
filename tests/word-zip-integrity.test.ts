import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip, writeZip } from '../src/core/docx/zip.js';
import { validateZipIntegrity } from '../src/core/docx/zip-integrity.js';

test('zip integrity checks the actual uncompressed bytes and both headers', async () => {
  const zip = await writeZip(new Map([['word/document.xml', new TextEncoder().encode('<doc/>')]]));
  const entries = await readZip(zip);
  assert.doesNotThrow(() => validateZipIntegrity(zip, entries));
  const altered = new Map(entries);
  altered.set('word/document.xml', new TextEncoder().encode('<bad/>'));
  assert.throws(() => validateZipIntegrity(zip, altered));
  const broken = zip.slice();
  broken[14] ^= 1;
  assert.throws(() => validateZipIntegrity(broken, entries));
  assert.throws(() => validateZipIntegrity(zip.subarray(0, zip.length - 1), entries));
});
