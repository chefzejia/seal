import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentHints, sameHint, type DismissalRecord } from '../src/core/bid/dismissals.js';

test('hints are recalculated from current text and a changed block invalidates its dismissal', () => {
  const doc = (text: string) => `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  const initial = currentHints(doc('姓名：____ 电话：____'), 'bid');
  assert.equal(initial.length, 2);
  const hint = initial[1];
  const dismissal: DismissalRecord = { draft: hint.draft, address: hint.address, blockFingerprint: hint.blockFingerprint, hintText: hint.hintText, hintIndex: hint.hintIndex, reason: '不适用', actor: 'agent' };
  assert.ok(sameHint(dismissal, initial[1]));
  const updated = currentHints(doc('姓名：张三 电话：____'), 'bid');
  assert.equal(updated.length, 1);
  assert.equal(updated[0].hintText, '____');
  assert.ok(!sameHint(dismissal, updated[0]));
  assert.equal(currentHints(doc('姓名：某人 电话：123'), 'bid').length, 0);
});
