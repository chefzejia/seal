import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeBase, type KbEntry, type SaveInput } from '../src/core/kb/index.js';
import { NodeHostPort } from '../src/shells/node-host.js';
import { runKnowledgeBase } from '../src/shells/cli/kb.js';
import { parseEntry, serializeEntry } from '../src/core/kb/markdown.js';

async function sandbox(t: TestContext) {
  const home = path.resolve('.tmp', `kb-contract-${randomUUID()}`);
  await fs.mkdir(home, { recursive: true });
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });
  const host = new NodeHostPort();
  const kb = new KnowledgeBase(host, path.join(home, 'vaults'));
  const vaultId = 'contract-vault';
  await kb.createVault({ vaultId, name: '机制测试资料柜' });
  const root = kb.vaultRoot(vaultId);
  const run = (command: string, ...args: string[]) => runKnowledgeBase(host, [command, '--vault', vaultId, ...args]);
  return { home, host, kb, vaultId, root, run };
}

test('health reports unknown metadata, required fields, duplicates and every unverified subject field', async t => {
  const { kb, vaultId } = await sandbox(t);
  await kb.save(vaultId, { action: 'update', kind: 'subject', fields: {
    legalName: '合成机构', address: '未核实地址', phone: '123', email: '', forbiddenAffiliates: [], thirdPartyHolders: ['合成供应商'], futureSubject: '保留主体字段',
  } });
  await kb.verify(vaultId, 'subject', 'subject', ['legalName']);
  const certificate = await kb.save(vaultId, { action: 'create', kind: 'record', fields: { type: '认证证书', title: '缺项证照', futureRecord: '保留记录字段' } });
  const contract = await kb.save(vaultId, { action: 'create', kind: 'record', fields: { type: '业绩合同', title: '缺项业绩' } });
  const material = await kb.save(vaultId, { action: 'create', kind: 'material', fields: { title: '素材', futureMaterial: ['保留素材字段'] } });
  const duplicates = [];
  for (const type of ['认证证书', '认证证书', '许可证']) {
    duplicates.push(await kb.save(vaultId, { action: 'create', kind: 'record', fields: { type, number: 'SAME-1', holder: '合成机构', validUntil: '长期' } }));
  }
  const report = await kb.health(vaultId, '2026-11-20');
  const fields = (id: string, code: string) => report.issues.filter(issue => issue.id === id && issue.code === code).map(issue => issue.field).sort();
  assert.deepEqual(fields('subject', 'subject_unverified'), ['address', 'futureSubject', 'phone', 'thirdPartyHolders']);
  assert.deepEqual(fields(certificate.id, 'field_missing'), ['holder', 'number', 'validUntil']);
  assert.deepEqual(fields(contract.id, 'field_missing'), ['amount', 'client', 'signedOn']);
  for (const [id, field] of [['subject', 'futureSubject'], [certificate.id, 'futureRecord'], [material.id, 'futureMaterial']]) {
    assert.deepEqual(fields(id, 'field_unknown'), [field]);
  }
  assert.deepEqual(report.issues.filter(issue => issue.code === 'record_duplicate').map(issue => issue.id).sort(), duplicates.slice(0, 2).map(entry => entry.id).sort());
  assert.equal((await kb.get(vaultId, 'material', material.id)).fields.futureMaterial instanceof Array, true);
});

