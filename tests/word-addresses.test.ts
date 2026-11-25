import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAddress } from '../src/core/docx/addresses.js';

const xml = `<w:document><w:body>
  <w:p><w:r><w:t>first</w:t></w:r><w:txbxContent><w:p><w:r><w:t>textbox</w:t></w:r></w:p></w:txbxContent></w:p>
  <w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>
  <w:p><w:r><w:t>last</w:t></w:r></w:p>
</w:body></w:document>`;

test('addresses count top-level blocks and nested cells independently', () => {
  assert.match(resolveAddress(xml, 'p:1').xml, />last</);
  assert.match(resolveAddress(xml, 't:0/r:0/c:0/p:0').xml, />outer</);
  assert.match(resolveAddress(xml, 't:0/r:0/c:0/t:0/r:0/c:0/p:0').xml, />inner</);
  assert.equal(resolveAddress(xml, 't:0/r:0').kind, 'row');
});

test('invalid, absent and inaccessible addresses fail', () => {
  for (const address of ['p:2', 'p:00', 't:0/c:0', 't:0/r:1', 'p:0/p:0', 't:0/r:0/c:0/p:1']) {
    assert.throws(() => resolveAddress(xml, address), /地址/);
  }
});
