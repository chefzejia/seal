import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packageDocument, paragraph } from './fixtures/layout-matrix.js';
import { readZip, writeZip } from '../src/core/docx/zip.js';
import { constraintCases } from './fixtures/layout-constraints.js';

test('formal CLI stages a table then fits evidence and exposes C16 with and without a draft selector', async () => {
  await mkdir('.tmp', { recursive: true });
  const sandbox = await mkdtemp(path.resolve('.tmp/cli-layout-'));
  const run = promisify(execFile), root = path.join(sandbox, 'project');
  const env = { ...process.env, SEAL_HOME: path.join(sandbox, 'seal-home') };
  const cli = async (...args: string[]) => JSON.parse((await run(process.execPath, ['--import', 'tsx', 'src/shells/cli/index.ts', ...(args[0] === 'init' ? ['project'] : []), ...args], { env })).stdout);
  try {
    const base = await packageDocument(paragraph('定位')), source = path.join(sandbox, 'original.docx');
    await writeFile(source, base);
    await cli('init', '--root', root, '--name', '几何测试', '--deadline', '2028-12-31', '--tender', source);
    await cli('extract', '--project', root, '--tender', 'tender/1.docx', '--draft', 'bid', '--ranges', JSON.stringify([{ from: 'p:0', to: 'p:0' }]));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'insert', at: 'p:0', position: 'after', markdown: '| 证据 | 备注 |\n| --- | --- |\n|  | 相邻备注完整 |' }]));
    await writeFile(path.join(root, 'materials', 'evidence.png'), await readFile('tests/fixtures/evidence-1600x1200.png'));
    await cli('edit', '--project', root, '--draft', 'bid', '--ops', JSON.stringify([{ op: 'insert_image', at: 't:0/r:1/c:0', image: 'materials/evidence.png' }]));
    const file = path.join(root, 'draft', 'bid.docx'), original = await readFile(file), parts = await readZip(original);
    const xml = new TextDecoder().decode(parts.get('word/document.xml'));
    assert.equal(Number(/<wp:extent cx="(\d+)"/.exec(xml)![1]), 4440 * 635);
    assert.deepEqual((await cli('check', '--project', root, '--draft', 'bid', '--group', 'C16')).results, { C16: [] });
    assert.deepEqual((await cli('check', '--project', root, '--group', 'C16')).volumes[0].results, { C16: [] });
    parts.set('word/document.xml', new TextEncoder().encode(xml.replace(/(<wp:extent cx=")\d+/, `$1${4440 * 635 + 1}`)));
    await writeFile(file, await writeZip(parts));
    assert.equal((await cli('check', '--project', root, '--draft', 'bid', '--group', 'C16')).counts.C16, 1);
    assert.equal((await cli('check', '--project', root, '--group', 'C16')).volumes[0].results.C16.length, 1);
    await writeFile(file, original);
    assert.deepEqual((await cli('check', '--project', root, '--group', 'C16')).volumes[0].results, { C16: [] });
    assert.deepEqual(new Uint8Array(await readFile(source)), base);
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test('formal CLI fits exact rows, vertical margins, natural columns and inherited paragraph indents',async()=>{
  await mkdir('.tmp',{recursive:true});const sandbox=await mkdtemp(path.resolve('.tmp/cli-constraints-')),run=promisify(execFile);
  const env={...process.env,SEAL_HOME:path.join(sandbox,'seal-home')};
  const cli=async(...args:string[])=>JSON.parse((await run(process.execPath,['--import','tsx','src/shells/cli/index.ts',...args],{env})).stdout);
  try{
    for(const [id,markdown]of [['row-exact-0',false],['vertical-margins',false],['natural-columns-0',true],['paragraph-indent-3',true]]as const){
      const item=constraintCases.find(item=>item.id===id)!,root=path.join(sandbox,id),source=path.join(sandbox,`${id}.docx`);
      await writeFile(source,await packageDocument(item.body,item.section,item.styles));
      await cli('project','init','--root',root,'--name','容器约束CLI','--deadline','2028-12-31','--tender',source);
      const block=item.body.startsWith('<w:tbl')?'t:0':'p:0';
      await cli('extract','--project',root,'--tender','tender/1.docx','--draft','bid','--ranges',JSON.stringify([{from:block,to:id.startsWith('natural')?'p:133':block}]));
      await writeFile(path.join(root,'materials','evidence.png'),await readFile('tests/fixtures/evidence-1600x1200.png'));
      await cli('edit','--project',root,'--draft','bid','--ops',JSON.stringify([markdown?{op:'insert',at:item.at,position:'after',markdown:'![图](materials/evidence.png)'}:{op:'insert_image',at:item.at,image:'materials/evidence.png'}]));
      const report=await cli('check','--project',root,'--draft','bid','--group','C16');assert.deepEqual(report.results.C16,[]);
      assert.equal(report.counts.C15,0);
      const xml=new TextDecoder().decode((await readZip(await readFile(path.join(root,'draft/bid.docx')))).get('word/document.xml'));
      const extent=/<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml)!;
      if(id==='row-exact-0')assert.ok(Number(extent[2])<4000*635);
      if(item.maxWidth)assert.ok(Number(extent[1])<=item.maxWidth*635);
    }
  }finally{await rm(sandbox,{recursive:true,force:true});}
});