test('health includes invalid record and subject HMAC signatures after external metadata changes', async t => {
  const { kb, vaultId, root } = await sandbox(t);
  await kb.save(vaultId, { action: 'update', kind: 'subject', fields: { legalName: '合成机构', address: '原地址' } });
  await kb.verify(vaultId, 'subject', 'subject', ['legalName', 'address']);
  const record = await kb.save(vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title: '原名称' } });
  await kb.verify(vaultId, 'record', record.id);
  for (const [file, before, after] of [['subject.md', '原地址', '外部地址'], [`records/${record.id}.md`, '原名称', '外部名称']]) {
    const target = path.join(root, file);
    await fs.writeFile(target, (await fs.readFile(target, 'utf8')).replace(before, after));
  }
  const report = await kb.health(vaultId, '2026-11-20');
  for (const [kind, id] of [['subject', 'subject'], ['record', record.id]]) {
    const entry = await kb.get(vaultId, kind as 'subject' | 'record', id);
    assert.ok(entry.issues.length > 0);
    for (const message of entry.issues) assert.ok(report.issues.some(issue => issue.id === id && issue.message === message), `${kind}: HMAC failure must reach aggregate health`);
  }
  const subjectPath = path.join(root, 'subject.md');
  const raw = parseEntry(await fs.readFile(subjectPath, 'utf8'));
  for (const encoded of ['null', '[]', '"invalid"', '{}', '{"address":false}', '{"address":12}', JSON.stringify({ address: ['f'.repeat(64)] })]) {
    await fs.writeFile(subjectPath, serializeEntry({ ...raw.fields, __sealVerification: encoded }, raw.body));
    const result: { entry?: KbEntry } = {};
    await assert.doesNotReject(async () => { result.entry = await kb.get(vaultId, 'subject'); }, 'malformed HMAC metadata must remain readable as unverified');
    assert.ok(result.entry);
    assert.deepEqual(result.entry.verifiedFields, []);
    const health = await kb.health(vaultId, '2026-11-20');
    assert.ok(health.issues.some(issue => issue.id === 'subject' && issue.code === 'verification_invalid'));
  }
  const recordPath = path.join(root, 'records', `${record.id}.md`);
  const recordRaw = parseEntry(await fs.readFile(recordPath, 'utf8'));
  for (const kind of ['subject', 'record'] as const) {
    const original = kind === 'subject' ? raw : recordRaw;
    const target = kind === 'subject' ? subjectPath : recordPath;
    const id = kind === 'subject' ? 'subject' : record.id;
    for (const marker of [undefined, true, [], 'null', '[]', '"scalar"', '{}', '{"address":false}']) {
      const fields = { ...original.fields };
      if (marker === undefined) delete fields.__sealVerification;
      else fields.__sealVerification = marker;
      await fs.writeFile(target, serializeEntry(fields, original.body));
      const result: { entry?: KbEntry } = {};
      await assert.doesNotReject(async () => { result.entry = await kb.get(vaultId, kind, id); }, `${kind}: malformed marker remains readable`);
      assert.ok(result.entry);
      const entry = result.entry;
      assert.equal(entry.verified, false);
      assert.ok(entry.issues.length > 0);
      const aggregate = await kb.health(vaultId, '2026-11-20');
      for (const message of entry.issues) assert.ok(aggregate.issues.some(issue => issue.kind === kind && issue.id === id && issue.message === message));
    }
  }
  await fs.writeFile(recordPath, serializeEntry({ ...recordRaw.fields, verified: 'true' }, recordRaw.body));
  assert.ok((await kb.get(vaultId, 'record', record.id)).issues.length > 0, 'wrong-type verification flag is explicitly reported');
  for (const verifiedFields of [undefined, true, 'legalName', []]) {
    const fields = { ...raw.fields };
    if (verifiedFields === undefined) delete fields.verifiedFields;
    else fields.verifiedFields = verifiedFields;
    await fs.writeFile(subjectPath, serializeEntry(fields, raw.body));
    const entry = await kb.get(vaultId, 'subject');
    assert.equal(entry.verified, false);
    assert.ok(entry.issues.length > 0, 'missing or wrong-type field declarations are explicitly reported');
    assert.ok((await kb.health(vaultId, '2026-11-20')).issues.some(issue => issue.id === 'subject' && issue.code === 'verification_invalid'));
  }
});

