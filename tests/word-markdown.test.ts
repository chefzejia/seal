import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SaxesParser } from 'saxes';
import { markdownBlocks } from '../src/core/docx/markdown.js';
import { editableText } from '../src/core/docx/visible-surgery.js';

test('Markdown produces styled headings, paragraphs, lists and tables', () => {
  const result = markdownBlocks('# 标题\n\n正文 **粗体** 与 *斜体*。\n\n- 第一项\n- 第二项\n\n| 名称 | 内容 |\n| --- | --- |\n| 甲 | 乙 |', { headingStyles: new Map([[1, 'Heading1']]) });
  assert.deepEqual(result.missingHeadings, []);
  assert.match(result.xml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(result.xml, /<w:b\/>/);
  assert.match(result.xml, /<w:i\/>/);
  assert.match(result.xml, /<w:tbl>/);
  assert.match(editableText(result.xml), /标题正文 粗体 与 斜体。/);
  assert.match(editableText(result.xml), /第一项/);
  assert.doesNotThrow(() => new SaxesParser({ xmlns: true }).write(`<root xmlns:w="word">${result.xml}</root>`).close());
});

test('missing heading styles are reported and HTML or unresolved images are rejected', () => {
  assert.deepEqual(markdownBlocks('## 标题').missingHeadings, [2]);
  assert.throws(() => markdownBlocks('<script>bad</script>'));
  assert.throws(() => markdownBlocks('![x](image.png)'));
});
