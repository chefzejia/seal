import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  detectLibreOfficeStatus,
  findSofficeBinary,
  isPopplerPdfEngine,
  NodeHostPort,
} from "../src/shells/node-host.js";
import {
  extractPdfBytesPageTexts,
  extractPdfWithPdfium,
  renderPdfBytesToPngs,
} from "../src/shells/pdf-engine.js";
import { WorkbenchHost } from "../src/shells/dsh/workbench-host.js";
import { editTextDocument } from "../src/core/docx/text-document.js";
import { validateImageBytes, writeZip, readZip } from "../src/core/docx/zip.js";
import { zh, en } from "../src/shells/dsh/client-locale.js";

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

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

/** Build a real multi-page Unicode/Chinese PDF using Type0 + ToUnicode CMap (zero external tools). */
function buildChineseTextPdf(pages: string[]): Uint8Array {
  const objects: string[] = ["", ""];
  const uniqueChars: string[] = [];
  const codeByChar = new Map<string, number>();
  for (const pageText of pages) {
    for (const ch of pageText) {
      if (!codeByChar.has(ch)) {
        const code = uniqueChars.length + 1;
        uniqueChars.push(ch);
        codeByChar.set(ch, code);
      }
    }
  }
  const cmapEntries = uniqueChars
    .map((ch, idx) => {
      const code = idx + 1;
      const cp = ch.codePointAt(0)!;
      return `<${code.toString(16).padStart(4, "0")}> <${cp.toString(16).padStart(4, "0")}>`;
    })
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
  for (const pageText of pages) {
    const pageObj = objects.length + 1;
    const contentObj = pageObj + 1;
    kidRefs.push(`${pageObj} 0 R`);
    const lines = pageText.split("\n");
    const ops = ["BT", "/F1 14 Tf", "72 740 Td"];
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) ops.push("0 -22 Td");
      const hex = Array.from(lines[i]!)
        .map((ch) => codeByChar.get(ch)!.toString(16).padStart(4, "0"))
        .join("");
      ops.push(`<${hex}> Tj`);
    }
    ops.push("ET");
    const stream = ops.join("\n") + "\n";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kidRefs.join(" ")}] /Count ${pages.length} >>`;
  return buildPdfFromObjects(objects);
}

/** Build a pure image-only PDF with zero text operators (simulates a scanned certificate). */
function buildScannedPdf(pageCount = 1): Uint8Array {
  const objects: string[] = ["", ""];
  const pixels: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      pixels.push(x === 0 || y === 0 ? 0x26 : 0xd4, x === 0 || y === 0 ? 0x47 : 0x88, 0x66);
    }
  }
  const rawHex = Buffer.from(pixels).toString("hex") + ">";
  objects.push(
    `<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${rawHex.length} >>\nstream\n${rawHex}\nendstream`,
  );
  const kidRefs: string[] = [];
  for (let p = 0; p < pageCount; p++) {
    const pageObj = objects.length + 1;
    const contentObj = pageObj + 1;
    kidRefs.push(`${pageObj} 0 R`);
    const contentStream = "q\n360 0 0 480 100 180 cm\n/Im0 Do\nQ\n";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 3 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    objects.push(`<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream`);
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${kidRefs.join(" ")}] /Count ${pageCount} >>`;
  return buildPdfFromObjects(objects);
}

/** Build a PDF containing an electronic seal / form Widget (/Subtype /Widget with /AP << /N ... >>). */
function buildWidgetSealPdf(): Uint8Array {
  const apStream = "q\n0.85 0.08 0.08 rg\n0 0 180 180 re f\nQ\n";
  const pageContent = "BT\n/F1 14 Tf\n72 740 Td\n(Seal Contract) Tj\nET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R] /NeedAppearances false >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 6 0 R >> >> /Annots [4 0 R] /Contents 7 0 R >>",
    "<< /Type /Annot /Subtype /Widget /FT /Sig /T (CompanySeal) /Rect [180 340 360 520] /F 4 /P 3 0 R /AP << /N 5 0 R >> >>",
    `<< /Type /XObject /Subtype /Form /BBox [0 0 180 180] /Resources << >> /Length ${apStream.length} >>\nstream\n${apStream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${pageContent.length} >>\nstream\n${pageContent}endstream`,
  ];
  return buildPdfFromObjects(objects);
}