test('all save actions reject privileged metadata before dispatch without file or log changes', async t => {
  const { kb, vaultId, root, host } = await sandbox(t);
  const record = await kb.save(vaultId, { action: 'create', kind: 'record', fields: { title: '原记录' } });
  const batch = path.join(root, 'inbox', 'batch-test');
  await fs.mkdir(batch, { recursive: true });
  await fs.writeFile(path.join(batch, 'candidate-test.md'), serializeEntry({ title: '候选', processed: false }, '原文'));
  const snapshot = async () => Promise.all((await host.listFiles(root)).sort().map(async file => [file, Buffer.from(await host.readBytes(path.join(root, file))).toString('base64')]));
  const before = await snapshot();
  for (const action of ['create', 'update', 'delete', 'attach_file', 'dismiss_candidate'] as const) {
    for (const field of ['verified', 'verifiedAt', 'verifiedFields', '__sealVerification', '__sealFuture']) {
      const input: SaveInput = { action, kind: 'record', id: action === 'dismiss_candidate' ? 'candidate-test' : record.id, fields: { [field]: 'forbidden' }, file: { fileName: 'proof.txt', bytes: new TextEncoder().encode('attachment') } };
      await assert.rejects(kb.save(vaultId, input), /不能设置核实字段/, `${action}/${field}`);
      assert.deepEqual(await snapshot(), before, `${action}/${field} preserves every file and log`);
    }
  }
});

test('no-op saves preserve valid record and subject signatures, real changes revoke them', async t => {
  const { kb, vaultId } = await sandbox(t);
  const record = await kb.save(vaultId, { action: 'create', kind: 'record', fields: { title: '已核实记录', tags: ['甲', '乙'] }, body: '正文' });
  await kb.verify(vaultId, 'record', record.id);
  for (const update of [{}, { fields: { title: '已核实记录' } }, { fields: { tags: ['甲', '乙'] }, body: '正文' }]) {
    const result = await kb.save(vaultId, { action: 'update', kind: 'record', id: record.id, ...update });
    assert.equal(result.verified, true, 'unchanged content retains its HMAC');
    assert.deepEqual(result.issues, []);
  }
  assert.equal((await kb.save(vaultId, { action: 'update', kind: 'record', id: record.id, body: '新正文' })).verified, false);
  await kb.save(vaultId, { action: 'update', kind: 'subject', fields: { legalName: '合成机构', address: '原地址' } });
  await kb.verify(vaultId, 'subject', 'subject', ['legalName', 'address']);
  const unchanged = await kb.save(vaultId, { action: 'update', kind: 'subject', fields: { legalName: '合成机构' } });
  assert.deepEqual(unchanged.verifiedFields, ['address', 'legalName']);
  const changed = await kb.save(vaultId, { action: 'update', kind: 'subject', fields: { address: '新地址' } });
  assert.deepEqual(changed.verifiedFields, ['legalName']);
});

