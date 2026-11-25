import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invalidDates } from '../src/core/bid/dates.js';

test('C11 recognizes impossible dates and valid leap years', () => {
  const text = '有效2028年2月29日；无效2027年2月29日与2026年13月1日。';
  const invalid = invalidDates(text);
  assert.deepEqual(invalid.map(item => item.text), ['2027年2月29日', '2026年13月1日']);
  for (const item of invalid) assert.equal(text.slice(item.offset, item.offset + item.text.length), item.text);
  assert.deepEqual(invalidDates('2026年 月 日'), []);
});
