import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { NodeHostPort } from "../src/shells/node-host.js";
import {
  OUTLINE_PDF_MAX_PAGES,
  WorkbenchHost,
  registerWorkbenchRoutes,
} from "../src/shells/dsh/workbench-host.js";
import { runProject } from "../src/shells/cli/project-v2.js";
import { KnowledgeBase } from "../src/core/kb/index.js";
import { compareDocuments } from "../src/core/docx/package-compare.js";
import { acceptChange } from "../src/core/bid/human-review.js";
import { sealLedger } from "../src/core/bid/ledger-integrity.js";
import { writeZip } from "../src/core/docx/zip.js";
import type { BidLedger } from "../src/core/bid/project.js";
import {
  addOutlineNode,
  moveOutlineNode,
  type OutlineDocument,
  type OutlineNode,
} from "../src/core/bid/outline.js";
import {
  applyOutlineDraftEdit,
  bindEvidenceToNode,
  buildOutlineView,
  canDeleteOutlineNode,
  canIndentOutlineNode,
  canMoveOutlineNode,
  canOutdentOutlineNode,
  createOutlineNodeId,
  outlineFilterCounts,
  reconcileOutlineServerPayload,
  unbindEvidenceFromNode,
} from "../src/workbench/outline.js";
import { zh, en } from "../src/shells/dsh/client-locale.js";

const enc = new TextEncoder();

const PNG_1X1_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const p = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

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

function buildPdfFromObjects(objects: string[]): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body));
}

function buildMultiPagePdf(pages: string[]): Uint8Array {
  const objects: string[] = ["", ""];
  const uniqueChars: string[] = [];
  const codeByChar = new Map<string, number>();
  for (const pageText of pages) {
    for (const ch of pageText) {
      if (!codeByChar.has(ch)) {
        codeByChar.set(ch, uniqueChars.length + 1);
        uniqueChars.push(ch);
      }
    }
  }
  const cmapEntries = uniqueChars
    .map(
      (ch, idx) =>
        `<${(idx + 1).toString(16).padStart(4, "0")}> <${ch.codePointAt(0)!.toString(16).padStart(4, "0")}>`,
    )
    .join("\n");
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CMapName /Seal-Test-UTF16 def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0001> <FFFF>",
    "endcodespacerange",
    `${Math.max(1, uniqueChars.length)} beginbfchar`,
    cmapEntries || "<0001> <0020>",
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");

  const fontObj = 3;
  const cidObj = 4;
  const cmapObj = 5;
  objects.push(
    `<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [${cidObj} 0 R] /ToUnicode ${cmapObj} 0 R >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>`,
    `<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`,
  );

  const kidRefs: string[] = [];
  for (const [pageIdx, pageText] of pages.entries()) {
    const pageObj = objects.length + 1;
    const contentObj = pageObj + 1;
    kidRefs.push(`${pageObj} 0 R`);
    const hex = Array.from(pageText)
      .map((ch) => codeByChar.get(ch)!.toString(16).padStart(4, "0"))
      .join("");
    // Draw a distinct colored rectangle per page so PDFium renders distinct PNGs for each page.
    const r = pageIdx % 2 === 0 ? "0.9 0.2 0.2" : "0.2 0.2 0.9";
    const y = 500 - pageIdx * 80;
    const stream = `${r} rg\n100 ${y} 220 120 re f\n0 0 0 rg\nBT\n/F1 14 Tf\n72 740 Td\n<${hex}> Tj\nET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    objects.push(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kidRefs.join(" ")}] /Count ${pages.length} >>`;
  return buildPdfFromObjects(objects);
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function registerTestRoutes(service: WorkbenchHost) {
  const routes: Array<{
    path: string;
    methods: string[];
    fetch(request: Request): Promise<Response>;
  }> = [];
  registerWorkbenchRoutes(
    {
      fetch: {
        register(route) {
          routes.push(route);
          return async () => {};
        },
      },
    },
    service,
  );
  return {
    actionRoute: routes.find((r) => r.path === "/api/seal/action")!,
    fileRoute: routes.find((r) => r.path === "/api/seal/file")!,
  };
}

test("M42 Slice 2 locale parity & pure workbench editor helpers", () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys);
  for (const key of zhKeys) {
    assert.ok(zh[key as keyof typeof zh].trim().length > 0, `zh.${key}`);
    assert.ok(en[key as keyof typeof en].trim().length > 0, `en.${key}`);
  }

  const outline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "sec-1",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "投标函",
        kind: "template",
        included: true,
        lockedTemplate: true,
      },
      {
        id: "sec-2",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "专项资质",
        kind: "attachment",
        included: true,
        materialMissing: true,
      },
      {
        id: "sec-3",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "技术方案",
        kind: "authored",
        included: false,
      },
    ],
  };

  assert.equal(canDeleteOutlineNode(outline, "sec-1"), false);
  assert.equal(canDeleteOutlineNode(outline, "sec-2"), true);
  assert.equal(canMoveOutlineNode(outline, "sec-1", "up"), false);
  assert.equal(canMoveOutlineNode(outline, "sec-1", "down"), true);
  assert.equal(canIndentOutlineNode(outline, "sec-1"), false);
  assert.equal(canIndentOutlineNode(outline, "sec-2"), true);
  assert.equal(canOutdentOutlineNode(outline, "sec-1"), false);

  const newId = createOutlineNodeId(new Set(["sec-1", "sec-2", "sec-3"]), "sec");
  assert.equal(newId, "sec-4");

  const bound = bindEvidenceToNode(outline, "sec-2", {
    source: "material",
    ref: "materials/outline/cert.png",
    label: "cert.png",
  });
  assert.equal(bound.nodes[1].materialMissing, false);
  assert.equal(bound.nodes[1].evidence?.length, 1);

  // Dedup on same source+ref
  const boundDup = bindEvidenceToNode(bound, "sec-2", {
    source: "material",
    ref: "materials/outline/cert.png",
    label: "cert-v2.png",
  });
  assert.equal(boundDup.nodes[1].evidence?.length, 1);
  assert.equal(boundDup.nodes[1].evidence?.[0].label, "cert-v2.png");

  const unbound = unbindEvidenceFromNode(
    boundDup,
    "sec-2",
    "material",
    "materials/outline/cert.png",
  );
  assert.equal(unbound.nodes[1].evidence?.length, 0);

  const view = buildOutlineView({
    outlineState: { kind: "value", outline: unbound },
    confirmationStatus: "unconfirmed",
    materials: [],
  });
  const counts = outlineFilterCounts(view.rows, "商务标");
  assert.equal(counts.all, 3);
  assert.equal(counts.missing_material, 1);
  assert.equal(counts.template, 1);
  assert.equal(counts.attachment, 1);
  assert.equal(counts.excluded, 1);
});

