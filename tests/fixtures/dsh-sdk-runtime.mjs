import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { packageDir, sdkModules, sandbox, source } = config;
assert.ok(process.versions.electron, 'Use the installed ASAR-aware Electron Node runtime');
assert.ok(path.isAbsolute(process.env.SEAL_HOME) && process.env.SEAL_HOME.startsWith(sandbox + path.sep));
const sdkRequire = createRequire(path.join(sdkModules, '__seal_sdk__.cjs'));
const sdkResolutions = new Map();
const runtimeResolutions = new Map();
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
const packageURL = pathToFileURL(packageDir + path.sep).href;
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@deepseek-ai/')) {
      const resolved = nextResolve(specifier, context);
      if (context.parentURL?.startsWith(packageURL) && (Object.hasOwn(manifest.dependencies, specifier) || resolved.url.endsWith('.node'))) {
        assert.ok(resolved.url.startsWith(pathToFileURL(path.join(packageDir, 'node_modules') + path.sep).href), `Runtime import escaped its package: ${specifier}`);
        runtimeResolutions.set(`${specifier} from ${context.parentURL}`, resolved.url);
      }
      return resolved;
    }
    const resolved = nextResolve(specifier, { ...context, parentURL: pathToFileURL(path.join(sdkModules, '__seal_sdk__.mjs')).href });
    assert.ok(resolved.url.startsWith(pathToFileURL(sdkModules + path.sep).href), `SDK peer escaped the installed provider tree: ${specifier}`);
    sdkResolutions.set(specifier, resolved.url);
    return resolved;
  },
});
const get = async name => import(pathToFileURL(sdkRequire.resolve(`@deepseek-ai/${name}`)).href);
const version = name => JSON.parse(fs.readFileSync(path.join(sdkModules, '@deepseek-ai', name, 'package.json'), 'utf8')).version;
const packageRequire = createRequire(path.join(packageDir, 'package.json'));
const runtimeDependencies = Object.keys(manifest.dependencies).map(name => {
  const resolved = fs.realpathSync(packageRequire.resolve(name));
  assert.ok(resolved.startsWith(path.join(packageDir, 'node_modules') + path.sep), `Runtime dependency must resolve inside the unpacked package: ${name}`);
  return { name, resolved };
});
console.log(JSON.stringify({ artifact: config.artifact, sha256: config.sha256, package: manifest.version, electron: process.versions.electron, node: process.versions.node, runtimeDependencies }));
const { Context } = await get('cordis');
const ctx = new Context();
let plugin;
let handle;
const original = fs.readFileSync(source);
const project = path.join(sandbox, 'explicit-project');
const agentProject = path.join(sandbox, 'agent-project');
const signal = new AbortController().signal;
const expectedSealTools = ['seal_check', 'seal_doc_edit', 'seal_doc_extract', 'seal_doc_read', 'seal_kb_get', 'seal_kb_ingest', 'seal_kb_save', 'seal_kb_search', 'seal_requirements'];
const expectedTools = [...expectedSealTools, 'skill'].sort();
const invoke = async (name, args, agent) => {
  const id = `seal-sdk-${randomUUID()}`;
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }], signal, ...(agent === undefined ? {} : { agent }) });
  assert.equal(batch.results.length, 1, `${name}: one settled outcome is required`);
  assert.equal(batch.results[0].callId, id, `${name}: result must correlate with the submitted call`);
  console.log(JSON.stringify({ call: name, args, result: batch.results[0].result }, (_key, value) => typeof value === 'string' && value.length > 1000
    ? { characters: value.length, sha256: createHash('sha256').update(value).digest('hex'), preview: value.slice(0, 160) }
    : value));
  return batch.results[0].result;
};
const invokeSuccessRaw = async (name, args, agent) => {
  const result = await invoke(name, args, agent);
  assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`);
  assert.equal(typeof result.value?.json, 'string', `${name}: canonical JSON output is required`);
  if (name === 'seal_doc_read') {
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.ok(result.content[0].text.length > 0);
  } else {
    assert.deepEqual(result.content, [{ type: 'text', text: result.value.json }]);
  }
  return { data: JSON.parse(result.value.json), text: result.content[0].text, jsonLength: result.value.json.length };
};
const success = async (name, args, agent) => (await invokeSuccessRaw(name, args, agent)).data;
const failure = async (name, args, expected, agent) => {
  const result = await invoke(name, args, agent);
  assert.equal(result.isError, true, `${name}: the call must fail`);
  assert.ok(!Object.hasOwn(result, 'value'), `${name}: failure cannot carry a successful canonical value`);
  assert.equal(typeof result.error?.message, 'string', `${name}: a failure must explain its cause`);
  assert.match(JSON.stringify(result.error), expected, `${name}: actionable structured error`);
  assert.ok(result.content.some(block => block.type === 'text' && block.text.startsWith('Error:')));
  return result;
};
const initialize = root => {
  const cli = path.join(packageDir, 'lib/shells/cli/index.js');
  const output = execFileSync(process.execPath, [cli, 'project', 'init', '--root', root, '--name', 'SDK 合成验收', '--deadline', '2028-02-29', '--tender', source], {
    cwd: sandbox, encoding: 'utf8', timeout: 30_000,
  });
  assert.ok(output.trim(), 'The packaged CLI project init must emit its created project');
  const created = JSON.parse(output);
  assert.equal(created.format, 'seal-project-1');
  assert.equal(created.tenders.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(root, created.tenders[0].copy)), original);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'ledger.json'), 'utf8'));
  assert.equal(typeof ledger.integrity?.snapshot, 'string', 'CLI initialization creates a sealed ledger');
  assert.match(ledger.integrity.signature, /^[0-9a-f]{64}$/);
  console.log(JSON.stringify({ cli, project: root, initialized: true }));
};
const checkReport = report => {
  assert.deepEqual(report.results.C01, []);
  assert.deepEqual(report.results.C06, []);
  assert.deepEqual(report.results.C10, []);
  assert.deepEqual(report.results.C15, []);
  assert.ok(report.results.C04.length > 0, 'Unverified fills remain pending');
};
const blankName = '姓名：⟦0:____⟧ 电话：⟦1:____⟧ □同意';
const readPage = (result, limit, maxChars) => {
  assert.deepEqual(Object.keys(result).sort(), ['mode', 'items', 'characters', 'truncated', 'next', 'notice', 'warnings', 'warningCount', 'warningsTruncated'].sort());
  assert.ok(result.items.length <= limit);
  assert.equal(result.characters, result.items.reduce((total, item) => total + item.text.length, 0));
  assert.ok(result.characters <= maxChars);
  assert.equal(result.truncated, result.next !== null);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.warningCount, 0);
  assert.equal(result.warningsTruncated, false);
  for (const item of result.items) {
    assert.equal(item.editable, true);
    assert.equal(item.location, `word/document.xml#${item.address}`);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(item.text), 'View fragments preserve Unicode characters');
  }
  if (result.next) {
    assert.equal(typeof result.notice, 'string');
    assert.equal(Object.hasOwn(result.next, 'pending'), false, 'Continuations contain only public options');
    assert.match(result.next.cursor.document, /^[0-9a-f]{64}$/);
    assert.match(result.next.cursor.request, /^[0-9a-f]{64}$/);
  } else assert.equal(result.notice, null);
};
try {
  for (const [name, settings, namespace] of [
    ['dsh-system-prompt', {}, false], ['dsh-session-projection', {}, false], ['dsh-session', {}, false],
    ['dsh-agent', {}, false], ['dsh-llm', {}, false], ['dsh-tools', {}, false],
    ['dsh-tool-executor-native', {}, true], ['dsh-fs-local', { cwd: sandbox }, false],
    ['dsh-working-directory', { defaultDirectory: sandbox }, false], ['dsh-agent-loop', {}, false],
    ['dsh-commands', {}, false], ['dsh-skill', {}, false], ['dsh-tool-skill', {}, true], ['dsh-host-webserver', { host: '127.0.0.1', port: 0 }, false],
    ['dsh-credentials-local', { path: path.join(sandbox, 'carrier-credentials.yaml'), watch: false }, false],
    ['dsh-client-connection', {}, true],
  ]) {
    assert.match(version(name), /^0\.2\.2-rc\./, `Use the installed DSH 0.2.2 release candidate: ${name}`);
    const module = await get(name);
    const fiber = await ctx.plugin(namespace ? module : module.default, settings);
    console.log(JSON.stringify({ provider: name, version: version(name), loaded: sdkRequire.resolve(`@deepseek-ai/${name}`), state: fiber.state }));
  }
  assert.equal(version('cordis'), '4.1.0');
  const { satisfies } = createRequire(packageRequire.resolve('sharp'))('semver');
  assert.ok(satisfies(version('dsh-tools'), manifest.peerDependencies['@deepseek-ai/dsh-tools']), 'The artifact peer range admits the installed SDK');
  assert.ok(satisfies(version('dsh-tools'), manifest.engines.dsh), 'The artifact engine range admits the installed SDK');
  for (const [dependency, range] of Object.entries(manifest.peerDependencies)) {
    assert.ok(dependency.startsWith('@deepseek-ai/'), `Unvalidated peer dependency: ${dependency}`);
    assert.ok(satisfies(version(dependency.slice('@deepseek-ai/'.length)), range), `Installed SDK peer mismatch: ${dependency}@${range}`);
  }
  const entry = path.resolve(packageDir, manifest.exports['.']);
  const host = await import(pathToFileURL(entry).href);
  assert.equal(host.name, 'seal-workbench');
  assert.ok(host.inject.includes('workingDirectory'), 'The complete plugin declares the real cwd provider');
  for (const dependency of host.inject) assert.ok(ctx.get(dependency), `Missing real injection: ${dependency}`);
  plugin = await ctx.plugin(host);
  console.log(JSON.stringify({ plugin: entry, inject: host.inject, toolNames: ctx.tools.definitions().map(tool => tool.name).sort() }));
  await test('installed owner carrier serves GET and POST routes and rejects untrusted callers', async () => {
    const origin = ctx.webServer.getOrigin();
    const statusUrl = `${origin}/api/seal/status`;
    assert.equal((await fetch(statusUrl)).status, 401);
    assert.equal((await fetch(statusUrl, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
    const disposeRoot = ctx.webServer.register({ kind: 'exact', path: '/', handler(req, res) {
      if (ctx.connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('owner'); }
    } });
    try {
      const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
      assert.equal(exchange.status, 303);
      const cookie = exchange.headers.get('set-cookie').split(';', 1)[0];
      const response = await fetch(statusUrl, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, 'The real node:http carrier must construct body-free GET Requests');
      const status = await response.json();
      assert.equal(status.version, manifest.version);
      assert.equal(status.home, process.env.SEAL_HOME);
      assert.equal(status.knowledgeBasesRoot, path.join(process.env.SEAL_HOME, 'vaults'));
      assert.equal(status.environment.platform, process.platform);
      assert.equal(status.environment.pdfEngine, 'builtin-pdfium');
      assert.equal(typeof status.environment.libreOffice.available, 'boolean');
      assert.equal((await fetch(statusUrl, { headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } })).status, 403);
      for (const endpoint of ['file', 'kb-file']) {
        const invalid = await fetch(`${origin}/api/seal/${endpoint}`, { headers: { Cookie: cookie } });
        assert.equal(invalid.status, 400);
        assert.equal(typeof (await invalid.json()).error, 'string');
      }
      const unsupported = await fetch(`${origin}/api/seal/action`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'not_allowed' }) });
      assert.equal(unsupported.status, 400);
      assert.match((await unsupported.json()).error, /操作不存在/);
      const action = async body => {
        const response = await fetch(`${origin}/api/seal/action`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);
        return response.json();
      };
      const created = await action({ operation: 'create', name: '载体合成项目', deadline: '2028-02-29', files: [source] });
      await success('seal_doc_extract', { project: created.root, tender: 'tender/1.docx', draft: '载体册', ranges: [{ from: 'p:1', to: 't:0' }] });
      const draftUrl = `${origin}/api/seal/file?${new URLSearchParams({ projectId: created.id, draft: '载体册' })}`;
      const draftResponse = await fetch(draftUrl, { headers: { Cookie: cookie } });
      assert.equal(draftResponse.status, 200);
      assert.deepEqual(Buffer.from(await draftResponse.arrayBuffer()), fs.readFileSync(path.join(created.root, 'draft/载体册.docx')));
      const preview = await action({ operation: 'preview', projectId: created.id, draft: '载体册' });
      assert.ok(preview.pages.length > 0);
      const previewUrl = `${origin}/api/seal/file?${new URLSearchParams({ projectId: created.id, preview: preview.pages[0].file })}`;
      const previewResponse = await fetch(previewUrl, { headers: { Cookie: cookie } });
      assert.equal(previewResponse.status, 200);
      assert.equal(previewResponse.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await previewResponse.arrayBuffer()).subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
      const vault = await action({ operation: 'kb', action: 'create', name: '载体合成库' });
      const record = await success('seal_kb_save', { vaultId: vault.vaultId, action: 'create', kind: 'record', fields: { title: '载体原件', type: '其他' }, body: '合成附件' });
      await success('seal_kb_save', { vaultId: vault.vaultId, action: 'attach_file', kind: 'record', id: record.id, filePath: source });
      const kbUrl = `${origin}/api/seal/kb-file?${new URLSearchParams({ vaultId: vault.vaultId, kind: 'record', id: record.id, index: '0' })}`;
      const kbResponse = await fetch(kbUrl, { headers: { Cookie: cookie } });
      assert.equal(kbResponse.status, 200);
      assert.deepEqual(Buffer.from(await kbResponse.arrayBuffer()), original);
      const actionUrl = `${origin}/api/seal/action`;
      const coverBody = JSON.stringify({
        operation: 'cover',
        projectId: created.id,
        expectedRevision: 'rev',
        id: 'req-1',
        draft: '载体册',
        address: 'p:0',
      });
      assert.equal((await fetch(actionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: coverBody })).status, 401);
      assert.equal((await fetch(actionUrl, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: coverBody })).status, 403);
      for (const url of [draftUrl, previewUrl, kbUrl]) {
        assert.equal((await fetch(url)).status, 401);
        assert.equal((await fetch(url, { headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } })).status, 403);
      }
      const peer = ctx.connection.createPeer({ principal: { kind: 'agent', agentId: 'non-owner-carrier' } });
      try {
        for (const url of [statusUrl, draftUrl, previewUrl, kbUrl]) {
          const forbidden = await ctx.connection.createSharedFetchHandler('/api').fetch(new Request(url), peer);
          assert.equal(forbidden.status, 403, 'The installed shared carrier rejects a non-owner Peer');
        }
        const forbiddenCover = await ctx.connection.createSharedFetchHandler('/api').fetch(
          new Request(actionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: coverBody }),
          peer,
        );
        assert.equal(forbiddenCover.status, 403, 'The installed shared carrier rejects non-owner POST /api/seal/action (cover)');
      } finally { await peer.dispose(); }
    } finally { disposeRoot(); }
  });
  initialize(project);
  initialize(agentProject);
  await test('complete plugin registers document and knowledge-base tools', () => {
    assert.deepEqual(ctx.tools.definitions().map(tool => tool.name).sort(), expectedTools);
  });
  await test('knowledge-base tools execute through the packaged CLI and preserve verification boundaries', async () => {
    const cli = path.join(packageDir, 'lib/shells/cli/index.js');
    const created = JSON.parse(execFileSync(process.execPath, [cli, 'kb', 'init', '--vault', 'sdk-test-vault', '--name', 'SDK 合成资料柜'], { cwd: sandbox, encoding: 'utf8' }));
    assert.equal(created.format, 'seal-kb-2');
    const vaultId = created.vaultId;
    const saved = await success('seal_kb_save', { vaultId, action: 'create', kind: 'record', fields: { title: 'SDK 合成证据', type: '其他', holder: '合成主体', tags: ['SDK'] }, body: 'SDK 入口测试资料。' });
    assert.equal(saved.verified, false);
    await failure('seal_kb_save', { vaultId, action: 'update', kind: 'record', id: saved.id, fields: { verified: true } }, /不能设置核实字段/);
    const results = await success('seal_kb_search', { vaultId, query: 'SDK 合成证据', limit: 5 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, saved.id);
    const full = await success('seal_kb_get', { vaultId, id: saved.id, kind: 'record' });
    assert.equal(full.body, 'SDK 入口测试资料。');
    const ingested = await success('seal_kb_ingest', { vaultId, files: [source, source, source], limit: 1 });
    assert.match(ingested.batchId, /^batch-/);
    assert.equal(ingested.sourceCount, 3);
    assert.equal(ingested.imageCount, 0);
    assert.ok(ingested.candidateCount >= 3);
    const all = [];
    for (let page = ingested; page;) {
      assert.equal(page.batchId, ingested.batchId);
      assert.equal(page.candidateCount, ingested.candidateCount);
      assert.equal(page.candidates.length, 1);
      const { id } = page.candidates[0];
      assert.equal((await success('seal_kb_get', { vaultId, id })).id, id);
      all.push(id);
      page = page.nextAfter ? await success('seal_kb_search', { vaultId, batchId: ingested.batchId, after: page.nextAfter, limit: 1 }) : null;
    }
    assert.equal(new Set(all).size, ingested.candidateCount);
    const log = fs.readFileSync(path.join(process.env.SEAL_HOME, 'vaults', vaultId, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(log.some(event => event.action === 'ingest' && event.actor === 'agent' && event.object === `batch:${ingested.batchId}`));

    const multiDir = path.join(sandbox, 'sdk-multiformat-dir');
    fs.mkdirSync(multiDir, { recursive: true });
    fs.writeFileSync(path.join(multiDir, 'note.txt'), 'SDK 多格式目录文本');
    fs.writeFileSync(path.join(multiDir, 'table.csv'), '项目,金额\n合成项目,100万元\n');
    fs.copyFileSync(path.join(config.readonlyFixtures, 'evidence-2x1.png'), path.join(multiDir, 'cert.png'));
    fs.writeFileSync(path.join(multiDir, '.hidden'), 'skip');
    fs.writeFileSync(path.join(multiDir, 'ignore.zip'), 'zip');
    const dirIngested = await success('seal_kb_ingest', { vaultId, files: [multiDir], limit: 20 });
    assert.equal(dirIngested.sourceCount, 3);
    assert.equal(dirIngested.imageCount, 1);
    assert.equal(dirIngested.candidateCount, 3);
    assert.equal(dirIngested.skipped?.length, 1);
    assert.match(dirIngested.skipped[0].source, /ignore\.zip$/);
    assert.deepEqual(new Set(dirIngested.candidates.map(c => c.sourceType)), new Set(['text', 'spreadsheet', 'image']));
    const scopedProject = path.join(sandbox, 'kb-date-project');
    execFileSync(process.execPath, [cli, 'project', 'init', '--root', scopedProject, '--name', 'SDK 日期上下文', '--deadline', '2028-03-01', '--vault', vaultId, '--tender', source], { cwd: sandbox, encoding: 'utf8' });
    await success('seal_kb_save', { project: scopedProject, action: 'update', kind: 'subject', fields: { legalName: '合成主体' } });
    const updated = await success('seal_kb_save', { project: scopedProject, action: 'update', kind: 'record', id: saved.id, fields: { validUntil: '2028-02-29' } });
    assert.equal(updated.health.referenceDate, '2028-03-01');
    assert.equal(updated.health.subject, 'self');
    assert.equal(updated.health.validity, 'expired');
    const projectRecord = await success('seal_kb_get', { project: scopedProject, vaultId, id: saved.id, referenceDate: '2027-01-01' });
    assert.deepEqual(projectRecord.health, updated.health);
    const expired = await success('seal_kb_search', { project: scopedProject, validity: 'expired' });
    assert.deepEqual(expired.map(item => [item.id, item.validity]), [[saved.id, 'expired']]);
    await failure('seal_kb_search', { vaultId, validity: 'expired' }, /参考日|reference-date/);
    const standalone = await success('seal_kb_search', { vaultId, referenceDate: '2027-01-01', validity: 'valid' });
    assert.deepEqual(standalone.map(item => item.id), [saved.id]);

    // Verify packaged @hyzyla/pdfium WASM executes inside unpacked TGZ runtime with PATH="" (zero Poppler)
    const chineseText = '第一章 投标函 合成验收测试';
    const glyphs = Array.from(chineseText).map((ch, idx) => ({ code: idx + 1, cp: ch.codePointAt(0) }));
    const cmapEntries = glyphs.map(g => `<${g.code.toString(16).padStart(4, '0')}> <${g.cp.toString(16).padStart(4, '0')}>`).join('\n');
    const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Seal-UTF16 def\n/CMapType 2 def\n1 begincodespacerange\n<0001> <FFFF>\nendcodespacerange\n${glyphs.length} beginbfchar\n${cmapEntries}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    const hexText = glyphs.map(g => g.code.toString(16).padStart(4, '0')).join('');
    const contentStream = `BT\n/F1 14 Tf\n72 720 Td\n<${hexText}> Tj\nET\n`;
    const pdfObjs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
      '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>',
      `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
      `<< /Length ${Buffer.byteLength(contentStream)} >>\nstream\n${contentStream}endstream`,
    ];
    let pdfBody = '%PDF-1.4\n';
    const pdfOffsets = [0];
    for (let i = 0; i < pdfObjs.length; i++) {
      pdfOffsets.push(Buffer.byteLength(pdfBody));
      pdfBody += `${i + 1} 0 obj\n${pdfObjs[i]}\nendobj\n`;
    }
    const xrefPos = Buffer.byteLength(pdfBody);
    pdfBody += `xref\n0 ${pdfObjs.length + 1}\n0000000000 65535 f \n` + pdfOffsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    pdfBody += `trailer\n<< /Size ${pdfObjs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    const pdfBytes = new Uint8Array(Buffer.from(pdfBody));
    const sdkPdfFile = path.join(sandbox, 'sdk-pdfium-chinese.pdf');
    fs.writeFileSync(sdkPdfFile, pdfBytes);
    const prevPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const pdfEngine = await import(pathToFileURL(path.join(packageDir, 'lib/shells/pdf-engine.js')).href);
      const pdfOutDir = path.join(sandbox, 'sdk-pdfium-out');
      const extracted = await pdfEngine.extractPdfWithPdfium(pdfBytes, pdfOutDir, { dpi: 120 });
      assert.equal(extracted.pageCount, 1);
      assert.equal(extracted.renderedPages, 1);
      assert.match(extracted.pages[0].text, /第一章 投标函 合成验收测试/);
      assert.ok(fs.existsSync(extracted.pages[0].imagePath));
      const pngHeader = fs.readFileSync(extracted.pages[0].imagePath).subarray(0, 8);
      assert.deepEqual(pngHeader, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

      const pdfIngested = await success('seal_kb_ingest', { vaultId, files: [sdkPdfFile], limit: 10 });
      assert.equal(pdfIngested.sourceCount, 1);
      assert.equal(pdfIngested.imageCount, 1);
      const pdfCand = await success('seal_kb_get', { vaultId, id: pdfIngested.candidates[0].id });
      assert.match(pdfCand.body, /第一章 投标函 合成验收测试/);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });
  await test('Native KB get rejects split UTF-16 starts and preserves exact suffix continuation for all kinds', async () => {
    const cli = path.join(packageDir, 'lib/shells/cli/index.js'), vaultId = 'sdk-codepoint-vault';
    execFileSync(process.execPath, [cli, 'kb', 'init', '--vault', vaultId, '--name', 'SDK Unicode 游标'], { cwd: sandbox, encoding: 'utf8' });
    const vaultRoot = path.join(process.env.SEAL_HOME, 'vaults', vaultId);
    const { serializeEntry } = await import(pathToFileURL(path.join(packageDir, 'lib/core/kb/markdown.js')).href);
    const entries = [];
    for (const kind of ['record', 'material']) entries.push({ id: (await success('seal_kb_save', { vaultId, action: 'create', kind, fields: { title: `游标 ${kind}` } })).id, kind });
    entries.push({ subject: true }, { id: 'candidate-codepoint' });
    const candidate = path.join(vaultRoot, 'inbox/batch-codepoint/candidate-codepoint.md');
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    const escaped = '甲😀' + String.fromCharCode(34, 92, 10, 9) + '𠮷末';
    for (const body of ['', '甲乙丙', '甲😀𠮷', escaped, '甲乙丙'.repeat(20000), '甲😀𠮷'.repeat(14000), escaped.repeat(8000)]) {
      for (const entry of entries.slice(0, 2)) await success('seal_kb_save', { vaultId, action: 'update', ...entry, body });
      await success('seal_kb_save', { vaultId, action: 'update', kind: 'subject', body });
      fs.writeFileSync(candidate, serializeEntry({ title: '游标候选', processed: false }, body));
      const boundaries = new Set([0]); let position = 0;
      for (const codePoint of body) { position += codePoint.length; boundaries.add(position); }
      const offsets = new Set([0, ...Array.from({ length: Math.min(body.length, 10) }, (_, i) => i + 1), body.length - 1, body.length, body.length + 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]);
      for (const entry of entries) {
        for (const offset of offsets) {
          if (!Number.isSafeInteger(offset) || !boundaries.has(offset)) {
            const rejected = await failure('seal_kb_get', { vaultId, ...entry, offset }, /offset/);
            const message = rejected.error.message;
            if (Number.isInteger(offset) && offset > 0 && offset < body.length) {
              assert.match(message, /UTF-16.*代理对/);
              assert.ok(message.includes(`${offset - 1}（码点前）`));
              assert.ok(message.includes(`${offset + 1}（码点后）`));
              assert.match(message, /nextOffset/);
            }
            continue;
          }
          const page = await success('seal_kb_get', { vaultId, ...entry, offset });
          assert.ok(JSON.stringify(page).length <= 50000);
          assert.equal(page.body, body.slice(offset, offset + page.body.length));
          assert.ok(boundaries.has(offset + page.body.length));
        }
        const initial = await success('seal_kb_get', { vaultId, ...entry });
        assert.equal(initial.body, body.slice(0, initial.body.length));
        for (const start of [0, 1, 3].filter(offset => boundaries.has(offset))) {
          let offset = start, assembled = '', count = 0;
          do {
            assert.ok(++count < 30);
            const page = await success('seal_kb_get', { vaultId, ...entry, offset });
            assert.ok(JSON.stringify(page).length <= 50000);
            assert.equal(page.body, body.slice(offset, offset + page.body.length));
            assert.ok(boundaries.has(offset + page.body.length)); assembled += page.body;
            if (!page.truncated) break;
            assert.equal(page.totalCharacters, body.length); assert.equal(page.nextOffset, offset + page.body.length);
            assert.ok(page.nextOffset > offset); assert.ok(boundaries.has(page.nextOffset)); offset = page.nextOffset;
          } while (true);
          assert.equal(assembled, body.slice(start));
        }
      }
    }
  });
  await test('knowledge-base Native get continues every long entry kind and save rejects private fields for every action', async () => {
    const cli = path.join(packageDir, 'lib/shells/cli/index.js');
    const vaultId = 'sdk-continuation-vault';
    execFileSync(process.execPath, [cli, 'kb', 'init', '--vault', vaultId, '--name', 'SDK 正文续读'], { cwd: sandbox, encoding: 'utf8' });
    const vaultRoot = path.join(process.env.SEAL_HOME, 'vaults', vaultId);
    const body = '中文😀"\\\n'.repeat(12000);
    const entries = [];
    for (const kind of ['record', 'material']) {
      const entry = await success('seal_kb_save', { vaultId, action: 'create', kind, fields: { title: `长正文 ${kind}` }, body });
      entries.push({ id: entry.id, kind });
    }
    await success('seal_kb_save', { vaultId, action: 'update', kind: 'subject', body });
    const { serializeEntry } = await import(pathToFileURL(path.join(packageDir, 'lib/core/kb/markdown.js')).href);
    const candidate = path.join(vaultRoot, 'inbox/batch-synthetic/candidate-long.md');
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, serializeEntry({ title: '合成长候选', processed: false }, body));
    entries.push({ subject: true }, { id: 'candidate-long' });
    for (const entry of entries) {
      let offset = 0, assembled = '';
      for (let index = 0; index < 20; index++) {
        const page = await success('seal_kb_get', { vaultId, ...entry, offset });
        assert.ok(JSON.stringify(page).length <= 50000);
        assert.equal(page.body, body.slice(offset, offset + page.body.length));
        assembled += page.body;
        if (!page.truncated) break;
        assert.equal(page.nextOffset, offset + page.body.length);
        assert.ok(page.nextOffset > offset);
        offset = page.nextOffset;
      }
      assert.equal(assembled, body);
      await failure('seal_kb_get', { vaultId, ...entry, offset: -1 }, /offset/);
      await failure('seal_kb_get', { vaultId, ...entry, offset: body.length + 1 }, /offset/);
    }
    const snapshot = directory => fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
      const target = path.join(directory, item.name);
      return item.isDirectory() ? snapshot(target) : [[path.relative(vaultRoot, target), fs.readFileSync(target).toString('base64')]];
    });
    const before = snapshot(vaultRoot);
    for (const action of ['create', 'update', 'delete', 'attach_file', 'dismiss_candidate']) {
      for (const field of ['verified', 'verifiedAt', 'verifiedFields', '__sealVerification', '__sealFuture']) {
        await failure('seal_kb_save', { vaultId, action, kind: 'record', id: action === 'dismiss_candidate' ? 'candidate-long' : entries[0].id, fields: { [field]: 'forbidden' }, ...(action === 'attach_file' ? { filePath: path.join(sandbox, 'image.gif') } : {}) }, /不能设置核实字段/);
        assert.deepEqual(snapshot(vaultRoot), before);
      }
    }
    const { KnowledgeBase } = await import(pathToFileURL(path.join(packageDir, 'lib/core/kb/service.js')).href);
    const { NodeHostPort } = await import(pathToFileURL(path.join(packageDir, 'lib/shells/node-host.js')).href);
    const { parseEntry } = await import(pathToFileURL(path.join(packageDir, 'lib/core/kb/markdown.js')).href);
    const kb = new KnowledgeBase(new NodeHostPort(), path.dirname(vaultRoot));
    await success('seal_kb_save', { vaultId, action: 'update', kind: 'subject', fields: { legalName: '合成签名主体' } });
    await kb.verify(vaultId, 'subject', 'subject', ['legalName']);
    await kb.verify(vaultId, 'record', entries[0].id);
    for (const [kind, id, file] of [['subject', 'subject', path.join(vaultRoot, 'subject.md')], ['record', entries[0].id, path.join(vaultRoot, 'records', `${entries[0].id}.md`)]]) {
      const raw = parseEntry(fs.readFileSync(file, 'utf8'));
      for (const encoded of ['null', '[]', '"scalar"', '{}', '{"legalName":false}']) {
        fs.writeFileSync(file, serializeEntry({ ...raw.fields, __sealVerification: encoded }, raw.body));
        const entry = await success('seal_kb_get', { vaultId, kind, id, referenceDate: '2026-11-20' });
        assert.equal(entry.verified, false);
        assert.ok(entry.issues.length > 0);
        assert.ok(entry.health.issues.some(issue => issue.code === 'verification_invalid'));
      }
    }
  });
  await test('fact citations, evidence pictures and C05/C08/C09 run through real packaged DSH tools', async () => {
    const cli = path.join(packageDir, 'lib/shells/cli/index.js');
    const created = JSON.parse(execFileSync(process.execPath, [cli, 'kb', 'init', '--vault', 'sdk-facts-vault', '--name', 'SDK 事实引用柜'], { cwd: sandbox, encoding: 'utf8' }));
    const { KnowledgeBase } = await import(pathToFileURL(path.join(packageDir, 'lib/core/kb/service.js')).href);
    const { NodeHostPort } = await import(pathToFileURL(path.join(packageDir, 'lib/shells/node-host.js')).href);
    const kb = new KnowledgeBase(new NodeHostPort(), path.join(process.env.SEAL_HOME, 'vaults'));
    await kb.save(created.vaultId, { action: 'update', kind: 'subject', fields: {
      legalName: 'SDK 本企业', forbiddenAffiliates: ['SDK 禁用主体'], thirdPartyHolders: ['SDK 第三方主体'],
    } });
    await kb.verify(created.vaultId, 'subject', 'subject', ['legalName', 'forbiddenAffiliates', 'thirdPartyHolders']);
    const addRecord = async fields => {
      const saved = await kb.save(created.vaultId, { action: 'create', kind: 'record', fields: { type: '其他', validUntil: '长期', holder: 'SDK 本企业', ...fields }, body: 'SDK 合成事实。' });
      await kb.verify(created.vaultId, 'record', saved.id, []);
      return saved.id;
    };
    const expired = await addRecord({ title: '已过期证据', number: 'SDK-EXPIRED', validUntil: '2020-01-01' });
    const forbidden = await addRecord({ title: '禁用主体证据', number: 'SDK-FORBIDDEN', holder: 'SDK 禁用主体' });
    const mismatch = await addRecord({ title: '主体不符证据', number: 'SDK-MISMATCH', holder: '其他合成主体' });
    const unknown = await kb.save(created.vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title: '未知效期主体', number: 'SDK-UNKNOWN' }, body: '' });
    const thirdParty = await addRecord({ title: '第三方证据', number: 'SDK-THIRD', creditCode: '333333333333333333', holder: 'SDK 第三方主体' });
    const imageRecord = await kb.save(created.vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title: '图片证据', holder: 'SDK 本企业', validUntil: '长期' }, body: '' });
    await kb.save(created.vaultId, { action: 'attach_file', kind: 'record', id: imageRecord.id, file: { fileName: '报告 (2026) 1.png', bytes: fs.readFileSync(path.join(config.readonlyFixtures, 'evidence-2x1.png')) } });
    await kb.verify(created.vaultId, 'record', imageRecord.id, []);
    const imageRecordFull = await kb.get(created.vaultId, 'record', imageRecord.id);
    const imagePath = imageRecordFull.fields.files[0];
    await kb.save(created.vaultId, { action: 'attach_file', kind: 'record', id: thirdParty, file: { fileName: '第三方图片.png', bytes: fs.readFileSync(path.join(config.readonlyFixtures, 'evidence-2x1.png')) } });
    await kb.verify(created.vaultId, 'record', thirdParty, []);
    const thirdPartyImage = `kb:${thirdParty}/${(await kb.get(created.vaultId, 'record', thirdParty)).fields.files[0]}`;
    const factProject = path.join(sandbox, 'fact-project');
    execFileSync(process.execPath, [cli, 'project', 'init', '--root', factProject, '--name', 'SDK 事实验收', '--deadline', '2028-02-29', '--vault', created.vaultId, '--tender', source], { cwd: sandbox, encoding: 'utf8' });
    const longImage = await packageRequire('sharp')({ create: { width: 1239, height: 1827, channels: 3, background: '#446688' } }).png().toBuffer();
    await kb.save(created.vaultId, { action: 'attach_file', kind: 'record', id: thirdParty, file: { fileName: '长幅证书.png', bytes: longImage } });
    await kb.verify(created.vaultId, 'record', thirdParty, []);
    const longReference = `kb:${thirdParty}/${(await kb.get(created.vaultId, 'record', thirdParty)).fields.files.find(file => file.endsWith('/长幅证书.png'))}`;
    const longMarkdown = `![长证书](<${longReference}>)`;
    for (const route of ['direct', 'same-markdown', 'staged-direct', 'staged-markdown']) {
      const draft = `几何-${route}`;
      await success('seal_doc_extract', { project: factProject, tender: 'tender/1.docx', draft, ranges: [{ from: 'p:1', to: 't:0' }] });
      if (route.startsWith('staged')) await success('seal_doc_edit', { project: factProject, draft, ops: [{ op: 'insert', at: 'p:0', position: 'after', markdown: '| 证据 | 备注 |\n| --- | --- |\n|  | 相邻备注完整 |' }] });
      const operation = route === 'same-markdown'
        ? { op: 'insert', at: 'p:0', position: 'after', markdown: `| 证据 | 备注 |\n| --- | --- |\n| ${longMarkdown} | 相邻备注完整 |` }
        : route === 'staged-markdown'
          ? { op: 'insert', at: 't:0/r:1/c:0/p:0', position: 'after', markdown: longMarkdown }
          : { op: 'insert_image', at: route === 'direct' ? 't:0/r:0/c:1/p:0' : 't:0/r:1/c:0', image: longReference };
      await success('seal_doc_edit', { project: factProject, draft, ops: [{ ...operation, thirdPartyHolder: 'SDK 第三方主体' }] });
      const file = path.join(factProject, 'draft', draft + '.docx');
      const xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8' });
      assert.match(xml, /持证方：SDK 第三方主体/);
      const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml);
      assert.equal(Number(extent[1]), 4440 * 635, `SDK ${route} uses the independent half-page cell width`);
      assert.ok(Math.abs(Number(extent[1]) / Number(extent[2]) - 1239 / 1827) < 0.000001);
      const report = await success('seal_check', { project: factProject, draft, group: 'C16' });
      assert.deepEqual(report.results, { C16: [] });
      if (route === 'staged-direct') {
        const { readZip, writeZip } = await import(pathToFileURL(path.join(packageDir, 'lib/core/docx/zip.js')).href);
        const original = fs.readFileSync(file), parts = await readZip(original);
        parts.set('word/document.xml', new TextEncoder().encode(xml.replace(/(<wp:extent cx=")\d+/, `$1${4440 * 635 + 1}`)));
        fs.writeFileSync(file, await writeZip(parts));
        const bad = await success('seal_check', { project: factProject, draft, group: 'C16' });
        assert.equal(bad.results.C16.length, 1, 'SDK C16 reports an intentionally oversized sandbox drawing');
        fs.writeFileSync(file, original);
        const restored = await success('seal_check', { project: factProject, draft, group: 'C16' });
        assert.deepEqual(restored.results.C16, []);
      }
    }
    for (const fixture of config.geometryFixtures) {
      const project = path.join(sandbox, `constraint-${fixture.id}`);
      execFileSync(process.execPath, [cli, 'project', 'init', '--root', project, '--name', 'SDK 容器约束', '--deadline', '2028-02-29', '--vault', created.vaultId, '--tender', fixture.file], { cwd: sandbox, encoding: 'utf8' });
      for (const route of ['direct', 'same-markdown', 'staged-direct', 'paragraph-markdown']) {
        const draft = route;
        await success('seal_doc_extract', { project, tender: 'tender/1.docx', draft, ranges: fixture.ranges });
        if (route === 'staged-direct') await success('seal_doc_edit', { project, draft, ops: [{ op: 'insert', at: fixture.at, position: 'after', markdown: '| 证据 | 备注 |\n| --- | --- |\n|  | 新表备注完整 |' }] });
        const at = route === 'staged-direct' ? fixture.at.includes('/c:') ? fixture.at.replace(/p:\d+$/, 't:0/r:1/c:0') : 't:0/r:1/c:0' : fixture.at;
        const operation = route === 'same-markdown' ? { op: 'insert', at, position: 'after', markdown: `| 证据 | 备注 |\n| --- | --- |\n| ${longMarkdown} | 新表备注完整 |` }
          : route === 'paragraph-markdown' ? { op: 'insert', at, position: 'after', markdown: longMarkdown } : { op: 'insert_image', at, image: longReference };
        await success('seal_doc_edit', { project, draft, ops: [{ ...operation, thirdPartyHolder: 'SDK 第三方主体' }] });
        const checked = await success('seal_check', { project, draft, group: 'C16' });
        assert.deepEqual(checked.results.C16, [], `${fixture.id}/${route}`);
        const file = path.join(project, 'draft', draft + '.docx'), xml = execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8' });
        const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml);
        assert.ok(Number(extent[1]) > 0 && Number(extent[2]) > 0);
        if (fixture.maxWidth) assert.ok(Number(extent[1]) <= fixture.maxWidth * 635);
        if (fixture.id === 'row-exact-0') assert.ok(Number(extent[2]) < 4000 * 635);
        if (config.geometryEvidence) { fs.mkdirSync(config.geometryEvidence, { recursive: true }); fs.copyFileSync(file, path.join(config.geometryEvidence, `${fixture.id}--${route}.docx`)); }
      }
    }
    await success('seal_doc_extract', { project: factProject, tender: 'tender/1.docx', draft: '事实册', ranges: [{ from: 'p:1', to: 't:0' }] });
    await success('seal_doc_edit', { project: factProject, draft: '事实册', ops: [{ op: 'replace', at: 'p:0', find: '姓名：____', value: '姓名：{{subject.legalName}}' }] });
    const subjectRead = await success('seal_doc_read', { project: factProject, file: '事实册', mode: 'search', query: 'SDK 本企业' });
    assert.ok(subjectRead.items.some(item => item.text.includes('SDK 本企业')));

    const draftPath = path.join(factProject, 'draft/事实册.docx'), ledgerPath = path.join(factProject, 'ledger.json');
    for (const [id, error] of [[expired, /已过期/], [forbidden, /禁用/], [mismatch, /不符/]]) {
      const draftBefore = fs.readFileSync(draftPath), ledgerBefore = fs.readFileSync(ledgerPath);
      await failure('seal_doc_edit', { project: factProject, draft: '事实册', ops: [{ op: 'replace', at: 'p:0', find: '电话：____', value: `电话：{{record:${id}.number}}` }] }, error);
      assert.deepEqual(fs.readFileSync(draftPath), draftBefore, 'Rejected citation leaves package bytes unchanged');
      assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBefore, 'Rejected citation leaves ledger bytes unchanged');
    }
    const draftBeforeThirdParty = fs.readFileSync(draftPath), ledgerBeforeThirdParty = fs.readFileSync(ledgerPath);
    await failure('seal_doc_edit', { project: factProject, draft: '事实册', ops: [{ op: 'set_cell', at: 't:0/r:0/c:1', value: `{{record:${thirdParty}.creditCode}}` }] }, /第三方.*声明/);
    assert.deepEqual(fs.readFileSync(draftPath), draftBeforeThirdParty);
    assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBeforeThirdParty);
    await success('seal_doc_edit', { project: factProject, draft: '事实册', ops: [{ op: 'set_cell', at: 't:0/r:0/c:1', value: `{{record:${thirdParty}.creditCode}}`, thirdPartyHolder: 'SDK 第三方主体' }] });
    await success('seal_doc_edit', { project: factProject, draft: '事实册', ops: [{ op: 'replace', at: 'p:0', find: '电话：____', value: `电话：{{record:${unknown.id}.number}}` }] });
    const unknownReport = await success('seal_check', { project: factProject, draft: '事实册' });
    assert.ok(unknownReport.results.C04.length > 0, 'Unknown source remains open for human review');
    assert.ok(unknownReport.results.C05.length > 0, 'Unknown source is visible in C05');
    assert.equal(unknownReport.results.C08.length, 0);
    assert.deepEqual(unknownReport.results.C10, [], 'Unknown citation is visibly highlighted and scoped');

    const markdown = `SDK 禁用主体 444444444444444444\n\n![证据](<kb:${imageRecord.id}/${imagePath}>)`;
    await success('seal_doc_edit', { project: factProject, draft: '事实册', ops: [{ op: 'insert', at: 'p:0', position: 'after', markdown }] });
    const identityReport = await success('seal_check', { project: factProject, draft: '事实册', group: 'C09' });
    assert.ok(identityReport.results.C09.some(item => item.value === 'SDK 禁用主体'));
    assert.ok(identityReport.results.C09.some(item => item.value === '444444444444444444'));
    const xml = execFileSync('unzip', ['-p', draftPath, 'word/document.xml'], { encoding: 'utf8' });
    assert.match(xml, /_Seal_F_[A-Za-z0-9]+/, 'Verified facts and evidence images carry document scopes');
    assert.match(xml, /<w:drawing\b/, 'The KB image was inserted through the document editor');
    assert.equal(execFileSync('unzip', ['-Z1', draftPath], { encoding: 'utf8' }).trim().split('\n').filter(member => member.startsWith('word/media/')).length, 1);

    const { sealRanges } = await import(pathToFileURL(path.join(packageDir, 'lib/core/docx/seal-ranges.js')).href);
    assert.ok(sealRanges(xml).some(range => range.text === '333333333333333333（持证方：SDK 第三方主体）'));
    const { visibleRunProperties } = await import(pathToFileURL(path.join(packageDir, 'lib/core/docx/visible-surgery.js')).href);
    const imageLink = `![证据](<kb:${imageRecord.id}/${imagePath}>)`;
    for (const [draft, op] of [
      ['第三方图文册', { op: 'insert', at: 'p:0', position: 'after', markdown: `![第三方证据](<${thirdPartyImage}>)` }],
      ['第三方单图册', { op: 'insert_image', at: 'p:0', image: thirdPartyImage }],
    ]) {
      await success('seal_doc_extract', { project: factProject, tender: 'tender/1.docx', draft, ranges: [{ from: 'p:1', to: 't:0' }] });
      await failure('seal_doc_edit', { project: factProject, draft, ops: [op] }, /第三方/);
      await success('seal_doc_edit', { project: factProject, draft, ops: [{ ...op, thirdPartyHolder: 'SDK 第三方主体' }] });
      const xml = execFileSync('unzip', ['-p', path.join(factProject, 'draft', `${draft}.docx`), 'word/document.xml'], { encoding: 'utf8' });
      const [range] = sealRanges(xml);
      assert.equal(range.text, '持证方：SDK 第三方主体\n');
      assert.match(xml.slice(range.startXml, range.endXml), /<w:drawing\b/);
      const report = await success('seal_check', { project: factProject, draft });
      assert.deepEqual(report.results.C05, []);
    }
    for (const [draft, markdown, expectedPending] of [
      ['分段证据册', `合成说明\n\n${imageLink}`, ['合成说明']],
      ['行内证据册', `合成前文 ${imageLink} 合成后文`, ['合成前文 ', ' 合成后文']],
    ]) {
      await success('seal_doc_extract', { project: factProject, tender: 'tender/1.docx', draft, ranges: [{ from: 'p:1', to: 't:0' }] });
      await success('seal_doc_edit', { project: factProject, draft, ops: [{ op: 'insert', at: 't:0', position: 'after', markdown, pending: { category: '报价', note: '待确认说明' } }] });
      const checked = await success('seal_check', { project: factProject, draft });
      assert.deepEqual(checked.results.C04.map(item => item.value), expectedPending);
      assert.ok(checked.results.C04.every(item => item.category === '报价'));
      for (const group of ['C01', 'C05', 'C08', 'C10']) assert.deepEqual(checked.results[group], []);
      const mixedXml = execFileSync('unzip', ['-p', path.join(factProject, 'draft', `${draft}.docx`), 'word/document.xml'], { encoding: 'utf8' });
      const scopes = sealRanges(mixedXml);
      assert.equal(scopes.length, expectedPending.length + 1);
      const imageFill = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).fills.find(item => item.draft === draft && item.sources.some(source => source.recordId === imageRecord.id && source.media));
      assert.ok(imageFill?.verified);
      const imageScope = scopes.find(scope => scope.name === `_Seal_F_${imageFill.id}`);
      assert.equal(imageScope?.text, '', 'The verified image scope contains just the drawing');
      assert.match(mixedXml.slice(imageScope.startXml, imageScope.endXml), /<w:drawing\b/);
      const styles = visibleRunProperties(mixedXml);
      for (const scope of scopes.filter(item => item.name.startsWith('_Seal_P_'))) {
        assert.ok(styles.slice(scope.start, scope.end).every(style => style.includes('<w:highlight w:val="yellow"/>')));
        assert.doesNotMatch(mixedXml.slice(scope.startXml, scope.endXml), /<w:drawing\b/);
      }
    }

    const pendingImage = await kb.save(created.vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title: '待核对图片', holder: 'SDK 本企业', validUntil: '长期' }, body: '' });
    await kb.save(created.vaultId, { action: 'attach_file', kind: 'record', id: pendingImage.id, file: { fileName: '未核实图片.png', bytes: fs.readFileSync(path.join(config.readonlyFixtures, 'evidence-2x1.png')) } });
    const pendingImageRef = `kb:${pendingImage.id}/${(await kb.get(created.vaultId, 'record', pendingImage.id)).fields.files[0]}`;
    for (const [draft, op, label, count] of [
      ['行内待核册', { op: 'insert', at: 't:0', position: 'after', markdown: `图前文字 ![待核](<${pendingImageRef}>) 图后文字` }, '（图片待核对1）', 1],
      ['单图待核册', { op: 'insert_image', at: 't:0', image: pendingImageRef }, '（图片待核对）', 1],
    ]) {
      await success('seal_doc_extract', { project: factProject, tender: 'tender/1.docx', draft, ranges: [{ from: 'p:1', to: 't:0' }] });
      await success('seal_doc_edit', { project: factProject, draft, ops: [op] });
      const checked = await success('seal_check', { project: factProject, draft });
      assert.equal(checked.results.C04.length, count);
      const imagePending = checked.results.C04.find(item => item.value === label + '\n');
      assert.equal(imagePending?.originalHighlights.length, label.length + 1);
      assert.equal(checked.results.C05.filter(item => item.reason === '事实引用内容已变化').length, 0);
      assert.ok(checked.results.C05.some(item => item.id === imagePending?.id && /未核实/.test(item.reason ?? '')));
      assert.deepEqual(checked.results.C10, []);
      const pendingXml = execFileSync('unzip', ['-p', path.join(factProject, 'draft', `${draft}.docx`), 'word/document.xml'], { encoding: 'utf8' });
      const scopes = sealRanges(pendingXml);
      assert.equal(scopes.length, count);
      const imageScope = scopes.find(scope => scope.name === `_Seal_P_${imagePending.id}`);
      assert.match(pendingXml.slice(imageScope.startXml, imageScope.endXml), /<w:drawing\b/);
    }

    await kb.save(created.vaultId, { action: 'update', kind: 'record', id: imageRecord.id, fields: { validUntil: '2020-01-01' } });
    const expiredImage = await success('seal_check', { project: factProject, draft: '行内证据册' });
    assert.equal(expiredImage.results.C08.length, 1, 'An attached image keeps its live evidence date');
    assert.ok(expiredImage.results.C05.length > 0);
    const draftBeforeImage = fs.readFileSync(draftPath), ledgerBeforeImage = fs.readFileSync(ledgerPath);
    await failure('seal_doc_edit', { project: factProject, draft: '事实册', ops: [{ op: 'insert', at: 't:0', position: 'after', markdown: `拒绝这段文字 ${imageLink}` }] }, /已过期/);
    assert.deepEqual(fs.readFileSync(draftPath), draftBeforeImage);
    assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBeforeImage);
  });
  await test('SDK reports distinct read-only objects and follows the suggested continuation', async () => {
    for (const [fixture, expectedBoxes] of [['readonly-single-textbox.docx', 1], ['readonly-two-textboxes.docx', 2], ['readonly-many.docx', 1], ['readonly-clean.docx', 0]]) {
      const input = path.join(config.readonlyFixtures, fixture), originalInput = fs.readFileSync(input), root = path.join(sandbox, fixture);
      execFileSync(process.execPath, [path.join(packageDir, 'lib/shells/cli/index.js'), 'project', 'init', '--root', root, '--name', '只读验收', '--deadline', '2028-02-29', '--tender', input], { cwd: sandbox, encoding: 'utf8' });
      const tender = await success('seal_doc_read', { project: root, file: 'tender/1.docx', mode: 'blocks', limit: 200 });
      const top = tender.items.filter(item => item.editable && item.address && !item.address.includes('/'));
      await success('seal_doc_extract', { project: root, tender: 'tender/1.docx', draft: '商务', ranges: [{ from: top[0].address, to: top.at(-1).address }] });
      const report = await success('seal_check', { project: root, draft: '商务', group: 'C02' });
      if (fixture === 'readonly-many.docx') {
        assert.ok(report.readonlyHints.remaining > 0);
        assert.equal(report.readonlyHints.continuation.tool, 'seal_doc_read');
        let options = report.readonlyHints.continuation.arguments;
        const locations = new Set();
        for (let page = 0; options; page++) {
          assert.ok(page < 20);
          const result = await success('seal_doc_read', { project: root, file: '商务', ...options });
          for (const item of result.items) if (!item.editable) locations.add(item.location);
          options = result.next;
        }
        for (const part of ['footer', 'footnotes', 'endnotes', 'comments']) assert.ok([...locations].some(location => location.includes(part)), part);
      } else {
        assert.equal(report.readonlyHints.items.filter(item => item.label?.includes('文本框')).length, expectedBoxes);
        if (fixture === 'readonly-clean.docx') assert.equal(report.readonlyHints.count, 0);
      }
      assert.deepEqual(fs.readFileSync(input), originalInput);
    }
  });
  await test('public reads return addressed items with bounded, replayable pages and literal search', async () => {
    const expected = [
      ['paragraph', 'p:0', '投标文件格式'], ['paragraph', 'p:1', blankName],
      ['table', 't:0', ''], ['row', 't:0/r:0', ''], ['cell', 't:0/r:0/c:0', ''],
      ['paragraph', 't:0/r:0/c:0/p:0', '报价'], ['cell', 't:0/r:0/c:1', '⟦0:⟧'],
      ['paragraph', 't:0/r:0/c:1/p:0', ''], ['paragraph', 'p:2', '固定原文必须保留。'],
    ];
    const seen = [];
    let options = { mode: 'blocks', limit: 2 };
    for (let page = 0; options; page++) {
      assert.ok(page < 10, 'Item pagination advances to the end');
      const result = await success('seal_doc_read', { project, file: 'tender/1.docx', ...options });
      readPage(result, 2, 12000);
      if (page === 0) {
        assert.deepEqual(result.items.map(item => [item.kind, item.address, item.text]), expected.slice(0, 2));
        assert.equal(result.next.cursor.item, 2);
        assert.equal(result.next.cursor.character, 0);
      }
      for (const item of result.items) {
        assert.deepEqual(item.fragment, { offset: 0, totalCharacters: item.text.length, complete: true });
        seen.push([item.kind, item.address, item.text]);
      }
      options = result.next;
    }
    assert.deepEqual(seen, expected);
    const fragments = new Map();
    options = { mode: 'blocks', limit: 2, maxChars: 7 };
    for (let page = 0; options; page++) {
      assert.ok(page < 30, 'Character pagination advances inside a displayed block');
      const result = await success('seal_doc_read', { project, file: 'tender/1.docx', ...options });
      readPage(result, 2, 7);
      for (const item of result.items) {
        const prior = fragments.get(item.address) ?? '';
        const completeText = expected.find(([, address]) => address === item.address)[2];
        assert.equal(item.fragment.offset, prior.length);
        assert.equal(item.fragment.totalCharacters, completeText.length);
        assert.equal(item.fragment.complete, prior.length + item.text.length === completeText.length);
        fragments.set(item.address, prior + item.text);
      }
      options = result.next;
    }
    assert.deepEqual([...fragments], expected.map(([, address, text]) => [address, text]));
    const outline = await success('seal_doc_read', { project, file: 'tender/1.docx', mode: 'outline' });
    readPage(outline, 60, 12000);
    assert.deepEqual(outline.items.map(({ kind, address, text, level, parent, range, counts }) => ({ kind, address, text, level, parent, range, counts })), [
      { kind: 'section', address: 'p:0', text: '投标文件格式', level: 1, parent: null, range: { from: 'p:0', to: 'p:2' }, counts: { paragraphs: 5, tables: 1, hints: 4 } },
    ]);
    const cell = await success('seal_doc_read', { project, file: 'tender/1.docx', mode: 'blocks', from: 't:0/r:0/c:0/p:0', limit: 1 });
    assert.deepEqual(cell.items.map(item => [item.address, item.text]), [['t:0/r:0/c:0/p:0', '报价']]);
    const search = await success('seal_doc_read', { project, file: 'tender/1.docx', mode: 'search', query: '电话', context: 0 });
    readPage(search, 30, 12000);
    assert.deepEqual(search.items.map(item => [item.kind, item.address, item.text]), [['paragraph', 'p:1', '电话']]);
    const literal = await success('seal_doc_read', { project, file: 'tender/1.docx', mode: 'search', query: '.*' });
    assert.deepEqual(literal.items, []);
    await failure('seal_doc_read', { project, file: 'tender/1.docx', mode: 'blocks', from: 'p:99999' }, /地址|视图/);
    await failure('seal_doc_read', { project, file: 'tender/1.docx', mode: 'blocks', maxChars: 1 }, /长度|分页|参数/);
  });
  await test('standalone Native calls read, extract, edit and check real project files', async () => {
    const read = await success('seal_doc_read', { project, file: 'tender/1.docx', mode: 'blocks', from: 'p:1', limit: 1 });
    assert.deepEqual(read.items.map(item => [item.address, item.text]), [['p:1', blankName]]);
    const extracted = await success('seal_doc_extract', { project, tender: 'tender/1.docx', draft: '商务', ranges: [{ from: 'p:1', to: 't:0' }] });
    assert.equal(extracted.draft, '商务');
    assert.deepEqual(fs.readFileSync(path.join(project, 'draft/商务.docx')), fs.readFileSync(path.join(project, 'draft/商务.base.docx')));
    const edited = await success('seal_doc_edit', { project, draft: '商务', ops: [
      { op: 'replace', at: 'p:0', find: '姓名：____', value: '姓名：张三' },
      { op: 'check', at: 'p:0', option: '同意', checked: true },
      { op: 'set_cell', at: 't:0/r:0/c:1', value: '100' },
    ] });
    assert.ok(edited.pending.some(item => item.category === '报价' && item.reasons.every(reason => reason.source === 'keyword')));
    fs.copyFileSync(path.join(sandbox, 'image.gif'), path.join(project, 'materials/image.gif'));
    await success('seal_doc_edit', { project, draft: '商务', ops: [{ op: 'insert', at: 't:0', position: 'after', markdown: '## 方案\n\n正文 **重点**。' }] });
    await success('seal_doc_edit', { project, draft: '商务', ops: [{ op: 'insert_image', at: 't:0', image: 'materials/image.gif' }] });
    const current = await success('seal_doc_read', { project, file: '商务', mode: 'blocks' });
    readPage(current, 60, 12000);
    const at = address => current.items.find(item => item.address === address);
    assert.equal(at('p:0').text, '姓名：张三 电话：⟦0:____⟧ ☑同意');
    assert.equal(at('t:0/r:0/c:0/p:0').text, '报价');
    assert.equal(at('t:0/r:0/c:1/p:0').text, '«待定:报价»100«/待定»');
    assert.ok(!current.items.some(item => item.address === 't:0/r:0/c:1/p:1'));
    assert.equal(at('p:2').text, '方案');
    assert.equal(at('p:3').text, '正文 重点。');
    const forgedContext = await success('seal_doc_read', { project, file: '商务', mode: 'blocks', pending: [{ address: 'p:0', find: '姓名：张三', category: '已核实' }] });
    assert.deepEqual(forgedContext, current, 'Agent arguments cannot replace the trusted pending display context');
    const partial = await success('seal_doc_read', { project, file: '商务', mode: 'blocks', limit: 1, maxChars: 7 });
    readPage(partial, 1, 7);
    assert.equal(partial.items[0].text, at('p:0').text.slice(0, 7));
    const continued = await success('seal_doc_read', { project, file: '商务', ...partial.next, maxChars: 50000 });
    readPage(continued, 1, 50000);
    assert.equal(continued.items[0].address, 'p:0');
    assert.equal(continued.items[0].fragment.offset, 7);
    assert.equal(continued.items[0].text, at('p:0').text.slice(7), 'The host reinjects pending context for continuation calls');
    await failure('seal_doc_read', { project, file: '商务', ...partial.next, cursor: { ...partial.next.cursor, request: '0'.repeat(64) } }, /续读|改变|参数/);
    const draftPath = path.join(project, 'draft/商务.docx');
    const documentXml = execFileSync('unzip', ['-p', draftPath, 'word/document.xml'], { encoding: 'utf8' });
    const members = execFileSync('unzip', ['-Z1', draftPath], { encoding: 'utf8' }).trim().split('\n');
    assert.match(documentXml, /<w:drawing\b/, 'The written Word contains the inserted image object');
    assert.match(documentXml, /<w:highlight w:val="yellow"/, 'Pending fills retain native Word highlighting');
    assert.equal(members.filter(member => member.startsWith('word/media/')).length, 1, 'The converted image is actually attached');
    const reports = await success('seal_check', { project, draft: '商务' });
    assert.equal(reports.draft, '商务');
    checkReport(reports);
    assert.deepEqual(fs.readFileSync(source), original);
  });
  await test('SDK errors preserve drafts and cannot exercise human authority or internal XML opcodes', async () => {
    await failure('seal_doc_read', { file: 'tender/1.docx', mode: 'blocks' }, /project/);
    await failure('seal_doc_read', { project, file: 'tender/1.docx', mode: 'blocks', limit: 'wrong' }, /INVALID_ARGS/);
    const draftPath = path.join(project, 'draft/商务.docx');
    const before = fs.readFileSync(draftPath);
    const ledgerBefore = fs.readFileSync(path.join(project, 'ledger.json'));
    for (const ops of [
      [{ op: 'insert_prepared_image', at: 'p:0', drawing: '<bad/>' }],
      [{ op: 'replace', at: 'p:0', find: '张三', value: '李四', explicitlyConfirmed: true }],
      [{ op: 'insert', at: 'p:0', position: 'after', markdown: 'x', compiledXml: '<bad/>' }],
      [{ op: 'replace', at: 'p:0', find: '张三', value: '李四' }, { op: 'insert_prepared_image', at: 'p:0', drawing: '<bad/>' }],
    ]) {
      await failure('seal_doc_edit', { project, draft: '商务', ops }, /编辑操作.*(无效|不支持|参数)/);
      assert.deepEqual(fs.readFileSync(draftPath), before, 'Rejected batch leaves draft bytes unchanged');
      assert.deepEqual(fs.readFileSync(path.join(project, 'ledger.json')), ledgerBefore, 'Rejected batch leaves ledger bytes unchanged');
    }
    for (const tool of ['seal_confirm_pending', 'seal_accept_change', 'seal_verify_record', 'seal_export_final', 'seal_mark_coverage']) await failure(tool, { project }, /UNKNOWN_TOOL/);
  });
  await test('seal_requirements executes through Native SDK, validates C14/schema atomically and paginates', async () => {
    const reqProject = path.join(sandbox, 'req-sdk-project');
    initialize(reqProject);
    const missing = await success('seal_requirements', { project: reqProject, action: 'list' });
    assert.equal(missing.kind, 'missing');
    await failure('seal_requirements', {
      project: reqProject,
      action: 'save',
      items: [
        {
          id: 'r-ok',
          kind: '格式要求',
          text: '投标文件格式',
          quote: '投标文件格式',
          source: { file: 'tender/1.docx', address: 'p:0' },
          mustRespond: false,
          responses: [],
        },
        {
          id: 'r-bad-quote',
          kind: '实质性条款',
          text: '不存在引文',
          quote: '绝对不存在的招标文本',
          source: { file: 'tender/1.docx', address: 'p:0' },
          mustRespond: true,
          responses: [],
        },
      ],
    }, /要求清单校验失败/);
    assert.equal(fs.existsSync(path.join(reqProject, 'requirements.json')), false);
    const saved = await success('seal_requirements', {
      project: reqProject,
      action: 'save',
      items: [
        {
          id: 'r-1',
          kind: '格式要求',
          text: '按投标文件格式编写',
          quote: '投标文件格式',
          source: { file: 'tender/1.docx', address: 'p:0' },
          mustRespond: true,
          responses: [],
        },
        {
          id: 'r-2',
          kind: '实质性条款',
          text: '保留固定原文',
          quote: '固定原文必须保留。',
          source: { file: 'tender/1.docx', address: 'p:2' },
          mustRespond: false,
          responses: [],
        },
      ],
    });
    assert.equal(saved.saved, true);
    assert.equal(saved.count, 2);
    const page1 = await success('seal_requirements', { project: reqProject, action: 'list', offset: 0, limit: 1 });
    assert.equal(page1.kind, 'value');
    assert.equal(page1.items.length, 1);
    assert.equal(page1.nextOffset, 1);
    const page2 = await success('seal_requirements', { project: reqProject, action: 'list', offset: 1, limit: 1 });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextOffset, null);
    await failure('seal_requirements', { project: reqProject, action: 'cover' }, /INVALID_ARGS|save|list/);
  });
  await test('seal-bid and seal-kb skills register in installed dsh-skill, load via skill tool, and degrade gracefully without skills service', async () => {
    handle = await ctx.agents.create({ sessionId: `seal-skill-${randomUUID()}`, meta: { cwd: agentProject } });
    const agent = handle.agent;
    const snapshot = await ctx.skills.snapshot({ cwd: agentProject, scope: agent });
    for (const [skillName, expectedMarker, toolExpected] of [
      ['seal-bid', 'seal_requirements', /读招标文件/],
      ['seal-kb', 'seal_kb_ingest', /seal_kb_save/],
    ]) {
      const summary = snapshot.skills.find(item => item.name === skillName);
      assert.ok(summary, `${skillName} must appear in installed dsh-skill catalog`);
      assert.equal(summary.source, 'bundled');
      assert.equal(summary.invocation.modelInvocable, true);
      assert.ok(summary.description.length > 0 && summary.description.length <= 500);
      const loaded = await ctx.skills.get(skillName, { cwd: agentProject, scope: agent });
      assert.ok(loaded?.content.includes(expectedMarker));
      const toolResult = await invoke('skill', { name: skillName }, agent);
      assert.equal(toolResult.isError, false, JSON.stringify(toolResult));
      assert.equal(toolResult.value?.name, skillName);
      assert.match(toolResult.value?.content ?? '', toolExpected);
    }
    await handle.dispose();
    handle = undefined;

    // Optional skills service degradation: mounting seal-workbench without dsh-skill still registers all 9 tools.
    const minimal = new Context();
    try {
      for (const [name, settings, namespace] of [
        ['dsh-system-prompt', {}, false], ['dsh-session-projection', {}, false], ['dsh-session', {}, false],
        ['dsh-agent', {}, false], ['dsh-llm', {}, false], ['dsh-tools', {}, false],
        ['dsh-tool-executor-native', {}, true], ['dsh-fs-local', { cwd: sandbox }, false],
        ['dsh-working-directory', { defaultDirectory: sandbox }, false],
      ]) {
        const module = await get(name);
        await minimal.plugin(namespace ? module : module.default, settings);
      }
      await minimal.plugin(host);
      assert.deepEqual(minimal.tools.definitions().map(tool => tool.name).sort(), expectedSealTools);
    } finally {
      await minimal.fiber.dispose();
    }
  });
  await test('a real Agent supplies its session cwd to all four Native calls', async () => {
    handle = await ctx.agents.create({ sessionId: `seal-sdk-${randomUUID()}`, meta: { cwd: agentProject } });
    assert.equal(await ctx.workingDirectory.ensure(handle.agent, signal), agentProject);
    const agent = handle.agent;
    const read = await success('seal_doc_read', { file: 'tender/1.docx', mode: 'blocks' }, agent);
    assert.deepEqual(read.items.filter(item => item.address === 'p:1').map(item => item.text), [blankName]);
    await success('seal_doc_extract', { tender: 'tender/1.docx', draft: '会话册', ranges: [{ from: 'p:1', to: 't:0' }] }, agent);
    await success('seal_doc_edit', { draft: '会话册', ops: [{ op: 'replace', at: 'p:0', find: '姓名：____', value: '姓名：会话填写', pending: { category: '其他', note: '核对' } }] }, agent);
    const current = await success('seal_doc_read', { file: '会话册', mode: 'search', query: '会话填写', context: 0 }, agent);
    assert.deepEqual(current.items.map(item => [item.address, item.text]), [['p:0', '«待定:其他»会话填写«/待定»']]);
    const reports = await success('seal_check', { draft: '会话册' }, agent);
    assert.equal(reports.draft, '会话册');
    checkReport(reports);
    assert.ok(fs.existsSync(path.join(agentProject, 'draft/会话册.docx')));
    assert.equal(fs.existsSync(path.join(project, 'draft/会话册.docx')), false);
    assert.deepEqual(fs.readFileSync(source), original);
    await handle.dispose();
    handle = undefined;
  });
  await test('ledger tampering stays visible in C15 after an ordinary Native edit', async () => {
    const mutations = [
      ['delete-pending', ledger => { ledger.pending = []; }],
      ['forge-draft-digest', ledger => { ledger.drafts['篡改册'] = '0'.repeat(64); }],
      ['remove-seal', ledger => { delete ledger.integrity; }],
      ['forge-seal', ledger => { ledger.integrity.signature = '0'.repeat(64); }],
      ['replay-sealed-ledger', null],
    ];
    for (const [name, mutate] of mutations) {
      const root = path.join(sandbox, name);
      initialize(root);
      await success('seal_doc_extract', { project: root, tender: 'tender/1.docx', draft: '篡改册', ranges: [{ from: 'p:1', to: 't:0' }] });
      const ledgerPath = path.join(root, 'ledger.json');
      const earlierSealedLedger = fs.readFileSync(ledgerPath);
      await success('seal_doc_edit', { project: root, draft: '篡改册', ops: [{ op: 'replace', at: 'p:0', find: '姓名：____', value: '姓名：张三', pending: { category: '其他', note: '核对' } }] });
      const baseline = await success('seal_check', { project: root, draft: '篡改册' });
      checkReport(baseline);
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      assert.ok(ledger.pending.length > 0, `${name}: the negative control starts with real pending records`);
      if (mutate) {
        mutate(ledger);
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
      } else fs.writeFileSync(ledgerPath, earlierSealedLedger);
      const detected = await success('seal_check', { project: root, draft: '篡改册' });
      assert.ok(detected.results.C15.length > 0, `${name}: check detects the modified ledger`);
      const draftPath = path.join(root, 'draft/篡改册.docx');
      const beforeEdit = fs.readFileSync(draftPath);
      await success('seal_doc_edit', { project: root, draft: '篡改册', ops: [{ op: 'replace', at: 'p:0', find: '姓名：张三', value: '姓名：李四' }] });
      assert.notDeepEqual(fs.readFileSync(draftPath), beforeEdit, `${name}: a valid edit still writes its draft`);
      const afterEdit = await success('seal_check', { project: root, draft: '篡改册' });
      assert.ok(afterEdit.results.C15.length > 0, `${name}: a normal edit cannot clear the integrity incident`);
      assert.ok(afterEdit.results.C04.length > 0, `${name}: unconfirmed facts cannot become confirmed`);
      console.log(JSON.stringify({ ledgerMutation: name, detected: detected.results.C15, afterEdit: afterEdit.results.C15 }));
    }
    assert.deepEqual(fs.readFileSync(source), original);
  });
  await test('Milestone #37 Slice 1 tool upgrades: compact render, cursor string/object, to/onlyHints, dismiss_hints, requirements patch and batch kb dismiss', async () => {
    const m37Project = path.join(sandbox, 'm37-sdk-project');
    initialize(m37Project);

    // 1. Compact render folds empty table/row/cell shells, preserves empty cell ⟦0:⟧ and achieves strong compression
    const fullRead = await invokeSuccessRaw('seal_doc_read', { project: m37Project, file: 'tender/1.docx', mode: 'blocks', limit: 200 });
    assert.ok(!fullRead.text.includes('"location":'), 'Compact render omits redundant JSON location wrapper');
    assert.ok(!fullRead.text.includes('[t:0]'), 'Compact render folds empty table shell');
    assert.ok(!fullRead.text.includes('[t:0/r:0]'), 'Compact render folds empty row shell');
    assert.ok(!fullRead.text.includes('[t:0/r:0/c:0]'), 'Compact render folds empty cell shell');
    assert.match(fullRead.text, /\[t:0\/r:0\/c:0\/p:0\] 报价/);
    assert.match(fullRead.text, /\[t:0\/r:0\/c:1\] ⟦0:⟧/);
    assert.ok(fullRead.text.length < fullRead.jsonLength * 0.55, `Compact render (${fullRead.text.length}) must substantially compress JSON (${fullRead.jsonLength})`);

    // 2. cursor accepts both object and JSON string, and invalid cursor produces actionable Chinese error
    const page1 = await invokeSuccessRaw('seal_doc_read', { project: m37Project, file: 'tender/1.docx', mode: 'blocks', limit: 2 });
    assert.ok(page1.data.next?.cursor);
    assert.match(page1.text, /truncated=true/);
    assert.match(page1.text, /next=/);
    const page2Obj = await success('seal_doc_read', { project: m37Project, file: 'tender/1.docx', ...page1.data.next });
    const page2Str = await success('seal_doc_read', {
      project: m37Project, file: 'tender/1.docx', mode: page1.data.next.mode, limit: page1.data.next.limit,
      maxChars: page1.data.next.maxChars, context: page1.data.next.context,
      cursor: JSON.stringify(page1.data.next.cursor),
    });
    assert.deepEqual(page2Obj.items, page2Str.items);
    const partialRead = await invokeSuccessRaw('seal_doc_read', { project: m37Project, file: 'tender/1.docx', mode: 'blocks', limit: 1, maxChars: 4 });
    assert.match(partialRead.text, /frag:0\.\.4\//);
    await failure('seal_doc_read', { project: m37Project, file: 'tender/1.docx', mode: 'blocks', cursor: '{bad-json' }, /cursor/);

    // 3. `to` (with descendants) and `onlyHints`
    const ranged = await success('seal_doc_read', { project: m37Project, file: 'tender/1.docx', mode: 'blocks', from: 'p:1', to: 't:0' });
    assert.ok(ranged.items.some(i => i.address === 't:0/r:0/c:1'));
    assert.ok(!ranged.items.some(i => i.address === 'p:2'));
    const hintsOnly = await success('seal_doc_read', { project: m37Project, file: 'tender/1.docx', mode: 'blocks', onlyHints: true });
    assert.deepEqual(hintsOnly.items.map(i => i.address), ['p:1', 't:0/r:0/c:1']);

    // 4. seal_doc_edit strips originalHighlights, supports dismiss_hints, and returns rich failure diagnostics
    await success('seal_doc_extract', { project: m37Project, tender: 'tender/1.docx', draft: '商务', ranges: [{ from: 'p:0', to: 'p:2' }] });
    const edited = await success('seal_doc_edit', { project: m37Project, draft: '商务', ops: [{ op: 'replace', at: 'p:1', blank: 0, value: '李四', pending: { category: '其他', note: '核对' } }] });
    assert.ok(edited.pending.length > 0);
    for (const item of edited.pending) assert.equal(Object.hasOwn(item, 'originalHighlights'), false);
    const ledgerAfterEdit = JSON.parse(fs.readFileSync(path.join(m37Project, 'ledger.json'), 'utf8'));
    assert.ok(Array.isArray(ledgerAfterEdit.pending[0].originalHighlights) && ledgerAfterEdit.pending[0].originalHighlights.length > 0);

    await success('seal_doc_edit', { project: m37Project, draft: '商务', ops: [{ op: 'dismiss_hints', from: 'p:1', to: 't:0', reason: 'SDK 批量跳过' }] });
    const checkAfterDismiss = await success('seal_check', { project: m37Project, draft: '商务' });
    assert.equal(checkAfterDismiss.results.C02.length, 0);
    assert.equal(checkAfterDismiss.results.C03.length, 3);

    await failure('seal_doc_edit', {
      project: m37Project, draft: '商务',
      ops: [{ op: 'replace', at: 'p:1', find: '不存在的原文', value: 'x' }],
    }, /currentBlock.*p:1/);

    // 5. seal_requirements action=patch
    await success('seal_requirements', {
      project: m37Project,
      action: 'save',
      items: [{ id: 'req-1', kind: '格式要求', text: '按格式编写', quote: '投标文件格式', source: { file: 'tender/1.docx', address: 'p:0' }, mustRespond: true, responses: [] }],
    });
    const patched = await success('seal_requirements', {
      project: m37Project,
      action: 'patch',
      items: [{ id: 'req-1', responses: [{ draft: '商务', address: 'p:0' }] }],
    });
    assert.equal(patched.patched, true);
    assert.equal(patched.updatedCount, 1);
    const listed = await success('seal_requirements', { project: m37Project, action: 'list' });
    assert.deepEqual(listed.items[0].responses, [{ draft: '商务', address: 'p:0' }]);
    await failure('seal_requirements', { project: m37Project, action: 'patch', items: [{ id: 'req-1', covered: true }] }, /覆盖|核实|禁止/);

    // 6. seal_kb_save dismiss_candidates & dismissCandidateIds
    const cli = path.join(packageDir, 'lib/shells/cli/index.js');
    const m37Vault = JSON.parse(execFileSync(process.execPath, [cli, 'kb', 'init', '--vault', 'm37-sdk-vault', '--name', 'M37 SDK 柜'], { cwd: sandbox, encoding: 'utf8' })).vaultId;
    const batchDir = path.join(process.env.SEAL_HOME, 'vaults', m37Vault, 'inbox', 'batch-m37');
    fs.mkdirSync(batchDir, { recursive: true });
    const { serializeEntry } = await import(pathToFileURL(path.join(packageDir, 'lib/core/kb/markdown.js')).href);
    for (const cid of ['candidate-a', 'candidate-b', 'candidate-c']) {
      fs.writeFileSync(path.join(batchDir, `${cid}.md`), serializeEntry({ title: cid, source: 'm.docx', processed: false }, `body ${cid}`));
    }
    const createdWithDismiss = await success('seal_kb_save', {
      vaultId: m37Vault, action: 'create', kind: 'record',
      fields: { type: '其他', title: 'M37 记录' }, body: '正文', dismissCandidateIds: ['candidate-a'],
    });
    assert.deepEqual(createdWithDismiss.dismissedCandidateIds, ['candidate-a']);
    const dismissedBatch = await success('seal_kb_save', {
      vaultId: m37Vault, action: 'dismiss_candidates', ids: ['candidate-b', 'candidate-c'],
    });
    assert.equal(dismissedBatch.dismissedCount, 2);
    await failure('seal_kb_save', {
      vaultId: m37Vault, action: 'dismiss_candidates', ids: ['candidate-b'], fields: { verified: true },
    }, /不能设置核实字段/);
  });
  await test('plugin disposal removes its real tool and skill registrations', async () => {
    await plugin.dispose();
    plugin = undefined;
    assert.deepEqual(ctx.tools.definitions().map(tool => tool.name), ['skill']);
    const remaining = await ctx.skills.list({ cwd: agentProject });
    assert.equal(remaining.some(item => item.name === 'seal-bid'), false);
    assert.equal(remaining.some(item => item.name === 'seal-kb'), false);
  });
} finally {
  if (handle) await handle.dispose();
  await ctx.fiber.dispose();
  hook.deregister();
  console.log(JSON.stringify({ sdkResolutions: Object.fromEntries(sdkResolutions), runtimeResolutions: Object.fromEntries(runtimeResolutions), disposed: true }));
}
