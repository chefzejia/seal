import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NodeHostPort } from "../src/shells/node-host.js";
import { KnowledgeBase, serializeEntry } from "../src/core/kb/index.js";
import type { HealthIssue, HealthReport, KbEntry } from "../src/core/kb/types.js";
import { WorkbenchHost } from "../src/shells/dsh/workbench-host.js";
import { zh, en } from "../src/shells/dsh/client-locale.js";
import {
  buildKnowledgeCatalog,
  formatCandidatePreviewBody,
  formatVaultSummaryLine,
  isSubjectReady,
  summarizeVault,
  summarizeVaultOverview,
} from "../src/workbench/knowledge.js";

function makeRecord(
  id: string,
  overrides: Partial<HealthReport["records"][number]> = {},
): HealthReport["records"][number] {
  return {
    id,
    kind: "record",
    fields: { type: "营业执照", title: `记录-${id}` },
    body: "",
    verified: false,
    verifiedFields: [],
    issues: [],
    validity: "valid",
    subject: "self",
    ...overrides,
  };
}

function makeMaterial(
  id: string,
  overrides: Partial<KbEntry> = {},
): KbEntry {
  return {
    id,
    kind: "material",
    fields: { title: `素材-${id}` },
    body: `正文-${id}`,
    verified: false,
    verifiedFields: [],
    issues: [],
    ...overrides,
  };
}

