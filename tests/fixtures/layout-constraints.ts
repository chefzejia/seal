import { editTextDocument, type DocumentEdit } from '../../src/core/docx/text-document.js';
import { packageDocument, type MatrixPath } from './layout-matrix.js';

export const flowParagraph = (text: string) => `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="exact"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const margins = (top = 0, bottom = 0, left = 120, right = 120) => `<w:tcMar>${Object.entries({top,bottom,left,right}).map(([edge,width]) => `<w:${edge} w:w="${width}" w:type="dxa"/>`).join('')}</w:tcMar>`;
const cell = (content: string, properties = '') => `<w:tc><w:tcPr>${properties}</w:tcPr>${content}</w:tc>`;
export function constraintTable(content: string, options: { rule?: string; height?: number; top?: number; bottom?: number; left?: number; right?: number; merged?: boolean; width?: number } = {}): string {
  const width = options.width ?? 9360, first = options.merged ? 7000 : width / 2, second = width - first;
  const grid = options.merged ? [3000,4000,second] : [first,second];
  return `<w:tbl><w:tblPr><w:tblW w:w="${width}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid.map(width=>`<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid><w:tr><w:trPr>${options.rule ? `<w:trHeight w:val="${options.height ?? 4000}" w:hRule="${options.rule}"/>` : ''}</w:trPr>${cell(content,`<w:tcW w:w="${first}" w:type="dxa"/>${options.merged ? '<w:gridSpan w:val="2"/>' : ''}${margins(options.top,options.bottom,options.left,options.right)}`)}${cell(flowParagraph('相邻列完整'))}</w:tr><w:tr>${cell(flowParagraph('下一行完整'))}${cell(flowParagraph('下一行右侧完整'))}</w:tr></w:tbl>`;
}
export interface ConstraintCase { id: string; body: string; at: string; section?: string; styles?: string; label?: string; maxWidth?: number; }
const anchor = flowParagraph('定位');
const column = (widths: number[]) => `<w:cols w:num="2" w:equalWidth="0">${widths.map((width,index)=>`<w:col w:w="${width}"${index===0 ? ' w:space="600"' : ''}/>`).join('')}</w:cols>`;
const style = '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:pPr><w:ind w:left="400" w:right="300" w:firstLine="470" w:firstLineChars="196"/></w:pPr><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:basedOn w:val="Normal"/></w:style></w:styles>';
export const constraintCases: ConstraintCase[] = [
  ...['auto','atLeast','exact'].flatMap(rule => [0,3].map(count => ({id:`row-${rule}-${count}`,body:constraintTable(Array.from({length:count},(_,index)=>flowParagraph(`已有内容${index}`)).join('')+anchor,{rule,height:4000,top:100,bottom:200}),at:`t:0/r:0/c:0/p:${count}`,label:'持证方：合成约束企业'}))),
  {id:'exact-1200',body:constraintTable(anchor,{rule:'exact',height:1200}),at:'t:0/r:0/c:0/p:0'},
  {id:'exact-1200-caption',body:constraintTable(anchor,{rule:'exact',height:1200}),at:'t:0/r:0/c:0/p:0',label:'持证方：合成企业'},
  {id:'vertical-margins',body:constraintTable(anchor,{top:2000,bottom:2000,left:400,right:300})+flowParagraph('表后原文完整'),at:'t:0/r:0/c:0/p:0',label:'持证方：上下边距企业'},
  {id:'nested-margins',body:constraintTable(anchor+constraintTable(anchor,{top:600,bottom:700,width:4440})+flowParagraph('外层尾文完整'),{top:800,bottom:900}),at:'t:0/r:0/c:0/t:0/r:0/c:0/p:0',label:'（图片待核对1）'},
  {id:'merged-exact',body:constraintTable(anchor,{rule:'exact',height:4000,merged:true,top:200,bottom:300}),at:'t:0/r:0/c:0/p:0',label:'持证方：合并格企业'},
  ...[[5760,3000],[3000,5760]].map((widths,index)=>({id:`natural-columns-${index}`,body:Array.from({length:63},(_,i)=>flowParagraph(`自然流动前文${i}`)).join('')+anchor+Array.from({length:70},(_,i)=>flowParagraph(`自然流动后文${i}`)).join(''),at:'p:63',section:column(widths),maxWidth:3000})),
  {id:'explicit-columns',body:anchor+'<w:p><w:r><w:br w:type="column"/></w:r></w:p>'+anchor,at:'p:2',section:column([3000,5760]),maxWidth:3000,label:'持证方：显式栏企业'},
  {id:'page-columns',body:'<w:p><w:r><w:br w:type="page"/></w:r></w:p>'+anchor,at:'p:1',section:column([5760,3000]),maxWidth:3000,label:'（图片待核对1）'},
  ...['<w:ind w:left="400" w:right="300" w:firstLine="600"/>','<w:ind w:left="600" w:right="200" w:hanging="400"/>','<w:ind w:leftChars="200" w:rightChars="100" w:firstLineChars="196" w:firstLine="470"/>','<w:pStyle w:val="Child"/>'].map((properties,index)=>({id:`paragraph-indent-${index}`,body:`<w:p><w:pPr>${properties}</w:pPr><w:r><w:t>定位</w:t></w:r></w:p>`,at:'p:0',styles:style,label:index%2 ? '（图片待核对1）' : undefined})),
];

export async function constrainedDocument(item: ConstraintCase, route: MatrixPath, image: Uint8Array): Promise<{base: Uint8Array; output: Uint8Array}> {
  let base = await packageDocument(item.body,item.section,item.styles), at=item.at;
  let edit: DocumentEdit;
  if(route==='staged-table') {
    base=await editTextDocument(base,[{op:'insert',at,position:'after',markdown:'| 证据 | 备注 |\n| --- | --- |\n|  | 新表备注完整 |'}]);
    at=at.includes('/c:') ? at.replace(/p:\d+$/,'t:0/r:1/c:0') : 't:0/r:1/c:0';
    edit={op:'insert_image',at,image,imageLabel:item.label,captioned:!!item.label};
  } else if(route==='same-markdown') edit={op:'insert',at,position:'after',markdown:'| 证据 | 备注 |\n| --- | --- |\n| ![证据](image.png) | 新表备注完整 |',images:[image],imageCaptions:[item.label]};
  else if(route==='paragraph-markdown') edit={op:'insert',at,position:'after',markdown:'![证据](image.png)',images:[image],imageCaptions:[item.label]};
  else edit={op:'insert_image',at,image,imageLabel:item.label,captioned:!!item.label};
  return {base,output:await editTextDocument(base,[edit])};
}
