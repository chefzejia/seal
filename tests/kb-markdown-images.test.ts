import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownImageTokens } from '../src/core/docx/markdown.js';

test('Markdown lexer preserves balanced, escaped and encoded KB image paths', () => {
  const balanced = markdownImageTokens('![证据](<kb:record-id/files/record-id/报告 (2026) 1.png>)');
  assert.equal(balanced.images[0]?.href, 'kb:record-id/files/record-id/报告 (2026) 1.png');

  const escaped = markdownImageTokens(String.raw`![证据](kb:record-id/files/record-id/报告\(2026\)1.png)`);
  assert.equal(escaped.images[0]?.href, 'kb:record-id/files/record-id/报告(2026)1.png');

  const encoded = markdownImageTokens('![证据](kb:record-id/files/record-id/%E6%8A%A5%E5%91%8A%20%282026%29%201.png)');
  assert.equal(encoded.images[0]?.href, 'kb:record-id/files/record-id/%E6%8A%A5%E5%91%8A%20%282026%29%201.png');
});