test('CLI get enforces UTF-16 code point starts and bounded continuation for every entry kind', async t => {
  const { kb, vaultId, root, run } = await sandbox(t);
  const record = await kb.save(vaultId, { action: 'create', kind: 'record', fields: { title: '游标记录' } });
  const material = await kb.save(vaultId, { action: 'create', kind: 'material', fields: { title: '游标素材' } });
  const batch = path.join(root, 'inbox', 'batch-test');
  await fs.mkdir(batch, { recursive: true });
  const escaped = '甲😀' + String.fromCharCode(34, 92, 10, 9) + '𠮷末';
  const samples = ['', '甲乙丙', '甲😀𠮷', escaped, '甲乙丙'.repeat(20000), '甲😀𠮷'.repeat(14000), escaped.repeat(8000)];
  type Page = { body: string; truncated?: boolean; nextOffset?: number; totalCharacters?: number };
  for (const body of samples) {
    await kb.save(vaultId, { action: 'update', kind: 'record', id: record.id, body });
    await kb.save(vaultId, { action: 'update', kind: 'material', id: material.id, body });
    await kb.save(vaultId, { action: 'update', kind: 'subject', body });
    await fs.writeFile(path.join(batch, 'candidate-long.md'), serializeEntry({ title: '游标候选', processed: false }, body));
    const boundaries = new Set([0]);
    let position = 0;
    for (const codePoint of body) { position += codePoint.length; boundaries.add(position); }
    const offsets = new Set([0, ...Array.from({ length: Math.min(body.length, 10) }, (_, i) => i + 1), body.length - 1, body.length, body.length + 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]);
    for (const args of [['--id', record.id, '--kind', 'record'], ['--id', material.id, '--kind', 'material'], ['--id', 'candidate-long'], ['--subject']]) {
      for (const offset of offsets) {
        const read = () => run('get', ...args, '--offset', String(offset)) as Promise<Page>;
        if (!Number.isSafeInteger(offset) || !boundaries.has(offset)) {
          await assert.rejects(read, error => {
            assert.ok(error instanceof Error); assert.match(error.message, /offset/);
            if (Number.isInteger(offset) && offset > 0 && offset < body.length) {
              assert.match(error.message, /UTF-16.*代理对/);
              assert.ok(error.message.includes(`${offset - 1}（码点前）`));
              assert.ok(error.message.includes(`${offset + 1}（码点后）`));
              assert.match(error.message, /nextOffset/);
            }
            return true;
          }, `${args.join(' ')}, body=${body.length}, offset=${offset}`);
          continue;
        }
        const page = await read();
        assert.ok(JSON.stringify(page).length <= 50000, 'escaped JSON fits the output limit');
        assert.equal(page.body, body.slice(offset, offset + page.body.length), 'legal offsets are not adjusted');
        assert.ok(boundaries.has(offset + page.body.length), 'page ends at a complete code point');
      }
      const initial = await run('get', ...args) as Page;
      assert.equal(initial.body, body.slice(0, initial.body.length), 'omitted offset starts at zero');
      for (const start of [...new Set([0, 1, 3])].filter(offset => boundaries.has(offset))) {
        let offset = start, assembled = '', count = 0;
        do {
          assert.ok(++count < 30);
          const page = await run('get', ...args, '--offset', String(offset)) as Page;
          assert.ok(JSON.stringify(page).length <= 50000);
          assert.equal(page.body, body.slice(offset, offset + page.body.length));
          assert.ok(boundaries.has(offset + page.body.length));
          assembled += page.body;
          if (!page.truncated) break;
          assert.equal(page.totalCharacters, body.length);
          assert.equal(page.nextOffset, offset + page.body.length);
          assert.ok(typeof page.nextOffset === 'number' && page.nextOffset > offset); assert.ok(boundaries.has(page.nextOffset));
          offset = page.nextOffset;
        } while (true);
        assert.equal(assembled, body.slice(start));
      }
    }
  }
});

test('attachments and health decode every supported source image format before accepting it', async t => {
  const { kb, vaultId, root } = await sandbox(t);
  const record = await kb.save(vaultId, { action: 'create', kind: 'record', fields: { type: '其他', title: '图像格式矩阵' } });
  const log = path.join(root, 'log.jsonl');
  for (const extension of ['png', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'wmf', 'emf']) {
    const fixture = ['png', 'jpeg'].includes(extension) ? `evidence-2x1.${extension}` : `geometry.${extension}`;
    const bytes = await fs.readFile(path.join('tests/fixtures', fixture));
    await kb.save(vaultId, { action: 'attach_file', kind: 'record', id: record.id, file: { fileName: `valid.${extension}`, bytes } });
    const before = await fs.readFile(log, 'utf8');
    await assert.rejects(kb.save(vaultId, { action: 'attach_file', kind: 'record', id: record.id, file: { fileName: `corrupt.${extension}`, bytes: bytes.subarray(0, 10) } }), Error, extension);
    assert.equal(await fs.readFile(log, 'utf8'), before);
    const stored = path.join(root, 'files', record.id, `valid.${extension}`);
    const healthy = await kb.health(vaultId, '2026-11-20');
    assert.equal(healthy.issues.some(issue => issue.id === record.id && issue.code === 'image_invalid'), false, `${extension} positive control`);
    await fs.writeFile(stored, bytes.subarray(0, 10));
    assert.ok((await kb.health(vaultId, '2026-11-20')).issues.some(issue => issue.id === record.id && issue.code === 'image_invalid'), extension);
    await fs.writeFile(stored, bytes);
  }
});
