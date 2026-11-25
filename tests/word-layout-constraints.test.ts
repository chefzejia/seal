import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { auditImageLayout,layoutBox } from '../src/core/docx/layout.js';
import { readZip } from '../src/core/docx/zip.js';
import { editTextDocument } from '../src/core/docx/text-document.js';
import { xmlElements } from '../src/core/docx/xml.js';
import { xmlAttributes } from '../src/core/docx/outline.js';
import { constraintCases,constrainedDocument,constraintTable,flowParagraph } from './fixtures/layout-constraints.js';
import { packageDocument,paths } from './fixtures/layout-matrix.js';

const long=sharp({create:{width:1239,height:1827,channels:3,background:'#e9edee'}}).png().toBuffer();
const xmlOf=async(bytes:Uint8Array)=>new TextDecoder().decode((await readZip(bytes)).get('word/document.xml'));
const drawing=(width:number,height:number)=>`<w:r><w:drawing><wp:inline><wp:extent cx="${width}" cy="${height}"/><wp:docPr id="1" name="Seal image 1"/></wp:inline></w:drawing></w:r>`;
const doc=(body:string,section='')=>`<w:document><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>${section}</w:sectPr></w:body></w:document>`;
for(const [id,xml] of [
  ['exact',doc(constraintTable(flowParagraph('锚点')+`<w:p>${drawing(2819400,4157420)}</w:p>`,{rule:'exact',height:1200}))],
  ['vertical',doc(constraintTable(`<w:p>${drawing(4000000,7500000)}</w:p>`,{top:2000,bottom:2000}))],
  ['natural',doc(`<w:p>${drawing(3657600,5393410)}</w:p>`,'<w:cols w:num="2" w:equalWidth="0"><w:col w:w="5760" w:space="600"/><w:col w:w="3000"/></w:cols>')],
  ['indent',doc(`<w:p><w:pPr><w:ind w:firstLine="470" w:firstLineChars="196"/></w:pPr>${drawing(9360*635,1000000)}</w:p>`) ],
  ['inline-prefix',doc(`<w:p><w:r><w:t>已有同行文字</w:t></w:r>${drawing(9360*635,1000000)}</w:p>`) ],
] as const)test(`serialized legacy ${id} overflow is independently visible to C16`,()=>assert.equal(auditImageLayout(xml).length,1));

for(const item of constraintCases)for(const route of paths)test(`constraint ${item.id} / ${route}`,async()=>{
  const {base,output}=await constrainedDocument(item,route,await long),xml=await xmlOf(output);
  if(route==='staged-table'&&item.at.includes('/c:')) {
    const baseXml=await xmlOf(base),baseNodes=xmlElements(baseXml);
    for(const [index,node]of baseNodes.entries())if(node.name==='w:tc')assert.equal(baseNodes.filter(child=>child.parent===index&&['w:p','w:tbl'].includes(child.name)).at(-1)?.name,'w:p','staged nested tables retain the required terminal cell paragraph');
  }
  assert.deepEqual(auditImageLayout(xml,item.styles),[]);
  const ext=/<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)!;
  assert.ok(Number(ext[1])>0&&Number(ext[2])>0);
  assert.ok(Math.abs(Number(ext[1])*1827-Number(ext[2])*1239)<=1827,'integer-rounding-only aspect ratio');
  if(item.maxWidth)assert.ok(Number(ext[1])<=item.maxWidth*635,'all possible columns bound the packet');
  if(item.id==='exact-1200')assert.ok(Number(ext[2])<(1200-240)*635,'existing anchor and image baseline occupy row space');
  if(item.id==='exact-1200-caption')assert.ok(Number(ext[2])<=(1200-240-240-120-20)*635,'caption line, image baseline and terminal paragraph are separate occupied space');
  const nodes=xmlElements(xml),drawingIndex=nodes.findIndex(node=>node.name==='w:drawing');
  let p=nodes[drawingIndex].parent;while(p!==null&&nodes[p].name!=='w:p')p=nodes[p].parent;
  const pPr=nodes.findIndex(node=>node.parent===p&&node.name==='w:pPr'),ind=nodes.find(node=>node.parent===pPr&&node.name==='w:ind')!;
  for(const key of ['left','right','firstLine','hanging','leftChars','rightChars','firstLineChars','hangingChars'])assert.equal(xmlAttributes(xml,ind).get(`w:${key}`),'0','picture paragraph cancels inherited positioning in both unit systems');
  for(const source of (await xmlOf(base)).match(/<w:trPr[\s\S]*?<\/w:trPr>|<w:tcPr[\s\S]*?<\/w:tcPr>|<w:sectPr[\s\S]*?<\/w:sectPr>/g)??[])assert.ok(xml.includes(source),'original row/cell/section properties retained');
  for(const text of ['相邻列完整','下一行完整','表后原文完整','外层尾文完整'])if((await xmlOf(base)).includes(text))assert.ok(xml.includes(text));
});

