import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFiumLibrary, type PDFiumDocument, type PDFiumPage } from "@hyzyla/pdfium";
import type { ExtractedPdfPage, ExtractedPdfResult } from "../core/host.js";
import { validateImageBytes } from "../core/docx/zip.js";

let libraryPromise: Promise<PDFiumLibrary> | null = null;
let wasmQueue: Promise<unknown> = Promise.resolve();

function getLibrary(): Promise<PDFiumLibrary> {
  if (!libraryPromise) {
    libraryPromise = PDFiumLibrary.init().catch((error) => {
      libraryPromise = null;
      throw error;
    });
  }
  return libraryPromise;
}

/** Serialize every WASM call because @hyzyla/pdfium shares a single Emscripten heap. */
function withWasmLock<T>(operation: (library: PDFiumLibrary) => Promise<T>): Promise<T> {
  const run = wasmQueue.then(async () => {
    const library = await getLibrary();
    return operation(library);
  });
  wasmQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizePageText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

async function openPdfDocument(library: PDFiumLibrary, pdfBytes: Uint8Array): Promise<PDFiumDocument> {
  if (!pdfBytes || pdfBytes.length === 0) {
    throw new Error("无法解析 PDF：文件为空");
  }
  let document: PDFiumDocument;
  try {
    document = await library.loadDocument(pdfBytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/password|security/i.test(detail)) {
      throw new Error(`无法解析 PDF（文件已加密或受密码保护）：${detail}`);
    }
    throw new Error(`无法解析 PDF 元数据（可能文件已损坏或非有效 PDF）：${detail}`);
  }
  let pageCount: number;
  try {
    pageCount = document.getPageCount();
  } catch (error) {
    document.destroy();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法解析 PDF 页数：${detail}`);
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    document.destroy();
    throw new Error("无法解析 PDF：PDF 页数无效或为空");
  }
  return document;
}

async function renderPageToPngFile(page: PDFiumPage, outFile: string, dpi: number): Promise<void> {
  const rendered = await page.render({
    scale: dpi / 72,
    renderFormFields: true,
    render: async ({ data, width, height }) =>
      sharp(Buffer.from(data), {
        raw: { width, height, channels: 4 },
      })
        .png()
        .toBuffer(),
  });
  const bytes = new Uint8Array(rendered.data);
  await validateImageBytes(bytes, "image/png");
  fs.writeFileSync(outFile, bytes);
}

function formatPageFilename(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(3, "0")}.png`;
}

export async function extractPdfWithPdfium(
  pdfBytes: Uint8Array,
  outDir: string,
  options?: { dpi?: number; maxPages?: number },
): Promise<ExtractedPdfResult> {
  const dpi = options?.dpi ?? 150;
  const maxPages = options?.maxPages ?? 120;
  if (!Number.isInteger(dpi) || dpi < 36 || dpi > 600) {
    throw new Error("PDF 渲染 DPI 参数无效");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error("PDF 最大渲染页数参数无效");
  }

  return withWasmLock(async (library) => {
    const document = await openPdfDocument(library, pdfBytes);
    try {
      const pageCount = document.getPageCount();
      const renderedPages = Math.min(pageCount, maxPages);
      const truncatedPages = Math.max(0, pageCount - renderedPages);
      fs.mkdirSync(outDir, { recursive: true });

      const pages: ExtractedPdfPage[] = [];
      for (let index = 0; index < pageCount; index++) {
        const pageNumber = index + 1;
        const page = document.getPage(index);
        try {
          const text = normalizePageText(page.getText());
          if (pageNumber <= renderedPages) {
            const outFile = path.join(outDir, formatPageFilename(pageNumber));
            await renderPageToPngFile(page, outFile, dpi);
            pages.push({ page: pageNumber, text, imagePath: outFile });
          } else {
            pages.push({ page: pageNumber, text });
          }
        } finally {
          page.close();
        }
      }
      return { pageCount, renderedPages, truncatedPages, pages };
    } finally {
      document.destroy();
    }
  });
}

export async function renderPdfBytesToPngs(
  pdfBytes: Uint8Array,
  outDir: string,
  options?: { dpi?: number; maxPages?: number },
): Promise<string[]> {
  const dpi = options?.dpi ?? 110;
  if (!Number.isInteger(dpi) || dpi < 36 || dpi > 600) {
    throw new Error("PDF 渲染 DPI 参数无效");
  }
  if (
    options?.maxPages !== undefined &&
    (!Number.isInteger(options.maxPages) || options.maxPages < 1)
  ) {
    throw new Error("PDF 最大渲染页数参数无效");
  }

  return withWasmLock(async (library) => {
    const document = await openPdfDocument(library, pdfBytes);
    try {
      const pageCount = document.getPageCount();
      const limit =
        options?.maxPages !== undefined ? Math.min(pageCount, options.maxPages) : pageCount;
      fs.mkdirSync(outDir, { recursive: true });

      const files: string[] = [];
      for (let index = 0; index < limit; index++) {
        const page = document.getPage(index);
        try {
          const outFile = path.join(outDir, formatPageFilename(index + 1));
          await renderPageToPngFile(page, outFile, dpi);
          files.push(outFile);
        } finally {
          page.close();
        }
      }
      return files.sort((a, b) =>
        path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }),
      );
    } finally {
      document.destroy();
    }
  });
}

export async function extractPdfBytesPageTexts(pdfBytes: Uint8Array): Promise<string[]> {
  return withWasmLock(async (library) => {
    const document = await openPdfDocument(library, pdfBytes);
    try {
      const pageCount = document.getPageCount();
      const texts: string[] = [];
      for (let index = 0; index < pageCount; index++) {
        const page = document.getPage(index);
        try {
          texts.push(normalizePageText(page.getText()));
        } finally {
          page.close();
        }
      }
      return texts;
    } finally {
      document.destroy();
    }
  });
}