test("M42 Slice 2 WorkbenchHost create workflowMode, overview/review outlineSummary, outline_get/save guards & 409 conflict", async (t) => {
  const sandbox = await createSandbox(t, "m42-wb-host-");
  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);
  const { actionRoute } = registerTestRoutes(service);

  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(
    tenderPath,
    await buildDocx([p("一、投标函"), p("请填写________"), p("二、资质证明")].join("")),
  );

  // Invalid workflowMode rejected
  await assert.rejects(
    service.create({
      name: "非法模式",
      deadline: "2028-06-01",
      files: [tenderPath],
      workflowMode: "invalid_mode",
    }),
    /编制模式/,
  );

  // Default workflowMode is outline_first
  const pDefault = await service.create({
    name: "默认两阶段项目",
    deadline: "2028-06-01",
    files: [tenderPath],
  });
  assert.equal((pDefault.project as { workflowMode?: string }).workflowMode, "outline_first");

  // Explicit direct mode
  const pDirect = await service.create({
    name: "直接编制项目",
    deadline: "2028-06-01",
    files: [tenderPath],
    workflowMode: "direct",
  });
  assert.equal((pDirect.project as { workflowMode?: string }).workflowMode, "direct");

  // Non-project outline_get returns { kind: 'not_project' }
  const notProj = await service.outlineGet({ cwd: sandbox });
  assert.deepEqual(notProj, { kind: "not_project" });

  // overview() and review() include outlineSummary
  const ovBefore = await service.overview();
  const ovProj = ovBefore.projects.find((item) => item.id === pDefault.id) as {
    outlineSummary?: { kind: string; confirmationStatus: string };
  };
  assert.equal(ovProj.outlineSummary?.kind, "missing");
  assert.equal(ovProj.outlineSummary?.confirmationStatus, "missing");

  const revBefore = (await service.review({ projectId: pDefault.id })) as {
    kind: string;
    outlineSummary?: { kind: string; confirmationStatus: string };
  };
  assert.equal(revBefore.kind, "project");
  assert.equal(revBefore.outlineSummary?.kind, "missing");

  // outline_get initial state
  const getInitial = (await service.outlineGet({ projectId: pDefault.id })) as {
    projectKind: string;
    revision: string;
    outline: { kind: string };
    view: { kind: string };
  };
  assert.equal(getInitial.projectKind, "project");
  assert.equal(getInitial.outline.kind, "missing");
  assert.equal(getInitial.view.kind, "missing");

  const validVolumes = [{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:2" }] }];
  const validNodes: OutlineNode[] = [
    {
      id: "n-1",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "投标函",
      kind: "template",
      included: true,
      lockedTemplate: true,
      tenderSource: { file: "tender/1.docx", ranges: [{ from: "p:0", to: "p:1" }] },
    },
    {
      id: "n-2",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "资质证明",
      kind: "attachment",
      included: true,
      materialMissing: true,
    },
  ];

  // Reject client-supplied confirmation / privilege fields
  for (const forbidden of [
    { confirmed: true },
    { authorization: { sig: "0" } },
    { digest: "abc" },
    { signature: "xyz" },
    { __sealAdmin: true },
  ]) {
    await assert.rejects(
      service.outlineSave({
        projectId: pDefault.id,
        expectedRevision: getInitial.revision,
        volumes: validVolumes,
        nodes: validNodes,
        ...forbidden,
      }),
      /禁止传入/,
    );
  }

  // Reject tenderSource.file not belonging to registered project tenders
  await assert.rejects(
    service.outlineSave({
      projectId: pDefault.id,
      expectedRevision: getInitial.revision,
      volumes: validVolumes,
      nodes: [
        {
          ...validNodes[0],
          tenderSource: { file: "tender/999.docx", ranges: [{ from: "p:0", to: "p:0" }] },
        },
      ],
    }),
    /不属于项目登记招标副本/,
  );

  // 409 conflict over HTTP /api/seal/action
  const conflictRes = await actionRoute.fetch(
    new Request("http://owner/api/seal/action", {
      method: "POST",
      body: JSON.stringify({
        operation: "outline_save",
        projectId: pDefault.id,
        expectedRevision: "stale-rev",
        volumes: validVolumes,
        nodes: validNodes,
      }),
    }),
  );
  assert.equal(conflictRes.status, 409);

  // Valid outline_save writes updatedBy='human' and refreshes summary
  const saved = (await service.outlineSave({
    projectId: pDefault.id,
    expectedRevision: getInitial.revision,
    volumes: validVolumes,
    nodes: validNodes,
  })) as {
    revision: string;
    outline: { kind: string; outline: OutlineDocument };
    view: {
      confirmationStatus: string;
      summary: { totalNodes: number; missingMaterials: number };
    };
  };
  assert.equal(saved.outline.kind, "value");
  assert.equal(saved.outline.outline.updatedBy, "human");
  assert.equal(saved.view.confirmationStatus, "unconfirmed");
  assert.equal(saved.view.summary.totalNodes, 2);
  assert.equal(saved.view.summary.missingMaterials, 1);

  const ovAfter = await service.overview();
  const ovProjAfter = ovAfter.projects.find((item) => item.id === pDefault.id) as {
    outlineSummary?: {
      kind: string;
      confirmationStatus: string;
      totalNodes: number;
      missingMaterials: number;
    };
  };
  assert.equal(ovProjAfter.outlineSummary?.kind, "value");
  assert.equal(ovProjAfter.outlineSummary?.confirmationStatus, "unconfirmed");
  assert.equal(ovProjAfter.outlineSummary?.totalNodes, 2);
  assert.equal(ovProjAfter.outlineSummary?.missingMaterials, 1);
});

test("M42 Slice 2 outline_upload_material (PNG + multi-page PDF via PDFium WASM), /api/seal/file traversal guards, outline_confirm & C17 E2E", async (t) => {
  const sandbox = await createSandbox(t, "m42-wb-e2e-");
  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);
  const { actionRoute, fileRoute } = registerTestRoutes(service);

  const kbRoot = path.join(sandbox, "seal-home", "vaults");
  await fs.mkdir(kbRoot, { recursive: true });
  const kb = new KnowledgeBase(host, kbRoot);
  const vault = await kb.createVault({ name: "测试企业库", vaultId: "v-m42-s2" });
  const rec = await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: { type: "营业执照", title: "企业营业执照", number: "91110000123456789A" },
    body: "执照详情",
  });
  await kb.save(vault.vaultId, {
    action: "attach_file",
    kind: "record",
    id: rec.id,
    file: { fileName: "kb-license.png", bytes: PNG_1X1_RED },
  });
  await kb.verify(vault.vaultId, "record", rec.id);

  const tenderBytes = await buildDocx(
    [p("投标函正文"), p("承诺按要求响应：________"), p("附件章节标题")].join(""),
  );
  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, tenderBytes);

  // Create synthetic PNG and 2-page PDF outside project root
  const origPng = path.join(sandbox, "cert-image.png");
  await fs.writeFile(origPng, PNG_1X1_RED);
  const origPngHash = sha256(PNG_1X1_RED);

  const pdfBytes = buildMultiPagePdf(["第一页资质证明", "第二页年审盖章"]);
  const origPdf = path.join(sandbox, "multi-page-cert.pdf");
  await fs.writeFile(origPdf, pdfBytes);
  const origPdfHash = sha256(pdfBytes);

  const created = await service.create({
    name: "端到端大纲测试",
    deadline: "2028-06-01",
    vaultId: vault.vaultId,
    files: [tenderPath],
    workflowMode: "outline_first",
  });
  const root = created.root;

  let state = (await service.outlineGet({ projectId: created.id })) as {
    revision: string;
    kbRecords: Array<{ id: string }>;
  };
  assert.ok(state.kbRecords.some((r) => r.id === rec.id));

  const volumes = [
    { name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:2" }] },
  ];
  const nodes: OutlineNode[] = [
    {
      id: "n-letter",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "投标函正文",
      kind: "template",
      included: true,
      lockedTemplate: true,
    },
    {
      id: "n-png",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "单图资质附件",
      kind: "attachment",
      included: true,
      materialMissing: true,
    },
    {
      id: "n-pdf",
      volume: "商务标",
      parentId: null,
      level: 1,
      title: "多页PDF证明",
      kind: "attachment",
      included: true,
      materialMissing: true,
    },
  ];
  state = (await service.outlineSave({
    projectId: created.id,
    expectedRevision: state.revision,
    volumes,
    nodes,
  })) as typeof state;

  // Reject disallowed extensions, corrupt PNG, symlinks
  const badExt = path.join(sandbox, "script.sh");
  await fs.writeFile(badExt, "#!/bin/sh\necho bad");
  await assert.rejects(
    service.outlineUploadMaterial({
      projectId: created.id,
      expectedRevision: state.revision,
      filePath: badExt,
      nodeId: "n-png",
    }),
    /不支持的材料文件扩展名/,
  );

  const badPng = path.join(sandbox, "corrupt.png");
  await fs.writeFile(badPng, "not a png");
  await assert.rejects(
    service.outlineUploadMaterial({
      projectId: created.id,
      expectedRevision: state.revision,
      filePath: badPng,
      nodeId: "n-png",
    }),
    /材料上传失败/,
  );

  const symPath = path.join(sandbox, "sym.png");
  await fs.symlink(origPng, symPath);
  await assert.rejects(
    service.outlineUploadMaterial({
      projectId: created.id,
      expectedRevision: state.revision,
      filePath: symPath,
      nodeId: "n-png",
    }),
    /不支持符号链接/,
  );

  // Verify no orphan files remained in materials/outline after rejected uploads
  const beforeUploadMaterials = await fs
    .readdir(path.join(root, "materials", "outline"))
    .catch(() => []);
  assert.equal(beforeUploadMaterials.length, 0);

  // Upload valid PNG -> clears materialMissing on n-png
  const pngUploaded = (await service.outlineUploadMaterial({
    projectId: created.id,
    expectedRevision: state.revision,
    filePath: origPng,
    nodeId: "n-png",
  })) as {
    revision: string;
    binding: { source: string; ref: string; label?: string };
    outline: { kind: string; outline: OutlineDocument };
    materials: string[];
  };
  assert.equal(pngUploaded.binding.source, "material");
  assert.ok(pngUploaded.binding.ref.startsWith("materials/outline/"));
  assert.ok(pngUploaded.materials.includes(pngUploaded.binding.ref));
  const pngNode = pngUploaded.outline.outline.nodes.find((n) => n.id === "n-png")!;
  assert.equal(pngNode.materialMissing, false);
  assert.equal(pngNode.evidence?.length, 1);

  // Upload 2-page PDF -> PDFium WASM renders 2 PNGs into renderedPages & clears materialMissing on n-pdf
  const pdfUploaded = (await service.outlineUploadMaterial({
    projectId: created.id,
    expectedRevision: pngUploaded.revision,
    filePath: origPdf,
    nodeId: "n-pdf",
  })) as {
    revision: string;
    binding: { source: string; ref: string; renderedPages?: string[] };
    outline: { kind: string; outline: OutlineDocument };
    materials: string[];
  };
  assert.equal(pdfUploaded.binding.renderedPages?.length, 2);
  for (const pageRef of pdfUploaded.binding.renderedPages!) {
    assert.ok(pageRef.startsWith("materials/outline/"));
    assert.ok(pdfUploaded.materials.includes(pageRef));
  }
  const pdfNode = pdfUploaded.outline.outline.nodes.find((n) => n.id === "n-pdf")!;
  assert.equal(pdfNode.materialMissing, false);

  // Originals 100% untouched
  assert.equal(sha256(await fs.readFile(origPng)), origPngHash);
  assert.equal(sha256(await fs.readFile(origPdf)), origPdfHash);
  assert.equal(sha256(await fs.readFile(tenderPath)), sha256(tenderBytes));

  // /api/seal/file?material=... serves valid files and blocks traversal / symlinks
  const pdfServe = await fileRoute.fetch(
    new Request(
      `http://owner/api/seal/file?${new URLSearchParams({ projectId: created.id, material: pdfUploaded.binding.ref })}`,
    ),
  );
  assert.equal(pdfServe.status, 200);
  assert.equal(pdfServe.headers.get("content-type"), "application/pdf");

  const page1Serve = await fileRoute.fetch(
    new Request(
      `http://owner/api/seal/file?${new URLSearchParams({ projectId: created.id, material: pdfUploaded.binding.renderedPages![0] })}`,
    ),
  );
  assert.equal(page1Serve.status, 200);
  assert.equal(page1Serve.headers.get("content-type"), "image/png");

  for (const badMaterial of [
    "../seal-project.json",
    "materials/../seal-project.json",
    "tender/1.docx",
    "materials\\evil.png",
  ]) {
    const blocked = await fileRoute.fetch(
      new Request(
        `http://owner/api/seal/file?${new URLSearchParams({ projectId: created.id, material: badMaterial })}`,
      ),
    );
    assert.equal(blocked.status, 400, badMaterial);
  }

  // Symlink planted inside materials/ must be rejected by /api/seal/file
  const plantedSymlink = path.join(root, "materials", "leak.txt");
  await fs.symlink(path.join(root, "seal-project.json"), plantedSymlink);
  const symServe = await fileRoute.fetch(
    new Request(
      `http://owner/api/seal/file?${new URLSearchParams({ projectId: created.id, material: "materials/leak.txt" })}`,
    ),
  );
  assert.equal(symServe.status, 400);
  await fs.unlink(plantedSymlink);

  // outline_confirm rejects forged digest/signature/confirmed
  for (const forged of [
    { digest: "abc" },
    { signature: "0".repeat(64) },
    { authorization: { signature: "0".repeat(64) } },
    { confirmed: true },
  ]) {
    const res = await actionRoute.fetch(
      new Request("http://owner/api/seal/action", {
        method: "POST",
        body: JSON.stringify({
          operation: "outline_confirm",
          projectId: created.id,
          expectedRevision: pdfUploaded.revision,
          ...forged,
        }),
      }),
    );
    assert.equal(res.status, 400);
  }

  // Confirm outline via /api/seal/action
  const confirmRes = await actionRoute.fetch(
    new Request("http://owner/api/seal/action", {
      method: "POST",
      body: JSON.stringify({
        operation: "outline_confirm",
        projectId: created.id,
        expectedRevision: pdfUploaded.revision,
      }),
    }),
  );
  assert.equal(confirmRes.status, 200);
  const confirmJson = (await confirmRes.json()) as {
    confirmed: boolean;
    digest: string;
    confirmedAt: string;
    prompt: string;
  };
  assert.equal(confirmJson.confirmed, true);
  assert.ok(confirmJson.digest.length === 64);
  assert.match(confirmJson.prompt, /seal_outline\(action="get"\)/);

  // Verify ledger.json + external anchor contain valid outlineConfirmation
  const ledgerDisk = JSON.parse(
    await fs.readFile(path.join(root, "ledger.json"), "utf8"),
  ) as BidLedger;
  assert.equal(ledgerDisk.outlineConfirmation?.digest, confirmJson.digest);
  const anchorDisk = JSON.parse(
    await fs.readFile(await host.ledgerAnchorPath(root, false), "utf8"),
  );
  assert.deepEqual(anchorDisk, ledgerDisk.integrity);

  const afterConfirm = (await service.outlineGet({
    projectId: created.id,
  })) as {
    revision: string;
    outline: { kind: string; outline: OutlineDocument };
    view: { confirmationStatus: string };
  };
  assert.equal(afterConfirm.view.confirmationStatus, "confirmed");

  // Stage 2: Extract 商务标 and mount PNG + ONLY page 1 of 2-page PDF -> C17 MUST block!
  await runProject(host, [
    "extract",
    "--project",
    root,
    "--tender",
    "tender/1.docx",
    "--draft",
    "商务标",
    "--ranges",
    JSON.stringify([{ from: "p:0", to: "p:2" }]),
  ]);

  await runProject(host, [
    "edit",
    "--project",
    root,
    "--draft",
    "商务标",
    "--ops",
    JSON.stringify([
      { op: "replace", at: "p:1", blank: 0, value: "已响应" },
      {
        op: "insert",
        at: "p:2",
        position: "after",
        markdown: `### 单图资质附件\n\n![png](${pngUploaded.binding.ref})\n\n### 多页PDF证明\n\n![page1](${pdfUploaded.binding.renderedPages![0]})`,
      },
    ]),
  ]);

  const partialCheck = (await runProject(host, ["check", "--project", root])) as {
    ready: boolean;
    blockingCounts: Record<string, number>;
    volumes: Array<{ results: { C17: Array<{ kind: string; nodeId?: string }> } }>;
  };
  assert.equal(partialCheck.ready, false);
  assert.ok(partialCheck.blockingCounts.C17 > 0);
  assert.ok(
    partialCheck.volumes[0].results.C17.some(
      (issue) => issue.nodeId === "n-pdf" && issue.kind === "missing_evidence",
    ),
  );

  // Mount page 2 + accept C06 modification -> C17=0 and ready === true!
  const blocks = (await runProject(host, [
    "read",
    "--project",
    root,
    "--file",
    "商务标",
    "--mode",
    "blocks",
  ])) as { items: Array<{ address: string | null }> };
  const lastAddr = blocks.items.filter((i) => i.address).at(-1)!.address!;

  await runProject(host, [
    "edit",
    "--project",
    root,
    "--draft",
    "商务标",
    "--ops",
    JSON.stringify([
      {
        op: "insert_image",
        at: lastAddr,
        image: pdfUploaded.binding.renderedPages![1],
      },
    ]),
  ]);

  const draftBytes = await fs.readFile(path.join(root, "draft", "商务标.docx"));
  const baseBytes = await fs.readFile(path.join(root, "draft", "商务标.base.docx"));
  const diffs = await compareDocuments(baseBytes, draftBytes);
  const secret = (await host.authorizationKey(false))!;
  const ledgerNow = JSON.parse(
    await fs.readFile(path.join(root, "ledger.json"), "utf8"),
  ) as BidLedger;
  for (const diff of diffs) {
    if (["modified", "deleted", "formatChanged", "objectLost"].includes(diff.kind)) {
      await acceptChange(
        ledgerNow,
        "商务标",
        diff,
        { root, vaultId: vault.vaultId, deadline: "2028-06-01" },
        secret,
      );
    }
  }
  await sealLedger(ledgerNow, root, secret);
  await fs.writeFile(path.join(root, "ledger.json"), JSON.stringify(ledgerNow, null, 2));
  await fs.writeFile(
    await host.ledgerAnchorPath(root, false),
    JSON.stringify(ledgerNow.integrity),
  );

  const fullCheck = (await runProject(host, ["check", "--project", root])) as {
    ready: boolean;
    blockingCounts: Record<string, number>;
  };
  assert.equal(fullCheck.blockingCounts.C17, 0);
  assert.equal(fullCheck.ready, true, `blockingCounts=${JSON.stringify(fullCheck.blockingCounts)}`);

  // Modifying outline after confirmation invalidates confirmation to 'stale'
  const beforeModify = (await service.outlineGet({
    projectId: created.id,
  })) as { revision: string; outline: { outline: OutlineDocument } };
  const moved = moveOutlineNode(beforeModify.outline.outline, "n-png", "down");
  const added = addOutlineNode(moved, {
    id: "n-extra",
    volume: "商务标",
    parentId: null,
    level: 1,
    title: "补充承诺",
    kind: "authored",
    included: true,
  });
  const afterModify = (await service.outlineSave({
    projectId: created.id,
    expectedRevision: beforeModify.revision,
    volumes: added.volumes,
    nodes: added.nodes,
  })) as { view: { confirmationStatus: string } };
  assert.equal(afterModify.view.confirmationStatus, "stale");
});

