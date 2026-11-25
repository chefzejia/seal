import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBlankHints } from '../src/core/docx/blank-hints.js';

test('blank hints are ordered, stable and include their original spans', () => {
  const text = '姓名：____ 日期：年 月 日 选择：□是 □否 【提供证明复印件】';
  const hints = detectBlankHints('p:0', text);
  assert.deepEqual(hints, detectBlankHints('p:0', text));
  assert.deepEqual(hints.map(hint => hint.id), hints.map((_, index) => `p:0#${index}`));
  assert.deepEqual(hints.map(hint => hint.kind), ['underline', 'date', 'checkbox', 'checkbox', 'attachment']);
  for (const hint of hints) assert.equal(text.slice(hint.start, hint.end), hint.text);
});

test('fixed text is not implicitly a writable placeholder', () => {
  assert.deepEqual(detectBlankHints('p:1', '联系人已经确认，合同于2026年11月16日签署。'), []);
});
