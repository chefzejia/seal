import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile,readdir,unlink} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {constraintCases,constrainedDocument} from './fixtures/layout-constraints.js';
import {paths,type MatrixPath} from './fixtures/layout-matrix.js';
import {editTextDocument} from '../src/core/docx/text-document.js';
import {readZip,sha256Hex} from '../src/core/docx/zip.js';
import {auditImageLayout} from '../src/core/docx/layout.js';
const root=path.resolve(process.env.SEAL_LAYOUT_REPAIR_OUTPUT??'.tmp/evidence/milestone-29/worker/repair-1');
const tester=process.env.SEAL_LAYOUT_TESTER;if(!tester)throw new Error('SEAL_LAYOUT_TESTER must explicitly select copied acceptance inputs');
const docs=path.join(root,'documents'),inputs=path.join(root,'inputs'),render=path.join(root,'render');
for(const dir of [docs,inputs,render,path.join(root,'combinations')])await mkdir(dir,{recursive:true});
const image=await readFile(path.join(tester,'inputs/matrix-evidence.png')),certificate=await readFile(path.join(tester,'inputs/real-cert.png'));
const decoder=new TextDecoder(),records:Array<{id:string;source?:string;sha256:string}>=[];
const save=async(id:string,bytes:Uint8Array,source?:string)=>{
 const parts=await readZip(bytes),xml=decoder.decode(parts.get('word/document.xml')),issues=auditImageLayout(xml,decoder.decode(parts.get('word/styles.xml')??new Uint8Array()));assert.deepEqual(issues,[],id);
 await writeFile(path.join(docs,`${id}.docx`),bytes);records.push({id,source,sha256:sha256Hex(bytes)});
};
for(const [index,item]of constraintCases.entries()){
 for(const route of paths){const {output}=await constrainedDocument(item,route,image);await writeFile(path.join(root,'combinations',`${item.id}--${route}.docx`),output);}
 const route:MatrixPath=paths[index%paths.length];
 let {output}=await constrainedDocument(item,route,image);
 output=await editTextDocument(output,[{op:'insert',at:item.body.startsWith('<w:tbl')?'t:0':'p:0',position:'before',markdown:`**${item.id} / ${route}**`}]);
 await save(item.id,output);
}
for(const [id,baseRelative,at,route,label,real]of [
 ['exact-direct','inputs/exact-height.docx','t:0/r:0/c:0/p:0','direct','',true],
 ['exact-markdown','inputs/exact-height.docx','t:0/r:0/c:0/p:0','markdown','',false],
 ['exact-caption','inputs/exact-height.docx','t:0/r:0/c:0/p:0','direct','持证方：合成配套方',true],
 ['vertical-direct','inputs/vertical-margins.docx','t:0/r:0/c:0/p:0','direct','',false],
 ['vertical-caption','inputs/vertical-margins.docx','t:0/r:0/c:0/p:0','markdown','持证方：合成配套方',false],
 ['natural-direct','inputs/unequal-natural.docx','p:63','direct','',false],
 ['natural-markdown','inputs/unequal-natural.docx','p:63','markdown','（图片待核对1）',false],
 ['real-indent-direct','cli/sccc/draft/bid.base.docx','t:0/r:1/c:1/p:0','direct','',true],
 ['real-indent-markdown','cli/sccc/draft/bid.base.docx','t:0/r:1/c:1/p:0','markdown','',true],
 ]as const){
 const source=path.join(tester,baseRelative);
 const copied=path.join(inputs,`${id}.base.docx`);await copyFile(source,copied);const base=await readFile(copied),media=real?certificate:image;
 const output=await editTextDocument(base,[route==='markdown'?{op:'insert',at,position:'after',markdown:'![证据](image.png)',images:[media],imageCaptions:label?[label]:undefined}:{op:'insert_image',at,image:media,imageLabel:label,captioned:!!label}]);
 await save(`regression-${id}`,output,source);
}
const goldenSource=path.join(tester,'inputs/golden-offer.base.docx'),golden=await readFile(goldenSource);
let staged=await editTextDocument(golden,[{op:'insert',at:'p:0',position:'after',markdown:'| 证据 | 备注 |\n| --- | --- |\n|  | 相邻备注完整 |'}]);
staged=await editTextDocument(staged,[{op:'insert',at:'t:0/r:1/c:0/p:0',position:'after',markdown:'![证据](image.png)',images:[certificate],pendingImages:true}]);
await save('regression-ordinary-pending-staged',staged,goldenSource);
const fonts=path.resolve('.tmp/evidence/milestone-29/worker/fonts.conf'),profile=pathToFileURL(path.join(root,'lo-profile')).href;
const results=[];
for(const file of(await readdir(docs)).filter(file=>file.endsWith('.docx'))){
 const id=path.basename(file,'.docx'),directory=path.join(render,id);await mkdir(directory,{recursive:true});
 for(const page of(await readdir(directory)).filter(name=>/^page-\d+\.png$/.test(name)))await unlink(path.join(directory,page));
 execFileSync('/Applications/LibreOffice.app/Contents/MacOS/soffice',['-env:UserInstallation='+profile,'--headless','--convert-to','pdf:writer_pdf_Export','--outdir',directory,path.join(docs,file)],{env:{...process.env,FONTCONFIG_FILE:fonts},timeout:60000});
 const pdf=path.join(directory,`${id}.pdf`);execFileSync('pdftoppm',['-r','100','-png',pdf,path.join(directory,'page')],{timeout:60000});
 await writeFile(path.join(directory,'text.txt'),execFileSync('pdftotext',['-layout',pdf,'-']));
 results.push({id,pages:(await readdir(directory)).filter(name=>/^page-\d+\.png$/.test(name)).sort()});
}
await writeFile(path.join(root,'render-matrix.json'),JSON.stringify({records,results},null,2));console.log(JSON.stringify(results));