test("M42 regression: WorkbenchHost.outlineSave enforces lockedTemplate, outline_upload_material blocks symlinked dirs & truncated PDFs, and client saveDraftOutline guards concurrent edits", async (t) => {
  assert.equal(OUTLINE_PDF_MAX_PAGES, 200);
  const sandbox = await createSandbox(t, "m42-wb-reg-");
  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);

  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, await buildDocx(p("投标函")));
  const created = await service.create({
    name: "工作台加固回归",
    deadline: "2028-06-01",
    files: [tenderPath],
    workflowMode: "outline_first",
  });
  const root = created.root;

  let state = (await service.outlineGet({ projectId: created.id })) as {
    revision: string;
  };
  const volumes = [
    { name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:0" }] },
    { name: "技术标" },
  ];
  const lockedNode: OutlineNode = {
    id: "n-lock",
    volume: "商务标",
    parentId: null,
    level: 1,
    title: "投标函",
    kind: "template",
    included: true,
    lockedTemplate: true,
  };
  const authoredNode: OutlineNode = {
    id: "n-auth",
    volume: "商务标",
    parentId: null,
    level: 1,
    title: "补充说明",
    kind: "authored",
    included: true,
    materialMissing: true,
  };
  state = (await service.outlineSave({
    projectId: created.id,
    expectedRevision: state.revision,
    volumes,
    nodes: [lockedNode, authoredNode],
  })) as typeof state;

  // 1. outlineSave rejects all lockedTemplate bypass attempts
  const { lockedTemplate: _omitted, ...withoutLock } = lockedNode;
  for (const badNodeList of [
    [withoutLock, authoredNode],
    [{ ...lockedNode, optional: true }, authoredNode],
    [{ ...lockedNode, included: false }, authoredNode],
    [{ ...lockedNode, title: "篡改标题" }, authoredNode],
    [{ ...lockedNode, volume: "技术标" }, authoredNode],
    [{ ...lockedNode, kind: "authored" }, authoredNode],
    [authoredNode],
  ]) {
    await assert.rejects(
      service.outlineSave({
        projectId: created.id,
        expectedRevision: state.revision,
        volumes,
        nodes: badNodeList,
      }),
      /锁定|可选/,
    );
  }

  // Allowed update (note) on locked node succeeds
  state = (await service.outlineSave({
    projectId: created.id,
    expectedRevision: state.revision,
    volumes,
    nodes: [{ ...lockedNode, note: "加盖公章" }, authoredNode],
  })) as typeof state;

  // 2. outline_upload_material rejects symlinked materials/outline directory and writes 0 bytes outside
  const outsideDir = path.join(sandbox, "outside-target");
  await fs.mkdir(outsideDir, { recursive: true });
  const origPng = path.join(sandbox, "upload.png");
  await fs.writeFile(origPng, PNG_1X1_RED);

  const materialsDir = path.join(root, "materials");
  const outlineDir = path.join(materialsDir, "outline");
  await fs.mkdir(materialsDir, { recursive: true });
  await fs.symlink(outsideDir, outlineDir);
  await assert.rejects(
    service.outlineUploadMaterial({
      projectId: created.id,
      expectedRevision: state.revision,
      filePath: origPng,
      nodeId: "n-auth",
    }),
    /符号链接/,
  );
  assert.deepEqual(await fs.readdir(outsideDir), []);
  await fs.unlink(outlineDir);

  // Also reject symlinked materials/ itself
  await fs.rm(materialsDir, { recursive: true, force: true });
  await fs.symlink(outsideDir, materialsDir);
  await assert.rejects(
    service.outlineUploadMaterial({
      projectId: created.id,
      expectedRevision: state.revision,
      filePath: origPng,
      nodeId: "n-auth",
    }),
    /符号链接/,
  );
  assert.deepEqual(await fs.readdir(outsideDir), []);
  await fs.unlink(materialsDir);
  await fs.mkdir(materialsDir, { recursive: true });

  // 3. outline_upload_material fails closed on truncated PDF (> maxPages) & cleans up copied PDF + pagesDir
  const prevMaxPages = process.env.SEAL_OUTLINE_PDF_MAX_PAGES;
  process.env.SEAL_OUTLINE_PDF_MAX_PAGES = "2";
  t.after(() => {
    if (prevMaxPages === undefined) delete process.env.SEAL_OUTLINE_PDF_MAX_PAGES;
    else process.env.SEAL_OUTLINE_PDF_MAX_PAGES = prevMaxPages;
  });

  const threePagePdf = buildMultiPagePdf(["第一页", "第二页", "第三页"]);
  const threePagePdfPath = path.join(sandbox, "three-pages.pdf");
  await fs.writeFile(threePagePdfPath, threePagePdf);

  await assert.rejects(
    service.outlineUploadMaterial({
      projectId: created.id,
      expectedRevision: state.revision,
      filePath: threePagePdfPath,
      nodeId: "n-auth",
    }),
    /超过单次上传上限|截断/,
  );
  const leftover = await fs.readdir(path.join(root, "materials", "outline")).catch(() => []);
  assert.deepEqual(leftover, [], "Failed PDF upload must clean up copied PDF and -pages dir");

  // 4. Real wired async flow verification: pause in-flight save AND in-flight confirm, inject concurrent edits
  const { reconcileOutlineSaveResult, runOutlineConfirmFlow } = await import(
    "../src/workbench/outline.js"
  );
  const { updateOutlineNode } = await import("../src/core/bid/outline.js");
  const fullState = await service.outlineGet({ projectId: created.id });
  assert.equal("projectKind" in fullState && fullState.projectKind === "project", true);
  if (!("projectKind" in fullState) || fullState.outline.kind !== "value") {
    throw new Error("Expected loaded outline value");
  }
  const outlineStateA = fullState.outline;
  const outlineA = outlineStateA.outline;
  const outlineB = updateOutlineNode(outlineA, "n-auth", { note: "保存期间用户新输入的批注B" });
  const outlineC = updateOutlineNode(outlineA, "n-auth", { note: "确认请求在途期间新输入的批注C" });

  // Case A: concurrent edit during in-flight save preserves B + Undo stack AND aborts confirm before calling outline_confirm or sendPrompt
  let localEditSeq = 1;
  let editorState: import("../src/workbench/outline.js").OutlineEditorSaveState = {
    serverRevision: fullState.revision,
    baselineOutline: outlineA,
    draftOutline: outlineA,
    undoStack: [],
    redoStack: [],
    conflictError: "",
    confirmMissing: true,
  };
  let resolveSaveA!: (value: { revision: string; outline: typeof outlineStateA }) => void;
  let confirmCalls = 0;
  let sendCalls = 0;
  let clearDirtyCalls = 0;

  const confirmPromiseA = runOutlineConfirmFlow({
    getEditSeq: () => localEditSeq,
    isDirty: true,
    initialRevision: editorState.serverRevision,
    saveDraft: async () => {
      const sentSeq = localEditSeq;
      const saved = await new Promise<{ revision: string; outline: typeof outlineStateA }>((resolve) => {
        resolveSaveA = resolve;
      });
      const reconciled = reconcileOutlineSaveResult(editorState, saved, sentSeq, localEditSeq);
      editorState = reconciled.state;
      return saved;
    },
    confirmOutline: async () => {
      confirmCalls++;
      return { confirmed: true, digest: "d", confirmedAt: "now", prompt: "run phase 2" };
    },
    onConfirmFinished: () => {},
    onClearDirty: () => {
      clearDirtyCalls++;
    },
    onReloadOverview: () => {},
    sessionId: "sess-1",
    sendPrompt: async () => {
      sendCalls++;
    },
    openReview: async () => {},
    onReloadUnbound: () => {},
  });

  // User edits locally to B while save A is suspended
  localEditSeq += 1;
  editorState = { ...editorState, draftOutline: outlineB, undoStack: [outlineA] };
  resolveSaveA({ revision: "rev-after-save-A", outline: outlineStateA });

  await assert.rejects(confirmPromiseA, /保存期间大纲有新修改/);
  assert.equal(confirmCalls, 0, "Must NOT call outline_confirm when local edit happened during save");
  assert.equal(sendCalls, 0, "Must NOT send Phase 2 prompt");
  assert.equal(clearDirtyCalls, 0, "Must NOT clear dirty flag");
  assert.equal(editorState.serverRevision, "rev-after-save-A");
  assert.deepEqual(editorState.draftOutline, outlineB, "Concurrent edit B must be preserved");
  assert.equal(editorState.undoStack.length, 1, "Undo stack must stay intact");

  // Case B: concurrent edit during in-flight outline_confirm aborts sendPrompt, openReview & clearDirty!
  let resolveConfirmB!: (value: { confirmed: boolean; digest: string; confirmedAt: string; prompt: string }) => void;
  let openReviewCalls = 0;
  let reloadUnboundCalls = 0;
  confirmCalls = 0;
  sendCalls = 0;
  clearDirtyCalls = 0;

  const confirmPromiseB = runOutlineConfirmFlow({
    getEditSeq: () => localEditSeq,
    isDirty: false,
    initialRevision: "rev-after-save-A",
    saveDraft: async () => ({ revision: "rev-after-save-A" }),
    confirmOutline: async () => {
      confirmCalls++;
      return new Promise((resolve) => {
        resolveConfirmB = resolve;
      });
    },
    onConfirmFinished: () => {},
    onClearDirty: () => {
      clearDirtyCalls++;
    },
    onReloadOverview: () => {},
    sessionId: "sess-1",
    sendPrompt: async () => {
      sendCalls++;
    },
    openReview: async () => {
      openReviewCalls++;
    },
    onReloadUnbound: () => {
      reloadUnboundCalls++;
    },
  });

  // User edits locally to C while outline_confirm is in-flight
  localEditSeq += 1;
  editorState = { ...editorState, draftOutline: outlineC };
  resolveConfirmB({ confirmed: true, digest: "d-old", confirmedAt: "now", prompt: "stale prompt" });

  await assert.rejects(confirmPromiseB, /确认期间大纲有新修改/);
  assert.equal(confirmCalls, 1);
  assert.equal(sendCalls, 0, "Must NOT send stale Phase 2 prompt when edited during in-flight confirm");
  assert.equal(openReviewCalls, 0, "Must NOT navigate away when edited during in-flight confirm");
  assert.equal(clearDirtyCalls, 0, "Must NOT clear dirty flag");
  assert.equal(reloadUnboundCalls, 0, "Must NOT overwrite local edit via reload");

  // Case C: clean save + confirm with no concurrent edits succeeds end-to-end
  confirmCalls = 0;
  sendCalls = 0;
  openReviewCalls = 0;
  clearDirtyCalls = 0;
  let sentPromptText = "";
  const cleanResult = await runOutlineConfirmFlow({
    getEditSeq: () => localEditSeq,
    isDirty: true,
    initialRevision: "rev-after-save-A",
    saveDraft: async () => {
      const sentSeq = localEditSeq;
      const saved = { revision: "rev-clean", outline: outlineStateA };
      editorState = reconcileOutlineSaveResult(editorState, saved, sentSeq, localEditSeq).state;
      return saved;
    },
    confirmOutline: async (rev) => {
      assert.equal(rev, "rev-clean");
      confirmCalls++;
      return { confirmed: true, digest: "d-clean", confirmedAt: "now", prompt: "phase2-go" };
    },
    onConfirmFinished: () => {},
    onClearDirty: () => {
      clearDirtyCalls++;
    },
    onReloadOverview: () => {},
    sessionId: "sess-1",
    sendPrompt: async (_sid, prompt) => {
      sendCalls++;
      sentPromptText = prompt;
    },
    openReview: async () => {
      openReviewCalls++;
    },
    onReloadUnbound: () => {},
  });
  assert.equal(cleanResult.confirmed, true);
  assert.equal(confirmCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(openReviewCalls, 1);
  assert.equal(clearDirtyCalls, 1);
  assert.equal(sentPromptText, "phase2-go");
  assert.deepEqual(editorState.undoStack, []);
});