test('fixed rows account for multiple pictures and zero capacity remains a reportable draft',async()=>{
  const base=await packageDocument(constraintTable(flowParagraph('定位'),{rule:'exact',height:4000}));
  const output=await editTextDocument(base,[{op:'insert',at:'t:0/r:0/c:0/p:0',position:'after',markdown:'![一](a.png)\n\n![二](b.png)',images:[await long,await long],pendingImages:true}]);
  const xml=await xmlOf(output);assert.deepEqual(auditImageLayout(xml),[]);
  const sizes=[...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)];assert.equal(sizes.length,2);
  assert.ok(sizes.reduce((sum,item)=>sum+Number(item[2]),0)<4000*635);
  assert.equal((xml.match(/w:keepLines/g)??[]).length,2,'ordinary pending labels form atomic packets');
  assert.equal((xml.match(/w:cantSplit/g)??[]).length,2,'both ordinary labels use indivisible evidence rows');
  const impossible=await packageDocument(constraintTable(flowParagraph('定位'),{rule:'exact',height:100}));
  const draft=await editTextDocument(impossible,[{op:'insert_image',at:'t:0/r:0/c:0/p:0',image:await long}]);
  const bad=await xmlOf(draft);assert.equal(auditImageLayout(bad).length,1);
  assert.equal(layoutBox(bad,bad.indexOf('<w:drawing')).height,0,'zero capacity is never clamped into a valid box');
});

test('ordinary direct pending labels use an indivisible image packet without holder captions',async()=>{
  const base=await packageDocument(constraintTable(flowParagraph('定位')));
  const output=await editTextDocument(base,[{op:'insert_image',at:'t:0/r:0/c:0/p:0',image:await long,imageLabel:'（图片待核对1）',pending:true}]);
  const xml=await xmlOf(output);
  assert.equal((xml.match(/w:cantSplit/g)??[]).length,1);
  assert.match(xml,/<w:br\/><w:drawing/,'ordinary label and image occupy separate lines of the same packet');
  assert.deepEqual(auditImageLayout(xml),[]);
});

test('vertical style margins and inherited character indents constrain serialized pictures per attribute',()=>{
  const styles='<w:styles><w:style w:type="table" w:default="1" w:styleId="Table"><w:tblPr><w:tblCellMar><w:top w:w="800" w:type="dxa"/><w:bottom w:w="900" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr><w:ind w:left="400" w:right="300" w:firstLineChars="200"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Normal"/><w:pPr><w:ind w:right="100"/></w:pPr></w:style></w:styles>';
  const xml=doc('<w:tbl><w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:pPr><w:pStyle w:val="Child"/></w:pPr>'+drawing(9360*635,1000000)+'</w:p></w:tc></w:tr></w:tbl>');
  const box=layoutBox(xml,xml.indexOf('<w:drawing'),{stylesXml:styles});
  assert.equal(box.width,(9360-240-400-100-440)*635);
  assert.equal(box.height,(12960-800-900-360)*635);
  assert.equal(auditImageLayout(xml,styles).length,1);
});
