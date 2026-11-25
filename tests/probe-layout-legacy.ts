import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {readZip,sha256Hex} from '../src/core/docx/zip.js';
import {auditImageLayout} from '../src/core/docx/layout.js';
import {finalizeDocument} from '../src/core/docx/finalize-document.js';
import type {HostPort} from '../src/core/host.js';
const directory=process.env.SEAL_LAYOUT_OLD_OUTPUTS;if(!directory)throw new Error('SEAL_LAYOUT_OLD_OUTPUTS is required');
const output=process.env.SEAL_LAYOUT_PROBE_OUTPUT;if(!output)throw new Error('SEAL_LAYOUT_PROBE_OUTPUT is required');
const records=[];
for(const [id,file]of [['exact','variant-caption-exact'],['vertical','variant-caption-vertical'],['natural','cli-unequal'],['indent','sdk-sccc']]){
  const draft=await readFile(path.join(directory,`${file}.docx`)),parts=await readZip(draft),decoder=new TextDecoder();
  const issues=auditImageLayout(decoder.decode(parts.get('word/document.xml')),decoder.decode(parts.get('word/styles.xml')??new Uint8Array()));
  assert.ok(issues.length>0,`${id}: frozen failing output must report C16`);
  await assert.rejects(finalizeDocument(draft,draft,{draftSha256:sha256Hex(draft),baseSha256:sha256Hex(draft),marks:[]},{}as HostPort),/C16/);
  records.push({id,file,sha256:sha256Hex(draft),issues,finalization:'rejected C16'});
}
await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(records,null,2));console.log(JSON.stringify(records));