test("WorkbenchHost.projectStamp tracks outline/requirements/draft changes lock-free for right-pane auto-refresh", async (t) => {
  const sandbox = await createSandbox(t, "m42-stamp-");
  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);
  const { actionRoute } = registerTestRoutes(service);

  const nonProject = await service.projectStamp({ cwd: sandbox });
  assert.equal(nonProject.kind, "not_project");

  const tenderBytes = await buildDocx([p("第一章 投标函"), p("请填写报价：________")].join(""));
  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, tenderBytes);

  const created = await service.create({
    name: "自动刷新测试项目",
    deadline: "2028-06-01",
    files: [tenderPath],
    workflowMode: "outline_first",
  });

  const rev1 = (await service.review({ cwd: created.root })) as {
    kind: string;
    projectStamp?: string;
    outlineSummary?: { kind: string };
  };
  assert.equal(rev1.kind, "project");
  assert.equal(rev1.outlineSummary?.kind, "missing");
  assert.ok(typeof rev1.projectStamp === "string" && rev1.projectStamp.length === 64);

  const stampRes1 = await actionRoute.fetch(
    new Request("http://local/api/seal/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "project_stamp", cwd: created.root }),
    }),
  );
  assert.equal(stampRes1.status, 200);
  const stampBody1 = (await stampRes1.json()) as { kind: string; stamp: string };
  assert.equal(stampBody1.kind, "project");
  assert.equal(stampBody1.stamp, rev1.projectStamp);

  // Simulate Agent saving outline.json directly via project CLI/tool.
  await runProject(host, [
    "outline",
    "--project",
    created.root,
    "--action",
    "save",
    "--volumes",
    JSON.stringify([{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:1" }] }]),
    "--nodes",
    JSON.stringify([
      {
        id: "n-1",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "投标函",
        kind: "template",
        included: true,
      },
    ]),
  ]);

  const stamp2 = (await service.projectStamp({ cwd: created.root })) as {
    kind: string;
    stamp: string;
  };
  assert.equal(stamp2.kind, "project");
  assert.notEqual(stamp2.stamp, stampBody1.stamp);

  const rev2 = (await service.review({ cwd: created.root })) as {
    kind: string;
    projectStamp?: string;
    outlineSummary?: { kind: string; totalNodes: number };
  };
  assert.equal(rev2.projectStamp, stamp2.stamp);
  assert.equal(rev2.outlineSummary?.kind, "value");
  assert.equal(rev2.outlineSummary?.totalNodes, 1);

  const out2 = (await service.outlineGet({ projectId: created.id })) as {
    projectKind: string;
    projectStamp?: string;
  };
  assert.equal(out2.projectKind, "project");
  assert.equal(out2.projectStamp, stamp2.stamp);
});

test("Outline editor KB loop: kbFiles/metadata exposure, outline_verify_kb, upload saveToKb (PNG + PDF), and promote_material_to_kb", async (t) => {
  const sandbox = await createSandbox(t, "m42-kb-loop-");
  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);

  const kbRoot = path.join(sandbox, "seal-home", "vaults");
  await fs.mkdir(kbRoot, { recursive: true });
  const kb = new KnowledgeBase(host, kbRoot);
  const vault = await kb.createVault({ name: "闭环测试企业库", vaultId: "v-kb-loop" });
  await kb.save(vault.vaultId, {
    action: "update",
    kind: "subject",
    fields: { legalName: "合成测试企业有限公司" },
  });
  // Create an UNVERIFIED KB record with an attached PNG
  const unverifiedRec = await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: {
      type: "营业执照",
      title: "营业执照副本",
      holder: "合成测试企业有限公司",
      validUntil: "长期",
      number: "91110000123456789A",
    },
    body: "",
  });
  await kb.save(vault.vaultId, {
    action: "attach_file",
    kind: "record",
    id: unverifiedRec.id,
    file: { fileName: "license.png", bytes: PNG_1X1_RED },
  });

  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(
    tenderPath,
    await buildDocx([p("一、企业证照"), p("二、补充资质"), p("三、专项材料")].join("")),
  );
  const created = await service.create({
    name: "知识库双向同步测试",
    deadline: "2028-06-01",
    vaultId: vault.vaultId,
    files: [tenderPath],
    workflowMode: "outline_first",
  });

  // Save outline with 3 nodes: one bound to unverified KB record, two missing materials
  let state = (await service.outlineGet({ projectId: created.id })) as any;
  state = await service.outlineSave({
    projectId: created.id,
    expectedRevision: state.revision,
    volumes: [{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:2" }] }],
    nodes: [
      {
        id: "n-kb",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "企业营业执照",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: unverifiedRec.id, label: "营业执照副本" }],
      },
      {
        id: "n-upload-pdf",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "新补资质PDF",
        kind: "attachment",
        included: true,
        materialMissing: true,
      },
      {
        id: "n-promote-png",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "先本地后入库图片",
        kind: "attachment",
        included: true,
        materialMissing: true,
      },
    ],
  });

  // 1. Verify kbFiles & metadata are exposed on resolvedEvidence and kbRecords
  const kbRow = state.view.rows.find((r: any) => r.id === "n-kb");
  assert.equal(kbRow.resolvedMaterialStatus, "needs_review");
  assert.equal(kbRow.resolvedEvidence[0].status, "unverified");
  assert.equal(kbRow.resolvedEvidence[0].kbVerified, false);
  assert.equal(kbRow.resolvedEvidence[0].kbHolder, "合成测试企业有限公司");
  assert.equal(kbRow.resolvedEvidence[0].kbValidUntil, "长期");
  assert.equal(kbRow.resolvedEvidence[0].kbFiles.length, 1);
  assert.ok(typeof kbRow.resolvedEvidence[0].kbRevision === "string");

  // Reject stale revision on outlineVerifyKb
  await assert.rejects(
    service.outlineVerifyKb({
      projectId: created.id,
      kbId: unverifiedRec.id,
      expectedKbRevision: "stale-rev",
    }),
    /版本冲突/,
  );

  // Verify in-place & sync back to KB
  state = await service.outlineVerifyKb({
    projectId: created.id,
    kbId: unverifiedRec.id,
    expectedKbRevision: kbRow.resolvedEvidence[0].kbRevision,
  });
  const kbRowAfter = state.view.rows.find((r: any) => r.id === "n-kb");
  assert.equal(kbRowAfter.resolvedMaterialStatus, "ready");
  assert.equal(kbRowAfter.resolvedEvidence[0].status, "ready");
  assert.equal(kbRowAfter.resolvedEvidence[0].kbVerified, true);
  const verifiedDiskEntry = await kb.get(vault.vaultId, "record", unverifiedRec.id);
  assert.equal(verifiedDiskEntry.verified, true);

  // 2. Upload multi-page PDF with saveToKb: true -> creates verified KB record with rendered PNG pages + PDF
  const pdfFile = path.join(sandbox, "new-cert.pdf");
  const pdfBytes = buildMultiPagePdf(["资质首页", "资质附页"]);
  await fs.writeFile(pdfFile, pdfBytes);
  const uploadedPdf = (await service.outlineUploadMaterial({
    projectId: created.id,
    expectedRevision: state.revision,
    filePath: pdfFile,
    nodeId: "n-upload-pdf",
    saveToKb: true,
    kbTitle: "特种设备许可PDF",
    kbType: "资质证书",
    kbValidUntil: "2030-01-01",
  })) as any;
  assert.ok(typeof uploadedPdf.syncedKbId === "string");
  assert.equal(uploadedPdf.binding.source, "kb");
  assert.equal(uploadedPdf.binding.ref, uploadedPdf.syncedKbId);
  const syncedPdfEntry = await kb.get(vault.vaultId, "record", uploadedPdf.syncedKbId);
  assert.equal(syncedPdfEntry.verified, true);
  assert.equal(syncedPdfEntry.fields.holder, "合成测试企业有限公司");
  assert.equal(syncedPdfEntry.fields.validUntil, "2030-01-01");
  const syncedPdfFiles = syncedPdfEntry.fields.files as string[];
  assert.equal(syncedPdfFiles.length, 3); // 2 rendered PNG pages + 1 original PDF
  assert.ok(syncedPdfFiles[0].endsWith("-p1.png"));
  assert.ok(syncedPdfFiles[1].endsWith("-p2.png"));
  assert.ok(syncedPdfFiles[2].endsWith(".pdf"));
  const pdfNodeRow = uploadedPdf.view.rows.find((r: any) => r.id === "n-upload-pdf");
  assert.equal(pdfNodeRow.resolvedMaterialStatus, "ready");
  assert.equal(pdfNodeRow.resolvedEvidence[0].kbFiles.length, 3);
  state = uploadedPdf;

  // 3. Upload local PNG without saveToKb, then promote it to KB via outlinePromoteMaterialToKb
  const pngFile = path.join(sandbox, "local-scan.png");
  await fs.writeFile(pngFile, PNG_1X1_RED);
  const uploadedLocal = (await service.outlineUploadMaterial({
    projectId: created.id,
    expectedRevision: state.revision,
    filePath: pngFile,
    nodeId: "n-promote-png",
    saveToKb: false,
  })) as any;
  assert.equal(uploadedLocal.binding.source, "material");
  const localRef = uploadedLocal.binding.ref;

  const promoted = (await service.outlinePromoteMaterialToKb({
    projectId: created.id,
    expectedRevision: uploadedLocal.revision,
    nodeId: "n-promote-png",
    materialRef: localRef,
    kbTitle: "推广入库扫描件",
    kbType: "认证证书",
    kbValidUntil: "长期",
  })) as any;
  assert.ok(typeof promoted.syncedKbId === "string");
  const promotedEntry = await kb.get(vault.vaultId, "record", promoted.syncedKbId);
  assert.equal(promotedEntry.verified, true);
  assert.equal(promotedEntry.fields.title, "推广入库扫描件");
  assert.equal((promotedEntry.fields.files as string[]).length, 1);
  const promotedRow = promoted.view.rows.find((r: any) => r.id === "n-promote-png");
  assert.equal(promotedRow.resolvedMaterialStatus, "ready");
  assert.equal(promotedRow.resolvedEvidence.length, 1);
  assert.equal(promotedRow.resolvedEvidence[0].source, "kb");
  assert.equal(promotedRow.resolvedEvidence[0].ref, promoted.syncedKbId);

  // 4. KB writing material (kind="material") resolves as ready with kbFiles & kbKind="material" (not missing!),
  //    and subject-mismatch record maps to needs_review (invalid) rather than missing.
  const kbMat = await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: { type: "通用素材", title: "法定代表人身份证扫描件" },
    body: "正反面扫描件",
  });
  await kb.save(vault.vaultId, {
    action: "attach_file",
    kind: "material",
    id: kbMat.id,
    file: { fileName: "idcard.png", bytes: PNG_1X1_RED },
  });
  const oemRec = await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: { type: "认证证书", title: "外购防爆部件合格证", holder: "外部配件厂有限公司", validUntil: "长期" },
    body: "",
  });

  const withMatState = (await service.outlineSave({
    projectId: created.id,
    expectedRevision: promoted.revision,
    volumes: [{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:2" }] }],
    nodes: [
      {
        id: "n-kb-mat",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "法定代表人身份证复印件",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: kbMat.id, label: "法定代表人身份证扫描件" }],
      },
      {
        id: "n-oem-mismatch",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "部件防爆合格证",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: oemRec.id, label: "外购防爆部件合格证" }],
      },
    ],
  })) as any;

  const matRow = withMatState.view.rows.find((r: any) => r.id === "n-kb-mat");
  assert.equal(matRow.resolvedMaterialStatus, "ready");
  assert.equal(matRow.resolvedEvidence[0].status, "ready");
  assert.equal(matRow.resolvedEvidence[0].kbKind, "material");
  assert.equal(matRow.resolvedEvidence[0].kbFiles.length, 1);

  const oemRow = withMatState.view.rows.find((r: any) => r.id === "n-oem-mismatch");
  assert.equal(oemRow.resolvedMaterialStatus, "needs_review");
  assert.equal(oemRow.resolvedEvidence[0].status, "invalid");
  assert.equal(oemRow.resolvedEvidence[0].kbSubject, "mismatch");
});

