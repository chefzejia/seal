import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paragraphText, paragraphView } from '../src/core/docx/visible-text.js';

test('paragraph text preserves visible text, tabs, breaks and decoded entities', () => {
  const xml = '<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>中文</w:t><w:br/><w:t>末行</w:t></w:r></w:p>';
  assert.equal(paragraphText(xml), 'A&B\t中文\n末行');
});

test('text boxes, deleted text and hidden runs are not editable visible text', () => {
  const xml = '<w:p><w:r><w:t>显示</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>隐藏</w:t></w:r><w:del><w:r><w:t>删除</w:t></w:r></w:del><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></w:p>';
  assert.equal(paragraphText(xml), '显示');
  assert.equal(paragraphView(xml), '显示‹隐藏›隐藏‹/隐藏›');
  assert.equal(paragraphText('<w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>显示</w:t></w:r></w:p>'), '显示');
});

test('view identifies drawing and embedded object locations', () => {
  assert.equal(paragraphView('<w:p><w:r><w:t>前</w:t><w:drawing/><w:object/><w:t>后</w:t></w:r></w:p>'), '前[图片][对象]后');
});

test('paragraph tab-stop properties are not visible tab characters', () => {
  const xml = '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="100"/></w:tabs></w:pPr><w:r><w:t>正文</w:t></w:r></w:p>';
  assert.equal(paragraphText(xml), '正文');
  assert.equal(paragraphView(xml), '正文');
});
