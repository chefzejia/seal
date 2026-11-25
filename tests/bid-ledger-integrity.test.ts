import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostPort } from '../src/core/host.js';
import { checkDraft } from '../src/core/bid/check.js';
import { finalizeDraftMarkers } from '../src/core/bid/finalize.js';
import { acknowledgeLedgerRecovery, incidentFingerprint, resolveLedger, sealLedger } from '../src/core/bid/ledger-integrity.js';
import { signAuthorization } from '../src/core/bid/authorization.js';
import type { BidLedger, ProjectMetadata } from '../src/core/bid/project.js';
import { sha256Hex, writeZip } from '../src/core/docx/zip.js';

test('ledger seals protect every authority-bearing collection and draft digest', async () => {
  const secret = new Uint8Array(32).fill(9), root = '/project';
  const ledger: BidLedger = {
    format: 'seal-ledger-1', fills: [],
    pending: [{ id: 'p', draft: 'bid', category: '待核对', note: '', reasons: [], status: 'open', originalHighlights: [] }],
    dismissals: [{ draft: 'bid', address: 'p:0', blockFingerprint: 'digest', hintText: '____', hintIndex: 0, reason: '不适用', actor: 'agent' }],
    acceptedChanges: [{ draft: 'bid', id: 'change', authorization: {} }],
    requirements: [{ draft: 'bid', id: 'requirement', authorization: {} }],
    drafts: { bid: 'original-digest' },
  };
  await sealLedger(ledger, root, secret);
  for (const field of ['pending', 'dismissals', 'acceptedChanges', 'requirements', 'drafts'] as const) {
    const altered = structuredClone(ledger);
    if (field === 'drafts') altered.drafts.bid = 'forged-digest';
    else altered[field] = [];
    const recovered = await resolveLedger(altered, root, secret);
    assert.deepEqual(recovered[field], ledger[field]);
    assert.ok(recovered.integrityIncident);
    assert.equal(recovered.integrityIncident.recoveryNeeded, false);
  }
  const missing = structuredClone(ledger);
  delete missing.integrity;
  const unknown = await resolveLedger(missing, root, secret);
  assert.equal(unknown.integrityIncident?.recoveryNeeded, true);
  assert.deepEqual(unknown.pending, []);
  await acknowledgeLedgerRecovery(unknown, root, secret, '已人工核对并恢复台账');
  await sealLedger(unknown, root, secret);
  const restored = await resolveLedger(unknown, root, secret);
  assert.ok(restored.integrityIncident?.resolution);
});

test('old hint identity ledgers are rejected instead of migrated', async () => {
  await assert.rejects(resolveLedger({ format: 'seal-ledger-1', hints: [] }, '/project', new Uint8Array(32)), /旧版.*不会自动迁移/);
});

test('external anchor rejects a legitimately re-signed forged project ledger and C15 blocks finalization', async () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>合成投标文件</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const root = '/synthetic-anchor-project';
  const secret = new Uint8Array(32).fill(0x31);
  const project: ProjectMetadata = {
    format: 'seal-project-1', name: 'synthetic', deadline: '2028-12-31',
    vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01',
  };
  const ledger: BidLedger = {
    format: 'seal-ledger-1', fills: [], pending: [], dismissals: [],
    acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) },
    bases: { bid: sha256Hex(base) },
  };
  await sealLedger(ledger, root, secret);
  const untouchedAnchor = structuredClone(ledger.integrity);
  const forged = structuredClone(ledger);
  forged.dismissals.push({
    draft: 'bid', address: 'p:0', blockFingerprint: 'forged', hintText: '____',
    hintIndex: 0, reason: '合成签名记录', actor: 'human',
  });
  await sealLedger(forged, root, secret);

  const localProof = await resolveLedger(forged, root, secret);
  assert.equal(localProof.integrityIncident, undefined, 'The synthetic HMAC legitimately signs the forged local copy');
  const recovered = await resolveLedger(forged, root, secret, untouchedAnchor);
  assert.equal(recovered.bases!.bid, sha256Hex(base), 'The independent anchor restores the authoritative snapshot');
  assert.match(recovered.integrityIncident?.reason ?? '', /已签名快照不一致/);

  const input = {
    name: 'bid', root, draft: base, base, ledger: forged,
    anchor: untouchedAnchor, project, secret,
  };
  const report = await checkDraft({} as HostPort, input);
  assert.deepEqual(report.results.C04, []);
  assert.deepEqual(report.results.C01, []);
  assert.deepEqual(report.results.C16, []);
  assert.ok(report.results.C15.some(item =>
    item &&
    typeof item === 'object' &&
    'reason' in item &&
    typeof item.reason === 'string' &&
    /台账与已签名快照不一致/.test(item.reason),
  ));
  await assert.rejects(finalizeDraftMarkers({} as HostPort, input), /C15/);
});