test("GPT audit regressions: KB material & WebP Phase-2 edit/C05/C17 E2E, omitted validUntil stays unknown, writeOutlineFile rollback, KB-only projectStamp, and reconcileOutlineServerPayload", async (t) => {
  const sandbox = await createSandbox(t, "m42-gpt-audit-");
  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);

  const kbRoot = path.join(sandbox, "seal-home", "vaults");
  await fs.mkdir(kbRoot, { recursive: true });
  const kb = new KnowledgeBase(host, kbRoot);
  const vault = await kb.createVault({ name: "审计闭环库", vaultId: "v-gpt-audit" });
  await kb.save(vault.vaultId, {
    action: "update",
    kind: "subject",
    fields: { legalName: "合成测试企业有限公司" },
  });

  // KB material with attached PNG
  const kbMat = await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: { type: "通用素材", title: "通用架构图素材" },
    body: "说明文字",
  });
  const kbMatAttached = await kb.save(vault.vaultId, {
    action: "attach_file",
    kind: "material",
    id: kbMat.id,
    file: { fileName: "diagram.png", bytes: PNG_1X1_RED },
  });
  const kbMatFile = (kbMatAttached.fields.files as string[])[0];
  const kbProseMat = await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: { type: "方案素材", title: "通用供货运输方案" },
    body: "用于自拟章节写作参考的纯文本素材。",
  });

  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(
    tenderPath,
    await buildDocx([p("一、技术架构图"), p("二、WebP资质图"), p("三、缺效期测试")].join("")),
  );
  const created = await service.create({
    name: "审计全链路回归",
    deadline: "2028-06-01",
    vaultId: vault.vaultId,
    files: [tenderPath],
    workflowMode: "outline_first",
  });

  // 1. projectStamp detects KB-only mutation without touching any file in projectRoot
  const stampBeforeKb = (await service.projectStamp({ projectId: created.id })) as { stamp: string };
  await kb.save(vault.vaultId, {
    action: "create",
    kind: "record",
    fields: { type: "其他", title: "独立知识库变更" },
    body: "",
  });
  const stampAfterKb = (await service.projectStamp({ projectId: created.id })) as { stamp: string };
  assert.notEqual(stampAfterKb.stamp, stampBeforeKb.stamp);

  // Initialize outline
  let state = (await service.outlineGet({ projectId: created.id })) as any;
  state = await service.outlineSave({
    projectId: created.id,
    expectedRevision: state.revision,
    volumes: [{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:2" }] }],
    nodes: [
      {
        id: "n-mat",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、技术架构图",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: kbMat.id, label: "通用架构图素材" }],
      },
      {
        id: "n-webp",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "二、WebP资质图",
        kind: "attachment",
        included: true,
        materialMissing: true,
      },
      {
        id: "n-unknown-exp",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "三、缺效期测试",
        kind: "attachment",
        included: true,
        materialMissing: true,
      },
    ],
  });

  // 2. Upload WebP with saveToKb=true and explicit validUntil='长期'
  const webpBytes = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 20, g: 140, b: 220, alpha: 1 } },
  }).webp().toBuffer();
  const webpFile = path.join(sandbox, "cert.webp");
  await fs.writeFile(webpFile, webpBytes);
  const uploadedWebp = (await service.outlineUploadMaterial({
    projectId: created.id,
    expectedRevision: state.revision,
    filePath: webpFile,
    nodeId: "n-webp",
    saveToKb: true,
    kbTitle: "WebP证书",
    kbType: "其他",
    kbValidUntil: "长期",
  })) as any;
  const webpRec = await kb.get(vault.vaultId, "record", uploadedWebp.syncedKbId);
  const webpKbFile = (webpRec.fields.files as string[])[0];
  assert.ok(webpKbFile.endsWith(".webp"));

  // 3. Omitting kbValidUntil MUST leave validUntil undefined (validity='unknown'), NOT '不适用'
  const pngUnknown = path.join(sandbox, "no-expiry.png");
  await fs.writeFile(pngUnknown, PNG_1X1_RED);
  const uploadedUnknown = (await service.outlineUploadMaterial({
    projectId: created.id,
    expectedRevision: uploadedWebp.revision,
    filePath: pngUnknown,
    nodeId: "n-unknown-exp",
    saveToKb: true,
    kbTitle: "未填效期上传件",
    kbType: "其他",
  })) as any;
  const unknownRec = await kb.get(vault.vaultId, "record", uploadedUnknown.syncedKbId);
  assert.equal(unknownRec.fields.validUntil, undefined);
  const healthUnknown = await kb.health(vault.vaultId, "2028-06-01", { checkImages: "none" });
  assert.equal(healthUnknown.records.find((r) => r.id === uploadedUnknown.syncedKbId)?.validity, "unknown");

  // Same check for promote_material_to_kb with omitted kbValidUntil
  const localForPromote = (await service.outlineUploadMaterial({
    projectId: created.id,
    expectedRevision: uploadedUnknown.revision,
    filePath: pngUnknown,
    nodeId: "n-unknown-exp",
    saveToKb: false,
  })) as any;
  const promotedUnknown = (await service.outlinePromoteMaterialToKb({
    projectId: created.id,
    expectedRevision: localForPromote.revision,
    nodeId: "n-unknown-exp",
    materialRef: localForPromote.binding.ref,
    kbTitle: "未填效期转存件",
    kbType: "其他",
  })) as any;
  const promotedRec = await kb.get(vault.vaultId, "record", promotedUnknown.syncedKbId);
  assert.equal(promotedRec.fields.validUntil, undefined);

  // 4. Compensating rollback: if writeOutlineFile fails after KB creation, no orphan KB record remains
  const kbCountBeforeFail = (await kb.health(vault.vaultId, "2028-06-01", { checkImages: "none" })).records.length;
  const failingHost = Object.create(host) as NodeHostPort;
  failingHost.writeFiles = async (files) => {
    if (files.some((f) => f.path.endsWith("outline.json"))) {
      throw new Error("模拟 outline.json 写入失败");
    }
    return host.writeFiles(files);
  };
  const failingService = new WorkbenchHost(failingHost);
  await assert.rejects(
    failingService.outlineUploadMaterial({
      projectId: created.id,
      expectedRevision: promotedUnknown.revision,
      filePath: pngUnknown,
      nodeId: "n-unknown-exp",
      saveToKb: true,
      kbTitle: "应被回滚的孤儿记录",
      kbType: "其他",
    }),
    /模拟 outline\.json 写入失败/,
  );
  const kbCountAfterFail = (await kb.health(vault.vaultId, "2028-06-01", { checkImages: "none" })).records.length;
  assert.equal(kbCountAfterFail, kbCountBeforeFail, "Failed outline write must roll back newly created KB record");

  // Rollback also applies to outlinePromoteMaterialToKb when outline.json write fails
  const localForRollback = (await service.outlineUploadMaterial({
    projectId: created.id,
    expectedRevision: promotedUnknown.revision,
    filePath: pngUnknown,
    nodeId: "n-unknown-exp",
    saveToKb: false,
  })) as any;
  await assert.rejects(
    failingService.outlinePromoteMaterialToKb({
      projectId: created.id,
      expectedRevision: localForRollback.revision,
      nodeId: "n-unknown-exp",
      materialRef: localForRollback.binding.ref,
      kbTitle: "转存失败应回滚",
      kbType: "其他",
    }),
    /模拟 outline\.json 写入失败/,
  );
  const kbCountAfterPromoteFail = (await kb.health(vault.vaultId, "2028-06-01", { checkImages: "none" })).records.length;
  assert.equal(kbCountAfterPromoteFail, kbCountBeforeFail, "Failed promote outline write must roll back newly created KB record");

  // 5. Phase-2 E2E: confirm outline -> extract -> edit inserting BOTH KB material PNG & WebP record + authored prose material -> check (C05=0, C17=0)
  const cleanState = (await service.outlineSave({
    projectId: created.id,
    expectedRevision: localForRollback.revision,
    volumes: [{ name: "商务标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:2" }] }],
    nodes: [
      {
        id: "n-mat",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、技术架构图",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: kbMat.id, label: "通用架构图素材" }],
      },
      {
        id: "n-webp",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "二、WebP资质图",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: uploadedWebp.syncedKbId, label: "WebP证书" }],
      },
      {
        id: "n-prose-mat",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "三、缺效期测试",
        kind: "authored",
        included: true,
        evidence: [{ source: "kb", ref: kbProseMat.id, label: "通用供货运输方案" }],
      },
    ],
  })) as any;

  await service.outlineConfirm({ projectId: created.id, expectedRevision: cleanState.revision });
  await runProject(host, [
    "extract",
    "--project",
    created.root,
    "--draft",
    "商务标",
    "--tender",
    "tender/1.docx",
    "--ranges",
    JSON.stringify([{ from: "p:0", to: "p:2" }]),
  ]);
  await runProject(host, [
    "edit",
    "--project",
    created.root,
    "--draft",
    "商务标",
    "--ops",
    JSON.stringify([
      {
        op: "insert",
        at: "p:0",
        position: "after",
        markdown: `![架构图](kb:${kbMat.id}/${kbMatFile})`,
      },
      {
        op: "insert",
        at: "p:1",
        position: "after",
        markdown: `![WebP证书](kb:${uploadedWebp.syncedKbId}/${webpKbFile})`,
      },
    ]),
  ]);
  const checkClean = (await runProject(host, [
    "check",
    "--project",
    created.root,
  ])) as { projectCounts: Record<string, number> };
  assert.equal(checkClean.projectCounts.C05, 0, "KB material and WebP KB record images must pass C05 cleanly");
  assert.equal(checkClean.projectCounts.C17, 0, "KB material and WebP KB record images must pass C17 cleanly");

  // Deleting the KB material must trigger C05 fail-closed
  await kb.deleteEntry(vault.vaultId, "material", kbMat.id, "human");
  const checkDeletedMat = (await runProject(host, [
    "check",
    "--project",
    created.root,
  ])) as { projectCounts: Record<string, number> };
  assert.ok(checkDeletedMat.projectCounts.C05 > 0, "Deleted KB material image must fail closed in C05");

  // 6. Client state reconciliation guards (Slice 2 #1, #2, #3)
  const docA: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [{ id: "n1", volume: "商务标", parentId: null, level: 1, title: "标题A", kind: "authored", included: true }],
  };
  const docB: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [{ id: "n1", volume: "商务标", parentId: null, level: 1, title: "服务端B", kind: "authored", included: true }],
  };
  const docC: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [{ id: "n1", volume: "商务标", parentId: null, level: 1, title: "本地C", kind: "authored", included: true }],
  };
  const baseState = {
    serverRevision: "rev-A",
    baselineOutline: docA,
    draftOutline: docC,
    undoStack: [docA],
    redoStack: [],
    conflictError: "",
    confirmMissing: false,
  };

  // Case 1: Clean + no in-flight edit -> sync_all
  const rClean = reconcileOutlineServerPayload({
    current: { ...baseState, draftOutline: docA, undoStack: [] },
    incoming: { revision: "rev-B", outline: { kind: "value", outline: docB } },
    sentSeq: 1,
    currentSeq: 1,
    isDirtyNow: false,
    serverMutatedOutline: false,
    conflictMessage: "conflict",
  });
  assert.equal(rClean.action, "sync_all");
  assert.equal(rClean.state.draftOutline?.nodes[0].title, "服务端B");

  // Case 2: In-flight edit while background refresh returns unchanged outline -> keep draft & advance rev
  const rInFlightKbOnly = reconcileOutlineServerPayload({
    current: baseState,
    incoming: { revision: "rev-A-kb-verified", outline: { kind: "value", outline: docA } },
    sentSeq: 1,
    currentSeq: 2,
    isDirtyNow: true,
    serverMutatedOutline: false,
    conflictMessage: "conflict",
  });
  assert.equal(rInFlightKbOnly.action, "keep_draft_advance_rev");
  assert.equal(rInFlightKbOnly.state.draftOutline?.nodes[0].title, "本地C");
  assert.equal(rInFlightKbOnly.state.serverRevision, "rev-A-kb-verified");
  assert.equal(rInFlightKbOnly.state.undoStack.length, 1);

  // Case 3: Dirty C based on A while server outline diverged to B -> conflict, MUST NOT advance serverRevision!
  const rDiverged = reconcileOutlineServerPayload({
    current: baseState,
    incoming: { revision: "rev-B", outline: { kind: "value", outline: docB } },
    sentSeq: 2,
    currentSeq: 2,
    isDirtyNow: true,
    serverMutatedOutline: false,
    conflictMessage: "conflict",
  });
  assert.equal(rDiverged.action, "keep_draft_conflict");
  assert.equal(rDiverged.state.draftOutline?.nodes[0].title, "本地C");
  assert.equal(rDiverged.state.serverRevision, "rev-A", "Must NEVER advance serverRevision past diverged server outline B");
  assert.equal(rDiverged.state.conflictError, "conflict");

  // Case 4: In-flight edit while serverMutatedOutline=true (upload direct / promote) -> conflict & keep draft
  const rPromoteRace = reconcileOutlineServerPayload({
    current: baseState,
    incoming: { revision: "rev-promoted", outline: { kind: "value", outline: docB } },
    sentSeq: 1,
    currentSeq: 2,
    isDirtyNow: true,
    serverMutatedOutline: true,
    conflictMessage: "conflict",
  });
  assert.equal(rPromoteRace.action, "keep_draft_conflict");
  assert.equal(rPromoteRace.state.draftOutline?.nodes[0].title, "本地C");
  assert.equal(rPromoteRace.state.serverRevision, "rev-A");

  // Case 5 (R2 #3): Brand-new unsaved blank outline (baseline=null, incoming=missing) uploads material -> no false conflict!
  const rBlankUpload = reconcileOutlineServerPayload({
    current: { ...baseState, baselineOutline: null, draftOutline: docC },
    incoming: { revision: "rev-missing-after-upload", outline: { kind: "missing" } },
    sentSeq: 1,
    currentSeq: 1,
    isDirtyNow: true,
    serverMutatedOutline: false,
    conflictMessage: "conflict",
  });
  assert.equal(rBlankUpload.action, "keep_draft_advance_rev");
  assert.equal(rBlankUpload.state.serverRevision, "rev-missing-after-upload");
  // Whereas incoming.outline.kind === 'error' MUST still conflict
  const rBlankError = reconcileOutlineServerPayload({
    current: { ...baseState, baselineOutline: null, draftOutline: docC },
    incoming: { revision: "rev-err", outline: { kind: "error", reason: "corrupt" } },
    sentSeq: 1,
    currentSeq: 1,
    isDirtyNow: true,
    serverMutatedOutline: false,
    conflictMessage: "conflict",
  });
  assert.equal(rBlankError.action, "keep_draft_conflict");

  // Case 6 (R2 #4): Edit C -> D during in-flight upload; binding uses live D so Undo reverts ONLY binding back to D
  const docD: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [{ id: "n1", volume: "商务标", parentId: null, level: 1, title: "上传期间修改D", kind: "authored", included: true }],
  };
  const afterEditD = applyOutlineDraftEdit(
    { draftOutline: docC, undoStack: [docA], redoStack: [], conflictError: "", confirmMissing: false },
    docD,
  );
  const afterBindOnD = applyOutlineDraftEdit(afterEditD, (live) =>
    bindEvidenceToNode(live, "n1", { source: "material", ref: "materials/outline/new.png" }),
  );
  assert.equal(afterBindOnD.draftOutline?.nodes[0].title, "上传期间修改D");
  assert.equal(afterBindOnD.draftOutline?.nodes[0].evidence?.length, 1);
  // Popping one Undo step returns D (NOT stale C!)
  assert.equal(afterBindOnD.undoStack.at(-1)?.nodes[0].title, "上传期间修改D");
  assert.equal(afterBindOnD.undoStack.at(-1)?.nodes[0].evidence, undefined);
});

