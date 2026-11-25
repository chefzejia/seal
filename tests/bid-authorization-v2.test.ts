import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentAuthorization, signAuthorization, verifyAuthorization } from '../src/core/bid/authorization.js';

test('human authorization is bound to the project, item, kind and content fingerprint', async () => {
  const secret = new Uint8Array(32).fill(17);
  const record = await signAuthorization(secret, { kind: 'confirm', project: 'project-a', item: 'pending-1', fingerprint: 'digest-a' });
  assert.equal(await verifyAuthorization(secret, record), true);
  for (const payload of [
    { ...record.payload, project: 'project-b' },
    { ...record.payload, item: 'pending-2' },
    { ...record.payload, fingerprint: 'digest-b' },
    { ...record.payload, kind: 'accept' as const },
  ]) assert.equal(await verifyAuthorization(secret, { ...record, payload }), false);
  assert.equal(await verifyAuthorization(new Uint8Array(32).fill(18), record), false);
  assert.equal(await verifyAuthorization(secret, { ...record, signature: '0000' }), false);
  assert.equal(await verifyAuthorization(secret, null), false);
  assert.equal(await verifyAuthorization(secret, { signature: record.signature, payload: {} }), false);
  assert.equal(await isCurrentAuthorization(secret, record, record.payload), true);
  assert.equal(await isCurrentAuthorization(secret, record, { ...record.payload, fingerprint: 'later-value' }), false);
});
