import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outline } from '../src/core/docx/outline.js';

test('outline uses explicit levels and mapped paragraph styles to bound sections', () => {
  const xml = '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>第一章</w:t></w:r></w:p><w:p><w:r><w:t>姓名：____</w:t></w:r></w:p><w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>子节</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>第二章</w:t></w:r></w:p></w:body></w:document>';
  const styles = '<w:styles><w:style w:styleId="H1"><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>';
  const result = outline(xml, styles);
  assert.deepEqual(result.map(item => [item.title, item.level, item.from, item.to]), [['第一章', 1, 'p:0', 't:0'], ['子节', 2, 'p:2', 't:0'], ['第二章', 1, 'p:3', 'p:3']]);
  assert.equal(result[0].hints, 2);
});

test('outline follows paragraph style inheritance and explicit body level overrides', () => {
  const paragraph = (property: string, text: string) => `<w:p><w:pPr>${property}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const styles = '<w:styles><w:style w:type="paragraph" w:styleId="Root"><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Root"/></w:style><w:style w:type="paragraph" w:styleId="Body"><w:basedOn w:val="Child"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style><w:style w:type="character" w:styleId="Char"><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Wrong"><w:basedOn w:val="Char"/></w:style></w:styles>';
  const xml = `<w:document><w:body>${paragraph('<w:pStyle w:val="Child"/>', '继承标题')}${paragraph('<w:pStyle w:val="Child"/><w:outlineLvl w:val="9"/>', '直接正文')}${paragraph('<w:pStyle w:val="Body"/>', '样式正文')}${paragraph('<w:pStyle w:val="Wrong"/>', '不同样式类型')}${paragraph('<w:outlineLvl w:val="1"/>', '直接子节')}</w:body></w:document>`;
  assert.deepEqual(outline(xml, styles).map(item => [item.title, item.level]), [['继承标题', 1], ['直接子节', 2]]);
});

test('outline reads heading names, defaults, and exact property ownership', () => {
  const styles = '<w:styles><w:style w:type="paragraph" w:styleId="default" w:default="1"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="custom"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Body"><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style></w:styles>';
  const xml = '<w:document><w:body><w:p><w:r><w:t>默认子节</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="custom"/></w:pPr><w:r><w:t>命名标题</w:t></w:r></w:p><w:p><w:pPr><w:outlineLvl w:val="9"/><w:pPrChange><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>旧属性不是现行大纲</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Body"/><w:pPrChange><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>只有历史级别</w:t></w:r></w:p></w:body></w:document>';
  assert.deepEqual(outline(xml, styles).map(item => [item.title, item.level]), [['默认子节', 2], ['命名标题', 1]]);
  assert.equal(outline('<w:document><w:body><w:p><w:r><w:t>文档默认</w:t></w:r></w:p></w:body></w:document>', '<w:styles><w:docDefaults><w:pPrDefault><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>')[0].level, 2);
});

test('cyclic style inheritance fails explicitly and heading selection is shared with insertion', async () => {
  const { headingStyles } = await import('../src/core/docx/outline.js');
  const styles = '<w:styles><w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Base"/></w:style></w:styles>';
  assert.equal(headingStyles(styles).get(3), 'Base');
  const cycle = '<w:styles><w:style w:styleId="A"><w:basedOn w:val="B"/></w:style><w:style w:styleId="B"><w:basedOn w:val="A"/></w:style></w:styles>';
  assert.throws(() => outline('<w:document><w:body><w:p><w:pPr><w:pStyle w:val="A"/></w:pPr></w:p></w:body></w:document>', cycle), /循环/);
});