test("GPT R2 regressions: authored node with image-bearing KB material fails C17 until mounted; direct mode fails C05 if physical KB material image deleted on disk", async (t) => {
  const sandbox = await createSandbox(t, "m42-gpt-r2-");
  const host = new NodeHostPort();
  const service = new WorkbenchHost(host);

  const kbRoot = path.join(sandbox, "seal-home", "vaults");
  await fs.mkdir(kbRoot, { recursive: true });
  const kb = new KnowledgeBase(host, kbRoot);
  const vault = await kb.createVault({ name: "R2回归库", vaultId: "v-gpt-r2" });
  await kb.save(vault.vaultId, {
    action: "update",
    kind: "subject",
    fields: { legalName: "合成测试企业有限公司" },
  });
  const imgMat = await kb.save(vault.vaultId, {
    action: "create",
    kind: "material",
    fields: { type: "工艺图示", title: "制造工艺流程图" },
    body: "流程图说明",
  });
  const imgMatAttached = await kb.save(vault.vaultId, {
    action: "attach_file",
    kind: "material",
    id: imgMat.id,
    file: { fileName: "flow.png", bytes: PNG_1X1_RED },
  });
  const imgMatFile = (imgMatAttached.fields.files as string[])[0];

  const tenderPath = path.join(sandbox, "tender.docx");
  await fs.writeFile(tenderPath, await buildDocx([p("一、制造工艺方案")].join("")));

  // Part A (R2 #1): authored node with image-bearing KB material MUST fail C17 when unmounted, pass once mounted
  const projOutline = await service.create({
    name: "自拟带图素材C17验证",
    deadline: "2028-06-01",
    vaultId: vault.vaultId,
    files: [tenderPath],
    workflowMode: "outline_first",
  });
  let st = (await service.outlineGet({ projectId: projOutline.id })) as any;
  st = await service.outlineSave({
    projectId: projOutline.id,
    expectedRevision: st.revision,
    volumes: [{ name: "技术标", tender: "tender/1.docx", ranges: [{ from: "p:0", to: "p:0" }] }],
    nodes: [
      {
        id: "n-authored-img",
        volume: "技术标",
        parentId: null,
        level: 1,
        title: "一、制造工艺方案",
        kind: "authored",
        included: true,
        evidence: [{ source: "kb", ref: imgMat.id, label: "制造工艺流程图" }],
      },
    ],
  });
  await service.outlineConfirm({ projectId: projOutline.id, expectedRevision: st.revision });
  await runProject(host, [
    "extract",
    "--project",
    projOutline.root,
    "--draft",
    "技术标",
    "--tender",
    "tender/1.docx",
    "--ranges",
    JSON.stringify([{ from: "p:0", to: "p:0" }]),
  ]);
  const checkUnmounted = (await runProject(host, ["check", "--project", projOutline.root])) as {
    projectCounts: Record<string, number>;
  };
  assert.ok(
    checkUnmounted.projectCounts.C17 > 0,
    "Authored node bound to an image-bearing KB material must NOT bypass C17 when unmounted",
  );
  await runProject(host, [
    "edit",
    "--project",
    projOutline.root,
    "--draft",
    "技术标",
    "--ops",
    JSON.stringify([
      {
        op: "insert",
        at: "p:0",
        position: "after",
        markdown: `![流程图](kb:${imgMat.id}/${imgMatFile})`,
      },
    ]),
  ]);
  const checkMounted = (await runProject(host, ["check", "--project", projOutline.root])) as {
    projectCounts: Record<string, number>;
  };
  assert.equal(checkMounted.projectCounts.C17, 0);
  assert.equal(checkMounted.projectCounts.C05, 0);

  // Part B (R2 #2): Direct mode (no outline!) -> mount KB material image -> delete ONLY the physical PNG on disk -> C05 MUST fail closed!
  const projDirect = await service.create({
    name: "直出模式物理删图C05验证",
    deadline: "2028-06-01",
    vaultId: vault.vaultId,
    files: [tenderPath],
    workflowMode: "direct",
  });
  await runProject(host, [
    "extract",
    "--project",
    projDirect.root,
    "--draft",
    "技术标",
    "--tender",
    "tender/1.docx",
    "--ranges",
    JSON.stringify([{ from: "p:0", to: "p:0" }]),
  ]);
  await runProject(host, [
    "edit",
    "--project",
    projDirect.root,
    "--draft",
    "技术标",
    "--ops",
    JSON.stringify([
      {
        op: "insert",
        at: "p:0",
        position: "after",
        markdown: `![流程图](kb:${imgMat.id}/${imgMatFile})`,
      },
    ]),
  ]);
  const directBeforeDelete = (await runProject(host, ["check", "--project", projDirect.root])) as {
    projectCounts: Record<string, number>;
  };
  assert.equal(directBeforeDelete.projectCounts.C05, 0);

  // Delete ONLY the physical PNG on disk while preserving materials/<id>.md intact
  await fs.unlink(path.join(kbRoot, vault.vaultId, imgMatFile));
  const directAfterDelete = (await runProject(host, ["check", "--project", projDirect.root])) as {
    projectCounts: Record<string, number>;
  };
  assert.ok(
    directAfterDelete.projectCounts.C05 > 0,
    "Deleting physical KB material image file must fail closed in C05 even in direct mode without outline",
  );
});