test("pure knowledge view model summarizes counts, formats summary lines, and filters tri-state verification", () => {
  // 1. Empty vault
  const emptySummary = summarizeVault({ records: [], materials: [], issues: [] });
  assert.deepEqual(emptySummary, {
    recordCount: 0,
    evidenceCount: 0,
    materialCount: 0,
    expiring: 0,
    unknown: 0,
    unverified: 0,
  });
  assert.equal(
    formatVaultSummaryLine({ creditCode: "", ...emptySummary }),
    "资料 0 · 即将过期 0 · 效期未知 0 · 未核实 0",
  );
  assert.equal(
    formatVaultSummaryLine({ creditCode: "   ", ...emptySummary }, { locale: "en" }),
    "Items 0 · Expiring soon 0 · Unknown validity 0 · Unverified 0",
  );
  const emptyCatalog = buildKnowledgeCatalog({ records: [], materials: [], issues: [] });
  assert.equal(emptyCatalog.count, 0);
  assert.deepEqual(emptyCatalog.types, []);
  assert.deepEqual(emptyCatalog.items, []);

  // 2. Pure material vault
  const materialOnly = [makeMaterial("m1")];
  const materialIssues: HealthIssue[] = [
    { code: "subject_missing", kind: "subject", id: "subject", field: "legalName", message: "主体法定名称缺失" },
    { code: "field_unknown", kind: "material", id: "m1", field: "note", message: "未定义字段" },
  ];
  const materialSummary = summarizeVault({
    records: [],
    materials: materialOnly,
    issues: materialIssues,
  });
  assert.deepEqual(materialSummary, {
    recordCount: 1,
    evidenceCount: 0,
    materialCount: 1,
    expiring: 0,
    unknown: 0,
    unverified: 0,
  });
  const materialLineZh = formatVaultSummaryLine({ creditCode: "", ...materialSummary });
  assert.ok(!materialLineZh.startsWith(" · "));
  assert.equal(
    materialLineZh,
    "资料 1（证据 0 · 素材 1） · 即将过期 0 · 效期未知 0 · 未核实 0",
  );
  assert.equal(
    formatVaultSummaryLine(
      { creditCode: "91110000000000000X", ...materialSummary },
      { locale: "en" },
    ),
    "91110000000000000X · Items 1 (Evidence 0 · Materials 1) · Expiring soon 0 · Unknown validity 0 · Unverified 0",
  );

  // 3. Pure evidence vault
  const evidenceOnly = [
    makeRecord("r1", { validity: "expiring_soon", verified: true }),
    makeRecord("r2", { validity: "unknown", verified: false, fields: { type: "资质证书", title: "资质" } }),
  ];
  const evidenceIssues: HealthIssue[] = [
    { code: "record_unverified", kind: "record", id: "r2", message: "未核实" },
  ];
  const evidenceSummary = summarizeVault({
    records: evidenceOnly,
    materials: [],
    issues: evidenceIssues,
  });
  assert.deepEqual(evidenceSummary, {
    recordCount: 2,
    evidenceCount: 2,
    materialCount: 0,
    expiring: 1,
    unknown: 1,
    unverified: 1,
  });
  assert.equal(
    formatVaultSummaryLine({ creditCode: "91110000000000000X", ...evidenceSummary }),
    "91110000000000000X · 资料 2 · 即将过期 1 · 效期未知 1 · 未核实 1",
  );

  // 4. Mixed vault with subject_unverified, record_unverified, missing type, and non-verification issues
  const mixedRecords = [
    makeRecord("r-ver", { validity: "valid", verified: true, fields: { type: "营业执照", title: "执照" } }),
    makeRecord("r-unv", { validity: "unknown", verified: false, fields: { title: "无类型证据" } }),
  ];
  const mixedMaterials = [makeMaterial("m-1", { fields: { title: "技术方案段落" }, body: "架构描述" })];
  const mixedIssues: HealthIssue[] = [
    { code: "subject_unverified", kind: "subject", id: "subject", field: "legalName", message: "主体未核实" },
    { code: "record_unverified", kind: "record", id: "r-unv", message: "记录未核实" },
    { code: "subject_missing", kind: "subject", id: "subject", field: "legalName", message: "非核实问题不应计入未核实" },
    { code: "validity_unknown", kind: "record", id: "r-unv", field: "validUntil", message: "效期未知" },
  ];
  const mixedCatalog = buildKnowledgeCatalog({
    records: mixedRecords,
    materials: mixedMaterials,
    issues: mixedIssues,
  });
  assert.equal(mixedCatalog.recordCount, 3);
  assert.equal(mixedCatalog.evidenceCount, 2);
  assert.equal(mixedCatalog.materialCount, 1);
  assert.equal(mixedCatalog.unverified, 2);
  assert.equal(mixedCatalog.count, 3);
  assert.deepEqual(mixedCatalog.types, ["营业执照", "material"]);
  assert.ok(mixedCatalog.types.every((value) => typeof value === "string" && value.length > 0));

  const byId = new Map(mixedCatalog.items.map((item) => [item.id, item]));
  assert.equal(byId.get("r-ver")?.verification, "verified");
  assert.equal(byId.get("r-ver")?.verified, true);
  assert.equal(byId.get("r-unv")?.verification, "unverified");
  assert.equal(byId.get("r-unv")?.verified, false);
  assert.equal(byId.get("m-1")?.verification, "not_applicable");
  assert.equal(byId.get("m-1")?.verified, false);
  assert.equal(byId.get("m-1")?.type, "material");

  // Type filter
  const onlyMaterial = buildKnowledgeCatalog({
    records: mixedRecords,
    materials: mixedMaterials,
    issues: mixedIssues,
    type: "material",
  });
  assert.deepEqual(onlyMaterial.items.map((item) => item.id), ["m-1"]);

  // Tri-state verification filters
  const onlyVerified = buildKnowledgeCatalog({
    records: mixedRecords,
    materials: mixedMaterials,
    issues: mixedIssues,
    verified: "yes",
  });
  assert.deepEqual(onlyVerified.items.map((item) => item.id), ["r-ver"]);

  const onlyUnverified = buildKnowledgeCatalog({
    records: mixedRecords,
    materials: mixedMaterials,
    issues: mixedIssues,
    verified: "no",
  });
  assert.deepEqual(onlyUnverified.items.map((item) => item.id), ["r-unv"]);

  const onlyNotApplicable = buildKnowledgeCatalog({
    records: mixedRecords,
    materials: mixedMaterials,
    issues: mixedIssues,
    verified: "not_applicable",
  });
  assert.deepEqual(onlyNotApplicable.items.map((item) => item.id), ["m-1"]);

  // Query filter
  const searched = buildKnowledgeCatalog({
    records: mixedRecords,
    materials: mixedMaterials,
    issues: mixedIssues,
    query: "架构描述",
  });
  assert.deepEqual(searched.items.map((item) => item.id), ["m-1"]);

  // Pagination validation
  assert.throws(
    () => buildKnowledgeCatalog({ records: [], materials: [], issues: [], offset: -1 }),
    /分页/,
  );

  // Locale completeness for client UI labels
  assert.equal(zh.verificationNotRequired, "无需核实");
  assert.equal(en.verificationNotRequired, "Not required");
  assert.equal(zh.healthIssues, "核实与体检提示");
  assert.equal(en.healthIssues, "Verification & health issues");
  assert.equal(zh.material, "写作素材");
  assert.equal(en.material, "Writing material");
});

