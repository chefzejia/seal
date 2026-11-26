import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { writeZip, sha256Hex } from "../src/core/docx/zip.js";
import {
  addOutlineNode,
  assertLockedTemplateTransitions,
  canonicalOutlineDigest,
  checkOutlineConsistency,
  confirmOutline,
  deleteOutlineNode,
  evaluateOutlineConfirmation,
  indentOutlineNode,
  moveOutlineNode,
  outdentOutlineNode,
  parseOutline,
  patchOutline,
  updateOutlineNode,
  validateOutlineInput,
  visibleBodyNonTocParagraphs,
  type OutlineDocument,
  type OutlineMaterialState,
  type OutlineNode,
} from "../src/core/bid/outline.js";
import { verifyAuthorization } from "../src/core/bid/authorization.js";
import { acceptChange } from "../src/core/bid/human-review.js";
import { compareDocuments } from "../src/core/docx/package-compare.js";
import { checkDraft } from "../src/core/bid/check.js";
import { initializeProject, readProject, type BidLedger } from "../src/core/bid/project.js";
import { resolveLedger, sealLedger } from "../src/core/bid/ledger-integrity.js";
import { completeProjectCheck, emptyResults } from "../src/core/bid/report.js";
import { KnowledgeBase } from "../src/core/kb/index.js";
import { NodeHostPort } from "../src/shells/node-host.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import { cliHelpText } from "../src/shells/cli/index.js";
import {
  buildOutlineExecutionPrompt,
  buildOutlineRevisionPrompt,
  buildOutlineView,
  countOutlineChanges,
  filterOutlineRows,
} from "../src/workbench/outline.js";
import { buildBidStartupPrompt } from "../src/workbench/requirements.js";
import { reviewItems, reviewPage } from "../src/workbench/review.js";

const enc = new TextEncoder();

// Minimal valid 1x1 PNGs with distinct pixel payloads so their SHA256 hashes differ.
const PNG_1X1_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const PNG_1X1_BLUE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);

