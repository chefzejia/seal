import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeInsertedBodyParagraphPr } from "../src/core/docx/xml.js";
import { applyTextBatch } from "../src/core/docx/text-batch.js";
import { applyInsertToc } from "../src/core/docx/toc.js";
import { compareBodyXml } from "../src/core/docx/compare.js";
import { validatePackageStructure } from "../src/core/docx/package-structure.js";
import { sha256Hex, writeZip } from "../src/core/docx/zip.js";
import {
  checkOutlineConsistency,
  type OutlineDocument,
  type OutlineKbMediaState,
  type OutlineMaterialState,
} from "../src/core/bid/outline.js";
import { editBidDraft, type AgentEdit } from "../src/core/bid/edit.js";
import { checkDraft } from "../src/core/bid/check.js";
import { confirmPending } from "../src/core/bid/human-review.js";
import { sealLedger } from "../src/core/bid/ledger-integrity.js";
import { resolveFactReferences, type FactContext, type FactResolution } from "../src/core/bid/facts.js";
import type { BidLedger } from "../src/core/bid/project.js";
import type { HostPort } from "../src/core/host.js";
import { SEAL_BID_SKILL } from "../src/shells/dsh/seal-bid-skill.js";

const enc = new TextEncoder();
const doc = (body: string) =>
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>${body}</w:body></w:document>`;

async function buildMockDocx(
  documentXml: string,
  options: { stylesXml?: string; media?: Record<string, Uint8Array> } = {},
): Promise<Uint8Array> {
  const relItems: string[] = [];
  const entries = new Map<string, Uint8Array>([
    [
      "[Content_Types].xml",
      enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Default Extension="png" ContentType="image/png"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          (options.stylesXml
            ? '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
            : "") +
          "</Types>",
      ),
    ],
    [
      "_rels/.rels",
      enc.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          "</Relationships>",
      ),
    ],
    ["word/document.xml", enc.encode(documentXml)],
  ]);

  if (options.stylesXml) {
    entries.set("word/styles.xml", enc.encode(options.stylesXml));
    relItems.push(
      '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    );
  }
  for (const [relId, bytes] of Object.entries(options.media ?? {})) {
    const filename = `${relId}.png`;
    entries.set(`word/media/${filename}`, bytes);
    relItems.push(
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${filename}"/>`,
    );
  }
  entries.set(
    "word/_rels/document.xml.rels",
    enc.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relItems.join("")}</Relationships>`,
    ),
  );
  return writeZip(entries);
}

const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const drawingXml = (relId: string, id: number) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="${id}" name="Seal image ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${relId}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const emptyLedger = (): BidLedger => ({
  format: "seal-ledger-1",
  fills: [],
  pending: [],
  dismissals: [],
  acceptedChanges: [],
  requirements: [],
  drafts: {},
});

test("P0-1: sanitizeInsertedBodyParagraphPr strips w:sectPr and w:pPrChange so insert never clones section breaks", () => {
  assert.equal(
    sanitizeInsertedBodyParagraphPr(
      '<w:pPr><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr><w:pPrChange w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"><w:pPr/></w:pPrChange></w:pPr>',
    ),
    "",
  );
  const kept = sanitizeInsertedBodyParagraphPr(
    '<w:pPr><w:spacing w:after="120"/><w:ind w:firstLine="420"/><w:sectPr><w:pgSz w:w="16838" w:h="11906"/></w:sectPr></w:pPr>',
  );
  assert.ok(kept.includes('<w:spacing w:after="120"/>'));
  assert.ok(kept.includes('<w:ind w:firstLine="420"/>'));
  assert.ok(!kept.includes("w:sectPr"));

  const before = doc(
    '<w:p><w:pPr><w:spacing w:after="120"/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:pPr><w:r><w:t>分节末段</w:t></w:r></w:p>' +
      '<w:sectPr><w:pgSz w:w="16838" w:h="11906"/></w:sectPr>',
  );
  const afterAfter = applyTextBatch(before, [
    { op: "insert", at: "p:0", position: "after", markdown: "新增第一段\n\n新增第二段" },
  ]);
  const afterBefore = applyTextBatch(before, [
    { op: "insert", at: "p:0", position: "before", markdown: "前置第一段\n\n前置第二段" },
  ]);
  assert.equal((afterAfter.match(/<w:sectPr\b/g) ?? []).length, 2);
  assert.equal((afterBefore.match(/<w:sectPr\b/g) ?? []).length, 2);
});

test("P0-2: applyInsertToc writes CT_PPrBase XSD-ordered pPr on entries and anchor with divId/cnfStyle", () => {
  const body =
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:divId w:val="42"/><w:cnfStyle w:val="100000000000"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>目录</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>一、投标函</w:t></w:r></w:p>' +
    "<w:sectPr/>";
  const res = applyInsertToc(
    doc(body),
    {
      op: "insert_toc",
      at: "p:0",
      position: "after",
      maxLevel: 3,
    },
    "",
  );

  // Anchor paragraph: outlineLvl MUST precede divId, cnfStyle, and rPr!
  const anchorPPr = res.xml.match(/<w:pPr><w:pStyle w:val="Heading1"[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  assert.ok(anchorPPr.includes('<w:outlineLvl w:val="9"/>'), anchorPPr);
  assert.ok(
    anchorPPr.indexOf("<w:outlineLvl ") < anchorPPr.indexOf("<w:divId "),
    `outlineLvl must precede divId: ${anchorPPr}`,
  );
  assert.ok(
    anchorPPr.indexOf("<w:divId ") < anchorPPr.indexOf("<w:cnfStyle "),
    `divId must precede cnfStyle: ${anchorPPr}`,
  );
  assert.ok(
    anchorPPr.indexOf("<w:cnfStyle ") < anchorPPr.indexOf("<w:rPr>"),
    `cnfStyle must precede rPr: ${anchorPPr}`,
  );

  // Entry paragraph: tabs -> spacing -> ind -> jc -> outlineLvl
  const entryPPr = res.xml.match(/<w:pPr><w:tabs>[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  const indices = ["<w:tabs>", "<w:spacing ", "<w:ind ", "<w:jc ", "<w:outlineLvl "].map((t) =>
    entryPPr.indexOf(t),
  );
  assert.ok(indices.every((i) => i >= 0), `missing tags in ${entryPPr}`);
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i - 1] < indices[i], `invalid CT_PPrBase order in ${entryPPr}`);
  }
});

test("P0-3: compareBodyXml reports structural formatChanged even when text is filled, without false positives on normal fills", () => {
  const before = doc(
    '<w:tbl>' +
      '<w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>' +
      '<w:tr><w:trPr><w:trHeight w:val="360" w:hRule="exact"/></w:trPr>' +
      '<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t>电话：____</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>备注</w:t></w:r></w:p></w:tc>' +
      "</w:tr></w:tbl>",
  );

  // 1) Normal Seal fill (including yellow highlight + run split) MUST NOT produce formatChanged!
  const normalFilled = applyTextBatch(before, [
    { op: "replace", at: "t:0/r:0/c:0/p:0", find: "____", value: "13800138000", yellow: true },
  ]);
  const normalDiffs = compareBodyXml(before, normalFilled);
  assert.deepEqual(
    normalDiffs.map((d) => d.kind),
    ["filled"],
    `normal fill must not trigger formatChanged: ${JSON.stringify(normalDiffs)}`,
  );

  // 2) Fill + trHeight exact->atLeast MUST report BOTH filled AND formatChanged at t:0/r:0!
  const rowRelaxed = normalFilled.replace('w:hRule="exact"', 'w:hRule="atLeast"');
  const rowDiffs = compareBodyXml(before, rowRelaxed);
  assert.ok(rowDiffs.some((d) => d.kind === "filled"));
  assert.ok(
    rowDiffs.some((d) => d.kind === "formatChanged" && d.address === "t:0/r:0"),
    `expected row formatChanged, got ${JSON.stringify(rowDiffs)}`,
  );

  // 3) Fill + tcPr / tblPr / tblGrid / pPr tampering MUST each be caught as formatChanged!
  const cellChanged = normalFilled.replace('<w:tcW w:w="4000" w:type="dxa"/>', '<w:tcW w:w="5000" w:type="dxa"/>');
  assert.ok(compareBodyXml(before, cellChanged).some((d) => d.kind === "formatChanged" && d.address === "t:0/r:0/c:0"));

  const tblChanged = normalFilled.replace('<w:tblW w:w="8000" w:type="dxa"/>', '<w:tblW w:w="9000" w:type="dxa"/>');
  assert.ok(compareBodyXml(before, tblChanged).some((d) => d.kind === "formatChanged" && d.address === "t:0"));

  const gridChanged = normalFilled.replace('<w:gridCol w:w="4000"/>', '<w:gridCol w:w="5000"/>');
  assert.ok(compareBodyXml(before, gridChanged).some((d) => d.kind === "formatChanged" && d.address === "t:0"));

  const pPrChanged = normalFilled.replace('<w:jc w:val="left"/>', '<w:jc w:val="center"/>');
  assert.ok(compareBodyXml(before, pPrChanged).some((d) => d.kind === "formatChanged" && d.address === "t:0/r:0/c:0/p:0"));
});

test("P0-4: C17 rejects prose substring heading spoof, incomplete multi-image KB, and wrong-section media while allowing valid multi-fill and child-section placement", async () => {
  const hashA = sha256Hex(PNG_A);
  const hashB = sha256Hex(PNG_B);

  // --- Case 1: Prose substring spoof, qualifier swap, and heading negation MUST fail missing_section ---
  const spoofXml = doc(
    "<w:p><w:r><w:t>本段只是正文中提到总体技术方案的说明，并不是独立章节标题。</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>此处略去营业执照副本</w:t></w:r></w:p>" +
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>未提供营业执照</w:t></w:r></w:p>' +
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>资格证书（甲类）</w:t></w:r></w:p>' +
      "<w:p><w:r><w:t>附件1：承诺书</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>格式一：投标函</w:t></w:r></w:p>" +
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>第二章 项目实施方案</w:t></w:r></w:p>' +
      "<w:sectPr/>",
  );
  const spoofDocx = await buildMockDocx(spoofXml);
  const spoofOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-prose-1", volume: "商务标", parentId: null, level: 1, title: "二、总体技术方案", kind: "authored", included: true },
      { id: "n-prose-2", volume: "商务标", parentId: null, level: 1, title: "营业执照副本", kind: "attachment", included: true },
      { id: "n-negated-heading", volume: "商务标", parentId: null, level: 1, title: "营业执照", kind: "attachment", included: true },
      { id: "n-qualifier-diff", volume: "商务标", parentId: null, level: 1, title: "资格证书（乙类）", kind: "attachment", included: true },
      { id: "n-label-diff", volume: "商务标", parentId: null, level: 1, title: "附件2：承诺书", kind: "template", included: true },
      { id: "n-ok-label", volume: "商务标", parentId: null, level: 1, title: "一、投标函", kind: "template", included: true },
      { id: "n-ok-heading", volume: "商务标", parentId: null, level: 1, title: "项目实施方案", kind: "authored", included: true },
    ],
  };
  const spoofIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: spoofOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", spoofDocx]]),
    ledger: emptyLedger(),
  });
  assert.deepEqual(
    spoofIssues.filter((i) => i.kind === "missing_section").map((i) => i.nodeId),
    ["n-prose-1", "n-prose-2", "n-negated-heading", "n-qualifier-diff", "n-label-diff"],
  );

  // --- Case 1b: Duplicate-title outline nodes CANNOT share a single matched heading anchor ---
  const dupOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-dup-1", volume: "商务标", parentId: null, level: 1, title: "一、营业执照", kind: "attachment", included: true },
      { id: "n-dup-2", volume: "商务标", parentId: null, level: 1, title: "二、营业执照", kind: "attachment", included: true },
    ],
  };
  const singleHeadingDocx = await buildMockDocx(
    doc("<w:p><w:r><w:t>一、营业执照</w:t></w:r></w:p><w:sectPr/>"),
  );
  const dupIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: dupOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", singleHeadingDocx]]),
    ledger: emptyLedger(),
  });
  assert.deepEqual(
    dupIssues.filter((i) => i.kind === "missing_section").map((i) => i.nodeId),
    ["n-dup-2"],
  );

  // --- Case 1b-2: Non-greedy bipartite matching avoids starving a later exact-match node ---
  const competingDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>附件1：营业执照</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>格式一：营业执照</w:t></w:r></w:p><w:sectPr/>",
    ),
  );
  const competingOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-loose", volume: "商务标", parentId: null, level: 1, title: "营业执照", kind: "attachment", included: true },
      { id: "n-exact", volume: "商务标", parentId: null, level: 1, title: "附件1：营业执照", kind: "attachment", included: true },
    ],
  };
  const competingIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: competingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", competingDocx]]),
    ledger: emptyLedger(),
  });
  assert.deepEqual(competingIssues, []);

  // --- Case 1b-3: Same-title child sections under DIFFERENT parents must stay scoped to their own parent ---
  const crossParentOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-p1", volume: "商务标", parentId: null, level: 1, title: "一、资格证明", kind: "template", included: true },
      {
        id: "n-p1-c",
        volume: "商务标",
        parentId: "n-p1",
        level: 2,
        title: "营业执照",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/a.png", label: "图A" }],
      },
      { id: "n-p2", volume: "商务标", parentId: null, level: 1, title: "二、补充证明", kind: "template", included: true },
      {
        id: "n-p2-c",
        volume: "商务标",
        parentId: "n-p2",
        level: 2,
        title: "营业执照",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/b.png", label: "图B" }],
      },
    ],
  };
  const crossParentStates = new Map<string, OutlineMaterialState>([
    ["materials/outline/a.png", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
    ["materials/outline/b.png", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashB] }],
  ]);
  const crossParentOkDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>营业执照</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rA", 1)}</w:p>` +
        "<w:p><w:r><w:t>二、补充证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>营业执照</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rB", 2)}</w:p><w:sectPr/>`,
    ),
    { media: { rA: PNG_A, rB: PNG_B } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: crossParentOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", crossParentOkDocx]]),
      ledger: emptyLedger(),
      materialStates: crossParentStates,
    }),
    [],
  );
  const crossParentSwappedDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>营业执照</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rB", 1)}</w:p>` +
        "<w:p><w:r><w:t>二、补充证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>营业执照</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rA", 2)}</w:p><w:sectPr/>`,
    ),
    { media: { rA: PNG_A, rB: PNG_B } },
  );
  const crossParentSwappedIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: crossParentOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", crossParentSwappedDocx]]),
    ledger: emptyLedger(),
    materialStates: crossParentStates,
  });
  assert.deepEqual(
    crossParentSwappedIssues.filter((i) => i.kind === "missing_evidence").map((i) => i.nodeId),
    ["n-p1-c", "n-p2-c"],
  );

  // --- Case 1b-4: 3 interchangeable siblings keep strictly distinct anchors (no stale-swap collapse) ---
  const threeSiblingOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-s1", volume: "商务标", parentId: null, level: 1, title: "营业执照", kind: "attachment", included: true },
      {
        id: "n-s2",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、营业执照",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/s.png", label: "图S" }],
      },
      {
        id: "n-s3",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "二、营业执照",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/s.png", label: "图S" }],
      },
    ],
  };
  const threeSiblingStates = new Map<string, OutlineMaterialState>([
    ["materials/outline/s.png", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
  ]);
  const threeSiblingDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、营业执照</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>二、营业执照</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>营业执照</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rS", 1)}</w:p><w:sectPr/>`,
    ),
    { media: { rS: PNG_A } },
  );
  const threeSiblingIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: threeSiblingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", threeSiblingDocx]]),
    ledger: emptyLedger(),
    materialStates: threeSiblingStates,
  });
  assert.ok(
    threeSiblingIssues.some((i) => i.nodeId === "n-s2" && i.kind === "missing_evidence"),
    `Second sibling must not share third sibling's anchor/evidence: ${JSON.stringify(threeSiblingIssues)}`,
  );

  // --- Case 1b-5: Root sibling must not steal an H2 (or unstyled) child heading under an earlier root ---
  const nestedSameTitleOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-root1", volume: "商务标", parentId: null, level: 1, title: "资格证明", kind: "template", included: true },
      { id: "n-root1-sub", volume: "商务标", parentId: "n-root1", level: 2, title: "补充说明", kind: "authored", included: true },
      { id: "n-root2", volume: "商务标", parentId: null, level: 1, title: "补充说明", kind: "authored", included: true },
    ],
  };
  const styledNestedDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>资格证明</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>补充说明</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>补充说明</w:t></w:r></w:p><w:sectPr/>',
    ),
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: nestedSameTitleOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", styledNestedDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );
  const plainNestedDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p><w:sectPr/>",
    ),
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: nestedSameTitleOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", plainNestedDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );

  // --- Case 1b-6: Multiple same-title children under earlier root are ALL preserved before shifting root sibling ---
  const multiSubSameTitleOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-r1", volume: "商务标", parentId: null, level: 1, title: "资格证明", kind: "template", included: true },
      { id: "n-r1-c1", volume: "商务标", parentId: "n-r1", level: 2, title: "补充说明", kind: "authored", included: true },
      { id: "n-r1-c2", volume: "商务标", parentId: "n-r1", level: 2, title: "补充说明", kind: "authored", included: true },
      { id: "n-r2", volume: "商务标", parentId: null, level: 1, title: "补充说明", kind: "authored", included: true },
    ],
  };
  const multiSubDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p><w:sectPr/>",
    ),
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: multiSubSameTitleOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", multiSubDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );

  // --- Case 1b-7: Five-node A->Ac, B->Bc, C with identical child/root titles preserves ALL subtrees and spans ---
  const fiveNodeSameTitleOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-a", volume: "商务标", parentId: null, level: 1, title: "资格证明", kind: "template", included: true },
      {
        id: "n-ac",
        volume: "商务标",
        parentId: "n-a",
        level: 2,
        title: "补充说明",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/ac.png", label: "A补充" }],
      },
      { id: "n-b", volume: "商务标", parentId: null, level: 1, title: "技术方案", kind: "authored", included: true },
      {
        id: "n-bc",
        volume: "商务标",
        parentId: "n-b",
        level: 2,
        title: "补充说明",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/bc.png", label: "B补充" }],
      },
      {
        id: "n-c",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "补充说明",
        kind: "authored",
        included: true,
      },
    ],
  };
  const fiveNodeMatStates = new Map<string, OutlineMaterialState>([
    ["materials/outline/ac.png", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
    ["materials/outline/bc.png", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashB] }],
  ]);
  const fiveNodeValidDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rAc", 1)}</w:p>` +
        "<w:p><w:r><w:t>技术方案</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rBc", 2)}</w:p>` +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p><w:sectPr/>",
    ),
    { media: { rAc: PNG_A, rBc: PNG_B } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: fiveNodeSameTitleOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", fiveNodeValidDocx]]),
      ledger: emptyLedger(),
      materialStates: fiveNodeMatStates,
    }),
    [],
  );
  // Misplacing B's child evidence under root C must still be caught!
  const fiveNodeMisplacedDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rAc", 1)}</w:p>` +
        "<w:p><w:r><w:t>技术方案</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rBc", 2)}</w:p><w:sectPr/>`,
    ),
    { media: { rAc: PNG_A, rBc: PNG_B } },
  );
  const fiveNodeMisplacedIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: fiveNodeSameTitleOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", fiveNodeMisplacedDocx]]),
    ledger: emptyLedger(),
    materialStates: fiveNodeMatStates,
  });
  assert.ok(
    fiveNodeMisplacedIssues.some(
      (i) => i.nodeId === "n-bc" && i.kind === "missing_evidence" && i.reason.includes("其他章节"),
    ),
    `Expected Bc evidence misplaced under root C to fail: ${JSON.stringify(fiveNodeMisplacedIssues)}`,
  );

  // --- Case 1b-8: Full tree match beats exact-rank greed when root heading number changes ---
  const renumberedRootOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-qual", volume: "商务标", parentId: null, level: 1, title: "资格证明", kind: "template", included: true },
      {
        id: "n-qual-sub",
        volume: "商务标",
        parentId: "n-qual",
        level: 2,
        title: "补充说明",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/ac.png", label: "资格补充" }],
      },
      {
        id: "n-root-num",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、补充说明",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/bc.png", label: "总补充" }],
      },
    ],
  };
  const renumberedValidDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>一、补充说明</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rSub", 1)}</w:p>` +
        "<w:p><w:r><w:t>二、补充说明</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rRoot", 2)}</w:p><w:sectPr/>`,
    ),
    { media: { rSub: PNG_A, rRoot: PNG_B } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: renumberedRootOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", renumberedValidDocx]]),
      ledger: emptyLedger(),
      materialStates: fiveNodeMatStates,
    }),
    [],
  );

  // --- Case 1b-9: Contested missing root yields to child subtree, while uncontested chapter boundary never drops ---
  const contestedMissingRootOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-q", volume: "商务标", parentId: null, level: 1, title: "资格证明", kind: "template", included: true },
      { id: "n-q1", volume: "商务标", parentId: "n-q", level: 2, title: "营业执照", kind: "attachment", included: true },
      { id: "n-q2", volume: "商务标", parentId: "n-q", level: 2, title: "资质证书", kind: "attachment", included: true },
      { id: "n-q3", volume: "商务标", parentId: "n-q", level: 2, title: "社保证明", kind: "attachment", included: true },
      { id: "n-missing-root", volume: "商务标", parentId: null, level: 1, title: "营业执照", kind: "attachment", included: true },
    ],
  };
  const contestedMissingRootDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>营业执照</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>资质证书</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>社保证明</w:t></w:r></w:p><w:sectPr/>",
    ),
  );
  const contestedMissingIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: contestedMissingRootOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", contestedMissingRootDocx]]),
    ledger: emptyLedger(),
  });
  assert.deepEqual(
    contestedMissingIssues.map((i) => ({ nodeId: i.nodeId, kind: i.kind })),
    [{ nodeId: "n-missing-root", kind: "missing_section" }],
  );
  // Conversely, an uncontested chapter boundary ("二、技术方案") must NEVER be dropped to excuse misplaced children!
  const boundaryGuardOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-p1", volume: "商务标", parentId: null, level: 1, title: "一、资格证明", kind: "template", included: true },
      { id: "n-c1", volume: "商务标", parentId: "n-p1", level: 2, title: "1.1 营业执照", kind: "attachment", included: true },
      { id: "n-c2", volume: "商务标", parentId: "n-p1", level: 2, title: "1.2 资质证书", kind: "attachment", included: true },
      { id: "n-p2", volume: "商务标", parentId: null, level: 1, title: "二、技术方案", kind: "authored", included: true },
    ],
  };
  const misplacedChildrenDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>二、技术方案</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>1.1 营业执照</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>1.2 资质证书</w:t></w:r></w:p><w:sectPr/>",
    ),
  );
  const boundaryGuardIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: boundaryGuardOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", misplacedChildrenDocx]]),
    ledger: emptyLedger(),
  });
  assert.deepEqual(
    boundaryGuardIssues.map((i) => i.nodeId),
    ["n-c1", "n-c2"],
  );

  // --- Case 1b-10: Imported doc with same Heading-1 style on both parent and child matches cleanly ---
  const h1ParentChildOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-p", volume: "商务标", parentId: null, level: 1, title: "资格证明", kind: "template", included: true },
      {
        id: "n-ch",
        volume: "商务标",
        parentId: "n-p",
        level: 2,
        title: "专项资质",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/ac.png", label: "专项资质图" }],
      },
    ],
  };
  const h1BothValidDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>资格证明</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>专项资质</w:t></w:r></w:p>' +
        `<w:p>${drawingXml("rSpec", 1)}</w:p><w:sectPr/>`,
    ),
    { media: { rSpec: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: h1ParentChildOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", h1BothValidDocx]]),
      ledger: emptyLedger(),
      materialStates: fiveNodeMatStates,
    }),
    [],
  );
  // An unmatched H1 peer AFTER the H1 child still terminates the child's section span!
  const h1BothMisplacedDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>资格证明</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>专项资质</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>未列入大纲的独立章节</w:t></w:r></w:p>' +
        `<w:p>${drawingXml("rSpec", 1)}</w:p><w:sectPr/>`,
    ),
    { media: { rSpec: PNG_A } },
  );
  const h1BothMisplacedIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: h1ParentChildOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", h1BothMisplacedDocx]]),
    ledger: emptyLedger(),
    materialStates: fiveNodeMatStates,
  });
  assert.ok(
    h1BothMisplacedIssues.some(
      (i) => i.nodeId === "n-ch" && i.kind === "missing_evidence" && i.reason.includes("其他章节"),
    ),
    `Expected unmatched H1 peer to terminate H1 child section: ${JSON.stringify(h1BothMisplacedIssues)}`,
  );

  // --- Case 1b-11: Unclaimed H1 candidate between parent and H2 child tightens parent span and blocks out-of-span child ---
  const crossBoundaryChildDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>资格证明</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>1.专项资质</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>专项资质</w:t></w:r></w:p>' +
        `<w:p>${drawingXml("rSpec", 1)}</w:p><w:sectPr/>`,
    ),
    { media: { rSpec: PNG_A } },
  );
  const crossBoundaryChildIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: h1ParentChildOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", crossBoundaryChildDocx]]),
    ledger: emptyLedger(),
    materialStates: fiveNodeMatStates,
  });
  assert.ok(
    crossBoundaryChildIssues.some(
      (i) => i.nodeId === "n-ch" && i.kind === "missing_section",
    ),
    `Expected unclaimed H1 boundary before H2 child to reject out-of-span child: ${JSON.stringify(crossBoundaryChildIssues)}`,
  );

  // --- Case 1b-12: Nine identical-title nodes (3 roots x 2 children) in strict preorder match completely via preorder DP ---
  const nineIdenticalNodes: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "r0", volume: "商务标", parentId: null, level: 1, title: "补充说明", kind: "authored", included: true },
      { id: "c0x0", volume: "商务标", parentId: "r0", level: 2, title: "补充说明", kind: "authored", included: true },
      {
        id: "c0x1",
        volume: "商务标",
        parentId: "r0",
        level: 2,
        title: "补充说明",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/ac.png", label: "第0组子2" }],
      },
      { id: "r1", volume: "商务标", parentId: null, level: 1, title: "补充说明", kind: "authored", included: true },
      { id: "c1x0", volume: "商务标", parentId: "r1", level: 2, title: "补充说明", kind: "authored", included: true },
      { id: "c1x1", volume: "商务标", parentId: "r1", level: 2, title: "补充说明", kind: "authored", included: true },
      { id: "r2", volume: "商务标", parentId: null, level: 1, title: "补充说明", kind: "authored", included: true },
      { id: "c2x0", volume: "商务标", parentId: "r2", level: 2, title: "补充说明", kind: "authored", included: true },
      { id: "c2x1", volume: "商务标", parentId: "r2", level: 2, title: "补充说明", kind: "authored", included: true },
    ],
  };
  const ninePreorderValidDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rC0x1", 1)}</w:p>` +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>补充说明</w:t></w:r></w:p><w:sectPr/>",
    ),
    { media: { rC0x1: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: nineIdenticalNodes },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", ninePreorderValidDocx]]),
      ledger: emptyLedger(),
      materialStates: fiveNodeMatStates,
    }),
    [],
  );

  // --- Case 1b-13: Native Word heading beats earlier plain paragraph with identical unnumbered text ---
  const headingOverPlainOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-cert",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "证件",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/ac.png", label: "证件图" }],
      },
    ],
  };
  const headingOverPlainDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>证件</w:t></w:r></w:p>" +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>一、证件</w:t></w:r></w:p>' +
        `<w:p>${drawingXml("rCert", 1)}</w:p><w:sectPr/>`,
    ),
    { media: { rCert: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: headingOverPlainOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", headingOverPlainDocx]]),
      ledger: emptyLedger(),
      materialStates: fiveNodeMatStates,
    }),
    [],
  );

  // --- Case 1c: Unmatched peer/higher native heading terminates section span, while unmatched sub-heading stays inside ---
  const peerBoundaryOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-lic",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、营业执照",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/lic.png", label: "营业执照图" }],
      },
    ],
  };
  const peerMatStates = new Map<string, OutlineMaterialState>([
    ["materials/outline/lic.png", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
  ]);
  const misplacedUnderUnmatchedPeer = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>一、营业执照</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>二、其他未列入大纲的说明</w:t></w:r></w:p>' +
        `<w:p>${drawingXml("rLic", 1)}</w:p><w:sectPr/>`,
    ),
    { media: { rLic: PNG_A } },
  );
  const misplacedPeerIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: peerBoundaryOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", misplacedUnderUnmatchedPeer]]),
    ledger: emptyLedger(),
    materialStates: peerMatStates,
  });
  assert.ok(
    misplacedPeerIssues.some(
      (i) => i.nodeId === "n-lic" && i.kind === "missing_evidence" && i.reason.includes("其他章节"),
    ),
    `Expected unmatched peer native heading to terminate section span: ${JSON.stringify(misplacedPeerIssues)}`,
  );

  const validUnderUnmatchedSub = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>一、营业执照</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>1.1 副本正面</w:t></w:r></w:p>' +
        `<w:p>${drawingXml("rLic", 1)}</w:p><w:sectPr/>`,
    ),
    { media: { rLic: PNG_A } },
  );
  const subHeadingIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: peerBoundaryOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", validUnderUnmatchedSub]]),
    ledger: emptyLedger(),
    materialStates: peerMatStates,
  });
  assert.deepEqual(subHeadingIssues, []);

  // --- Case 2: Multi-image KB record (2 images) — partial (1/2) fails, split across 2 fills in-section passes ---
  const kbOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-idcard",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、身份证复印件",
        kind: "attachment",
        included: true,
        evidence: [{ source: "kb", ref: "rec-idcard", label: "法人身份证" }],
      },
      {
        id: "n-other",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "二、其他说明",
        kind: "authored",
        included: true,
      },
    ],
  };
  const kbMediaStates = new Map<string, OutlineKbMediaState>([
    ["rec-idcard", { kind: "ok", hashes: [hashA, hashB] }],
  ]);

  // 2a) Only 1 of 2 KB images mounted -> MUST block!
  const partialKbDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、身份证复印件</w:t></w:r></w:p>" +
        `<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_f1"/>${drawingXml("rImg1", 1)}<w:bookmarkEnd w:id="1"/></w:p>` +
        "<w:p><w:r><w:t>二、其他说明</w:t></w:r></w:p><w:sectPr/>",
    ),
    { media: { rImg1: PNG_A } },
  );
  const partialLedger = emptyLedger();
  partialLedger.fills.push({
    id: "f1",
    draft: "商务标",
    operation: "insert_image",
    reference: "kb:rec-idcard/front.png",
    sources: [{ recordId: "rec-idcard", media: true, reference: "kb:rec-idcard/front.png", resolvedValue: "front.png", verified: true }],
    resolvedValue: "front.png",
    verified: true,
    sealKind: "fact",
  });
  const partialKbIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: kbOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", partialKbDocx]]),
    ledger: partialLedger,
    kbRecordHasFiles: new Map([["rec-idcard", true]]),
    kbRecordMediaStates: kbMediaStates,
  });
  assert.ok(
    partialKbIssues.some(
      (i) => i.nodeId === "n-idcard" && i.kind === "missing_evidence" && i.reason.includes("1/2"),
    ),
    `Expected 1/2 missing KB image issue, got: ${JSON.stringify(partialKbIssues)}`,
  );

  // 2b) Both images mounted across TWO separate fills inside n-idcard -> MUST pass!
  const twoFillKbDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、身份证复印件</w:t></w:r></w:p>" +
        `<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_f1"/>${drawingXml("rImg1", 1)}<w:bookmarkEnd w:id="1"/></w:p>` +
        `<w:p><w:bookmarkStart w:id="2" w:name="_Seal_F_f2"/>${drawingXml("rImg2", 2)}<w:bookmarkEnd w:id="2"/></w:p>` +
        "<w:p><w:r><w:t>二、其他说明</w:t></w:r></w:p><w:sectPr/>",
    ),
    { media: { rImg1: PNG_A, rImg2: PNG_B } },
  );
  const twoFillLedger = emptyLedger();
  twoFillLedger.fills.push(
    {
      id: "f1",
      draft: "商务标",
      operation: "insert_image",
      reference: "kb:rec-idcard/front.png",
      sources: [{ recordId: "rec-idcard", media: true, reference: "kb:rec-idcard/front.png", resolvedValue: "front.png", verified: true }],
      resolvedValue: "front.png",
      verified: true,
      sealKind: "fact",
    },
    {
      id: "f2",
      draft: "商务标",
      operation: "insert_image",
      reference: "kb:rec-idcard/back.png",
      sources: [{ recordId: "rec-idcard", media: true, reference: "kb:rec-idcard/back.png", resolvedValue: "back.png", verified: true }],
      resolvedValue: "back.png",
      verified: true,
      sealKind: "fact",
    },
  );
  const twoFillIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: kbOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", twoFillKbDocx]]),
    ledger: twoFillLedger,
    kbRecordHasFiles: new Map([["rec-idcard", true]]),
    kbRecordMediaStates: kbMediaStates,
  });
  assert.deepEqual(twoFillIssues, []);

  // 2c) Second image placed in WRONG section (under 二、其他说明) -> MUST block!
  const wrongSecKbDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、身份证复印件</w:t></w:r></w:p>" +
        `<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_f1"/>${drawingXml("rImg1", 1)}<w:bookmarkEnd w:id="1"/></w:p>` +
        "<w:p><w:r><w:t>二、其他说明</w:t></w:r></w:p>" +
        `<w:p><w:bookmarkStart w:id="2" w:name="_Seal_F_f2"/>${drawingXml("rImg2", 2)}<w:bookmarkEnd w:id="2"/></w:p>` +
        "<w:sectPr/>",
    ),
    { media: { rImg1: PNG_A, rImg2: PNG_B } },
  );
  const wrongSecKbIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: kbOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", wrongSecKbDocx]]),
    ledger: twoFillLedger,
    kbRecordHasFiles: new Map([["rec-idcard", true]]),
    kbRecordMediaStates: kbMediaStates,
  });
  assert.ok(
    wrongSecKbIssues.some(
      (i) => i.nodeId === "n-idcard" && i.kind === "missing_evidence" && i.reason.includes("其他章节"),
    ),
    `Expected wrong-section KB issue, got: ${JSON.stringify(wrongSecKbIssues)}`,
  );

  // 2d) Verified image-only KB scan mounted under template, authored, AND attachment nodes all pass;
  // partial 1/2 OR text-only citation (0/2 images!) MUST FAIL across all 3 node kinds!
  const textOnlyKbDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、身份证复印件</w:t></w:r></w:p>" +
        '<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_ftOnly"/><w:r><w:t>证件号：110101199001011234</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>' +
        "<w:p><w:r><w:t>二、其他说明</w:t></w:r></w:p><w:sectPr/>",
    ),
  );
  const textOnlyKbLedger = emptyLedger();
  textOnlyKbLedger.fills.push({
    id: "ftOnly",
    draft: "商务标",
    operation: "insert",
    reference: "{{record:rec-idcard.number}}",
    sources: [{ recordId: "rec-idcard", reference: "{{record:rec-idcard.number}}", resolvedValue: "110101199001011234", verified: true }],
    resolvedValue: "110101199001011234",
    verified: true,
    sealKind: "fact",
  });
  for (const nodeKind of ["template", "authored", "attachment"] as const) {
    const kindOutline: OutlineDocument = {
      format: "seal-outline-1",
      volumes: [{ name: "商务标" }],
      nodes: [
        {
          id: `n-${nodeKind}`,
          volume: "商务标",
          parentId: null,
          level: 1,
          title: "一、身份证复印件",
          kind: nodeKind,
          included: true,
          evidence: [{ source: "kb", ref: "rec-idcard", label: "法人身份证" }],
        },
        {
          id: "n-other",
          volume: "商务标",
          parentId: null,
          level: 1,
          title: "二、其他说明",
          kind: "authored",
          included: true,
        },
      ],
    };
    assert.deepEqual(
      await checkOutlineConsistency({
        outlineState: { kind: "value", outline: kindOutline },
        confirmationStatus: "confirmed",
        workflowMode: "outline_first",
        drafts: new Map([["商务标", twoFillKbDocx]]),
        ledger: twoFillLedger,
        kbRecordHasFiles: new Map([["rec-idcard", true]]),
        kbRecordMediaStates: kbMediaStates,
      }),
      [],
      `Expected verified KB scan under kind=${nodeKind} to pass`,
    );
    const kindPartialIssues = await checkOutlineConsistency({
      outlineState: { kind: "value", outline: kindOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", partialKbDocx]]),
      ledger: partialLedger,
      kbRecordHasFiles: new Map([["rec-idcard", true]]),
      kbRecordMediaStates: kbMediaStates,
    });
    assert.ok(
      kindPartialIssues.some(
        (i) => i.nodeId === `n-${nodeKind}` && i.kind === "missing_evidence" && i.reason.includes("1/2"),
      ),
      `Expected partial 1/2 KB scan under kind=${nodeKind} to fail: ${JSON.stringify(kindPartialIssues)}`,
    );
    const kindTextOnlyIssues = await checkOutlineConsistency({
      outlineState: { kind: "value", outline: kindOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", textOnlyKbDocx]]),
      ledger: textOnlyKbLedger,
      kbRecordHasFiles: new Map([["rec-idcard", true]]),
      kbRecordMediaStates: kbMediaStates,
    });
    assert.ok(
      kindTextOnlyIssues.some(
        (i) => i.nodeId === `n-${nodeKind}` && i.kind === "missing_evidence" && i.reason.includes("2/2"),
      ),
      `Expected text-only citation without scanned images under kind=${nodeKind} to fail 2/2: ${JSON.stringify(kindTextOnlyIssues)}`,
    );
  }

  // --- Case 3: Uploaded material placed in wrong section fails, placed under descendant of parent node passes ---
  const matOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-parent",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、资格证明",
        kind: "template",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/parent.png", label: "父级汇总图" }],
      },
      {
        id: "n-child",
        volume: "商务标",
        parentId: "n-parent",
        level: 2,
        title: "1.1 专项资质",
        kind: "attachment",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/child.png", label: "专项资质图" }],
      },
      {
        id: "n-sibling",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "二、技术方案",
        kind: "authored",
        included: true,
      },
    ],
  };
  const matStates = new Map<string, OutlineMaterialState>([
    ["materials/outline/parent.png", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
    ["materials/outline/child.png", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashB] }],
  ]);

  // parent.png is placed inside descendant n-child (valid for n-parent!), but child.png is placed in n-sibling (invalid for n-child!)
  const matDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、资格证明</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>1.1 专项资质</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rParent", 1)}</w:p>` +
        "<w:p><w:r><w:t>二、技术方案</w:t></w:r></w:p>" +
        `<w:p>${drawingXml("rChild", 2)}</w:p>` +
        "<w:sectPr/>",
    ),
    { media: { rParent: PNG_A, rChild: PNG_B } },
  );
  const matIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: matOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", matDocx]]),
    ledger: emptyLedger(),
    materialStates: matStates,
  });
  assert.ok(
    !matIssues.some((i) => i.nodeId === "n-parent"),
    `Parent evidence placed in descendant section should pass: ${JSON.stringify(matIssues)}`,
  );
  assert.ok(
    matIssues.some(
      (i) => i.nodeId === "n-child" && i.kind === "missing_evidence" && i.reason.includes("其他章节"),
    ),
    `Child evidence placed in unrelated sibling section must fail: ${JSON.stringify(matIssues)}`,
  );

  // --- Case 4: mc:AlternateContent Choice/Fallback are mutually exclusive for both uploaded materials & KB multi-image ---
  const altMatOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-alt-mat",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、双页材料",
        kind: "attachment",
        included: true,
        evidence: [
          {
            source: "material",
            ref: "materials/outline/two-page.pdf",
            label: "双页材料",
            renderedPages: ["materials/outline/p1.png", "materials/outline/p2.png"],
          },
        ],
      },
    ],
  };
  const altTwoPageStates = new Map<string, OutlineMaterialState>([
    [
      "materials/outline/two-page.pdf",
      { exists: true, readable: true, kind: "pdf", expectedImageHashes: [hashA, hashB] },
    ],
  ]);
  const vmlXml = (rId: string) => `<w:pict><v:shape><v:imagedata r:id="${rId}"/></v:shape></w:pict>`;

  // 4a) Page 1 in normal body + Page 2 hidden inside mutually exclusive Fallback (Choice has Page 1 or empty) -> MUST block!
  const splitAltMatDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        `<w:p><w:r>${drawingXml("rP1", 1)}</w:r></w:p>` +
        `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">${drawingXml("rP1b", 2)}</mc:Choice><mc:Fallback>${vmlXml("rP2")}</mc:Fallback></mc:AlternateContent></w:r></w:p>` +
        "<w:sectPr/>",
    ),
    { media: { rP1: PNG_A, rP1b: PNG_A, rP2: PNG_B } },
  );
  const splitAltMatIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", splitAltMatDocx]]),
    ledger: emptyLedger(),
    materialStates: altTwoPageStates,
  });
  assert.ok(
    splitAltMatIssues.some(
      (i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence" && i.reason.includes("1/2"),
    ),
    `Expected AlternateContent Choice/Fallback split to fail 1/2: ${JSON.stringify(splitAltMatIssues)}`,
  );

  // 4b) KB 2-image record split across Choice & Fallback -> MUST block!
  const splitAltKbDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、身份证复印件</w:t></w:r></w:p>" +
        `<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_f1"/><w:r><mc:AlternateContent><mc:Choice Requires="wps">${drawingXml("rImg1", 1)}</mc:Choice><mc:Fallback>${vmlXml("rImg2")}</mc:Fallback></mc:AlternateContent></w:r><w:bookmarkEnd w:id="1"/></w:p>` +
        "<w:p><w:r><w:t>二、其他说明</w:t></w:r></w:p><w:sectPr/>",
    ),
    { media: { rImg1: PNG_A, rImg2: PNG_B } },
  );
  const splitAltKbIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: kbOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", splitAltKbDocx]]),
    ledger: partialLedger,
    kbRecordHasFiles: new Map([["rec-idcard", true]]),
    kbRecordMediaStates: kbMediaStates,
  });
  assert.ok(
    splitAltKbIssues.some(
      (i) => i.nodeId === "n-idcard" && i.kind === "missing_evidence" && i.reason.includes("1/2"),
    ),
    `Expected KB Choice/Fallback split to fail 1/2: ${JSON.stringify(splitAltKbIssues)}`,
  );

  // 4c) Legitimate Word Choice+Fallback embedding the SAME image counts ONCE (passes [hashA], fails [hashA, hashA])
  const sameImageAltDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">${drawingXml("rSame", 1)}</mc:Choice><mc:Fallback>${vmlXml("rSame")}</mc:Fallback></mc:AlternateContent></w:r></w:p>` +
        "<w:sectPr/>",
    ),
    { media: { rSame: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", sameImageAltDocx]]),
      ledger: emptyLedger(),
      materialStates: new Map<string, OutlineMaterialState>([
        ["materials/outline/two-page.pdf", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
      ]),
    }),
    [],
  );
  const doubleCountAltIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", sameImageAltDocx]]),
    ledger: emptyLedger(),
    materialStates: new Map<string, OutlineMaterialState>([
      ["materials/outline/two-page.pdf", { exists: true, readable: true, kind: "pdf", expectedImageHashes: [hashA, hashA] }],
    ]),
  });
  assert.ok(
    doubleCountAltIssues.some(
      (i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence" && i.reason.includes("1/2"),
    ),
    `Expected single Choice+Fallback image not to double-count for [hashA, hashA]: ${JSON.stringify(doubleCountAltIssues)}`,
  );

  // 4d) Block-level AlternateContent where Choice has inverted hierarchy (Child -> Parent) and Fallback has Parent -> Child -> MUST fail!
  const invertedAltHierarchyOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-parent", volume: "商务标", parentId: null, level: 1, title: "父节", kind: "template", included: true },
      { id: "n-child", volume: "商务标", parentId: "n-parent", level: 2, title: "子节", kind: "authored", included: true },
    ],
  };
  const invertedAltHierarchyDocx = await buildMockDocx(
    doc(
      '<mc:AlternateContent><mc:Choice Requires="wps">' +
        '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>子节</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>父节</w:t></w:r></w:p>' +
        "</mc:Choice><mc:Fallback>" +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>父节</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>子节</w:t></w:r></w:p>' +
        "</mc:Fallback></mc:AlternateContent><w:sectPr/>",
    ),
  );
  const invertedAltIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: invertedAltHierarchyOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", invertedAltHierarchyDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    invertedAltIssues.some((i) => i.nodeId === "n-child" && i.kind === "missing_section"),
    `Expected inverted Choice hierarchy to fail C17: ${JSON.stringify(invertedAltIssues)}`,
  );

  // 4e) Positive control: block-level AlternateContent containing the same heading AND same image in BOTH Choice & Fallback -> MUST PASS!
  const blockAltValidDocx = await buildMockDocx(
    doc(
      '<mc:AlternateContent><mc:Choice Requires="wps">' +
        "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        `<w:p><w:r>${drawingXml("rBlockA", 1)}</w:r></w:p>` +
        "</mc:Choice><mc:Fallback>" +
        "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        `<w:p><w:r>${vmlXml("rBlockA")}</w:r></w:p>` +
        "</mc:Fallback></mc:AlternateContent><w:sectPr/>",
    ),
    { media: { rBlockA: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", blockAltValidDocx]]),
      ledger: emptyLedger(),
      materialStates: new Map<string, OutlineMaterialState>([
        ["materials/outline/two-page.pdf", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
      ]),
    }),
    [],
  );

  // 4f) Choice-only AlternateContent with NO Fallback -> fails closed for legacy/fallback consumer!
  const choiceOnlyAltDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps">${drawingXml("rOnly", 1)}</mc:Choice></mc:AlternateContent></w:r></w:p>` +
        "<w:sectPr/>",
    ),
    { media: { rOnly: PNG_A } },
  );
  const choiceOnlyIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", choiceOnlyAltDocx]]),
    ledger: emptyLedger(),
    materialStates: new Map<string, OutlineMaterialState>([
      ["materials/outline/two-page.pdf", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
    ]),
  });
  assert.ok(
    choiceOnlyIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
    `Expected Choice-only AlternateContent without Fallback to fail: ${JSON.stringify(choiceOnlyIssues)}`,
  );

  // 4g) Exact enumeration catches 4-capability subset {a,b} where heading vanishes completely
  const singleHeadingOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-sec", volume: "商务标", parentId: null, level: 1, title: "关键章节", kind: "authored", included: true },
    ],
  };
  const fourCapDocx = await buildMockDocx(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="urn:cap:a" xmlns:b="urn:cap:b" xmlns:c="urn:cap:c" xmlns:d="urn:cap:d"><w:body>` +
      `<mc:AlternateContent><mc:Choice Requires="a"/><mc:Fallback><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>` +
      `<mc:AlternateContent><mc:Choice Requires="b"/><mc:Fallback><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>` +
      `<mc:AlternateContent><mc:Choice Requires="c"><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Choice><mc:Fallback/></mc:AlternateContent>` +
      `<mc:AlternateContent><mc:Choice Requires="d"><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Choice><mc:Fallback/></mc:AlternateContent>` +
      `<w:sectPr/></w:body></w:document>`,
  );
  const fourCapIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", fourCapDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    fourCapIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
    `Expected exact enumeration to catch missing heading under {a,b}: ${JSON.stringify(fourCapIssues)}`,
  );

  // 4h) XML namespace URI resolution: prefix rebinding catches missing heading; URI aliasing passes; unbound prefix fails closed
  const reboundPrefixDocx = await buildMockDocx(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>` +
      `<mc:AlternateContent><mc:Choice xmlns:x="urn:cap:A" Requires="x"/><mc:Fallback><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>` +
      `<mc:AlternateContent><mc:Choice xmlns:x="urn:cap:B" Requires="x"><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Choice><mc:Fallback/></mc:AlternateContent>` +
      `<w:sectPr/></w:body></w:document>`,
  );
  const reboundPrefixIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", reboundPrefixDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    reboundPrefixIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
    `Expected rebound prefix x (urn:cap:A vs urn:cap:B) to fail when only A is supported: ${JSON.stringify(reboundPrefixIssues)}`,
  );

  const aliasedUriDocx = await buildMockDocx(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x="urn:cap:same" xmlns:y="urn:cap:same"><w:body>` +
      `<mc:AlternateContent><mc:Choice Requires="x"/><mc:Fallback><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>` +
      `<mc:AlternateContent><mc:Choice Requires="y"><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Choice><mc:Fallback/></mc:AlternateContent>` +
      `<w:sectPr/></w:body></w:document>`,
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleHeadingOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", aliasedUriDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );

  const unboundReqDocx = await buildMockDocx(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>` +
      `<mc:AlternateContent><mc:Choice Requires="missingPrefix"><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>` +
      `<w:sectPr/></w:body></w:document>`,
  );
  const unboundReqIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", unboundReqDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    unboundReqIssues.some((i) => i.kind === "corrupt_draft" && i.reason.includes("missingPrefix")),
    `Expected unbound Requires prefix to fail closed with corrupt_draft: ${JSON.stringify(unboundReqIssues)}`,
  );

  // 4i) Exceeding exact AlternateContent verification budget (>64 reachable profiles) fails closed instead of sampling
  const sevenCapXml = Array.from({ length: 7 }, (_, i) =>
    `<mc:AlternateContent><mc:Choice xmlns:u="urn:cap:u${i}" Requires="u"><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>`,
  ).join("");
  const sevenCapDocx = await buildMockDocx(
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${sevenCapXml}<w:sectPr/></w:body></w:document>`,
  );
  const sevenCapIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", sevenCapDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    sevenCapIssues.some((i) => i.kind === "corrupt_draft"),
    `Expected >64 reachable AlternateContent profiles to fail closed with corrupt_draft: ${JSON.stringify(sevenCapIssues)}`,
  );

  // 4j) Outer bookmark wrapping AlternateContent with text only in Choice (empty Fallback) MUST fail for both KB text & uploaded quote fills!
  const textAltOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-kb-txt",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "一、业绩说明",
        kind: "authored",
        included: true,
        evidence: [
          { source: "kb", ref: "rec-case", label: "代表业绩" },
          { source: "material", ref: "materials/outline/spec.txt", label: "技术规范" },
        ],
      },
    ],
  };
  const textAltLedger = emptyLedger();
  textAltLedger.fills.push(
    {
      id: "ft1",
      draft: "商务标",
      operation: "insert",
      reference: "kb:rec-case",
      sources: [{ recordId: "rec-case", reference: "kb:rec-case", resolvedValue: "示例业绩", verified: true }],
      resolvedValue: "示例业绩",
      verified: true,
      sealKind: "fact",
    },
    {
      id: "fq1",
      draft: "商务标",
      operation: "insert",
      reference: "{{quote:materials/outline/spec.txt|规范原文}}",
      sources: [{ reference: "{{quote:materials/outline/spec.txt|规范原文}}", resolvedValue: "规范原文", verified: true }],
      resolvedValue: "规范原文",
      verified: true,
      sealKind: "fact",
    },
  );
  const textAltMatStates = new Map<string, OutlineMaterialState>([
    ["materials/outline/spec.txt", { exists: true, readable: true, kind: "text" }],
  ]);
  const emptyFallbackTextDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、业绩说明</w:t></w:r></w:p>" +
        '<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_ft1"/><mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>示例业绩</w:t></w:r></mc:Choice><mc:Fallback/></mc:AlternateContent><w:bookmarkEnd w:id="1"/></w:p>' +
        '<w:p><w:bookmarkStart w:id="2" w:name="_Seal_F_fq1"/><mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>规范原文</w:t></w:r></mc:Choice><mc:Fallback/></mc:AlternateContent><w:bookmarkEnd w:id="2"/></w:p>' +
        "<w:sectPr/>",
    ),
  );
  const emptyFallbackTextIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: textAltOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", emptyFallbackTextDocx]]),
    ledger: textAltLedger,
    materialStates: textAltMatStates,
  });
  assert.ok(
    emptyFallbackTextIssues.some(
      (i) => i.nodeId === "n-kb-txt" && i.kind === "missing_evidence" && i.source === "kb",
    ),
    `Expected outer bookmark wrapping empty-Fallback KB text to fail: ${JSON.stringify(emptyFallbackTextIssues)}`,
  );
  assert.ok(
    emptyFallbackTextIssues.some(
      (i) => i.nodeId === "n-kb-txt" && i.kind === "missing_evidence" && i.source === "material",
    ),
    `Expected outer bookmark wrapping empty-Fallback quote text to fail: ${JSON.stringify(emptyFallbackTextIssues)}`,
  );
  const bothBranchesTextDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、业绩说明</w:t></w:r></w:p>" +
        '<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_ft1"/><mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>示例业绩</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>示例业绩</w:t></w:r></mc:Fallback></mc:AlternateContent><w:bookmarkEnd w:id="1"/></w:p>' +
        '<w:p><w:bookmarkStart w:id="2" w:name="_Seal_F_fq1"/><mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>规范原文</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>规范原文</w:t></w:r></mc:Fallback></mc:AlternateContent><w:bookmarkEnd w:id="2"/></w:p>' +
        "<w:sectPr/>",
    ),
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: textAltOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", bothBranchesTextDocx]]),
      ledger: textAltLedger,
      materialStates: textAltMatStates,
    }),
    [],
  );

  // --- Case 5: Hidden media via inherited rStyle->w:vanish, VML display:none/visibility:hidden, or DrawingML hidden="1" fails C17 ---
  const hiddenMediaStylesXml =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="character" w:styleId="HiddenChar"><w:rPr><w:vanish/></w:rPr></w:style>' +
    "</w:styles>";
  const singleImgMatStates = new Map<string, OutlineMaterialState>([
    ["materials/outline/two-page.pdf", { exists: true, readable: true, kind: "image", expectedImageHashes: [hashA] }],
  ]);

  // 5a) rStyle -> w:vanish hides image (negative) vs direct w:vanish w:val="0" override (positive)
  const runWithProps = (rPr: string, relId: string, id: number) =>
    drawingXml(relId, id).replace("<w:r>", `<w:r>${rPr}`);
  const rStyleHiddenMediaDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        `<w:p>${runWithProps('<w:rPr><w:rStyle w:val="HiddenChar"/></w:rPr>', "rHid1", 1)}</w:p><w:sectPr/>`,
    ),
    { stylesXml: hiddenMediaStylesXml, media: { rHid1: PNG_A } },
  );
  const rStyleHiddenIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", rStyleHiddenMediaDocx]]),
    ledger: emptyLedger(),
    materialStates: singleImgMatStates,
  });
  assert.ok(
    rStyleHiddenIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
    `Expected rStyle->w:vanish hidden image to fail C17: ${JSON.stringify(rStyleHiddenIssues)}`,
  );
  const rStyleOverrideVisibleDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        `<w:p>${runWithProps('<w:rPr><w:rStyle w:val="HiddenChar"/><w:vanish w:val="0"/></w:rPr>', "rVis1", 1)}</w:p><w:sectPr/>`,
    ),
    { stylesXml: hiddenMediaStylesXml, media: { rVis1: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", rStyleOverrideVisibleDocx]]),
      ledger: emptyLedger(),
      materialStates: singleImgMatStates,
    }),
    [],
  );

  // 5b) VML shape style="display:none" hides image (negative) vs visible VML shape (positive)
  const vmlHiddenDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        '<w:p><w:r><w:pict><v:shape style="width:100pt;display:none"><v:imagedata r:id="rVml1"/></v:shape></w:pict></w:r></w:p><w:sectPr/>',
    ),
    { media: { rVml1: PNG_A } },
  );
  const vmlHiddenIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", vmlHiddenDocx]]),
    ledger: emptyLedger(),
    materialStates: singleImgMatStates,
  });
  assert.ok(
    vmlHiddenIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
    `Expected VML display:none image to fail C17: ${JSON.stringify(vmlHiddenIssues)}`,
  );
  const vmlVisibleDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        '<w:p><w:r><w:pict><v:shape style="width:100pt"><v:imagedata r:id="rVml2"/></v:shape></w:pict></w:r></w:p><w:sectPr/>',
    ),
    { media: { rVml2: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", vmlVisibleDocx]]),
      ledger: emptyLedger(),
      materialStates: singleImgMatStates,
    }),
    [],
  );

  // 5c) DrawingML wp:docPr hidden="1" hides image (negative)
  const docPrHiddenDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Hidden" hidden="1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="a.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rDocPr1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr/>',
    ),
    { media: { rDocPr1: PNG_A } },
  );
  const docPrHiddenIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", docPrHiddenDocx]]),
    ledger: emptyLedger(),
    materialStates: singleImgMatStates,
  });
  assert.ok(
    docPrHiddenIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
    `Expected wp:docPr hidden="1" image to fail C17: ${JSON.stringify(docPrHiddenIssues)}`,
  );

  // 5d) Style inheritance cycle (A -> B -> A) fails closed with corrupt_draft instead of silently ignoring pStyle vanish;
  // normal 2-step toggle inheritance (Hidden -> ToggledVisible) resolves accurately!
  const cyclicStylesXml =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:styleId="HiddenPara"><w:rPr><w:vanish/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="CycleA"><w:basedOn w:val="CycleB"/></w:style>' +
    '<w:style w:type="character" w:styleId="CycleB"><w:basedOn w:val="CycleA"/></w:style>' +
    "</w:styles>";
  const cyclicStyleDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:pStyle w:val="HiddenPara"/></w:pPr><w:r><w:rPr><w:rStyle w:val="CycleA"/></w:rPr><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>',
    ),
    { stylesXml: cyclicStylesXml },
  );
  const cyclicStyleIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", cyclicStyleDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    cyclicStyleIssues.some((i) => i.kind === "corrupt_draft" && i.reason.includes("循环")),
    `Expected cyclic style inheritance to fail closed with corrupt_draft: ${JSON.stringify(cyclicStyleIssues)}`,
  );

  // Per MS-OI29500 (Word assignment semantics for paragraph styles) and conservative cross-consumer C17:
  // stacked <w:vanish/> in parent+child paragraph styles (or pStyle+rStyle) MUST stay hidden;
  // only explicit <w:vanish w:val="0"/> turns visibility back on.
  const vanishInheritanceStylesXml =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:styleId="HiddenPara"><w:rPr><w:vanish/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="DoubleVanishPara"><w:basedOn w:val="HiddenPara"/><w:rPr><w:vanish/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ExplicitVisiblePara"><w:basedOn w:val="HiddenPara"/><w:rPr><w:vanish w:val="0"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="HiddenChar2"><w:rPr><w:vanish/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="ExplicitVisibleChar"><w:rPr><w:vanish w:val="0"/></w:rPr></w:style>' +
    "</w:styles>";
  for (const bodyXml of [
    '<w:p><w:pPr><w:pStyle w:val="DoubleVanishPara"/></w:pPr><w:r><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>',
    '<w:p><w:pPr><w:pStyle w:val="HiddenPara"/></w:pPr><w:r><w:rPr><w:rStyle w:val="HiddenChar2"/></w:rPr><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>',
  ]) {
    const doubleVanishDocx = await buildMockDocx(doc(bodyXml), { stylesXml: vanishInheritanceStylesXml });
    const doubleVanishIssues = await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleHeadingOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", doubleVanishDocx]]),
      ledger: emptyLedger(),
    });
    assert.ok(
      doubleVanishIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
      `Expected stacked <w:vanish/> to remain hidden in C17: ${JSON.stringify(doubleVanishIssues)}`,
    );
  }
  for (const bodyXml of [
    '<w:p><w:pPr><w:pStyle w:val="ExplicitVisiblePara"/></w:pPr><w:r><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>',
    '<w:p><w:pPr><w:pStyle w:val="HiddenPara"/></w:pPr><w:r><w:rPr><w:rStyle w:val="ExplicitVisibleChar"/></w:rPr><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>',
  ]) {
    const explicitVisibleDocx = await buildMockDocx(doc(bodyXml), { stylesXml: vanishInheritanceStylesXml });
    assert.deepEqual(
      await checkOutlineConsistency({
        outlineState: { kind: "value", outline: singleHeadingOutline },
        confirmationStatus: "confirmed",
        workflowMode: "outline_first",
        drafts: new Map([["商务标", explicitVisibleDocx]]),
        ledger: emptyLedger(),
      }),
      [],
    );
  }

  // 5e) w:webHidden uses OOXML override inheritance (NOT toggle):
  // parent=on + child=off -> visible; parent=on + child=on -> stays hidden; parent=on + child=omitted -> hidden!
  const webHiddenStylesXml =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:styleId="WhParent"><w:rPr><w:webHidden/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="WhChildOff"><w:basedOn w:val="WhParent"/><w:rPr><w:webHidden w:val="0"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="WhChildOn"><w:basedOn w:val="WhParent"/><w:rPr><w:webHidden/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="WhChildInherit"><w:basedOn w:val="WhParent"/></w:style>' +
    "</w:styles>";
  const whChildOffDocx = await buildMockDocx(
    doc('<w:p><w:pPr><w:pStyle w:val="WhChildOff"/></w:pPr><w:r><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>'),
    { stylesXml: webHiddenStylesXml },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleHeadingOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", whChildOffDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );
  for (const styleId of ["WhChildOn", "WhChildInherit"] as const) {
    const whHiddenDocx = await buildMockDocx(
      doc(`<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>`),
      { stylesXml: webHiddenStylesXml },
    );
    const whIssues = await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleHeadingOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", whHiddenDocx]]),
      ledger: emptyLedger(),
    });
    assert.ok(
      whIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
      `Expected w:webHidden style ${styleId} to remain hidden: ${JSON.stringify(whIssues)}`,
    );
  }

  // 5f) Table style (w:tblStyle + default table style + w:tblStylePr conditional formatting) hides media & text in C17,
  //     while explicit w:vanish w:val="0" (conditional or direct run override) restores visibility
  const tblHiddenStylesXml =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="table" w:styleId="HiddenTbl"><w:rPr><w:vanish/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="ChildHiddenTbl"><w:basedOn w:val="HiddenTbl"/></w:style>' +
    '<w:style w:type="table" w:styleId="HiddenWebTbl"><w:rPr><w:webHidden/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="CondFirstRowHiddenTbl">' +
    '<w:tblStylePr w:type="firstRow"><w:rPr><w:vanish/></w:rPr></w:tblStylePr>' +
    '<w:tblStylePr w:type="firstCol"><w:rPr><w:vanish/></w:rPr></w:tblStylePr>' +
    "</w:style>" +
    '<w:style w:type="table" w:styleId="CondFirstRowVisibleTbl">' +
    "<w:rPr><w:vanish/></w:rPr>" +
    '<w:tblStylePr w:type="firstRow"><w:rPr><w:vanish w:val="0"/></w:rPr></w:tblStylePr>' +
    "</w:style>" +
    "</w:styles>";
  const wrapTblImage = (tblPr: string, rowXml: string) =>
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        `<w:tbl><w:tblPr>${tblPr}</w:tblPr>${rowXml}</w:tbl><w:sectPr/>`,
    );
  const bmImageRun = (rPr = "") => runWithProps(rPr, "rVis1", 1);

  // Whole-table vanish, inherited table style vanish, and table style webHidden all hide media -> missing_evidence
  for (const tblStyleId of ["HiddenTbl", "ChildHiddenTbl", "HiddenWebTbl"] as const) {
    const tblHiddenDocx = await buildMockDocx(
      wrapTblImage(
        `<w:tblStyle w:val="${tblStyleId}"/>`,
        `<w:tr><w:tc><w:p>${bmImageRun()}</w:p></w:tc></w:tr>`,
      ),
      { stylesXml: tblHiddenStylesXml, media: { rVis1: PNG_A } },
    );
    const tblIssues = await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", tblHiddenDocx]]),
      ledger: emptyLedger(),
      materialStates: singleImgMatStates,
    });
    assert.ok(
      tblIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
      `Expected table style ${tblStyleId} to hide media in C17: ${JSON.stringify(tblIssues)}`,
    );
  }

  // Default table style (w:default="1") hides media even when <w:tblStyle> is omitted
  const defaultHiddenTblStylesXml =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="table" w:default="1" w:styleId="DefaultHiddenTbl"><w:rPr><w:vanish/></w:rPr></w:style>' +
    "</w:styles>";
  const defaultHiddenTblDocx = await buildMockDocx(
    wrapTblImage("", `<w:tr><w:tc><w:p>${bmImageRun()}</w:p></w:tc></w:tr>`),
    { stylesXml: defaultHiddenTblStylesXml, media: { rVis1: PNG_A } },
  );
  const defaultTblIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", defaultHiddenTblDocx]]),
    ledger: emptyLedger(),
    materialStates: singleImgMatStates,
  });
  assert.ok(
    defaultTblIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
    `Expected default table style vanish to hide media in C17: ${JSON.stringify(defaultTblIssues)}`,
  );

  // Direct run <w:vanish w:val="0"/> overrides table style <w:vanish/> -> visible & passes C17
  const directOverrideTblDocx = await buildMockDocx(
    wrapTblImage(
      '<w:tblStyle w:val="HiddenTbl"/>',
      `<w:tr><w:tc><w:p>${bmImageRun('<w:rPr><w:vanish w:val="0"/></w:rPr>')}</w:p></w:tc></w:tr>`,
    ),
    { stylesXml: tblHiddenStylesXml, media: { rVis1: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", directOverrideTblDocx]]),
      ledger: emptyLedger(),
      materialStates: singleImgMatStates,
    }),
    [],
  );

  // Conditional table formatting: firstRow + firstCol both vanish -> cell (0,0) stays HIDDEN (no XOR cancellation),
  // whereas cell (1,1) in row 1 col 1 stays VISIBLE!
  const condCornerHiddenDocx = await buildMockDocx(
    wrapTblImage(
      '<w:tblStyle w:val="CondFirstRowHiddenTbl"/><w:tblLook w:firstRow="1" w:firstColumn="1" w:noHBand="1" w:noVBand="1"/>',
      `<w:tr><w:tc><w:p>${bmImageRun()}</w:p></w:tc><w:tc><w:p><w:r><w:t>头</w:t></w:r></w:p></w:tc></w:tr>` +
        "<w:tr><w:tc><w:p><w:r><w:t>左</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>内容</w:t></w:r></w:p></w:tc></w:tr>",
    ),
    { stylesXml: tblHiddenStylesXml, media: { rVis1: PNG_A } },
  );
  const condCornerIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", condCornerHiddenDocx]]),
    ledger: emptyLedger(),
    materialStates: singleImgMatStates,
  });
  assert.ok(
    condCornerIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
    `Expected firstRow+firstCol corner cell (0,0) to remain hidden: ${JSON.stringify(condCornerIssues)}`,
  );

  const condBodyVisibleDocx = await buildMockDocx(
    wrapTblImage(
      '<w:tblStyle w:val="CondFirstRowHiddenTbl"/><w:tblLook w:firstRow="1" w:firstColumn="1" w:noHBand="1" w:noVBand="1"/>',
      "<w:tr><w:tc><w:p><w:r><w:t>头</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>头2</w:t></w:r></w:p></w:tc></w:tr>" +
        `<w:tr><w:tc><w:p><w:r><w:t>左</w:t></w:r></w:p></w:tc><w:tc><w:p>${bmImageRun()}</w:p></w:tc></w:tr>`,
    ),
    { stylesXml: tblHiddenStylesXml, media: { rVis1: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", condBodyVisibleDocx]]),
      ledger: emptyLedger(),
      materialStates: singleImgMatStates,
    }),
    [],
  );

  // Conditional firstRow w:vanish="0" overrides whole-table vanish on row 0 (via explicit w:cnfStyle)
  const condUnhideRow0Docx = await buildMockDocx(
    wrapTblImage(
      '<w:tblStyle w:val="CondFirstRowVisibleTbl"/>',
      `<w:tr><w:tc><w:tcPr><w:cnfStyle w:val="100000000000"/></w:tcPr><w:p>${bmImageRun()}</w:p></w:tc></w:tr>`,
    ),
    { stylesXml: tblHiddenStylesXml, media: { rVis1: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", condUnhideRow0Docx]]),
      ledger: emptyLedger(),
      materialStates: singleImgMatStates,
    }),
    [],
  );

  // Table style also hides heading text inside table cells
  const hiddenTblHeadingDocx = await buildMockDocx(
    doc(
      '<w:tbl><w:tblPr><w:tblStyle w:val="HiddenTbl"/></w:tblPr>' +
        "<w:tr><w:tc><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/>",
    ),
    { stylesXml: tblHiddenStylesXml },
  );
  const hiddenTblHeadingIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", hiddenTblHeadingDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    hiddenTblHeadingIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
    `Expected table-style hidden heading text to fail C17: ${JSON.stringify(hiddenTblHeadingIssues)}`,
  );

  // 5g) R24 regression: w:tblStylePr w:type="wholeTable" hides headings and media (even with cnfStyle="000000000000"),
  //     while higher-precedence conditional formatting or direct <w:vanish w:val="0"/> restores visibility
  const wholeTableStylesXml =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="table" w:styleId="WholeTableHidden">' +
    '<w:tblStylePr w:type="wholeTable"><w:rPr><w:vanish/></w:rPr></w:tblStylePr>' +
    "</w:style>" +
    '<w:style w:type="table" w:styleId="WholeTableHiddenFirstRowVisible">' +
    '<w:tblStylePr w:type="wholeTable"><w:rPr><w:vanish/></w:rPr></w:tblStylePr>' +
    '<w:tblStylePr w:type="firstRow"><w:rPr><w:vanish w:val="0"/></w:rPr></w:tblStylePr>' +
    "</w:style>" +
    "</w:styles>";
  const wholeTblHeadingHiddenDocx = await buildMockDocx(
    doc(
      '<w:tbl><w:tblPr><w:tblStyle w:val="WholeTableHidden"/></w:tblPr>' +
        '<w:tr><w:tc><w:tcPr><w:cnfStyle w:val="000000000000"/></w:tcPr><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/>',
    ),
    { stylesXml: wholeTableStylesXml },
  );
  const wholeTblHeadingIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", wholeTblHeadingHiddenDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    wholeTblHeadingIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
    `Expected wholeTable w:vanish heading to fail C17: ${JSON.stringify(wholeTblHeadingIssues)}`,
  );
  const wholeTblMediaHiddenDocx = await buildMockDocx(
    wrapTblImage(
      '<w:tblStyle w:val="WholeTableHidden"/>',
      `<w:tr><w:tc><w:p>${bmImageRun()}</w:p></w:tc></w:tr>`,
    ),
    { stylesXml: wholeTableStylesXml, media: { rVis1: PNG_A } },
  );
  const wholeTblMediaIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", wholeTblMediaHiddenDocx]]),
    ledger: emptyLedger(),
    materialStates: singleImgMatStates,
  });
  assert.ok(
    wholeTblMediaIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
    `Expected wholeTable w:vanish media to fail C17: ${JSON.stringify(wholeTblMediaIssues)}`,
  );
  const wholeTblDirectVisibleDocx = await buildMockDocx(
    wrapTblImage(
      '<w:tblStyle w:val="WholeTableHidden"/>',
      `<w:tr><w:tc><w:p>${bmImageRun('<w:rPr><w:vanish w:val="0"/></w:rPr>')}</w:p></w:tc></w:tr>`,
    ),
    { stylesXml: wholeTableStylesXml, media: { rVis1: PNG_A } },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", wholeTblDirectVisibleDocx]]),
      ledger: emptyLedger(),
      materialStates: singleImgMatStates,
    }),
    [],
  );
  const wholeTblFirstRowVisibleDocx = await buildMockDocx(
    doc(
      '<w:tbl><w:tblPr><w:tblStyle w:val="WholeTableHiddenFirstRowVisible"/><w:tblLook w:firstRow="1"/></w:tblPr>' +
        "<w:tr><w:tc><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/>",
    ),
    { stylesXml: wholeTableStylesXml },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleHeadingOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", wholeTblFirstRowVisibleDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );

  // 5h) R25 regression: tracked-deleted paragraph mark (<w:pPr><w:rPr><w:del/>) merges consecutive paragraphs
  //     so body prose cannot spoof a standalone heading; dangling deleted mark before table fails closed as corrupt_draft;
  //     and deleted table row (<w:trPr><w:del/>) cannot supply headings or media!
  const deletedParaMarkMergeDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t>本节不提供</w:t></w:r></w:p>' +
        "<w:p><w:r><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>",
    ),
  );
  const deletedParaMarkIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", deletedParaMarkMergeDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    deletedParaMarkIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
    `Expected merged paragraph via w:pPr/w:rPr/w:del to fail standalone heading match: ${JSON.stringify(deletedParaMarkIssues)}`,
  );

  const danglingParaMarkBeforeTblDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:rPr><w:del w:id="2" w:author="a" w:date="2026-01-01T00:00:00Z"/></w:rPr></w:pPr><w:r><w:t>本节不提供</w:t></w:r></w:p>' +
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/>",
    ),
  );
  const danglingParaMarkIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", danglingParaMarkBeforeTblDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    danglingParaMarkIssues.some((i) => i.kind === "corrupt_draft"),
    `Expected unprojectable w:pPr/w:rPr/w:del before table to fail closed with corrupt_draft: ${JSON.stringify(danglingParaMarkIssues)}`,
  );

  const deletedTableRowDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>一、双页材料</w:t></w:r></w:p>" +
        '<w:tbl><w:tr><w:trPr><w:del w:id="3" w:author="a" w:date="2026-01-01T00:00:00Z"/></w:trPr>' +
        `<w:tc><w:p>${bmImageRun()}</w:p></w:tc></w:tr></w:tbl><w:sectPr/>`,
    ),
    { media: { rVis1: PNG_A } },
  );
  const deletedTableRowIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: altMatOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", deletedTableRowDocx]]),
    ledger: emptyLedger(),
    materialStates: singleImgMatStates,
  });
  assert.ok(
    deletedTableRowIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
    `Expected deleted table row (w:trPr/w:del) media to fail C17: ${JSON.stringify(deletedTableRowIssues)}`,
  );

  // 5i) R28 regression: conditional table-style hiding (firstRow w:vanish) still applies to rows/cells
  //     wrapped inside mc:AlternateContent Choice & Fallback (with inactive branches excluded from row numbering!)
  const altFirstRowHiddenDocx = await buildMockDocx(
    doc(
      '<w:tbl><w:tblPr><w:tblStyle w:val="CondFirstRowHiddenTbl"/><w:tblLook w:firstRow="1" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
        "<mc:AlternateContent>" +
        '<mc:Choice Requires="wps"><w:tr><w:tc><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></w:tc></w:tr></mc:Choice>' +
        "<mc:Fallback><w:tr><w:tc><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></w:tc></w:tr></mc:Fallback>" +
        "</mc:AlternateContent></w:tbl><w:sectPr/>",
    ),
    { stylesXml: tblHiddenStylesXml },
  );
  const altFirstRowIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: singleHeadingOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", altFirstRowHiddenDocx]]),
    ledger: emptyLedger(),
  });
  assert.ok(
    altFirstRowIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
    `Expected firstRow w:vanish inside mc:AlternateContent Choice/Fallback to remain hidden: ${JSON.stringify(altFirstRowIssues)}`,
  );

  // Positive control: row 1 (after visible row 0) inside mc:AlternateContent is NOT hidden by firstRow
  const altSecondRowVisibleDocx = await buildMockDocx(
    doc(
      '<w:tbl><w:tblPr><w:tblStyle w:val="CondFirstRowHiddenTbl"/><w:tblLook w:firstRow="1" w:noHBand="1" w:noVBand="1"/></w:tblPr>' +
        "<w:tr><w:tc><w:p><w:r><w:t>隐藏表头</w:t></w:r></w:p></w:tc></w:tr>" +
        "<mc:AlternateContent>" +
        '<mc:Choice Requires="wps"><w:tr><w:tc><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></w:tc></w:tr></mc:Choice>' +
        "<mc:Fallback><w:tr><w:tc><w:p><w:r><w:t>关键章节</w:t></w:r></w:p></w:tc></w:tr></mc:Fallback>" +
        "</mc:AlternateContent></w:tbl><w:sectPr/>",
    ),
    { stylesXml: tblHiddenStylesXml },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleHeadingOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", altSecondRowVisibleDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );

  // 5j) R29 regression: w:outlineLvl wrapped inside mc:AlternateContent Choice/Fallback truncates the
  //     preceding section identically to a direct w:outlineLvl (rejecting wrong-section evidence!)
  const directPeerTruncateDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>一、双页材料</w:t></w:r></w:p>' +
        '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>二、其他章节</w:t></w:r></w:p>' +
        `<w:p>${bmImageRun()}</w:p><w:sectPr/>`,
    ),
    { media: { rVis1: PNG_A } },
  );
  const mcWrappedPeerTruncateDocx = await buildMockDocx(
    doc(
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>一、双页材料</w:t></w:r></w:p>' +
        "<w:p><w:pPr><mc:AlternateContent>" +
        '<mc:Choice Requires="wps"><w:outlineLvl w:val="0"/></mc:Choice>' +
        '<mc:Fallback><w:outlineLvl w:val="0"/></mc:Fallback>' +
        "</mc:AlternateContent></w:pPr><w:r><w:t>二、其他章节</w:t></w:r></w:p>" +
        `<w:p>${bmImageRun()}</w:p><w:sectPr/>`,
    ),
    { media: { rVis1: PNG_A } },
  );
  for (const [label, sampleDocx] of [
    ["direct outlineLvl", directPeerTruncateDocx],
    ["mc:AlternateContent-wrapped outlineLvl", mcWrappedPeerTruncateDocx],
  ] as const) {
    const peerTruncateIssues = await checkOutlineConsistency({
      outlineState: { kind: "value", outline: altMatOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", sampleDocx]]),
      ledger: emptyLedger(),
      materialStates: singleImgMatStates,
    });
    assert.ok(
      peerTruncateIssues.some((i) => i.nodeId === "n-alt-mat" && i.kind === "missing_evidence"),
      `Expected ${label} on peer heading to truncate preceding section and reject misplaced evidence: ${JSON.stringify(peerTruncateIssues)}`,
    );
  }

  // 5k) R30 regression: mc:AlternateContent inside word/styles.xml is projected jointly with document.xml
  //     so <w:vanish/> wrapped inside mc:Choice / mc:Fallback in styles.xml still hides sections in C17!
  const mcWrappedStylesHiddenBoth =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<w:style w:type="paragraph" w:styleId="McHiddenPara"><w:rPr><mc:AlternateContent>' +
    '<mc:Choice Requires="wps"><w:vanish/></mc:Choice>' +
    "<mc:Fallback><w:vanish/></mc:Fallback>" +
    "</mc:AlternateContent></w:rPr></w:style>" +
    "</w:styles>";
  const directStylesHidden =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:style w:type="paragraph" w:styleId="McHiddenPara"><w:rPr><w:vanish/></w:rPr></w:style>' +
    "</w:styles>";
  for (const [label, stylesXml] of [
    ["direct styles.xml w:vanish", directStylesHidden],
    ["mc:AlternateContent-wrapped styles.xml w:vanish (both branches)", mcWrappedStylesHiddenBoth],
  ] as const) {
    const sampleDocx = await buildMockDocx(
      doc('<w:p><w:pPr><w:pStyle w:val="McHiddenPara"/></w:pPr><w:r><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>'),
      { stylesXml },
    );
    const mcStyleIssues = await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleHeadingOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", sampleDocx]]),
      ledger: emptyLedger(),
    });
    assert.ok(
      mcStyleIssues.some((i) => i.nodeId === "n-sec" && i.kind === "missing_section"),
      `Expected ${label} to hide heading in C17: ${JSON.stringify(mcStyleIssues)}`,
    );
  }
  // Positive control: styles.xml mc:AlternateContent where both branches explicitly set w:vanish="0" stays visible
  const mcWrappedStylesVisibleBoth =
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<w:style w:type="paragraph" w:styleId="BaseHide"><w:rPr><w:vanish/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="McVisiblePara"><w:basedOn w:val="BaseHide"/><w:rPr><mc:AlternateContent>' +
    '<mc:Choice Requires="wps"><w:vanish w:val="0"/></mc:Choice>' +
    '<mc:Fallback><w:vanish w:val="0"/></mc:Fallback>' +
    "</mc:AlternateContent></w:rPr></w:style>" +
    "</w:styles>";
  const mcVisibleDocx = await buildMockDocx(
    doc('<w:p><w:pPr><w:pStyle w:val="McVisiblePara"/></w:pPr><w:r><w:t>关键章节</w:t></w:r></w:p><w:sectPr/>'),
    { stylesXml: mcWrappedStylesVisibleBoth },
  );
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleHeadingOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", mcVisibleDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );

  // --- Case 6: Cross-section aggregate pending bookmark via real editBidDraft tracks exact citation sub-spans ---
  const cellTwoSectionsDocx = await buildMockDocx(
    doc(
      "<w:tbl><w:tr><w:tc>" +
        "<w:p><w:r><w:t>甲节 规范原文 占位甲</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>乙节 占位乙</w:t></w:r></w:p>" +
        "</w:tc></w:tr></w:tbl><w:sectPr/>",
    ),
  );
  const cellTwoSectionsOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-jia",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "甲节",
        expectedHeading: "甲节 规范原文 占位甲",
        kind: "authored",
        included: true,
        evidence: [
          { source: "material", ref: "materials/outline/spec.txt", label: "规范" },
          { source: "kb", ref: "rec-case", label: "业绩" },
        ],
      },
      {
        id: "n-yi",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "乙节",
        expectedHeading: "乙节 占位乙",
        kind: "authored",
        included: true,
      },
    ],
  };
  const cellFactContext: FactContext = {
    deadline: "2028-06-01",
    records: new Map([
      [
        "rec-case",
        {
          id: "rec-case",
          kind: "record",
          fields: { title: "示例业绩", type: "业绩", holder: "本企业" },
          body: "",
          verified: true,
          verifiedFields: ["title"],
          issues: [],
          validity: "valid",
          subject: "self",
        },
      ],
    ]),
    quotes: new Map([["materials/outline/spec.txt", "这里是规范原文全文"]]),
  };
  // Step 1: mark entire cell pending (creating one aggregate _Seal_P_* spanning both 甲节 and 乙节),
  // then write BOTH citations ONLY inside 乙节!
  const aggLedger = emptyLedger();
  const markOp: AgentEdit = {
    op: "mark_pending",
    at: "t:0/r:0/c:0",
    find: "甲节 规范原文 占位甲乙节 占位乙",
    pending: { category: "其他", note: "整格待核" },
  };
  const markRes = await editBidDraft({
    name: "商务标",
    old: cellTwoSectionsDocx,
    ledger: aggLedger,
    operations: [markOp],
    images: new Map(),
    markdownImages: new Map(),
  });
  const factRawExpr = "{{quote:materials/outline/spec.txt|规范原文}} {{record:rec-case.title}}";
  const resolvedFact = resolveFactReferences(factRawExpr, cellFactContext);
  const replaceYiOp: AgentEdit = {
    op: "replace",
    at: "t:0/r:0/c:0/p:1",
    find: "占位乙",
    value: resolvedFact.value,
  };
  const misplacedInYiRes = await editBidDraft({
    name: "商务标",
    old: markRes.output,
    ledger: markRes.ledger,
    operations: [replaceYiOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[replaceYiOp, resolvedFact]]),
  });
  // Update outline expected headings to match paragraphs after replacement
  const cellCheckOutlineAfterYi: OutlineDocument = {
    ...cellTwoSectionsOutline,
    nodes: [
      cellTwoSectionsOutline.nodes[0],
      { ...cellTwoSectionsOutline.nodes[1], expectedHeading: "乙节 规范原文 示例业绩" },
    ],
  };
  const misplacedInYiIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: cellCheckOutlineAfterYi },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", misplacedInYiRes.output]]),
    ledger: misplacedInYiRes.ledger,
    materialStates: textAltMatStates,
  });
  assert.ok(
    misplacedInYiIssues.some(
      (i) => i.nodeId === "n-jia" && i.kind === "missing_evidence" && i.source === "material" && i.reason.includes("其他章节"),
    ),
    `Expected cross-section aggregate pending quote in 乙节 to fail for 甲节 even when 甲节 already has literal text: ${JSON.stringify(misplacedInYiIssues)}`,
  );
  assert.ok(
    misplacedInYiIssues.some(
      (i) => i.nodeId === "n-jia" && i.kind === "missing_evidence" && i.source === "kb" && i.reason.includes("其他章节"),
    ),
    `Expected cross-section aggregate pending KB text in 乙节 to fail for 甲节: ${JSON.stringify(misplacedInYiIssues)}`,
  );

  // Positive control: writing BOTH citations inside 甲节 (inside the same aggregate pending bookmark) MUST PASS!
  const replaceJiaOp: AgentEdit = {
    op: "replace",
    at: "t:0/r:0/c:0/p:0",
    find: "占位甲",
    value: resolvedFact.value,
  };
  const validInJiaRes = await editBidDraft({
    name: "商务标",
    old: markRes.output,
    ledger: structuredClone(markRes.ledger),
    operations: [replaceJiaOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[replaceJiaOp, resolvedFact]]),
  });
  const cellCheckOutlineAfterJia: OutlineDocument = {
    ...cellTwoSectionsOutline,
    nodes: [
      { ...cellTwoSectionsOutline.nodes[0], expectedHeading: "甲节 规范原文 规范原文 示例业绩" },
      cellTwoSectionsOutline.nodes[1],
    ],
  };
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: cellCheckOutlineAfterJia },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", validInJiaRes.output]]),
      ledger: validInJiaRes.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );

  // Subsequent edit before the citation inside the same aggregate bookmark shifts rangeSpan accurately!
  const shiftPrefixOp: AgentEdit = {
    op: "replace",
    at: "t:0/r:0/c:0/p:0",
    find: "甲节",
    value: "甲节前缀",
  };
  const shiftedRes = await editBidDraft({
    name: "商务标",
    old: validInJiaRes.output,
    ledger: structuredClone(validInJiaRes.ledger),
    operations: [shiftPrefixOp],
    images: new Map(),
    markdownImages: new Map(),
  });
  const shiftedOutline: OutlineDocument = {
    ...cellTwoSectionsOutline,
    nodes: [
      { ...cellTwoSectionsOutline.nodes[0], expectedHeading: "甲节前缀 规范原文 规范原文 示例业绩" },
      cellTwoSectionsOutline.nodes[1],
    ],
  };
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: shiftedOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", shiftedRes.output]]),
      ledger: shiftedRes.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );

  // In-place rewrite with the EXACT same citation inside the aggregate bookmark MUST remain valid!
  const inPlaceFact = resolveFactReferences(factRawExpr, cellFactContext);
  const inPlaceOp: AgentEdit = {
    op: "replace",
    at: "t:0/r:0/c:0/p:0",
    find: "规范原文 示例业绩",
    value: inPlaceFact.value,
  };
  const inPlaceRes = await editBidDraft({
    name: "商务标",
    old: validInJiaRes.output,
    ledger: structuredClone(validInJiaRes.ledger),
    operations: [inPlaceOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[inPlaceOp, inPlaceFact]]),
  });
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: cellCheckOutlineAfterJia },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", inPlaceRes.output]]),
      ledger: inPlaceRes.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );

  // Structural delete of cited paragraph + prefix inside aggregate bookmark invalidates rangeSpan
  // so decoy identical prose in another section can NEVER masquerade as the deleted citation!
  const decoyCellDocx = await buildMockDocx(
    doc(
      "<w:tbl><w:tr><w:tc>" +
        "<w:p><w:r><w:t>开头</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>前缀段</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>甲节</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>占位甲</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>乙节</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>规范原文</w:t></w:r></w:p>" +
        "</w:tc></w:tr></w:tbl><w:sectPr/>",
    ),
  );
  const decoyOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-jia",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "甲节",
        kind: "authored",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/spec.txt", label: "规范" }],
      },
      {
        id: "n-yi",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "乙节",
        kind: "authored",
        included: true,
      },
    ],
  };
  const decoyMarkOp: AgentEdit = {
    op: "mark_pending",
    at: "t:0/r:0/c:0",
    find: "开头前缀段甲节占位甲乙节规范原文",
    pending: { category: "其他", note: "整格待核" },
  };
  const decoyMarked = await editBidDraft({
    name: "商务标",
    old: decoyCellDocx,
    ledger: emptyLedger(),
    operations: [decoyMarkOp],
    images: new Map(),
    markdownImages: new Map(),
  });
  const decoyQuoteFact = resolveFactReferences("{{quote:materials/outline/spec.txt|规范原文}}", cellFactContext);
  const decoyCiteOp: AgentEdit = {
    op: "replace",
    at: "t:0/r:0/c:0/p:3",
    find: "占位甲",
    value: decoyQuoteFact.value,
  };
  const decoyCited = await editBidDraft({
    name: "商务标",
    old: decoyMarked.output,
    ledger: decoyMarked.ledger,
    operations: [decoyCiteOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[decoyCiteOp, decoyQuoteFact]]),
  });
  // Sanity: before deletion, citation in 甲节 passes!
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: decoyOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", decoyCited.output]]),
      ledger: decoyCited.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );
  // Deleting ONLY the prefix paragraph (p:1) shifts rangeSpan accurately -> still passes!
  const prefixDeleted = await editBidDraft({
    name: "商务标",
    old: decoyCited.output,
    ledger: structuredClone(decoyCited.ledger),
    operations: [{ op: "delete", at: "t:0/r:0/c:0/p:1" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: decoyOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", prefixDeleted.output]]),
      ledger: prefixDeleted.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );
  // Deleting BOTH the cited paragraph (p:3) AND prefix paragraph (p:1) must invalidate rangeSpan
  // so decoy "规范原文" under 乙节 CANNOT spoof 甲节!
  const citedDeleted = await editBidDraft({
    name: "商务标",
    old: decoyCited.output,
    ledger: structuredClone(decoyCited.ledger),
    operations: [
      { op: "delete", at: "t:0/r:0/c:0/p:3" },
      { op: "delete", at: "t:0/r:0/c:0/p:1" },
    ],
    images: new Map(),
    markdownImages: new Map(),
  });
  const citedDeletedIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: decoyOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", citedDeleted.output]]),
    ledger: citedDeleted.ledger,
    materialStates: textAltMatStates,
  });
  assert.ok(
    citedDeletedIssues.some(
      (i) => i.nodeId === "n-jia" && i.kind === "missing_evidence" && i.source === "material",
    ),
    `Expected structural delete of cited paragraph to invalidate rangeSpan despite decoy text in 乙节: ${JSON.stringify(citedDeletedIssues)}`,
  );

  // --- Case 6b: Disabled (included:false) peer outline heading still terminates preceding section's boundary ---
  const disabledPeerOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-jia",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "甲节",
        kind: "authored",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/spec.txt", label: "规范" }],
      },
      {
        id: "n-yi-disabled",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "乙节",
        kind: "authored",
        included: false,
      },
    ],
  };
  const disabledPeerDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>甲节</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>乙节</w:t></w:r></w:p>" +
        '<w:p><w:bookmarkStart w:id="1" w:name="_Seal_F_fq1"/><w:r><w:t>规范原文</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p><w:sectPr/>',
    ),
  );
  const disabledPeerIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: disabledPeerOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", disabledPeerDocx]]),
    ledger: textAltLedger,
    materialStates: textAltMatStates,
  });
  assert.ok(
    disabledPeerIssues.some(
      (i) => i.nodeId === "n-jia" && i.kind === "missing_evidence" && i.source === "material" && i.reason.includes("其他章节"),
    ),
    `Expected disabled (included:false) peer section heading in draft to terminate 甲节 span: ${JSON.stringify(disabledPeerIssues)}`,
  );

  // --- Case 6c: Plain paragraph insert inside cross-paragraph _Seal_F_* fact bookmark shifts rangeSpan accurately ---
  const crossParaFactDocx = await buildMockDocx(
    doc(
      "<w:tbl><w:tr><w:tc>" +
        "<w:p><w:r><w:t>甲节</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>占位</w:t></w:r></w:p>" +
        "</w:tc></w:tr></w:tbl><w:sectPr/>",
    ),
  );
  const crossParaFactExpr = resolveFactReferences("甲节{{quote:materials/outline/spec.txt|规范原文}}", cellFactContext);
  const crossParaFactReplaceOp: AgentEdit = {
    op: "replace",
    at: "t:0/r:0/c:0",
    find: "甲节占位",
    value: crossParaFactExpr.value,
  };
  const factCreated = await editBidDraft({
    name: "商务标",
    old: crossParaFactDocx,
    ledger: emptyLedger(),
    operations: [crossParaFactReplaceOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[crossParaFactReplaceOp, crossParaFactExpr]]),
  });
  const singleJiaOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-jia",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "甲节",
        kind: "authored",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/spec.txt", label: "规范" }],
      },
    ],
  };
  // Sanity: before insert, cross-paragraph _Seal_F_* passes C17
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleJiaOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", factCreated.output]]),
      ledger: factCreated.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );
  // Insert plain explanatory paragraph inside _Seal_F_* right after p:0 (before the citation in p:1!)
  const factAfterInsert = await editBidDraft({
    name: "商务标",
    old: factCreated.output,
    ledger: structuredClone(factCreated.ledger),
    operations: [{ op: "insert", at: "t:0/r:0/c:0/p:0", position: "after", markdown: "新插入说明" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: singleJiaOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", factAfterInsert.output]]),
      ledger: factAfterInsert.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );

  // --- Case 6d: Inserting an unverified KB citation inside _Seal_F_* promotes to _Seal_P_* pending + yellow highlight ---
  const unverifiedKbContext: FactContext = {
    deadline: "2028-06-01",
    records: new Map([
      [
        "rec-unverified",
        {
          id: "rec-unverified",
          kind: "record",
          fields: { title: "未核实业绩", type: "业绩", holder: "本企业" },
          body: "",
          verified: false,
          verifiedFields: [],
          issues: [],
          validity: "valid",
          subject: "self",
        },
      ],
    ]),
    quotes: new Map([
      ["materials/outline/jia.txt", "甲方原文内容"],
      ["materials/outline/yi.txt", "乙方原文内容"],
    ]),
  };
  const unvFactRes = resolveFactReferences("{{record:rec-unverified.title}}", unverifiedKbContext);
  const insertUnvInFactOp: AgentEdit = {
    op: "insert",
    at: "t:0/r:0/c:0/p:0",
    position: "after",
    markdown: unvFactRes.value,
  };
  const promotedFactRes = await editBidDraft({
    name: "商务标",
    old: factCreated.output,
    ledger: structuredClone(factCreated.ledger),
    operations: [insertUnvInFactOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[insertUnvInFactOp, unvFactRes]]),
  });
  assert.equal(promotedFactRes.ledger.pending.length, 1, "Unverified insert inside _Seal_F_* must create a pending record");
  assert.equal(promotedFactRes.ledger.fills[0].sealKind, "pending", "Unverified insert inside _Seal_F_* must promote fill sealKind to pending");
  const promotedDocXml = new TextDecoder().decode(
    (await validatePackageStructure(promotedFactRes.output)).get("word/document.xml")!,
  );
  assert.match(promotedDocXml, /_Seal_P_/, "Bookmark must be renamed from _Seal_F_ to _Seal_P_");
  assert.match(promotedDocXml, /<w:highlight w:val="yellow"\/>/, "Promoted pending range must carry yellow highlight");

  // --- Case 6e: Same-batch adjacent inserts after(p:0) and before(p:1) sharing original offset keep exact distinct post-batch rangeSpans ---
  const adjFactContext = unverifiedKbContext;
  const adjJiaFact = resolveFactReferences("{{quote:materials/outline/jia.txt|甲方原文}}", adjFactContext);
  const adjYiFact = resolveFactReferences("{{quote:materials/outline/yi.txt|乙方原文}}", adjFactContext);
  const adjAfterOp: AgentEdit = {
    op: "insert",
    at: "t:0/r:0/c:0/p:0",
    position: "after",
    markdown: adjJiaFact.value,
  };
  const adjBeforeOp: AgentEdit = {
    op: "insert",
    at: "t:0/r:0/c:0/p:1",
    position: "before",
    markdown: adjYiFact.value,
  };
  const adjRes = await editBidDraft({
    name: "商务标",
    old: factCreated.output,
    ledger: structuredClone(factCreated.ledger),
    operations: [adjAfterOp, adjBeforeOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([
      [adjAfterOp, adjJiaFact],
      [adjBeforeOp, adjYiFact],
    ]),
  });
  const adjOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-jia",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "甲节",
        kind: "authored",
        included: true,
        evidence: [
          { source: "material", ref: "materials/outline/jia.txt", label: "甲方材料" },
          { source: "material", ref: "materials/outline/yi.txt", label: "乙方材料" },
          { source: "material", ref: "materials/outline/spec.txt", label: "规范" },
        ],
      },
    ],
  };
  const adjMatStates = new Map<string, OutlineMaterialState>([
    ["materials/outline/jia.txt", { exists: true, readable: true, kind: "text" }],
    ["materials/outline/yi.txt", { exists: true, readable: true, kind: "text" }],
    ["materials/outline/spec.txt", { exists: true, readable: true, kind: "text" }],
  ]);
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: adjOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", adjRes.output]]),
      ledger: adjRes.ledger,
      materialStates: adjMatStates,
    }),
    [],
  );

  // --- Case 6f: Same-value replace and surrounding-only edits inside _Seal_P_* preserve rangeSpan, while altering cited text still invalidates ---
  const surroundingPendingDoc = await buildMockDocx(
    doc(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>甲节</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>说明：待填写</w:t></w:r></w:p><w:sectPr/>`,
    ),
  );
  const specQuoteFact = resolveFactReferences("{{quote:materials/outline/spec.txt|规范原文}}", cellFactContext);
  const seededPendingOp: AgentEdit = {
    op: "replace",
    at: "p:1",
    find: "待填写",
    value: specQuoteFact.value,
    pending: { category: "待核对", note: "需人工核对" },
  };
  const seededPending = await editBidDraft({
    name: "商务标",
    old: surroundingPendingDoc,
    ledger: emptyLedger(),
    operations: [seededPendingOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[seededPendingOp, specQuoteFact]]),
  });
  const specOnlyOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-jia",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "甲节",
        kind: "authored",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/spec.txt", label: "规范" }],
      },
    ],
  };
  // Sanity check before replace
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: specOnlyOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", seededPending.output]]),
      ledger: seededPending.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );
  // 1) Identical same-value replace inside _Seal_P_* must preserve rangeSpan
  const noopReplace = await editBidDraft({
    name: "商务标",
    old: seededPending.output,
    ledger: structuredClone(seededPending.ledger),
    operations: [{ op: "replace", at: "p:1", find: "规范原文", value: "规范原文" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: specOnlyOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", noopReplace.output]]),
      ledger: noopReplace.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );
  // 2) Adding a prefix around the cited text shifts rangeSpan cleanly
  const prefixAdded = await editBidDraft({
    name: "商务标",
    old: noopReplace.output,
    ledger: structuredClone(noopReplace.ledger),
    operations: [{ op: "replace", at: "p:1", find: "规范原文", value: "补充说明：规范原文" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.deepEqual(prefixAdded.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 5, end: 9 });
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: specOnlyOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", prefixAdded.output]]),
      ledger: prefixAdded.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );
  // 3) Modifying BOTH prefix and suffix around the cited text in one replace preserves citation & shifts rangeSpan
  const bothSidesEdited = await editBidDraft({
    name: "商务标",
    old: prefixAdded.output,
    ledger: structuredClone(prefixAdded.ledger),
    operations: [{ op: "replace", at: "p:1", find: "补充说明：规范原文", value: "注：规范原文（已核）" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.deepEqual(bothSidesEdited.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 2, end: 6 });
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: specOnlyOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", bothSidesEdited.output]]),
      ledger: bothSidesEdited.ledger,
      materialStates: textAltMatStates,
    }),
    [],
  );
  // 4) Inserting a character INSIDE the cited span still invalidates rangeSpan and triggers missing_evidence
  const innerTampered = await editBidDraft({
    name: "商务标",
    old: bothSidesEdited.output,
    ledger: structuredClone(bothSidesEdited.ledger),
    operations: [{ op: "replace", at: "p:1", find: "规范原文", value: "规范改原文" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.deepEqual(innerTampered.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: -1, end: -1 });
  const innerTamperedIssues = await checkOutlineConsistency({
    outlineState: { kind: "value", outline: specOnlyOutline },
    confirmationStatus: "confirmed",
    workflowMode: "outline_first",
    drafts: new Map([["商务标", innerTampered.output]]),
    ledger: innerTampered.ledger,
    materialStates: textAltMatStates,
  });
  assert.ok(innerTamperedIssues.some((issue) => issue.kind === "missing_evidence"));
  // 5) Same-batch prefix insertion + modifying the cited text must still invalidate the cited text
  const sameBatchTamper = await editBidDraft({
    name: "商务标",
    old: seededPending.output,
    ledger: structuredClone(seededPending.ledger),
    operations: [{ op: "replace", at: "p:1", find: "规范原文", value: "前缀规范改原文后缀" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.deepEqual(sameBatchTamper.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: -1, end: -1 });
  // 6) Modifying the first cited occurrence when an identical decoy string follows must invalidate (not slide onto decoy)
  const dupQuoteDoc = await buildMockDocx(
    doc(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>甲节</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>待填</w:t></w:r></w:p><w:sectPr/>`,
    ),
  );
  const dupQuoteFact = resolveFactReferences(
    "主项：{{quote:materials/outline/spec.txt|规范原文}}，附注：规范原文",
    cellFactContext,
  );
  const dupSeedOp: AgentEdit = {
    op: "replace",
    at: "p:1",
    find: "待填",
    value: dupQuoteFact.value,
    pending: { category: "待核对", note: "核对" },
  };
  const dupSeeded = await editBidDraft({
    name: "商务标",
    old: dupQuoteDoc,
    ledger: emptyLedger(),
    operations: [dupSeedOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[dupSeedOp, dupQuoteFact]]),
  });
  assert.deepEqual(dupSeeded.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 3, end: 7 });
  const dupTampered = await editBidDraft({
    name: "商务标",
    old: dupSeeded.output,
    ledger: structuredClone(dupSeeded.ledger),
    operations: [
      { op: "replace", at: "p:1", find: "主项：规范原文，附注：规范原文", value: "主项：已改内容，附注：规范原文" },
    ],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.deepEqual(dupTampered.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: -1, end: -1 });

  // --- Case 6g: E2E editBidDraft -> confirmPending -> sealLedger -> checkDraft C05 closure ---
  const c05Root = "/p0-c05-project";
  const c05Secret = new Uint8Array(32).fill(7);
  const c05Project = {
    format: "seal-project-1" as const,
    name: "p0-c05-test",
    deadline: "2028-06-01",
    vaultId: null,
    tenders: [],
    drafts: ["商务标"],
    createdAt: "2028-01-01",
  };
  const c05Context = { root: c05Root, vaultId: null, deadline: c05Project.deadline };
  const runC05Check = async (draft: Uint8Array, base: Uint8Array, ledger: BidLedger) => {
    const copy = structuredClone(ledger);
    copy.drafts["商务标"] = sha256Hex(draft);
    (copy.bases ??= {})["商务标"] = sha256Hex(base);
    await sealLedger(copy, c05Root, c05Secret);
    return (await checkDraft({} as HostPort, {
      name: "商务标",
      root: c05Root,
      draft,
      base,
      ledger: copy,
      project: c05Project,
      secret: c05Secret,
    })) as { results: { C04: Array<{ reason?: string }>; C05: Array<{ id: string; reason: string }> } };
  };

  // 1) R19 regression: inserting unverified citation inside _Seal_F_* promotes to _Seal_P_*;
  //    before human confirm: C04 blocks & C05 blocks ONLY for unverified source (NOT content changed);
  //    after human confirmPending: BOTH C04 and C05 become empty!
  const beforeConfirmReport = await runC05Check(promotedFactRes.output, crossParaFactDocx, promotedFactRes.ledger);
  assert.equal(beforeConfirmReport.results.C04.length, 1, "Unconfirmed promoted pending must block C04");
  assert.ok(
    beforeConfirmReport.results.C05.some((item) => item.reason === "事实来源未核实"),
    `Expected unverified-source C05 before confirm: ${JSON.stringify(beforeConfirmReport.results.C05)}`,
  );
  assert.ok(
    !beforeConfirmReport.results.C05.some((item) => item.reason === "事实引用内容已变化"),
    `Controlled insert must not trigger stale-content C05: ${JSON.stringify(beforeConfirmReport.results.C05)}`,
  );
  const confirmedPromotedLedger = structuredClone(promotedFactRes.ledger);
  await confirmPending(
    confirmedPromotedLedger,
    "商务标",
    confirmedPromotedLedger.pending[0].id,
    promotedDocXml,
    c05Context,
    c05Secret,
  );
  const afterConfirmReport = await runC05Check(promotedFactRes.output, crossParaFactDocx, confirmedPromotedLedger);
  assert.deepEqual(afterConfirmReport.results.C04, [], "Confirmed pending must clear C04");
  assert.deepEqual(afterConfirmReport.results.C05, [], "Confirmed controlled insert inside _Seal_F_* must clear C05");

  // 2) Unreferenced plain insert inside _Seal_F_* (Case 6c) must STILL trigger C05 content-changed
  const plainInsertReport = await runC05Check(factAfterInsert.output, crossParaFactDocx, factAfterInsert.ledger);
  assert.ok(
    plainInsertReport.results.C05.some((item) => item.reason === "事实引用内容已变化"),
    `Plain unreferenced insert inside _Seal_F_* must still trigger C05: ${JSON.stringify(plainInsertReport.results.C05)}`,
  );

  // 3) 100%-covered verified fact inserts inside _Seal_F_* (Case 6e) pass C04 & C05 cleanly
  const verifiedAdjReport = await runC05Check(adjRes.output, crossParaFactDocx, adjRes.ledger);
  assert.deepEqual(verifiedAdjReport.results.C04, []);
  assert.deepEqual(verifiedAdjReport.results.C05, []);

  // 4) Verified quote mixed with unreferenced prose inside _Seal_F_* must NOT bypass C05
  const smuggledProseFact = resolveFactReferences(
    "私自补充承诺：{{quote:materials/outline/jia.txt|甲方原文}}",
    adjFactContext,
  );
  const smuggledOp: AgentEdit = {
    op: "insert",
    at: "t:0/r:0/c:0/p:0",
    position: "after",
    markdown: smuggledProseFact.value,
  };
  const smuggledRes = await editBidDraft({
    name: "商务标",
    old: factCreated.output,
    ledger: structuredClone(factCreated.ledger),
    operations: [smuggledOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[smuggledOp, smuggledProseFact]]),
  });
  const smuggledReport = await runC05Check(smuggledRes.output, crossParaFactDocx, smuggledRes.ledger);
  assert.ok(
    smuggledReport.results.C05.some((item) => item.reason === "事实引用内容已变化"),
    `Unreferenced prose alongside verified quote inside _Seal_F_* must still trigger C05: ${JSON.stringify(smuggledReport.results.C05)}`,
  );

  // 5) Surrounding-only edit inside _Seal_P_* (bothSidesEdited) clears C04 & C05 after human confirm,
  //    while innerTampered STILL blocks C05 even after human confirm
  const bothSidesXml = new TextDecoder().decode(
    (await validatePackageStructure(bothSidesEdited.output)).get("word/document.xml")!,
  );
  const bothSidesConfirmedLedger = structuredClone(bothSidesEdited.ledger);
  await confirmPending(
    bothSidesConfirmedLedger,
    "商务标",
    bothSidesConfirmedLedger.pending[0].id,
    bothSidesXml,
    c05Context,
    c05Secret,
  );
  const bothSidesReport = await runC05Check(bothSidesEdited.output, surroundingPendingDoc, bothSidesConfirmedLedger);
  assert.deepEqual(bothSidesReport.results.C04, []);
  assert.deepEqual(bothSidesReport.results.C05, []);

  const innerTamperedXml = new TextDecoder().decode(
    (await validatePackageStructure(innerTampered.output)).get("word/document.xml")!,
  );
  const innerTamperedConfirmedLedger = structuredClone(innerTampered.ledger);
  await confirmPending(
    innerTamperedConfirmedLedger,
    "商务标",
    innerTamperedConfirmedLedger.pending[0].id,
    innerTamperedXml,
    c05Context,
    c05Secret,
  );
  const innerTamperedC05 = await runC05Check(innerTampered.output, surroundingPendingDoc, innerTamperedConfirmedLedger);
  assert.ok(
    innerTamperedC05.results.C05.some((item) => item.reason === "事实引用内容已变化"),
    `Tampering cited text must remain blocked by C05 even after confirmPending: ${JSON.stringify(innerTamperedC05.results.C05)}`,
  );

  // 6) R20 regression: CRLF fact citation surrounded by legal edit refreshes resolvedValue and clears C05 after human confirm
  const crlfFactContext: FactContext = {
    deadline: "2028-06-01",
    records: new Map(),
    quotes: new Map([["materials/outline/crlf.txt", "甲\r\n乙"]]),
  };
  const crlfDoc = await buildMockDocx(
    doc(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>甲节</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>待填</w:t></w:r></w:p><w:sectPr/>`,
    ),
  );
  const crlfQuoteFact = resolveFactReferences("{{quote:materials/outline/crlf.txt|甲\r\n乙}}", crlfFactContext);
  const crlfSeedOp: AgentEdit = {
    op: "replace",
    at: "p:1",
    find: "待填",
    value: crlfQuoteFact.value,
    pending: { category: "待核对", note: "换行引用核对" },
  };
  const crlfSeeded = await editBidDraft({
    name: "商务标",
    old: crlfDoc,
    ledger: emptyLedger(),
    operations: [crlfSeedOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[crlfSeedOp, crlfQuoteFact]]),
  });
  const crlfPrefixed = await editBidDraft({
    name: "商务标",
    old: crlfSeeded.output,
    ledger: structuredClone(crlfSeeded.ledger),
    operations: [{ op: "replace", at: "p:1", find: "甲\n乙", value: "前缀甲\n乙" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.equal(crlfPrefixed.ledger.fills[0]?.resolvedValue, "前缀甲\n乙");
  assert.deepEqual(crlfPrefixed.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 2, end: 5 });
  const crlfPrefixedXml = new TextDecoder().decode(
    (await validatePackageStructure(crlfPrefixed.output)).get("word/document.xml")!,
  );
  const crlfConfirmedLedger = structuredClone(crlfPrefixed.ledger);
  await confirmPending(
    crlfConfirmedLedger,
    "商务标",
    crlfConfirmedLedger.pending[0].id,
    crlfPrefixedXml,
    c05Context,
    c05Secret,
  );
  const crlfReport = await runC05Check(crlfPrefixed.output, crlfDoc, crlfConfirmedLedger);
  assert.deepEqual(crlfReport.results.C04, []);
  assert.deepEqual(crlfReport.results.C05, []);
  const crlfOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      {
        id: "n-jia",
        volume: "商务标",
        parentId: null,
        level: 1,
        title: "甲节",
        kind: "authored",
        included: true,
        evidence: [{ source: "material", ref: "materials/outline/crlf.txt", label: "换行规范" }],
      },
    ],
  };
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: crlfOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", crlfPrefixed.output]]),
      ledger: crlfConfirmedLedger,
      materialStates: new Map<string, OutlineMaterialState>([
        ["materials/outline/crlf.txt", { exists: true, readable: true, kind: "text" }],
      ]),
    }),
    [],
  );

  // 7) R21 regression: first partial fact fill inside an existing aggregate _Seal_P_* initializes resolvedValue to full bookmark text
  //    so C04 & C05 clear cleanly after human confirmPending
  const aggCellDoc = await buildMockDocx(
    doc(
      "<w:tbl><w:tr><w:tc>" +
        "<w:p><w:r><w:t>甲节</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>占位</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>乙节</w:t></w:r></w:p>" +
        "</w:tc></w:tr></w:tbl><w:sectPr/>",
    ),
  );
  const aggPendingMarked = await editBidDraft({
    name: "商务标",
    old: aggCellDoc,
    ledger: emptyLedger(),
    operations: [
      { op: "mark_pending", at: "t:0/r:0/c:0", find: "甲节占位乙节", pending: { category: "待核对", note: "整格待定" } },
    ],
    images: new Map(),
    markdownImages: new Map(),
  });
  const aggFirstFactOp: AgentEdit = {
    op: "replace",
    at: "t:0/r:0/c:0/p:1",
    find: "占位",
    value: specQuoteFact.value,
  };
  const aggFirstFilled = await editBidDraft({
    name: "商务标",
    old: aggPendingMarked.output,
    ledger: structuredClone(aggPendingMarked.ledger),
    operations: [aggFirstFactOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[aggFirstFactOp, specQuoteFact]]),
  });
  assert.equal(aggFirstFilled.ledger.fills[0]?.resolvedValue, "甲节规范原文乙节");
  assert.deepEqual(aggFirstFilled.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 2, end: 6 });
  const aggFirstXml = new TextDecoder().decode(
    (await validatePackageStructure(aggFirstFilled.output)).get("word/document.xml")!,
  );
  const aggConfirmedLedger = structuredClone(aggFirstFilled.ledger);
  await confirmPending(
    aggConfirmedLedger,
    "商务标",
    aggConfirmedLedger.pending[0].id,
    aggFirstXml,
    c05Context,
    c05Secret,
  );
  const aggC05Report = await runC05Check(aggFirstFilled.output, aggCellDoc, aggConfirmedLedger);
  assert.deepEqual(aggC05Report.results.C04, []);
  assert.deepEqual(aggC05Report.results.C05, []);
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: specOnlyOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", aggFirstFilled.output]]),
      ledger: aggConfirmedLedger,
      materialStates: textAltMatStates,
    }),
    [],
  );

  // 8) R23 regression: replacing an existing verified fact with a different verified fact
  //    supersedes the old source, refreshes resolvedValue, and clears C05 cleanly;
  //    whereas partial replacement of an existing source or mixing unreferenced prose still blocks C05
  const replaceFactContext: FactContext = {
    deadline: "2028-06-01",
    records: new Map(),
    quotes: new Map([["materials/outline/spec.txt", "旧证与新证与合同编号12345与99999"]]),
  };
  const replaceFactBaseDoc = await buildMockDocx(
    doc(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>甲节</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>待填</w:t></w:r></w:p><w:sectPr/>`,
    ),
  );
  const oldQuoteFact = resolveFactReferences("{{quote:materials/outline/spec.txt|旧证}}", replaceFactContext);
  const newQuoteFact = resolveFactReferences("{{quote:materials/outline/spec.txt|新证}}", replaceFactContext);
  const seedOldOp: AgentEdit = { op: "replace", at: "p:1", find: "待填", value: oldQuoteFact.value };
  const seededOldFact = await editBidDraft({
    name: "商务标",
    old: replaceFactBaseDoc,
    ledger: emptyLedger(),
    operations: [seedOldOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[seedOldOp, oldQuoteFact]]),
  });
  const replaceWithNewOp: AgentEdit = { op: "replace", at: "p:1", find: "旧证", value: newQuoteFact.value };
  const replacedWithNewFact = await editBidDraft({
    name: "商务标",
    old: seededOldFact.output,
    ledger: structuredClone(seededOldFact.ledger),
    operations: [replaceWithNewOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[replaceWithNewOp, newQuoteFact]]),
  });
  assert.equal(replacedWithNewFact.ledger.fills[0]?.resolvedValue, "新证");
  assert.equal(replacedWithNewFact.ledger.fills[0]?.sources?.length, 1);
  assert.deepEqual(replacedWithNewFact.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 0, end: 2 });
  const replacedFactReport = await runC05Check(
    replacedWithNewFact.output,
    replaceFactBaseDoc,
    replacedWithNewFact.ledger,
  );
  assert.deepEqual(replacedFactReport.results.C04, []);
  assert.deepEqual(replacedFactReport.results.C05, []);

  // Partial replacement of a longer verified quote ("合同编号12345" -> replace only "12345" with "99999")
  // must NOT supersede the corrupted outer source -> C05 still blocks!
  const longQuoteFact = resolveFactReferences("{{quote:materials/outline/spec.txt|合同编号12345}}", replaceFactContext);
  const tailQuoteFact = resolveFactReferences("{{quote:materials/outline/spec.txt|99999}}", replaceFactContext);
  const seedLongOp: AgentEdit = { op: "replace", at: "p:1", find: "待填", value: longQuoteFact.value };
  const seededLongFact = await editBidDraft({
    name: "商务标",
    old: replaceFactBaseDoc,
    ledger: emptyLedger(),
    operations: [seedLongOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[seedLongOp, longQuoteFact]]),
  });
  const partialReplaceOp: AgentEdit = { op: "replace", at: "p:1", find: "12345", value: tailQuoteFact.value };
  const partiallyReplaced = await editBidDraft({
    name: "商务标",
    old: seededLongFact.output,
    ledger: structuredClone(seededLongFact.ledger),
    operations: [partialReplaceOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[partialReplaceOp, tailQuoteFact]]),
  });
  const partialReplaceReport = await runC05Check(
    partiallyReplaced.output,
    replaceFactBaseDoc,
    partiallyReplaced.ledger,
  );
  assert.ok(
    partialReplaceReport.results.C05.some((item) => item.reason === "事实引用内容已变化"),
    `Partial replacement corrupting a verified quote must still trigger C05: ${JSON.stringify(partialReplaceReport.results.C05)}`,
  );

  // 9) R25 regression: insert + pending stamps exact rangeSpan so editing surrounding text + confirmPending clears C04 & C05
  const insertPendingBaseDoc = await buildMockDocx(
    doc(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>甲节</w:t></w:r></w:p><w:sectPr/>`),
  );
  const insertPendingFact = resolveFactReferences(
    "前缀{{quote:materials/outline/spec.txt|规范原文}}后缀",
    cellFactContext,
  );
  const insertPendingOp: AgentEdit = {
    op: "insert",
    at: "p:0",
    position: "after",
    markdown: insertPendingFact.value,
    pending: { category: "待核对", note: "插入待定段落" },
  };
  const insertedPending = await editBidDraft({
    name: "商务标",
    old: insertPendingBaseDoc,
    ledger: emptyLedger(),
    operations: [insertPendingOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[insertPendingOp, insertPendingFact]]),
  });
  assert.deepEqual(insertedPending.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 2, end: 6 });
  const editedSurroundingPending = await editBidDraft({
    name: "商务标",
    old: insertedPending.output,
    ledger: structuredClone(insertedPending.ledger),
    operations: [{ op: "replace", at: "p:1", find: "前缀", value: "新前缀" }],
    images: new Map(),
    markdownImages: new Map(),
  });
  assert.equal(editedSurroundingPending.ledger.fills[0]?.resolvedValue, "新前缀规范原文后缀");
  assert.deepEqual(editedSurroundingPending.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 3, end: 7 });
  const editedSurroundingXml = new TextDecoder().decode(
    (await validatePackageStructure(editedSurroundingPending.output)).get("word/document.xml")!,
  );
  const editedSurroundingConfirmedLedger = structuredClone(editedSurroundingPending.ledger);
  await confirmPending(
    editedSurroundingConfirmedLedger,
    "商务标",
    editedSurroundingConfirmedLedger.pending[0].id,
    editedSurroundingXml,
    c05Context,
    c05Secret,
  );
  const insertPendingReport = await runC05Check(
    editedSurroundingPending.output,
    insertPendingBaseDoc,
    editedSurroundingConfirmedLedger,
  );
  assert.deepEqual(insertPendingReport.results.C04, []);
  assert.deepEqual(insertPendingReport.results.C05, []);
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: specOnlyOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", editedSurroundingPending.output]]),
      ledger: editedSurroundingConfirmedLedger,
      materialStates: textAltMatStates,
    }),
    [],
  );

  // 10) R26 regression: damaged pending fact range (rangeSpan {-1,-1}, stale resolvedValue) cleanly recovers
  //     when the ENTIRE range is rebound to a valid fact reference and human-confirmed -> C04 & C05 clear;
  //     partial replacement or unreferenced full replacement still blocks C05!
  const recoverRebindOp: AgentEdit = {
    op: "replace",
    at: "p:1",
    find: "注：规范改原文（已核）",
    value: newQuoteFact.value,
  };
  const recoveredFill = await editBidDraft({
    name: "商务标",
    old: innerTampered.output,
    ledger: structuredClone(innerTampered.ledger),
    operations: [recoverRebindOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[recoverRebindOp, newQuoteFact]]),
  });
  assert.equal(recoveredFill.ledger.fills[0]?.resolvedValue, "新证");
  assert.equal(recoveredFill.ledger.fills[0]?.sources?.length, 1);
  assert.deepEqual(recoveredFill.ledger.fills[0]?.sources?.[0]?.rangeSpan, { start: 0, end: 2 });
  const recoveredXml = new TextDecoder().decode(
    (await validatePackageStructure(recoveredFill.output)).get("word/document.xml")!,
  );
  const recoveredConfirmedLedger = structuredClone(recoveredFill.ledger);
  await confirmPending(
    recoveredConfirmedLedger,
    "商务标",
    recoveredConfirmedLedger.pending[0].id,
    recoveredXml,
    c05Context,
    c05Secret,
  );
  const recoveredReport = await runC05Check(
    recoveredFill.output,
    surroundingPendingDoc,
    recoveredConfirmedLedger,
  );
  assert.deepEqual(recoveredReport.results.C04, []);
  assert.deepEqual(recoveredReport.results.C05, []);

  // Partial replace inside damaged range MUST NOT launder the broken fill even after confirmPending
  const partialRecoverOp: AgentEdit = {
    op: "replace",
    at: "p:1",
    find: "规范改原文",
    value: newQuoteFact.value,
  };
  const partialRecovered = await editBidDraft({
    name: "商务标",
    old: innerTampered.output,
    ledger: structuredClone(innerTampered.ledger),
    operations: [partialRecoverOp],
    images: new Map(),
    markdownImages: new Map(),
    facts: new Map<AgentEdit, FactResolution>([[partialRecoverOp, newQuoteFact]]),
  });
  const partialRecXml = new TextDecoder().decode(
    (await validatePackageStructure(partialRecovered.output)).get("word/document.xml")!,
  );
  const partialRecConfirmedLedger = structuredClone(partialRecovered.ledger);
  await confirmPending(
    partialRecConfirmedLedger,
    "商务标",
    partialRecConfirmedLedger.pending[0].id,
    partialRecXml,
    c05Context,
    c05Secret,
  );
  const partialRecReport = await runC05Check(
    partialRecovered.output,
    surroundingPendingDoc,
    partialRecConfirmedLedger,
  );
  assert.ok(
    partialRecReport.results.C05.some((item) => item.reason === "事实引用内容已变化"),
    `Partial replace inside damaged range must NOT clear C05: ${JSON.stringify(partialRecReport.results.C05)}`,
  );

  // 11) R27 P1 regression: ambiguous insert + pending with plain decoy text + same-value quote rejects explicitly
  //     (never fabricating a fake FactSource / rangeSpan on the plain text paragraph!)
  const ambiguousPendingFact = resolveFactReferences(
    "甲节普通文字：规范原文\n\n乙节真实引用：{{quote:materials/outline/spec.txt|规范原文}}",
    cellFactContext,
  );
  const ambiguousPendingOp: AgentEdit = {
    op: "insert",
    at: "p:0",
    position: "after",
    markdown: ambiguousPendingFact.value,
    pending: { category: "待核对", note: "歧义引用" },
  };
  await assert.rejects(
    editBidDraft({
      name: "商务标",
      old: insertPendingBaseDoc,
      ledger: emptyLedger(),
      operations: [ambiguousPendingOp],
      images: new Map(),
      markdownImages: new Map(),
      facts: new Map<AgentEdit, FactResolution>([[ambiguousPendingOp, ambiguousPendingFact]]),
    }),
    /无法唯一定位/,
  );

  // 12) R27 P2 regression: excluded chapter boundary is respected during anchor solving so solver picks
  //     the second parent anchor that actually contains the child chapter ("父章、排除章、父章、子章")
  const excludedBetweenDupParentsDocx = await buildMockDocx(
    doc(
      "<w:p><w:r><w:t>父章</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>排除章</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>父章</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>子章</w:t></w:r></w:p><w:sectPr/>",
    ),
  );
  const excludedBetweenDupParentsOutline: OutlineDocument = {
    format: "seal-outline-1",
    volumes: [{ name: "商务标" }],
    nodes: [
      { id: "n-p", volume: "商务标", parentId: null, level: 1, title: "父章", kind: "authored", included: true },
      { id: "n-c", volume: "商务标", parentId: "n-p", level: 2, title: "子章", kind: "authored", included: true },
      { id: "n-ex", volume: "商务标", parentId: null, level: 1, title: "排除章", kind: "authored", included: false },
    ],
  };
  assert.deepEqual(
    await checkOutlineConsistency({
      outlineState: { kind: "value", outline: excludedBetweenDupParentsOutline },
      confirmationStatus: "confirmed",
      workflowMode: "outline_first",
      drafts: new Map([["商务标", excludedBetweenDupParentsDocx]]),
      ledger: emptyLedger(),
    }),
    [],
  );
});

test("P0-5: SEAL_BID_SKILL stays concise, generic, and encodes verified anti-pitfall bidding rules", () => {
  const lines = SEAL_BID_SKILL.content.split("\n");
  assert.ok(lines.length <= 105, `SEAL_BID_SKILL grew too long (${lines.length} lines)`);
  assert.match(SEAL_BID_SKILL.content, /落款日与客观事实日分离/);
  assert.match(SEAL_BID_SKILL.content, /行首缩进空白/);
  assert.match(SEAL_BID_SKILL.content, /（如有）/);
  assert.match(SEAL_BID_SKILL.content, /内部整理表/);
  assert.match(SEAL_BID_SKILL.content, /跨分册|多册/);
  assert.match(SEAL_BID_SKILL.content, /区分“待核实”与“缺件”/);
  assert.match(SEAL_BID_SKILL.content, /不把机械检查通过等同于可直接交标/);
});