test("WorkbenchHost keeps overview cards and catalog consistent across material, unverified, and verified transitions", async (t) => {
  const home = path.resolve(".tmp", `wb-knowledge-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const kb = new KnowledgeBase(host, path.join(home, "vaults"));
  const service = new WorkbenchHost(host);

  // 1. Create vault (reproducing #33 scenario)
  const created = (await service.kb({
    action: "create",
    name: "虚构项目验收库",
  })) as { vaultId: string };
  const vaultId = created.vaultId;

  // 2. Save 1 writing material
  await kb.save(vaultId, {
    action: "create",
    kind: "material",
    fields: { title: "合成技术方案素材" },
    body: "合成技术方案正文",
  });

  let overview = await service.overview();
  let card = overview.vaults.find((v) => v.vaultId === vaultId) as any;
  let catalog = (await service.kb({ action: "catalog", vaultId })) as any;

  assert.equal(card.recordCount, 1);
  assert.equal(card.evidenceCount, 0);
  assert.equal(card.materialCount, 1);
  assert.equal(card.unverified, 0);
  assert.equal(catalog.count, 1);
  assert.equal(catalog.recordCount, card.recordCount);
  assert.equal(catalog.items[0].kind, "material");
  assert.equal(catalog.items[0].type, "material");
  assert.equal(catalog.items[0].verification, "not_applicable");
  assert.equal(catalog.items[0].verified, false);
  assert.deepEqual(catalog.types, ["material"]);

  const cardLine = formatVaultSummaryLine(card);
  assert.ok(!cardLine.startsWith(" · "), `Unexpected leading dot: ${cardLine}`);
  assert.equal(
    cardLine,
    "资料 1（证据 0 · 素材 1） · 即将过期 0 · 效期未知 0 · 未核实 0",
  );

  // Filtering by verified=no must NOT return the writing material
  const unverifiedFilterWithOnlyMaterial = (await service.kb({
    action: "catalog",
    vaultId,
    verified: "no",
  })) as any;
  assert.equal(unverifiedFilterWithOnlyMaterial.count, 0);

  // Filtering by verified=not_applicable and type=material both find it
  const naFilter = (await service.kb({
    action: "catalog",
    vaultId,
    verified: "not_applicable",
  })) as any;
  assert.equal(naFilter.count, 1);
  const typeFilter = (await service.kb({
    action: "catalog",
    vaultId,
    type: "material",
  })) as any;
  assert.equal(typeFilter.count, 1);

  // 3. Add 1 unverified evidence record and an unverified subject field
  await kb.save(vaultId, {
    action: "update",
    kind: "subject",
    fields: { legalName: "合成验收企业" },
  });
  const record = await kb.save(vaultId, {
    action: "create",
    kind: "record",
    fields: {
      type: "营业执照",
      title: "合成营业执照",
      number: "SYN-001",
      holder: "合成验收企业",
      validUntil: "长期",
    },
    body: "",
  });

  overview = await service.overview();
  card = overview.vaults.find((v) => v.vaultId === vaultId) as any;
  catalog = (await service.kb({ action: "catalog", vaultId })) as any;

  assert.equal(card.recordCount, 2);
  assert.equal(card.evidenceCount, 1);
  assert.equal(card.materialCount, 1);
  assert.equal(card.unverified, 2); // 1 subject_unverified + 1 record_unverified
  assert.equal(catalog.count, 2);
  assert.equal(catalog.recordCount, 2);
  assert.deepEqual(new Set(catalog.types), new Set(["营业执照", "material"]));

  const unverifiedCatalog = (await service.kb({
    action: "catalog",
    vaultId,
    verified: "no",
  })) as any;
  assert.equal(unverifiedCatalog.count, 1);
  assert.equal(unverifiedCatalog.items[0].id, record.id);
  assert.equal(unverifiedCatalog.items[0].verification, "unverified");

  // 4. Verify subject field and evidence record via WorkbenchHost
  const subjectDetail = (await service.kb({
    action: "detail",
    vaultId,
    kind: "subject",
    id: "subject",
  })) as any;
  await service.kb({
    action: "verify",
    vaultId,
    kind: "subject",
    id: "subject",
    fields: ["legalName"],
    revision: subjectDetail.revision,
  });

  const recordDetail = (await service.kb({
    action: "detail",
    vaultId,
    kind: "record",
    id: record.id,
  })) as any;
  await service.kb({
    action: "verify",
    vaultId,
    kind: "record",
    id: record.id,
    fields: [],
    revision: recordDetail.revision,
  });

  overview = await service.overview();
  card = overview.vaults.find((v) => v.vaultId === vaultId) as any;
  catalog = (await service.kb({ action: "catalog", vaultId })) as any;

  assert.equal(card.recordCount, 2);
  assert.equal(card.evidenceCount, 1);
  assert.equal(card.materialCount, 1);
  assert.equal(card.unverified, 0);
  assert.equal(catalog.count, 2);
  assert.equal(
    ((await service.kb({ action: "catalog", vaultId, verified: "no" })) as any).count,
    0,
  );
  assert.equal(
    ((await service.kb({ action: "catalog", vaultId, verified: "yes" })) as any).count,
    1,
  );
  assert.equal(
    ((await service.kb({ action: "catalog", vaultId, verified: "not_applicable" })) as any).count,
    1,
  );
});

test("summarizeVaultOverview and buildKnowledgeCatalog project item metadata, kind filtering, and subject readiness", () => {
  const records = [
    makeRecord("rec-pdf", {
      validity: "valid",
      verified: true,
      fields: {
        type: "资质证书",
        title: "ISO9001 证书",
        number: "CERT-2026-01",
        validUntil: "2028-12-31",
        files: ["files/b1/cert.pdf", "files/b1/page-001.png", "files/b1/page-002.png"],
      },
    }),
    makeRecord("rec-no-img", {
      validity: "expiring_soon",
      verified: false,
      fields: {
        type: "营业执照",
        title: "无图证照",
        files: ["files/b1/doc.pdf"],
      },
    }),
  ];
  const materials = [
    makeMaterial("mat-1", {
      fields: { title: "技术方案段落", files: ["files/b1/diagram.webp"] },
    }),
  ];

  const emptySubjectSummary = summarizeVaultOverview({
    records,
    materials,
    issues: [{ code: "subject_missing" }],
    subject: { fields: {}, verified: false, verifiedFields: [] },
    pendingBatches: [{ pendingCount: 3 }, { pendingCount: 2 }],
  });
  assert.equal(emptySubjectSummary.pendingCandidateCount, 5);
  assert.equal(emptySubjectSummary.subjectName, undefined);
  assert.equal(emptySubjectSummary.subjectVerified, false);

  const partialSubjectSummary = summarizeVaultOverview({
    records,
    materials,
    issues: [{ code: "subject_unverified" }],
    subject: {
      fields: { legalName: "合成测试企业", phone: "010-12345678" },
      verified: true,
      verifiedFields: ["legalName"],
    },
    pendingBatches: [],
  });
  assert.equal(partialSubjectSummary.subjectName, "合成测试企业");
  assert.equal(partialSubjectSummary.subjectVerified, false);

  const fullSubjectSummary = summarizeVaultOverview({
    records,
    materials,
    issues: [],
    subject: {
      fields: { legalName: "合成测试企业" },
      verified: true,
      verifiedFields: ["legalName"],
    },
    pendingBatches: [{ pendingCount: 1 }],
  });
  assert.equal(fullSubjectSummary.subjectName, "合成测试企业");
  assert.equal(fullSubjectSummary.subjectVerified, true);
  assert.equal(fullSubjectSummary.pendingCandidateCount, 1);

  const fullCatalog = buildKnowledgeCatalog({ records, materials, issues: [] });
  assert.equal(fullCatalog.count, 3);
  const byId = new Map(fullCatalog.items.map((item) => [item.id, item]));
  assert.equal(byId.get("rec-pdf")?.number, "CERT-2026-01");
  assert.equal(byId.get("rec-pdf")?.validUntil, "2028-12-31");
  assert.equal(byId.get("rec-pdf")?.imageCount, 2);
  assert.equal(byId.get("rec-pdf")?.firstImageIndex, 1);
  assert.equal(byId.get("rec-no-img")?.imageCount, 0);
  assert.equal(byId.get("rec-no-img")?.firstImageIndex, undefined);
  assert.equal(byId.get("mat-1")?.imageCount, 1);
  assert.equal(byId.get("mat-1")?.firstImageIndex, 0);

  const recordOnly = buildKnowledgeCatalog({
    records,
    materials,
    issues: [],
    kind: "record",
  });
  assert.equal(recordOnly.count, 2);
  assert.deepEqual(recordOnly.items.map((i) => i.id), ["rec-pdf", "rec-no-img"]);
  assert.equal(recordOnly.materialCount, 1);

  const materialOnly = buildKnowledgeCatalog({
    records,
    materials,
    issues: [],
    kind: "material",
  });
  assert.equal(materialOnly.count, 1);
  assert.deepEqual(materialOnly.items.map((i) => i.id), ["mat-1"]);
  assert.equal(materialOnly.evidenceCount, 2);

  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test("PendingBatchSummary.sources, listCandidates metadata/pagination, and kbFile(kind=candidate) with traversal guard", async (t) => {
  const home = path.resolve(".tmp", `wb-cand-${randomUUID()}`);
  const previous = process.env.SEAL_HOME;
  process.env.SEAL_HOME = home;
  await fs.mkdir(home, { recursive: true });
  t.after(async () => {
    if (previous === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });

  const host = new NodeHostPort();
  const kb = new KnowledgeBase(host, path.join(home, "vaults"));
  const service = new WorkbenchHost(host);
  await kb.createVault({ vaultId: "cand-vault", name: "候选元数据测试库" });

  const vaultRoot = kb.vaultRoot("cand-vault");
  const batchId = "batch-meta-01";
  const inboxBatch = path.join(vaultRoot, "inbox", batchId);
  const filesBatch = path.join(vaultRoot, "files", batchId);
  await fs.mkdir(inboxBatch, { recursive: true });
  await fs.mkdir(filesBatch, { recursive: true });

  const pngBytes = await fs.readFile("tests/fixtures/evidence-2x1.png");
  await fs.writeFile(path.join(filesBatch, "page-1.png"), pngBytes);
  await fs.writeFile(path.join(filesBatch, "docx-img.png"), pngBytes);
  await fs.writeFile(path.join(home, "outside.png"), pngBytes);

  await fs.writeFile(
    path.join(inboxBatch, "candidate-01.md"),
    serializeEntry(
      {
        title: "营业执照扫描件",
        source: "license.pdf",
        sourceType: "pdf",
        location: "第 1 页 / 共 1 页",
        imageFiles: [`files/${batchId}/page-1.png`],
        files: [`files/${batchId}/page-1.png`],
        processed: false,
      },
      "营业执照正文",
    ),
  );
  await fs.writeFile(
    path.join(inboxBatch, "candidate-02.md"),
    serializeEntry(
      {
        title: "公司简介",
        source: "master.docx",
        sourceType: "docx",
        location: "word/document.xml#p:1-p:3",
        files: [`files/${batchId}/docx-img.png`],
        imageCount: "1",
        processed: true,
      },
      "公司简介正文",
    ),
  );
  await fs.writeFile(
    path.join(inboxBatch, "candidate-03.md"),
    serializeEntry(
      {
        title: "报价表",
        source: "license.pdf",
        sourceType: "spreadsheet",
        location: "Sheet1",
        imageFiles: ["../outside.png"],
        processed: false,
      },
      "报价正文",
    ),
  );
  await fs.writeFile(
    path.join(inboxBatch, "candidate-04.md"),
    "malformed-frontmatter-no-delimiter",
  );

  // 1. listPendingBatches returns deduplicated sources without extra I/O
  const batches = await kb.listPendingBatches("cand-vault");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].batchId, batchId);
  assert.equal(batches[0].totalCandidates, 4);
  assert.equal(batches[0].pendingCount, 3);
  assert.deepEqual(batches[0].sources, ["license.pdf", "master.docx"]);

  // 2. overview.vaults carries pendingCandidateCount & subject summary
  const overview = await service.overview();
  const card = overview.vaults.find((v) => v.vaultId === "cand-vault") as any;
  assert.equal(card.pendingCandidateCount, 3);
  assert.equal(card.subjectVerified, false);

  // 3. listCandidates paginates and enriches metadata with malformed fallback
  const page1 = await kb.listCandidates("cand-vault", batchId, 2);
  assert.equal(page1.candidateCount, 4);
  assert.equal(page1.candidates.length, 2);
  assert.equal(page1.nextAfter, "candidate-02");
  assert.deepEqual(page1.candidates[0], {
    id: "candidate-01",
    title: "营业执照扫描件",
    source: "license.pdf",
    location: "第 1 页 / 共 1 页",
    sourceType: "pdf",
    imageCount: 1,
    processed: false,
  });
  assert.deepEqual(page1.candidates[1], {
    id: "candidate-02",
    title: "公司简介",
    source: "master.docx",
    location: "word/document.xml#p:1-p:3",
    sourceType: "docx",
    imageCount: 1,
    processed: true,
  });

  const page2 = await kb.listCandidates("cand-vault", batchId, 2, page1.nextAfter!);
  assert.equal(page2.candidates.length, 2);
  assert.equal(page2.nextAfter, null);
  assert.equal(page2.candidates[0].id, "candidate-03");
  assert.equal(page2.candidates[0].sourceType, "spreadsheet");
  assert.deepEqual(page2.candidates[1], {
    id: "candidate-04",
    title: "candidate-04",
    source: "",
    location: "",
    imageCount: 0,
    processed: false,
  });

  // 4. kbFile(kind="candidate") positive controls (imageFiles & docx files fallback)
  const pdfImg = await service.kbFile({
    vaultId: "cand-vault",
    kind: "candidate",
    id: "candidate-01",
    index: "0",
  });
  assert.equal(pdfImg.type, "image/png");
  assert.deepEqual(Buffer.from(pdfImg.bytes), pngBytes);

  const docxImg = await service.kbFile({
    vaultId: "cand-vault",
    kind: "candidate",
    id: "candidate-02",
    index: 0,
  });
  assert.equal(docxImg.type, "image/png");
  assert.deepEqual(Buffer.from(docxImg.bytes), pngBytes);

  // 5. kbFile(kind="candidate") negative controls: traversal & out-of-range
  await assert.rejects(
    service.kbFile({
      vaultId: "cand-vault",
      kind: "candidate",
      id: "candidate-03",
      index: "0",
    }),
    /原件路径无效/,
  );
  await assert.rejects(
    service.kbFile({
      vaultId: "cand-vault",
      kind: "candidate",
      id: "candidate-01",
      index: "99",
    }),
    /原件不存在/,
  );
  await assert.rejects(
    service.kbFile({
      vaultId: "cand-vault",
      kind: "unknown",
      id: "candidate-01",
      index: "0",
    }),
    /类型无效/,
  );
});

test("isSubjectReady requires non-empty verified legalName and zero subject health errors, and formatCandidatePreviewBody strips batch UUID paths", () => {
  // Phone-only verified subject with empty legalName is NOT ready
  assert.equal(
    isSubjectReady({
      subject: {
        fields: { legalName: "", phone: "021-12345678" },
        verified: true,
        verifiedFields: ["phone"],
        issues: [],
      },
      issues: [],
    }),
    false,
  );
  // Verified legalName with invalid credit code health issue is NOT ready
  assert.equal(
    isSubjectReady({
      subject: {
        fields: { legalName: "合成测试有限公司", creditCode: "INVALID" },
        verified: true,
        verifiedFields: ["legalName"],
        issues: [],
      },
      issues: [{ code: "credit_code_invalid", kind: "subject" }],
    }),
    false,
  );
  // Verified legalName with record-scoped blocking codes (date_invalid / verification_invalid) IS ready on subject,
  // while subject-scoped date_invalid / verification_invalid MUST block subject readiness.
  assert.equal(
    isSubjectReady({
      subject: {
        fields: { legalName: "合成测试有限公司" },
        verified: true,
        verifiedFields: ["legalName"],
        issues: [],
      },
      issues: [
        { code: "record_unverified", kind: "record" },
        { code: "date_invalid", kind: "record" },
        { code: "verification_invalid", kind: "record" },
      ],
    }),
    true,
  );
  assert.equal(
    isSubjectReady({
      subject: {
        fields: { legalName: "合成测试有限公司" },
        verified: true,
        verifiedFields: ["legalName"],
        issues: [],
      },
      issues: [{ code: "date_invalid", kind: "subject" }],
    }),
    false,
  );
  assert.equal(
    isSubjectReady({
      subject: {
        fields: { legalName: "合成测试有限公司" },
        verified: true,
        verifiedFields: ["legalName"],
        issues: [],
      },
      issues: [{ code: "verification_invalid", kind: "subject" }],
    }),
    false,
  );
  // formatCandidatePreviewBody removes raw batch-UUID storage paths and markdown image refs while preserving human text
  const raw = [
    "原 PDF 存档：`files/batch-9338c71e-7597-4b75-a3d9-6653686044ca/src-1/ISO9001.pdf`",
    "",
    "## 第 1 页",
    "",
    "（本页无文本层，疑似扫描件，请查看对应图片提取关键信息）",
    "",
    "图片路径：`files/batch-9338c71e-7597-4b75-a3d9-6653686044ca/src-1/page-001.png`",
    "",
    "![第 1 页](../../files/batch-9338c71e-7597-4b75-a3d9-6653686044ca/src-1/page-001.png)",
  ].join("\n");
  const formatted = formatCandidatePreviewBody(raw);
  assert.doesNotMatch(formatted, /batch-9338c71e/i);
  assert.doesNotMatch(formatted, /files\/batch-/i);
  assert.match(formatted, /## 第 1 页/);
  assert.match(formatted, /本页无文本层，疑似扫描件/);
});
