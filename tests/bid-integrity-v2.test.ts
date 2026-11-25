import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAuthorization } from '../src/core/bid/authorization.js';
import { checkIntegrity } from '../src/core/bid/integrity.js';
import { sha256Hex } from '../src/core/docx/zip.js';

test('C15 detects external draft changes and stale or forged authorizations', async () => {
  const secret = new Uint8Array(32).fill(21), draft = new TextEncoder().encode('draft');
  const expected = { kind: 'confirm' as const, project: 'project', item: 'pending', fingerprint: 'value-a' };
  const record = await signAuthorization(secret, expected);
  const input = { secret, drafts: { volume: draft }, expectedDrafts: { volume: sha256Hex(draft) }, authorizations: [{ expected, record }] };
  assert.deepEqual(await checkIntegrity(input), []);
  assert.equal((await checkIntegrity({ ...input, drafts: { volume: new TextEncoder().encode('changed') } }))[0].code, 'C15');
  assert.equal((await checkIntegrity({ ...input, authorizations: [{ expected: { ...expected, fingerprint: 'value-b' }, record }] }))[0].code, 'C15');
  assert.equal((await checkIntegrity({ ...input, authorizations: [{ expected, record: { ...record, signature: '0'.repeat(64) } }] }))[0].code, 'C15');
});