const p = (text: string, props = "") =>
  `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function buildDocx(body: string): Promise<Uint8Array> {
  return writeZip(
    new Map([
      [
        "[Content_Types].xml",
        enc.encode(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
        ),
      ],
      [
        "word/document.xml",
        enc.encode(
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
        ),
      ],
      [
        "word/_rels/document.xml.rels",
        enc.encode(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
        ),
      ],
    ]),
  );
}

async function createSandbox(t: TestContext, prefix: string) {
  await fs.mkdir(".tmp", { recursive: true });
  const sandbox = await fs.mkdtemp(path.resolve(".tmp", prefix));
  const previousSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, "seal-home");
  t.after(async () => {
    if (previousSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previousSealHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  });
  return sandbox;
}

function sampleOutline(): OutlineDocument {
  return {
    format: "seal-outline-1",
    volumes: [
      {
        name: "商务标",
        tender: "tender/1.docx",
        ranges: [{ from: "p:0", to: "p:3" }],
      },
      {
        name: "技术标",
        tender: "tender/1.docx",
        ranges: [{ from: "p:4", to: "p:5" }],
      },
    ],
    nodes: [
      {
        id: "n-cover",
        volume: "商务标",
        parentId: null,
        level: 1,
        number: "一、",
        title: "投标函",
        kind: "template",
        included: true,
        lockedTemplate: true,
        tenderSource: {
          file: "tender/1.docx",
          ranges: [{ from: "p:0", to: "p:1" }],
        },
      },
      {
        id: "n-opt-tpl",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "联合体协议书",
        kind: "template",
        included: true,
        optional: true,
        lockedTemplate: true,
      },
      {
        id: "n-qual",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "资格证明文件",
        kind: "attachment",
        included: true,
      },
      {
        id: "n-cert-kb",
        volume: "商务标",
        parentId: "n-qual",
        level: 2,
        title: "营业执照",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: "rec-license", label: "营业执照" }],
      },
      {
        id: "n-cert-mat",
        volume: "商务标",
        parentId: "n-qual",
        level: 2,
        title: "专项资质证明",
        kind: "attachment",
        included: true,
        materialMissing: true,
        materialNote: "请上传专项资质 PDF",
      },
      {
        id: "n-tech",
        volume: "技术标",
        parentId: null,
        level: 1,
        number: "第一章",
        title: "总体技术方案",
        kind: "authored",
        included: true,
        requirementIds: ["req-1"],
        note: "结合评分项展开架构与实施计划",
      },
      {
        id: "n-tech-sub",
        volume: "技术标",
        parentId: "n-tech",
        level: 2,
        title: "系统架构设计",
        kind: "authored",
        included: true,
        requirementIds: ["req-2"],
      },
    ],
  };
}

test("M42 outline schema: validates seal-outline-1 and rejects duplicates, cycles, bad paths and privilege fields", () => {
  const valid = validateOutlineInput(sampleOutline());
  assert.equal(valid.errors.length, 0);
  assert.ok(valid.outline);
  assert.equal(parseOutline(JSON.stringify(sampleOutline())).kind, "value");

  // Duplicate volume name
  const dupVol = sampleOutline();
  dupVol.volumes.push({ name: "商务标" });
  assert.equal(validateOutlineInput(dupVol).outline, null);

  // Duplicate node ID
  const dupNode = sampleOutline();
  dupNode.nodes.push({ ...dupNode.nodes[0] });
  assert.equal(validateOutlineInput(dupNode).outline, null);

  // Cycle in parentId
  const cyclic = sampleOutline();
  cyclic.nodes[0].parentId = "n-opt-tpl";
  cyclic.nodes[1].parentId = "n-cover";
  const cyclicRes = validateOutlineInput(cyclic);
  assert.equal(cyclicRes.outline, null);
  assert.ok(cyclicRes.errors.some((err) => err.reason.includes("循环")));

  // Cross-volume parent
  const crossVol = sampleOutline();
  crossVol.nodes[5].parentId = "n-cover";
  assert.equal(validateOutlineInput(crossVol).outline, null);

  // Invalid level
  for (const badLevel of [0, 7, 1.5]) {
    const bad = sampleOutline();
    bad.nodes[0].level = badLevel;
    assert.equal(validateOutlineInput(bad).outline, null);
  }

  // Bad material path / renderedPages traversal
  for (const badPath of [
    "../secret.png",
    "/abs/file.png",
    "materials\\win.png",
    "materials/../escape.png",
    "tender/1.png",
  ]) {
    const badMat = sampleOutline();
    badMat.nodes[3].evidence = [{ source: "material", ref: badPath }];
    assert.equal(validateOutlineInput(badMat).outline, null, badPath);

    const badPage = sampleOutline();
    badPage.nodes[3].evidence = [
      {
        source: "material",
        ref: "materials/outline/ok.pdf",
        renderedPages: [badPath],
      },
    ];
    assert.equal(validateOutlineInput(badPage).outline, null, badPath);
  }

  // KB with renderedPages or invalid ID rejected
  const badKb = sampleOutline();
  badKb.nodes[3].evidence = [{ source: "kb", ref: "../escape" }];
  assert.equal(validateOutlineInput(badKb).outline, null);

  const kbWithPages = sampleOutline();
  kbWithPages.nodes[3].evidence = [
    {
      source: "kb",
      ref: "rec-1",
      renderedPages: ["materials/outline/p1.png"],
    },
  ];
  assert.equal(validateOutlineInput(kbWithPages).outline, null);

  // Reject all forbidden privilege / confirmation fields on root, volume, node and evidence
  for (const forbidden of [
    "confirmed",
    "confirmedAt",
    "authorization",
    "approved",
    "lockedBy",
    "verified",
    "verifiedAt",
    "verifiedFields",
    "__sealAdmin",
  ]) {
    const rootBad = { ...sampleOutline(), [forbidden]: true };
    assert.equal(validateOutlineInput(rootBad).outline, null, `root:${forbidden}`);

    const nodeBad = sampleOutline();
    (nodeBad.nodes[0] as unknown as Record<string, unknown>)[forbidden] = true;
    assert.equal(validateOutlineInput(nodeBad).outline, null, `node:${forbidden}`);
  }
});

test("M42 outline tree primitives: immutable add, update, lockedTemplate guard, delete subtree, move, indent/outdent and patch", () => {
  const base = sampleOutline();
  const snapshotBefore = JSON.stringify(base);

  // Add sibling after n-qual (should land after n-qual's entire subtree)
  const added = addOutlineNode(
    base,
    {
      id: "n-added",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "补充声明",
      kind: "authored",
      included: true,
    },
    { afterNodeId: "n-qual" },
  );
  assert.equal(JSON.stringify(base), snapshotBefore, "input outline is never mutated");
  assert.equal(added.nodes.at(-3)?.id, "n-added");

  // Locked non-optional template: rejects title change & included=false, allows note/number/expectedHeading
  assert.throws(
    () => updateOutlineNode(base, "n-cover", { title: "篡改标题" }),
    /锁定/,
  );
  assert.throws(
    () => updateOutlineNode(base, "n-cover", { included: false }),
    /固定格式/,
  );
  const updatedLocked = updateOutlineNode(base, "n-cover", {
    note: "请填报价日期",
    expectedHeading: "投标函及附录",
  });
  assert.equal(updatedLocked.nodes[0].note, "请填报价日期");

  // Optional lockedTemplate: allows toggling included=false
  const toggledOpt = updateOutlineNode(base, "n-opt-tpl", { included: false });
  assert.equal(toggledOpt.nodes[1].included, false);

  // Delete subtree: n-qual deletes n-qual + n-cert-kb + n-cert-mat
  const deleted = deleteOutlineNode(base, "n-qual");
  assert.ok(!deleted.nodes.some((n) => n.id.startsWith("n-cert") || n.id === "n-qual"));
  // Reject deleting non-optional lockedTemplate
  assert.throws(() => deleteOutlineNode(base, "n-cover"), /锁定/);
  // Reject deleting parent whose subtree contains a lockedTemplate node
  const withLockedChild = addOutlineNode(base, {
    id: "n-locked-child",
    volume: "商务标",
    parentId: "n-qual",
    level: 2,
    title: "固定附表",
    kind: "template",
    included: true,
    lockedTemplate: true,
  });
  assert.throws(() => deleteOutlineNode(withLockedChild, "n-qual"), /锁定/);

  // Move subtree up/down among same-parent siblings
  const movedUp = moveOutlineNode(base, "n-qual", "up");
  const topIds = movedUp.nodes
    .filter((n) => n.volume === "商务标" && n.parentId === null)
    .map((n) => n.id);
  assert.deepEqual(topIds, ["n-cover", "n-qual", "n-opt-tpl"]);
  // Children of n-qual moved along with it
  const qualIdx = movedUp.nodes.findIndex((n) => n.id === "n-qual");
  assert.equal(movedUp.nodes[qualIdx + 1].id, "n-cert-kb");
  assert.equal(movedUp.nodes[qualIdx + 2].id, "n-cert-mat");

  // Indent and outdent adjust parentId and subtree levels (clamped at 6)
  const indented = indentOutlineNode(base, "n-qual");
  const indQual = indented.nodes.find((n) => n.id === "n-qual")!;
  const indChild = indented.nodes.find((n) => n.id === "n-cert-kb")!;
  assert.equal(indQual.parentId, "n-opt-tpl");
  assert.equal(indQual.level, 2);
  assert.equal(indChild.level, 3);

  // Clamp at level 6
  let deep: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "d1", volume: "商务标", parentId: null, level: 5, title: "A", kind: "authored", included: true },
      { id: "d2", volume: "商务标", parentId: null, level: 6, title: "B", kind: "authored", included: true },
    ],
  };
  deep = indentOutlineNode(deep, "d2");
  assert.equal(deep.nodes[1].parentId, "d1");
  assert.equal(deep.nodes[1].level, 6);

  const outdented = outdentOutlineNode(indented, "n-qual");
  assert.equal(outdented.nodes.find((n) => n.id === "n-qual")!.parentId, null);
  assert.equal(outdented.nodes.find((n) => n.id === "n-qual")!.level, 1);
  assert.equal(outdented.nodes.find((n) => n.id === "n-cert-kb")!.level, 2);

  // Patch outline (upsertNodes + removeNodeIds + updateVolumes)
  const patched = patchOutline(base, {
    updateVolumes: [{ name: "商务标", note: "已更新" }],
    removeNodeIds: ["n-tech-sub"],
    upsertNodes: [
      {
        id: "n-tech-new",
        volume: "技术标",
        parentId: "n-tech",
        level: 2,
        title: "运维方案",
        kind: "authored",
        included: true,
      },
    ],
  });
  assert.equal(patched.volumes[0].note, "已更新");
  assert.ok(!patched.nodes.some((n) => n.id === "n-tech-sub"));
  assert.ok(patched.nodes.some((n) => n.id === "n-tech-new"));
  assert.throws(
    () => patchOutline(base, { removeNodeIds: ["n-cover"] }),
    /锁定/,
  );
});

test("M42 outline confirmation: HMAC signing, stale on outline/vault/deadline changes, and C15 on forged ledger", async (t) => {
  const sandbox = await createSandbox(t, "m42-confirm-");
  const host = new NodeHostPort();
  const tenderPath = path.join(sandbox, "tender-src.docx");
  await fs.writeFile(tenderPath, await buildDocx(p("投标函") + p("技术方案")));

  const projectRoot = path.join(sandbox, "proj-1");
  const project = await initializeProject(host, projectRoot, {
    name: "大纲确认测试",
    deadline: "2028-06-01",
    vaultId: "vault-1",
    workflowMode: "outline_first",
    tenders: [tenderPath],
    createdAt: "2028-01-01T00:00:00.000Z",
  });
  const secret = (await host.authorizationKey(false))!;
  assert.ok(secret);

  const outline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:0" }] }],
    nodes: [
      { id: "n1", volume: "商务标", parentId: null, level: 1, title: "投标函", kind: "template", included: true },
    ],
  };

  // canonicalOutlineDigest ignores updatedAt / updatedBy
  const withTimestamp: OutlineNode = outline.nodes[0];
  assert.equal(
    canonicalOutlineDigest({ ...outline, updatedAt: "2028-01-01", updatedBy: "agent" }),
    canonicalOutlineDigest({ ...outline, updatedAt: "2028-02-01", updatedBy: "human" }),
  );
  assert.ok(withTimestamp.id === "n1");

  const ledger: BidLedger = JSON.parse(
    await fs.readFile(path.join(projectRoot, "ledger.json"), "utf8"),
  );
  const confirmation = await confirmOutline(
    ledger,
    outline,
    { root: projectRoot, vaultId: project.vaultId, deadline: project.deadline },
    secret,
    "2028-01-02T00:00:00.000Z",
  );
  assert.equal(await verifyAuthorization(secret, confirmation.authorization), true);

  const confirmedEval = await evaluateOutlineConfirmation({
    outlineState: { kind: "value", outline },
    confirmation: ledger.outlineConfirmation,
    root: projectRoot,
    secret,
    context: { vaultId: project.vaultId, deadline: project.deadline },
  });
  assert.equal(confirmedEval.status, "confirmed");
  assert.equal(confirmedEval.valid, true);

  // Editing outline -> stale
  const editedOutline = updateOutlineNode(outline, "n1", { note: "新增批注" });
  const staleByEdit = await evaluateOutlineConfirmation({
    outlineState: { kind: "value", outline: editedOutline },
    confirmation: ledger.outlineConfirmation,
    root: projectRoot,
    secret,
    context: { vaultId: project.vaultId, deadline: project.deadline },
  });
  assert.equal(staleByEdit.status, "stale");
  assert.equal(staleByEdit.valid, false);

  // Changing vaultId or deadline -> stale
  const staleByVault = await evaluateOutlineConfirmation({
    outlineState: { kind: "value", outline },
    confirmation: ledger.outlineConfirmation,
    root: projectRoot,
    secret,
    context: { vaultId: "vault-2", deadline: project.deadline },
  });
  assert.equal(staleByVault.status, "stale");

  const staleByDeadline = await evaluateOutlineConfirmation({
    outlineState: { kind: "value", outline },
    confirmation: ledger.outlineConfirmation,
    root: projectRoot,
    secret,
    context: { vaultId: project.vaultId, deadline: "2028-07-01" },
  });
  assert.equal(staleByDeadline.status, "stale");

  // Forged signature in ledger -> invalid_signature + C15
  const forged = structuredClone(ledger);
  forged.outlineConfirmation!.authorization.signature = "0".repeat(64);
  const invalidEval = await evaluateOutlineConfirmation({
    outlineState: { kind: "value", outline },
    confirmation: forged.outlineConfirmation,
    root: projectRoot,
    secret,
    context: { vaultId: project.vaultId, deadline: project.deadline },
  });
  assert.equal(invalidEval.status, "invalid_signature");
  assert.ok(invalidEval.invalidAuthorization);

  // Establish a clean baseline with C15 === 0 (registered draft & base + external anchor)
  const draftBytes = await buildDocx(p("投标函"));
  const baseBytes = await buildDocx(p("投标函"));
  ledger.drafts["商务标"] = sha256Hex(draftBytes);
  ledger.bases = { ...(ledger.bases ?? {}), 商务标: sha256Hex(baseBytes) };
  await sealLedger(ledger, projectRoot, secret);
  await fs.writeFile(path.join(projectRoot, "ledger.json"), JSON.stringify(ledger, null, 2));
  await fs.writeFile(
    await host.ledgerAnchorPath(projectRoot, false),
    JSON.stringify(ledger.integrity),
  );
  await fs.writeFile(path.join(projectRoot, "outline.json"), JSON.stringify(outline, null, 2));

  const anchorValue = JSON.parse(
    await fs.readFile(await host.ledgerAnchorPath(projectRoot, false), "utf8"),
  );
  const cleanReport = await checkDraft(host, {
    name: "商务标",
    root: projectRoot,
    draft: draftBytes,
    base: baseBytes,
    ledger,
    project: { ...project, drafts: ["商务标"] },
    secret,
    anchor: anchorValue,
    outline: { C17: [] },
  });
  assert.equal(cleanReport.results.C15.length, 0, "Clean baseline must have C15 === 0");

  // Attacker holding the SAME authorization.key re-signs project ledger.json without touching external anchor -> blocked by C15!
  const attackerLedger: BidLedger = JSON.parse(
    await fs.readFile(path.join(projectRoot, "ledger.json"), "utf8"),
  );
  await confirmOutline(
    attackerLedger,
    editedOutline,
    { root: projectRoot, vaultId: project.vaultId, deadline: project.deadline },
    secret,
    "2028-01-03T00:00:00.000Z",
  );
  await sealLedger(attackerLedger, projectRoot, secret);
  await fs.writeFile(
    path.join(projectRoot, "ledger.json"),
    JSON.stringify(attackerLedger, null, 2),
  );

  const report = await checkDraft(host, {
    name: "商务标",
    root: projectRoot,
    draft: draftBytes,
    base: baseBytes,
    ledger: attackerLedger,
    project: { ...project, drafts: ["商务标"] },
    secret,
    anchor: anchorValue,
    outline: { C17: [] },
  });
  assert.ok(report.results.C15.length > 0, "External anchor mismatch triggers C15");
  assert.match(JSON.stringify(report.results.C15), /台账与已签名快照不一致/);

  const recovered = await resolveLedger(attackerLedger, projectRoot, secret, anchorValue);
  assert.equal(recovered.integrityIncident?.reason, "台账与已签名快照不一致");
  assert.equal(
    recovered.outlineConfirmation?.digest,
    canonicalOutlineDigest(outline),
    "Authoritative outlineConfirmation state is restored from external anchor",
  );
});

test("M42 C17 deterministic checks: missing/corrupt/unconfirmed/missing_volume/missing_section/KB media/material & PDF renderedPages + delete re-triggers C17", async (t) => {
  const sandbox = await createSandbox(t, "m42-c17-");
  const host = new NodeHostPort();
  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(
    tenderPath,
    await buildDocx(
      p("投标函") +
        p("投标人名称：____") +
        p("第一章 资格证明文件") +
        p("第二章 总体技术方案"),
    ),
  );

  // Build KB with one verified record carrying a PNG file
  const kbRoot = path.join(process.env.SEAL_HOME!, "vaults");
  await fs.mkdir(kbRoot, { recursive: true });
  const kb = new KnowledgeBase(host, kbRoot);
  const vault = await kb.createVault({ name: "测试库", vaultId: "v-c17" });
  const kbPng = path.join(sandbox, "kb-license.png");
  await fs.writeFile(kbPng, PNG_1X1_RED);
  const savedSubj = await kb.save(vault.vaultId, {
    action: "update",
    kind: "subject",
    fields: { legalName: "星辰测试科技有限公司" },
    body: "",
  });
  const savedRec = await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: {
      type: "营业执照",
      title: "营业执照副本",
      number: "LIC-2028-001",
      holder: "星辰测试科技有限公司",
      validUntil: "2030-12-31",
    },
    body: "营业执照",
  });
  const attached = await kb.save(vault.vaultId, {
    action: "attach_file",
    kind: "record",
    id: savedRec.id,
    file: { fileName: "license.png", bytes: PNG_1X1_RED },
  });
  const kbFileRel = (attached.fields.files as string[])[0];
  await kb.verify(vault.vaultId, "subject", "subject", ["legalName"]);
  await kb.verify(vault.vaultId, "record", savedRec.id);
  assert.ok(savedSubj);

  // 1. Direct mode WITHOUT outline.json -> backward compatible (C17 = 0, ready = true)
  const directRoot = path.join(sandbox, "proj-direct");
  await runProject(host, [
    "init",
    "--root",
    directRoot,
    "--name",
    "旧模式项目",
    "--deadline",
    "2028-06-01",
    "--vault",
    vault.vaultId,
    "--workflow-mode",
    "direct",
    "--tender",
    tenderPath,
  ]);
  await runProject(host, [
    "extract",
    "--project",
    directRoot,
    "--tender",
    "tender/1.docx",
    "--draft",
    "商务标",
    "--ranges",
    JSON.stringify([{ from: "p:0", to: "p:0" }]),
  ]);
  const directCheck = (await runProject(host, ["check", "--project", directRoot])) as {
    ready: boolean;
    blockingCounts: Record<string, number>;
  };
  assert.equal(directCheck.blockingCounts.C17, 0);
  assert.equal(directCheck.ready, true);

  // 2. outline_first project
  const projRoot = path.join(sandbox, "proj-outline");
  await runProject(host, [
    "init",
    "--root",
    projRoot,
    "--name",
    "两阶段大纲项目",
    "--deadline",
    "2028-06-01",
    "--vault",
    vault.vaultId,
    "--workflow-mode",
    "outline_first",
    "--tender",
    tenderPath,
  ]);
  const loadedMeta = await readProject(host, projRoot);
  assert.equal(loadedMeta.workflowMode, "outline_first");

  // Prepare uploaded material images (simulating 2-page PDF rendered PNGs under materials/outline/)
  const matDir = path.join(projRoot, "materials", "outline");
  await fs.mkdir(matDir, { recursive: true });
  await fs.writeFile(path.join(matDir, "cert.pdf"), enc.encode("%PDF-1.4\n"));
  await fs.writeFile(path.join(matDir, "page-1.png"), PNG_1X1_RED);
  await fs.writeFile(path.join(matDir, "page-2.png"), PNG_1X1_BLUE);

  // Corrupt outline.json -> C17 blocks with corrupt_outline
  await fs.writeFile(path.join(projRoot, "outline.json"), "{bad json");
  const corruptCheck = (await runProject(host, ["check", "--project", projRoot])) as {
    blockingCounts: Record<string, number>;
    outline?: Array<{ kind: string }>;
  };
  assert.equal(corruptCheck.blockingCounts.C17, 1);
  assert.equal(corruptCheck.outline?.[0]?.kind, "corrupt_outline");

  // Save valid outline via CLI
  const volumes = [
    { name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:2" }] },
    { name: "技术标", tender: "tender/1.docx", ranges: [{ from: "p:3", to: "p:3" }] },
  ];
  const nodes: OutlineNode[] = [
    {
      id: "n-cover",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "投标函",
      kind: "template",
      included: true,
      lockedTemplate: true,
    },
    {
      id: "n-kb-att",
      volume: "商务标",
      parentId: null,
      level: 1,
      number: "（一）",
      title: "营业执照扫描件",
      kind: "attachment",
      included: true,
      evidence: [{ source: "kb", ref: savedRec.id, label: "营业执照" }],
    },
    {
      id: "n-mat-pdf",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "补充证明PDF",
      kind: "attachment",
      included: true,
      evidence: [
        {
          source: "material",
          ref: "materials/outline/cert.pdf",
          renderedPages: [
            "materials/outline/page-1.png",
            "materials/outline/page-2.png",
          ],
        },
      ],
    },
    {
      id: "n-missing-only",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "待补材料占位节",
      kind: "attachment",
      included: true,
      materialMissing: true,
      materialNote: "人暂未上传",
    },
    {
      id: "n-excluded",
      volume: "技术标",
      parentId: null,
      level: 1,
      title: "跳过的不检查章节",
      kind: "authored",
      included: false,
    },
    {
      id: "n-tech",
      volume: "技术标",
      parentId: null,
      level: 1,
      number: "二、",
      title: "总体技术方案",
      kind: "authored",
      included: true,
    },
  ];
  await runProject(host, [
    "outline",
    "--project",
    projRoot,
    "--action",
    "save",
    "--volumes",
    JSON.stringify(volumes),
    "--nodes",
    JSON.stringify(nodes),
  ]);

  // Extract only 商务标 -> 技术标 missing_volume + unconfirmed + missing sections/evidence
  await runProject(host, [
    "extract",
    "--project",
    projRoot,
    "--tender",
    "tender/1.docx",
    "--draft",
    "商务标",
    "--ranges",
    JSON.stringify([{ from: "p:0", to: "p:2" }]),
  ]);

  const unconfirmedReport = (await runProject(host, ["check", "--project", projRoot])) as {
    ready: boolean;
    blockingCounts: Record<string, number>;
    volumes: Array<{ draft: string; results: { C17: Array<{ kind: string; nodeId?: string }> } }>;
  };
  assert.equal(unconfirmedReport.ready, false);
  const allC17Kinds = unconfirmedReport.volumes.flatMap((v) =>
    v.results.C17.map((issue) => issue.kind),
  );
  assert.ok(allC17Kinds.includes("outline_unconfirmed"));
  assert.ok(allC17Kinds.includes("missing_volume"));
  assert.ok(allC17Kinds.includes("missing_section"));
  assert.ok(allC17Kinds.includes("missing_evidence"));
  // materialMissing-only node should NOT emit missing_evidence
  assert.ok(
    !unconfirmedReport.volumes.some((v) =>
      v.results.C17.some(
        (issue) => issue.nodeId === "n-missing-only" && issue.kind === "missing_evidence",
      ),
    ),
  );

  // Confirm outline as human (using core function directly, like workbench host does)
  const secret = (await host.authorizationKey(false))!;
  const ledgerRaw: BidLedger = JSON.parse(
    await fs.readFile(path.join(projRoot, "ledger.json"), "utf8"),
  );
  const parsedOutline = parseOutline(
    await fs.readFile(path.join(projRoot, "outline.json"), "utf8"),
  );
  assert.equal(parsedOutline.kind, "value");
  await confirmOutline(
    ledgerRaw,
    parsedOutline.outline,
    { root: projRoot, vaultId: vault.vaultId, deadline: "2028-06-01" },
    secret,
    "2028-01-05T00:00:00.000Z",
  );
  await sealLedger(ledgerRaw, projRoot, secret);
  await fs.writeFile(path.join(projRoot, "ledger.json"), JSON.stringify(ledgerRaw, null, 2));
  await fs.writeFile(
    await host.ledgerAnchorPath(projRoot, false),
    JSON.stringify(ledgerRaw.integrity),
  );

  // Extract 技术标 (includes "第二章 总体技术方案", which matches "二、总体技术方案" via prefix stripping!)
  await runProject(host, [
    "extract",
    "--project",
    projRoot,
    "--tender",
    "tender/1.docx",
    "--draft",
    "技术标",
    "--ranges",
    JSON.stringify([{ from: "p:3", to: "p:3" }]),
  ]);

  // Write ONLY text KB citation (no media!) to verify attachment node with hasFiles=true STILL blocks!
  await runProject(host, [
    "edit",
    "--project",
    projRoot,
    "--draft",
    "商务标",
    "--ops",
    JSON.stringify([
      {
        op: "replace",
        at: "p:1",
        blank: 0,
        value: `{{subject.legalName}}（执照号：{{record:${savedRec.id}.number}}）`,
      },
      {
        op: "insert",
        at: "p:2",
        position: "after",
        markdown:
          "### 1. 营业执照扫描件\n\n### 2. 补充证明PDF\n\n### 3. 待补材料占位节\n\n![page1](materials/outline/page-1.png)",
      },
    ]),
  ]);

  const partialMediaCheck = (await runProject(host, ["check", "--project", projRoot])) as {
    ready: boolean;
    volumes: Array<{ draft: string; results: { C17: Array<{ kind: string; nodeId?: string; source?: string }> } }>;
  };
  assert.equal(partialMediaCheck.ready, false);
  const c17AfterPartial = partialMediaCheck.volumes.flatMap((v) => v.results.C17);
  // 1) KB attachment still missing media=true fill
  assert.ok(
    c17AfterPartial.some(
      (issue) => issue.nodeId === "n-kb-att" && issue.kind === "missing_evidence" && issue.source === "kb",
    ),
  );
  // 2) Material PDF missing page-2.png
  assert.ok(
    c17AfterPartial.some(
      (issue) => issue.nodeId === "n-mat-pdf" && issue.kind === "missing_evidence" && issue.source === "material",
    ),
  );
  // 3) 技术标 section "二、总体技术方案" matched "第二章 总体技术方案", and excluded node did NOT trigger missing_section!
  assert.ok(
    !c17AfterPartial.some((issue) => issue.kind === "missing_section"),
    `Unexpected missing_section: ${JSON.stringify(c17AfterPartial)}`,
  );

  // Mount KB image + page-2.png (read blocks first to locate exact anchor)
  const beforeMount = (await runProject(host, [
    "read",
    "--project",
    projRoot,
    "--file",
    "商务标",
    "--mode",
    "blocks",
  ])) as { items: Array<{ address: string | null }> };
  const lastAddr = beforeMount.items.filter((i) => i.address).at(-1)!.address!;

  await runProject(host, [
    "edit",
    "--project",
    projRoot,
    "--draft",
    "商务标",
    "--ops",
    JSON.stringify([
      {
        op: "insert",
        at: "p:3",
        position: "after",
        markdown: `![kb](kb:${savedRec.id}/${kbFileRel})`,
      },
      {
        op: "insert_image",
        at: lastAddr,
        image: "materials/outline/page-2.png",
      },
    ]),
  ]);

  // Accept the expected C06 source modification on p:1 as human so full gate becomes ready=true
  const draftBytes = await fs.readFile(path.join(projRoot, "draft", "商务标.docx"));
  const baseBytes = await fs.readFile(path.join(projRoot, "draft", "商务标.base.docx"));
  const diffs = await compareDocuments(baseBytes, draftBytes);
  const ledgerNow: BidLedger = JSON.parse(
    await fs.readFile(path.join(projRoot, "ledger.json"), "utf8"),
  );
  for (const diff of diffs) {
    if (["modified", "deleted", "formatChanged", "objectLost"].includes(diff.kind)) {
      await acceptChange(
        ledgerNow,
        "商务标",
        diff,
        { root: projRoot, vaultId: vault.vaultId, deadline: "2028-06-01" },
        secret,
      );
    }
  }
  await sealLedger(ledgerNow, projRoot, secret);
  await fs.writeFile(path.join(projRoot, "ledger.json"), JSON.stringify(ledgerNow, null, 2));
  await fs.writeFile(
    await host.ledgerAnchorPath(projRoot, false),
    JSON.stringify(ledgerNow.integrity),
  );

  const fullCheck = (await runProject(host, ["check", "--project", projRoot])) as {
    ready: boolean;
    blockingCounts: Record<string, number>;
  };
  assert.equal(fullCheck.blockingCounts.C17, 0);
  assert.equal(fullCheck.ready, true, `blockingCounts=${JSON.stringify(fullCheck.blockingCounts)}`);

  // Now delete the paragraph containing page-2.png -> C17 MUST immediately reappear!
  const afterMount = (await runProject(host, [
    "read",
    "--project",
    projRoot,
    "--file",
    "商务标",
    "--mode",
    "blocks",
  ])) as { items: Array<{ address: string | null; text: string }> };
  const page2Addr = afterMount.items.filter((i) => i.address && i.text.includes("[图片]")).at(-1)!.address!;
  await runProject(host, [
    "edit",
    "--project",
    projRoot,
    "--draft",
    "商务标",
    "--ops",
    JSON.stringify([{ op: "delete", at: page2Addr }]),
  ]);
  const afterDeleteCheck = (await runProject(host, ["check", "--project", projRoot])) as {
    ready: boolean;
    blockingCounts: Record<string, number>;
    volumes: Array<{ results: { C17: Array<{ kind: string; nodeId?: string }> } }>;
  };
  assert.equal(afterDeleteCheck.ready, false);
  assert.ok(afterDeleteCheck.blockingCounts.C17 > 0);
  assert.ok(
    afterDeleteCheck.volumes[0].results.C17.some(
      (issue) => issue.nodeId === "n-mat-pdf" && issue.kind === "missing_evidence",
    ),
  );

  // Missing material file -> missing_material_file
  await fs.rm(path.join(matDir, "page-2.png"));
  const missingFileCheck = (await runProject(host, ["check", "--project", projRoot])) as {
    volumes: Array<{ results: { C17: Array<{ kind: string; nodeId?: string }> } }>;
  };
  assert.ok(
    missingFileCheck.volumes[0].results.C17.some(
      (issue) => issue.nodeId === "n-mat-pdf" && issue.kind === "missing_material_file",
    ),
  );
});

test("M42 authorization isolation: CLI outline and seal_outline tool cannot confirm or set privilege fields", async (t) => {
  const sandbox = await createSandbox(t, "m42-auth-");
  const host = new NodeHostPort();
  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, await buildDocx(p("投标函")));
  const projRoot = path.join(sandbox, "proj");
  await initializeProject(host, projRoot, {
    name: "权限隔离测试",
    deadline: "2028-06-01",
    workflowMode: "outline_first",
    tenders: [tenderPath],
    createdAt: "2028-01-01T00:00:00.000Z",
  });

  // CLI rejects --action confirm and privilege flags
  await assert.rejects(
    runProject(host, ["outline", "--project", projRoot, "--action", "confirm"]),
    /工作台人工操作/,
  );
  await assert.rejects(
    runProject(host, [
      "outline",
      "--project",
      projRoot,
      "--action",
      "save",
      "--confirm",
      "--volumes",
      "[]",
      "--nodes",
      "[]",
    ]),
    /禁止/,
  );
  await assert.rejects(
    runProject(host, [
      "outline",
      "--project",
      projRoot,
      "--action",
      "save",
      "--volumes",
      JSON.stringify([{ name: "商务标" }]),
      "--nodes",
      JSON.stringify([
        {
          id: "n1",
          volume: "商务标",
          parentId: null,
          level: 1,
          title: "投标函",
          kind: "template",
          included: true,
          confirmed: true,
        },
      ]),
    ]),
    /confirmed/,
  );

  // CLI outline save/get/patch and help text
  assert.match(cliHelpText(), /outline/);
  assert.match(cliHelpText(), /--workflow-mode/);

  const emptyGet = (await runProject(host, ["outline", "--project", projRoot, "--action", "get"])) as {
    kind: string;
  };
  assert.equal(emptyGet.kind, "missing");

  const saved = (await runProject(host, [
    "outline",
    "--project",
    projRoot,
    "--action",
    "save",
    "--volumes",
    JSON.stringify([{ name: "商务标" }]),
    "--nodes",
    JSON.stringify([
      {
        id: "n1",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "投标函",
        kind: "template",
        included: true,
      },
    ]),
  ])) as { saved: boolean };
  assert.equal(saved.saved, true);

  const patched = (await runProject(host, [
    "outline",
    "--project",
    projRoot,
    "--action",
    "patch",
    "--upsert-nodes",
    JSON.stringify([
      {
        id: "n2",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "技术方案",
        kind: "authored",
        included: true,
      },
    ]),
  ])) as { patched: boolean; summary: { totalNodes: number } };
  assert.equal(patched.patched, true);
  assert.equal(patched.summary.totalNodes, 2);

  await assert.rejects(
    runProject(host, [
      "outline",
      "--project",
      projRoot,
      "--action",
      "patch",
      "--upsert-nodes",
      JSON.stringify([
        {
          id: "n3",
          volume: "商务标",
          parentId: null,
          level: 1,
          title: "越权节点",
          kind: "authored",
          included: true,
          authorization: { sig: "fake" },
        },
      ]),
    ]),
    /authorization/,
  );

  // Verify project-tools.ts registers seal_outline with get/save/patch only (no confirm)
  const toolsSource = await fs.readFile(path.resolve("src/shells/dsh/project-tools.ts"), "utf8");
  assert.match(toolsSource, /name:\s*"seal_outline"/);
  assert.match(toolsSource, /enum:\s*\["get",\s*"save",\s*"patch"\]/);
  assert.match(toolsSource, /C01–C17/);
});

test("M42 workbench view models: buildOutlineView, filterOutlineRows ancestor preservation, countOutlineChanges, prompts and C17 reviewItems", () => {
  const baseline = sampleOutline();
  const modified = updateOutlineNode(baseline, "n-tech-sub", { note: "新增架构图要求" });
  assert.equal(countOutlineChanges(baseline, baseline), 0);
  assert.equal(
    countOutlineChanges(baseline, { ...baseline, updatedAt: "2028-01-02", updatedBy: "human" }),
    0,
  );
  assert.equal(countOutlineChanges(baseline, modified), 1);

  const view = buildOutlineView({
    outlineState: { kind: "value", outline: modified },
    confirmationStatus: "unconfirmed",
    baselineOutline: baseline,
    requirements: {
      kind: "value",
      items: [
        {
          id: "req-1",
          kind: "评分项",
          text: "总体技术方案",
          quote: "总体技术方案",
          source: { file: "tender/1.docx", address: "p:4" },
          mustRespond: true,
          responses: [],
        },
        {
          id: "req-3",
          kind: "资格要求",
          text: "未关联大纲的必答要求",
          quote: "未关联要求",
          source: { file: "tender/1.docx", address: "p:1" },
          mustRespond: true,
          responses: [],
        },
      ],
    },
    kbRecords: [
      { id: "rec-license", title: "营业执照", type: "营业执照", verified: false, validity: "valid", subject: "self", hasFiles: true },
    ],
    materials: [],
    c17Issues: [
      { kind: "missing_evidence", draft: "商务标", nodeId: "n-cert-kb", title: "营业执照", reason: "漏挂证照" },
      { kind: "missing_section", draft: "商务标", nodeId: "n-cert-kb", title: "营业执照", reason: "漏章" },
    ],
  });

  assert.equal(view.kind, "value");
  assert.equal(view.summary.totalNodes, 7);
  assert.equal(view.summary.missingMaterials, 1);
  assert.equal(view.summary.needsReviewMaterials, 1);
  assert.equal(view.summary.uncoveredRequirements, 1);
  assert.equal(view.uncoveredRequirementList[0].id, "req-3");
  assert.equal(view.summary.changesCount, 1);

  // Ancestor preservation when filtering for missing_material child (n-cert-mat -> parent n-qual preserved!)
  const missingFiltered = filterOutlineRows(view.rows, { filter: "missing_material" });
  assert.deepEqual(
    missingFiltered.map((r) => r.id),
    ["n-qual", "n-cert-mat"],
  );

  // Ancestor preservation on query match (n-tech-sub -> parent n-tech preserved!)
  const queryFiltered = filterOutlineRows(view.rows, { query: "架构设计" });
  assert.deepEqual(
    queryFiltered.map((r) => r.id),
    ["n-tech", "n-tech-sub"],
  );

  // Startup prompt comparison
  const outlineFirstPrompt = buildBidStartupPrompt({
    name: "测试项目",
    deadline: "2028-06-01",
    vaultId: "v1",
    workflowMode: "outline_first",
    tenders: [{ copy: "tender/1.docx" }],
  });
  assert.match(outlineFirstPrompt, /seal_outline\(action="save"\)/);
  assert.match(outlineFirstPrompt, /严禁调用 `seal_doc_extract` 或 `seal_doc_edit`/);

  const directPrompt = buildBidStartupPrompt({
    name: "测试项目",
    deadline: "2028-06-01",
    vaultId: "v1",
    workflowMode: "direct",
    tenders: [{ copy: "tender/1.docx" }],
  });
  assert.match(directPrompt, /direct/);
  assert.doesNotMatch(directPrompt, /严禁调用 `seal_doc_extract`/);

  // Stage-2 execution & revision prompts
  const execPrompt = buildOutlineExecutionPrompt(
    { name: "测试项目", deadline: "2028-06-01", vaultId: "v1" },
    modified,
    { digest: canonicalOutlineDigest(modified), confirmedAt: "2028-01-02T00:00:00Z" },
  );
  assert.match(execPrompt, /seal_outline\(action="get"\)/);
  assert.match(execPrompt, /renderedPages/);
  assert.match(execPrompt, /C17/);

  const revPrompt = buildOutlineRevisionPrompt(
    { name: "测试项目" },
    modified.nodes[5],
    "补充售后服务条款",
  );
  assert.match(revPrompt, /n-tech/);
  assert.match(revPrompt, /补充售后服务条款/);

  // C17 reviewItems & reviewPage
  const results = emptyResults();
  results.C17 = [
    { kind: "missing_evidence", draft: "商务标", nodeId: "n-cert-kb", title: "营业执照", reason: "漏挂证照", ref: "rec-license" },
    { kind: "missing_section", draft: "商务标", nodeId: "n-cert-kb", title: "营业执照", reason: "漏章" },
  ];
  const items = reviewItems([{ draft: "商务标", complete: true, results, limitations: [] }]);
  assert.equal(items.length, 2);
  assert.notEqual(items[0].key, items[1].key);
  assert.equal(items[0].nodeId, "n-cert-kb");
  assert.equal(items[0].title, "营业执照");
  assert.equal(items[0].draft, "商务标");
  assert.equal(items[0].reason, "漏挂证照");
  const pages = reviewPage(items);
  assert.equal(pages[0].id, "C17");
  assert.equal(pages[0].totalCount, 2);
});

test("M42 regression: assertLockedTemplateTransitions across updateOutlineNode, patchOutline and CLI outline save/patch", async (t) => {
  const base = sampleOutline();

  // Direct assertLockedTemplateTransitions checks
  assert.doesNotThrow(() => assertLockedTemplateTransitions(null, base));
  assert.doesNotThrow(() =>
    assertLockedTemplateTransitions(
      base,
      updateOutlineNode(base, "n-cover", { note: "补充说明", number: "一、" }),
    ),
  );

  // Omitting lockedTemplate, flipping optional, changing volume/kind/title, setting included=false, deleting
  const clone = (): OutlineDocument => structuredClone(base);
  const omittedLock = clone();
  delete omittedLock.nodes[0].lockedTemplate;
  assert.throws(() => assertLockedTemplateTransitions(base, omittedLock), /锁定/);

  const flippedOptional = clone();
  flippedOptional.nodes[0].optional = true;
  assert.throws(() => assertLockedTemplateTransitions(base, flippedOptional), /可选/);

  const changedVolume = clone();
  changedVolume.nodes[0].volume = "技术标";
  assert.throws(() => assertLockedTemplateTransitions(base, changedVolume), /分册/);

  const changedKind = clone();
  changedKind.nodes[0].kind = "authored";
  assert.throws(() => assertLockedTemplateTransitions(base, changedKind), /类型/);

  // updateOutlineNode & patchOutline bypass attempts
  assert.throws(() => updateOutlineNode(base, "n-cover", { optional: true }), /锁定/);
  assert.throws(
    () => updateOutlineNode(base, "n-cover", { lockedTemplate: undefined }),
    /锁定/,
  );
  assert.throws(() => updateOutlineNode(base, "n-cover", { volume: "技术标" }), /锁定/);
  assert.throws(() => updateOutlineNode(base, "n-cover", { kind: "authored" }), /锁定/);

  assert.throws(
    () =>
      patchOutline(base, {
        upsertNodes: [
          {
            id: "n-cover",
            volume: "商务标",
            parentId: null,
            level: 1,
            title: "投标函",
            kind: "template",
            included: true,
          },
        ],
      }),
    /锁定/,
  );
  assert.throws(
    () =>
      patchOutline(base, {
        upsertNodes: [{ ...base.nodes[0], optional: true }],
      }),
    /锁定/,
  );

  // CLI outline save/patch full replacement bypass attempt
  const sandbox = await createSandbox(t, "m42-lock-cli-");
  const host = new NodeHostPort();
  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, await buildDocx(p("投标函")));
  const projRoot = path.join(sandbox, "proj");
  await initializeProject(host, projRoot, {
    name: "锁定保护测试",
    deadline: "2028-06-01",
    workflowMode: "outline_first",
    tenders: [tenderPath],
    createdAt: "2028-01-01T00:00:00.000Z",
  });

  await runProject(host, [
    "outline",
    "--project",
    projRoot,
    "--action",
    "save",
    "--volumes",
    JSON.stringify(base.volumes),
    "--nodes",
    JSON.stringify(base.nodes),
  ]);

  // Attempt CLI outline save omitting lockedTemplate on n-cover -> rejected
  await assert.rejects(
    runProject(host, [
      "outline",
      "--project",
      projRoot,
      "--action",
      "save",
      "--volumes",
      JSON.stringify(base.volumes),
      "--nodes",
      JSON.stringify(omittedLock.nodes),
    ]),
    /锁定/,
  );

  // Attempt CLI outline save flipping optional: true on n-cover -> rejected
  await assert.rejects(
    runProject(host, [
      "outline",
      "--project",
      projRoot,
      "--action",
      "save",
      "--volumes",
      JSON.stringify(base.volumes),
      "--nodes",
      JSON.stringify(flippedOptional.nodes),
    ]),
    /锁定/,
  );

  // Attempt CLI outline patch changing kind -> rejected
  await assert.rejects(
    runProject(host, [
      "outline",
      "--project",
      projRoot,
      "--action",
      "patch",
      "--upsert-nodes",
      JSON.stringify([{ ...base.nodes[0], kind: "authored" }]),
    ]),
    /锁定/,
  );
});

test("M42 regression: visibleBodyNonTocParagraphs and C17 exclude TOC caches, w:vanish, w:webHidden and w:del", async () => {
  const xml =
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>目录</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:rPr><w:vanish/></w:rPr><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>` +
    `<w:r><w:rPr><w:vanish/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:hyperlink w:anchor="_Toc1"><w:r><w:t>一、投标函</w:t></w:r></w:hyperlink></w:p>` +
    `<w:p><w:r><w:t>二、假装已写技术方案</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
    `<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` +
    `<w:p><w:fldSimple w:instr="TOC \\o '1-2'"><w:r><w:t>三、简单域目录项</w:t></w:r></w:fldSimple></w:p>` +
    `<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>四、隐藏文字章节</w:t></w:r></w:p>` +
    `<w:p><w:r><w:rPr><w:webHidden/></w:rPr><w:t>五、网页隐藏章节</w:t></w:r></w:p>` +
    `<w:p><w:del w:id="1" w:author="x" w:date="2028-01-01T00:00:00Z"><w:r><w:t>六、已删除章节</w:t></w:r></w:del></w:p>` +
    `<w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>七、显式可见章节</w:t></w:r></w:p>` +
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:webHidden w:val="false"/></w:rPr><w:t>八、表格内可见章节</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    `<w:sectPr/></w:body></w:document>`;

  const paras = visibleBodyNonTocParagraphs(xml);
  assert.deepEqual(paras, ["目录", "七、显式可见章节", "八、表格内可见章节"]);

  // Verify checkOutlineConsistency reports missing_section when headings only exist in TOC cache or vanish/webHidden
  const fakeDocx = await writeZip(
    new Map([
      [
        "[Content_Types].xml",
        enc.encode(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
        ),
      ],
      ["word/document.xml", enc.encode(xml)],
      [
        "word/_rels/document.xml.rels",
        enc.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'),
      ],
    ]),
  );

  const outline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n1", volume: "商务标", parentId: null, level: 1, title: "一、投标函", kind: "template", included: true },
      { id: "n2", volume: "商务标", parentId: null, level: 1, title: "二、假装已写技术方案", kind: "authored", included: true },
      { id: "n3", volume: "商务标", parentId: null, level: 1, title: "三、简单域目录项", kind: "authored", included: true },
      { id: "n4", volume: "商务标", parentId: null, level: 1, title: "四、隐藏文字章节", kind: "authored", included: true },
      { id: "n5", volume: "商务标", parentId: null, level: 1, title: "五、网页隐藏章节", kind: "authored", included: true },
      { id: "n6", volume: "商务标", parentId: null, level: 1, title: "六、已删除章节", kind: "authored", included: true },
      { id: "n7", volume: "商务标", parentId: null, level: 1, title: "七、显式可见章节", kind: "authored", included: true },
      { id: "n8", volume: "商务标", parentId: null, level: 1, title: "八、表格内可见章节", kind: "authored", included: true },
    ],
  };

  const issues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", fakeDocx]]),
    ledger: {
      format: "seal-ledger-1",
      fills: [],
      pending: [],
      dismissals: [],
      acceptedChanges: [],
      requirements: [],
      drafts: {},
    },
  });

  const missingIds = issues.filter((i) => i.kind === "missing_section").map((i) => i.nodeId);
  assert.deepEqual(missingIds, ["n1", "n2", "n3", "n4", "n5", "n6"]);
});

test("M42 regression: C17 verifies non-image materials via {{quote:...}} and KB attachments via active bookmark media", async (t) => {
  const sandbox = await createSandbox(t, "m42-ev-reg-");
  const host = new NodeHostPort();
  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, await buildDocx(p("承诺书章节") + p("营业执照章节")));

  // Create KB with record carrying PNG_1X1_RED
  const kbRoot = path.join(process.env.SEAL_HOME!, "vaults");
  await fs.mkdir(kbRoot, { recursive: true });
  const kb = new KnowledgeBase(host, kbRoot);
  const vault = await kb.createVault({ name: "测试库", vaultId: "v-ev-reg" });
  await kb.save(vault.vaultId, {
    action: "update",
    kind: "subject",
    fields: { legalName: "星辰测试科技有限公司" },
    body: "",
  });
  const savedRec = await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: {
      type: "营业执照",
      title: "营业执照副本",
      number: "LIC-2028-002",
      holder: "星辰测试科技有限公司",
      validUntil: "2030-12-31",
    },
    body: "",
  });
  const attached = await kb.save(vault.vaultId, {
    action: "attach_file",
    kind: "record",
    id: savedRec.id,
    file: { fileName: "license.png", bytes: PNG_1X1_RED },
  });
  const kbFileRel = (attached.fields.files as string[])[0];
  await kb.verify(vault.vaultId, "record", savedRec.id);

  const projRoot = path.join(sandbox, "proj");
  await runProject(host, [
    "init",
    "--root",
    projRoot,
    "--name",
    "非图片与KB空书签回归",
    "--deadline",
    "2028-06-01",
    "--vault",
    vault.vaultId,
    "--workflow-mode",
    "outline_first",
    "--tender",
    tenderPath,
  ]);

  const matDir = path.join(projRoot, "materials", "outline");
  await fs.mkdir(matDir, { recursive: true });
  await fs.writeFile(path.join(matDir, "commitment.txt"), "本公司承诺严格按期交付。", "utf8");
  await fs.writeFile(path.join(matDir, "manual.docx"), await buildDocx(p("履约说明书正文")));

  const outline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:1" }] }],
    nodes: [
      {
        id: "n-txt",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "承诺书章节",
        kind: "authored",
        included: true,
        evidence: [
          { source: "material", ref: "materials/outline/commitment.txt" },
          { source: "material", ref: "materials/outline/manual.docx" },
        ],
      },
      {
        id: "n-kb",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "营业执照章节",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: savedRec.id }],
      },
    ],
  };

  await runProject(host, [
    "outline",
    "--project",
    projRoot,
    "--action",
    "save",
    "--volumes",
    JSON.stringify(outline.volumes),
    "--nodes",
    JSON.stringify(outline.nodes),
  ]);

  const secret = (await host.authorizationKey(false))!;
  const ledgerInit: BidLedger = JSON.parse(await fs.readFile(path.join(projRoot, "ledger.json"), "utf8"));
  await confirmOutline(
    ledgerInit,
    outline,
    { root: projRoot, vaultId: vault.vaultId, deadline: "2028-06-01" },
    secret,
    "2028-01-02T00:00:00.000Z",
  );
  await sealLedger(ledgerInit, projRoot, secret);
  await fs.writeFile(path.join(projRoot, "ledger.json"), JSON.stringify(ledgerInit, null, 2));
  await fs.writeFile(await host.ledgerAnchorPath(projRoot, false), JSON.stringify(ledgerInit.integrity));

  await runProject(host, [
    "extract",
    "--project",
    projRoot,
    "--tender",
    "tender/1.docx",
    "--draft",
    "商务标",
    "--ranges",
    JSON.stringify([{ from: "p:0", to: "p:1" }]),
  ]);

  // Before quoting .txt / .docx and mounting KB image -> C17 blocks all three!
  const beforeCheck = (await runProject(host, ["check", "--project", projRoot])) as {
    volumes: Array<{ results: { C17: Array<{ kind: string; ref?: string }> } }>;
  };
  const missingRefs = beforeCheck.volumes[0].results.C17.filter((i) => i.kind === "missing_evidence").map((i) => i.ref);
  assert.ok(missingRefs.includes("materials/outline/commitment.txt"));
  assert.ok(missingRefs.includes("materials/outline/manual.docx"));
  assert.ok(missingRefs.includes(savedRec.id));

  // Unknown 'other' material state also triggers missing_evidence (never silently passes)
  const otherIssueCheck = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: { ...outline, nodes: [{ ...outline.nodes[0], evidence: [{ source: "material", ref: "materials/outline/raw.bin" }] }] } },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", await fs.readFile(path.join(projRoot, "draft", "商务标.docx"))]]),
    ledger: ledgerInit,
    materialStates: new Map<string, OutlineMaterialState>([
      ["materials/outline/raw.bin", { exists: true, readable: true, kind: "other", expectedImageHashes: [] }],
    ]),
  });
  assert.ok(otherIssueCheck.some((i) => i.kind === "missing_evidence" && i.ref === "materials/outline/raw.bin"));

  // Write {{quote:...}} for both .txt and .docx AND mount KB image
  await runProject(host, [
    "edit",
    "--project",
    projRoot,
    "--draft",
    "商务标",
    "--ops",
    JSON.stringify([
      {
        op: "insert",
        at: "p:0",
        position: "after",
        markdown:
          "{{quote:materials/outline/commitment.txt|本公司承诺严格按期交付。}}\n\n{{quote:materials/outline/manual.docx|履约说明书正文}}",
      },
      {
        op: "insert",
        at: "p:1",
        position: "after",
        markdown: `![kb](kb:${savedRec.id}/${kbFileRel})`,
      },
    ]),
  ]);

  const cleanAfterQuote = (await runProject(host, ["check", "--project", projRoot])) as {
    blockingCounts: Record<string, number>;
    ready: boolean;
  };
  assert.equal(cleanAfterQuote.blockingCounts.C17, 0);
  assert.equal(cleanAfterQuote.ready, true, `blockingCounts=${JSON.stringify(cleanAfterQuote.blockingCounts)}`);

  // Simulate empty KB bookmark (strip <w:drawing ...>...</w:drawing> / <a:blip> inside _Seal_F_<id> while keeping bookmark & fill!)
  const draftBytesNow = await fs.readFile(path.join(projRoot, "draft", "商务标.docx"));
  const { validatePackageStructure } = await import("../src/core/docx/package-structure.js");
  const parts = await validatePackageStructure(draftBytesNow);
  const docXml = new TextDecoder().decode(parts.get("word/document.xml")!);
  const strippedXml = docXml.replace(/<w:drawing\b[\s\S]*?<\/w:drawing>/g, "<w:t>空占位</w:t>");
  assert.notEqual(strippedXml, docXml, "Expected <w:drawing> to be stripped from document.xml");
  const strippedParts = new Map(parts);
  strippedParts.set("word/document.xml", enc.encode(strippedXml));
  const strippedDocx = await writeZip(strippedParts);

  const ledgerNow: BidLedger = JSON.parse(await fs.readFile(path.join(projRoot, "ledger.json"), "utf8"));
  const strippedCheck = await checkOutlineConsistency({
    outlineState: { kind: "value", outline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", strippedDocx]]),
    ledger: ledgerNow,
    kbRecordHasFiles: new Map([[savedRec.id, true]]),
    kbRecordImageHashes: new Map([[savedRec.id, [sha256Hex(PNG_1X1_RED)]]]),
    materialStates: new Map<string, OutlineMaterialState>([
      ["materials/outline/commitment.txt", { exists: true, readable: true, kind: "text", expectedImageHashes: [] }],
      ["materials/outline/manual.docx", { exists: true, readable: true, kind: "docx", expectedImageHashes: [] }],
    ]),
  });
  assert.ok(
    strippedCheck.some((i) => i.kind === "missing_evidence" && i.source === "kb" && i.ref === savedRec.id),
    `Stripping <a:blip> from KB bookmark must trigger C17 missing_evidence, got: ${JSON.stringify(strippedCheck)}`,
  );

  // Wrong image hash inside KB bookmark (blue instead of red) also fails C17!
  const wrongHashCheck = await checkOutlineConsistency({
    outlineState: { kind: "value", outline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", draftBytesNow]]),
    ledger: ledgerNow,
    kbRecordHasFiles: new Map([[savedRec.id, true]]),
    kbRecordImageHashes: new Map([[savedRec.id, [sha256Hex(PNG_1X1_BLUE)]]]),
    materialStates: new Map<string, OutlineMaterialState>([
      ["materials/outline/commitment.txt", { exists: true, readable: true, kind: "text", expectedImageHashes: [] }],
      ["materials/outline/manual.docx", { exists: true, readable: true, kind: "docx", expectedImageHashes: [] }],
    ]),
  });
  assert.ok(
    wrongHashCheck.some((i) => i.kind === "missing_evidence" && i.source === "kb" && i.ref === savedRec.id),
    "Mismatched KB image hash must trigger C17 missing_evidence",
  );

  // Delete the quoted .txt paragraph -> C17 missing_evidence reappears
  const blocksAfterQuote = (await runProject(host, [
    "read",
    "--project",
    projRoot,
    "--file",
    "商务标",
    "--mode",
    "blocks",
  ])) as { items: Array<{ address: string | null; text: string }> };
  const txtQuoteAddr = blocksAfterQuote.items.find((i) => i.address && i.text.includes("严格按期交付"))!.address!;
  await runProject(host, [
    "edit",
    "--project",
    projRoot,
    "--draft",
    "商务标",
    "--ops",
    JSON.stringify([{ op: "delete", at: txtQuoteAddr }]),
  ]);
  const afterDeleteQuote = (await runProject(host, ["check", "--project", projRoot])) as {
    blockingCounts: Record<string, number>;
    volumes: Array<{ results: { C17: Array<{ kind: string; ref?: string }> } }>;
  };
  assert.ok(afterDeleteQuote.blockingCounts.C17 > 0);
  assert.ok(
    afterDeleteQuote.volumes[0].results.C17.some(
      (i) => i.kind === "missing_evidence" && i.ref === "materials/outline/commitment.txt",
    ),
  );
});

test("M42 regression: empty-volumes check reports unresolved ledger.integrityIncident in C15", async (t) => {
  const sandbox = await createSandbox(t, "m42-empty-c15-");
  const host = new NodeHostPort();
  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, await buildDocx(p("投标函")));
  const projRoot = path.join(sandbox, "proj");
  await initializeProject(host, projRoot, {
    name: "空分册C15防篡改测试",
    deadline: "2028-06-01",
    workflowMode: "outline_first",
    tenders: [tenderPath],
    createdAt: "2028-01-01T00:00:00.000Z",
  });

  // Baseline with volumes.length === 0 has C15 === 0
  const clean = (await runProject(host, ["check", "--project", projRoot])) as {
    counts: Record<string, number>;
    blockingCounts: Record<string, number>;
  };
  assert.equal(clean.counts.C15, 0);
  assert.equal(clean.blockingCounts.C15, 0);

  // Tamper and re-sign ledger.json with SAME key without updating external anchor
  const secret = (await host.authorizationKey(false))!;
  const forgedLedger: BidLedger = JSON.parse(
    await fs.readFile(path.join(projRoot, "ledger.json"), "utf8"),
  );
  forgedLedger.tenders = { "tender/1.docx": "0".repeat(64) };
  await sealLedger(forgedLedger, projRoot, secret);
  await fs.writeFile(path.join(projRoot, "ledger.json"), JSON.stringify(forgedLedger, null, 2));

  const tampered = (await runProject(host, ["check", "--project", projRoot])) as {
    counts: Record<string, number>;
    blockingCounts: Record<string, number>;
  };
  assert.ok(tampered.counts.C15 >= 1, `Expected C15 >= 1, got ${tampered.counts.C15}`);
  assert.ok(tampered.blockingCounts.C15 >= 1);
});

test("M42 R2 regression: KB attachment requires expected hash inside exact bookmark and fails closed on media resolution error", async () => {
  const rightBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const wrongBytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
  const rightHash = sha256Hex(rightBytes);

  // Document puts WRONG image inside bookmark _Seal_F_kb1, and RIGHT image OUTSIDE the bookmark!
  const spoofedDocx = await writeZip(
    new Map([
      [
        "[Content_Types].xml",
        new Uint8Array(
          Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          ),
        ),
      ],
      [
        "_rels/.rels",
        new Uint8Array(
          Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          ),
        ),
      ],
      [
        "word/_rels/document.xml.rels",
        new Uint8Array(
          Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWrong" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/wrong.png"/><Relationship Id="rIdRight" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/right.png"/></Relationships>',
          ),
        ),
      ],
      [
        "word/document.xml",
        new Uint8Array(
          Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>' +
              "<w:p><w:r><w:t>营业执照</w:t></w:r></w:p>" +
              '<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_kb1"/><w:r><w:drawing><a:blip r:embed="rIdWrong"/></w:drawing></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
              '<w:p><w:r><w:drawing><a:blip r:embed="rIdRight"/></w:drawing></w:r></w:p>' +
              "<w:sectPr/></w:body></w:document>",
          ),
        ),
      ],
      ["word/media/wrong.png", wrongBytes],
      ["word/media/right.png", rightBytes],
    ]),
  );

  const outlineDoc: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-kb-exact",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "营业执照",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: "rec-yyzz", label: "营业执照" }],
      },
    ],
    updatedAt: "2028-01-01T00:00:00.000Z",
    updatedBy: "human",
  };
  const ledger: BidLedger = {
    format: "seal-ledger-1",
    fills: [
      {
        id: "kb1",
        draft: "商务标",
        operation: "insert_image",
        reference: "kb:rec-yyzz/files/yyzz.png",
        sources: [
          {
            reference: "kb:rec-yyzz/files/yyzz.png",
            resolvedValue: "",
            verified: true,
            recordId: "rec-yyzz",
            media: true,
          },
        ],
        resolvedValue: "",
        verified: true,
        sealKind: "fact",
      },
    ],
    pending: [],
    dismissals: [],
    acceptedChanges: [],
    requirements: [],
    drafts: {},
  };

  // (a) Right image outside bookmark + wrong image inside bookmark MUST STILL fail C17
  const outsideIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: outlineDoc },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", spoofedDocx]]),
    ledger,
    kbRecordHasFiles: new Map([["rec-yyzz", true]]),
    kbRecordMediaStates: new Map([["rec-yyzz", { kind: "ok", hashes: [rightHash] }]]),
  });
  assert.ok(
    outsideIssues.some((issue) => issue.kind === "missing_evidence" && issue.nodeId === "n-kb-exact"),
    "Expected C17 missing_evidence when right KB image is outside target bookmark",
  );

  // (b) Unreadable/errored KB media state MUST fail closed even if bookmark has an image AND even when kbRecordHasFiles is false/missing!
  for (const hasFilesMap of [
    new Map([["rec-yyzz", true]]),
    new Map<string, boolean>(),
  ]) {
    const errorIssues = await checkOutlineConsistency({
      outlineState: { kind: "value", outline: outlineDoc },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", spoofedDocx]]),
      ledger,
      kbRecordHasFiles: hasFilesMap,
      kbRecordMediaStates: new Map([["rec-yyzz", { kind: "error", reason: "原图已损坏" }]]),
    });
    assert.ok(
      errorIssues.some(
        (issue) =>
          issue.kind === "missing_evidence" &&
          issue.nodeId === "n-kb-exact" &&
          issue.reason.includes("原图已损坏"),
      ),
      "Expected C17 fail-closed on KB media resolution error regardless of kbRecordHasFiles",
    );
  }
});

test("M42 R3 regression: partial KB attachment read error (1 valid image + 1 missing image) fails closed in C17", async (t) => {
  const sandbox = await createSandbox(t, "m42-kb-partial-err-");
  const host = new NodeHostPort();
  const kbRoot = path.join(sandbox, "seal-home", "vaults");
  await fs.mkdir(kbRoot, { recursive: true });
  const prevSealHome = process.env.SEAL_HOME;
  process.env.SEAL_HOME = path.join(sandbox, "seal-home");
  t.after(() => {
    if (prevSealHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = prevSealHome;
  });

  const kb = new KnowledgeBase(host, kbRoot);
  await kb.createVault({ vaultId: "v-part", name: "部分缺失测试库" });
  await kb.save("v-part", {
    action: "update",
    kind: "subject",
    fields: { legalName: "测试企业" },
    body: "测试企业主体",
  });
  const rec = await kb.save("v-part", {
    action: "create",
    kind: "record",
    fields: { title: "双页证照", type: "资质证书", holder: "测试企业", validFrom: "2020-01-01", validUntil: "2035-12-31" },
    body: "双页证照记录",
  });
  await kb.save("v-part", { action: "attach_file", kind: "record", id: rec.id, file: { fileName: "good.png", bytes: PNG_1X1_RED } });
  await kb.save("v-part", { action: "attach_file", kind: "record", id: rec.id, file: { fileName: "missing.png", bytes: PNG_1X1_BLUE } });
  const attached = await kb.get("v-part", "record", rec.id);
  const attachedFiles = attached.fields.files as string[];
  assert.equal(attachedFiles.length, 2);

  // Remove the second file on disk so file A succeeds while file B fails!
  await fs.unlink(path.join(kb.vaultRoot("v-part"), attachedFiles[1]));

  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, await buildDocx(p("双页证照")));
  const projRoot = path.join(sandbox, "proj");
  await initializeProject(host, projRoot, {
    name: "部分缺失测试项目",
    deadline: "2028-06-01",
    vaultId: "v-part",
    workflowMode: "outline_first",
    tenders: [tenderPath],
    createdAt: "2028-01-01T00:00:00.000Z",
  });
  await runProject(host, [
    "outline", "--project", projRoot, "--action", "save",
    "--volumes", JSON.stringify([{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:0" }] }]),
    "--nodes", JSON.stringify([
      { id: "n-dual", volume: "商务标", parentId: null, level: 1, title: "双页证照", kind: "attachment", included: true, evidence: [{ source: "kb", ref: rec.id, label: "双页证照" }] },
    ]),
  ]);
  await runProject(host, [
    "extract", "--project", projRoot, "--tender", "tender/1.docx", "--draft", "商务标",
    "--ranges", JSON.stringify([{ from: "p:0", to: "p:0" }]),
  ]);
  await runProject(host, [
    "edit", "--project", projRoot, "--draft", "商务标",
    "--ops", JSON.stringify([{ op: "insert_image", at: "p:0", image: `kb:${rec.id}/${attachedFiles[0]}` }]),
  ]);

  const checked = (await runProject(host, ["check", "--project", projRoot, "--group", "C17"])) as {
    volumes: Array<{ results: { C17: Array<{ kind: string; nodeId?: string; reason: string }> } }>;
  };
  assert.ok(
    checked.volumes[0].results.C17.some(
      (issue) => issue.kind === "missing_evidence" && issue.nodeId === "n-dual" && issue.reason.includes("无法核验原图"),
    ),
    `Expected partial KB image read error to fail closed in C17, got: ${JSON.stringify(checked.volumes[0].results.C17)}`,
  );
});