async function makeTocTestDocx(): Promise<Uint8Array> {
  const parts = new Map<string, Uint8Array>();
  parts.set(
    "_rels/.rels",
    enc(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    ),
  );
  parts.set(
    "[Content_Types].xml",
    enc(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        "</Types>",
    ),
  );
  parts.set(
    "word/styles.xml",
    enc(
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
        "</w:styles>",
    ),
  );
  parts.set(
    "word/_rels/document.xml.rels",
    enc(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        "</Relationships>",
    ),
  );
  parts.set(
    "word/document.xml",
    enc(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:pPr><w:outlineLvl w:val="9"/></w:pPr><w:r><w:t>目录</w:t></w:r></w:p>' +
        '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 投标函</w:t></w:r></w:p>' +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/></w:sectPr>' +
        "</w:body></w:document>",
    ),
  );
  return writeZip(parts);
}

test("M41 PDFium WASM: zero-Poppler Chinese text, scanned PDF, truncation, error handling, and concurrent mutex safety", async (t) => {
  const sandbox = path.resolve(".tmp", `m41-pdfium-${randomUUID()}`);
  await fs.mkdir(sandbox, { recursive: true });
  const prevPath = process.env.PATH;
  const prevEngine = process.env.SEAL_PDF_ENGINE;
  const prevInfo = process.env.SEAL_PDFINFO;
  const prevText = process.env.SEAL_PDFTOTEXT;
  const prevPpm = process.env.SEAL_PDFTOPPM;
  process.env.PATH = "";
  delete process.env.SEAL_PDF_ENGINE;
  delete process.env.SEAL_PDFINFO;
  delete process.env.SEAL_PDFTOTEXT;
  delete process.env.SEAL_PDFTOPPM;

  t.after(async () => {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevEngine === undefined) delete process.env.SEAL_PDF_ENGINE;
    else process.env.SEAL_PDF_ENGINE = prevEngine;
    if (prevInfo === undefined) delete process.env.SEAL_PDFINFO;
    else process.env.SEAL_PDFINFO = prevInfo;
    if (prevText === undefined) delete process.env.SEAL_PDFTOTEXT;
    else process.env.SEAL_PDFTOTEXT = prevText;
    if (prevPpm === undefined) delete process.env.SEAL_PDFTOPPM;
    else process.env.SEAL_PDFTOPPM = prevPpm;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  assert.equal(isPopplerPdfEngine(), false);
  const host = new NodeHostPort();

  const chinesePdfBytes = buildChineseTextPdf([
    "目录\n第一章 投标函 .... 1",
    "第一章 投标函\n报价金额：100万元",
    "第二章 技术方案\n交付周期：30天",
  ]);
  const chinesePdfPath = path.join(sandbox, "chinese-3p.pdf");
  const scannedPdfBytes = buildScannedPdf(2);
  const scannedPdfPath = path.join(sandbox, "scan-2p.pdf");
  const corruptPdfPath = path.join(sandbox, "corrupt.pdf");
  const emptyPdfPath = path.join(sandbox, "empty.pdf");
  await fs.writeFile(chinesePdfPath, chinesePdfBytes);
  await fs.writeFile(scannedPdfPath, scannedPdfBytes);
  await fs.writeFile(corruptPdfPath, enc("not-a-valid-pdf"));
  await fs.writeFile(emptyPdfPath, new Uint8Array());

  // 1. Chinese electronic PDF with maxPages truncation
  const chOut = path.join(sandbox, "ch-out");
  const chRes = await host.extractPdf(chinesePdfPath, chOut, { dpi: 120, maxPages: 2 });
  assert.equal(chRes.pageCount, 3);
  assert.equal(chRes.renderedPages, 2);
  assert.equal(chRes.truncatedPages, 1);
  assert.match(chRes.pages[0]!.text, /目录/);
  assert.match(chRes.pages[1]!.text, /第一章 投标函/);
  assert.match(chRes.pages[2]!.text, /第二章 技术方案/);
  assert.ok(chRes.pages[0]!.imagePath && chRes.pages[1]!.imagePath);
  assert.equal(chRes.pages[2]!.imagePath, undefined);
  for (const p of chRes.pages.slice(0, 2)) {
    assert.match(path.basename(p.imagePath!), /^page-\d+\.png$/);
    const dim = await validateImageBytes(await fs.readFile(p.imagePath!), "image/png");
    assert.ok(dim.widthPx > 0 && dim.heightPx > 0);
  }

  // 2. Pure image-only scanned PDF + real pixel color assertion (ensures non-blank render)
  const scanOut = path.join(sandbox, "scan-out");
  const scanRes = await host.extractPdf(scannedPdfPath, scanOut);
  assert.equal(scanRes.pageCount, 2);
  assert.equal(scanRes.renderedPages, 2);
  assert.equal(scanRes.truncatedPages, 0);
  assert.equal(scanRes.pages[0]!.text.trim(), "");
  assert.equal(scanRes.pages[1]!.text.trim(), "");
  for (const p of scanRes.pages) {
    const pngBytes = await fs.readFile(p.imagePath!);
    const dim = await validateImageBytes(pngBytes, "image/png");
    assert.ok(dim.widthPx > 0 && dim.heightPx > 0);
    const decoded = await sharp(pngBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let goldPixels = 0;
    let bluePixels = 0;
    let whitePixels = 0;
    for (let idx = 0; idx < decoded.data.length; idx += 4) {
      const r = decoded.data[idx]!;
      const g = decoded.data[idx + 1]!;
      const b = decoded.data[idx + 2]!;
      if (r >= 245 && g >= 245 && b >= 245) whitePixels++;
      else if (r >= 180 && g >= 110 && g <= 165 && b <= 130) goldPixels++;
      else if (r <= 65 && g >= 50 && g <= 95 && b >= 80) bluePixels++;
    }
    assert.ok(whitePixels > 10_000, `Expected white background pixels, got ${whitePixels}`);
    assert.ok(goldPixels > 10_000, `Expected gold/orange seal pixels, got ${goldPixels}`);
    assert.ok(bluePixels > 5_000, `Expected blue border pixels, got ${bluePixels}`);
  }

  // 2b. Electronic signature / form Widget appearance stream (/Subtype /Widget + /AP << /N ... >>)
  const widgetPdfBytes = buildWidgetSealPdf();
  const widgetPdfPath = path.join(sandbox, "widget-seal.pdf");
  await fs.writeFile(widgetPdfPath, widgetPdfBytes);
  const widgetRes = await host.extractPdf(widgetPdfPath, path.join(sandbox, "widget-out"), { dpi: 110 });
  assert.equal(widgetRes.pageCount, 1);
  assert.match(widgetRes.pages[0]!.text, /Seal Contract/);
  const widgetPngBytes = await fs.readFile(widgetRes.pages[0]!.imagePath!);
  await validateImageBytes(widgetPngBytes, "image/png");
  const widgetDecoded = await sharp(widgetPngBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let widgetRedPixels = 0;
  let widgetWhitePixels = 0;
  for (let idx = 0; idx < widgetDecoded.data.length; idx += 4) {
    const r = widgetDecoded.data[idx]!;
    const g = widgetDecoded.data[idx + 1]!;
    const b = widgetDecoded.data[idx + 2]!;
    if (r >= 245 && g >= 245 && b >= 245) widgetWhitePixels++;
    else if (r >= 190 && g <= 45 && b <= 45) widgetRedPixels++;
  }
  assert.ok(widgetWhitePixels > 10_000, `Expected white background on widget PDF, got ${widgetWhitePixels}`);
  assert.ok(
    widgetRedPixels > 10_000,
    `Expected red electronic seal (/Subtype /Widget) pixels with renderFormFields:true, got ${widgetRedPixels}`,
  );

  // 3. Invalid inputs and corrupt/empty PDF errors
  await assert.rejects(host.extractPdf(corruptPdfPath, path.join(sandbox, "bad-out")), /无法解析 PDF/);
  await assert.rejects(host.extractPdf(emptyPdfPath, path.join(sandbox, "empty-out")), /无法解析 PDF/);
  await assert.rejects(
    host.extractPdf(chinesePdfPath, path.join(sandbox, "bad-dpi"), { dpi: 10 }),
    /DPI 参数无效/,
  );
  await assert.rejects(
    host.extractPdf(chinesePdfPath, path.join(sandbox, "bad-max"), { maxPages: 0 }),
    /最大渲染页数参数无效/,
  );

  // 4. Direct renderPdfBytesToPngs & extractPdfBytesPageTexts with PATH=""
  const pngOut = path.join(sandbox, "direct-pngs");
  const pngFiles = await renderPdfBytesToPngs(chinesePdfBytes, pngOut);
  assert.equal(pngFiles.length, 3);
  assert.deepEqual(
    pngFiles.map((f) => path.basename(f)),
    ["page-001.png", "page-002.png", "page-003.png"],
  );
  const pageTexts = await extractPdfBytesPageTexts(chinesePdfBytes);
  assert.equal(pageTexts.length, 3);
  assert.match(pageTexts[1]!, /报价金额：100万元/);

  // 5. Concurrent Promise.all mixing text PDF, scanned PDF, and corrupt PDF to prove mutex safety
  const concurrentResults = await Promise.allSettled([
    extractPdfWithPdfium(chinesePdfBytes, path.join(sandbox, "conc-1"), { dpi: 96 }),
    extractPdfBytesPageTexts(chinesePdfBytes),
    renderPdfBytesToPngs(scannedPdfBytes, path.join(sandbox, "conc-2"), { dpi: 110 }),
    extractPdfWithPdfium(enc("corrupt"), path.join(sandbox, "conc-bad")),
    extractPdfWithPdfium(chinesePdfBytes, path.join(sandbox, "conc-3"), { dpi: 96 }),
    extractPdfBytesPageTexts(scannedPdfBytes),
  ]);
  assert.equal(concurrentResults[0]!.status, "fulfilled");
  assert.equal(concurrentResults[1]!.status, "fulfilled");
  assert.equal(concurrentResults[2]!.status, "fulfilled");
  assert.equal(concurrentResults[3]!.status, "rejected");
  assert.equal(concurrentResults[4]!.status, "fulfilled");
  assert.equal(concurrentResults[5]!.status, "fulfilled");
  if (concurrentResults[0]!.status === "fulfilled") assert.equal(concurrentResults[0]!.value.pageCount, 3);
  if (concurrentResults[4]!.status === "fulfilled") assert.equal(concurrentResults[4]!.value.pageCount, 3);

  // 6. Real soffice + PDFium renderDocxPages & extractDocxPageTexts (with zero Poppler PATH)
  const soffice = findSofficeBinary(process.platform, { ...process.env, PATH: prevPath ?? "" });
  let sofficeReady = false;
  const probeProfile = await fs.mkdtemp(path.join(os.tmpdir(), "seal-m41-probe-"));
  try {
    execFileSync(soffice, [`-env:UserInstallation=${pathToFileURL(probeProfile).href}`, "--headless", "--version"], {
      stdio: "pipe",
      timeout: 15_000,
    });
    sofficeReady = true;
  } catch {
    sofficeReady = false;
  } finally {
    await fs.rm(probeProfile, { recursive: true, force: true });
  }
  if (sofficeReady) {
    const prevSoffice = process.env.SEAL_SOFFICE;
    process.env.SEAL_SOFFICE = soffice;
    try {
      const docxBytes = await makeTocTestDocx();
      const docxFile = path.join(sandbox, "toc-test.docx");
      await fs.writeFile(docxFile, docxBytes);
      const renderedPngs = await host.renderDocxPages(docxFile, path.join(sandbox, "docx-preview"));
      assert.ok(renderedPngs.length >= 2);
      for (const png of renderedPngs) {
        assert.match(path.basename(png), /^page-\d+\.png$/);
        await validateImageBytes(await fs.readFile(png), "image/png");
      }
      const edited = await editTextDocument(docxBytes, [{ op: "insert_toc", at: "p:0", position: "after" }], host);
      const editedParts = await readZip(edited);
      const editedXml = dec(editedParts.get("word/document.xml")!);
      assert.match(editedXml, /PAGEREF _TocSeal_1 \\h[\s\S]*?<w:t>2<\/w:t>/);
    } finally {
      if (prevSoffice === undefined) delete process.env.SEAL_SOFFICE;
      else process.env.SEAL_SOFFICE = prevSoffice;
    }
  }
});

test("M41 cross-platform findSofficeBinary & detectLibreOfficeStatus matrix", () => {
  // 1. SEAL_SOFFICE override
  assert.equal(findSofficeBinary("darwin", { SEAL_SOFFICE: "/custom/soffice" }, () => true), "/custom/soffice");
  assert.deepEqual(detectLibreOfficeStatus("darwin", { SEAL_SOFFICE: "/custom/soffice" }, () => true), {
    available: true,
    binaryPath: "/custom/soffice",
  });
  assert.deepEqual(detectLibreOfficeStatus("darwin", { SEAL_SOFFICE: "/nonexistent/soffice" }, () => false), {
    available: false,
    binaryPath: null,
  });

  // 2. Windows: ProgramFiles, ProgramFiles(x86), LOCALAPPDATA, PATH, and missing fallback
  const winPF = "D:\\Apps\\LibreOffice\\program\\soffice.exe";
  assert.equal(
    findSofficeBinary("win32", { ProgramFiles: "D:\\Apps" }, (p) => p === winPF),
    winPF,
  );
  const winPF86Custom = "D:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe";
  assert.deepEqual(
    detectLibreOfficeStatus(
      "win32",
      { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "D:\\Program Files (x86)" },
      (p) => p === winPF86Custom,
    ),
    { available: true, binaryPath: winPF86Custom },
  );
  const winPF86Fallback = "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe";
  assert.deepEqual(
    detectLibreOfficeStatus("win32", {}, (p) => p === winPF86Fallback),
    { available: true, binaryPath: winPF86Fallback },
  );
  const winLocal = "C:\\Users\\alice\\AppData\\Local\\Programs\\LibreOffice\\program\\soffice.exe";
  assert.equal(
    findSofficeBinary("win32", { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" }, (p) => p === winLocal),
    winLocal,
  );
  const winPathExe = "E:\\Tools\\LO\\soffice.com";
  assert.deepEqual(
    detectLibreOfficeStatus("win32", { PATH: "E:\\Missing;\"E:\\Tools\\LO\"" }, (p) => p === winPathExe),
    { available: true, binaryPath: winPathExe },
  );
  assert.equal(findSofficeBinary("win32", {}, () => false), "soffice.exe");
  assert.deepEqual(detectLibreOfficeStatus("win32", {}, () => false), { available: false, binaryPath: null });

  // 3. macOS: homebrew, /usr/local, /Applications, PATH, missing
  for (const macBin of [
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ]) {
    assert.deepEqual(detectLibreOfficeStatus("darwin", {}, (p) => p === macBin), {
      available: true,
      binaryPath: macBin,
    });
  }
  assert.equal(
    findSofficeBinary("darwin", { PATH: "/bin:/custom/lo/bin" }, (p) => p === "/custom/lo/bin/soffice"),
    "/custom/lo/bin/soffice",
  );
  assert.equal(findSofficeBinary("darwin", {}, () => false), "soffice");
  assert.deepEqual(detectLibreOfficeStatus("darwin", {}, () => false), { available: false, binaryPath: null });

  // 4. Linux: /usr/bin, /usr/local/bin, /snap/bin, PATH, missing
  for (const linuxBin of ["/usr/bin/soffice", "/usr/local/bin/soffice", "/snap/bin/libreoffice"]) {
    assert.deepEqual(detectLibreOfficeStatus("linux", {}, (p) => p === linuxBin), {
      available: true,
      binaryPath: linuxBin,
    });
  }
  assert.equal(
    findSofficeBinary("linux", { PATH: "/opt/lo/bin" }, (p) => p === "/opt/lo/bin/soffice"),
    "/opt/lo/bin/soffice",
  );
  assert.equal(findSofficeBinary("linux", {}, () => false), "soffice");
  assert.deepEqual(detectLibreOfficeStatus("linux", {}, () => false), { available: false, binaryPath: null });
});

test("M41 WorkbenchHost.status() & overview() report environment and locale banner keys exist", async (t) => {
  const sandbox = path.resolve(".tmp", `m41-env-${randomUUID()}`);
  await fs.mkdir(sandbox, { recursive: true });
  const prevHome = process.env.SEAL_HOME;
  const prevSoffice = process.env.SEAL_SOFFICE;
  const prevEngine = process.env.SEAL_PDF_ENGINE;
  process.env.SEAL_HOME = path.join(sandbox, "seal-home");

  t.after(async () => {
    if (prevHome === undefined) delete process.env.SEAL_HOME;
    else process.env.SEAL_HOME = prevHome;
    if (prevSoffice === undefined) delete process.env.SEAL_SOFFICE;
    else process.env.SEAL_SOFFICE = prevSoffice;
    if (prevEngine === undefined) delete process.env.SEAL_PDF_ENGINE;
    else process.env.SEAL_PDF_ENGINE = prevEngine;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const service = new WorkbenchHost(new NodeHostPort());

  // Missing LibreOffice case
  process.env.SEAL_SOFFICE = path.join(sandbox, "missing-soffice");
  delete process.env.SEAL_PDF_ENGINE;
  const missingStatus = await service.status();
  const missingOverview = await service.overview();
  assert.equal(missingStatus.environment.platform, process.platform);
  assert.equal(missingStatus.environment.pdfEngine, "builtin-pdfium");
  assert.deepEqual(missingStatus.environment.libreOffice, { available: false, binaryPath: null });
  assert.deepEqual(missingOverview.environment, missingStatus.environment);

  // Present LibreOffice + poppler override case
  const fakeSoffice = path.join(sandbox, "fake-soffice");
  await fs.writeFile(fakeSoffice, "#!/bin/sh\n");
  process.env.SEAL_SOFFICE = fakeSoffice;
  process.env.SEAL_PDF_ENGINE = "poppler";
  const presentStatus = await service.status();
  const presentOverview = await service.overview();
  assert.equal(presentStatus.environment.pdfEngine, "poppler");
  assert.deepEqual(presentStatus.environment.libreOffice, { available: true, binaryPath: fakeSoffice });
  assert.deepEqual(presentOverview.environment, presentStatus.environment);

  // Locale banner strings present in zh & en
  for (const key of ["libreOfficeMissingTitle", "libreOfficeMissingDesc", "libreOfficeDownload", "dismissNotice"] as const) {
    assert.ok(zh[key].length > 0, `zh.${key}`);
    assert.ok(en[key].length > 0, `en.${key}`);
  }
});

test("M41 Market Index: buildMarketIndex merges SemVer descending & passes real DSH parseMarketIndex + marketInstallTarget", async (t) => {
  const sandbox = path.resolve(".tmp", `m41-mkt-${randomUUID()}`);
  await fs.mkdir(sandbox, { recursive: true });
  const envKeys = [
    "SEAL_MARKET_OUT_DIR",
    "SEAL_MARKET_BASE_URL",
    "SEAL_NPM_REGISTRY",
    "SEAL_MARKET_PUBLISH_TIMESTAMP",
    "SEAL_DSH_ARTIFACT",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  t.after(async () => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  // Use an existing dist TGZ if available or build one cleanly in test
  let artifact = savedEnv.SEAL_DSH_ARTIFACT;
  if (!artifact) {
    const distFiles = fsSync.existsSync("dist")
      ? fsSync.readdirSync("dist").filter((f) => /^seal-dsh-\d+\.\d+\.\d+\.tgz$/.test(f)).sort()
      : [];
    if (distFiles.length > 0) {
      artifact = path.resolve("dist", distFiles[distFiles.length - 1]!);
    } else {
      const stdout = execFileSync(process.execPath, ["scripts/build-dsh-bundle.mjs"], { encoding: "utf8" });
      artifact = stdout.trim().split("\n").at(-1)!;
    }
  }

  const outDir = path.join(sandbox, "market");
  await fs.mkdir(outDir, { recursive: true });
  // Seed an older historical version in outDir/index.json to verify SemVer descending merge
  const pkgJson = JSON.parse(execFileSync("tar", ["-xOzf", artifact, "package/package.json"], { encoding: "utf8" }));
  await fs.writeFile(
    path.join(outDir, "index.json"),
    JSON.stringify({
      format: 1,
      title: { en: "Old" },
      plugins: [
        {
          name: pkgJson.name,
          versions: [
            { version: "0.1.1", publishTimestamp: 1700000000, source: { type: "npm" }, engines: { dsh: ">=0.2.2-rc.5 <0.3.0" } },
          ],
        },
      ],
    }),
  );

  const baseUrl = "https://raw.githubusercontent.com/chefzejia/seal/main/market/";
  const builtOut = execFileSync(process.execPath, ["scripts/build-market-index.mjs"], {
    env: {
      ...process.env,
      SEAL_DSH_ARTIFACT: artifact,
      SEAL_MARKET_OUT_DIR: outDir,
      SEAL_MARKET_BASE_URL: baseUrl,
      SEAL_NPM_REGISTRY: "https://registry.npmjs.org",
      SEAL_MARKET_PUBLISH_TIMESTAMP: "1764000000",
    },
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  const indexPath = path.join(outDir, "index.json");
  assert.equal(path.resolve(builtOut), path.resolve(indexPath));
  const indexData = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(indexData.format, 1);
  assert.equal(indexData.plugins.length, 1);
  assert.equal(indexData.plugins[0].versions.length, pkgJson.version === "0.1.1" ? 1 : 2);
  assert.equal(indexData.plugins[0].versions[0].version, pkgJson.version);
  assert.equal(indexData.plugins[0].versions[0].publishTimestamp, 1764000000);
  assert.equal(indexData.plugins[0].versions[0].source.registry, "https://registry.npmjs.org/");
  assert.ok(fsSync.existsSync(path.join(outDir, "icon.svg")));

  // Negative controls on built-in CLI validator (spawned script rejects invalid SEAL_NPM_REGISTRY)
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/build-market-index.mjs"], {
        env: {
          ...process.env,
          SEAL_DSH_ARTIFACT: artifact,
          SEAL_MARKET_OUT_DIR: outDir,
          SEAL_NPM_REGISTRY: "ftp://invalid.example.com",
        },
        stdio: "pipe",
      }),
    /https: or http:/,
  );

  // Also test SEAL_NPM_PACKAGE override + market index against real DSH app.asar validator
  const electron = process.env.SEAL_DSH_ELECTRON ?? "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
  const marketIndexPkg = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js";
  if (fsSync.existsSync(electron)) {
    const verifyScript = `
      const assert = require("node:assert/strict");
      const fs = require("node:fs");
      const { pathToFileURL } = require("node:url");
      (async () => {
        const { parseMarketIndex, marketInstallTarget, MarketIndexError } = await import(pathToFileURL(${JSON.stringify(marketIndexPkg)}).href);
        const raw = JSON.parse(fs.readFileSync(${JSON.stringify(indexPath)}, "utf8"));
        const parsed = parseMarketIndex(raw, ${JSON.stringify(`${baseUrl}index.json`)});
        assert.equal(parsed.format, 1);
        assert.equal(parsed.plugins[0].name, ${JSON.stringify(pkgJson.name)});
        assert.equal(parsed.plugins[0].icon, ${JSON.stringify(`${baseUrl}icon.svg`)});
        assert.equal(parsed.plugins[0].versions[0].version, ${JSON.stringify(pkgJson.version)});
        const target = marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0]);
        assert.equal(target.spec, ${JSON.stringify(`${pkgJson.name}@${pkgJson.version}`)});
        assert.equal(target.registry, "https://registry.npmjs.org/");

        // Verify tracked repository market/index.json if present
        if (fs.existsSync("market/index.json")) {
          const repoRaw = JSON.parse(fs.readFileSync("market/index.json", "utf8"));
          const repoParsed = parseMarketIndex(repoRaw, ${JSON.stringify(`${baseUrl}index.json`)});
          assert.equal(repoParsed.format, 1);
          assert.ok(repoParsed.plugins[0].versions.length >= 1);
        }

        // Negative controls: invalid publishTimestamp & invalid format
        const badTs = structuredClone(raw);
        badTs.plugins[0].versions[0].publishTimestamp = 1764000000.5;
        assert.throws(() => parseMarketIndex(badTs, ${JSON.stringify(`${baseUrl}index.json`)}), MarketIndexError);

        const badFmt = structuredClone(raw);
        badFmt.format = 2;
        assert.throws(() => parseMarketIndex(badFmt, ${JSON.stringify(`${baseUrl}index.json`)}), MarketIndexError);

        console.log("DSH_MARKET_OK");
      })().catch((err) => { console.error(err); process.exit(1); });
    `;
    const out = execFileSync(electron, ["-e", verifyScript], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.match(out, /DSH_MARKET_OK/);
  }
});
