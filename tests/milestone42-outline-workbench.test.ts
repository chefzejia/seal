import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
  bindEvidenceToNode,
  buildOutlineView,
  canDeleteOutlineNode,
  canIndentOutlineNode,
  canMoveOutlineNode,
  canOutdentOutlineNode,
  createOutlineNodeId,
  outlineFilterCounts,
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