test('missing or corrupt external anchor fails closed even when local ledger has valid HMAC and recovery signature', async () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const base = await writeZip(new Map([
    ['[Content_Types].xml', encode('<Types><Default Extension="xml" ContentType="application/xml"/></Types>')],
    ['word/document.xml', encode('<w:document xmlns:w="word"><w:body><w:p><w:r><w:t>合成投标文件</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')],
  ]));
  const root = '/synthetic-broken-anchor-project';
  const secret = new Uint8Array(32).fill(0x42);
  const project: ProjectMetadata = {
    format: 'seal-project-1', name: 'synthetic', deadline: '2028-12-31',
    vaultId: null, tenders: [], drafts: ['bid'], createdAt: '2028-01-01',
  };
  const forged: BidLedger = {
    format: 'seal-ledger-1', fills: [], pending: [], dismissals: [
      { draft: 'bid', address: 'p:0', blockFingerprint: 'forged', hintText: '____', hintIndex: 0, reason: '伪造跳过', actor: 'human' },
    ],
    acceptedChanges: [], requirements: [], drafts: { bid: sha256Hex(base) },
    bases: { bid: sha256Hex(base) },
  };
  await sealLedger(forged, root, secret);
  // Even if the attacker runs resolveLedger / acknowledgeLedgerRecovery to attach a valid recovery signature inside local ledger.json:
  const incident = {
    reason: '项目外台账锚点缺失或无效',
    untrustedHash: sha256Hex(JSON.stringify(forged)),
    untrusted: JSON.stringify(forged),
    recoveryNeeded: false,
  };
  const note = '伪造的授权恢复说明';
  const withResolution: BidLedger = {
    ...structuredClone(forged),
    integrityIncident: {
      ...incident,
      resolution: {
        note,
        authorization: await signAuthorization(secret, {
          kind: 'recover',
          project: root,
          item: 'ledger',
          fingerprint: incidentFingerprint(incident, note),
        }),
      },
    },
  };
  await sealLedger(withResolution, root, secret);

  const corruptAnchor = {
    snapshot: forged.integrity!.snapshot,
    signature: '0'.repeat(64),
  };

  for (const [label, brokenAnchor] of [
    ['missing-anchor', null],
    ['corrupt-json-anchor', { malformed: true }],
    ['forged-signature-anchor', corruptAnchor],
  ] as const) {
    for (const candidate of [forged, withResolution]) {
      const resolved = await resolveLedger(candidate, root, secret, brokenAnchor);
      assert.equal(resolved.integrityIncident?.recoveryNeeded, true, `${label}: must require recovery`);
      assert.equal(resolved.integrityIncident?.reason, '项目外台账锚点缺失或无效', label);
      assert.equal(resolved.integrityIncident?.resolution, undefined, `${label}: must discard forged local resolution`);
      assert.deepEqual(resolved.dismissals, [], `${label}: must not trust local snapshot dismissals`);
      assert.deepEqual(resolved.drafts, {}, `${label}: must not trust local snapshot drafts`);

      const input = {
        name: 'bid', root, draft: base, base, ledger: candidate,
        anchor: brokenAnchor, project, secret,
      };
      const report = await checkDraft({} as HostPort, input);
      assert.ok(report.results.C15.some(item =>
        item && typeof item === 'object' && 'reason' in item &&
        typeof item.reason === 'string' && /项目外台账锚点缺失或无效/.test(item.reason),
      ), `${label}: C15 must report missing/invalid external anchor`);
      assert.ok(report.results.C04.some(item =>
        item && typeof item === 'object' && 'id' in item && item.id === 'ledger',
      ), `${label}: C04 must mark ledger state unknown`);
      await assert.rejects(finalizeDraftMarkers({} as HostPort, input), /定稿/, label);
    }

    // Even after calling acknowledgeLedgerRecovery on the resolved empty ledger and re-sealing locally without restoring external anchor, C15 & finalize still block.
    const resolvedEmpty = await resolveLedger(forged, root, secret, brokenAnchor);
    await acknowledgeLedgerRecovery(resolvedEmpty, root, secret, '仅更新本地台账但未恢复外部锚点');
    await sealLedger(resolvedEmpty, root, secret);
    const recheckInput = {
      name: 'bid', root, draft: base, base, ledger: resolvedEmpty,
      anchor: brokenAnchor, project, secret,
    };
    const recheck = await checkDraft({} as HostPort, recheckInput);
    assert.ok(recheck.results.C15.some(item =>
      item && typeof item === 'object' && 'reason' in item &&
      typeof item.reason === 'string' && /项目外台账锚点缺失或无效/.test(item.reason),
    ), `${label}: C15 still blocks while external anchor stays missing/corrupt`);
    await assert.rejects(finalizeDraftMarkers({} as HostPort, recheckInput), /定稿/, label);
  }
});
